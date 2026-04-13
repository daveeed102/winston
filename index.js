// ============================================================
// WINSTON v17 — Copy Trade Bot (Grok-reviewed)
// ⚠️  HIGH RISK — for educational/personal use only
// ============================================================
// Changes from v16 (per Grok review):
//   1. Max hold bumped to 45 minutes (was 10 min)
//   2. Emergency sell is now HIGHEST priority — checked before
//      TP/SL in the exit loop (not just in poll)
//   3. Tiered exits:
//        - 50% sold at +100% (2x) — locks profit fast
//        - Remaining 50% sold at +175% (2.75x) — let it run
//        - Moon bag trail: if peak hit +100%, trailing SL at -25%
//   4. Min buy signal lowered to 0.5 SOL (was 1.0)
//
// Exit priority order:
//   1. He sells         → emergency sell 100% instantly
//   2. Tier 1 TP +100%  → sell 50%
//   3. Tier 2 TP +175%  → sell remaining 50%
//   4. Trailing SL      → if peak ≥ +100%, floor at -25% from peak
//   5. Hard SL -45%     → full exit if never hit TP1
//   6. Max hold 45min   → safety net fallback
// ============================================================

require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const bs58  = require('bs58');
const fetch = require('node-fetch');

// ── CONFIG ───────────────────────────────────────────────────
const CONFIG = {
  HELIUS_API_KEY:  process.env.HELIUS_API_KEY  || '',
  PRIVATE_KEY:     process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || '',
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || '',

  get HELIUS_RPC() { return `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },
  get HELIUS_TX()  { return `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${this.HELIUS_API_KEY}`; },

  JUPITER_QUOTE: 'https://lite-api.jup.ag/swap/v1/quote',
  JUPITER_SWAP:  'https://lite-api.jup.ag/swap/v1/swap',

  // ── Target wallet ────────────────────────────────────────
  TARGET: 'CP7eVtQYsweR7vAjSvW2shgA1weszsVmxDFbpV22s5w1',

  // ── Entry filter (lowered to 0.5 SOL per Grok) ──────────
  MIN_BUY_SOL_SIGNAL: 0.5,

  // ── Scaled sizing ($5–$10 by conviction) ─────────────────
  BUY_TIERS: [
    { maxWhaleSol: 2.0,      ourSol: 0.033 }, // ~$5
    { maxWhaleSol: 4.0,      ourSol: 0.046 }, // ~$7
    { maxWhaleSol: Infinity, ourSol: 0.065 }, // ~$10
  ],
  BUY_SOL: 0.065, // fallback

  // ── Tiered TP exits ──────────────────────────────────────
  TP1_PCT:      100,  // sell 50% at +100% (2x)
  TP1_SELL_PCT:  50,  // how much to sell at TP1
  TP2_PCT:      175,  // sell remaining 50% at +175% (2.75x)

  // ── Trailing stop (activates after TP1 hit) ──────────────
  // Once peak ROI ≥ TP1, we never close below peak - TRAIL_DROP
  TRAIL_DROP:    25,  // trail by 25% from peak (e.g. peak +120% → floor +95%)

  // ── Hard stop loss (full exit, only if TP1 never hit) ────
  SL_PCT:       -45,

  // ── Max hold — 45 min safety net ─────────────────────────
  MAX_HOLD_SECONDS: 2700,  // 45 minutes

  EXIT_CHECK_MS: 800,

  // ── Speed fees ───────────────────────────────────────────
  BUY_PRIORITY_LAMPORTS:       3000000, // 0.003 SOL
  BUY_SLIPPAGE_BPS:            2000,    // 20%
  SELL_PRIORITY_LAMPORTS:      3000000, // 0.003 SOL
  SELL_SLIPPAGE_BPS:           2500,    // 25%
  EMERGENCY_PRIORITY_LAMPORTS: 8000000, // 0.008 SOL — absolute max
  EMERGENCY_SLIPPAGE_BPS:      4000,    // 40%

  MAX_RETRIES: 3,
  POLL_MS:     500,
  HEALTH_MS:  30000,
  SOL_MINT:  'So11111111111111111111111111111111111111112',
};

const IGNORE = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
]);

// ── STATE ────────────────────────────────────────────────────
const state = {
  wallet:      null,
  connection:  null,
  isRunning:   false,
  lastSig:     null,
  // mint → { time, sol, sym, isSelling, tp1Hit, highestRoi, soldPct }
  positions:   new Map(),
  tradedMints: new Set(),
  // Mints where whale sold — emergency exit queue
  emergencyQueue: new Set(),
  stats: { buys:0, sells:0, errors:0, retries:0, startBal:0 },
};

// ── UTILS ────────────────────────────────────────────────────

function log(lv, msg, d={}) {
  const ts = new Date().toISOString();
  const ic = {INFO:'📡',BUY:'🟢',SELL:'🔴',EXEC:'⚡',ERROR:'❌',MIRROR:'🪞',EXIT:'🎯',EMERGENCY:'🚨'};
  console.log(`[${ts}] ${ic[lv]||'📋'} [${lv}] ${msg}${Object.keys(d).length?' '+JSON.stringify(d):''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function solBal() {
  try { return (await state.connection.getBalance(state.wallet.publicKey)) / 1e9; } catch(e) { return 0; }
}

async function tokenInfo(mint) {
  try {
    const r = await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mint}`);
    if(r.ok) { const d = await r.json(); return { sym: d.symbol||'???', name: d.name||'Unknown' }; }
  } catch(e) {}
  return { sym: '???', name: 'Unknown' };
}

async function discord(msg) {
  if(!CONFIG.DISCORD_WEBHOOK) return;
  try {
    await fetch(CONFIG.DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg.slice(0, 1990) })
    });
  } catch(e) {}
}

// ── HELIUS ───────────────────────────────────────────────────

async function heliusParse(sigs) {
  try {
    const r = await fetch(CONFIG.HELIUS_TX, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: sigs })
    });
    if(!r.ok) return [];
    return await r.json() || [];
  } catch(e) { return []; }
}

function extractTrades(tx) {
  if(tx.transactionError) return null;
  const w      = CONFIG.TARGET;
  const tfers  = tx.tokenTransfers  || [];
  const native = tx.nativeTransfers || [];
  const desc   = (tx.description||'').toLowerCase();

  let solOut = 0, solIn = 0;
  for(const t of native) {
    if(t.fromUserAccount === w) solOut += (t.amount||0) / 1e9;
    if(t.toUserAccount   === w) solIn  += (t.amount||0) / 1e9;
  }

  const buys = [], sells = [];
  for(const t of tfers) {
    if(IGNORE.has(t.mint) || t.mint === CONFIG.SOL_MINT) continue;
    if(t.toUserAccount   === w && t.tokenAmount > 0) buys.push({ mint: t.mint });
    if(t.fromUserAccount === w && t.tokenAmount > 0) sells.push({ mint: t.mint });
  }

  if(!buys.length && !sells.length && tfers.length > 0) {
    const mints = new Set();
    for(const t of tfers) {
      if(!IGNORE.has(t.mint) && t.mint !== CONFIG.SOL_MINT && t.tokenAmount > 0) mints.add(t.mint);
    }
    for(const mint of mints) {
      if(tx.type !== 'SWAP' && !desc.includes('swap') && !desc.includes('buy') && !desc.includes('sell')) continue;
      if(solOut > 0.01) buys.push({ mint });
      else if(solIn > 0.01) sells.push({ mint });
      break;
    }
  }

  const trades = [];
  for(const b of buys)  trades.push({ mint: b.mint, dir: 'buy',  sol: solOut||0.01 });
  for(const s of sells) trades.push({ mint: s.mint, dir: 'sell', sol: solIn||0.01  });
  return trades.length ? trades : null;
}

// ── CONFIRM ──────────────────────────────────────────────────

async function confirm(sig, timeout=60000) {
  const start = Date.now();
  while(Date.now()-start < timeout) {
    try {
      const r = await state.connection.getSignatureStatuses([sig]);
      const v = r?.value?.[0];
      if(v?.err) return false;
      if(v?.confirmationStatus==='confirmed'||v?.confirmationStatus==='finalized') return true;
    } catch(e) {}
    await sleep(1500);
  }
  return false;
}

// ── GET CURRENT ROI ──────────────────────────────────────────

async function getCurrentRoi(mint, pos) {
  try {
    const accts = await state.connection.getParsedTokenAccountsByOwner(
      state.wallet.publicKey, { mint: new PublicKey(mint) }
    );
    const acct = accts?.value?.[0];
    if(!acct) return null;
    const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount||0);
    if(bal <= 0) return null;
    const dec = acct.account.data.parsed.info.tokenAmount.decimals;
    const raw = BigInt(Math.floor(bal * Math.pow(10, dec)));

    const qr = await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL_MINT}&amount=${raw.toString()}&slippageBps=3000`);
    if(!qr.ok) return null;
    const q = await qr.json();
    if(!q.outAmount) return null;

    const currentVal = parseFloat(q.outAmount) / 1e9;
    // ROI based on remaining position (soldPct already accounted for in pos.sol)
    const invested = pos.sol * (1 - (pos.soldPct||0) / 100);
    return ((currentVal / invested) - 1) * 100;
  } catch(e) { return null; }
}

// ── SCALE BUY ────────────────────────────────────────────────

function scaleBuy(whaleSol) {
  for(const tier of CONFIG.BUY_TIERS) {
    if(whaleSol <= tier.maxWhaleSol) return tier.ourSol;
  }
  return CONFIG.BUY_SOL;
}

// ── PARTIAL SELL ─────────────────────────────────────────────
// Sells a percentage of remaining token balance

async function execPartialSell(mint, pct, reason, emergency=false, attempt=1) {
  const info     = await tokenInfo(mint);
  const pos      = state.positions.get(mint);
  if(!pos) return false;

  const slippage = emergency ? CONFIG.EMERGENCY_SLIPPAGE_BPS : CONFIG.SELL_SLIPPAGE_BPS;
  const priority = emergency ? CONFIG.EMERGENCY_PRIORITY_LAMPORTS : CONFIG.SELL_PRIORITY_LAMPORTS;
  const tag      = emergency ? '🚨 EMERGENCY' : '🔴';

  log('EXEC', `${tag} SELL ${pct}% ${info.sym} — ${reason} (attempt ${attempt})`, { mint: mint.slice(0,12) });

  try {
    const accts = await state.connection.getParsedTokenAccountsByOwner(
      state.wallet.publicKey, { mint: new PublicKey(mint) }
    );
    const acct = accts?.value?.[0];
    if(!acct) { state.positions.delete(mint); return false; }
    const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount||0);
    if(bal <= 0) { state.positions.delete(mint); return false; }
    const dec    = acct.account.data.parsed.info.tokenAmount.decimals;
    const sellAmt = bal * (pct / 100);
    const raw    = BigInt(Math.floor(sellAmt * Math.pow(10, dec)));
    if(raw <= 0n) { state.positions.delete(mint); return false; }

    const qr = await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL_MINT}&amount=${raw.toString()}&slippageBps=${slippage}`);
    if(!qr.ok) throw new Error(`Sell quote ${qr.status}`);
    const q = await qr.json();
    if(!q.outAmount) throw new Error('No sell route');

    const sr = await fetch(CONFIG.JUPITER_SWAP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: q,
        userPublicKey: state.wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicSlippage: { minBps: 50, maxBps: slippage },
        prioritizationFeeLamports: priority
      })
    });
    if(!sr.ok) throw new Error(`Sell swap ${sr.status}`);
    const sd = await sr.json();
    if(!sd.swapTransaction) throw new Error('No sell tx');

    const buf = Buffer.from(sd.swapTransaction, 'base64');
    const tx  = VersionedTransaction.deserialize(buf);
    tx.sign([state.wallet]);
    const sig = await state.connection.sendRawTransaction(tx.serialize(), { skipPreflight:true, maxRetries:5 });

    if(await confirm(sig)) {
      const solBack  = parseFloat(q.outAmount) / 1e9;
      const portion  = pos.sol * (pct / 100);
      const pnl      = solBack - portion;
      const pnlSign  = pnl >= 0 ? '+' : '';
      const pnlEmoji = pnl >= 0 ? '📈' : '📉';
      const roiPct   = ((solBack / portion) - 1) * 100;

      // Track sold percentage on position
      pos.soldPct = (pos.soldPct||0) + pct;
      state.stats.sells++;

      // If fully sold, clean up
      if(pos.soldPct >= 100) state.positions.delete(mint);

      log('SELL', `✅ ${info.sym} ${pct}% → ${solBack.toFixed(4)} SOL (${pnlSign}${pnl.toFixed(4)}) | ${reason}`);

      const label = emergency              ? '🚨 **EMERGENCY EXIT** (whale selling)'
        : reason.startsWith('TP1')         ? '🎯 **TAKE PROFIT 1** (50% sold at 2x)'
        : reason.startsWith('TP2')         ? '🎯🎯 **TAKE PROFIT 2** (final 50%)'
        : reason.startsWith('TRAIL')       ? '📉 **TRAILING STOP**'
        : reason.startsWith('SL')          ? '🛑 **STOP LOSS**'
        : reason.startsWith('max_hold')    ? '⏱ **MAX HOLD EXIT**'
        : '🔴 **SELL**';

      await discord(
        `${label} \`${mint}\`\n` +
        `💰  **${solBack.toFixed(4)} SOL** back  ·  ${pnlEmoji} **${pnlSign}${pnl.toFixed(4)} SOL** (${pnlSign}${roiPct.toFixed(1)}%)\n` +
        `📊  Sold **${pct}%** of position  ·  Remaining: **${100 - pos.soldPct}%**\n` +
        `🔗  https://solscan.io/tx/${sig}`
      );
      return true;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    log('ERROR', `Sell fail: ${e.message}`, { attempt, emergency });
    if(attempt < CONFIG.MAX_RETRIES) {
      state.stats.retries++;
      await sleep(emergency ? 200 : 1000);
      return execPartialSell(mint, pct, reason, emergency, attempt+1);
    }
    state.stats.errors++;
    if(pct >= 100) state.positions.delete(mint);
    await discord(`❌ Sell FAILED: ${info.sym} \`${mint.slice(0,16)}\` — ${e.message}`);
    return false;
  }
}

// ── BUY ──────────────────────────────────────────────────────

async function execBuy(mint, whaleSol, sol=CONFIG.BUY_SOL) {
  state.tradedMints.add(mint);
  const info     = await tokenInfo(mint);
  const lamports = Math.floor(sol * 1e9);

  log('EXEC', `🪞 BUY ${info.sym} ${sol.toFixed(4)} SOL (whale: ${whaleSol.toFixed(2)} SOL)`, { mint: mint.slice(0,12) });

  try {
    const qr = await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${CONFIG.SOL_MINT}&outputMint=${mint}&amount=${lamports}&slippageBps=${CONFIG.BUY_SLIPPAGE_BPS}`);
    if(!qr.ok) throw new Error(`Quote ${qr.status}`);
    const q = await qr.json();
    if(!q.outAmount || q.outAmount==='0') throw new Error('No route');

    const sr = await fetch(CONFIG.JUPITER_SWAP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: q,
        userPublicKey: state.wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicSlippage: { minBps: 50, maxBps: CONFIG.BUY_SLIPPAGE_BPS },
        prioritizationFeeLamports: CONFIG.BUY_PRIORITY_LAMPORTS
      })
    });
    if(!sr.ok) throw new Error(`Swap ${sr.status}`);
    const sd = await sr.json();
    if(!sd.swapTransaction) throw new Error('No swap tx');

    const buf = Buffer.from(sd.swapTransaction, 'base64');
    const tx  = VersionedTransaction.deserialize(buf);
    tx.sign([state.wallet]);
    const sig = await state.connection.sendRawTransaction(tx.serialize(), { skipPreflight:true, maxRetries:5 });

    if(await confirm(sig)) {
      state.positions.set(mint, {
        time:       Date.now(),
        sol,
        sym:        info.sym,
        isSelling:  false,
        soldPct:    0,       // % of position sold so far
        tp1Hit:     false,   // has first TP fired?
        highestRoi: -Infinity,
      });
      state.stats.buys++;
      log('BUY', `✅ ${info.sym} ${sol.toFixed(4)} SOL | TP1:+${CONFIG.TP1_PCT}% TP2:+${CONFIG.TP2_PCT}% SL:${CONFIG.SL_PCT}%`);
      await discord(
        `🪞  **COPY BUY** \`${mint}\`\n` +
        `💸  **${sol.toFixed(4)} SOL** | Whale: **${whaleSol.toFixed(2)} SOL**\n` +
        `🎯  TP1: **+${CONFIG.TP1_PCT}%** (50%) → TP2: **+${CONFIG.TP2_PCT}%** (50%)\n` +
        `📉  Trail: **-${CONFIG.TRAIL_DROP}%** from peak after TP1 | SL: **${CONFIG.SL_PCT}%**\n` +
        `⏱  Max hold: **${CONFIG.MAX_HOLD_SECONDS/60}min** | Emergency exit if he sells\n` +
        `🔗  https://solscan.io/tx/${sig}`
      );
      return true;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    state.stats.errors++;
    log('ERROR', `Buy fail: ${e.message}`, { mint: mint.slice(0,12) });
    await discord(`❌ Buy failed: ${info.sym} \`${mint.slice(0,16)}\` — ${e.message}`);
    return false;
  }
}

// ── EXIT MANAGER ─────────────────────────────────────────────
// Priority: 1. Emergency (he sold) 2. TP1 3. TP2 4. Trail 5. SL 6. Max hold

async function exitManager() {
  log('INFO', `🎯 Exit manager | TP1:+${CONFIG.TP1_PCT}% TP2:+${CONFIG.TP2_PCT}% SL:${CONFIG.SL_PCT}% Trail:-${CONFIG.TRAIL_DROP}% Max:${CONFIG.MAX_HOLD_SECONDS/60}min`);

  while(state.isRunning) {
    await sleep(CONFIG.EXIT_CHECK_MS);

    for(const [mint, pos] of state.positions) {
      if(pos.isSelling) continue;
      if((pos.soldPct||0) >= 100) { state.positions.delete(mint); continue; }

      const ageSec = (Date.now() - pos.time) / 1000;

      // ── PRIORITY 1: Emergency queue (whale sold) ──────────
      // This is checked FIRST every cycle, before any RPC calls
      if(state.emergencyQueue.has(mint)) {
        state.emergencyQueue.delete(mint);
        pos.isSelling = true;
        log('EMERGENCY', `🚨 EMERGENCY EXIT ${pos.sym} — whale sold`);
        execPartialSell(mint, 100, 'emergency_whale_sold', true)
          .catch(e => log('ERROR', `Emergency sell error: ${e.message}`));
        continue;
      }

      // ── PRIORITY 6: Max hold (no RPC needed) ─────────────
      if(ageSec >= CONFIG.MAX_HOLD_SECONDS) {
        pos.isSelling = true;
        log('EXIT', `⏱ MAX HOLD ${pos.sym} at ${(ageSec/60).toFixed(1)}min`);
        execPartialSell(mint, 100, `max_hold_${(ageSec/60).toFixed(0)}min`, false)
          .catch(e => log('ERROR', `Max-hold sell error: ${e.message}`));
        await discord(`⏱  **MAX HOLD EXIT** \`${mint.slice(0,16)}...\`\n⏱  Held **${(ageSec/60).toFixed(1)} min**`);
        continue;
      }

      // ── Get current ROI ───────────────────────────────────
      const roi = await getCurrentRoi(mint, pos);
      if(roi === null) continue;

      // Track peak
      if(roi > pos.highestRoi) pos.highestRoi = roi;

      // Console display
      const bar = roi >= 0
        ? '█'.repeat(Math.min(Math.floor(roi/10), 20)) + '░'.repeat(Math.max(20-Math.floor(roi/10),0))
        : '▓'.repeat(Math.min(Math.floor(Math.abs(roi)/5), 20));
      const tp1flag = pos.tp1Hit ? ' [TP1✅]' : '';
      console.log(`  [${pos.sym}] ${roi>=0?'+':''}${roi.toFixed(1)}% [${bar}] peak:${pos.highestRoi.toFixed(0)}% | ${ageSec.toFixed(0)}s${tp1flag}`);

      // ── PRIORITY 2: TP1 — sell 50% at +100% ──────────────
      if(!pos.tp1Hit && roi >= CONFIG.TP1_PCT) {
        pos.tp1Hit = true;
        log('EXIT', `🎯 TP1 ${pos.sym} at +${roi.toFixed(1)}% — selling 50%`);
        execPartialSell(mint, CONFIG.TP1_SELL_PCT, `TP1_+${roi.toFixed(0)}%`, false)
          .catch(e => log('ERROR', `TP1 sell error: ${e.message}`));
        await discord(`🎯  **TP1 HIT** \`${mint.slice(0,16)}...\`\n📊  **+${roi.toFixed(1)}%** — sold **50%**\n📈  Letting remaining 50% ride to **+${CONFIG.TP2_PCT}%** or trail`);
        continue;
      }

      // ── PRIORITY 3: TP2 — sell remaining 50% at +175% ────
      if(pos.tp1Hit && (pos.soldPct||0) < 100 && roi >= CONFIG.TP2_PCT) {
        pos.isSelling = true;
        log('EXIT', `🎯🎯 TP2 ${pos.sym} at +${roi.toFixed(1)}% — selling remaining`);
        execPartialSell(mint, 100, `TP2_+${roi.toFixed(0)}%`, false)
          .catch(e => log('ERROR', `TP2 sell error: ${e.message}`));
        await discord(`🎯🎯  **TP2 HIT** \`${mint.slice(0,16)}...\`\n📊  **+${roi.toFixed(1)}%** — selling final 50%`);
        continue;
      }

      // ── PRIORITY 4: Trailing SL (only after TP1 hit) ─────
      // Floor = peak ROI - TRAIL_DROP
      if(pos.tp1Hit && pos.highestRoi >= CONFIG.TP1_PCT) {
        const trailFloor = pos.highestRoi - CONFIG.TRAIL_DROP;
        if(roi <= trailFloor) {
          pos.isSelling = true;
          log('EXIT', `📉 TRAIL STOP ${pos.sym} at ${roi.toFixed(1)}% (floor was ${trailFloor.toFixed(1)}%)`);
          execPartialSell(mint, 100, `TRAIL_${roi.toFixed(0)}%_floor_${trailFloor.toFixed(0)}%`, false)
            .catch(e => log('ERROR', `Trail sell error: ${e.message}`));
          await discord(`📉  **TRAILING STOP** \`${mint.slice(0,16)}...\`\n📊  ROI **${roi.toFixed(1)}%** dropped below floor **${trailFloor.toFixed(1)}%**\n📈  Peak was **+${pos.highestRoi.toFixed(1)}%**`);
          continue;
        }
      }

      // ── PRIORITY 5: Hard SL (only if TP1 never hit) ──────
      if(!pos.tp1Hit && roi <= CONFIG.SL_PCT) {
        pos.isSelling = true;
        log('EXIT', `🛑 STOP LOSS ${pos.sym} at ${roi.toFixed(1)}%`);
        execPartialSell(mint, 100, `SL_${roi.toFixed(0)}%`, false)
          .catch(e => log('ERROR', `SL sell error: ${e.message}`));
        await discord(`🛑  **STOP LOSS** \`${mint.slice(0,16)}...\`\n📊  **${roi.toFixed(1)}%** after ${ageSec.toFixed(0)}s`);
        continue;
      }
    }
  }
}

// ── POLL ─────────────────────────────────────────────────────

async function poll() {
  log('INFO', `🪞 Mirroring ${CONFIG.TARGET.slice(0,20)}... every ${CONFIG.POLL_MS}ms`);

  while(state.isRunning) {
    try {
      const r = await fetch(CONFIG.HELIUS_RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getSignaturesForAddress',
          params: [CONFIG.TARGET, { limit: 10 }]
        })
      });
      const d    = await r.json();
      const sigs = d?.result || [];

      const newSigs = [];
      for(const s of sigs) {
        if(s.signature === state.lastSig) break;
        if(!s.err) newSigs.push(s);
      }

      if(newSigs.length > 0) {
        state.lastSig = newSigs[0].signature;
        const parsed  = await heliusParse(newSigs.map(s => s.signature));

        for(const tx of parsed) {
          const trades = extractTrades(tx);
          if(!trades) continue;

          // ── HE SOLD → queue emergency exit ──────────────
          // Add to queue — exitManager picks it up next cycle
          // This ensures emergency is always highest priority
          for(const t of trades.filter(t => t.dir==='sell')) {
            if(!state.positions.has(t.mint)) continue;
            const pos = state.positions.get(t.mint);
            if(pos.isSelling) continue;
            log('EMERGENCY', `🚨 TARGET SELLING ${t.mint.slice(0,10)}... — queuing emergency exit`);
            state.emergencyQueue.add(t.mint);
          }

          // ── HE BOUGHT → we buy ───────────────────────────
          for(const t of trades.filter(t => t.dir==='buy')) {
            if(IGNORE.has(t.mint)) continue;
            if(state.tradedMints.has(t.mint)) continue;
            if(state.positions.has(t.mint)) continue;

            if(t.sol < CONFIG.MIN_BUY_SOL_SIGNAL) {
              log('INFO', `⏭ SKIP ${t.mint.slice(0,10)}... only ${t.sol.toFixed(2)} SOL (min: ${CONFIG.MIN_BUY_SOL_SIGNAL})`);
              continue;
            }

            const ourSize = scaleBuy(t.sol);
            const bal     = await solBal();
            if(bal < ourSize + 0.015) {
              log('INFO', `💸 Balance too low (${bal.toFixed(4)} SOL)`);
              continue;
            }

            log('MIRROR', `🟢 TARGET BOUGHT ${t.mint.slice(0,10)}... ${t.sol.toFixed(2)} SOL → we bet ${ourSize.toFixed(3)} SOL`);
            execBuy(t.mint, t.sol, ourSize)
              .catch(e => log('ERROR', `Mirror buy error: ${e.message}`));
          }
        }
      }
    } catch(e) { log('ERROR', `Poll: ${e.message}`); }

    await sleep(CONFIG.POLL_MS);
  }
}

// ── HEALTH ───────────────────────────────────────────────────

async function health() {
  while(state.isRunning) {
    const bal = await solBal();
    const pnl = bal - state.stats.startBal;
    console.log('\n' + '═'.repeat(62));
    console.log('  🪞 WINSTON v17 — Copy Trade Bot');
    console.log('═'.repeat(62));
    console.log(`  👀 ${CONFIG.TARGET.slice(0,20)}...`);
    console.log(`  💰 ${bal.toFixed(4)} SOL | PnL: ${pnl>=0?'+':''}${pnl.toFixed(4)} SOL`);
    console.log(`  🛒 ${state.stats.buys}B  🚪 ${state.stats.sells}S  ❌ ${state.stats.errors}E  🔄 ${state.stats.retries}R`);
    console.log(`  📦 ${state.positions.size} open | 🚫 ${state.tradedMints.size} blacklisted`);
    console.log(`  🎯 TP1:+${CONFIG.TP1_PCT}%(50%) → TP2:+${CONFIG.TP2_PCT}%(50%) | Trail:-${CONFIG.TRAIL_DROP}% | SL:${CONFIG.SL_PCT}% | Max:${CONFIG.MAX_HOLD_SECONDS/60}min`);
    for(const [m, p] of state.positions) {
      const age  = ((Date.now()-p.time)/60).toFixed(1);
      const sold = p.soldPct||0;
      console.log(`     ${p.sym} ${m.slice(0,8)}... | ${age}min | ${p.sol.toFixed(4)} SOL | sold:${sold}% | tp1:${p.tp1Hit?'✅':'⬜'}`);
    }
    console.log('═'.repeat(62) + '\n');
    await sleep(CONFIG.HEALTH_MS);
  }
}

// ── MAIN ─────────────────────────────────────────────────────

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  🪞 WINSTON v17 — Copy Trade Bot (Grok-reviewed)           ║');
  console.log('║  Tiered TP · Trailing SL · Emergency exit · 45min max     ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  if(!CONFIG.HELIUS_API_KEY) { log('ERROR', 'HELIUS_API_KEY missing in .env'); process.exit(1); }
  if(!CONFIG.PRIVATE_KEY)    { log('ERROR', 'WALLET_PRIVATE_KEY missing in .env'); process.exit(1); }

  try { state.wallet = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY)); }
  catch(e) { log('ERROR', 'Bad private key'); process.exit(1); }
  log('INFO', `Wallet: ${state.wallet.publicKey}`);

  state.connection     = new Connection(CONFIG.HELIUS_RPC, { commitment:'confirmed' });
  state.stats.startBal = await solBal();
  log('INFO', `Balance: ${state.stats.startBal.toFixed(4)} SOL`);

  if(state.stats.startBal < 0.10) {
    log('ERROR', 'Need at least 0.10 SOL to trade safely.');
    process.exit(1);
  }

  try {
    const r = await fetch(CONFIG.HELIUS_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'getSignaturesForAddress', params:[CONFIG.TARGET,{limit:1}] })
    });
    const d = await r.json();
    state.lastSig = d?.result?.[0]?.signature || null;
    log('INFO', `Cursor: ${state.lastSig ? state.lastSig.slice(0,20)+'...' : 'none'}`);
  } catch(e) { log('ERROR', `Init failed: ${e.message}`); process.exit(1); }

  state.isRunning = true;
  log('INFO', `🪞 LIVE | ${CONFIG.TARGET} | TP1:+${CONFIG.TP1_PCT}% TP2:+${CONFIG.TP2_PCT}% SL:${CONFIG.SL_PCT}% Max:${CONFIG.MAX_HOLD_SECONDS/60}min`);

  await discord(
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `🪞  **WINSTON v17 ONLINE**\n` +
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `👀  Target: \`${CONFIG.TARGET}\`\n` +
    `💸  Scaled sizing: **$5–$10** per trade\n` +
    `🎯  TP1: **+${CONFIG.TP1_PCT}%** (sell 50%) → TP2: **+${CONFIG.TP2_PCT}%** (sell 50%)\n` +
    `📉  Trailing SL: **-${CONFIG.TRAIL_DROP}%** from peak (activates after TP1)\n` +
    `🛑  Hard SL: **${CONFIG.SL_PCT}%** | Max hold: **${CONFIG.MAX_HOLD_SECONDS/60}min**\n` +
    `🚨  Emergency exit if target sells first\n` +
    `💰  Balance: **${state.stats.startBal.toFixed(4)} SOL**\n` +
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if(shuttingDown) return;
    shuttingDown = true;
    state.isRunning = false;
    const f = await solBal(); const p = f - state.stats.startBal;
    await discord(
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
      `🔴  **WINSTON v17 OFFLINE**\n` +
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
      `💰  **${f.toFixed(4)} SOL**  ·  PnL: **${p>=0?'+':''}${p.toFixed(4)} SOL**\n` +
      `🛒  ${state.stats.buys}B  🚪 ${state.stats.sells}S  ❌ ${state.stats.errors}E\n` +
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`
    );
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await Promise.all([poll(), exitManager(), health()]);
}

main().catch(e => { log('ERROR', 'Fatal', { err: e.message }); process.exit(1); });
