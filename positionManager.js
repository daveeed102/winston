// FILE: src/trading/positionManager.js
// Position entry logic. Validates all pre-trade conditions before buying.
// Calls executor, persists position, notifies Discord.

const config = require('./config');
const db = require('./db');
const { buyToken } = require('./executor');
const { getAllocation } = require('./confidenceCalculator');
const discord = require('./discord');
const { createLogger } = require('./logger');

const log = createLogger('POSITIONS');

// Track time of last entry in memory (supplement to DB cooldowns)
let lastEntryTime = null;

// ─── Pre-entry validation ─────────────────────────────────────────────────────

function canEnterTrade(candidate, confidenceScore) {
  // Kill switch
  if (config.KILL_SWITCH) {
    return { ok: false, reason: 'Kill switch active' };
  }

  // Pause new entries
  if (config.PAUSE_NEW_ENTRIES) {
    return { ok: false, reason: 'New entries paused' };
  }

  // Confidence threshold
  if (confidenceScore < config.MIN_CONFIDENCE_TO_TRADE) {
    return { ok: false, reason: `Confidence ${confidenceScore} below threshold ${config.MIN_CONFIDENCE_TO_TRADE}` };
  }

  // Dump risk
  const dumpRisk = candidate.grokScore?.dump_risk_prob || 0;
  if (dumpRisk > config.MAX_DUMP_RISK_TO_TRADE) {
    return { ok: false, reason: `Dump risk ${(dumpRisk * 100).toFixed(0)}% exceeds max ${(config.MAX_DUMP_RISK_TO_TRADE * 100).toFixed(0)}%` };
  }

  // Max concurrent positions
  const openPositions = db.getOpenPositions();
  if (openPositions.length >= config.MAX_CONCURRENT_POSITIONS) {
    return { ok: false, reason: `Max concurrent positions reached (${config.MAX_CONCURRENT_POSITIONS})` };
  }

  // Max trades per day
  const todayTrades = db.getTodayTrades();
  if (todayTrades.length >= config.MAX_TRADES_PER_DAY) {
    return { ok: false, reason: `Max daily trades reached (${config.MAX_TRADES_PER_DAY})` };
  }

  // Max daily loss
  const todayPnl = db.getDailyPnl();
  if (todayPnl <= -Math.abs(config.MAX_DAILY_LOSS_USD)) {
    return { ok: false, reason: `Max daily loss hit ($${todayPnl.toFixed(2)})` };
  }

  // No duplicate active position for this token
  const existing = db.getPosition(candidate.tokenAddress);
  if (existing && existing.status === 'open') {
    return { ok: false, reason: `Already have open position in ${candidate.ticker}` };
  }

  // Re-entry cooldown
  if (db.isOnCooldown(candidate.tokenAddress, config.REENTRY_COOLDOWN_HOURS)) {
    return { ok: false, reason: `${candidate.ticker} on re-entry cooldown` };
  }

  // Minimum time between entries
  if (lastEntryTime) {
    const minGapMs = config.MIN_TIME_BETWEEN_ENTRIES_MINUTES * 60 * 1000;
    if (Date.now() - lastEntryTime < minGapMs) {
      const remainSec = Math.ceil((minGapMs - (Date.now() - lastEntryTime)) / 1000);
      return { ok: false, reason: `Min entry gap not elapsed (${remainSec}s remaining)` };
    }
  }

  // Market data freshness
  if (candidate.dataFetchedAt) {
    const ageMin = (Date.now() - new Date(candidate.dataFetchedAt).getTime()) / 60000;
    if (ageMin > config.MAX_MARKET_DATA_AGE_MINUTES) {
      return { ok: false, reason: `Market data stale (${ageMin.toFixed(1)} min old)` };
    }
  }

  return { ok: true };
}

// ─── Enter a position ─────────────────────────────────────────────────────────

async function enterPosition(candidate, confidenceScore, grokScore) {
  const ticker = candidate.ticker;

  const check = canEnterTrade(candidate, confidenceScore);
  if (!check.ok) {
    log.info(`Entry blocked for ${ticker}: ${check.reason}`);
    return null;
  }

  // Calculate position size — fixed USD amounts per confidence tier
  const sizeUsdRaw = getAllocation(confidenceScore);
  if (sizeUsdRaw <= 0) {
    log.info(`Zero allocation for ${ticker} at confidence ${confidenceScore}`);
    return null;
  }

  let sizeUsd = Math.min(sizeUsdRaw, config.MAX_POSITION_USD);

  log.info(`Attempting entry: ${ticker} | confidence=${confidenceScore} | size=$${sizeUsd.toFixed(2)}`);

  // ── Live price sanity check ───────────────────────────────────────────────
  // Verify current price is within 20% of what DexScreener reported.
  // Protects against buying a token that is already crashing.
  try {
    const { getCurrentPrice } = require('./dexscreener');
    const livePrice = await getCurrentPrice(candidate.tokenAddress);
    if (livePrice && candidate.priceUsd) {
      const priceDiff = Math.abs(livePrice - candidate.priceUsd) / candidate.priceUsd * 100;
      if (priceDiff > 20) {
        log.warn(`Price moved too much since scan for ${ticker}: scanned $${candidate.priceUsd.toFixed(8)}, live $${livePrice.toFixed(8)} (${priceDiff.toFixed(1)}% diff) — skipping entry`);
        return null;
      }
      log.info(`Price check OK for ${ticker}: $${livePrice.toFixed(8)} (${priceDiff.toFixed(1)}% from scan price)`);
      // Store livePrice in outer scope for entry price calculation
      candidate._verifiedLivePrice = livePrice;
    }
  } catch (err) {
    log.warn(`Live price check failed for ${ticker}: ${err.message} — proceeding anyway`);
  }

  try {
    const result = await buyToken(candidate.tokenAddress, sizeUsd);

    if (!result.success) {
      log.error(`Buy failed for ${ticker}`);
      return null;
    }

    // Use live price check as entry — accurate, not skewed by retry delays
    const entryPrice = candidate._verifiedLivePrice || result.entryPrice;
    log.info(`Entry price for ${ticker}: $${entryPrice.toFixed(8)} (live price check)`);

    // Calculate stop loss from the CORRECT entry price
    const stopLossPrice = entryPrice * (1 - config.EXIT.STOP_LOSS_PCT / 100);

    const position = {
      tokenAddress: candidate.tokenAddress,
      tokenName: candidate.tokenName,
      ticker: candidate.ticker,
      entryPrice: entryPrice,
      entryTime: new Date().toISOString(),
      sizeUsd: result.sizeUsd,
      sizeTokens: result.tokenAmount,
      stopLossPrice,
      trailingActive: false,
      trailingPeakPrice: null,
      trailingStopPrice: null,
      partialTpDone: false,
      confidenceScore,
      allocationPct: sizeUsd,
      grokSnapshot: grokScore,
      allWalletResults: result.allWalletResults || [],  // per-wallet tx results for Discord
      status: 'open',
    };

    // Persist
    db.upsertPosition(position);
    db.setCooldown(candidate.tokenAddress, 'opened');
    db.logCandidate({ ...candidate, confidenceScore }, 'BOUGHT');

    lastEntryTime = Date.now();

    // Discord
    await discord.notifyTradeEntry(position, candidate);
    await discord.notifyStopArmed(position);

    log.info(`✅ Position opened: ${ticker} @ $${entryPrice.toFixed(8)} | stop @ $${stopLossPrice.toFixed(8)}`);
    return position;
  } catch (err) {
    log.error(`Entry error for ${ticker}: ${err.message}`);
    await discord.notifyError('PositionManager', `Entry failed for ${ticker}`, err.message);
    return null;
  }
}

module.exports = { enterPosition, canEnterTrade };
