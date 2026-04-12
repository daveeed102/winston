/**
 * Winston Sniper - Entry Point
 *
 * Pump.fun launch sniper for Solana
 * Buy: 0.012 SOL per token, instantly on launch
 * Exit: 20x take profit OR 30-second hard stop
 * Max: 5 simultaneous positions
 */

require('dotenv').config();

const logger    = require('./logger');
const config    = require('./config');
const wallet    = require('./wallet');
const jupiter   = require('./jupiter');
const discord   = require('./discord');
const health    = require('./health');
const positions = require('./positionTracker');
const exitMgr   = require('./exitManager');
const PumpListener = require('./pumpListener');

// Track mints we've already tried to buy (dedup within session)
const seenMints = new Set();

async function main() {
  logger.info('╔══════════════════════════════════════╗');
  logger.info('║        WINSTON SNIPER v1.0           ║');
  logger.info('╚══════════════════════════════════════╝');
  logger.info(`Buy size:     ${config.BUY_AMOUNT_SOL} SOL`);
  logger.info(`Max positions: ${config.MAX_POSITIONS}`);
  logger.info(`Take profit:   ${config.TAKE_PROFIT_MULTIPLIER}x`);
  logger.info(`Time stop:     ${config.TIME_STOP_SECONDS}s`);
  logger.info(`Max token age: ${config.MAX_TOKEN_AGE_SECONDS}s`);

  // Validate wallet loads correctly
  const walletPubkey = wallet.getPublicKey().toBase58();
  logger.info(`Wallet: ${walletPubkey}`);

  // Check SOL balance
  const solBalance = await jupiter.getSolBalance();
  logger.info(`SOL Balance: ${solBalance.toFixed(4)} SOL`);

  const minRequired = config.BUY_AMOUNT_SOL * config.MAX_POSITIONS;
  if (solBalance < config.BUY_AMOUNT_SOL) {
    logger.error(`Insufficient SOL balance. Need at least ${config.BUY_AMOUNT_SOL} SOL to trade.`);
    process.exit(1);
  }

  if (solBalance < minRequired) {
    logger.warn(`Balance ${solBalance.toFixed(4)} SOL is less than max exposure ${minRequired.toFixed(4)} SOL. Will stop buying when funds run low.`);
  }

  // Start health server
  health.start();

  // Send startup notification
  await discord.sendStartup(walletPubkey, solBalance);

  // Heartbeat every 10 minutes
  setInterval(async () => {
    const bal = await jupiter.getSolBalance();
    await discord.sendHeartbeat(positions.count(), bal);
  }, 10 * 60 * 1000);

  // Start listening for new token launches
  const listener = new PumpListener(onNewToken);
  listener.start();

  logger.info('[SNIPER] 👀 Listening for new Pump.fun launches...');

  // Graceful shutdown
  process.on('SIGTERM', () => shutdown(listener));
  process.on('SIGINT',  () => shutdown(listener));
  process.on('uncaughtException', async (err) => {
    logger.error(`[UNCAUGHT] ${err.message}`);
    await discord.sendError('Uncaught exception', err.message);
  });
}

/**
 * Called the instant a new token launch is detected
 * @param {string} mint - the new token's mint address
 * @param {number} detectedAt - timestamp when we detected it
 */
async function onNewToken(mint, detectedAt) {
  const now = Date.now();
  const ageMs = now - detectedAt;
  const ageSec = ageMs / 1000;

  logger.info(`[SNIPER] New token: ${mint} | Age: ${ageSec.toFixed(2)}s`);

  // ── FRESHNESS CHECK ──
  // Only buy tokens that JUST launched - skip stale ones
  if (ageSec > config.MAX_TOKEN_AGE_SECONDS) {
    logger.info(`[SNIPER] Skipping ${mint} - too old (${ageSec.toFixed(1)}s > ${config.MAX_TOKEN_AGE_SECONDS}s)`);
    // Don't spam Discord for every skip - too noisy
    return;
  }

  // ── DEDUP CHECK ──
  if (seenMints.has(mint)) {
    logger.debug(`[SNIPER] Already seen ${mint}, skipping`);
    return;
  }
  seenMints.add(mint);

  // ── POSITION CAP CHECK ──
  if (positions.count() >= config.MAX_POSITIONS) {
    logger.info(`[SNIPER] At max positions (${config.MAX_POSITIONS}), skipping ${mint}`);
    await discord.sendSkipped(mint, `Max positions (${config.MAX_POSITIONS}) reached`);
    return;
  }

  // ── SOL BALANCE CHECK ──
  const solBalance = await jupiter.getSolBalance();
  if (solBalance < config.BUY_AMOUNT_SOL * 1.01) {
    logger.warn(`[SNIPER] Insufficient SOL balance (${solBalance.toFixed(4)}) for buy of ${config.BUY_AMOUNT_SOL}`);
    await discord.sendSkipped(mint, `Insufficient SOL balance: ${solBalance.toFixed(4)}`);
    return;
  }

  // ── FIRE THE BUY ──
  logger.info(`[SNIPER] 🚀 Buying ${mint} | ${ageSec.toFixed(2)}s old | ${positions.count() + 1}/${config.MAX_POSITIONS} slots`);
  await executeBuy(mint);
}

/**
 * Execute a buy and set up exit monitoring
 */
async function executeBuy(mint) {
  const buyResult = await jupiter.buyToken(mint, config.BUY_AMOUNT_SOL);

  if (!buyResult.success) {
    logger.error(`[SNIPER] Buy failed for ${mint}: ${buyResult.error}`);
    await discord.sendBuyFailed(mint, buyResult.error);
    return;
  }

  const tokenAmount = buyResult.estimatedTokens;
  const targetSolValue = config.BUY_AMOUNT_SOL * config.TAKE_PROFIT_MULTIPLIER;

  // Register position
  positions.add(mint, {
    mint,
    buyTxSig: buyResult.txSignature,
    tokenAmount,
    solSpent: config.BUY_AMOUNT_SOL,
    buyTime: Date.now(),
    targetSolValue,
  });

  logger.info(`[SNIPER] ✅ Position opened: ${mint} | ${tokenAmount.toLocaleString()} tokens | Target: ${targetSolValue.toFixed(6)} SOL`);

  await discord.sendBuySuccess({
    mint,
    solSpent: config.BUY_AMOUNT_SOL,
    tokenAmount,
    txSig: buyResult.txSignature,
    positionCount: positions.count(),
  });

  // Start exit monitoring (20x check + 30s timer)
  exitMgr.monitor(mint);
}

async function shutdown(listener) {
  logger.info('[SHUTDOWN] Shutting down...');
  listener.stop();
  health.stop();

  // Warn about open positions
  const open = positions.getAll();
  if (open.length > 0) {
    logger.warn(`[SHUTDOWN] WARNING: ${open.length} open positions! They will continue their exit timers if node is still running, but exit on process kill.`);
    await discord.sendError('Bot shutting down with open positions', `${open.length} positions still open: ${open.map(p => p.mint.slice(0, 8)).join(', ')}`);
  }

  process.exit(0);
}

main().catch(async (err) => {
  logger.error(`[FATAL] ${err.message}`);
  await discord.sendError('Fatal startup error', err.message).catch(() => {});
  process.exit(1);
});
