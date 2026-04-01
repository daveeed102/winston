'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — set all of these in Railway Variables tab
// ─────────────────────────────────────────────────────────────────────────────

const GROK_API_KEY        = process.env.GROK_API_KEY        || null;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;
const HELIUS_RPC_URL      = process.env.HELIUS_RPC_URL      || null;
const WALLET_PRIVATE_KEY  = process.env.WALLET_PRIVATE_KEY  || null;
const JUPITER_API_KEY     = process.env.JUPITER_API_KEY     || null;

const BUY_AMOUNT_SOL      = 0.1813;    // FIXED — do not change
const BUY_AMOUNT_LAMPORTS = 181300000; // 0.1813 SOL in lamports
const SLIPPAGE_BPS        = parseInt(process.env.SLIPPAGE_BPS || '500', 10);
const RUGCHECK_THRESHOLD  = parseInt(process.env.RUGCHECK_RISK_THRESHOLD || '500', 10);
const SOL_MINT            = 'So11111111111111111111111111111111111111112';
const TWO_HOURS_MS        = 2 * 60 * 60 * 1000;
const MAX_PICK_ATTEMPTS   = 3;

// ─────────────────────────────────────────────────────────────────────────────
// STARTUP CHECKS
// ─────────────────────────────────────────────────────────────────────────────

const missing = [];
if (!GROK_API_KEY)       missing.push('GROK_API_KEY');
if (!HELIUS_RPC_URL)     missing.push('HELIUS_RPC_URL');
if (!WALLET_PRIVATE_KEY) missing.push('WALLET_PRIVATE_KEY');

if (missing.length > 0) {
  console.error(`\n❌ Missing required Railway environment variables:\n  ${missing.join('\n  ')}`);
  console.error('\nAdd them in Railway → your service → Variables tab.\n');
  process.exit(1);
}

if (!DISCORD_WEBHOOK_URL) console.warn('[WARN] DISCORD_WEBHOOK_URL not set — alerts disabled.');
if (!JUPITER_API_KEY)     console.warn('[WARN] JUPITER_API_KEY not set — Jupiter token search unavailable as fallback.');

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nowISO()  { return new Date().toISOString(); }

// ─────────────────────────────────────────────────────────────────────────────
// DISCORD
// ─────────────────────────────────────────────────────────────────────────────

const COLORS = { GREEN: 0x57f287, RED: 0xed4245, YELLOW: 0xfee75c, ORANGE: 0xe67e22, BLUE: 0x5865f2 };

async function discordSend(embed) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) console.error(`[DISCORD] HTTP ${res.status}`);
  } catch (e) { console.error('[DISCORD] Failed:', e.message); }
}

async function alertStartup() {
  await discordSend({
    title: '🤖 Winston Online — v4',
    description: 'Actor-Critic bot started. Running 2-hour cycles.',
    color: COLORS.BLUE,
    fields: [
      { name: 'Buy Size',       value: `${BUY_AMOUNT_SOL} SOL (fixed)`, inline: true },
      { name: 'Hold Window',    value: '120 minutes',                    inline: true },
      { name: 'Address Source', value: 'DexScreener + Jupiter fallback', inline: true },
    ],
    timestamp: nowISO(),
  });
}

async function alertBuy({ symbol, tokenAddress, txSig, confidence, reasoning, rugcheckStatus, dexUrl }) {
  await discordSend({
    title: `🟢 BUY — ${symbol}`,
    description: `Bought **${symbol}** for **${BUY_AMOUNT_SOL} SOL**. Holding 120 minutes.`,
    color: COLORS.GREEN,
    fields: [
      { name: 'Amount',               value: `${BUY_AMOUNT_SOL} SOL`,   inline: true  },
      { name: 'Confidence',           value: `${confidence}/100`,        inline: true  },
      { name: '🧠 Grok\'s Reasoning', value: reasoning,                  inline: false },
      { name: 'Mint Address',         value: `\`${tokenAddress}\``,      inline: false },
      { name: `${rugcheckStatus.icon} Rugcheck`, value: rugcheckStatus.text, inline: false },
      ...(dexUrl ? [{ name: 'Chart', value: `[DexScreener](${dexUrl})`, inline: true }] : []),
      ...(txSig  ? [{ name: 'Tx',    value: `[Solscan](https://solscan.io/tx/${txSig})`, inline: true }] : []),
    ],
    timestamp: nowISO(),
  });
}

async function alertSell({ symbol, tokenAddress, buyTimestamp, txSig }) {
  const mins = Math.round((Date.now() - new Date(buyTimestamp).getTime()) / 60000);
  await discordSend({
    title: `🔴 SELL — ${symbol}`,
    description: `Sold **${symbol}** → SOL after **${mins}m** hold.`,
    color: COLORS.RED,
    fields: [
      { name: 'Hold Time',   value: `${mins} minutes`,      inline: true  },
      { name: 'Mint',        value: `\`${tokenAddress}\``,  inline: false },
      ...(txSig ? [{ name: 'Tx', value: `[Solscan](https://solscan.io/tx/${txSig})`, inline: false }] : []),
    ],
    timestamp: nowISO(),
  });
}

async function alertRejection({ attempt, symbol, reason, confidence }) {
  await discordSend({
    title: `⚠️ REJECTED — ${symbol} (Attempt ${attempt}/${MAX_PICK_ATTEMPTS})`,
    description: `**${symbol}** was rejected. Asking Grok for a new pick...`,
    color: COLORS.YELLOW,
    fields: [
      { name: 'Reason',     value: reason,              inline: false },
      { name: 'Confidence', value: `${confidence}/100`, inline: true  },
    ],
    timestamp: nowISO(),
  });
}

async function alertCircuitBreaker(rejectedPicks) {
  const list = rejectedPicks.map((r, i) => `**${i+1}. ${r.symbol}** — ${r.reason}`).join('\n');
  await discordSend({
    title: '🔴 CIRCUIT BREAKER — Holding SOL',
    description: `All ${MAX_PICK_ATTEMPTS} picks rejected. Holding SOL this cycle.`,
    color: COLORS.ORANGE,
    fields: [{ name: 'Failed Picks', value: list || 'none', inline: false }],
    timestamp: nowISO(),
  });
}

async function alertError(message) {
  await discordSend({ title: '❌ Error', description: message, color: COLORS.RED, timestamp: nowISO() });
}

// ─────────────────────────────────────────────────────────────────────────────
// GROK — The Actor (returns symbol only — never trusts Grok for addresses)
// ─────────────────────────────────────────────────────────────────────────────

async function grokPick(timestamp, rejectedPicks) {
  const systemPrompt = `You are Winston, an aggressive Solana memecoin trading bot optimized for 2-hour hold windows.

Pick ONE token that will be profitable at the EXACT 2-hour mark.

Rules:
- HIGH social buzz and momentum RIGHT NOW on Twitter/X, Telegram, DEX screeners
- NOT a 5-minute pump-and-dump — must sustain momentum for 120 minutes
- NOT a slow "safe" bluechip — needs real upside potential
- SWEET SPOT: early-to-mid pump phase with building momentum
- Must be a real Solana token actively trading on Raydium, Orca, or Meteora

CRITICAL: Do NOT include a token address. The system resolves real addresses from DexScreener.
Only provide the ticker symbol.

Respond ONLY with valid JSON, no markdown, no backticks:
{"symbol":"<ticker>","confidence_score_out_of_100":<0-100>,"short_reasoning":"<1-2 sentences>"}`;

  let userPrompt = `Current UTC Time: ${timestamp}

Pick a Solana memecoin to hold for EXACTLY 120 minutes. Find the sweet spot of high buzz and 2-hour survivability.`;

  if (rejectedPicks.length > 0) {
    userPrompt += `\n\nDO NOT pick these — already rejected this session:`;
    for (const r of rejectedPicks) {
      userPrompt += `\n- ${r.symbol}: ${r.reason}`;
    }
    userPrompt += `\n\nPick a completely different token.`;
  }

  userPrompt += `\n\nJSON only. No other text.`;

  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROK_API_KEY}` },
    body: JSON.stringify({
      model: 'grok-3-latest',
      temperature: 0.7,
      max_tokens: 256,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Grok HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw  = data?.choices?.[0]?.message?.content ?? '';
  if (!raw) throw new Error('Grok returned empty response');

  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch { throw new Error(`Grok non-JSON: ${raw.slice(0, 200)}`); }

  for (const f of ['symbol', 'confidence_score_out_of_100', 'short_reasoning']) {
    if (parsed[f] == null) throw new Error(`Grok missing field: ${f}`);
  }

  return {
    symbol:                      String(parsed.symbol).toUpperCase().trim(),
    confidence_score_out_of_100: Math.min(100, Math.max(0, Number(parsed.confidence_score_out_of_100))),
    short_reasoning:             String(parsed.short_reasoning),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TOKEN ADDRESS LOOKUP
// Chain: DexScreener → Jupiter token search → fail with clear message
// ─────────────────────────────────────────────────────────────────────────────

// Source 1: DexScreener search
async function lookupViaDexScreener(symbol) {
  const res = await fetch(
    `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbol)}`,
    { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);

  const data  = await res.json();
  const pairs = (data.pairs || []).filter(p =>
    p.chainId === 'solana' &&
    p.baseToken?.symbol?.toUpperCase() === symbol.toUpperCase() &&
    p.baseToken?.address
  );

  if (pairs.length === 0) throw new Error(`Symbol "${symbol}" not found on DexScreener`);

  pairs.sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
  const best = pairs[0];

  return {
    address:   best.baseToken.address,
    name:      best.baseToken.name || symbol,
    dexUrl:    best.url || null,
    volume24h: best.volume?.h24 || 0,
    source:    'DexScreener',
  };
}

// Source 2: Jupiter token search API
async function lookupViaJupiter(symbol) {
  if (!JUPITER_API_KEY) throw new Error('JUPITER_API_KEY not configured');

  const headers = { 'Accept': 'application/json', 'x-api-key': JUPITER_API_KEY };

  // Jupiter v2 token search
  const res = await fetch(
    `https://api.jup.ag/tokens/v1/search?query=${encodeURIComponent(symbol)}`,
    { headers, signal: AbortSignal.timeout(10000) }
  );

  if (!res.ok) throw new Error(`Jupiter token search HTTP ${res.status}`);

  const data = await res.json();
  // Response is an array of token objects
  const tokens = Array.isArray(data) ? data : (data.tokens || data.data || []);

  const match = tokens.find(t =>
    t.symbol?.toUpperCase() === symbol.toUpperCase() && t.address
  );

  if (!match) throw new Error(`Symbol "${symbol}" not found on Jupiter token list`);

  return {
    address:   match.address,
    name:      match.name || symbol,
    dexUrl:    `https://jup.ag/swap/SOL-${match.address}`,
    volume24h: 0,
    source:    'Jupiter',
  };
}

// Main lookup — tries DexScreener first, falls back to Jupiter
async function lookupTokenAddress(symbol) {
  // Try DexScreener first
  try {
    const result = await lookupViaDexScreener(symbol);
    console.log(`[LOOKUP] ${symbol} → ${result.address} via DexScreener (vol $${Math.round(result.volume24h).toLocaleString()})`);
    return result;
  } catch (e) {
    console.warn(`[LOOKUP] DexScreener failed for ${symbol}: ${e.message}`);
  }

  // Fallback: Jupiter token search
  try {
    const result = await lookupViaJupiter(symbol);
    console.log(`[LOOKUP] ${symbol} → ${result.address} via Jupiter fallback`);
    return result;
  } catch (e) {
    console.warn(`[LOOKUP] Jupiter failed for ${symbol}: ${e.message}`);
  }

  throw new Error(`Could not find "${symbol}" on DexScreener or Jupiter — token may not exist or symbol may be wrong`);
}

// ─────────────────────────────────────────────────────────────────────────────
// RUGCHECK — The Critic
// 400/404 = too new to audit → pass through. Real flags = reject.
// ─────────────────────────────────────────────────────────────────────────────

async function rugcheckAudit(tokenAddress) {
  const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report/summary`, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    if (res.status === 400 || res.status === 404) {
      // Token too new for Rugcheck — very common for fresh memecoins. Pass through.
      console.warn(`[CRITIC] Rugcheck HTTP ${res.status} — too new to audit, passing through.`);
      return { approved: true, warning: 'Token too new for Rugcheck to audit — trade at your own risk' };
    }
    throw new Error(`Rugcheck HTTP ${res.status}`);
  }

  const report  = await res.json();
  const reasons = [];

  // Mint authority
  for (const key of ['mintAuthorityEnabled', 'mintAuthority', 'mint_authority']) {
    if (report?.[key] === true || report?.tokenMeta?.[key] === true) {
      reasons.push('Mint authority still active');
      break;
    }
  }

  // Freeze authority
  for (const key of ['freezeAuthorityEnabled', 'freezeAuthority', 'freeze_authority']) {
    if (report?.[key] === true || report?.tokenMeta?.[key] === true) {
      reasons.push('Freeze authority still active');
      break;
    }
  }

  // Risk score
  const score = report?.score ?? report?.riskScore ?? 0;
  if (score >= RUGCHECK_THRESHOLD) reasons.push(`Risk score ${score} >= ${RUGCHECK_THRESHOLD}`);

  // Danger flags
  for (const risk of (report?.risks ?? [])) {
    if (['danger', 'critical'].includes((risk?.level ?? '').toLowerCase())) {
      reasons.push(`Critical: ${risk.name}`);
    }
  }

  if (reasons.length > 0) return { approved: false, reason: reasons.join('; ') };
  return { approved: true, warning: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// JUPITER — Swap Execution
// ─────────────────────────────────────────────────────────────────────────────

async function sellTokenForSol(tokenAddress) {
  // ── REPLACE with your Jupiter sell swap ──────────────────────────────────
  // Get token balance → swap → SOL → return tx signature string
  throw new Error('sellTokenForSol() not implemented — plug in your Jupiter swap here');
}

async function buySolForToken(tokenAddress) {
  // ── REPLACE with your Jupiter buy swap ───────────────────────────────────
  // Swap BUY_AMOUNT_LAMPORTS (181300000) SOL → token → return tx signature
  throw new Error('buySolForToken() not implemented — plug in your Jupiter swap here');
}

// ─────────────────────────────────────────────────────────────────────────────
// TRADING CYCLE
// ─────────────────────────────────────────────────────────────────────────────

let currentHolding = null;

async function sellPhase() {
  if (!currentHolding) { console.log('[SELL] Nothing held. Skipping.'); return; }
  console.log(`[SELL] Selling ${currentHolding.symbol}...`);
  try {
    const txSig = await sellTokenForSol(currentHolding.tokenAddress);
    await alertSell({ ...currentHolding, txSig });
    console.log(`[SELL] ✅ Done. Tx: ${txSig}`);
  } catch (e) {
    console.error(`[SELL] ❌ Failed:`, e.message);
    await alertError(`Sell failed for ${currentHolding.symbol}: ${e.message}`);
  }
  currentHolding = null;
}

async function pickPhase() {
  const timestamp     = nowISO();
  const rejectedPicks = [];

  console.log(`[PICK] Starting pick session at ${timestamp}`);

  for (let attempt = 1; attempt <= MAX_PICK_ATTEMPTS; attempt++) {
    console.log(`\n[PICK] Attempt ${attempt}/${MAX_PICK_ATTEMPTS}`);

    // Step 1: Grok picks a symbol
    let grokResult;
    try {
      grokResult = await grokPick(timestamp, rejectedPicks);
      console.log(`[ACTOR] Symbol: ${grokResult.symbol} | Confidence: ${grokResult.confidence_score_out_of_100}/100`);
      console.log(`[ACTOR] Reasoning: ${grokResult.short_reasoning}`);
    } catch (e) {
      console.error(`[ACTOR] Grok error:`, e.message);
      await alertError(`Grok error on attempt ${attempt}: ${e.message}`);
      await sleep(3000);
      continue;
    }

    // Step 2: Resolve real on-chain address
    let tokenInfo;
    try {
      tokenInfo = await lookupTokenAddress(grokResult.symbol);
    } catch (e) {
      const reason = `Address lookup failed: ${e.message}`;
      console.warn(`[LOOKUP] ❌ ${grokResult.symbol}: ${reason}`);
      await alertRejection({ attempt, symbol: grokResult.symbol, reason, confidence: grokResult.confidence_score_out_of_100 });
      rejectedPicks.push({ symbol: grokResult.symbol, reason });
      await sleep(2000);
      continue;
    }

    // Step 3: Rugcheck security audit
    let rugResult;
    try {
      rugResult = await rugcheckAudit(tokenInfo.address);
    } catch (e) {
      console.warn(`[CRITIC] Rugcheck error (passing through):`, e.message);
      rugResult = { approved: true, warning: `Rugcheck unavailable: ${e.message}` };
    }

    if (!rugResult.approved) {
      const reason = rugResult.reason;
      console.warn(`[CRITIC] ❌ Rejected ${grokResult.symbol}: ${reason}`);
      await alertRejection({ attempt, symbol: grokResult.symbol, reason, confidence: grokResult.confidence_score_out_of_100 });
      rejectedPicks.push({ symbol: grokResult.symbol, reason });
      await sleep(2000);
      continue;
    }

    if (rugResult.warning) {
      console.warn(`[CRITIC] ⚠️ ${grokResult.symbol} unverified — ${rugResult.warning}`);
    } else {
      console.log(`[CRITIC] ✅ ${grokResult.symbol} passed Rugcheck.`);
    }

    // Approved — return full pick
    return {
      symbol:                      grokResult.symbol,
      token_address:               tokenInfo.address,
      confidence_score_out_of_100: grokResult.confidence_score_out_of_100,
      short_reasoning:             grokResult.short_reasoning,
      dexUrl:                      tokenInfo.dexUrl,
      source:                      tokenInfo.source,
      rugcheckStatus: rugResult.warning
        ? { icon: '⚠️', text: rugResult.warning }
        : { icon: '✅', text: 'Passed Rugcheck security audit' },
    };
  }

  console.warn('[CIRCUIT BREAKER] All picks exhausted. Holding SOL.');
  await alertCircuitBreaker(rejectedPicks);
  return null;
}

async function buyPhase(pick) {
  console.log(`[BUY] ${pick.symbol} | ${pick.token_address} | Source: ${pick.source}`);
  try {
    const txSig = await buySolForToken(pick.token_address);
    currentHolding = { tokenAddress: pick.token_address, symbol: pick.symbol, buyTimestamp: nowISO() };
    await alertBuy({
      symbol:         pick.symbol,
      tokenAddress:   pick.token_address,
      txSig,
      confidence:     pick.confidence_score_out_of_100,
      reasoning:      pick.short_reasoning,
      rugcheckStatus: pick.rugcheckStatus,
      dexUrl:         pick.dexUrl,
    });
    console.log(`[BUY] ✅ Done. Tx: ${txSig}`);
  } catch (e) {
    console.error(`[BUY] ❌ Failed:`, e.message);
    await alertError(`Buy failed for ${pick.symbol}: ${e.message}`);
    currentHolding = null;
  }
}

async function runCycle() {
  console.log(`\n${'═'.repeat(52)}`);
  console.log(`[CYCLE] Starting at ${nowISO()}`);
  console.log('═'.repeat(52));

  await sellPhase();
  const pick = await pickPhase();

  if (pick) {
    await buyPhase(pick);
    console.log(`\n[CYCLE] ✅ Holding ${pick.symbol} for 2 hours.`);
  } else {
    console.log('\n[CYCLE] Holding SOL for 2 hours.');
  }
  console.log(`[CYCLE] Next cycle: ${new Date(Date.now() + TWO_HOURS_MS).toISOString()}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🤖 Winston Actor-Critic Bot v4 starting...');
  console.log(`   Buy:     ${BUY_AMOUNT_SOL} SOL fixed`);
  console.log(`   Cycle:   2 hours`);
  console.log(`   Lookup:  DexScreener → Jupiter fallback`);
  console.log(`   Discord: ${DISCORD_WEBHOOK_URL ? 'enabled' : 'disabled'}\n`);

  await alertStartup();
  await runCycle();

  setInterval(async () => {
    try { await runCycle(); }
    catch (e) {
      console.error('[FATAL] Cycle error:', e.message);
      await alertError(`Cycle error: ${e.message}`);
    }
  }, TWO_HOURS_MS);
}

main().catch(async (e) => {
  console.error('[FATAL] Boot failed:', e.message);
  await alertError(`Boot failed: ${e.message}`).catch(() => {});
  process.exit(1);
});
