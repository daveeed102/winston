// FILE: src/trading/exitManager.js
// Manages all exit logic for open positions.
// Runs on a fast loop (every 30s by default).
// Checks: hard stop, trailing stop, partial TP, time stop, hype collapse, momentum fail.

const config = require('./config');
const db = require('./db');
const { sellToken, getSolPriceUsd } = require('./executor');
const { getCurrentPrice } = require('./dexscreener');
const discord = require('./discord');
const { createLogger } = require('./logger');

const log = createLogger('EXIT');

// Track peak prices in memory for accuracy (supplement to DB)
const peakPrices = new Map(); // tokenAddress → peak price seen
// Lock to prevent double exits while a sell is in progress
const exitingNow = new Set(); // tokenAddress → currently being exited

// ─── Main exit check loop ─────────────────────────────────────────────────────
// Called every POSITION_CHECK_INTERVAL_SECONDS seconds

async function checkAllPositions() {
  if (config.KILL_SWITCH) return;

  const positions = db.getOpenPositions();
  if (!positions.length) return;

  log.debug(`Checking ${positions.length} open position(s)`);

  for (const position of positions) {
    try {
      await checkPosition(position);
    } catch (err) {
      log.error(`Exit check error for ${position.ticker}: ${err.message}`);
      await discord.notifyError('ExitManager', `Exit check failed for ${position.ticker}`, err.message);
    }
  }

  db.updateDailySummary();
}

// ─── Check a single position ──────────────────────────────────────────────────

async function checkPosition(position) {
  // Prevent double exits — if already selling this token, skip
  if (exitingNow.has(position.tokenAddress)) {
    log.debug(`Skipping exit check for ${position.ticker} — exit already in progress`);
    return;
  }

  const currentPrice = await getCurrentPrice(position.tokenAddress);

  if (!currentPrice || currentPrice <= 0) {
    log.warn(`Could not get price for ${position.ticker} — skipping exit check`);
    return;
  }

  const entry = position.entryPrice;
  const pnlPct = ((currentPrice - entry) / entry) * 100;
  const holdTimeMs = Date.now() - new Date(position.entryTime).getTime();
  const holdTimeHours = holdTimeMs / (1000 * 60 * 60);

  // Update peak price
  const peak = Math.max(peakPrices.get(position.tokenAddress) || entry, currentPrice);
  peakPrices.set(position.tokenAddress, peak);
  const peakPnlPct = ((peak - entry) / entry) * 100;

  // ── Safety check — skip if prices look invalid ────────────────────────────
  if (!position.stopLossPrice || position.stopLossPrice <= 0) {
    log.warn(`⚠️  Invalid stop loss price for ${position.ticker} ($${position.stopLossPrice}) — skipping exit checks`);
    return;
  }

  // ── 1. Hard stop loss ──────────────────────────────────────────────────────
  // Minimum 90 second hold before stop loss can fire
  const holdTimeSec = holdTimeMs / 1000;
  if (currentPrice <= position.stopLossPrice) {
    if (holdTimeSec < 90) {
      log.warn(`⏳ Stop loss would trigger for ${position.ticker} but minimum hold (90s) not elapsed (${holdTimeSec.toFixed(0)}s) — waiting`);
    } else {
      log.info(`🛑 Stop loss hit: ${position.ticker} @ ${currentPrice.toFixed(8)} (stop: ${position.stopLossPrice.toFixed(8)})`);
      await executeExit(position, currentPrice, 'STOP_LOSS', 1.0, peakPnlPct);
      return;
    }
  }

  // ── 2. Trailing stop ───────────────────────────────────────────────────────
  if (pnlPct >= config.EXIT.TRAILING_ACTIVATE_PCT && !position.trailingActive) {
    // Arm trailing stop
    const trailStopPrice = currentPrice * (1 - config.EXIT.TRAILING_DISTANCE_PCT / 100);
    position.trailingActive = true;
    position.trailingPeakPrice = currentPrice;
    position.trailingStopPrice = trailStopPrice;
    db.upsertPosition(position);
    await discord.notifyTrailingArmed(position, currentPrice);
    log.info(`📐 Trailing armed for ${position.ticker}: stop @ ${trailStopPrice.toFixed(8)}`);
  }

  if (position.trailingActive) {
    // Update peak and trail stop if price moved higher
    if (currentPrice > (position.trailingPeakPrice || 0)) {
      const newTrailStop = currentPrice * (1 - config.EXIT.TRAILING_DISTANCE_PCT / 100);
      const prevPeak = position.trailingPeakPrice;
      position.trailingPeakPrice = currentPrice;
      position.trailingStopPrice = newTrailStop;
      db.upsertPosition(position);
      if (currentPrice > prevPeak * 1.02) {
        // Only notify if trail moved by >2%
        await discord.notifyTrailingMoved(position, currentPrice);
      }
    }

    // Check if trail stop was hit
    if (currentPrice <= position.trailingStopPrice) {
      log.info(`📉 Trailing stop hit: ${position.ticker} @ ${currentPrice.toFixed(8)}`);
      await executeExit(position, currentPrice, 'TRAILING_STOP', 1.0, peakPnlPct);
      return;
    }
  }

  // ── 3. Take profit — exit full position when SOL gain target hit ────────────
  if (position.takeProfitPrice && currentPrice >= position.takeProfitPrice) {
    log.info(`💰 Take profit hit: ${position.ticker} @ $${currentPrice.toFixed(8)} (target: $${position.takeProfitPrice.toFixed(8)})`);
    await executeExit(position, currentPrice, 'TAKE_PROFIT', 1.0, peakPnlPct);
    return;
  }

  // ── 4. Time stop ───────────────────────────────────────────────────────────
  if (holdTimeHours >= config.EXIT.MAX_HOLD_HOURS) {
    log.info(`⏰ Time stop: ${position.ticker} held ${holdTimeHours.toFixed(1)}h`);
    await executeExit(position, currentPrice, 'TIME_STOP', 1.0, peakPnlPct);
    return;
  }

  // ── 5. Momentum failure check ──────────────────────────────────────────────
  // Only fires if: holding >5 min, price is negative, AND dropped from peak
  // Never fires in first 5 minutes to avoid false signals on entry price noise
  // Momentum failure: only fires if holding >10min, dropped >12% from peak, AND PnL < -5%
  // This prevents selling a healthy coin during a normal pullback
  if (!position.trailingActive && peak > entry && holdTimeHours >= (10 / 60)) {
    const dropFromPeak = ((peak - currentPrice) / peak) * 100;
    if (dropFromPeak >= config.EXIT.MOMENTUM_FAIL_PCT && pnlPct < -5) {
      log.info(`📊 Momentum failure: ${position.ticker} dropped ${dropFromPeak.toFixed(1)}% from peak, PnL ${pnlPct.toFixed(1)}%`);
      await executeExit(position, currentPrice, 'MOMENTUM_FAILURE', 1.0, peakPnlPct);
      return;
    }
  }
}

// ─── Execute full exit ────────────────────────────────────────────────────────

async function executeExit(position, exitPrice, reason, fraction, peakPnlPct) {
  // Set lock so exit loop doesn't fire again while this sell is processing
  exitingNow.add(position.tokenAddress);
  log.info(`Executing exit for ${position.ticker}: reason=${reason}, price=${exitPrice.toFixed(8)}`);

  try {
    const result = await sellToken(position.tokenAddress, fraction, position.entryPrice);

    const finalExitPrice = result.exitPrice || exitPrice;
    // Use actual USD received vs USD originally spent for accurate PnL
    const usdReceived = result.usdReceived || 0;
    const realizedPnlUsd = usdReceived > 0 ? usdReceived - position.sizeUsd : position.sizeUsd * ((finalExitPrice - position.entryPrice) / position.entryPrice);
    const realizedPnlPct = (realizedPnlUsd / position.sizeUsd) * 100;
    const holdTimeMs = Date.now() - new Date(position.entryTime).getTime();

    const trade = {
      tokenAddress: position.tokenAddress,
      tokenName: position.tokenName,
      ticker: position.ticker,
      direction: 'sell',
      entryPrice: position.entryPrice,
      exitPrice: finalExitPrice,
      sizeUsd: position.sizeUsd,
      sizeTokens: position.sizeTokens,
      realizedPnlUsd,
      realizedPnlPct,
      holdTimeMinutes: holdTimeMs / 60000,
      exitReason: reason,
      peakUnrealizedPct: peakPnlPct,
      confidenceScore: position.confidenceScore,
      openedAt: position.entryTime,
      closedAt: new Date().toISOString(),
      txSignature: result.signature || '',
    };

    db.logTrade(trade);
    db.closePosition(position.tokenAddress);
    db.setCooldown(position.tokenAddress, reason);
    peakPrices.delete(position.tokenAddress);
    exitingNow.delete(position.tokenAddress);

    await discord.notifyExit(trade);
    log.info(`Exit complete: ${position.ticker} | PnL: ${realizedPnlPct.toFixed(2)}% ($${realizedPnlUsd.toFixed(2)})`);

    return trade;
  } catch (err) {
    exitingNow.delete(position.tokenAddress);
    log.error(`Exit execution failed for ${position.ticker}: ${err.message}`);
    await discord.notifyError('ExitManager', `EXIT FAILED for ${position.ticker} — MANUAL ACTION REQUIRED`, err.message);
    throw err;
  }
}

// ─── Execute partial exit ─────────────────────────────────────────────────────

async function executePartialExit(position, exitPrice, fraction, peakPnlPct) {
  log.info(`Partial exit: ${position.ticker} (${(fraction * 100).toFixed(0)}%)`);
  try {
    const result = await sellToken(position.tokenAddress, fraction, position.entryPrice);
    if (!result.success) return null;

    const partialPnlPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
    const partialPnlUsd = position.sizeUsd * fraction * (partialPnlPct / 100);

    db.logTrade({
      tokenAddress: position.tokenAddress,
      tokenName: position.tokenName,
      ticker: position.ticker,
      direction: 'partial_sell',
      entryPrice: position.entryPrice,
      exitPrice,
      sizeUsd: position.sizeUsd * fraction,
      sizeTokens: position.sizeTokens * fraction,
      realizedPnlUsd: partialPnlUsd,
      realizedPnlPct: partialPnlPct,
      holdTimeMinutes: (Date.now() - new Date(position.entryTime).getTime()) / 60000,
      exitReason: 'PARTIAL_TP',
      peakUnrealizedPct: peakPnlPct,
      confidenceScore: position.confidenceScore,
      openedAt: position.entryTime,
      closedAt: new Date().toISOString(),
      txSignature: result.signature || '',
    });

    return result;
  } catch (err) {
    log.error(`Partial exit failed for ${position.ticker}: ${err.message}`);
    return null;
  }
}

// ─── Force close (kill switch / manual) ──────────────────────────────────────

async function forceCloseAll(reason = 'KILL_SWITCH') {
  const positions = db.getOpenPositions();
  log.warn(`Force closing ${positions.length} positions: ${reason}`);

  for (const position of positions) {
    try {
      const price = await getCurrentPrice(position.tokenAddress);
      await executeExit(position, price || position.entryPrice, reason, 1.0, 0);
    } catch (err) {
      log.error(`Force close failed for ${position.ticker}: ${err.message}`);
    }
  }
}

module.exports = { checkAllPositions, forceCloseAll, executeExit };
