// FILE: src/utils/logger.js
// Structured logger. Timestamps, levels, clean output for Railway logs.

const config = require('./config');

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const MIN_LEVEL = config.ENV === 'development' ? LEVELS.DEBUG : LEVELS.INFO;

function fmt(level, module, message, data) {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level}] [${module}] ${message}`;
  if (data !== undefined) {
    const extra = typeof data === 'object' ? JSON.stringify(data) : data;
    return `${base} | ${extra}`;
  }
  return base;
}

function log(level, levelStr, module, message, data) {
  if (level < MIN_LEVEL) return;
  const line = fmt(levelStr, module, message, data);
  if (level >= LEVELS.ERROR) {
    console.error(line);
  } else if (level >= LEVELS.WARN) {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function createLogger(module) {
  return {
    debug: (msg, data) => log(LEVELS.DEBUG, 'DEBUG', module, msg, data),
    info:  (msg, data) => log(LEVELS.INFO,  'INFO',  module, msg, data),
    warn:  (msg, data) => log(LEVELS.WARN,  'WARN',  module, msg, data),
    error: (msg, data) => log(LEVELS.ERROR, 'ERROR', module, msg, data),
  };
}

module.exports = { createLogger };
