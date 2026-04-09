// FILE: src/filters/tokenFilters.js
// Hard filters. Applied before Grok scoring to eliminate trash fast.
// A candidate must pass ALL filters to proceed. Fail fast, fail cheap.

const config = require('./config');
const { createLogger } = require('./logger');

const log = createLogger('FILTERS');
const F = config.FILTERS;

// Returns { pass: bool, reason: string }
function applyHardFilters(candidate) {
  const c = candidate;

  // ── Liquidity ──────────────────────────────────────────────────────────────
  if (!c.liquidityUsd || c.liquidityUsd < F.MIN_LIQUIDITY_USD) {
    return fail(`Liquidity too low: $${c.liquidityUsd?.toFixed(0)} < $${F.MIN_LIQUIDITY_USD}`);
  }

  // ── Volume 24h ─────────────────────────────────────────────────────────────
  if (!c.volume24h || c.volume24h < F.MIN_VOLUME_24H_USD) {
    return fail(`Volume 24h too low: $${c.volume24h?.toFixed(0)} < $${F.MIN_VOLUME_24H_USD}`);
  }

  // ── Volume 1h (needs recent activity, not stale momentum) ─────────────────
  if (!c.volume1h || c.volume1h < F.MIN_VOLUME_1H_USD) {
    return fail(`Volume 1h too low: $${c.volume1h?.toFixed(0)} < $${F.MIN_VOLUME_1H_USD}`);
  }

  // ── Token age (not too new, not too old) ───────────────────────────────────
  if (c.ageHours != null) {
    if (c.ageHours < F.MIN_TOKEN_AGE_HOURS) {
      return fail(`Token too new: ${c.ageHours?.toFixed(1)}h < ${F.MIN_TOKEN_AGE_HOURS}h minimum`);
    }
    if (c.ageHours > F.MAX_TOKEN_AGE_DAYS * 24) {
      return fail(`Token too old: ${(c.ageHours / 24).toFixed(1)}d > ${F.MAX_TOKEN_AGE_DAYS}d maximum`);
    }
  }

  // ── Minimum momentum: needs to actually be moving ─────────────────────────
  if (c.priceChange1h < F.MIN_PRICE_CHANGE_1H) {
    return fail(`Not enough 1h momentum: ${c.priceChange1h?.toFixed(1)}% < ${F.MIN_PRICE_CHANGE_1H}%`);
  }

  // ── Reject obviously parabolic / overextended moves ───────────────────────
  if (c.priceChange1h > F.MAX_PRICE_CHANGE_1H) {
    return fail(`1h candle too vertical (overextended): ${c.priceChange1h?.toFixed(1)}% > ${F.MAX_PRICE_CHANGE_1H}%`);
  }

  if (c.priceChange6h < F.MIN_PRICE_CHANGE_6H) {
    return fail(`Not enough 6h momentum: ${c.priceChange6h?.toFixed(1)}% < ${F.MIN_PRICE_CHANGE_6H}%`);
  }

  if (c.priceChange6h > F.MAX_PRICE_CHANGE_6H) {
    return fail(`6h move too extended: ${c.priceChange6h?.toFixed(1)}% > ${F.MAX_PRICE_CHANGE_6H}%`);
  }

  // ── Buy activity (needs real buyers, not just wash trading) ───────────────
  if (c.buys1h < F.MIN_BUYS_1H) {
    return fail(`Not enough buys in last 1h: ${c.buys1h} < ${F.MIN_BUYS_1H}`);
  }

  // ── Pullback check: not too far from local high (exhaustion signal) ────────
  if (c.pullbackFromHigh > F.MAX_PULLBACK_FROM_HIGH) {
    return fail(`Too far from recent high: -${c.pullbackFromHigh?.toFixed(1)}% > ${F.MAX_PULLBACK_FROM_HIGH}% max`);
  }

  // ── Buy/sell ratio: needs net buy pressure ────────────────────────────────
  if (c.buySellRatio1h != null && c.buySellRatio1h < 0.7) {
    return fail(`Net sell pressure: buy/sell ratio ${c.buySellRatio1h?.toFixed(2)} < 0.7`);
  }

  // ── Price must be above zero (data sanity) ────────────────────────────────
  if (!c.priceUsd || c.priceUsd <= 0) {
    return fail(`Invalid price: ${c.priceUsd}`);
  }

  // ── Token address must exist ──────────────────────────────────────────────
  if (!c.tokenAddress || c.tokenAddress.length < 20) {
    return fail(`Invalid token address: ${c.tokenAddress}`);
  }

  // ── Honeypot / rug guardrails ─────────────────────────────────────────────

  // Freeze authority: token issuer can freeze your wallet = honeypot risk
  if (F.REJECT_FREEZE_AUTHORITY && c.freezeAuthority === true) {
    return fail(`Freeze authority active — honeypot risk`);
  }

  // Mint authority: issuer can print more tokens = dump risk
  if (F.REJECT_MINT_AUTHORITY && c.mintAuthority === true) {
    return fail(`Mint authority active — inflation/rug risk`);
  }

  // Top holder concentration: if top 10 wallets hold >60% it's a ticking time bomb
  if (c.top10HolderPct != null && c.top10HolderPct > 60) {
    return fail(`Top 10 holders own ${c.top10HolderPct?.toFixed(0)}% — too concentrated`);
  }

  // Single wallet dominance: one wallet >20% = whale dump risk
  if (c.topHolderPct != null && c.topHolderPct > 20) {
    return fail(`Single wallet owns ${c.topHolderPct?.toFixed(0)}% — whale dump risk`);
  }

  // Suspiciously perfect buy/sell ratio (wash trading signal: ratio > 10 is unnatural)
  if (c.buySellRatio1h > 10) {
    return fail(`Buy/sell ratio unrealistically high (${c.buySellRatio1h?.toFixed(1)}) — likely wash trading`);
  }

  // Zero sells in 1h with significant volume = honeypot (no one can sell)
  if (c.sells1h === 0 && c.volume1h > 5000) {
    return fail(`Zero sells in last 1h with $${c.volume1h?.toFixed(0)} volume — possible honeypot`);
  }

  return { pass: true, reason: 'OK' };
}

// ── Soft scoring factors (used in confidence calc, not hard rejects) ──────────
// Returns a number 0–40 representing market quality bonus

function marketQualityScore(candidate) {
  let score = 0;
  const c = candidate;

  // Liquidity quality (0–10)
  if (c.liquidityUsd >= 500000) score += 10;
  else if (c.liquidityUsd >= 200000) score += 7;
  else if (c.liquidityUsd >= 100000) score += 4;
  else score += 2;

  // Volume acceleration bonus (0–10)
  if (c.volumeAcceleration >= 3) score += 10;       // 3x average = strong
  else if (c.volumeAcceleration >= 2) score += 7;
  else if (c.volumeAcceleration >= 1.5) score += 4;
  else if (c.volumeAcceleration >= 1) score += 2;

  // Buy/sell ratio bonus (0–10)
  if (c.buySellRatio1h >= 3) score += 10;
  else if (c.buySellRatio1h >= 2) score += 7;
  else if (c.buySellRatio1h >= 1.5) score += 4;
  else if (c.buySellRatio1h >= 1) score += 2;

  // Continuation structure: moderate 6h move is healthiest (0–10)
  const move6h = c.priceChange6h || 0;
  if (move6h >= 15 && move6h <= 80) score += 10;
  else if (move6h >= 10 && move6h <= 120) score += 6;
  else if (move6h >= 5) score += 3;

  return Math.min(40, score);
}

function fail(reason) {
  return { pass: false, reason };
}

module.exports = { applyHardFilters, marketQualityScore };
