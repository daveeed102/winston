// FILE: src/scoring/confidenceCalculator.js
// Final confidence score = weighted combination of:
//   - Market quality (from hard filter scoring)
//   - Grok AI scores
//   - Anti-dump / anti-exhaustion penalties
//
// Output: 0–100. Trading only happens above MIN_CONFIDENCE_TO_TRADE.

const config = require('./config');
const { marketQualityScore } = require('./tokenFilters');
const { createLogger } = require('./logger');

const log = createLogger('CONFIDENCE');

// Weights must sum to 100
const WEIGHTS = {
  grokOverall: 35,         // Grok's own overall_confidence_score
  continuation24h: 15,     // Grok continuation probability 24h
  trendHealth: 15,         // Grok trend health
  hypeQuality: 10,         // Grok hype quality
  marketQuality: 20,       // Our market data scoring (liquidity, vol accel, buy/sell ratio)
  // Anti-dump is a PENALTY applied after, max -30
};

function calculateConfidence(candidate, grokScore) {
  if (!grokScore) {
    log.warn(`No Grok score for ${candidate.ticker} — cannot compute confidence`);
    return null;
  }

  const g = grokScore;

  // ── Raw component scores (all normalized 0–100) ───────────────────────────

  const grokOverallNorm = clamp(g.overall_confidence_score, 0, 100);
  const continuation24hNorm = clamp(g.continuation_24h_prob * 100, 0, 100);
  const trendHealthNorm = clamp(g.trend_health_score, 0, 100);
  const hypeQualityNorm = clamp(g.hype_quality_score, 0, 100);
  const marketQualityNorm = clamp(marketQualityScore(candidate) * (100 / 40), 0, 100);

  // ── Weighted base score ───────────────────────────────────────────────────
  const base =
    (grokOverallNorm    * WEIGHTS.grokOverall    / 100) +
    (continuation24hNorm * WEIGHTS.continuation24h / 100) +
    (trendHealthNorm    * WEIGHTS.trendHealth    / 100) +
    (hypeQualityNorm    * WEIGHTS.hypeQuality    / 100) +
    (marketQualityNorm  * WEIGHTS.marketQuality  / 100);

  // ── Anti-dump penalty (max -30 points) ───────────────────────────────────
  const dumpRisk = g.dump_risk_prob || 0;
  let dumpPenalty = 0;
  if (dumpRisk >= 0.7) dumpPenalty = 30;
  else if (dumpRisk >= 0.5) dumpPenalty = 20;
  else if (dumpRisk >= 0.35) dumpPenalty = 12;
  else if (dumpRisk >= 0.25) dumpPenalty = 5;

  // ── Overextension penalty ─────────────────────────────────────────────────
  // If 1h candle > 50%, penalize 10 — too late, likely near exhaustion
  let extensionPenalty = 0;
  if (candidate.priceChange1h > 60) extensionPenalty = 15;
  else if (candidate.priceChange1h > 50) extensionPenalty = 10;
  else if (candidate.priceChange1h > 40) extensionPenalty = 5;

  // ── Volume authenticity bonus ─────────────────────────────────────────────
  // High buy/sell ratio with high acceleration = genuinely hot
  let volumeBonus = 0;
  if (candidate.buySellRatio1h >= 2.5 && candidate.volumeAcceleration >= 2) volumeBonus = 5;
  else if (candidate.buySellRatio1h >= 2 && candidate.volumeAcceleration >= 1.5) volumeBonus = 3;

  // ── Boost signal (DexScreener boosts signal real attention) ───────────────
  let boostBonus = 0;
  if (candidate.boostAmount >= 1000) boostBonus = 3;
  else if (candidate.boostAmount >= 500) boostBonus = 2;
  else if (candidate.boostAmount >= 100) boostBonus = 1;

  // ── Stale social data penalty ─────────────────────────────────────────────
  // Grok reports whether it found fresh posts (<2h old).
  // If social data is stale, we can't trust hype scores — penalize accordingly.
  let stalePenalty = 0;
  if (g.socialDataStale) {
    const ageMin = g.staleAgeMinutes;
    if (!ageMin || ageMin > 480) stalePenalty = 20;      // >8h or unknown
    else if (ageMin > 240) stalePenalty = 15;             // 4–8h old
    else if (ageMin > 120) stalePenalty = 10;             // 2–4h old
    log.warn(`Stale social penalty for ${candidate.ticker}: -${stalePenalty} pts (last post ~${ageMin || '?'} min ago)`);
  }

  // ── Final score ───────────────────────────────────────────────────────────
  const finalScore = clamp(base - dumpPenalty - extensionPenalty - stalePenalty + volumeBonus + boostBonus, 0, 100);

  const breakdown = {
    grokOverall: grokOverallNorm,
    continuation24h: continuation24hNorm,
    trendHealth: trendHealthNorm,
    hypeQuality: hypeQualityNorm,
    marketQuality: marketQualityNorm,
    base: parseFloat(base.toFixed(1)),
    dumpPenalty,
    extensionPenalty,
    stalePenalty,
    volumeBonus,
    boostBonus,
    final: parseFloat(finalScore.toFixed(1)),
  };

  log.info(`Confidence for ${candidate.ticker}: ${finalScore.toFixed(1)} (dump penalty: ${dumpPenalty}, extension: ${extensionPenalty})`, breakdown);

  return {
    score: parseFloat(finalScore.toFixed(1)),
    tier: getTier(finalScore),
    breakdown,
  };
}

function getTier(score) {
  if (score >= config.CONFIDENCE_TIERS.ELITE)  return 'ELITE';
  if (score >= config.CONFIDENCE_TIERS.STRONG) return 'STRONG';
  if (score >= config.CONFIDENCE_TIERS.GOOD)   return 'GOOD';
  if (score >= config.CONFIDENCE_TIERS.SMALL)  return 'SMALL';
  return 'SKIP';
}

function getAllocation(score) {
  const T = config.CONFIDENCE_TIERS;
  const S = config.SIZING;
  if (score >= T.ELITE)  return S.ELITE;
  if (score >= T.STRONG) return S.STRONG;
  if (score >= T.GOOD)   return S.GOOD;
  if (score >= T.SMALL)  return S.SMALL;
  // Floor tier: covers cases where MIN_CONFIDENCE is set below 75
  if (score >= config.MIN_CONFIDENCE_TO_TRADE) return 0.03; // 3% floor allocation
  return 0;
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

module.exports = { calculateConfidence, getTier, getAllocation };
