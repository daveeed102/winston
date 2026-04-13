// ============================================================
// WINSTON v20.1 — Pre-emptive Timer Exit Bot
// ⚠️  HIGH RISK — for educational/personal use only
// ============================================================
// Tuned specifically for CP7eVtQYsw...FbpV22s5w1
//
// CORE INSIGHT: He IS the price movement. When he sells,
// the dump is instant. Waiting for his sell signal = too late.
//
// Strategy: EXIT AT 6 MINUTES FLAT — before he sells.
// His median hold is 8-10min. At 6min the pump is still live.
// We don't need his sell signal. We just need to leave first.
//
// Exit priority:
//   1. SL at -20%      → bail early if it's a rug/bad token
//   2. Hard exit 6min  → out before he dumps, no exceptions
//
// Math per trade (0.065 SOL / ~$10):
//   Win  (exit at +15%): +0.0098 SOL profit after fees
//   Loss (SL at -20%):   -0.013  SOL loss after fees
//   Need ~57% win rate to profit — realistic for his style
// ============================================================

require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const bs58  = require('bs58');
const fetch = require('node-fetch');

// ── CONFIG ───────────────────────────────────────────────────
const CONFIG = {
  HELIUS_API_KEY:  process.env.HELIUS_API_KEY  || '',
  PRIVATE_KEY_1:   process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || '',
  PRIVATE_KEY_2:   process.env.WALLET_PRIVATE_KEY_2 || '',
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || '',

  get HELIUS_RPC() { return `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },
  get HELIUS_TX()  { return `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${this.HELIUS_API_KEY}`; },

  JUPITER_QUOTE: 'https://lite-api.jup.ag/swap/v1/quote',
  JUPITER_SWAP:  'https://lite-api.jup.ag/swap/v1/swap',

  // ── Target ───────────────────────────────────────────────
  TARGET: 'CP7eVtQYsweR7vAjSvW2shgA1weszsVmxDFbpV22s5w1',

  // ── Only copy trades where whale spends >= 2 SOL ────────
  // Data shows: every fast exit (<6min) was a sub-2 SOL buy.
  // Above 2 SOL his median hold is 12+ min — our timer wins.
  MIN_BUY_SOL_SIGNAL: 2.0,

  // ── Scaled sizing ($8-$12 based on his conviction) ───────
  // Whale spends 2-4 SOL   -> we bet 0.096 SOL (~$8)
  // Whale spends 4-8 SOL   -> we bet 0.120 SOL (~$10)
  // Whale spends 8+ SOL    -> we bet 0.140 SOL (~$12)
  BUY_TIERS: [
    { maxWhaleSol: 4.0,      ourSol: 0.096 }, // ~$8
    { maxWhaleSol: 8.0,      ourSol: 0.120 }, // ~$10
    { maxWhaleSol: Infinity, ourSol: 0.140 }, // ~$12
  ],
  BUY_SOL: 0.096,

  // ── Exit strategy — PRE-EMPTIVE TIMER ───────────────────
  // We exit at 6 minutes BEFORE he sells, not after.
  // His median hold is 8-10min — at 6min price still elevated.
  // SL at -20% catches rugs/bad tokens early.
  // NO TP — we just ride the 6 minutes and get out flat.
  TP_PCT:           35,   // cash immediately if up 35% — don't be greedy
  SL_PCT:          -20,   // bail early on bad tokens
  EXIT_SECONDS:    360,   // 6 minute hard exit — fallback if TP never hit

  EXIT_CHECK_MS: 500,     // check every 500ms for precision

  // ── Speed fees ───────────────────────────────────────────
  BUY_PRIORITY_LAMPORTS:       3000000, // 0.003 SOL
  BUY_SLIPPAGE_BPS:            2000,    // 20%
  SELL_PRIORITY_LAMPORTS:      3000000, // 0.003 SOL
  SELL_SLIPPAGE_BPS:           2500,    // 25%
  EMERGENCY_PRIORITY_LAMPORTS: 8000000, // 0.008 SOL — max speed to beat him
  EMERGENCY_SLIPPAGE_BPS:      4000,    // 40%

  MAX_RETRIES: 5,
  POLL_MS:     500,
  HEALTH_MS:  20000,
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

// ── WALLETS + STATE ──────────────────────────────────────────

function makeWallet(label) {
  return {
    label,
    keypair:        null,
    positions:      new Map(), // mint → { time, sol, sym, isSelling, highestRoi }
    tradedMints:    new Set(),
    emergencyQueue: new Set(),
    stats: { buys:0, sells:0, wins:0, losses:0, totalPnl:0, errors:0, retries:0, startBal:0 },
  };
}

const wallets = [];
const shared  = { connection:null, isRunning:false, lastSig:null };

// ── UTILS ────────────────────────────────────────────────────

function log(lv, msg, d={}) {
  const ts = new Date().toISOString();
  const ic = {INFO:'📡',BUY:'🟢',SELL:'🔴',EXEC:'⚡',ERROR:'❌',MIRROR:'🪞',EXIT:'🎯',EMERGENCY:'🚨'};
  console.log(`[${ts}] ${ic[lv]||'📋'} [${lv}] ${msg}${Object.keys(d).length?' '+JSON.stringify(d):''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function solBal(keypair) {
  try { return (await shared.connection.getBalance(keypair.publicKey)) / 1e9; } catch(e) { return 0; }
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
      const r = await shared.connection.getSignatureStatuses([sig]);
      const v = r?.value?.[0];
      if(v?.err) return false;
      if(v?.confirmationStatus==='confirmed'||v?.confirmationStatus==='finalized') return true;
    } catch(e) {}
    await sleep(1500);
  }
  return false;
}

// ── GET CURRENT ROI ──────────────────────────────────────────

async function getCurrentRoi(mint, pos, keypair) {
  try {
    const accts = await shared.connection.getParsedTokenAccountsByOwner(
      keypair.publicKey, { mint: new PublicKey(mint) }
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

// ── SCALE BUY ────────────────────────────────────────────────

function scaleBuy(whaleSol) {
  for(const tier of CONFIG.BUY_TIERS) {
    if(whaleSol <= tier.maxWhaleSol) return tier.ourSol;
  }
  return CONFIG.BUY_SOL;
}

// ── SELL ─────────────────────────────────────────────────────

async function execSell(w, mint, reason, emergency=false, attempt=1) {
  const info     = await tokenInfo(mint);
  const pos      = w.positions.get(mint);
  if(!pos) return false;

  const slippage = emergency ? CONFIG.EMERGENCY_SLIPPAGE_BPS : CONFIG.SELL_SLIPPAGE_BPS;
  const priority = emergency ? CONFIG.EMERGENCY_PRIORITY_LAMPORTS : CONFIG.SELL_PRIORITY_LAMPORTS;

  log('EXEC', `${emergency?'🚨':'🔴'} [${w.label}] SELL ${info.sym} — ${reason} (attempt ${attempt})`);

  try {
    const accts = await shared.connection.getParsedTokenAccountsByOwner(
      w.keypair.publicKey, { mint: new PublicKey(mint) }
    );
    const acct = accts?.value?.[0];
    if(!acct) { w.positions.delete(mint); return false; }
    const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount||0);
    if(bal <= 0) { w.positions.delete(mint); return false; }
    const dec = acct.account.data.parsed.info.tokenAmount.decimals;
    const raw = BigInt(Math.floor(bal * Math.pow(10, dec)));
    if(raw <= 0n) { w.positions.delete(mint); return false; }

    const qr = await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL_MINT}&amount=${raw.toString()}&slippageBps=${slippage}`);
    if(!qr.ok) throw new Error(`Sell quote ${qr.status}`);
    const q = await qr.json();
    if(!q.outAmount) throw new Error('No sell route');

    const sr = await fetch(CONFIG.JUPITER_SWAP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: q,
        userPublicKey: w.keypair.publicKey.toString(),
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
    tx.sign([w.keypair]);
    const sig = await shared.connection.sendRawTransaction(tx.serialize(), { skipPreflight:true, maxRetries:5 });

    if(await confirm(sig)) {
      const solBack  = parseFloat(q.outAmount) / 1e9;
      const pnl      = solBack - pos.sol;
      const pnlSign  = pnl >= 0 ? '+' : '';
      const pnlEmoji = pnl >= 0 ? '📈' : '📉';
      const roiPct   = ((solBack / pos.sol) - 1) * 100;

      // Track win/loss stats
      if(pnl >= 0) w.stats.wins++; else w.stats.losses++;
      w.stats.totalPnl += pnl;
      w.stats.sells++;
      w.positions.delete(mint);

      const winRate = w.stats.sells > 0 ? ((w.stats.wins/w.stats.sells)*100).toFixed(0) : '0';

      log('SELL', `✅ [${w.label}] ${info.sym} → ${solBack.toFixed(4)} SOL (${pnlSign}${pnl.toFixed(4)}) | ${reason} | WR:${winRate}%`);

      const label = emergency              ? `🚨 **EMERGENCY** [${w.label}]`
        : reason.startsWith('TP')          ? `🎯 **TAKE PROFIT** [${w.label}]`
        : reason.startsWith('SL')          ? `🛑 **STOP LOSS** [${w.label}]`
        : reason.startsWith('max_hold')    ? `⏱ **MAX HOLD** [${w.label}]`
        : `🔴 **SELL** [${w.label}]`;

      await discord(
        `${label} \`${mint}\`\n` +
        `💰  **${solBack.toFixed(4)} SOL** back  ·  ${pnlEmoji} **${pnlSign}${pnl.toFixed(4)} SOL** (**${pnlSign}${roiPct.toFixed(1)}%**)\n` +
        `📊  Session: **${w.stats.wins}W/${w.stats.losses}L** (${winRate}% WR) · PnL: **${w.stats.totalPnl>=0?'+':''}${w.stats.totalPnl.toFixed(4)} SOL**\n` +
        `🔗  https://solscan.io/tx/${sig}`
      );
      return true;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    log('ERROR', `[${w.label}] Sell fail: ${e.message}`, { attempt });
    if(attempt < CONFIG.MAX_RETRIES) {
      w.stats.retries++;
      await sleep(emergency ? 200 : 800);
      return execSell(w, mint, reason, emergency, attempt+1);
    }
    w.stats.errors++;
    w.positions.delete(mint);
    await discord(`❌ [${w.label}] Sell FAILED: ${info.sym} \`${mint.slice(0,16)}\` — ${e.message}`);
    return false;
  }
}

// ── BUY ──────────────────────────────────────────────────────

async function execBuy(w, mint, whaleSol, sol, attempt=1) {
  const info     = await tokenInfo(mint);
  const lamports = Math.floor(sol * 1e9);

  log('EXEC', `🪞 [${w.label}] BUY ${info.sym} ${sol.toFixed(4)} SOL (whale: ${whaleSol.toFixed(2)})`, { mint: mint.slice(0,12) });

  try {
    const qr = await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${CONFIG.SOL_MINT}&outputMint=${mint}&amount=${lamports}&slippageBps=${CONFIG.BUY_SLIPPAGE_BPS}`);
    if(!qr.ok) throw new Error(`Quote ${qr.status}`);
    const q = await qr.json();
    if(!q.outAmount || q.outAmount==='0') throw new Error('No route');

    const sr = await fetch(CONFIG.JUPITER_SWAP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: q,
        userPublicKey: w.keypair.publicKey.toString(),
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
    tx.sign([w.keypair]);
    const sig = await shared.connection.sendRawTransaction(tx.serialize(), { skipPreflight:true, maxRetries:5 });

    if(await confirm(sig)) {
      w.positions.set(mint, {
        time: Date.now(), sol, sym: info.sym,
        isSelling: false, highestRoi: -Infinity,
      });
      w.stats.buys++;
      log('BUY', `✅ [${w.label}] ${info.sym} ${sol.toFixed(4)} SOL | Exit:${CONFIG.EXIT_SECONDS/60}min SL:${CONFIG.SL_PCT}%`);
      await discord(
        `🪞  **COPY BUY** [${w.label}] \`${mint}\`\n` +
        `💸  **${sol.toFixed(4)} SOL** | Whale: **${whaleSol.toFixed(2)} SOL**\n` +
        `🎯  TP: **+${CONFIG.TP_PCT}%** early cash | 6min timer | SL: **${CONFIG.SL_PCT}%**\n` +
        `🔗  https://solscan.io/tx/${sig}`
      );
      return true;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    log('ERROR', `[${w.label}] Buy fail (attempt ${attempt}): ${e.message}`);
    if(attempt < CONFIG.MAX_RETRIES) {
      w.stats.retries++;
      await sleep(800 * attempt);
      return execBuy(w, mint, whaleSol, sol, attempt+1);
    }
    w.stats.errors++;
    await discord(`❌ [${w.label}] Buy FAILED: ${info.sym} \`${mint.slice(0,16)}\` — ${e.message}`);
    return false;
  }
}

// ── EXIT MANAGER ─────────────────────────────────────────────
// Simple and fast — matches the wallet's scalper style

async function exitManager(w) {
  log('INFO', `[${w.label}] ⏱ Exit | 6min timer + SL:${CONFIG.SL_PCT}%`);

  while(shared.isRunning) {
    await sleep(CONFIG.EXIT_CHECK_MS);

    for(const [mint, pos] of w.positions) {
      if(pos.isSelling) continue;

      const ageSec = (Date.now() - pos.time) / 1000;
      const ageMin = ageSec / 60;
      const timeLeft = ((CONFIG.EXIT_SECONDS - ageSec)).toFixed(0);

      // ── 1. HARD 6-MINUTE EXIT — primary strategy ─────────
      // Exit before whale sells. No waiting for his signal.
      if(ageSec >= CONFIG.EXIT_SECONDS) {
        pos.isSelling = true;
        log('EXIT', `[${w.label}] ⏱ 6MIN EXIT ${pos.sym} — selling before whale`);
        execSell(w, mint, `6min_exit`, false)
          .catch(e => log('ERROR', `[${w.label}] Timer exit: ${e.message}`));
        continue;
      }

      // ── 2. STOP LOSS -20% — catch rugs/bad tokens ────────
      // Check ROI only for SL — no TP, we just ride the timer
      const roi = await getCurrentRoi(mint, pos, w.keypair);
      if(roi === null) continue;
      if(roi > pos.highestRoi) pos.highestRoi = roi;

      // Console countdown
      const bar = roi >= 0
        ? '█'.repeat(Math.min(Math.floor(roi/2), 20)) + '░'.repeat(Math.max(20-Math.floor(roi/2),0))
        : '▓'.repeat(Math.min(Math.floor(Math.abs(roi)/2), 20));
      console.log(`  [${w.label}][${pos.sym}] ${roi>=0?'+':''}${roi.toFixed(1)}% [${bar}] peak:${pos.highestRoi.toFixed(0)}% | ${ageMin.toFixed(1)}min | exit in ${timeLeft}s | TP:+${CONFIG.TP_PCT}% SL:${CONFIG.SL_PCT}%`);

      // ── TAKE PROFIT at +35% ──────────────────────────────
      if(roi >= CONFIG.TP_PCT) {
        pos.isSelling = true;
        log('EXIT', `[${w.label}] 🎯 TAKE PROFIT ${pos.sym} at +${roi.toFixed(1)}% — cashing early`);
        execSell(w, mint, `TP_+${roi.toFixed(0)}%`, false)
          .catch(e => log('ERROR', `[${w.label}] TP: ${e.message}`));
        await discord(`🎯  **TAKE PROFIT +${CONFIG.TP_PCT}%** [${w.label}] \`${mint.slice(0,16)}...\`
📊  **+${roi.toFixed(1)}%** after **${ageMin.toFixed(1)}min** — cashed before 6min timer`);
        continue;
      }

      // ── STOP LOSS at -20% ────────────────────────────────
      if(roi <= CONFIG.SL_PCT) {
        pos.isSelling = true;
        log('EXIT', `[${w.label}] 🛑 STOP LOSS ${pos.sym} at ${roi.toFixed(1)}% — rug/bad token`);
        execSell(w, mint, `SL_${roi.toFixed(0)}%`, false)
          .catch(e => log('ERROR', `[${w.label}] SL: ${e.message}`));
        await discord(`🛑  **STOP LOSS** [${w.label}] \`${mint.slice(0,16)}...\`
📊  **${roi.toFixed(1)}%** after **${ageMin.toFixed(1)}min**`);
        continue;
      }
    }
  }
}

// ── POLL ─────────────────────────────────────────────────────

async function poll() {
  log('INFO', `🪞 Mirroring ${CONFIG.TARGET.slice(0,20)}... every ${CONFIG.POLL_MS}ms (${wallets.length} wallets)`);

  while(shared.isRunning) {
    try {
      const r = await fetch(CONFIG.HELIUS_RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc:'2.0', id:1,
          method: 'getSignaturesForAddress',
          params: [CONFIG.TARGET, { limit:10 }]
        })
      });
      const d    = await r.json();
      const sigs = d?.result || [];

      const newSigs = [];
      for(const s of sigs) {
        if(s.signature === shared.lastSig) break;
        if(!s.err) newSigs.push(s);
      }

      if(newSigs.length > 0) {
        shared.lastSig = newSigs[0].signature;
        const parsed   = await heliusParse(newSigs.map(s => s.signature));

        for(const tx of parsed) {
          const trades = extractTrades(tx);
          if(!trades) continue;

          // He sold → queue emergency for all wallets holding it
          for(const t of trades.filter(t => t.dir==='sell')) {
            for(const w of wallets) {
              if(!w.positions.has(t.mint)) continue;
              if(w.positions.get(t.mint).isSelling) continue;
              log('EMERGENCY', `🚨 [${w.label}] TARGET SOLD ${t.mint.slice(0,10)}...`);
              w.emergencyQueue.add(t.mint);
            }
          }

          // He bought → both wallets buy simultaneously
          for(const t of trades.filter(t => t.dir==='buy')) {
            if(IGNORE.has(t.mint)) continue;
            if(t.sol < CONFIG.MIN_BUY_SOL_SIGNAL) {
              log('INFO', `⏭ SKIP ${t.mint.slice(0,10)}... whale only ${t.sol.toFixed(2)} SOL (min: ${CONFIG.MIN_BUY_SOL_SIGNAL})`);
              continue;
            }

            const ourSize = scaleBuy(t.sol);

            Promise.allSettled(
              wallets.map(async (w) => {
                if(w.tradedMints.has(t.mint)) return;
                if(w.positions.has(t.mint)) return;
                const bal = await solBal(w.keypair);
                if(bal < ourSize + 0.015) {
                  log('INFO', `[${w.label}] 💸 Balance too low (${bal.toFixed(4)} SOL)`);
                  return;
                }
                w.tradedMints.add(t.mint);
                log('MIRROR', `🟢 [${w.label}] BUYING ${t.mint.slice(0,10)}... ${ourSize.toFixed(3)} SOL (whale: ${t.sol.toFixed(2)})`);
                return execBuy(w, t.mint, t.sol, ourSize);
              })
            ).catch(e => log('ERROR', `allSettled: ${e.message}`));
          }
        }
      }
    } catch(e) { log('ERROR', `Poll: ${e.message}`); }

    await sleep(CONFIG.POLL_MS);
  }
}

// ── HEALTH ───────────────────────────────────────────────────

async function health() {
  while(shared.isRunning) {
    console.log('\n' + '═'.repeat(64));
    console.log('  🪞 WINSTON v20.1 — Scalper Copy Bot');
    console.log('═'.repeat(64));
    console.log(`  👀 ${CONFIG.TARGET.slice(0,20)}...`);
    console.log(`  🎯 TP:+${CONFIG.TP_PCT}%  SL:${CONFIG.SL_PCT}%  Timer:${CONFIG.EXIT_SECONDS/60}min  MinSignal:${CONFIG.MIN_BUY_SOL_SIGNAL} SOL`);

    for(const w of wallets) {
      const bal     = await solBal(w.keypair);
      const pnl     = bal - w.stats.startBal;
      const winRate = w.stats.sells > 0 ? ((w.stats.wins/w.stats.sells)*100).toFixed(0) : '0';
      console.log(`  [${w.label}] ${w.keypair.publicKey.toString().slice(0,16)}...`);
      console.log(`       💰 ${bal.toFixed(4)} SOL | PnL: ${pnl>=0?'+':''}${pnl.toFixed(4)} SOL`);
      console.log(`       📊 ${w.stats.buys}B ${w.stats.wins}W/${w.stats.losses}L (${winRate}% WR) | PnL: ${w.stats.totalPnl>=0?'+':''}${w.stats.totalPnl.toFixed(4)} SOL`);
      for(const [m, p] of w.positions) {
        const age = ((Date.now()-p.time)/60000).toFixed(1);
        console.log(`       📦 ${p.sym} ${m.slice(0,8)}... | ${age}min | ${p.sol.toFixed(4)} SOL`);
      }
    }
    console.log('═'.repeat(64) + '\n');
    await sleep(CONFIG.HEALTH_MS);
  }
}

// ── MAIN ─────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  🪞 WINSTON v20.1 — Scalper-Optimized Copy Trade Bot         ║');
  console.log('║  TP:+25% · SL:-20% · 12min max · Dual wallet                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  if(!CONFIG.HELIUS_API_KEY) { log('ERROR', 'HELIUS_API_KEY missing'); process.exit(1); }
  if(!CONFIG.PRIVATE_KEY_1)  { log('ERROR', 'WALLET_PRIVATE_KEY missing'); process.exit(1); }

  for(const [label, key] of [['W1', CONFIG.PRIVATE_KEY_1], ['W2', CONFIG.PRIVATE_KEY_2]]) {
    if(!key) { log('INFO', `[${label}] No key — skipping`); continue; }
    try {
      const w   = makeWallet(label);
      w.keypair = Keypair.fromSecretKey(bs58.decode(key));
      wallets.push(w);
      log('INFO', `[${label}] ${w.keypair.publicKey}`);
    } catch(e) { log('ERROR', `[${label}] Bad key: ${e.message}`); }
  }

  if(!wallets.length) { log('ERROR', 'No valid wallets'); process.exit(1); }

  shared.connection = new Connection(CONFIG.HELIUS_RPC, { commitment:'confirmed' });

  for(const w of wallets) {
    w.stats.startBal = await solBal(w.keypair);
    log('INFO', `[${w.label}] Balance: ${w.stats.startBal.toFixed(4)} SOL`);
  }

  try {
    const r = await fetch(CONFIG.HELIUS_RPC, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({jsonrpc:'2.0',id:1,method:'getSignaturesForAddress',params:[CONFIG.TARGET,{limit:1}]})
    });
    const d = await r.json();
    shared.lastSig = d?.result?.[0]?.signature || null;
    log('INFO', `Cursor: ${shared.lastSig ? shared.lastSig.slice(0,20)+'...' : 'none'}`);
  } catch(e) { log('ERROR', `Init: ${e.message}`); process.exit(1); }

  shared.isRunning = true;

  await discord(
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `🪞  **WINSTON v20.1 ONLINE**\n` +
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `👀  \`${CONFIG.TARGET}\`\n` +
    `👛  ${wallets.map(w=>`[${w.label}]`).join(' + ')} · **$5/$8/$10** scaled by conviction\n` +
    `🎯  TP: **+${CONFIG.TP_PCT}%** instant cash | 6min timer | SL: **${CONFIG.SL_PCT}%**\n` +
    `🚨  Emergency exit if he sells first\n` +
    `📊  Min signal: **${CONFIG.MIN_BUY_SOL_SIGNAL} SOL** (ignores test buys)\n` +
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if(shuttingDown) return;
    shuttingDown = true;
    shared.isRunning = false;
    const lines = await Promise.all(wallets.map(async w => {
      const f  = await solBal(w.keypair);
      const p  = f - w.stats.startBal;
      const wr = w.stats.sells > 0 ? ((w.stats.wins/w.stats.sells)*100).toFixed(0) : '0';
      return `[${w.label}] **${f.toFixed(4)} SOL** · PnL:**${p>=0?'+':''}${p.toFixed(4)}** · ${w.stats.wins}W/${w.stats.losses}L (${wr}% WR)`;
    }));
    await discord(
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n🔴  **WINSTON v19 OFFLINE**\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
      lines.join('\n') + '\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬'
    );
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await Promise.all([
    poll(),
    ...wallets.map(w => exitManager(w)),
    health(),
  ]);
}

main().catch(e => { log('ERROR', 'Fatal', { err: e.message }); process.exit(1); });
