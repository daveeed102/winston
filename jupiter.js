/**
 * Jupiter Swap Client
 * Buy: SOL → Token
 * Sell: Token → SOL
 *
 * Uses Jupiter Quote API v6 with fallback URLs in case one is unreachable.
 */

const axios = require('axios');
const {
  Connection,
  VersionedTransaction,
  PublicKey,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const { getKeypair } = require('./wallet');
const config = require('./config');
const logger = require('./logger');

// Try multiple Jupiter endpoints in case one is unreachable from Railway
const JUPITER_QUOTE_URLS = [
  'https://quote-api.jup.ag/v6',
  'https://jupiter-swap-api.quiknode.pro/v6',
];

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const connection = new Connection(config.HELIUS_RPC_URL, 'confirmed');

async function buyToken(mintAddress, solAmount) {
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  logger.info(`[JUPITER] Buying ${mintAddress} with ${solAmount} SOL`);

  try {
    const quote = await getQuote(SOL_MINT, mintAddress, lamports);
    if (!quote) throw new Error('No quote available');

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
    if (!quote) throw new Error('No quote available — token may have no liquidity');

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

// ─── INTERNAL HELPERS ───

async function getQuote(inputMint, outputMint, amount) {
  const path = `/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${config.SLIPPAGE_BPS}&onlyDirectRoutes=false`;

  // Try each base URL in order
  let lastErr;
  for (const base of JUPITER_QUOTE_URLS) {
    try {
      const response = await axios.get(`${base}${path}`, { timeout: 8000 });
      if (response.data && !response.data.error) return response.data;
    } catch (err) {
      lastErr = err;
      logger.debug(`[JUPITER] Quote URL ${base} failed: ${err.message}`);
    }
  }

  throw new Error(`All Jupiter quote endpoints failed: ${lastErr?.message}`);
}

async function buildSwapTransaction(quote) {
  const keypair = getKeypair();

  // Try each base URL in order
  let lastErr;
  for (const base of JUPITER_QUOTE_URLS) {
    try {
      const response = await axios.post(`${base}/swap`, {
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }, { timeout: 10000 });

      if (response.data?.swapTransaction) return response.data.swapTransaction;
    } catch (err) {
      lastErr = err;
      logger.debug(`[JUPITER] Swap URL ${base} failed: ${err.message}`);
    }
  }

  throw new Error(`All Jupiter swap endpoints failed: ${lastErr?.message}`);
}

async function signAndSend(swapTransactionBase64) {
  const keypair = getKeypair();
  const swapTransactionBuf = Buffer.from(swapTransactionBase64, 'base64');
  const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

  transaction.sign([keypair]);

  const rawTx = transaction.serialize();
  const txSignature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: true,
    maxRetries: 3,
    preflightCommitment: 'processed',
  });

  const confirmation = await connection.confirmTransaction(
    { signature: txSignature, ...(await connection.getLatestBlockhash()) },
    'confirmed'
  );

  if (confirmation.value.err) {
    throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
  }

  return txSignature;
}

async function getTokenBalance(mintAddress) {
  try {
    const keypair = getKeypair();
    const mint = new PublicKey(mintAddress);
    const tokenAccounts = await connection.getTokenAccountsByOwner(keypair.publicKey, { mint });
    if (!tokenAccounts.value.length) return 0;
    const balance = await connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
    return parseInt(balance.value.amount);
  } catch (err) {
    logger.debug(`[JUPITER] getTokenBalance error for ${mintAddress}: ${err.message}`);
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
