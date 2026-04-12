const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const levels = { debug: 0, info: 1, warn: 2, error: 3 };

function format(level, message) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return `[${ts}] [SNIPER] [${level.toUpperCase()}] ${message}`;
}

function log(level, message) {
  if (levels[level] >= levels[LOG_LEVEL]) {
    const line = format(level, message);
    if (level === 'error') console.error(line);
    else console.log(line);
  }
}

module.exports = {
  debug: (m) => log('debug', m),
  info:  (m) => log('info',  m),
  warn:  (m) => log('warn',  m),
  error: (m) => log('error', m),
};
