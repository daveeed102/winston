// FILE: src/health/server.js
// Express health server.
// Railway uses this to confirm the container is alive.
// Also exposes /status for quick bot inspection.

const express = require('express');
const config = require('./config');
const db = require('./db');
const { createLogger } = require('./logger');

const log = createLogger('HEALTH');
const app = express();

app.get('/health', (req, res) => {
  res.json({ status: 'ok', bot: 'Winston', version: config.VERSION, time: new Date().toISOString() });
});

app.get('/status', (req, res) => {
  try {
    const openPositions = db.getOpenPositions();
    const todayTrades = db.getTodayTrades();
    const todayPnl = db.getDailyPnl();
    const recentCandidates = db.getRecentCandidates(10);

    res.json({
      bot: 'Winston',
      version: config.VERSION,
      time: new Date().toISOString(),
      killSwitch: config.KILL_SWITCH,
      pauseNewEntries: config.PAUSE_NEW_ENTRIES,
      openPositions: openPositions.map((p) => ({
        ticker: p.ticker,
        entryPrice: p.entryPrice,
        sizeUsd: p.sizeUsd,
        entryTime: p.entryTime,
        trailingActive: p.trailingActive,
        confidence: p.confidenceScore,
      })),
      todayTrades: todayTrades.length,
      todayPnl,
      recentCandidates: recentCandidates.map((c) => ({
        ticker: c.ticker,
        confidence: c.confidence_score,
        action: c.action_taken,
        scannedAt: c.scanned_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Kill switch endpoint (simple auth via secret header)
app.post('/kill', express.json(), (req, res) => {
  const secret = req.headers['x-winston-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  process.env.KILL_SWITCH = 'true';
  config.KILL_SWITCH = true;
  log.warn('Kill switch activated via API');
  res.json({ status: 'kill switch activated' });
});

function startHealthServer() {
  app.listen(config.HEALTH_PORT, () => {
    log.info(`Health server listening on port ${config.HEALTH_PORT}`);
  });
}

module.exports = { startHealthServer };
