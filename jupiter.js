/**
 * Jupiter Swap Client
 * Handles buy and sell swaps via Jupiter V6 API
 *
 * Buy:  SOL → Token
 * Sell: Token → SOL
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

const JUPITER_API = 'https://quote-api.jup.ag/v6';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const connection = new Connection(config.HELIUS_RPC_URL, 'confirmed');

/**
 * Buy a token with SOL
 * @param {string} mintAddress - token mint to buy
 * @param {number} solAmount - amount of SOL to spend
 * @returns {object} { success, txSignature, estimatedTokens, error }
 */
async function buyToken(mintAddress, solAmount) {
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  logger.info(`[JUPITER] Buying ${mintAddress} with ${solAmount} SOL (${lamports} lamports)`);

  try {
    // Step 1: Get quote
    const quote = await getQuote(SOL_MINT, mintAddress, lamports);
    if (!quote) throw new Error('No quote available for this token');

    const estimatedTokens = parseInt(quote.outAmount);
    logger.info(`[JUPITER] Quote: ${lamports} lamports → ~${estimatedTokens} tokens`);

    // Step 2: Build swap transaction
    const swapTx = await buildSwapTransaction(quote);

    // Step 3: Sign and send
    const txSignature = await signAndSend(swapTx);

    logger.info(`[JUPITER] Buy success: ${txSignature}`);
    return { success: true, txSignature, estimatedTokens };

  } catch (err) {
    logger.error(`[JUPITER] Buy failed for ${mintAddress}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Sell all tokens for SOL
 * @param {string} mintAddress - token mint to sell
 * @param {number} tokenAmount - token amount in raw units
 * @returns {object} { success, txSignature, solReceived, error }
 */
async function sellToken(mintAddress, tokenAmount) {
  logger.info(`[JUPITER] Selling ${tokenAmount} of ${mintAddress}`);

  try {
    // Step 1: Get quote (Token → SOL)
    const quote = await getQuote(mintAddress, SOL_MINT, tokenAmount);
    if (!quote) throw new Error('No quote available - token may have no liquidity');

    const solLamports = parseInt(quote.outAmount);
    const solReceived = solLamports / LAMPORTS_PER_SOL;
    logger.info(`[JUPITER] Sell quote: ${tokenAmount} tokens → ~${solReceived.toFixed(6)} SOL`);

    // Step 2: Build swap transaction
    const swapTx = await buildSwapTransaction(quote);

    // Step 3: Sign and send
    const txSignature = await signAndSend(swapTx);

    logger.info(`[JUPITER] Sell success: ${txSignature} | Got ${solReceived.toFixed(6)} SOL`);
    return { success: true, txSignature, solReceived };

  } catch (err) {
    logger.error(`[JUPITER] Sell failed for ${mintAddress}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Get current price of token in SOL
 * Returns the SOL value of 1 unit of the token (scaled by decimals)
 * @param {string} mintAddress
 * @param {number} tokenAmount - raw token amount to check price for
 */
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
  const url = `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${config.SLIPPAGE_BPS}&onlyDirectRoutes=false`;

  const response = await axios.get(url, { timeout: 8000 });

  if (!response.data || response.data.error) {
    throw new Error(response.data?.error || 'Quote API returned no data');
  }

  return response.data;
}

async function buildSwapTransaction(quote) {
  const keypair = getKeypair();

  const response = await axios.post(`${JUPITER_API}/swap`, {
    quoteResponse: quote,
    userPublicKey: keypair.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto', // auto priority fee for speed
  }, { timeout: 10000 });

  if (!response.data?.swapTransaction) {
    throw new Error('No swap transaction returned from Jupiter');
  }

  return response.data.swapTransaction;
}

async function signAndSend(swapTransactionBase64) {
  const keypair = getKeypair();

  // Deserialize
  const swapTransactionBuf = Buffer.from(swapTransactionBase64, 'base64');
  const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

  // Sign
  transaction.sign([keypair]);

  // Send with preflight disabled for max speed
  const rawTx = transaction.serialize();
  const txSignature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: true,
    maxRetries: 3,
    preflightCommitment: 'processed',
  });

  // Wait for confirmation (up to 30s)
  const confirmation = await connection.confirmTransaction(
    { signature: txSignature, ...(await connection.getLatestBlockhash()) },
    'confirmed'
  );

  if (confirmation.value.err) {
    throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
  }

  return txSignature;
}

/**
 * Get token balance for our wallet
 * Returns raw token amount (not adjusted for decimals)
 */
async function getTokenBalance(mintAddress) {
  try {
    const keypair = getKeypair();
    const mint = new PublicKey(mintAddress);
    const owner = keypair.publicKey;

    const tokenAccounts = await connection.getTokenAccountsByOwner(owner, { mint });

    if (!tokenAccounts.value.length) return 0;

    const accountInfo = tokenAccounts.value[0];
    const balance = await connection.getTokenAccountBalance(accountInfo.pubkey);
    return parseInt(balance.value.amount);

  } catch (err) {
    logger.debug(`[JUPITER] getTokenBalance error for ${mintAddress}: ${err.message}`);
    return 0;
  }
}

/**
 * Get SOL balance
 */
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
