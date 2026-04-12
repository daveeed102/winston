require('dotenv').config();

function get(key, def) { return process.env[key] !== undefined ? process.env[key] : def; }
function getFloat(key, def) { const v = process.env[key]; return v !== undefined ? parseFloat(v) : def; }
function getInt(key, def) { const v = process.env[key]; return v !== undefined ? parseInt(v, 10) : def; }

module.exports = {
  // Wallet
  WALLET_PRIVATE_KEY: get('WALLET_PRIVATE_KEY', '[]'),

  // RPC
  HELIUS_API_KEY: get('HELIUS_API_KEY', ''),
  HELIUS_RPC_URL: get('HELIUS_RPC_URL', 'https://api.mainnet-beta.solana.com'),
  HELIUS_WS_URL: get('HELIUS_WS_URL', 'wss://api.mainnet-beta.solana.com'),

  // Discord
  DISCORD_WEBHOOK_URL: get('DISCORD_WEBHOOK_URL', ''),

  // Trade settings
  BUY_AMOUNT_SOL: getFloat('BUY_AMOUNT_SOL', 0.012),
  MAX_POSITIONS: getInt('MAX_POSITIONS', 5),
  MAX_TOKEN_AGE_SECONDS: getInt('MAX_TOKEN_AGE_SECONDS', 10),

  // Exit settings
  TAKE_PROFIT_MULTIPLIER: getFloat('TAKE_PROFIT_MULTIPLIER', 20),
  TIME_STOP_SECONDS: getInt('TIME_STOP_SECONDS', 30),

  // Execution
  SLIPPAGE_BPS: getInt('SLIPPAGE_BPS', 500),
  SELL_RETRY_ATTEMPTS: getInt('SELL_RETRY_ATTEMPTS', 10),
  SELL_RETRY_DELAY_MS: getInt('SELL_RETRY_DELAY_MS', 2000),

  // Health
  PORT: getInt('PORT', 3000),
};
