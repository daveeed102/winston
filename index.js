/**
 * Winston — Actor-Critic Solana Trading Bot
 * Plain JS — no build step required. Railway runs this directly.
 */

'use strict';

const { GrokService }     = require('./grokService');
const { RugcheckService } = require('./rugcheckService');
const { JupiterService }  = require('./jupiterService');
const { DiscordService }  = require('./discordService');
const { config }          = require('./config');

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────

let currentHolding = null;
// { tokenAddress, symbol, buyAmountSol, buyTimestamp, jupiterTxSig }

const grok     = new GrokService();
const rugcheck = new RugcheckService();
const jupiter  = new JupiterService();
const discord  = new DiscordService();

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowISO() {
  return new Date().toISOString();
}

// ─────────────────────────────────────────────
// Phase 1 — Sell current holding into SOL
// ─────────────────────────────────────────────

async function sellCurrentHolding() {
  if (!currentHolding) {
    console.log('[SELL] No current holding. Skipping sell phase.');
    return;
  }

  console.log(`[SELL] Selling ${currentHolding.symbol} → SOL...`);

  try {
    // ── INTEGRATION POINT ─────────────────────────────────────────────────
    // Replace with your actual Jupiter swap. Example:
    //   const txSig = await jupiter.swap({
    //     inputMint:      currentHolding.tokenAddress,
    //     outputMint:     config.SOL_MINT,
    //     amountLamports: await jupiter.getTokenBalance(currentHolding.tokenAddress),
    //     slippageBps:    config.SLIPPAGE_BPS,
    //   });
    // ──────────────────────────────────────────────────────────────────────
    const txSig = await jupiter.sellTokenForSol(currentHolding.tokenAddress);

    await discord.sendSellAlert({
      symbol:        currentHolding.symbol,
      tokenAddress:  currentHolding.tokenAddress,
      buyTimestamp:  currentHolding.buyTimestamp,
      sellTimestamp: nowISO(),
      txSig,
    });

    console.log(`[SELL] ✅ Sold ${currentHolding.symbol}. Tx: ${txSig}`);
  } catch (err) {
    console.error(`[SELL] ❌ Sell failed for ${currentHolding.symbol}:`, err.message);
    await discord.sendErrorAlert(`Sell failed for **${currentHolding.symbol}**: ${err.message}`);
  }

  currentHolding = null;
}

// ─────────────────────────────────────────────
// Phase 2 — Actor-Critic pick loop (max 3 tries)
// ─────────────────────────────────────────────

async function pickToken() {
  const MAX_ATTEMPTS  = 3;
  const rejectedPicks = [];
  const timestamp     = nowISO();

  console.log(`[PICK] Starting Actor-Critic pick session at ${timestamp}`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`[PICK] Attempt ${attempt}/${MAX_ATTEMPTS}...`);

    // ── ACTOR: Grok picks a token ──────────────────────────────────────────
    let pick;
    try {
      pick = await grok.pickToken({ timestamp, rejectedPicks });
      console.log(`[ACTOR] Grok picked: ${pick.symbol} (${pick.token_address}) — confidence: ${pick.confidence_score_out_of_100}/100`);
      console.log(`[ACTOR] Reasoning: ${pick.short_reasoning}`);
    } catch (err) {
      console.error(`[ACTOR] Grok API error on attempt ${attempt}:`, err.message);
      await discord.sendErrorAlert(`Grok API error (attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message}`);
      await sleep(3000);
      continue;
    }

    // ── CRITIC: Rugcheck security audit ───────────────────────────────────
    let rejection = null;
    try {
      rejection = await rugcheck.audit(pick.token_address);
    } catch (err) {
      console.warn(`[CRITIC] Rugcheck error for ${pick.symbol}:`, err.message);
      rejection = `Rugcheck API unavailable (${err.message}) — skipping to be safe`;
    }

    if (rejection) {
      console.warn(`[CRITIC] ❌ Rejected ${pick.symbol}: ${rejection}`);

      await discord.sendRejectionAlert({
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        symbol:      pick.symbol,
        tokenAddress: pick.token_address,
        reason:      rejection,
        confidence:  pick.confidence_score_out_of_100,
      });

      rejectedPicks.push({ symbol: pick.symbol, tokenAddress: pick.token_address, reason: rejection });
      await sleep(2000);
      continue;
    }

    console.log(`[CRITIC] ✅ ${pick.symbol} passed security audit.`);
    return pick;
  }

  // ── CIRCUIT BREAKER ────────────────────────────────────────────────────
  console.warn('[CIRCUIT BREAKER] 3 picks rejected. Holding SOL this window.');
  await discord.sendCircuitBreakerAlert({ rejectedPicks, timestamp });
  return null;
}

// ─────────────────────────────────────────────
// Phase 3 — Buy the approved token
// ─────────────────────────────────────────────

async function buyToken(pick) {
  console.log(`[BUY] Buying ${pick.symbol} (${pick.token_address}) for ${config.BUY_AMOUNT_SOL} SOL...`);

  try {
    // ── INTEGRATION POINT ─────────────────────────────────────────────────
    // Replace with your actual Jupiter swap. Example:
    //   const txSig = await jupiter.swap({
    //     inputMint:      config.SOL_MINT,
    //     outputMint:     pick.token_address,
    //     amountLamports: config.BUY_AMOUNT_LAMPORTS,
    //     slippageBps:    config.SLIPPAGE_BPS,
    //   });
    // ──────────────────────────────────────────────────────────────────────
    const txSig = await jupiter.buySolForToken(pick.token_address);

    currentHolding = {
      tokenAddress: pick.token_address,
      symbol:       pick.symbol,
      buyAmountSol: config.BUY_AMOUNT_SOL,
      buyTimestamp: nowISO(),
      jupiterTxSig: txSig,
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
  } catch (err) {
    console.error(`[BUY] ❌ Buy failed for ${pick.symbol}:`, err.message);
    await discord.sendErrorAlert(`Buy failed for **${pick.symbol}**: ${err.message}`);
    currentHolding = null;
  }
}

// ─────────────────────────────────────────────
// Main 2-Hour Cycle
// ─────────────────────────────────────────────

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

async function runCycle() {
  console.log('\n══════════════════════════════════════════');
  console.log(`[CYCLE] New cycle starting at ${nowISO()}`);
  console.log('══════════════════════════════════════════');

  await sellCurrentHolding();

  const pick = await pickToken();

  if (!pick) {
    console.log('[CYCLE] Holding SOL. Next cycle in 2 hours.');
  } else {
    await buyToken(pick);
    console.log(`[CYCLE] Holding ${pick.symbol} for 2 hours.`);
  }

  console.log(`[CYCLE] Next cycle at: ${new Date(Date.now() + TWO_HOURS_MS).toISOString()}`);
}

// ─────────────────────────────────────────────
// Entry Point
// ─────────────────────────────────────────────

async function main() {
  console.log('🤖 Winston Actor-Critic Bot starting...');
  await discord.sendStartupAlert();

  await runCycle();

  setInterval(async () => {
    try {
      await runCycle();
    } catch (err) {
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
