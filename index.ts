/**
 * Winston - Actor-Critic Solana Trading Bot
 * Architecture: Grok (Actor/Hype Hunter) + Rugcheck (Critic/Security Bouncer)
 * Cycle: 2-hour hold windows with strict sell → pick → buy loop
 */

import { GrokService, GrokPick } from './services/grokService';
import { RugcheckService } from './services/rugcheckService';
import { JupiterService } from './services/jupiterService';
import { DiscordService } from './services/discordService';
import { config } from './config';

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────
interface HoldingState {
  tokenAddress: string;
  symbol: string;
  buyAmountSol: number;
  buyTimestamp: string;
  jupiterTxSig?: string;
}

let currentHolding: HoldingState | null = null;

const grok      = new GrokService();
const rugcheck  = new RugcheckService();
const jupiter   = new JupiterService();
const discord   = new DiscordService();

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowISO(): string {
  return new Date().toISOString();
}

// ─────────────────────────────────────────────
// Phase 1 — Sell current holding into SOL
// ─────────────────────────────────────────────

async function sellCurrentHolding(): Promise<void> {
  if (!currentHolding) {
    console.log('[SELL] No current holding. Skipping sell phase.');
    return;
  }

  console.log(`[SELL] Selling ${currentHolding.symbol} → SOL...`);

  try {
    // ── INTEGRATION POINT ──────────────────────────────────────────────────
    // Replace the stub below with your actual Jupiter swap call, e.g.:
    //   const txSig = await jupiter.swap({
    //     inputMint:  currentHolding.tokenAddress,
    //     outputMint: config.SOL_MINT,
    //     amountLamports: await jupiter.getTokenBalance(currentHolding.tokenAddress),
    //     slippageBps: config.SLIPPAGE_BPS,
    //     walletKeypair: jupiter.wallet,
    //   });
    // ───────────────────────────────────────────────────────────────────────
    const txSig = await jupiter.sellTokenForSol(currentHolding.tokenAddress);

    await discord.sendSellAlert({
      symbol:        currentHolding.symbol,
      tokenAddress:  currentHolding.tokenAddress,
      buyTimestamp:  currentHolding.buyTimestamp,
      sellTimestamp: nowISO(),
      txSig,
    });

    console.log(`[SELL] ✅ Sold ${currentHolding.symbol}. Tx: ${txSig}`);
  } catch (err: any) {
    console.error(`[SELL] ❌ Sell failed for ${currentHolding.symbol}:`, err.message);
    await discord.sendErrorAlert(`Sell failed for **${currentHolding.symbol}**: ${err.message}`);
    // Continue the cycle even if sell fails — don't get stuck
  }

  currentHolding = null;
}

// ─────────────────────────────────────────────
// Phase 2 — Actor-Critic pick loop (max 3 tries)
// ─────────────────────────────────────────────

interface RejectedPick {
  symbol: string;
  tokenAddress: string;
  reason: string;
}

async function pickToken(): Promise<GrokPick | null> {
  const MAX_ATTEMPTS = 3;
  const rejectedPicks: RejectedPick[] = [];
  const timestamp = nowISO(); // Injected once per pick session

  console.log(`[PICK] Starting Actor-Critic pick session at ${timestamp}`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`[PICK] Attempt ${attempt}/${MAX_ATTEMPTS}...`);

    // ── ACTOR: Ask Grok for a token pick ───────────────────────────────────
    let pick: GrokPick;
    try {
      pick = await grok.pickToken({ timestamp, rejectedPicks });
      console.log(`[ACTOR] Grok picked: ${pick.symbol} (${pick.token_address}) — confidence: ${pick.confidence_score_out_of_100}/100`);
      console.log(`[ACTOR] Reasoning: ${pick.short_reasoning}`);
    } catch (err: any) {
      console.error(`[ACTOR] Grok API error on attempt ${attempt}:`, err.message);
      await discord.sendErrorAlert(`Grok API error (attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message}`);
      await sleep(3000);
      continue;
    }

    // ── CRITIC: Run Rugcheck security audit ────────────────────────────────
    let rejection: string | null = null;
    try {
      rejection = await rugcheck.audit(pick.token_address);
    } catch (err: any) {
      console.warn(`[CRITIC] Rugcheck error for ${pick.symbol}:`, err.message);
      // Treat rugcheck API failure as a soft rejection to avoid buying unchecked tokens
      rejection = `Rugcheck API unavailable (${err.message}) — skipping to be safe`;
    }

    if (rejection) {
      console.warn(`[CRITIC] ❌ Rejected ${pick.symbol}: ${rejection}`);

      await discord.sendRejectionAlert({
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        symbol: pick.symbol,
        tokenAddress: pick.token_address,
        reason: rejection,
        confidence: pick.confidence_score_out_of_100,
      });

      rejectedPicks.push({
        symbol:       pick.symbol,
        tokenAddress: pick.token_address,
        reason:       rejection,
      });

      await sleep(2000); // Brief pause before re-querying Grok
      continue;
    }

    // ── APPROVED ───────────────────────────────────────────────────────────
    console.log(`[CRITIC] ✅ ${pick.symbol} passed security audit.`);
    return pick;
  }

  // ── CIRCUIT BREAKER ────────────────────────────────────────────────────
  console.warn('[CIRCUIT BREAKER] 3 picks rejected. Holding SOL this window.');
  await discord.sendCircuitBreakerAlert({
    rejectedPicks,
    timestamp,
  });

  return null;
}

// ─────────────────────────────────────────────
// Phase 3 — Buy the approved token
// ─────────────────────────────────────────────

async function buyToken(pick: GrokPick): Promise<void> {
  console.log(`[BUY] Buying ${pick.symbol} (${pick.token_address})...`);

  try {
    // ── INTEGRATION POINT ──────────────────────────────────────────────────
    // Replace the stub below with your actual Jupiter swap call, e.g.:
    //   const txSig = await jupiter.swap({
    //     inputMint:  config.SOL_MINT,
    //     outputMint: pick.token_address,
    //     amountLamports: config.BUY_AMOUNT_LAMPORTS,
    //     slippageBps: config.SLIPPAGE_BPS,
    //     walletKeypair: jupiter.wallet,
    //   });
    // ───────────────────────────────────────────────────────────────────────
    const txSig = await jupiter.buySolForToken(pick.token_address);

    currentHolding = {
      tokenAddress:  pick.token_address,
      symbol:        pick.symbol,
      buyAmountSol:  config.BUY_AMOUNT_SOL,
      buyTimestamp:  nowISO(),
      jupiterTxSig:  txSig,
    };

    await discord.sendBuyAlert({
      symbol:       pick.symbol,
      tokenAddress: pick.token_address,
      amountSol:    config.BUY_AMOUNT_SOL,
      confidence:   pick.confidence_score_out_of_100,
      reasoning:    pick.short_reasoning,
      txSig,
    });

    console.log(`[BUY] ✅ Bought ${pick.symbol}. Tx: ${txSig}`);
  } catch (err: any) {
    console.error(`[BUY] ❌ Buy failed for ${pick.symbol}:`, err.message);
    await discord.sendErrorAlert(`Buy failed for **${pick.symbol}**: ${err.message}`);
    currentHolding = null;
  }
}

// ─────────────────────────────────────────────
// Main 2-Hour Cycle
// ─────────────────────────────────────────────

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

async function runCycle(): Promise<void> {
  console.log('\n══════════════════════════════════════════');
  console.log(`[CYCLE] New cycle starting at ${nowISO()}`);
  console.log('══════════════════════════════════════════');

  // Phase 1: Sell whatever we're holding
  await sellCurrentHolding();

  // Phase 2: Actor-Critic pick (with feedback loop + circuit breaker)
  const pick = await pickToken();

  if (!pick) {
    // Circuit breaker triggered — hold SOL for this window
    console.log('[CYCLE] Holding SOL. Next cycle in 2 hours.');
  } else {
    // Phase 3: Buy the approved token
    await buyToken(pick);
    console.log(`[CYCLE] Holding ${pick.symbol} for 2 hours.`);
  }

  console.log(`[CYCLE] Next cycle at: ${new Date(Date.now() + TWO_HOURS_MS).toISOString()}`);
}

// ─────────────────────────────────────────────
// Entry Point
// ─────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🤖 Winston Actor-Critic Bot starting...');
  await discord.sendStartupAlert();

  // Run immediately on startup, then every 2 hours
  await runCycle();

  setInterval(async () => {
    try {
      await runCycle();
    } catch (err: any) {
      console.error('[FATAL] Unhandled cycle error:', err.message);
      await discord.sendErrorAlert(`Unhandled cycle error: ${err.message}`);
    }
  }, TWO_HOURS_MS);
}

main().catch(async (err) => {
  console.error('[FATAL] Boot error:', err);
  await discord.sendErrorAlert(`Boot error: ${err.message}`).catch(() => {});
  process.exit(1);
});
