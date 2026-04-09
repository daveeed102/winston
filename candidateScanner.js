// FILE: src/scanner/candidateScanner.js
// The main pipeline orchestrator.
// Discovery → Hard Filters → Grok Score → Confidence → Entry Decision

const config = require('./config');
const { discoverCandidates } = require('./dexscreener');
const { applyHardFilters } = require('./tokenFilters');
const { scoreCandidate } = require('./grokScorer');
const { calculateConfidence } = require('./confidenceCalculator');
const { enterPosition } = require('./positionManager');
const db = require('./db');
const discord = require('./discord');
const { createLogger } = require('./logger');

const log = createLogger('SCANNER');

// Track last scan time for heartbeat
let lastScanTime = null;
let lastCandidatesFound = 0;

// ─── Main scan cycle ──────────────────────────────────────────────────────────

async function runScanCycle() {
  if (config.KILL_SWITCH) {
    log.warn('Kill switch active — scan skipped');
    return;
  }

  log.info('═══ Starting scan cycle ═══');
  const scanStart = Date.now();

  try {
    // Step 1: Discover candidates from DexScreener
    const rawCandidates = await discoverCandidates();
    log.info(`Discovered ${rawCandidates.length} raw candidates`);

    if (!rawCandidates.length) {
      log.warn('No candidates returned from discovery');
      lastScanTime = new Date().toISOString();
      return;
    }

    // Step 2: Hard filter
    const passed = [];
    const rejected = [];

    for (const candidate of rawCandidates) {
      // Skip if already in open position
      const existing = db.getPosition(candidate.tokenAddress);
      if (existing?.status === 'open') {
        continue;
      }

      // Skip if on cooldown
      if (db.isOnCooldown(candidate.tokenAddress, config.REENTRY_COOLDOWN_HOURS)) {
        continue;
      }

      const filterResult = applyHardFilters(candidate);
      if (filterResult.pass) {
        passed.push(candidate);
      } else {
        rejected.push({ ticker: candidate.ticker, reason: filterResult.reason });
      }
    }

    log.info(`Hard filters: ${passed.length} passed, ${rejected.length} rejected`);
    if (rejected.length > 0) {
      log.debug('Filter rejections:', rejected.slice(0, 5)); // log first 5
    }

    lastCandidatesFound = passed.length;

    if (!passed.length) {
      log.info('No candidates survived hard filters this cycle');
      lastScanTime = new Date().toISOString();
      return;
    }

    // Sort by volume acceleration + boost (most promising first)
    passed.sort((a, b) =>
      (b.volumeAcceleration * (b.boostAmount > 0 ? 1.2 : 1)) -
      (a.volumeAcceleration * (a.boostAmount > 0 ? 1.2 : 1))
    );

    // Limit to top N candidates per cycle to avoid Grok rate limits
    const MAX_PER_CYCLE = 6;
    const toScore = passed.slice(0, MAX_PER_CYCLE);

    log.info(`Scoring top ${toScore.length} candidates with Grok...`);

    // Step 3: Score each candidate
    const scored = [];

    for (const candidate of toScore) {
      // Notify candidate found
      await discord.notifyCandidateFound(candidate);

      let grokScore = null;
      try {
        grokScore = await scoreCandidate(candidate);
      } catch (err) {
        log.error(`Grok scoring failed for ${candidate.ticker}: ${err.message}`);
        db.logCandidate(candidate, 'GROK_FAILED');
        continue;
      }

      if (!grokScore) {
        log.warn(`Grok returned invalid score for ${candidate.ticker}`);
        db.logCandidate(candidate, 'GROK_INVALID');
        continue;
      }

      // Step 4: Calculate final confidence
      const confidenceResult = calculateConfidence(candidate, grokScore);
      if (!confidenceResult) {
        db.logCandidate(candidate, 'CONFIDENCE_FAILED');
        continue;
      }

      candidate.grokScore = grokScore;
      candidate.confidenceScore = confidenceResult.score;
      candidate.confidenceTier = confidenceResult.tier;
      candidate.confidenceBreakdown = confidenceResult.breakdown;

      // Notify score created
      await discord.notifyScoreCreated(candidate);

      // Log to history
      db.logCandidate(candidate, confidenceResult.score >= config.MIN_CONFIDENCE_TO_TRADE ? 'ELIGIBLE' : 'SCORED_LOW');

      if (confidenceResult.score >= config.MIN_CONFIDENCE_TO_TRADE) {
        scored.push(candidate);
      }
    }

    log.info(`${scored.length} candidates eligible for entry after scoring`);

    // Sort eligible candidates by confidence (best first)
    scored.sort((a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0));

    // Step 5: Enter positions
    for (const candidate of scored) {
      // Check if we're at max positions before each entry
      const openPositions = db.getOpenPositions();
      if (openPositions.length >= config.MAX_CONCURRENT_POSITIONS) {
        log.info(`Max concurrent positions reached (${config.MAX_CONCURRENT_POSITIONS}), skipping remaining candidates`);
        break;
      }

      if (config.PAUSE_NEW_ENTRIES) {
        log.info('New entries paused, skipping entry');
        break;
      }

      await enterPosition(candidate, candidate.confidenceScore, candidate.grokScore);

      // Small delay between entries
      await sleep(3000);
    }

    const elapsed = ((Date.now() - scanStart) / 1000).toFixed(1);
    log.info(`═══ Scan cycle complete in ${elapsed}s ═══`);
    lastScanTime = new Date().toISOString();
  } catch (err) {
    log.error(`Scan cycle error: ${err.message}`, err.stack);
    await discord.notifyError('Scanner', 'Scan cycle failed', err.message);
    lastScanTime = new Date().toISOString();
  }
}

function getLastScanTime() {
  return lastScanTime;
}

function getLastCandidatesFound() {
  return lastCandidatesFound;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { runScanCycle, getLastScanTime, getLastCandidatesFound };
