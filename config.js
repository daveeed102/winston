'use strict';

function requireEnv(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

const config = {
  GROK_API_KEY:        requireEnv('GROK_API_KEY'),
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || null,
  WALLET_PRIVATE_KEY:  requireEnv('WALLET_PRIVATE_KEY'),
  HELIUS_RPC_URL:      requireEnv('HELIUS_RPC_URL'),

  // FIXED — do not change
  BUY_AMOUNT_SOL:      0.1813,
  BUY_AMOUNT_LAMPORTS: 181300000,   // 0.1813 SOL × 1,000,000,000

  SLIPPAGE_BPS:            parseInt(process.env.SLIPPAGE_BPS || '500', 10),
  RUGCHECK_RISK_THRESHOLD: parseInt(process.env.RUGCHECK_RISK_THRESHOLD || '500', 10),
  SOL_MINT: 'So11111111111111111111111111111111111111112',
};

module.exports = { config };
