// ============================================================
// WINSTON v13 — Single-Wallet 10s Momentum Scalper
// ============================================================
// Watch ONE wallet. When it buys:
//   1. Grab Jupiter price snapshot
//   2. Wait 3 seconds
//   3. Check price again — if token pumped (fewer tokens per SOL
//      = costs more = price up) → BUY 0.11 SOL
//   4. Hard exit at exactly 10 seconds
//   5. Stop loss at -10% active the whole time
// ============================================================

require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');

const CONFIG = {
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  get HELIUS_RPC() { return `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },
  get HELIUS_TX()  { return `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${this.HELIUS_API_KEY}`; },
  PRIVATE_KEY:     process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || '',
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || '',
  JUPITER_QUOTE:   'https://lite-api.jup.ag/swap/v1/quote',
  JUPITER_SWAP:    'https://lite-api.jup.ag/swap/v1/swap',

  // ── The one wallet we watch ──────────────────────────────
  TARGET: 'Fw8Cwufb3ELmS5pVN6SaZGVy9KsfZ35zrRp2WrUFvSDg',

  // ── Entry filter ─────────────────────────────────────────
  MIN_BUY_SOL_SIGNAL: 2.01,  // skip whale buys ≤ 2 SOL, only mirror 2.01+ SOL

  // ── Momentum confirmation ────────────────────────────────
  MOMENTUM_WAIT_MS: 25000,   // wait 25s then re-check price
  // After 25s, if token costs MORE sol per token (price pumped)
  // = fewer tokens per SOL out = quoteAfter < quoteBefore → BUY
  // If token got cheaper (dump) = more tokens per SOL = SKIP

  // ── Position sizing ──────────────────────────────────────
  BUY_SOL:     0.060,  // fixed 0.060 SOL per trade — always
  MAX_BUY_PCT: 0.80,         // safety cap

  // ── Fees ─────────────────────────────────────────────────
  MAX_SLIPPAGE_BPS:            1500,
  PRIORITY_FEE_LAMPORTS:       1500000,
  EMERGENCY_SLIPPAGE_BPS:      2500,
  EMERGENCY_PRIORITY_LAMPORTS: 4000000,
  MAX_RETRIES: 3,

  // ── Exit ─────────────────────────────────────────────────
  HOLD_SECONDS:  25,    // hard exit at 25s — no exceptions
  SL_PCT:       -10,    // stop loss, checked every 500ms
  EXIT_CHECK_MS: 500,

  POLL_MS:    1200,
  HEALTH_MS: 60000,
  SOL: 'So11111111111111111111111111111111111111112',
};

const IGNORE = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
]);

const state = {
  wallet:      null,
  connection:  null,
  isRunning:   false,
  lastSig:     null,          // single cursor for the one target
  positions:   new Map(),     // mint → position object
  tradedMints: new Set(),     // session blacklist
  stats: { buys:0, sells:0, errors:0, retries:0, startBal:0 },
};

// ── UTILS ────────────────────────────────────────────────────

function log(lv, msg, d={}) {
  const ts = new Date().toISOString();
  const ic = {INFO:'📡',BUY:'🟢',SELL:'🔴',EXEC:'⚡',ERROR:'❌',SIGNAL:'📶',EXIT:'🎯',EMERGENCY:'🚨'};
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
  const w = CONFIG.TARGET;
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
    if(IGNORE.has(t.mint) || t.mint === CONFIG.SOL) continue;
    if(t.toUserAccount   === w && t.tokenAmount > 0) buys.push({ mint: t.mint, amt: t.tokenAmount });
    if(t.fromUserAccount === w && t.tokenAmount > 0) sells.push({ mint: t.mint, amt: t.tokenAmount });
  }

  // Aggregator fallback
  if(buys.length === 0 && sells.length === 0 && tfers.length > 0) {
    const mints = new Set();
    for(const t of tfers) {
      if(!IGNORE.has(t.mint) && t.mint !== CONFIG.SOL && t.tokenAmount > 0) mints.add(t.mint);
    }
    for(const mint of mints) {
      if(tx.type !== 'SWAP' && !desc.includes('swap') && !desc.includes('buy') && !desc.includes('sell')) continue;
      if(solOut > 0.01) buys.push({ mint, amt: tfers.find(t => t.mint===mint)?.tokenAmount||0 });
      else if(solIn > 0.01) sells.push({ mint, amt: tfers.find(t => t.mint===mint)?.tokenAmount||0 });
      break;
    }
  }

  const trades = [];
  for(const b of buys)  trades.push({ mint: b.mint, dir: 'buy',  sol: solOut||0.01 });
  for(const s of sells) trades.push({ mint: s.mint, dir: 'sell', sol: solIn||0.01  });
  return trades.length > 0 ? trades : null;
}

// ── BUY ──────────────────────────────────────────────────────

async function execBuy(mint, sol, context) {
  state.tradedMints.add(mint);
  const info = await tokenInfo(mint);
  const lamports = Math.floor(sol * 1e9);
  log('EXEC', `🛒 BUY ${info.sym} ${sol.toFixed(4)} SOL [${context}]`, { mint: mint.slice(0,12) });

  try {
    const qr = await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${CONFIG.SOL}&outputMint=${mint}&amount=${lamports}&slippageBps=${CONFIG.MAX_SLIPPAGE_BPS}`);
    if(!qr.ok) throw new Error(`Quote ${qr.status}`);
    const q = await qr.json();
    if(!q.outAmount || q.outAmount === '0') throw new Error('No route');

    const sr = await fetch(CONFIG.JUPITER_SWAP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: q,
        userPublicKey: state.wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicSlippage: { minBps: 50, maxBps: CONFIG.MAX_SLIPPAGE_BPS },
        prioritizationFeeLamports: CONFIG.PRIORITY_FEE_LAMPORTS
      })
    });
    if(!sr.ok) throw new Error(`Swap ${sr.status}`);
    const sd = await sr.json();
    if(!sd.swapTransaction) throw new Error('No swap tx');

    const buf = Buffer.from(sd.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(buf);
    tx.sign([state.wallet]);
    const sig = await state.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });

    if(await confirm(sig)) {
      state.positions.set(mint, {
        time: Date.now(), sol, sym: info.sym,
        soldPct: 0, isSelling: false, highestRoi: -Infinity
      });
      state.stats.buys++;
      log('BUY', `✅ ${info.sym} ${sol.toFixed(4)} SOL — exits in ${CONFIG.HOLD_SECONDS}s`);
      await discord(
        `🟢  **BUY** \`${mint}\`\n` +
        `💸  **${sol.toFixed(4)} SOL**  ·  ${context}\n` +
        `⏱  Hard exit in **${CONFIG.HOLD_SECONDS}s**  |  SL: **${CONFIG.SL_PCT}%**\n` +
        `🔗  https://solscan.io/tx/${sig}`
      );
      return true;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    state.stats.errors++;
    log('ERROR', `Buy fail (no retry): ${e.message}`, { mint: mint.slice(0,12) });
    await discord(`❌ Buy failed: \`${mint.slice(0,16)}\` — ${e.message}`);
    return false;
  }
}

// ── SELL ─────────────────────────────────────────────────────

async function execSell(mint, pct, reason, emergency=false, attempt=1) {
  const info = await tokenInfo(mint);
  const pos = state.positions.get(mint);
  const remain = pos ? (100 - (pos.soldPct||0)) : 100;
  const sellPct = Math.min(pct, remain);
  if(sellPct <= 0) { state.positions.delete(mint); return false; }

  const slippage = emergency ? CONFIG.EMERGENCY_SLIPPAGE_BPS : CONFIG.MAX_SLIPPAGE_BPS;
  const priority = emergency ? CONFIG.EMERGENCY_PRIORITY_LAMPORTS : CONFIG.PRIORITY_FEE_LAMPORTS;

  log('EXEC', `${emergency?'🚨 EMERGENCY':'🔴'} SELL ${sellPct}% ${info.sym} — ${reason} (attempt ${attempt})`, { mint: mint.slice(0,12) });

  try {
    const accts = await state.connection.getParsedTokenAccountsByOwner(state.wallet.publicKey, { mint: new PublicKey(mint) });
    const acct = accts?.value?.[0];
    if(!acct) { state.positions.delete(mint); return false; }
    const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount||0);
    if(bal <= 0) { state.positions.delete(mint); return false; }
    const dec = acct.account.data.parsed.info.tokenAmount.decimals;
    const raw = BigInt(Math.floor(bal * (sellPct/100) * Math.pow(10, dec)));
    if(raw <= 0n) { state.positions.delete(mint); return false; }

    const qr = await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL}&amount=${raw.toString()}&slippageBps=${slippage}`);
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
    const tx = VersionedTransaction.deserialize(buf);
    tx.sign([state.wallet]);
    const sig = await state.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });

    if(await confirm(sig)) {
      const solBack = parseFloat(q.outAmount) / 1e9;
      const pnlPortion = pos?.sol ? (solBack - (pos.sol * sellPct/100)) : 0;
      state.stats.sells++;
      if(pos) pos.soldPct = (pos.soldPct||0) + sellPct;
      if(!pos || pos.soldPct >= 100) state.positions.delete(mint);

      const pnlSign  = pnlPortion >= 0 ? '+' : '';
      const pnlEmoji = pnlPortion >= 0 ? '📈' : '📉';
      const label = emergency          ? '⚠️🚨 **EMERGENCY**'
        : reason.startsWith('SL')      ? '🛑 **STOP LOSS**'
        : reason.startsWith('10s')     ? (pnlPortion >= 0 ? '✅ **10s EXIT (profit)**' : '⏱ **10s EXIT (loss)**')
        : '🔴 **SELL**';
      await discord(`${label} \`${mint}\`\n💰  **${solBack.toFixed(4)} SOL** back  ·  ${pnlEmoji} **${pnlSign}${pnlPortion.toFixed(4)} SOL**\n📋  ${reason}\n🔗  https://solscan.io/tx/${sig}`);
      log('SELL', `✅ ${info.sym} ${sellPct}% → ${solBack.toFixed(4)} SOL (${pnlPortion>=0?'+':''}${pnlPortion.toFixed(4)})${emergency?' EMERGENCY':''}`);
      return true;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    log('ERROR', `Sell fail: ${e.message}`, { attempt, emergency });
    if(attempt < CONFIG.MAX_RETRIES) {
      state.stats.retries++;
      await sleep(emergency ? 500 : 2000);
      return execSell(mint, pct, reason, emergency, attempt+1);
    }
    state.stats.errors++;
    await discord(`❌ Sell failed: ${info.sym} \`${mint}\` — ${e.message}${emergency?' [EMERGENCY]':''}`);
    return false;
  }
}

async function confirm(sig, timeout=60000) {
  const s = Date.now();
  while(Date.now()-s < timeout) {
    try {
      const r = await state.connection.getSignatureStatuses([sig]);
      const v = r?.value?.[0];
      if(v?.err) return false;
      if(v?.confirmationStatus==='confirmed' || v?.confirmationStatus==='finalized') return true;
    } catch(e) {}
    await sleep(2000);
  }
  return false;
}

// ── EXIT MANAGER — 10s scalp ─────────────────────────────────

async function exitManager() {
  log('INFO', `🎯 Exit manager | Hard exit: ${CONFIG.HOLD_SECONDS}s | SL: ${CONFIG.SL_PCT}%`);

  while(state.isRunning) {
    await sleep(CONFIG.EXIT_CHECK_MS);

    for(const [mint, pos] of state.positions) {
      if(!pos.sol || pos.sol <= 0) continue;
      if((pos.soldPct||0) >= 100) continue;
      if(pos.isSelling) continue;

      try {
        const ageSec = (Date.now() - pos.time) / 1000;

        // Get current value
        const accts = await state.connection.getParsedTokenAccountsByOwner(state.wallet.publicKey, { mint: new PublicKey(mint) });
        const acct = accts?.value?.[0];
        if(!acct) { state.positions.delete(mint); continue; }
        const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount||0);
        if(bal <= 0) { state.positions.delete(mint); continue; }
        const dec = acct.account.data.parsed.info.tokenAmount.decimals;
        const raw = BigInt(Math.floor(bal * Math.pow(10, dec)));

        const qr = await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL}&amount=${raw.toString()}&slippageBps=3000`);
        if(!qr.ok) continue;
        const q = await qr.json();
        if(!q.outAmount) continue;

        const currentVal = parseFloat(q.outAmount) / 1e9;
        const roiPct = ((currentVal / pos.sol) - 1) * 100;
        if(roiPct > (pos.highestRoi ?? -Infinity)) pos.highestRoi = roiPct;

        // Console bar
        const bar = roiPct >= 0
          ? '█'.repeat(Math.min(Math.floor(roiPct * 2), 20)) + '░'.repeat(Math.max(20 - Math.floor(roiPct * 2), 0))
          : '▓'.repeat(Math.min(Math.floor(Math.abs(roiPct) * 2), 20));
        console.log(`  [${pos.sym}] ${roiPct>=0?'+':''}${roiPct.toFixed(1)}% [${bar}] | ${ageSec.toFixed(1)}s / ${CONFIG.HOLD_SECONDS}s | SL:${CONFIG.SL_PCT}%`);

        // ── HARD 25s EXIT — only exit, no early sells ────────
        if(ageSec >= CONFIG.HOLD_SECONDS) {
          log('EXIT', `⏱ 10s HARD EXIT ${pos.sym} at ${roiPct>=0?'+':''}${roiPct.toFixed(1)}%`);
          pos.isSelling = true;
          await execSell(mint, 100, `10s_exit_${roiPct.toFixed(0)}%`, false);
          await discord(
            `⏱  **10s HARD EXIT**\n\`${mint}\`\n` +
            `📊  ROI: **${roiPct>=0?'+':''}${roiPct.toFixed(1)}%**  ·  Peak: **${pos.highestRoi>-Infinity?(pos.highestRoi>=0?'+':'')+pos.highestRoi.toFixed(1)+'%':'--'}**`
          );
          continue;
        }

      } catch(e) { /* skip cycle */ }
    }
  }
}

// ── POLL — single target wallet ───────────────────────────────

async function poll() {
  log('INFO', `👀 Watching ${CONFIG.TARGET.slice(0,16)}... every ${CONFIG.POLL_MS/1000}s`);

  while(state.isRunning) {
    try {
      const r = await fetch(CONFIG.HELIUS_RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'getSignaturesForAddress', params:[CONFIG.TARGET,{limit:10}] })
      });
      const d = await r.json();
      const sigs = d?.result || [];
      const newSigs = [];
      for(const s of sigs) { if(s.signature === state.lastSig) break; if(!s.err) newSigs.push(s); }

      if(newSigs.length > 0) {
        state.lastSig = newSigs[0].signature;
        const parsed = await heliusParse(newSigs.map(s => s.signature));

        for(const tx of parsed) {
          const trades = extractTrades(tx);
          if(!trades) continue;

          // Emergency sell if whale dumps something we hold
          for(const t of trades.filter(t => t.dir === 'sell')) {
            if(state.positions.has(t.mint)) {
              const pos = state.positions.get(t.mint);
              if(pos.isSelling) continue;
              log('EMERGENCY', `🚨 WHALE DUMPING ${t.mint.slice(0,8)}... — EMERGENCY SELL`);
              pos.isSelling = true;
              await execSell(t.mint, 100, 'WALLET_DUMP', true);
            }
          }

          // Buy signals — one wallet, no consensus needed
          for(const t of trades.filter(t => t.dir === 'buy')) {
            if(IGNORE.has(t.mint)) continue;
            if(state.tradedMints.has(t.mint)) continue;
            if(state.positions.has(t.mint)) continue;
            if(t.sol < CONFIG.MIN_BUY_SOL_SIGNAL) continue;

            log('SIGNAL', `👀 ${CONFIG.TARGET.slice(0,8)} bought ${t.mint.slice(0,10)}... for ${t.sol.toFixed(2)} SOL — checking momentum...`);

            // ── MOMENTUM CONFIRMATION ─────────────────────────
            // Snapshot 1: how many tokens do we get right now?
            const lamports = Math.floor(CONFIG.BUY_SOL * 1e9);
            let quoteBefore = null;
            try {
              const qb = await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${CONFIG.SOL}&outputMint=${t.mint}&amount=${lamports}&slippageBps=${CONFIG.MAX_SLIPPAGE_BPS}`);
              if(qb.ok) { const qbd = await qb.json(); quoteBefore = parseFloat(qbd.outAmount||0); }
            } catch(e) {}

            if(!quoteBefore || quoteBefore === 0) {
              log('SIGNAL', `⚠️ No route for ${t.mint.slice(0,10)}... — skipping`);
              state.tradedMints.add(t.mint);
              continue;
            }

            // Wait 3 seconds
            log('SIGNAL', `⏳ Waiting 25s to confirm momentum on ${t.mint.slice(0,10)}...`);
            await sleep(CONFIG.MOMENTUM_WAIT_MS);

            // Guard: still valid?
            if(state.tradedMints.has(t.mint) || state.positions.has(t.mint)) continue;

            // Snapshot 2: how many tokens now?
            let quoteAfter = null;
            try {
              const qa = await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${CONFIG.SOL}&outputMint=${t.mint}&amount=${lamports}&slippageBps=${CONFIG.MAX_SLIPPAGE_BPS}`);
              if(qa.ok) { const qad = await qa.json(); quoteAfter = parseFloat(qad.outAmount||0); }
            } catch(e) {}

            if(!quoteAfter || quoteAfter === 0) {
              log('SIGNAL', `⚠️ Lost route for ${t.mint.slice(0,10)}... — skipping`);
              state.tradedMints.add(t.mint);
              continue;
            }

            // UPWARD momentum = token price went UP = costs more SOL per token
            // = we receive FEWER tokens for same SOL = quoteAfter < quoteBefore
            // DOWNWARD / dump = token got cheaper = MORE tokens = quoteAfter > quoteBefore
            const tokenChangePct = ((quoteAfter - quoteBefore) / quoteBefore) * 100;
            const priceChangePct = -tokenChangePct; // invert: fewer tokens = higher price

            if(quoteAfter >= quoteBefore * 1.02) {
              // Getting ≥2% more tokens = token price dropped ≥2% = dump — SKIP
              log('SIGNAL', `📉 NO MOMENTUM ${t.mint.slice(0,10)}... price down ${Math.abs(priceChangePct).toFixed(1)}% in 3s — skipping`);
              await discord(`📉  **SKIP** \`${t.mint.slice(0,16)}...\`\nPrice dropped **${Math.abs(priceChangePct).toFixed(1)}%** in 25s — no momentum.`);
              state.tradedMints.add(t.mint);
              continue;
            }

            // Price held or pumped — confirmed upward momentum → BUY
            log('SIGNAL', `✅ MOMENTUM UP ${t.mint.slice(0,10)}... price +${priceChangePct.toFixed(1)}% in 25s — BUYING`);

            const bal = await solBal();
            const size = Math.min(CONFIG.BUY_SOL, bal * CONFIG.MAX_BUY_PCT, bal - 0.005);
            if(size < 0.01) {
              log('INFO', `💸 Balance too low (${bal.toFixed(4)} SOL)`);
              continue;
            }

            const ctx = `whale ${t.sol.toFixed(2)} SOL · price +${priceChangePct.toFixed(1)}% in 25s`;
            await discord(
              `📶✅  **MOMENTUM CONFIRMED — BUYING**\n\`${t.mint}\`\n` +
              `🐋  Whale bought **${t.sol.toFixed(2)} SOL** · price **+${priceChangePct.toFixed(1)}%** in 25s\n` +
              `💰  Entry: **${size.toFixed(4)} SOL** · exit in **${CONFIG.HOLD_SECONDS}s**`
            );
            await execBuy(t.mint, size, ctx);
          }
        }
      }
    } catch(e) {
      log('ERROR', `Poll error: ${e.message}`);
    }
    await sleep(CONFIG.POLL_MS);
  }
}

// ── HEALTH ───────────────────────────────────────────────────

async function health() {
  while(state.isRunning) {
    const bal = await solBal();
    const pnl = bal - state.stats.startBal;
    console.log('\n' + '═'.repeat(58));
    console.log('  ⚡ WINSTON v13 — 10s Momentum Scalper');
    console.log('═'.repeat(58));
    console.log(`  👀 Target: ${CONFIG.TARGET.slice(0,20)}...`);
    console.log(`  💰 ${bal.toFixed(4)} SOL | PnL: ${pnl>=0?'+':''}${pnl.toFixed(4)} SOL`);
    console.log(`  🛒 ${state.stats.buys}B  🚪 ${state.stats.sells}S  ❌ ${state.stats.errors}E`);
    console.log(`  📦 ${state.positions.size} open | 🚫 ${state.tradedMints.size} blacklisted`);
    console.log(`  🎯 Buy: ${CONFIG.BUY_SOL} SOL | 3s momentum check | ${CONFIG.HOLD_SECONDS}s exit | SL: ${CONFIG.SL_PCT}%`);
    for(const [m, p] of state.positions) {
      const age = ((Date.now()-p.time)/1000).toFixed(1);
      console.log(`     ${p.sym} ${m.slice(0,8)}... | ${age}s | ${p.sol.toFixed(4)} SOL in`);
    }
    console.log('═'.repeat(58) + '\n');
    await sleep(CONFIG.HEALTH_MS);
  }
}

// ── MAIN ─────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  ⚡ WINSTON v13 — 10s Momentum Scalper               ║');
  console.log('║  1 wallet · 3s momentum check · 10s hard exit        ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  if(!CONFIG.HELIUS_API_KEY) { log('ERROR', 'HELIUS_API_KEY missing'); process.exit(1); }
  if(!CONFIG.PRIVATE_KEY)    { log('ERROR', 'WALLET_PRIVATE_KEY missing'); process.exit(1); }

  try { state.wallet = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY)); }
  catch(e) { log('ERROR', 'Bad private key'); process.exit(1); }
  log('INFO', `Wallet: ${state.wallet.publicKey}`);

  state.connection = new Connection(CONFIG.HELIUS_RPC, { commitment: 'confirmed' });
  state.stats.startBal = await solBal();
  log('INFO', `Balance: ${state.stats.startBal.toFixed(4)} SOL`);

  if(state.stats.startBal < 0.015) {
    log('ERROR', 'Balance too low to trade safely.');
    process.exit(1);
  }

  // Bootstrap cursor — don't replay old history
  try {
    const r = await fetch(CONFIG.HELIUS_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'getSignaturesForAddress', params:[CONFIG.TARGET,{limit:1}] })
    });
    const d = await r.json();
    state.lastSig = d?.result?.[0]?.signature || null;
    log('INFO', `Cursor set: ${state.lastSig ? state.lastSig.slice(0,16)+'...' : 'none'}`);
  } catch(e) { log('ERROR', `Cursor init failed: ${e.message}`); process.exit(1); }

  state.isRunning = true;
  log('INFO', `⚡ Live | target: ${CONFIG.TARGET.slice(0,16)}... | buy: ${CONFIG.BUY_SOL} SOL | 3s momentum | ${CONFIG.HOLD_SECONDS}s exit | SL: ${CONFIG.SL_PCT}%`);
  await discord(
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `⚡  **WINSTON v13 ONLINE**\n` +
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `👀  Target: \`${CONFIG.TARGET}\`\n` +
    `💰  Balance: **${state.stats.startBal.toFixed(4)} SOL** | Entry: **${CONFIG.BUY_SOL} SOL**\n` +
    `⏱  3s momentum check → **${CONFIG.HOLD_SECONDS}s hard exit** | SL: **${CONFIG.SL_PCT}%**\n` +
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
      `🔴  **WINSTON v13 OFFLINE**\n` +
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
