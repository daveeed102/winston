// FILE: src/config.js
// Central configuration for Winston.
// Every meaningful threshold lives here. Tune these before going live.

require('dotenv').config();

const config = {
  // ─── Bot identity ──────────────────────────────────────────────────────────
  BOT_NAME: 'Winston',
  VERSION: '3.0.0',
  ENV: process.env.NODE_ENV || 'production',

  // ─── Wallet / Solana ──────────────────────────────────────────────────────
  WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || '',         // base58 encoded
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',                 // optional, faster RPC
  JUPITER_API_BASE: 'https://quote-api.jup.ag/v6',
  SOL_MINT: 'So11111111111111111111111111111111111111112',

  // ─── API keys ─────────────────────────────────────────────────────────────
  GROK_API_KEY: process.env.GROK_API_KEY || '',
  GROK_API_BASE: 'https://api.x.ai/v1',
  GROK_MODEL: 'grok-3-latest',
  BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY || '',               // optional, leave blank to use DexScreener

  // ─── Discord ───────────────────────────────────────────────────────────────
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || '',

  // ─── Safety / kill switches ───────────────────────────────────────────────
  KILL_SWITCH: process.env.KILL_SWITCH === 'true',                  // hard stop all activity
  PAUSE_NEW_ENTRIES: process.env.PAUSE_NEW_ENTRIES === 'true',      // exits only
  MAX_DAILY_LOSS_USD: parseFloat(process.env.MAX_DAILY_LOSS_USD || '50'),
  MAX_CONCURRENT_POSITIONS: parseInt(process.env.MAX_CONCURRENT_POSITIONS || '4'),
  MAX_TRADES_PER_DAY: parseInt(process.env.MAX_TRADES_PER_DAY || '8'),

  // ─── Portfolio sizing ─────────────────────────────────────────────────────
  PORTFOLIO_SIZE_USD: parseFloat(process.env.PORTFOLIO_SIZE_USD || '200'),
  MAX_POSITION_USD: parseFloat(process.env.MAX_POSITION_USD || '40'),

  // Confidence-based allocation (% of portfolio)
  SIZING: {
    ELITE: 0.75,    // 90–100 confidence
    STRONG: 0.50,   // 85–89
    GOOD: 0.40,     // 80–84
    SMALL: 0.35,    // 75–79
  },

  // ─── Confidence thresholds ────────────────────────────────────────────────
  MIN_CONFIDENCE_TO_TRADE: parseFloat(process.env.MIN_CONFIDENCE || '80'),
  MAX_DUMP_RISK_TO_TRADE: parseFloat(process.env.MAX_DUMP_RISK || '0.30'),
  CONFIDENCE_TIERS: {
    ELITE: 90,
    STRONG: 85,
    GOOD: 80,
    SMALL: 75,
  },

  // ─── Hard token filters ───────────────────────────────────────────────────
  FILTERS: {
    MIN_LIQUIDITY_USD: parseFloat(process.env.MIN_LIQUIDITY || '50000'),
    MIN_VOLUME_24H_USD: parseFloat(process.env.MIN_VOLUME_24H || '100000'),
    MIN_VOLUME_1H_USD: parseFloat(process.env.MIN_VOLUME_1H || '5000'),
    MIN_TOKEN_AGE_HOURS: parseFloat(process.env.MIN_TOKEN_AGE_HOURS || '6'),
    MAX_TOKEN_AGE_DAYS: parseFloat(process.env.MAX_TOKEN_AGE_DAYS || '30'),
    MIN_PRICE_CHANGE_1H: parseFloat(process.env.MIN_PRICE_CHANGE_1H || '2'),       // % min momentum
    MAX_PRICE_CHANGE_1H: parseFloat(process.env.MAX_PRICE_CHANGE_1H || '80'),      // % max (parabolic reject)
    MIN_PRICE_CHANGE_6H: parseFloat(process.env.MIN_PRICE_CHANGE_6H || '5'),
    MAX_PRICE_CHANGE_6H: parseFloat(process.env.MAX_PRICE_CHANGE_6H || '200'),
    MAX_PULLBACK_FROM_HIGH: parseFloat(process.env.MAX_PULLBACK || '35'),          // % max dip from ATH
    MIN_BUYS_1H: parseInt(process.env.MIN_BUYS_1H || '15'),                       // tx activity
    MIN_UNIQUE_WALLETS_24H: parseInt(process.env.MIN_WALLETS || '100'),
    REJECT_FREEZE_AUTHORITY: process.env.REJECT_FREEZE_AUTH !== 'false',           // true = reject tokens with freeze authority
    REJECT_MINT_AUTHORITY: process.env.REJECT_MINT_AUTH !== 'false',
  },

  // ─── Exit strategy ────────────────────────────────────────────────────────
  EXIT: {
    STOP_LOSS_PCT: parseFloat(process.env.STOP_LOSS_PCT || '6'),                   // -6% hard stop
    TRAILING_ACTIVATE_PCT: parseFloat(process.env.TRAIL_ACTIVATE || '6'),          // trail starts at +6%
    TRAILING_DISTANCE_PCT: parseFloat(process.env.TRAIL_DISTANCE || '4'),          // trails 4% below peak
    PARTIAL_TP_PCT: parseFloat(process.env.PARTIAL_TP || '9'),                     // take 50% at +9%
    PARTIAL_TP_SIZE: parseFloat(process.env.PARTIAL_TP_SIZE || '0.5'),             // fraction to close
    MAX_HOLD_HOURS: parseFloat(process.env.MAX_HOLD_HOURS || '48'),
    HYPE_COLLAPSE_THRESHOLD: parseFloat(process.env.HYPE_COLLAPSE || '0.3'),       // if volume drops 70%, exit
    MOMENTUM_FAIL_PCT: parseFloat(process.env.MOMENTUM_FAIL || '3'),               // % reversal from peak triggers check
  },

  // ─── Cooldowns / rate limiting ────────────────────────────────────────────
  REENTRY_COOLDOWN_HOURS: parseFloat(process.env.REENTRY_COOLDOWN || '4'),
  MIN_TIME_BETWEEN_ENTRIES_MINUTES: parseFloat(process.env.MIN_ENTRY_GAP || '10'),

  // ─── Scan schedule ────────────────────────────────────────────────────────
  SCAN_INTERVAL_MINUTES: parseInt(process.env.SCAN_INTERVAL || '5'),
  POSITION_CHECK_INTERVAL_SECONDS: parseInt(process.env.POS_CHECK_INTERVAL || '10'),
  HEARTBEAT_INTERVAL_MINUTES: parseInt(process.env.HEARTBEAT_INTERVAL || '30'),

  // ─── Staleness guards ─────────────────────────────────────────────────────
  MAX_MARKET_DATA_AGE_MINUTES: 10,
  MAX_GROK_SCORE_AGE_MINUTES: 20,

  // ─── Slippage / execution ─────────────────────────────────────────────────
  SLIPPAGE_BPS: parseInt(process.env.SLIPPAGE_BPS || '300'),                       // 3% slippage tolerance
  JUPITER_PRIORITY_FEE_LAMPORTS: parseInt(process.env.PRIORITY_FEE || '100000'),   // ~0.0001 SOL priority fee

  // ─── Health server ────────────────────────────────────────────────────────
  HEALTH_PORT: parseInt(process.env.PORT || '3000'),

  // ─── DexScreener ──────────────────────────────────────────────────────────
  DEXSCREENER_BASE: 'https://api.dexscreener.com',
  DEXSCREENER_BOOST_URL: 'https://api.dexscreener.com/token-boosts/top/v1',
  DEXSCREENER_TRENDING_URL: 'https://api.dexscreener.com/token-profiles/latest/v1',

  // ─── Birdeye (optional) ───────────────────────────────────────────────────
  BIRDEYE_BASE: 'https://public-api.birdeye.so',
};

// Validate critical keys on startup
config.validate = function () {
  const required = ['WALLET_PRIVATE_KEY', 'GROK_API_KEY', 'DISCORD_WEBHOOK_URL'];
  const missing = required.filter((k) => !config[k]);
  if (missing.length > 0) {
    throw new Error(`Winston config missing required env vars: ${missing.join(', ')}`);
  }
  if (config.KILL_SWITCH) {
    console.warn('[CONFIG] ⚠️  KILL_SWITCH is ON — bot will not trade.');
  }
};

module.exports = config;
