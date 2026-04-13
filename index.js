// ============================================================
// WINSTON v16 — Copy Trade Bot
// ⚠️  HIGH RISK — for educational/personal use only
// ============================================================
// Mirrors one wallet with smart exits:
//
//   1. He buys  → we buy instantly (0.12 SOL / ~$10)
//   2. EXIT PRIORITY ORDER:
//      a. Take Profit at +175% ROI (configurable)
//      b. He sells  → we sell BEFORE him (emergency priority)
//      c. Stop Loss at -45% (configurable)
//      d. Max hold fallback at 10 minutes
//
// Target: CP7eVtQYsweR7vAjSvW2shgA1weszsVmxDFbpV22s5w1
// ============================================================

require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const bs58   = require('bs58');
const fetch  = require('node-fetch');

// ── CONFIG ───────────────────────────────────────────────────
const CONFIG = {
  // Loaded from .env
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  PRIVATE_KEY:    process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || '',
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || '',

  get HELIUS_RPC() { return `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },
  get HELIUS_TX()  { return `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${this.HELIUS_API_KEY}`; },

  JUPITER_QUOTE: 'https://lite-api.jup.ag/swap/v1/quote',
  JUPITER_SWAP:  'https://lite-api.jup.ag/swap/v1/swap',

  // ── Target wallet to copy ────────────────────────────────
  TARGET: 'CP7eVtQYsweR7vAjSvW2shgA1weszsVmxDFbpV22s5w1',

  // ── Entry filter ─────────────────────────────────────────
  MIN_BUY_SOL_SIGNAL: 1.0,   // ignore whale buys below 1 SOL — too small/risky

  // ── Scaled trade sizing ($5-$10 based on his conviction) ──
  // He buys 1-2 SOL    → we bet ~$5  (0.033 SOL)
  // He buys 2-4 SOL    → we bet ~$7  (0.046 SOL)
  // He buys 4+ SOL     → we bet ~$10 (0.065 SOL)
  BUY_TIERS: [
    { maxWhaleSol: 2.0,        ourSol: 0.033 },
    { maxWhaleSol: 4.0,        ourSol: 0.046 },
    { maxWhaleSol: Infinity,   ourSol: 0.065 },
  ],
  BUY_SOL: 0.065,  // fallback default (overridden by scaleBuy at runtime)

  // ── Exit config ──────────────────────────────────────────
  TP_PCT:           175,   // take profit at +175% ROI (2.75x)
  SL_PCT:           -45,   // stop loss at -45%
  MAX_HOLD_SECONDS: 600,   // 10 min absolute max hold
  EXIT_CHECK_MS:    800,   // check TP/SL every 800ms

  // ── Speed fees ───────────────────────────────────────────
  // Buy: high priority to enter with him
  BUY_PRIORITY_LAMPORTS:  3000000,  // 0.003 SOL
  BUY_SLIPPAGE_BPS:       2000,     // 20%

  // Sell (normal TP/SL): fast but not maximum
  SELL_PRIORITY_LAMPORTS: 3000000,  // 0.003 SOL
  SELL_SLIPPAGE_BPS:      2500,     // 25%

  // Emergency sell (he's selling): maximum speed to beat him
  EMERGENCY_PRIORITY_LAMPORTS: 8000000, // 0.008 SOL — fastest possible
  EMERGENCY_SLIPPAGE_BPS:      4000,    // 40% — get out no matter what

  MAX_RETRIES: 3,
  POLL_MS:     500,   // poll every 500ms
  HEALTH_MS:  30000,
  SOL_MINT:  'So11111111111111111111111111111111111111112',
};

// Tokens we never trade
const IGNORE = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  // USDT
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
  // mint → { time, sol, sym, isSelling, entryTokens }
  positions:   new Map(),
  tradedMints: new Set(), // session blacklist
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

// ── HELIUS TX PARSING ────────────────────────────────────────

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
  const w     = CONFIG.TARGET;
  const tfers = tx.tokenTransfers  || [];
  const native= tx.nativeTransfers || [];
  const desc  = (tx.description||'').toLowerCase();

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

  // Aggregator routing fallback
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

// ── CONFIRM TX ───────────────────────────────────────────────

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
// Quotes the current value of our token balance back to SOL
// Returns ROI as a percentage, or null if quote fails

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
    return ((currentVal / pos.sol) - 1) * 100;
  } catch(e) { return null; }
}

// ── SCALE BUY — maps whale size to our bet size ─────────────
// Returns the correct SOL amount based on BUY_TIERS config

function scaleBuy(whaleSol) {
  for(const tier of CONFIG.BUY_TIERS) {
    if(whaleSol <= tier.maxWhaleSol) return tier.ourSol;
  }
  return CONFIG.BUY_SOL; // fallback
}

// ── BUY ──────────────────────────────────────────────────────

async function execBuy(mint, whaleSol, sol=CONFIG.BUY_SOL) {
  state.tradedMints.add(mint); // blacklist immediately
  const info    = await tokenInfo(mint);
  const lamports= Math.floor(sol * 1e9);

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
        time: Date.now(), sol, sym: info.sym, isSelling: false
      });
      state.stats.buys++;
      log('BUY', `✅ ${info.sym} ${sol.toFixed(4)} SOL | TP:+${CONFIG.TP_PCT}% SL:${CONFIG.SL_PCT}%`);
      await discord(
        `🪞  **COPY BUY** \`${mint}\`\n` +
        `💸  **${sol.toFixed(4)} SOL** | Whale spent: **${whaleSol.toFixed(2)} SOL**\n` +
        `🎯  TP: **+${CONFIG.TP_PCT}%** | SL: **${CONFIG.SL_PCT}%** | Max: **${CONFIG.MAX_HOLD_SECONDS}s**\n` +
        `⚡  Will also sell if he sells first\n` +
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

// ── SELL ─────────────────────────────────────────────────────

async function execSell(mint, reason, emergency=false, attempt=1) {
  const info    = await tokenInfo(mint);
  const pos     = state.positions.get(mint);
  if(!pos) return false;

  const slippage = emergency ? CONFIG.EMERGENCY_SLIPPAGE_BPS : CONFIG.SELL_SLIPPAGE_BPS;
  const priority = emergency ? CONFIG.EMERGENCY_PRIORITY_LAMPORTS : CONFIG.SELL_PRIORITY_LAMPORTS;
  const tag      = emergency ? '🚨 EMERGENCY' : '🔴';

  log('EXEC', `${tag} SELL ${info.sym} — ${reason} (attempt ${attempt})`, { mint: mint.slice(0,12) });

  try {
    const accts = await state.connection.getParsedTokenAccountsByOwner(
      state.wallet.publicKey, { mint: new PublicKey(mint) }
    );
    const acct = accts?.value?.[0];
    if(!acct) { state.positions.delete(mint); return false; }
    const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount||0);
    if(bal <= 0) { state.positions.delete(mint); return false; }
    const dec = acct.account.data.parsed.info.tokenAmount.decimals;
    const raw = BigInt(Math.floor(bal * Math.pow(10, dec)));
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
      const pnl      = pos.sol ? solBack - pos.sol : 0;
      const pnlSign  = pnl >= 0 ? '+' : '';
      const pnlEmoji = pnl >= 0 ? '📈' : '📉';
      const roiPct   = pos.sol ? ((solBack / pos.sol) - 1) * 100 : 0;

      state.positions.delete(mint);
      state.stats.sells++;
      log('SELL', `✅ ${info.sym} → ${solBack.toFixed(4)} SOL (${pnlSign}${pnl.toFixed(4)}) | ${reason}`);

      const label = emergency                   ? '🚨 **EMERGENCY EXIT** (whale selling)'
        : reason.startsWith('TP')               ? '🎯 **TAKE PROFIT**'
        : reason.startsWith('SL')               ? '🛑 **STOP LOSS**'
        : reason.startsWith('max_hold')         ? '⏱ **MAX HOLD EXIT**'
        : '🔴 **SELL**';

      await discord(
        `${label} \`${mint}\`\n` +
        `💰  **${solBack.toFixed(4)} SOL** back  ·  ${pnlEmoji} **${pnlSign}${pnl.toFixed(4)} SOL** (${pnlSign}${roiPct.toFixed(1)}%)\n` +
        `📋  ${reason}\n` +
        `🔗  https://solscan.io/tx/${sig}`
      );
      return true;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    log('ERROR', `Sell fail: ${e.message}`, { attempt, emergency });
    if(attempt < CONFIG.MAX_RETRIES) {
      state.stats.retries++;
      await sleep(emergency ? 200 : 1000);
      return execSell(mint, reason, emergency, attempt+1);
    }
    state.stats.errors++;
    state.positions.delete(mint);
    await discord(`❌ Sell FAILED: ${info.sym} \`${mint.slice(0,16)}\` — ${e.message}`);
    return false;
  }
}

// ── EXIT MANAGER — TP / SL / max hold ───────────────────────

async function exitManager() {
  log('INFO', `🎯 Exit manager | TP:+${CONFIG.TP_PCT}% | SL:${CONFIG.SL_PCT}% | Max:${CONFIG.MAX_HOLD_SECONDS}s`);

  while(state.isRunning) {
    await sleep(CONFIG.EXIT_CHECK_MS);

    for(const [mint, pos] of state.positions) {
      if(pos.isSelling) continue;

      const ageSec = (Date.now() - pos.time) / 1000;

      // Max hold fallback — always check first (no RPC call needed)
      if(ageSec >= CONFIG.MAX_HOLD_SECONDS) {
        log('EXIT', `⏱ MAX HOLD ${pos.sym} at ${ageSec.toFixed(0)}s — selling`);
        pos.isSelling = true;
        execSell(mint, `max_hold_${ageSec.toFixed(0)}s`, false)
          .catch(e => log('ERROR', `Max-hold sell error: ${e.message}`));
        continue;
      }

      // Get current ROI via Jupiter quote
      const roi = await getCurrentRoi(mint, pos);
      if(roi === null) continue; // quote failed, skip this cycle

      // Console display
      const bar = roi >= 0
        ? '█'.repeat(Math.min(Math.floor(roi/10), 20)) + '░'.repeat(Math.max(20-Math.floor(roi/10),0))
        : '▓'.repeat(Math.min(Math.floor(Math.abs(roi)/5), 20));
      console.log(`  [${pos.sym}] ${roi>=0?'+':''}${roi.toFixed(1)}% [${bar}] | ${ageSec.toFixed(0)}s | TP:+${CONFIG.TP_PCT}% SL:${CONFIG.SL_PCT}%`);

      // Take profit
      if(roi >= CONFIG.TP_PCT) {
        log('EXIT', `🎯 TAKE PROFIT ${pos.sym} at +${roi.toFixed(1)}%`);
        pos.isSelling = true;
        execSell(mint, `TP_+${roi.toFixed(0)}%`, false)
          .catch(e => log('ERROR', `TP sell error: ${e.message}`));
        await discord(`🎯  **TAKE PROFIT** \`${mint.slice(0,16)}...\`\n📊  **+${roi.toFixed(1)}%** after ${ageSec.toFixed(0)}s`);
        continue;
      }

      // Stop loss
      if(roi <= CONFIG.SL_PCT) {
        log('EXIT', `🛑 STOP LOSS ${pos.sym} at ${roi.toFixed(1)}%`);
        pos.isSelling = true;
        execSell(mint, `SL_${roi.toFixed(0)}%`, false)
          .catch(e => log('ERROR', `SL sell error: ${e.message}`));
        await discord(`🛑  **STOP LOSS** \`${mint.slice(0,16)}...\`\n📊  **${roi.toFixed(1)}%** after ${ageSec.toFixed(0)}s`);
        continue;
      }
    }
  }
}

// ── POLL — watch target, mirror buys, emergency sell on dump ─

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

          // ── HE SOLD → EMERGENCY EXIT ────────────────────
          // Use maximum priority to beat him to the exit
          for(const t of trades.filter(t => t.dir==='sell')) {
            if(!state.positions.has(t.mint)) continue;
            const pos = state.positions.get(t.mint);
            if(pos.isSelling) continue;
            pos.isSelling = true;
            log('EMERGENCY', `🚨 TARGET SELLING ${t.mint.slice(0,10)}... — EMERGENCY EXIT`);
            // Fire immediately without await — don't delay for other trades
            execSell(t.mint, 'target_sold', true)
              .catch(e => log('ERROR', `Emergency sell error: ${e.message}`));
          }

          // ── HE BOUGHT → WE BUY ──────────────────────────
          for(const t of trades.filter(t => t.dir==='buy')) {
            if(IGNORE.has(t.mint)) continue;
            if(state.tradedMints.has(t.mint)) continue;
            if(state.positions.has(t.mint)) continue;

            // Skip if his buy is too small — low conviction, high rug risk
            if(t.sol < CONFIG.MIN_BUY_SOL_SIGNAL) {
              log('INFO', `⏭ SKIP ${t.mint.slice(0,10)}... whale only spent ${t.sol.toFixed(2)} SOL (min: ${CONFIG.MIN_BUY_SOL_SIGNAL})`);
              continue;
            }

            // Scale our bet to match his conviction level
            const ourSize = scaleBuy(t.sol);

            const bal = await solBal();
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
    console.log('\n' + '═'.repeat(60));
    console.log('  🪞 WINSTON v16 — Copy Trade Bot');
    console.log('═'.repeat(60));
    console.log(`  👀 ${CONFIG.TARGET.slice(0,20)}...`);
    console.log(`  💰 ${bal.toFixed(4)} SOL | PnL: ${pnl>=0?'+':''}${pnl.toFixed(4)} SOL`);
    console.log(`  🛒 ${state.stats.buys}B  🚪 ${state.stats.sells}S  ❌ ${state.stats.errors}E  🔄 ${state.stats.retries}R`);
    console.log(`  📦 ${state.positions.size} open | 🚫 ${state.tradedMints.size} blacklisted`);
    console.log(`  🎯 TP:+${CONFIG.TP_PCT}%  SL:${CONFIG.SL_PCT}%  Max:${CONFIG.MAX_HOLD_SECONDS}s  Buy:${CONFIG.BUY_SOL} SOL`);
    for(const [m, p] of state.positions) {
      const age = ((Date.now()-p.time)/1000).toFixed(0);
      console.log(`     ${p.sym} ${m.slice(0,8)}... | ${age}s | ${p.sol.toFixed(4)} SOL in`);
    }
    console.log('═'.repeat(60) + '\n');
    await sleep(CONFIG.HEALTH_MS);
  }
}

// ── MAIN ─────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  🪞 WINSTON v16 — Copy Trade Bot                         ║');
  console.log('║  Mirrors target · TP +175% · SL -45% · Emergency exit   ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  if(!CONFIG.HELIUS_API_KEY) { log('ERROR', 'HELIUS_API_KEY missing in .env'); process.exit(1); }
  if(!CONFIG.PRIVATE_KEY)    { log('ERROR', 'WALLET_PRIVATE_KEY missing in .env'); process.exit(1); }

  try { state.wallet = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY)); }
  catch(e) { log('ERROR', 'Bad private key'); process.exit(1); }
  log('INFO', `Wallet: ${state.wallet.publicKey}`);

  state.connection  = new Connection(CONFIG.HELIUS_RPC, { commitment:'confirmed' });
  state.stats.startBal = await solBal();
  log('INFO', `Balance: ${state.stats.startBal.toFixed(4)} SOL`);

  if(state.stats.startBal < 0.15) {
    log('ERROR', 'Need at least 0.15 SOL (0.12 buy + fees).');
    process.exit(1);
  }

  // Bootstrap cursor — don't replay old history on startup
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
  log('INFO', `🪞 LIVE | target: ${CONFIG.TARGET} | ${CONFIG.BUY_SOL} SOL | TP:+${CONFIG.TP_PCT}% | SL:${CONFIG.SL_PCT}%`);

  await discord(
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `🪞  **WINSTON v16 ONLINE**\n` +
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `👀  Target: \`${CONFIG.TARGET}\`\n` +
    `💸  **${CONFIG.BUY_SOL} SOL** (~$10) per trade\n` +
    `🎯  TP: **+${CONFIG.TP_PCT}%**  |  SL: **${CONFIG.SL_PCT}%**\n` +
    `🚨  Emergency exit if target sells first\n` +
    `⏱  Max hold: **${CONFIG.MAX_HOLD_SECONDS}s**\n` +
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
      `🔴  **WINSTON v16 OFFLINE**\n` +
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
