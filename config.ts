/**
 * config.ts — Centralized environment variable access
 * All Railway/env vars are read here. Never use process.env directly elsewhere.
 */

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function optionalEnv(key: string, fallback?: string): string | undefined {
  return process.env[key] ?? fallback;
}

export const config = {
  // ── Grok (Actor) ────────────────────────────────────────────────────────
  GROK_API_KEY: requireEnv('GROK_API_KEY'),

  // ── Discord (Alerts) ────────────────────────────────────────────────────
  DISCORD_WEBHOOK_URL: optionalEnv('DISCORD_WEBHOOK_URL'),

  // ── Wallet / Solana ──────────────────────────────────────────────────────
  WALLET_PRIVATE_KEY: requireEnv('WALLET_PRIVATE_KEY'),
  HELIUS_RPC_URL:     requireEnv('HELIUS_RPC_URL'),

  // ── Trading Parameters ───────────────────────────────────────────────────
  // Buy amount is FIXED — not overridable via env var
  BUY_AMOUNT_SOL:      0.1813,
  BUY_AMOUNT_LAMPORTS: 181300000, // 0.1813 SOL in lamports (1 SOL = 1,000,000,000 lamports)
  SLIPPAGE_BPS:        parseInt(  optionalEnv('SLIPPAGE_BPS',    '500')   ?? '500', 10),

  // ── Rugcheck (Critic) ────────────────────────────────────────────────────
  // Risk score threshold — tokens AT or ABOVE this score are rejected.
  // rugcheck.xyz scores vary; 500 is a reasonable starting mid-point.
  // Tune lower (e.g. 300) for stricter security, higher for more permissive.
  RUGCHECK_RISK_THRESHOLD: parseInt(optionalEnv('RUGCHECK_RISK_THRESHOLD', '500') ?? '500', 10),

  // ── Token Addresses ──────────────────────────────────────────────────────
  SOL_MINT: 'So11111111111111111111111111111111111111112',
} as const;
