// FILE: src/trading/executor.js
// Jupiter swap executor with multi-wallet mirroring.
// Wallet 1 (yours) leads. Wallets 2 & 3 mirror every trade simultaneously.
// A failure on wallet 2 or 3 never blocks wallet 1.

const axios = require('axios');
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const config = require('./config');
const { createLogger } = require('./logger');

const log = createLogger('EXECUTOR');

let connection;
let wallets = []; // index 0 = primary (yours), 1 = friend 1, 2 = friend 2

function initExecutor() {
  const rpcUrl = config.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`
    : config.SOLANA_RPC_URL;

  connection = new Connection(rpcUrl, 'confirmed');

  const keys = [
    process.env.WALLET_PRIVATE_KEY,
    process.env.WALLET_PRIVATE_KEY_2,
    process.env.WALLET_PRIVATE_KEY_3,
  ].filter(Boolean);

  if (!keys.length) throw new Error('No wallet private keys set');

  wallets = keys.map((key, i) => {
    const kp = Keypair.fromSecretKey(bs58.decode(key));
    log.info(`Wallet ${i + 1} loaded: ${kp.publicKey.toBase58()}`);
    return kp;
  });

  log.info(`Executor ready. ${wallets.length} wallet(s) active.`);
  return { connection, wallets };
}

// ─── Balances ─────────────────────────────────────────────────────────────────

async function getSolBalance(walletIndex = 0) {
  const wallet = wallets[walletIndex];
  if (!wallet) return 0;
  const lamports = await connection.getBalance(wallet.publicKey);
  return lamports / 1e9;
}

async function getTokenBalance(mintAddress, walletIndex = 0) {
  const wallet = wallets[walletIndex];
  if (!wallet) return 0;
  try {
    const mint = new PublicKey(mintAddress);
    const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint });
    if (!accounts.value.length) return 0;
    return accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
  } catch (err) {
    log.warn(`Token balance check failed (wallet ${walletIndex + 1}): ${err.message}`);
    return 0;
  }
}

// ─── Jupiter quote ────────────────────────────────────────────────────────────

async function getQuote(inputMint, outputMint, amountLamports) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountLamports.toString(),
    slippageBps: config.SLIPPAGE_BPS.toString(),
    onlyDirectRoutes: 'false',
    asLegacyTransaction: 'false',
  });
  const res = await axios.get(`https://api.jup.ag/v6/quote?${params}`, { timeout: 15000 });
  return res.data;
}

// ─── Single wallet swap ───────────────────────────────────────────────────────

async function executeSwapForWallet(quote, wallet) {
  const swapRes = await axios.post(
    `https://api.jup.ag/v6/swap`,
    {
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: config.JUPITER_PRIORITY_FEE_LAMPORTS,
      dynamicComputeUnitLimit: true,
    },
    { timeout: 20000 }
  );

  const { swapTransaction } = swapRes.data;
  if (!swapTransaction) throw new Error('No swapTransaction in Jupiter response');

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([wallet]);
  return await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
}

async function confirmTransaction(signature, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await connection.getSignatureStatus(signature);
    const conf = status?.value?.confirmationStatus;
    if (conf === 'confirmed' || conf === 'finalized') return true;
    if (status?.value?.err) { log.error(`TX failed: ${signature}`); return false; }
    await sleep(2000);
  }
  log.warn(`TX timeout: ${signature}`);
  return false;
}

// ─── BUY — all wallets simultaneously ────────────────────────────────────────
// Each wallet gets its own quote for its own SOL balance.
// Wallet 1 must succeed. Wallets 2 & 3 are best-effort.

async function buyToken(tokenAddress, sizeUsd) {
  log.info(`BUY ${tokenAddress} ~$${sizeUsd} across ${wallets.length} wallet(s)`);
  const solPrice = await getSolPriceUsd();

  const walletPromises = wallets.map(async (wallet, i) => {
    const label = `Wallet ${i + 1}`;
    try {
      const solBalance = await getSolBalance(i);
      const solNeeded = sizeUsd / solPrice;
      if (solBalance < solNeeded + 0.01) {
        log.warn(`${label}: low SOL — have ${solBalance.toFixed(4)}, need ${solNeeded.toFixed(4)}`);
        return { walletIndex: i, success: false, reason: 'insufficient_sol', label };
      }

      const lamports = Math.floor(solNeeded * 1e9);
      const quote = await getQuote(config.SOL_MINT, tokenAddress, lamports);
      if (!quote?.outAmount) throw new Error('Invalid quote');

      const sig = await executeSwapForWallet(quote, wallet);
      const confirmed = await confirmTransaction(sig);
      if (!confirmed) throw new Error(`Not confirmed: ${sig}`);

      const tokenAmount = parseFloat(quote.outAmount) / Math.pow(10, quote.outputDecimals || 6);
      const entryPrice = sizeUsd / tokenAmount;

      log.info(`${label} BUY ✅ ${tokenAmount.toFixed(4)} tokens | tx: ${sig}`);
      return { walletIndex: i, success: true, signature: sig, tokenAmount, entryPrice, sizeUsd, solSpent: solNeeded, label };
    } catch (err) {
      log.error(`${label} BUY ❌ ${err.message}`);
      return { walletIndex: i, success: false, reason: err.message, label };
    }
  });

  const allResults = (await Promise.allSettled(walletPromises)).map((r) =>
    r.status === 'fulfilled' ? r.value : { success: false, reason: r.reason?.message }
  );

  const primary = allResults[0];
  if (!primary?.success) throw new Error(`Primary wallet BUY failed: ${primary?.reason}`);

  return { ...primary, allWalletResults: allResults };
}

// ─── SELL — all wallets simultaneously ───────────────────────────────────────

async function sellToken(tokenAddress, fraction = 1.0) {
  log.info(`SELL ${tokenAddress} (${(fraction * 100).toFixed(0)}%) across ${wallets.length} wallet(s)`);
  const solPrice = await getSolPriceUsd();
  const decimals = await getTokenDecimals(tokenAddress);

  const walletPromises = wallets.map(async (wallet, i) => {
    const label = `Wallet ${i + 1}`;
    try {
      const tokenBalance = await getTokenBalance(tokenAddress, i);
      if (tokenBalance <= 0) {
        log.warn(`${label}: no token balance`);
        return { walletIndex: i, success: false, reason: 'no_balance', label };
      }

      const sellAmount = Math.floor(tokenBalance * fraction * Math.pow(10, decimals));
      if (sellAmount <= 0) return { walletIndex: i, success: false, reason: 'zero_amount', label };

      const quote = await getQuote(tokenAddress, config.SOL_MINT, sellAmount);
      if (!quote?.outAmount) throw new Error('Invalid quote');

      const sig = await executeSwapForWallet(quote, wallet);
      const confirmed = await confirmTransaction(sig);
      if (!confirmed) throw new Error(`Not confirmed: ${sig}`);

      const solReceived = parseFloat(quote.outAmount) / 1e9;
      const usdReceived = solReceived * solPrice;
      const tokensSold = tokenBalance * fraction;
      const exitPrice = usdReceived / tokensSold;

      log.info(`${label} SELL ✅ $${usdReceived.toFixed(2)} | tx: ${sig}`);
      return { walletIndex: i, success: true, signature: sig, tokensSold, usdReceived, exitPrice, solReceived, label };
    } catch (err) {
      log.error(`${label} SELL ❌ ${err.message}`);
      return { walletIndex: i, success: false, reason: err.message, label };
    }
  });

  const allResults = (await Promise.allSettled(walletPromises)).map((r) =>
    r.status === 'fulfilled' ? r.value : { success: false, reason: r.reason?.message }
  );

  const primary = allResults[0];
  if (!primary?.success) throw new Error(`Primary wallet SELL failed: ${primary?.reason}`);

  return { ...primary, allWalletResults: allResults };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getTokenDecimals(mintAddress) {
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mintAddress));
    return info?.value?.data?.parsed?.info?.decimals || 6;
  } catch { return 6; }
}

async function getSolPriceUsd() {
  try {
    const res = await axios.get(
      'https://api.dexscreener.com/tokens/v1/solana/So11111111111111111111111111111111111111112',
      { timeout: 8000 }
    );
    const pairs = Array.isArray(res.data) ? res.data : [];
    const usdcPair = pairs.find((p) => p.quoteToken?.symbol === 'USDC');
    return usdcPair ? parseFloat(usdcPair.priceUsd) : 150;
  } catch { return 150; }
}

function getWalletCount() { return wallets.length; }
function getWalletAddresses() {
  return wallets.map((w, i) => ({ index: i + 1, address: w.publicKey.toBase58() }));
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = {
  initExecutor, getSolBalance, getTokenBalance,
  buyToken, sellToken, getSolPriceUsd,
  getWalletCount, getWalletAddresses,
};
