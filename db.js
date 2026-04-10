// FILE: db.js
// SQLite persistence using sql.js (pure JS — no native compilation needed).
// Loads DB from disk on startup, saves back to disk after every write.

const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');

const log = createLogger('DB');
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'winston.db');

let db;
let SQL;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function initDb() {
  const initSqlJs = require('sql.js');
  SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    log.info(`Database loaded from ${DB_PATH}`);
  } else {
    db = new SQL.Database();
    log.info(`New database created at ${DB_PATH}`);
  }

  createTables();
  save(); // write initial state
  return db;
}

function save() {
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (err) {
    log.error(`DB save failed: ${err.message}`);
  }
}

function run(sql, params = []) {
  db.run(sql, params);
  save();
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// ─── Tables ───────────────────────────────────────────────────────────────────

function createTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address TEXT NOT NULL UNIQUE,
      token_name TEXT,
      ticker TEXT,
      entry_price REAL NOT NULL,
      entry_time TEXT NOT NULL,
      size_usd REAL NOT NULL,
      size_tokens REAL NOT NULL,
      stop_loss_price REAL NOT NULL,
      trailing_active INTEGER DEFAULT 0,
      trailing_peak_price REAL,
      trailing_stop_price REAL,
      partial_tp_done INTEGER DEFAULT 0,
      confidence_score REAL,
      allocation_pct REAL,
      grok_snapshot TEXT,
      take_profit_price REAL,
      status TEXT DEFAULT 'open',
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address TEXT NOT NULL,
      token_name TEXT,
      ticker TEXT,
      direction TEXT NOT NULL,
      entry_price REAL,
      exit_price REAL,
      size_usd REAL,
      size_tokens REAL,
      realized_pnl_usd REAL,
      realized_pnl_pct REAL,
      hold_time_minutes REAL,
      exit_reason TEXT,
      peak_unrealized_pct REAL,
      confidence_score REAL,
      opened_at TEXT,
      closed_at TEXT,
      tx_signature TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS cooldowns (
      token_address TEXT PRIMARY KEY,
      last_trade_time TEXT NOT NULL,
      reason TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS candidate_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address TEXT NOT NULL,
      token_name TEXT,
      ticker TEXT,
      scanned_at TEXT DEFAULT (datetime('now')),
      confidence_score REAL,
      action_taken TEXT,
      snapshot TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS daily_summary (
      date TEXT PRIMARY KEY,
      trades_count INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      gross_pnl_usd REAL DEFAULT 0,
      best_trade_pct REAL DEFAULT 0,
      worst_trade_pct REAL DEFAULT 0
    )
  `);

  save();
  log.info('Tables ready.');
}

// ─── Positions ────────────────────────────────────────────────────────────────

function upsertPosition(pos) {
  db.run(`
    INSERT INTO positions (
      token_address, token_name, ticker, entry_price, entry_time,
      size_usd, size_tokens, stop_loss_price, trailing_active,
      trailing_peak_price, trailing_stop_price, partial_tp_done,
      confidence_score, allocation_pct, grok_snapshot, take_profit_price, status, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(token_address) DO UPDATE SET
      trailing_active=excluded.trailing_active,
      trailing_peak_price=excluded.trailing_peak_price,
      trailing_stop_price=excluded.trailing_stop_price,
      partial_tp_done=excluded.partial_tp_done,
      stop_loss_price=excluded.stop_loss_price,
      status=excluded.status,
      updated_at=datetime('now')
  `, [
    pos.tokenAddress, pos.tokenName || '', pos.ticker || '',
    pos.entryPrice, pos.entryTime || new Date().toISOString(),
    pos.sizeUsd, pos.sizeTokens, pos.stopLossPrice,
    pos.trailingActive ? 1 : 0,
    pos.trailingPeakPrice || null, pos.trailingStopPrice || null,
    pos.partialTpDone ? 1 : 0,
    pos.confidenceScore || null, pos.allocationPct || null,
    pos.grokSnapshot ? JSON.stringify(pos.grokSnapshot) : null,
    pos.takeProfitPrice || null,
    pos.status || 'open',
  ]);
  save();
}

function getOpenPositions() {
  return all(`SELECT * FROM positions WHERE status = 'open'`).map(deserializePosition);
}

function getPosition(tokenAddress) {
  const row = get(`SELECT * FROM positions WHERE token_address = ?`, [tokenAddress]);
  return row ? deserializePosition(row) : null;
}

function closePosition(tokenAddress) {
  run(`UPDATE positions SET status='closed', updated_at=datetime('now') WHERE token_address=?`, [tokenAddress]);
}

function deserializePosition(row) {
  return {
    ...row,
    tokenAddress: row.token_address,
    tokenName: row.token_name,
    entryPrice: row.entry_price,
    entryTime: row.entry_time,
    sizeUsd: row.size_usd,
    sizeTokens: row.size_tokens,
    stopLossPrice: row.stop_loss_price,
    trailingActive: row.trailing_active === 1,
    trailingPeakPrice: row.trailing_peak_price,
    trailingStopPrice: row.trailing_stop_price,
    partialTpDone: row.partial_tp_done === 1,
    confidenceScore: row.confidence_score,
    allocationPct: row.allocation_pct,
    grokSnapshot: row.grok_snapshot ? JSON.parse(row.grok_snapshot) : null,
    takeProfitPrice: row.take_profit_price || null,
  };
}

// ─── Trades ───────────────────────────────────────────────────────────────────

function logTrade(trade) {
  db.run(`
    INSERT INTO trades (
      token_address, token_name, ticker, direction, entry_price, exit_price,
      size_usd, size_tokens, realized_pnl_usd, realized_pnl_pct,
      hold_time_minutes, exit_reason, peak_unrealized_pct,
      confidence_score, opened_at, closed_at, tx_signature
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `, [
    trade.tokenAddress, trade.tokenName || '', trade.ticker || '',
    trade.direction || 'buy', trade.entryPrice || null, trade.exitPrice || null,
    trade.sizeUsd || 0, trade.sizeTokens || 0,
    trade.realizedPnlUsd || 0, trade.realizedPnlPct || 0,
    trade.holdTimeMinutes || 0, trade.exitReason || '',
    trade.peakUnrealizedPct || 0, trade.confidenceScore || null,
    trade.openedAt || '', trade.closedAt || new Date().toISOString(),
    trade.txSignature || '',
  ]);
  save();
}

function getTodayTrades() {
  const today = new Date().toISOString().slice(0, 10);
  return all(`SELECT * FROM trades WHERE date(closed_at) = ?`, [today]);
}

function getDailyPnl() {
  const today = new Date().toISOString().slice(0, 10);
  const row = get(`SELECT COALESCE(SUM(realized_pnl_usd), 0) AS total FROM trades WHERE date(closed_at) = ?`, [today]);
  return row?.total || 0;
}

// ─── Cooldowns ────────────────────────────────────────────────────────────────

function setCooldown(tokenAddress, reason = 'traded') {
  db.run(`
    INSERT INTO cooldowns (token_address, last_trade_time, reason)
    VALUES (?, datetime('now'), ?)
    ON CONFLICT(token_address) DO UPDATE SET last_trade_time=datetime('now'), reason=excluded.reason
  `, [tokenAddress, reason]);
  save();
}

function isOnCooldown(tokenAddress, cooldownHours) {
  const row = get(`SELECT last_trade_time FROM cooldowns WHERE token_address = ?`, [tokenAddress]);
  if (!row) return false;
  const diff = (Date.now() - new Date(row.last_trade_time).getTime()) / (1000 * 60 * 60);
  return diff < cooldownHours;
}

// ─── Bot state ────────────────────────────────────────────────────────────────

function setState(key, value) {
  db.run(`
    INSERT INTO bot_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')
  `, [key, JSON.stringify(value)]);
  save();
}

function getState(key, defaultValue = null) {
  const row = get(`SELECT value FROM bot_state WHERE key = ?`, [key]);
  if (!row) return defaultValue;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

// ─── Candidate history ────────────────────────────────────────────────────────

function logCandidate(candidate, action) {
  db.run(`
    INSERT INTO candidate_history (token_address, token_name, ticker, confidence_score, action_taken, snapshot)
    VALUES (?,?,?,?,?,?)
  `, [
    candidate.tokenAddress, candidate.tokenName || '', candidate.ticker || '',
    candidate.confidenceScore || null, action, JSON.stringify(candidate),
  ]);
  save();
}

function getRecentCandidates(limit = 50) {
  return all(`SELECT * FROM candidate_history ORDER BY scanned_at DESC LIMIT ?`, [limit]);
}

// ─── Daily summary ────────────────────────────────────────────────────────────

function updateDailySummary() {
  const today = new Date().toISOString().slice(0, 10);
  const trades = all(`SELECT * FROM trades WHERE date(closed_at) = ?`, [today]);
  if (!trades.length) return;

  const wins = trades.filter(t => t.realized_pnl_usd > 0).length;
  const losses = trades.filter(t => t.realized_pnl_usd <= 0).length;
  const grossPnl = trades.reduce((s, t) => s + (t.realized_pnl_usd || 0), 0);
  const bestPct = Math.max(...trades.map(t => t.realized_pnl_pct || 0));
  const worstPct = Math.min(...trades.map(t => t.realized_pnl_pct || 0));

  db.run(`
    INSERT INTO daily_summary (date, trades_count, wins, losses, gross_pnl_usd, best_trade_pct, worst_trade_pct)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(date) DO UPDATE SET
      trades_count=excluded.trades_count, wins=excluded.wins, losses=excluded.losses,
      gross_pnl_usd=excluded.gross_pnl_usd, best_trade_pct=excluded.best_trade_pct,
      worst_trade_pct=excluded.worst_trade_pct
  `, [today, trades.length, wins, losses, grossPnl, bestPct, worstPct]);
  save();
}

module.exports = {
  initDb, save,
  upsertPosition, getOpenPositions, getPosition, closePosition,
  logTrade, getTodayTrades, getDailyPnl,
  setCooldown, isOnCooldown,
  setState, getState,
  logCandidate, getRecentCandidates,
  updateDailySummary,
};
