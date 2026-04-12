/**
 * Health check server for Railway
 */

const express = require('express');
const config = require('./config');
const logger = require('./logger');
const positions = require('./positionTracker');
const jupiter = require('./jupiter');

let server;

function start() {
  const app = express();

  app.get('/', (req, res) => {
    res.json({ status: 'ok', bot: 'Winston Sniper' });
  });

  app.get('/health', async (req, res) => {
    try {
      const solBalance = await jupiter.getSolBalance();
      res.json({
        status: 'ok',
        bot: 'Winston Sniper v1.0',
        uptime: process.uptime(),
        openPositions: positions.count(),
        maxPositions: config.MAX_POSITIONS,
        solBalance: solBalance.toFixed(4),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  server = app.listen(config.PORT, () => {
    logger.info(`[HEALTH] Server on port ${config.PORT}`);
  });
}

function stop() {
  if (server) server.close();
}

module.exports = { start, stop };
