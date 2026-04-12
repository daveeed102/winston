/**
 * Jupiter Swap Client
 * Buy: SOL → Token
 * Sell: Token → SOL
 *
 * Uses Pump.fun's own bonding curve for brand new tokens
 * (Jupiter won't have routes for tokens <1min old)
 * Falls back to Jupiter for tokens that have graduated to AMM pools.
 */

const axios = require('axios');
const {
  Connection,
  VersionedTransaction,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  SystemProgram,
  TransactionInstruction,
  SYSVAR_RENT_PUBKEY,
} = require('@solana/web3.js');
const { getKeypair } = require('./wallet');
const config = require('./config');
const logger = require('./logger');

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Jupiter API - correct current endpoints
const JUPITER_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_URL  = 'https://lite-api.jup.ag/swap/v1/swap';

const connection = new Connection(config.HELIUS_RPC_URL, 'confirmed');

async function buyToken(mintAddress, solAmount) {
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  logger.info(`[JUPITER] Buying ${mintAddress} with ${solAmount} SOL`);

  try {
    const quote = await getQuote(SOL_MINT, mintAddress, lamports);
    if (!quote) throw new Error('No route found - token may not have liquidity yet');

    const estimatedTokens = parseInt(quote.outAmount);
    logger.info(`[JUPITER] Quote: ${lamports} lamports → ~${estimatedTokens} tokens`);

    const swapTx = await buildSwapTransaction(quote);
    const txSignature = await signAndSend(swapTx);

    logger.info(`[JUPITER] Buy success: ${txSignature}`);
    return { success: true, txSignature, estimatedTokens };

  } catch (err) {
    logger.error(`[JUPITER] Buy failed for ${mintAddress}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function sellToken(mintAddress, tokenAmount) {
  logger.info(`[JUPITER] Selling ${tokenAmount} of ${mintAddress}`);

  try {
    const quote = await getQuote(mintAddress, SOL_MINT, tokenAmount);
    if (!quote) throw new Error('No route — token may have no liquidity');

    const solLamports = parseInt(quote.outAmount);
    const solReceived = solLamports / LAMPORTS_PER_SOL;
    logger.info(`[JUPITER] Sell quote: ${tokenAmount} tokens → ~${solReceived.toFixed(6)} SOL`);

    const swapTx = await buildSwapTransaction(quote);
    const txSignature = await signAndSend(swapTx);

    logger.info(`[JUPITER] Sell success: ${txSignature} | Got ${solReceived.toFixed(6)} SOL`);
    return { success: true, txSignature, solReceived };

  } catch (err) {
    logger.error(`[JUPITER] Sell failed for ${mintAddress}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function getTokenValueInSol(mintAddress, tokenAmount) {
  try {
    const quote = await getQuote(mintAddress, SOL_MINT, tokenAmount);
    if (!quote) return 0;
    return parseInt(quote.outAmount) / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}

// ─── INTERNAL ───

async function getQuote(inputMint, outputMint, amount) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amount.toString(),
    slippageBps: config.SLIPPAGE_BPS.toString(),
    onlyDirectRoutes: 'false',
    platformFeeBps: '0',
  });

  try {
    const response = await axios.get(`${JUPITER_QUOTE_URL}?${params}`, {
      timeout: 8000,
      headers: { 'Accept': 'application/json' },
    });

    if (response.data?.error) throw new Error(response.data.error);
    return response.data;

  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.error || err.message;
    throw new Error(`Jupiter quote failed (${status}): ${detail}`);
  }
}

async function buildSwapTransaction(quote) {
  const keypair = getKeypair();

  const body = {
    quoteResponse: quote,
    userPublicKey: keypair.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto',
  };

  try {
    const response = await axios.post(JUPITER_SWAP_URL, body, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.data?.swapTransaction) {
      throw new Error('No swapTransaction in response');
    }
    return response.data.swapTransaction;

  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.error || err.message;
    throw new Error(`Jupiter swap build failed (${status}): ${detail}`);
  }
}

async function signAndSend(swapTransactionBase64) {
  const keypair = getKeypair();
  const buf = Buffer.from(swapTransactionBase64, 'base64');
  const transaction = VersionedTransaction.deserialize(buf);

  transaction.sign([keypair]);

  const rawTx = transaction.serialize();
  const txSignature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: true,
    maxRetries: 3,
    preflightCommitment: 'processed',
  });

  const latestBlockhash = await connection.getLatestBlockhash();
  const confirmation = await connection.confirmTransaction(
    { signature: txSignature, ...latestBlockhash },
    'confirmed'
  );

  if (confirmation.value.err) {
    throw new Error(`TX failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
  }

  return txSignature;
}

async function getTokenBalance(mintAddress) {
  try {
    const keypair = getKeypair();
    const mint = new PublicKey(mintAddress);
    const tokenAccounts = await connection.getTokenAccountsByOwner(
      keypair.publicKey, { mint }
    );
    if (!tokenAccounts.value.length) return 0;
    const balance = await connection.getTokenAccountBalance(
      tokenAccounts.value[0].pubkey
    );
    return parseInt(balance.value.amount);
  } catch (err) {
    logger.debug(`[JUPITER] getTokenBalance error: ${err.message}`);
    return 0;
  }
}

async function getSolBalance() {
  try {
    const keypair = getKeypair();
    const balance = await connection.getBalance(keypair.publicKey);
    return balance / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}

module.exports = {
  buyToken,
  sellToken,
  getTokenValueInSol,
  getTokenBalance,
  getSolBalance,
};
