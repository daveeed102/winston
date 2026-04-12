/**
 * Exit Manager
 * Monitors open positions and triggers sells on:
 *   1. 20x take profit  (price monitor polls every 2s)
 *   2. 30s hard timeout (timer set at buy time)
 *
 * If a sell fails, it retries up to SELL_RETRY_ATTEMPTS times
 * with SELL_RETRY_DELAY_MS between each attempt.
 * It will NEVER silently give up — keeps trying until it gets out.
 */

const jupiter = require('./jupiter');
const positions = require('./positionTracker');
const discord = require('./discord');
const config = require('./config');
const logger = require('./logger');

// Poll interval for price checks (ms)
const PRICE_POLL_MS = 2000;

/**
 * Start monitoring a newly opened position
 */
function monitor(mint) {
  const position = positions.get(mint);
  if (!position) return;

  logger.info(`[EXIT] Monitoring ${mint} | Target: ${position.targetSolValue.toFixed(6)} SOL (${config.TAKE_PROFIT_MULTIPLIER}x) | Hard stop: ${config.TIME_STOP_SECONDS}s`);

  // ── HARD TIME STOP ──
  // No matter what, sell after TIME_STOP_SECONDS
  const exitTimer = setTimeout(async () => {
    const pos = positions.get(mint);
    if (!pos || pos.sold) return;
    logger.info(`[EXIT] ⏰ Time stop hit for ${mint}`);
    await triggerSell(mint, 'time_stop');
  }, config.TIME_STOP_SECONDS * 1000);

  positions.setExitTimer(mint, exitTimer);

  // ── PRICE MONITOR ──
  // Poll Jupiter for current value, exit at 20x
  startPriceMonitor(mint);
}

function startPriceMonitor(mint) {
  const poll = async () => {
    const pos = positions.get(mint);

    // Stop polling if position is gone or already exiting
    if (!pos || pos.sold || pos.selling) return;

    try {
      const currentSolValue = await jupiter.getTokenValueInSol(mint, pos.tokenAmount);

      if (currentSolValue <= 0) {
        // Can't get a price - token may have no liquidity yet, try again
        setTimeout(poll, PRICE_POLL_MS);
        return;
      }

      const multiplier = currentSolValue / pos.solSpent;
      logger.debug(`[EXIT] ${mint.slice(0, 8)}... | Value: ${currentSolValue.toFixed(6)} SOL | ${multiplier.toFixed(2)}x`);

      // Take profit check
      if (currentSolValue >= pos.targetSolValue) {
        logger.info(`[EXIT] 🎯 Take profit triggered for ${mint} | ${multiplier.toFixed(2)}x`);
        await triggerSell(mint, 'take_profit');
        return; // Stop polling
      }

    } catch (err) {
      logger.debug(`[EXIT] Price poll error for ${mint}: ${err.message}`);
    }

    // Schedule next poll if position still open
    const stillOpen = positions.get(mint);
    if (stillOpen && !stillOpen.sold && !stillOpen.selling) {
      setTimeout(poll, PRICE_POLL_MS);
    }
  };

  // Start polling after a short delay (give the buy time to confirm)
  setTimeout(poll, 3000);
}

/**
 * Trigger a sell for a position
 * Retries indefinitely until success or max retries exhausted
 */
async function triggerSell(mint, reason) {
  const pos = positions.get(mint);
  if (!pos) return;
  if (pos.sold || pos.selling) return; // Already being handled

  positions.markSelling(mint);

  logger.info(`[EXIT] Initiating sell for ${mint} | Reason: ${reason}`);
  await discord.sendSellAttempt(mint, reason);

  // Get current token balance (use actual wallet balance, not cached)
  let tokenAmount = await jupiter.getTokenBalance(mint);
  if (tokenAmount <= 0) {
    // Fallback to stored amount
    tokenAmount = pos.tokenAmount;
  }

  if (tokenAmount <= 0) {
    logger.warn(`[EXIT] No token balance found for ${mint} - marking as sold`);
    positions.remove(mint);
    return;
  }

  // ── RETRY LOOP ──
  let attempt = 0;
  let sold = false;

  while (attempt < config.SELL_RETRY_ATTEMPTS && !sold) {
    attempt++;
    logger.info(`[EXIT] Sell attempt ${attempt}/${config.SELL_RETRY_ATTEMPTS} for ${mint}`);

    try {
      const result = await jupiter.sellToken(mint, tokenAmount);

      if (result.success) {
        sold = true;
        const pos = positions.get(mint); // Re-fetch in case it changed
        const solReceived = result.solReceived;
        const pnlSol = solReceived - (pos?.solSpent || config.BUY_AMOUNT_SOL);
        const multiplier = solReceived / (pos?.solSpent || config.BUY_AMOUNT_SOL);

        logger.info(`[EXIT] ✅ Sold ${mint} | Received: ${solReceived.toFixed(6)} SOL | PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(6)} SOL | ${multiplier.toFixed(2)}x | Reason: ${reason}`);

        await discord.sendSellSuccess({
          mint,
          reason,
          solReceived,
          solSpent: pos?.solSpent || config.BUY_AMOUNT_SOL,
          pnlSol,
          multiplier,
          txSig: result.txSignature,
          attempts: attempt,
        });

        positions.remove(mint);

      } else {
        logger.warn(`[EXIT] Sell attempt ${attempt} failed: ${result.error}`);

        if (attempt < config.SELL_RETRY_ATTEMPTS) {
          logger.info(`[EXIT] Retrying in ${config.SELL_RETRY_DELAY_MS}ms...`);
          await sleep(config.SELL_RETRY_DELAY_MS);

          // Refresh token balance before retry
          const freshBalance = await jupiter.getTokenBalance(mint);
          if (freshBalance > 0) tokenAmount = freshBalance;
        }
      }

    } catch (err) {
      logger.error(`[EXIT] Sell attempt ${attempt} threw: ${err.message}`);

      if (attempt < config.SELL_RETRY_ATTEMPTS) {
        await sleep(config.SELL_RETRY_DELAY_MS);
      }
    }
  }

  if (!sold) {
    // All retries exhausted - this is bad, alert loudly
    logger.error(`[EXIT] ❌ FAILED TO SELL ${mint} after ${attempt} attempts! MANUAL INTERVENTION NEEDED.`);
    await discord.sendSellFailed(mint, reason, attempt);

    // Keep the position in tracker but mark it as needing attention
    // Start an aggressive retry loop that runs every 10 seconds forever
    logger.warn(`[EXIT] Starting emergency retry loop for ${mint}`);
    emergencyRetry(mint, tokenAmount, reason);
  }
}

/**
 * Emergency retry loop - runs every 10 seconds until sold
 * This fires when all normal retries fail
 */
async function emergencyRetry(mint, tokenAmount, originalReason) {
  let emergencyAttempt = 0;

  const retry = async () => {
    // Check if somehow it got removed (manual sell, etc.)
    if (!positions.has(mint)) {
      logger.info(`[EXIT] Emergency retry: ${mint} no longer in positions, stopping`);
      return;
    }

    emergencyAttempt++;
    logger.warn(`[EXIT] 🚨 Emergency sell attempt #${emergencyAttempt} for ${mint}`);

    try {
      // Always get fresh balance
      const freshBalance = await jupiter.getTokenBalance(mint);
      const amount = freshBalance > 0 ? freshBalance : tokenAmount;

      if (amount <= 0) {
        logger.info(`[EXIT] Emergency retry: ${mint} balance is 0 - assuming sold, removing`);
        positions.remove(mint);
        return;
      }

      const result = await jupiter.sellToken(mint, amount);

      if (result.success) {
        logger.info(`[EXIT] ✅ Emergency sell succeeded for ${mint} on attempt #${emergencyAttempt}`);
        await discord.sendEmergencySellSuccess(mint, result.solReceived, emergencyAttempt);
        positions.remove(mint);
        return;
      }

    } catch (err) {
      logger.error(`[EXIT] Emergency attempt #${emergencyAttempt} error: ${err.message}`);
    }

    // Schedule next emergency attempt
    logger.warn(`[EXIT] Emergency retry #${emergencyAttempt} failed, next in 10s...`);
    setTimeout(retry, 10000);
  };

  setTimeout(retry, 10000);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { monitor, triggerSell };
