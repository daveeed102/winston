// FILE: src/scoring/grokScorer.js
// Grok AI scoring layer.
// Sends a structured token snapshot and gets back continuation probabilities.
// Includes freshness enforcement — Grok must report WHEN social data is from.
// Stale social data (>2h old) is penalized automatically in the confidence calc.

const axios = require('axios');
const config = require('./config');
const { createLogger } = require('./logger');

const log = createLogger('GROK');

const EXPECTED_FIELDS = [
  'continuation_24h_prob',
  'continuation_48h_prob',
  'dump_risk_prob',
  'hype_quality_score',
  'narrative_strength_score',
  'trend_health_score',
  'overall_confidence_score',
  'verdict',
  'summary_reason',
  'social_data_fresh',
  'most_recent_post_age_minutes',
];

// ─── Main scoring call ────────────────────────────────────────────────────────

async function scoreCandidate(candidate) {
  if (!config.GROK_API_KEY) throw new Error('GROK_API_KEY not set');

  const now = new Date();
  const prompt = buildPrompt(candidate, now);

  try {
    const res = await axios.post(
      `${config.GROK_API_BASE}/chat/completions`,
      {
        model: config.GROK_MODEL,
        max_tokens: 800,
        temperature: 0.1, // lower = less creative = less hallucination
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${config.GROK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 25000,
      }
    );

    const raw = res.data?.choices?.[0]?.message?.content || '';
    return parseGrokResponse(raw, candidate);
  } catch (err) {
    log.error(`Grok API call failed for ${candidate.ticker}: ${err.message}`);
    throw err;
  }
}

// ─── Parse and validate Grok response ────────────────────────────────────────

function parseGrokResponse(raw, candidate) {
  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); }
      catch {
        log.warn(`Could not parse Grok JSON for ${candidate.ticker}. Raw: ${raw.slice(0, 300)}`);
        return null;
      }
    } else {
      log.warn(`No JSON found in Grok response for ${candidate.ticker}`);
      return null;
    }
  }

  // Validate required core fields
  const coreFields = [
    'continuation_24h_prob', 'continuation_48h_prob', 'dump_risk_prob',
    'hype_quality_score', 'narrative_strength_score', 'trend_health_score',
    'overall_confidence_score', 'verdict', 'summary_reason',
  ];
  for (const field of coreFields) {
    if (parsed[field] === undefined || parsed[field] === null) {
      log.warn(`Grok response missing field '${field}' for ${candidate.ticker}`);
      return null;
    }
  }

  // Validate probability ranges
  for (const f of ['continuation_24h_prob', 'continuation_48h_prob', 'dump_risk_prob']) {
    const v = parsed[f];
    if (typeof v !== 'number' || v < 0 || v > 1) {
      log.warn(`Grok field '${f}' out of range (${v}) for ${candidate.ticker}`);
      return null;
    }
  }

  // Validate score ranges
  for (const f of ['hype_quality_score', 'narrative_strength_score', 'trend_health_score', 'overall_confidence_score']) {
    const v = parsed[f];
    if (typeof v !== 'number' || v < 0 || v > 100) {
      log.warn(`Grok field '${f}' out of range (${v}) for ${candidate.ticker}`);
      return null;
    }
  }

  // Normalize verdict
  if (!['BUY', 'SKIP', 'WAIT'].includes(parsed.verdict)) {
    parsed.verdict = parsed.overall_confidence_score >= 75 ? 'BUY' : 'SKIP';
  }

  // ── Freshness enforcement ──────────────────────────────────────────────────
  // If Grok reports stale social data, penalize hype scores automatically.
  // This is the hallucination guard — Grok must be honest about recency.
  const postAgeMinutes = parsed.most_recent_post_age_minutes;
  const isFresh = parsed.social_data_fresh !== false;

  if (!isFresh || (typeof postAgeMinutes === 'number' && postAgeMinutes > 120)) {
    const staleAge = postAgeMinutes ? `${postAgeMinutes} min` : 'unknown age';
    log.warn(`⚠️  Stale social data for ${candidate.ticker} (most recent post: ${staleAge}) — penalizing hype scores`);

    // Cap hype scores if data is stale
    parsed.hype_quality_score = Math.min(parsed.hype_quality_score, 35);
    parsed.narrative_strength_score = Math.min(parsed.narrative_strength_score, 45);

    // Flag it so confidence calculator can apply additional penalty
    parsed.socialDataStale = true;
    parsed.staleAgeMinutes = postAgeMinutes || null;
  } else {
    parsed.socialDataStale = false;
    log.info(`✅ Fresh social data for ${candidate.ticker} (most recent post: ~${postAgeMinutes} min ago)`);
  }

  log.info(`Grok scored ${candidate.ticker}: confidence=${parsed.overall_confidence_score}, verdict=${parsed.verdict}, fresh=${!parsed.socialDataStale}`);
  return parsed;
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompt(c, now) {
  const nowStr = now.toUTCString();
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toUTCString();

  return `
The current time is: ${nowStr}

STEP 1 — LIVE SEARCH (do this first, before scoring):
Search X (Twitter) and the web RIGHT NOW for posts about "${c.tokenName}" (ticker: $${c.ticker}).
You are ONLY looking for posts published after: ${twoHoursAgo}
If you find posts, note approximately how many minutes ago the most recent one was posted.
If the most recent post you can find is older than 2 hours, set social_data_fresh to false.
Do NOT use posts from yesterday or earlier to inflate hype scores.

STEP 2 — MARKET DATA SNAPSHOT:
- Token: ${c.tokenName} (${c.ticker})
- Chain: Solana
- Contract: ${c.tokenAddress}
- Price: $${c.priceUsd?.toFixed(8)}
- Token Age: ${c.ageHours?.toFixed(1)} hours
- Liquidity: $${c.liquidityUsd?.toFixed(0)}
- 1h Price Change: ${c.priceChange1h?.toFixed(2)}%
- 6h Price Change: ${c.priceChange6h?.toFixed(2)}%
- 24h Price Change: ${c.priceChange24h?.toFixed(2)}%
- Volume 1h: $${c.volume1h?.toFixed(0)}
- Volume 6h: $${c.volume6h?.toFixed(0)}
- Volume 24h: $${c.volume24h?.toFixed(0)}
- Volume Acceleration (1h vs 24h avg): ${c.volumeAcceleration?.toFixed(2)}x
- Buys last 1h: ${c.buys1h}
- Sells last 1h: ${c.sells1h}
- Buy/Sell Ratio: ${c.buySellRatio1h?.toFixed(2)}
- Pullback from Recent High: ${c.pullbackFromHigh?.toFixed(1)}%
- Boost Amount: ${c.boostAmount}
- Description: ${c.description || 'none'}
- Twitter/X link: ${c.twitterLink || 'none'}

STEP 3 — EVALUATE:
1. Continuation potential for next 24–48 hours
2. Dump risk: bot volume, wash trading, whale exit, rug signals
3. Hype quality: is social energy organic and CURRENTLY GROWING (last 2h)?
4. Narrative strength: is there a real story people are excited about RIGHT NOW?
5. Trend health: does price structure support a second leg?

STEP 4 — RETURN ONLY this JSON, nothing else:
{
  "continuation_24h_prob": <0.0–1.0>,
  "continuation_48h_prob": <0.0–1.0>,
  "dump_risk_prob": <0.0–1.0>,
  "hype_quality_score": <0–100>,
  "narrative_strength_score": <0–100>,
  "trend_health_score": <0–100>,
  "overall_confidence_score": <0–100>,
  "verdict": "<BUY|SKIP|WAIT>",
  "summary_reason": "<1-2 sentences including what you found socially and when>",
  "social_data_fresh": <true if you found posts from last 2 hours, false otherwise>,
  "most_recent_post_age_minutes": <how many minutes ago the most recent post was, or null if not found>
}
`.trim();
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are Winston's AI scoring module. You score Solana tokens for continuation trading potential.

STEP 1 — LIVE SEARCH FIRST:
Search X (Twitter) and the web RIGHT NOW before scoring anything.
Only count posts from the LAST 2 HOURS. Report the age of the most recent post you find.
If you cannot find posts from the last 2 hours, set social_data_fresh=false.
Do NOT use old posts to inflate hype scores. Be honest about what you found and when.

STEP 2 — SCORE EACH DIMENSION using these EXACT rubrics:

── hype_quality_score (0–100) ──────────────────────────────
100 = Massive organic X/CT buzz right now, hundreds of fresh posts, influencers posting, trending
80  = Strong fresh community activity, multiple posts last hour, real people excited
60  = Moderate activity, some posts last 2h, small community engaging
40  = Minimal activity, last post 2–4h ago, low engagement
20  = Stale or no social presence, last post >4h ago, or looks botted
0   = Dead, no posts found, or obviously fake/spam engagement

── narrative_strength_score (0–100) ────────────────────────
100 = Strong clear narrative (AI, RWA, gaming, meme with cultural moment) with real community buy-in
80  = Identifiable theme, people are genuinely excited about the story
60  = Vague narrative but some coherent angle
40  = No clear narrative, just price movement
20  = Confusing or misleading description
0   = No narrative, anonymous token, copy-paste of another project

── trend_health_score (0–100) ──────────────────────────────
100 = Clean breakout structure, healthy consolidation after initial move, volume increasing on bounces
80  = Good momentum, moderate pullback from high (<15%), buy pressure increasing
60  = Decent momentum but some chop, pullback 15–25%, volume holding
40  = Extended move, showing distribution signs, pullback >25%
20  = Overextended parabolic, likely exhausted, low buy/sell ratio
0   = Clearly dumping, volume declining hard, sells dominating

── dump_risk_prob (0.0–1.0) ────────────────────────────────
0.0–0.1 = Clean: locked liquidity, no mint/freeze authority, distributed holders, organic volume
0.1–0.2 = Low risk: minor concerns but nothing alarming
0.2–0.35 = Moderate: some red flags (concentrated holders, unverified contract, thin liq)
0.35–0.6 = High: multiple red flags (mint authority active, top 10 hold >50%, suspicious volume)
0.6–1.0 = Extreme: honeypot signals, freeze authority, rug indicators, dev wallet dumping

── continuation_24h_prob / continuation_48h_prob (0.0–1.0) ─
Base these on: trend health + hype freshness + narrative strength + market structure
0.8+ = Very likely to continue, strong setup across all dimensions
0.6–0.8 = Probable continuation, most signals positive
0.4–0.6 = Uncertain, mixed signals
0.2–0.4 = Unlikely, setup looks weak or exhausted
0.0–0.2 = Very unlikely, strong reversal signals

── overall_confidence_score (0–100) ────────────────────────
DO NOT just average the other scores.
Start at 50. Then:
+15 if continuation_24h_prob >= 0.70
+10 if hype_quality_score >= 70 AND social_data_fresh = true
+10 if trend_health_score >= 70
+8  if narrative_strength_score >= 70
+8  if dump_risk_prob <= 0.15
+5  if volume acceleration >= 2x
-10 if dump_risk_prob >= 0.35
-15 if dump_risk_prob >= 0.50
-10 if social_data_fresh = false
-10 if trend_health_score <= 30
-8  if hype_quality_score <= 30
Cap at 100, floor at 0.

verdict rules:
- BUY if overall_confidence_score >= 75 AND dump_risk_prob <= 0.35
- WAIT if overall_confidence_score >= 60 but not BUY criteria
- SKIP everything else

Return ONLY the JSON object. No markdown, no preamble, no explanation outside JSON.
`.trim();

module.exports = { scoreCandidate };
