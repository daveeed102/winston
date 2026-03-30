// ============================================================
// WINSTON v11.1 — Anti-Rug Mirror Bot
// ============================================================
// Beat the whale to the exit. We sell BEFORE he dumps.
// TP: Single-shot sell at +40-45% (front-run whale's +50% dump)
// SL: -20% instant dump
// Stall: 3min timer → dump everything
// Emergency: If whale sells, max priority fee sell
// Buy logic unchanged from v11.
// ============================================================

require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');

const CONFIG = {
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  get HELIUS_RPC() { return `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },
  get HELIUS_TX() { return `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${this.HELIUS_API_KEY}`; },
  PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || '',
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || '',
  JUPITER_QUOTE: 'https://lite-api.jup.ag/swap/v1/quote',
  JUPITER_SWAP: 'https://lite-api.jup.ag/swap/v1/swap',

  TARGET: 'Fw8Cwufb3ELmS5pVN6SaZGVy9KsfZ35zrRp2WrUFvSDg',

  // Sizing: 1 SOL he spends = $2 for us = 0.024 SOL
  RATIO: 0.024,
  MIN_BUY_SOL: 0.02,
  MAX_BUY_PCT: 0.60,
  MAX_RETRIES: 3,

  // Normal fees for buys
  MAX_SLIPPAGE_BPS: 2000,               // Changed to 20% to survive volatility 
  PRIORITY_FEE_LAMPORTS: 2000000,       // 0.002 SOL (~$0.30) to bypass network lag

  // EMERGENCY fees for panic sells (whale dumping)
  EMERGENCY_SLIPPAGE_BPS: 2000,         // 20% slippage — get out at any cost
  EMERGENCY_PRIORITY_LAMPORTS: 5000000, // 0.005 SOL (~$0.80) — absolute max priority

  // Exit strategy — Single-shot whale front-run
  WHALE_TP_MIN: 40,                // Sell when ROI hits +40%
  WHALE_TP_MAX: 45,                // Hard sell at +45% no matter what
  STOP_LOSS_PCT: -20,              // -20% → dump everything
  STALL_MINUTES: 3,                // 3 min stall → dump everything
  EXIT_CHECK_MS: 2500,             // Check exits every 2.5s

  POLL_MS: 1000,
  HEALTH_MS: 60000,
  SOL: 'So11111111111111111111111111111111111111112',
};

const IGNORE = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB','mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn','bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
]);

const state = {
  wallet: null, connection: null, lastSig: null, isRunning: false,
  positions: new Map(), // mint -> {time, sol, sym, soldPct}
  stats: { buys:0, sells:0, errors:0, retries:0, startBal:0 },
};

// === UTILS ===
function log(lv, msg, d={}) {
  const ts = new Date().toISOString();
  const ic = {INFO:'📡',BUY:'🟢',SELL:'🔴',EXEC:'⚡',ERROR:'❌',RETRY:'🔄',MIRROR:'🪞',EXIT:'🎯',EMERGENCY:'🚨'};
  console.log(`[${ts}] ${ic[lv]||'📋'} [${lv}] ${msg}${Object.keys(d).length?' '+JSON.stringify(d):''}`);
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function solBal() {
  try { return (await state.connection.getBalance(state.wallet.publicKey))/1e9; } catch(e) { return 0; }
}

async function tokenInfo(mint) {
  try { const r=await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mint}`); if(r.ok){const d=await r.json(); return {name:d.name||'Unknown',sym:d.symbol||'???'};} } catch(e){}
  return {name:'Unknown',sym:'???'};
}

async function discord(msg) {
  if(!CONFIG.DISCORD_WEBHOOK) return;
  try { await fetch(CONFIG.DISCORD_WEBHOOK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:msg.slice(0,1990)})}); } catch(e){}
}

async function getHolderCount(mint) {
  try {
    // Use getTokenLargestAccounts — returns up to 20 holders, fast and free
    const r = await fetch(CONFIG.HELIUS_RPC, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({jsonrpc:'2.0',id:1,method:'getTokenLargestAccounts',params:[mint]})
    });
    if(!r.ok) return 999; // If API fails, don't block the buy
    const d = await r.json();
    const accounts = d?.result?.value || [];
    // Filter out zero-balance accounts
    const active = accounts.filter(a => parseFloat(a.uiAmount || a.amount || 0) > 0);
    return active.length;
  } catch(e) {
    return 999; // On error, assume enough holders so we don't miss trades
  }
}

// === HELIUS PARSE ===
async function heliusParse(sigs) {
  try {
    const r = await fetch(CONFIG.HELIUS_TX,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transactions:sigs})});
    if(!r.ok) return [];
    return await r.json() || [];
  } catch(e) { return []; }
}

function extractTrades(tx) {
  if(tx.transactionError) return null;
  const w = CONFIG.TARGET;
  const tfers = tx.tokenTransfers || [];
  const native = tx.nativeTransfers || [];
  const desc = (tx.description||'').toLowerCase();

  let solOut=0, solIn=0;
  for(const t of native) {
    if(t.fromUserAccount===w) solOut += (t.amount||0)/1e9;
    if(t.toUserAccount===w) solIn += (t.amount||0)/1e9;
  }

  const buys=[], sells=[];
  for(const t of tfers) {
    if(IGNORE.has(t.mint) || t.mint===CONFIG.SOL) continue;
    if(t.toUserAccount===w && t.tokenAmount>0) buys.push({mint:t.mint, amt:t.tokenAmount});
    if(t.fromUserAccount===w && t.tokenAmount>0) sells.push({mint:t.mint, amt:t.tokenAmount});
  }

  // Fallback for aggregator routing
  if(buys.length===0 && sells.length===0 && tfers.length>0) {
    const mints = new Set();
    for(const t of tfers) { if(!IGNORE.has(t.mint) && t.mint!==CONFIG.SOL && t.tokenAmount>0) mints.add(t.mint); }
    for(const mint of mints) {
      if(tx.type!=='SWAP' && !desc.includes('swap') && !desc.includes('buy') && !desc.includes('sell')) continue;
      if(solOut>0.01) buys.push({mint, amt:tfers.find(t=>t.mint===mint)?.tokenAmount||0});
      else if(solIn>0.01) sells.push({mint, amt:tfers.find(t=>t.mint===mint)?.tokenAmount||0});
      break;
    }
  }

  const trades = [];
  for(const b of buys) trades.push({mint:b.mint, dir:'buy', sol:solOut||0.01, sig:tx.signature, src:tx.source||'?'});
  for(const s of sells) trades.push({mint:s.mint, dir:'sell', sol:solIn||0.01, sig:tx.signature, src:tx.source||'?'});
  return trades.length > 0 ? trades : null;
}

// === SIZING ===
function calcSize(targetSol, ourBal) {
  let amt = targetSol * CONFIG.RATIO;
  amt = Math.max(amt, CONFIG.MIN_BUY_SOL);
  amt = Math.min(amt, ourBal * CONFIG.MAX_BUY_PCT);
  amt = Math.min(amt, ourBal - 0.003);
  return amt >= CONFIG.MIN_BUY_SOL ? amt : 0;
}

// === EXECUTION: BUY (unchanged from v11) ===
async function execBuy(mint, sol, targetSol, attempt=1) {
  const info = await tokenInfo(mint);
  const lamports = Math.floor(sol * 1e9);
  log('EXEC', `🛒 BUY ${info.sym} ${sol.toFixed(4)} SOL (attempt ${attempt})`, {mint:mint.slice(0,12)});

  try {
    const qr = await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${CONFIG.SOL}&outputMint=${mint}&amount=${lamports}&slippageBps=${CONFIG.MAX_SLIPPAGE_BPS}`);
    if(!qr.ok) throw new Error(`Quote ${qr.status}`);
    const q = await qr.json();
    if(!q.outAmount || q.outAmount==='0') throw new Error('No route');

    const sr = await fetch(CONFIG.JUPITER_SWAP,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({quoteResponse:q, userPublicKey:state.wallet.publicKey.toString(), wrapAndUnwrapSol:true,
        dynamicSlippage:{minBps:50,maxBps:CONFIG.MAX_SLIPPAGE_BPS}, prioritizationFeeLamports:CONFIG.PRIORITY_FEE_LAMPORTS})});
    if(!sr.ok) throw new Error(`Swap ${sr.status}`);
    const sd = await sr.json();
    if(!sd.swapTransaction) throw new Error('No swap tx');

    const buf = Buffer.from(sd.swapTransaction,'base64');
    const tx = VersionedTransaction.deserialize(buf);
    tx.sign([state.wallet]);
    const sig = await state.connection.sendRawTransaction(tx.serialize(),{skipPreflight:true,maxRetries:3});

    if(await confirm(sig)) {
      state.positions.set(mint, {time:Date.now(), sol, sym:info.sym, soldPct:0, isSelling:false, highestRoi:-Infinity, lastBarStep:0});
      state.stats.buys++;
      const msg = `🟢  **BUY** \`${mint}\`\n💸  **${sol.toFixed(4)} SOL**  ·  target: ${targetSol.toFixed(2)} SOL\n🔗  https://solscan.io/tx/${sig}`;
      log('BUY', `✅ ${info.sym} ${sol.toFixed(4)} SOL`);
      await discord(msg);
      return true;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    log('ERROR', `Buy fail: ${e.message}`, {attempt});
    if(attempt < CONFIG.MAX_RETRIES) {
      state.stats.retries++;
      await sleep(2000);
      return execBuy(mint, sol, targetSol, attempt+1);
    }
    state.stats.errors++;
    await discord(`❌ Buy failed: ${info.sym} \`${mint}\` — ${e.message}`);
    return false;
  }
}

// === EXECUTION: SELL (supports partial %, normal or emergency mode) ===
async function execSell(mint, pct, reason, emergency=false, attempt=1) {
  const info = await tokenInfo(mint);
  const pos = state.positions.get(mint);
  const remain = pos ? (100 - (pos.soldPct||0)) : 100;
  const sellPct = Math.min(pct, remain);
  if(sellPct <= 0) { state.positions.delete(mint); return false; }

  const slippage = emergency ? CONFIG.EMERGENCY_SLIPPAGE_BPS : CONFIG.MAX_SLIPPAGE_BPS;
  const priority = emergency ? CONFIG.EMERGENCY_PRIORITY_LAMPORTS : CONFIG.PRIORITY_FEE_LAMPORTS;
  const tag = emergency ? '🚨 EMERGENCY' : '🔴';

  log('EXEC', `${tag} SELL ${sellPct}% ${info.sym} — ${reason} (attempt ${attempt})`, {mint:mint.slice(0,12), emergency});

  try {
    const accts = await state.connection.getParsedTokenAccountsByOwner(state.wallet.publicKey,{mint:new PublicKey(mint)});
    const acct = accts?.value?.[0];
    if(!acct) { state.positions.delete(mint); return false; }
    const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount||0);
    if(bal<=0) { state.positions.delete(mint); return false; }
    const dec = acct.account.data.parsed.info.tokenAmount.decimals;
    const sellBal = bal * (sellPct / 100);
    const raw = BigInt(Math.floor(sellBal * Math.pow(10, dec)));
    if(raw<=0n) { state.positions.delete(mint); return false; }

    const qr = await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL}&amount=${raw.toString()}&slippageBps=${slippage}`);
    if(!qr.ok) throw new Error(`Sell quote ${qr.status}`);
    const q = await qr.json();
    if(!q.outAmount) throw new Error('No sell route');

    const sr = await fetch(CONFIG.JUPITER_SWAP,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({quoteResponse:q, userPublicKey:state.wallet.publicKey.toString(), wrapAndUnwrapSol:true,
        dynamicSlippage:{minBps:50,maxBps:slippage}, prioritizationFeeLamports:priority})});
    if(!sr.ok) throw new Error(`Sell swap ${sr.status}`);
    const sd = await sr.json();
    if(!sd.swapTransaction) throw new Error('No sell tx');

    const buf = Buffer.from(sd.swapTransaction,'base64');
    const tx = VersionedTransaction.deserialize(buf);
    tx.sign([state.wallet]);
    const sig = await state.connection.sendRawTransaction(tx.serialize(),{skipPreflight:true,maxRetries:5});

    if(await confirm(sig)) {
      const solBack = parseFloat(q.outAmount)/1e9;
      const pnlPortion = pos?.sol ? (solBack - (pos.sol * sellPct / 100)) : 0;
      state.stats.sells++;

      if(pos) pos.soldPct = (pos.soldPct||0) + sellPct;
      if(!pos || pos.soldPct >= 100) state.positions.delete(mint);

      const pnlSign = pnlPortion >= 0 ? '+' : '';
      const pnlEmoji = pnlPortion >= 0 ? '📈' : '📉';
      let sellEmoji, sellLabel;
      if(emergency) {
        sellEmoji = '⚠️🚨';
        sellLabel = '**EMERGENCY SELL**';
      } else if(reason.startsWith('TRAILING SL') || reason.startsWith('STOP LOSS') || reason.startsWith('SL')) {
        sellEmoji = '🛑';
        sellLabel = '**STOP LOSS**';
      } else if(reason.startsWith('stall')) {
        sellEmoji = '⏰';
        sellLabel = '**STALL EXIT**';
      } else {
        sellEmoji = '🔴';
        sellLabel = '**SELL**';
      }
      const msg = `${sellEmoji}  ${sellLabel} \`${mint}\`\n💰  **${solBack.toFixed(4)} SOL** back  ·  ${pnlEmoji} PnL: **${pnlSign}${pnlPortion.toFixed(4)} SOL**\n📋  ${reason}\n🔗  https://solscan.io/tx/${sig}`;
      log('SELL', `✅ ${info.sym} ${sellPct}% → ${solBack.toFixed(4)} SOL (${pnlPortion>=0?'+':''}${pnlPortion.toFixed(4)})${emergency?' EMERGENCY':''}`);
      await discord(msg);
      return true;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    log('ERROR', `Sell fail: ${e.message}`, {attempt, emergency});
    if(attempt < CONFIG.MAX_RETRIES) {
      state.stats.retries++;
      await sleep(emergency ? 500 : 2000); // Faster retry on emergency
      return execSell(mint, pct, reason, emergency, attempt+1);
    }
    state.stats.errors++;
    await discord(`❌ Sell failed: ${info.sym} \`${mint}\` — ${e.message}${emergency?' [EMERGENCY]':''}`);
    return false;
  }
}

async function confirm(sig, timeout=60000) {
  const s=Date.now();
  while(Date.now()-s<timeout) {
    try {
      const r=await state.connection.getSignatureStatuses([sig]);
      const v=r?.value?.[0];
      if(v?.err) return false;
      if(v?.confirmationStatus==='confirmed'||v?.confirmationStatus==='finalized') return true;
    } catch(e){}
    await sleep(2000);
  }
  return false;
}

// ============================================================
// EXIT MANAGER — Single-Shot Whale Front-Run
// ============================================================
// The whale dumps at ~+50%. We sell at +40-45% to beat him.
// One sell, one fee, maximum profit retained.
// Live console shows whale PnL approaching dump zone.
// Safety nets: -20% SL, 3min stall, emergency eject unchanged.
// ============================================================
async function exitManager() {
  log('INFO', `🎯 Whale Tracker active | Sell zone: +${CONFIG.WHALE_TP_MIN}% to +${CONFIG.WHALE_TP_MAX}% | SL: ${CONFIG.STOP_LOSS_PCT}% | Stall: ${CONFIG.STALL_MINUTES}min`);

  while(state.isRunning) {
    await sleep(CONFIG.EXIT_CHECK_MS);

    for(const [mint, pos] of state.positions) {
      if(!pos.sol || pos.sol <= 0) continue;
      if((pos.soldPct||0) >= 100) continue;
      if(pos.isSelling) continue; // Sell lock: emergency poll already handling this position

      try {
        // Get current position value via Jupiter quote
        const accts = await state.connection.getParsedTokenAccountsByOwner(state.wallet.publicKey,{mint:new PublicKey(mint)});
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

        const currentValSol = parseFloat(q.outAmount) / 1e9;
        const originalInvest = pos.sol;
        const roiPct = ((currentValSol / originalInvest) - 1) * 100;
        const ageMin = (Date.now() - pos.time) / 60000;
        const ageSec = ((Date.now() - pos.time) / 1000).toFixed(0);

        // === TRAILING STOP: Update highestRoi and adjust dynamic SL ===
        if(roiPct > (pos.highestRoi ?? -Infinity)) pos.highestRoi = roiPct;
        let dynamicSL = CONFIG.STOP_LOSS_PCT; // default: -20%
        if(pos.highestRoi >= 25) dynamicSL = 10;       // Peak hit +25% → SL moves to +10%
        else if(pos.highestRoi >= 15) dynamicSL = 0;   // Peak hit +15% → SL moves to 0% (break-even)

        // Live console log — show whale approaching dump zone
        const bar = roiPct >= 0
          ? '█'.repeat(Math.min(Math.floor(roiPct / 2), 25)) + '░'.repeat(Math.max(25 - Math.floor(roiPct / 2), 0))
          : '▓'.repeat(Math.min(Math.floor(Math.abs(roiPct) / 2), 25));
        const danger = roiPct >= 35 ? ' ⚠️ DUMP ZONE APPROACHING' : roiPct >= CONFIG.WHALE_TP_MIN ? ' 🔥 SELLING NOW' : '';
        const slLabel = dynamicSL !== CONFIG.STOP_LOSS_PCT ? ` | TSL:${dynamicSL>=0?'+':''}${dynamicSL}%` : '';
        console.log(`  [WATCHING] ${pos.sym} | Whale/Bot PnL: ${roiPct>=0?'+':''}${roiPct.toFixed(1)}% [${bar}] | Peak: ${pos.highestRoi>-Infinity?(pos.highestRoi>=0?'+':'')+pos.highestRoi.toFixed(1)+'%':'--'}${slLabel} | Target: +${CONFIG.WHALE_TP_MIN}% | ${ageSec}s${danger}`);

        // === DISCORD PROGRESS BAR: Post update at each 10% ROI milestone ===
        if(roiPct > 0) {
          const step = Math.floor(roiPct / 10); // 1=10%, 2=20%, ... 5=50%+
          if(step > (pos.lastBarStep || 0)) {
            pos.lastBarStep = step;
            const cappedPct = Math.min(roiPct, 50);
            const filled = Math.round(cappedPct / 5); // 10 blocks = 50%
            const discordBar = '🟩'.repeat(filled) + '⬛'.repeat(Math.max(10 - filled, 0));
            const milestoneLabel = roiPct >= 40 ? ' 🔥 DUMP ZONE' : roiPct >= 30 ? ' ⚠️ DANGER ZONE' : '';
            const slInfo = dynamicSL !== CONFIG.STOP_LOSS_PCT ? `  ·  TSL locked at **${dynamicSL>=0?'+':''}${dynamicSL}%**` : '';
            await discord(`🐋  **WHALE TRACKER** \`${mint.slice(0,16)}...\`\n${discordBar}\n📊  ROI: **+${roiPct.toFixed(1)}%** / **50% rug zone**${milestoneLabel}\n⏱  Age: **${ageSec}s**  ·  SL: **${dynamicSL>=0?'+':''}${dynamicSL}%**${slInfo}`);
          }
        }

        // === 1. STOP LOSS: dynamic trailing SL → dump everything ===
        if(roiPct <= dynamicSL) {
          const slType = dynamicSL !== CONFIG.STOP_LOSS_PCT ? 'TRAILING SL' : 'STOP LOSS';
          log('EXIT', `⛔ ${slType} ${pos.sym} at ${roiPct.toFixed(1)}% (SL: ${dynamicSL>=0?'+':''}${dynamicSL}%) — dumping 100%`);
          pos.isSelling = true;
          await execSell(mint, 100, `${slType}_${roiPct.toFixed(0)}%`, false);
          continue;
        }

        // === 2. STALL TIMER: 3 min → dump everything ===
        if(ageMin >= CONFIG.STALL_MINUTES) {
          log('EXIT', `⏰ STALL ${pos.sym} — ${ageMin.toFixed(1)}min with ${roiPct.toFixed(1)}% ROI — dumping before whale`);
          pos.isSelling = true;
          await execSell(mint, 100, `stall_${ageMin.toFixed(0)}min_${roiPct.toFixed(0)}%`, false);
          continue;
        }

        // === 3. WHALE TRACKER: +40% → SINGLE-SHOT 100% SELL ===
        // Front-run the whale's +50% dump zone
        if(roiPct >= CONFIG.WHALE_TP_MIN) {
          log('EXIT', `🎯🔥 WHALE TRACKER ${pos.sym} at +${roiPct.toFixed(1)}% — FRONT-RUNNING WHALE DUMP — selling 100%`);
          pos.isSelling = true;
          await execSell(mint, 100, `WHALE_FRONTRUN_+${roiPct.toFixed(0)}%`, false);
          await discord(`🐋🎯  **WHALE FRONT-RUN — SOLD**\n\`${mint}\`\n📊  ROI: **+${roiPct.toFixed(1)}%**  ·  Peak: **+${pos.highestRoi.toFixed(1)}%**\n✅  Sold 100% before whale dump zone (+50%)\n📋  ${`WHALE_FRONTRUN_+${roiPct.toFixed(0)}%`}`);
          continue;
        }

      } catch(e) { /* skip this cycle for this position */ }
    }
  }
}

// === POLL: Watch target, mirror buys, EMERGENCY sell on whale dump ===
async function poll() {
  log('INFO', `👀 Watching ${CONFIG.TARGET.slice(0,12)}... every ${CONFIG.POLL_MS/1000}s`);
  let cycle = 0;

  while(state.isRunning) {
    cycle++;
    try {
      const r = await fetch(CONFIG.HELIUS_RPC,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getSignaturesForAddress',params:[CONFIG.TARGET,{limit:40}]})});
      const d = await r.json();
      const sigs = d?.result || [];
      const newSigs = [];
      for(const s of sigs) { if(s.signature===state.lastSig) break; if(!s.err) newSigs.push(s); }

      if(newSigs.length > 0) {
        state.lastSig = newSigs[0].signature;
        const parsed = await heliusParse(newSigs.map(s=>s.signature));

        for(const tx of parsed) {
          const trades = extractTrades(tx);
          if(!trades) continue;

          // WHALE SELLING → EMERGENCY SELL with max priority
          for(const t of trades.filter(t=>t.dir==='sell')) {
            if(state.positions.has(t.mint)) {
              const pos = state.positions.get(t.mint);
              if(pos.isSelling) continue; // Sell lock: exitManager already handling this position
              log('EMERGENCY', `🚨 WHALE DUMPING ${t.mint.slice(0,8)}... — EMERGENCY SELL`);
              pos.isSelling = true;
              await execSell(t.mint, 100, 'WHALE_DUMP', true); // emergency=true → max fees
            } else {
              try {
                const a = await state.connection.getParsedTokenAccountsByOwner(state.wallet.publicKey,{mint:new PublicKey(t.mint)});
                const b = parseFloat(a?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount||0);
                if(b > 0) {
                  state.positions.set(t.mint, {time:0, sol:0, sym:'?', soldPct:0, isSelling:true, highestRoi:-Infinity});
                  await execSell(t.mint, 100, 'WHALE_DUMP_leftover', true);
                }
              } catch(e){}
            }
          }

          // Buys — mirror all target buys unconditionally
          for(const t of trades.filter(t=>t.dir==='buy')) {
            if(state.positions.has(t.mint)) continue;
            const bal = await solBal();
            const size = calcSize(t.sol, bal);
            if(size <= 0) { log('INFO', `Low bal (${bal.toFixed(4)})`); break; }

            log('MIRROR', `🎯 BUY ${t.mint.slice(0,8)}... ${t.sol.toFixed(2)} SOL → us: ${size.toFixed(4)} SOL`);
            await execBuy(t.mint, size, t.sol);
            await sleep(300);
          }
        }
      }

      if(cycle % 30 === 0) {
        log('INFO', `📊 #${cycle} | ${state.positions.size} pos | ${state.stats.buys}B ${state.stats.sells}S ${state.stats.errors}E ${state.stats.retries}R`);
      }
    } catch(e) { log('ERROR', 'Poll', {err:e.message}); }
    await sleep(CONFIG.POLL_MS);
  }
}

// === HEALTH ===
async function health() {
  while(state.isRunning) {
    const bal = await solBal();
    const pnl = bal - state.stats.startBal;
    console.log('\n' + '═'.repeat(55));
    console.log('  🪞 WINSTON v11.1 — Anti-Rug Mirror');
    console.log('═'.repeat(55));
    console.log(`  🎯 ${CONFIG.TARGET.slice(0,20)}...`);
    console.log(`  💰 ${bal.toFixed(4)} SOL | PnL: ${pnl>=0?'+':''}${pnl.toFixed(4)}`);
    console.log(`  🛒 ${state.stats.buys}B 🚪 ${state.stats.sells}S ❌ ${state.stats.errors}E 🔄 ${state.stats.retries}R`);
    console.log(`  📦 ${state.positions.size} positions`);
    console.log(`  🎯 Whale Tracker: sell 100% at +${CONFIG.WHALE_TP_MIN}% (whale dumps at +50%)`);
    console.log(`  ⛔ SL: ${CONFIG.STOP_LOSS_PCT}% | ⏰ Stall: ${CONFIG.STALL_MINUTES}min`);
    for(const [m,p] of state.positions) {
      const age = ((Date.now()-p.time)/60000).toFixed(1);
      console.log(`     ${p.sym} ${m.slice(0,8)}... | ${age}m | sold ${p.soldPct||0}% | entry ${p.sol.toFixed(4)} SOL`);
    }
    console.log('═'.repeat(55) + '\n');
    await sleep(CONFIG.HEALTH_MS);
  }
}

// === MAIN ===
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  🪞 WINSTON v11.1 — Anti-Rug Mirror Bot              ║');
  console.log('║  Beat the whale • TP ladder • SL • Stall timer       ║');
  console.log('║  Emergency sells with max priority fees               ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  if(!CONFIG.HELIUS_API_KEY) { log('ERROR','HELIUS_API_KEY needed'); process.exit(1); }
  if(!CONFIG.PRIVATE_KEY) { log('ERROR','WALLET_PRIVATE_KEY needed'); process.exit(1); }

  try { state.wallet = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY)); }
  catch(e) { log('ERROR','Bad key'); process.exit(1); }
  log('INFO', `Wallet: ${state.wallet.publicKey}`);

  state.connection = new Connection(CONFIG.HELIUS_RPC, {commitment:'confirmed'});
  state.stats.startBal = await solBal();
  log('INFO', `Balance: ${state.stats.startBal.toFixed(4)} SOL`);

  try {
    const r = await fetch(CONFIG.HELIUS_RPC,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getSignaturesForAddress',params:[CONFIG.TARGET,{limit:1}]})});
    const d = await r.json();
    state.lastSig = d?.result?.[0]?.signature || null;
  } catch(e) { log('ERROR','Init fail'); process.exit(1); }

  state.isRunning = true;
  log('INFO', `📐 Ratio: ${(CONFIG.RATIO*100).toFixed(1)}% | Min: ${CONFIG.MIN_BUY_SOL} SOL`);
  log('INFO', `🎯 Whale Tracker: single-shot 100% sell at +${CONFIG.WHALE_TP_MIN}% to +${CONFIG.WHALE_TP_MAX}% (whale dumps at +50%)`);
  log('INFO', `⛔ SL: ${CONFIG.STOP_LOSS_PCT}% | ⏰ Stall: ${CONFIG.STALL_MINUTES}min | 🚨 Emergency: ${CONFIG.EMERGENCY_SLIPPAGE_BPS/100}% slip, ${CONFIG.EMERGENCY_PRIORITY_LAMPORTS/1e9} SOL priority`);

  await discord(`▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n🟢  **WINSTON NOW ONLINE**\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n🎯  Target: \`${CONFIG.TARGET}\`\n💰  Balance: **${state.stats.startBal.toFixed(4)} SOL**\n📊  TP: **+${CONFIG.WHALE_TP_MIN}%**  |  SL: **${CONFIG.STOP_LOSS_PCT}%**  |  Stall: **${CONFIG.STALL_MINUTES}min**\n🚨  Emergency: ${CONFIG.EMERGENCY_SLIPPAGE_BPS/100}% slippage, 16x priority\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`);

  let shuttingDown = false;
  const shutdown = async () => {
    if(shuttingDown) return;
    shuttingDown = true;
    state.isRunning = false;
    const f = await solBal(); const p = f - state.stats.startBal;
    const pnlStr = `${p>=0?'+':''}${p.toFixed(4)} SOL`;
    await discord(`▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n🔴  **WINSTON OFFLINE**\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n💰  Balance: **${f.toFixed(4)} SOL**\n📈  Session PnL: **${pnlStr}**\n🛒  ${state.stats.buys} Buys  |  🚪 ${state.stats.sells} Sells  |  ❌ ${state.stats.errors} Errors\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await Promise.all([poll(), exitManager(), health()]);
}

main().catch(e => { log('ERROR','Fatal',{err:e.message}); process.exit(1); });
