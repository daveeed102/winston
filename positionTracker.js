/**
 * Position Tracker
 * In-memory store of all open sniper positions
 * Each position has its own exit monitor running
 */

const logger = require('./logger');

// Map of mintAddress -> position object
const positions = new Map();

/**
 * Position shape:
 * {
 *   mint: string,
 *   buyTxSig: string,
 *   tokenAmount: number,      // raw token units received
 *   solSpent: number,         // SOL spent on buy
 *   buyTime: number,          // Date.now() at buy
 *   targetSolValue: number,   // SOL value that = 20x
 *   exitTimer: Timeout,       // 30s hard stop timer handle
 *   selling: boolean,         // true while sell is in progress
 *   sold: boolean,            // true once fully exited
 * }
 */

function add(mint, positionData) {
  positions.set(mint, { ...positionData, selling: false, sold: false });
}

function get(mint) {
  return positions.get(mint);
}

function getAll() {
  return Array.from(positions.values());
}

function count() {
  return positions.size;
}

function has(mint) {
  return positions.has(mint);
}

function markSelling(mint) {
  const p = positions.get(mint);
  if (p) p.selling = true;
}

function remove(mint) {
  const p = positions.get(mint);
  if (p?.exitTimer) clearTimeout(p.exitTimer);
  positions.delete(mint);
}

function setExitTimer(mint, timer) {
  const p = positions.get(mint);
  if (p) p.exitTimer = timer;
}

module.exports = { add, get, getAll, count, has, markSelling, remove, setExitTimer };
