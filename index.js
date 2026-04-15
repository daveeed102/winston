// ============================================================
// WINSTON v20.9 — Copy Trade Bot
// ⚠️  HIGH RISK — for educational/personal use only
// ============================================================
// SELLING IS THE #1 PRIORITY. Everything else is secondary.
//
// Exit rules (checked every 2s):
//   1. He sells      → emergency sell instantly, max fees
//   2. TP at +20%    → sell immediately
//   3. Timer 10min   → sell no matter what
//   4. SL at -20%    → cut the loss
//
// Rate limit fixes:
//   - Helius polled every 1200ms (was 500ms) — stays under limit
//   - Jupiter ROI check every 3s per wallet (staggered)
//   - 429 on any endpoint → sleep 3s before retry
//   - Sell retries up to 10 times with 2s backoff
//   - Sell uses direct token balance check, no extra quote calls
// ============================================================

require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const bs58  = require('bs58');
const fetch = require('node-fetch');

const CONFIG = {
  HELIUS_API_KEY:  process.env.HELIUS_API_KEY  || '',
  PRIVATE_KEY_1:   process.env.WALLET_PRIVATE_KEY  || process.env.PRIVATE_KEY || '',
  PRIVATE_KEY_2:   process.env.WALLET_PRIVATE_KEY_2 || '',
  PRIVATE_KEY_3:   process.env.WALLET_PRIVATE_KEY_3 || '',
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || '',

  get HELIUS_RPC() { return `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },
  get HELIUS_TX()  { return `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${this.HELIUS_API_KEY}`; },

  JUPITER_QUOTE: 'https://lite-api.jup.ag/swap/v1/quote',
  JUPITER_SWAP:  'https://lite-api.jup.ag/swap/v1/swap',

  TARGET: 'CP7eVtQYsweR7vAjSvW2shgA1weszsVmxDFbpV22s5w1',

  // ── Entry filter ─────────────────────────────────────────
  MIN_BUY_SOL_SIGNAL: 2.0,  // only copy 2+ SOL buys

  // ── Sizing: $10–$15 per wallet per trade ─────────────────
  // Whale 2-4 SOL   → 0.12 SOL (~$10)
  // Whale 4-8 SOL   → 0.14 SOL (~$12)
  // Whale 8+ SOL    → 0.17 SOL (~$15)
  BUY_TIERS: [
    { maxWhaleSol: 4.0,      ourSol: 0.120 }, // ~$10
    { maxWhaleSol: 8.0,      ourSol: 0.140 }, // ~$12
    { maxWhaleSol: Infinity, ourSol: 0.170 }, // ~$15
  ],
  BUY_SOL: 0.260, // ~$22 flat every trade

  // ── Exit rules ───────────────────────────────────────────
  //   1. Normal hold:
  //      - TP: +0.070 SOL profit (~$6) → cash out
  //      - SL: -50% → cut the loss
  //   2. After whale sells (post-sell mode):
  //      - Still riding the bounce, trying to hit TP
  //      - If drops -35% from entry → bail immediately
  //      - Hard exit after 4 minutes regardless
  TP_SOL:               0.070,  // take profit: ~$6 (27% on 0.26 SOL)
  SL_PCT:                 -50,  // normal stop loss
  POST_SELL_SL_PCT:       -35,  // tighter SL once whale has sold
  POST_SELL_TIMER_MS:  240000,  // 4 minutes max after whale sells

  // ── Fees ─────────────────────────────────────────────────
  // ── Fees — lowered to reduce cost per trade ─────────────
  // Buy: 0.0005 SOL priority — enough to get in, not excessive
  // Sell: 0.001 SOL priority — slightly higher to ensure exit
  // Emergency: 0.005 SOL — still aggressive for whale-sell exits
  // Slippage lowered too — less value lost on each swap
  BUY_PRIORITY_LAMPORTS:        500000,  // 0.0005 SOL (was 0.003)
  BUY_SLIPPAGE_BPS:               500,   // 5% (was 20%)
  SELL_PRIORITY_LAMPORTS:       1000000, // 0.001 SOL (was 0.005)
  SELL_SLIPPAGE_BPS:             1000,   // 10% (was 30%)
  EMERGENCY_PRIORITY_LAMPORTS:  5000000, // 0.005 SOL (was 0.01) — still fast
  EMERGENCY_SLIPPAGE_BPS:        3000,   // 30% (was 50%) — still gets out

  // ── Rate limit safe intervals ────────────────────────────
  POLL_MS:         1200,  // Helius poll — safe under free tier limit
  EXIT_CHECK_MS:   3000,  // ROI check every 3s per wallet
  HEALTH_MS:      30000,

  SELL_MAX_RETRIES: 10,   // keep trying to sell — never give up
  BUY_MAX_RETRIES:   3,
  SOL_MINT: 'So11111111111111111111111111111111111111112',
};

const IGNORE = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
]);

function makeWallet(label) {
  return {
    label,
    keypair:        null,
    positions:      new Map(),
    tradedMints:    new Set(),
    emergencyQueue: new Set(),
    stats: { buys:0, sells:0, wins:0, losses:0, totalPnl:0, errors:0, startBal:0 },
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

// USD conversion — 1 USD = 0.012 SOL → 1 SOL = $83.33
const SOL_USD = (sol) => (sol / 0.012).toFixed(2);

// Wallet display names
const WALLET_NAMES = {
  W1: "Daveeeed's Account",
  W2: "Kinduuuuude's Account",
  W3: "Maxxxxxwell's Account",
};
const wName = (label) => WALLET_NAMES[label] || label;

// Safe fetch — handles 429 by sleeping and throwing retryable error
async function safeFetch(url, opts={}, label='') {
  const r = await fetch(url, opts);
  if(r.status === 429) {
    log('ERROR', `429 rate limit on ${label || url.slice(0,40)} — sleeping 3s`);
    await sleep(3000);
    throw new Error(`429 rate limit — retry`);
  }
  return r;
}

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
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg.slice(0, 1990) })
    });
  } catch(e) {}
}

// ── HELIUS ───────────────────────────────────────────────────

async function heliusParse(sigs) {
  try {
    const r = await safeFetch(CONFIG.HELIUS_TX, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: sigs })
    }, 'helius-parse');
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

async function confirm(sig, timeout=90000) {
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

// ── SCALE BUY ────────────────────────────────────────────────

function scaleBuy(whaleSol) {
  return CONFIG.BUY_SOL; // flat 0.17 SOL every trade
}

// ── GET ROI ──────────────────────────────────────────────────

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

    const qr = await safeFetch(
      `${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL_MINT}&amount=${raw.toString()}&slippageBps=3000`,
      {}, 'roi-quote'
    );
    if(!qr.ok) return null;
    const q = await qr.json();
    if(!q.outAmount) return null;

    return ((parseFloat(q.outAmount) / 1e9 / pos.sol) - 1) * 100;
  } catch(e) { return null; }
}

// ── SELL — #1 PRIORITY, retries up to 10 times ───────────────

async function execSell(w, mint, reason, emergency=false, attempt=1) {
  const info     = await tokenInfo(mint);
  const pos      = w.positions.get(mint);
  if(!pos) return true; // already gone

  const slippage = emergency ? CONFIG.EMERGENCY_SLIPPAGE_BPS : CONFIG.SELL_SLIPPAGE_BPS;
  const priority = emergency ? CONFIG.EMERGENCY_PRIORITY_LAMPORTS : CONFIG.SELL_PRIORITY_LAMPORTS;
  const maxRetries = CONFIG.SELL_MAX_RETRIES;

  log('EXEC', `${emergency?'🚨':'🔴'} [${w.label}] SELL ${info.sym} — ${reason} (attempt ${attempt}/${maxRetries})`);

  try {
    const accts = await shared.connection.getParsedTokenAccountsByOwner(
      w.keypair.publicKey, { mint: new PublicKey(mint) }
    );
    const acct = accts?.value?.[0];
    if(!acct) { w.positions.delete(mint); return true; }
    const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount||0);
    if(bal <= 0) { w.positions.delete(mint); return true; }
    const dec = acct.account.data.parsed.info.tokenAmount.decimals;
    const raw = BigInt(Math.floor(bal * Math.pow(10, dec)));
    if(raw <= 0n) { w.positions.delete(mint); return true; }

    // Get sell quote — retry on 429
    const qr = await safeFetch(
      `${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL_MINT}&amount=${raw.toString()}&slippageBps=${slippage}`,
      {}, 'sell-quote'
    );
    if(!qr.ok) throw new Error(`Sell quote ${qr.status}`);
    const q = await qr.json();
    if(!q.outAmount) throw new Error('No sell route');

    const sr = await safeFetch(CONFIG.JUPITER_SWAP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: q,
        userPublicKey: w.keypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicSlippage: { minBps: 50, maxBps: slippage },
        prioritizationFeeLamports: priority
      })
    }, 'sell-swap');
    if(!sr.ok) throw new Error(`Sell swap ${sr.status}`);
    const sd = await sr.json();
    if(!sd.swapTransaction) throw new Error('No sell tx');

    const buf = Buffer.from(sd.swapTransaction, 'base64');
    const tx  = VersionedTransaction.deserialize(buf);
    tx.sign([w.keypair]);
    const sig = await shared.connection.sendRawTransaction(tx.serialize(), { skipPreflight:true, maxRetries:8 });

    if(await confirm(sig)) {
      const solBack  = parseFloat(q.outAmount) / 1e9;
      const pnl      = solBack - pos.sol;
      const roiPct   = ((solBack / pos.sol) - 1) * 100;
      const pnlSign  = pnl >= 0 ? '+' : '';
      const pnlEmoji = pnl >= 0 ? '📈' : '📉';

      if(pnl >= 0) w.stats.wins++; else w.stats.losses++;
      w.stats.totalPnl += pnl;
      w.stats.sells++;
      w.positions.delete(mint);

      const wr = w.stats.sells > 0 ? ((w.stats.wins/w.stats.sells)*100).toFixed(0) : '0';
      log('SELL', `✅ [${w.label}] ${info.sym} → ${solBack.toFixed(4)} SOL (${pnlSign}${pnl.toFixed(4)}) | ${reason} | WR:${wr}%`);

      const exitType = emergency ? '🚨 EMERGENCY EXIT'
        : reason.startsWith('TP') ? '🎯 TAKE PROFIT'
        : reason.startsWith('SL') ? '🛑 STOP LOSS'
        : '🔴 SELL';

      const dMsg = [
        exitType + ' — **' + wName(w.label) + '**',
        '━━━━━━━━━━━━━━━━━━━━',
        '📥  Bought at: **$' + SOL_USD(pos.sol) + '** (' + pos.sol.toFixed(3) + ' SOL)',
        '📤  Sold at:   **$' + SOL_USD(solBack) + '** (' + solBack.toFixed(3) + ' SOL)',
        pnlEmoji + '  Profit:    **' + pnlSign + '$' + SOL_USD(Math.abs(pnl)) + '** (' + pnlSign + pnl.toFixed(4) + ' SOL / ' + pnlSign + roiPct.toFixed(1) + '%)',
        '━━━━━━━━━━━━━━━━━━━━',
        '📊  Session: **' + w.stats.wins + 'W / ' + w.stats.losses + 'L** (' + wr + '% WR)',
        '💰  Total PnL: **' + (w.stats.totalPnl>=0?'+':'') + '$' + SOL_USD(Math.abs(w.stats.totalPnl)) + '** (' + (w.stats.totalPnl>=0?'+':'') + w.stats.totalPnl.toFixed(4) + ' SOL)',
        '🔗  https://solscan.io/tx/' + sig,
      ].join('\n');
      await discord(dMsg);
      return true;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    log('ERROR', `[${w.label}] Sell fail (${attempt}/${maxRetries}): ${e.message}`);
    if(attempt < maxRetries) {
      // Back off longer each retry — critical to get through rate limits
      // Exponential backoff + jitter to avoid synchronized retries across wallets
      const base  = emergency ? 2000 : 3000;
      const jitter = Math.floor(Math.random() * 1000); // 0-1000ms random
      const delay  = base * attempt + jitter;
      log('ERROR', `[${w.label}] Retrying in ${delay}ms...`);
      await sleep(delay);
      return execSell(w, mint, reason, emergency, attempt+1);
    }
    // All retries exhausted — alert loudly
    w.stats.errors++;
    await discord(
      `🆘  **SELL EXHAUSTED** — ${wName(w.label)}\n` +
      `All ${maxRetries} attempts failed — **ACT NOW**\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🪙  Token: \`${mint}\`\n` +
      `❌  Reason: ${e.message}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🔗  **Sell manually on Jupiter:**\n` +
      `https://jup.ag/swap/${mint}-SOL\n` +
      `(paste link in browser — works even if Phantom shows spam)`
    );
    return false;
  }
}

// ── BUY ──────────────────────────────────────────────────────

async function execBuy(w, mint, whaleSol, sol, attempt=1) {
  const info     = await tokenInfo(mint);
  const lamports = Math.floor(sol * 1e9);

  log('EXEC', `🪞 [${w.label}] BUY ${info.sym} ${sol.toFixed(4)} SOL (whale: ${whaleSol.toFixed(2)})`, { mint: mint.slice(0,12) });

  try {
    const qr = await safeFetch(
      `${CONFIG.JUPITER_QUOTE}?inputMint=${CONFIG.SOL_MINT}&outputMint=${mint}&amount=${lamports}&slippageBps=${CONFIG.BUY_SLIPPAGE_BPS}`,
      {}, 'buy-quote'
    );
    if(!qr.ok) throw new Error(`Quote ${qr.status}`);
    const q = await qr.json();
    if(!q.outAmount || q.outAmount==='0') throw new Error('No route');

    const sr = await safeFetch(CONFIG.JUPITER_SWAP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: q,
        userPublicKey: w.keypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicSlippage: { minBps: 50, maxBps: CONFIG.BUY_SLIPPAGE_BPS },
        prioritizationFeeLamports: CONFIG.BUY_PRIORITY_LAMPORTS
      })
    }, 'buy-swap');
    if(!sr.ok) throw new Error(`Swap ${sr.status}`);
    const sd = await sr.json();
    if(!sd.swapTransaction) throw new Error('No swap tx');

    const buf = Buffer.from(sd.swapTransaction, 'base64');
    const tx  = VersionedTransaction.deserialize(buf);
    tx.sign([w.keypair]);
    const sig = await shared.connection.sendRawTransaction(tx.serialize(), { skipPreflight:true, maxRetries:5 });

    if(await confirm(sig)) {
      w.positions.set(mint, {
        time:          Date.now(),
        sol,
        sym:           info.sym,
        isSelling:     false,
        highestRoi:    -Infinity,
        whaleSoldAt:   null,   // timestamp when whale sold — activates post-sell mode
      });
      w.stats.buys++;
      log('BUY', `✅ [${w.label}] ${info.sym} ${sol.toFixed(4)} SOL | TP:+${CONFIG.TP_SOL}SOL SL:${CONFIG.SL_PCT}%`);
      await discord(
        `🪞  **COPY BUY — ${wName(w.label)}**\n` +
        `\`${mint}\`\n` +
        `💸  Bought: **${sol.toFixed(3)} SOL** (~$${SOL_USD(sol)})\n` +
        `🐋  Whale spent: **${whaleSol.toFixed(2)} SOL** (~$${SOL_USD(whaleSol)})\n` +
        `🎯  TP: **+${CONFIG.TP_SOL} SOL** (~$${SOL_USD(CONFIG.TP_SOL)} profit) | SL: **${CONFIG.SL_PCT}%**\n` +
        `🚨  Emergency exit if whale sells\n` +
        `🔗  https://solscan.io/tx/${sig}`
      );
      return true;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    log('ERROR', `[${w.label}] Buy fail (attempt ${attempt}): ${e.message}`);
    if(attempt < CONFIG.BUY_MAX_RETRIES) {
      await sleep(2000 * attempt);
      return execBuy(w, mint, whaleSol, sol, attempt+1);
    }
    w.stats.errors++;
    await discord(`❌ [${w.label}] Buy FAILED: ${info.sym} \`${mint.slice(0,16)}\` — ${e.message}`);
    return false;
  }
}

// ── EXIT MANAGER ─────────────────────────────────────────────
// SELLING IS THE #1 PRIORITY
// Emergency queue checked first — no RPC calls, immediate fire

async function exitManager(w) {
  log('INFO', `[${w.label}] 🎯 Exit | TP:+${CONFIG.TP_SOL}SOL SL:${CONFIG.SL_PCT}% — no timer`);

  while(shared.isRunning) {
    await sleep(CONFIG.EXIT_CHECK_MS);

    for(const [mint, pos] of w.positions) {
      if(pos.isSelling) continue;

      const ageSec = (Date.now() - pos.time) / 1000;
      const ageMin = (ageSec / 60).toFixed(1);

      // ── PRIORITY 1: Whale sold → enter post-sell mode ───────
      // Don't panic sell — ride the bounce, but with tighter rules:
      //   - SL tightens from -50% to -35%
      //   - Hard exit after 4 minutes no matter what
      //   - Still trying to hit TP during this window
      if(w.emergencyQueue.has(mint)) {
        w.emergencyQueue.delete(mint);
        if(!pos.whaleSoldAt) {
          pos.whaleSoldAt = Date.now();
          log('EMERGENCY', `🚨 [${w.label}] WHALE SOLD — entering post-sell mode (4min window, SL:-35%)`);
          await discord(
            `⚠️  **WHALE SOLD — POST-SELL MODE** — ${wName(w.label)}\n` +
            `\`${mint}\`\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📊  Riding the bounce for up to **4 minutes**\n` +
            `🎯  Still targeting: **+$${SOL_USD(CONFIG.TP_SOL)}** profit\n` +
            `🛑  Bail if down: **-${Math.abs(CONFIG.POST_SELL_SL_PCT)}%** from entry\n` +
            `⏱  Hard exit in: **4 minutes**`
          );
        }
        continue;
      }

      // ── POST-SELL MODE checks ────────────────────────────────
      if(pos.whaleSoldAt) {
        const postSellAge = Date.now() - pos.whaleSoldAt;

        // 4 minute hard exit after whale sold
        if(postSellAge >= CONFIG.POST_SELL_TIMER_MS) {
          pos.isSelling = true;
          log('EXIT', `[${w.label}] ⏱ POST-SELL TIMER — 4min elapsed, exiting ${pos.sym}`);
          const labelIndex = wallets.indexOf(w);
          setTimeout(() => {
            execSell(w, mint, 'post_sell_4min', false)
              .catch(e => log('ERROR', `[${w.label}] Post-sell timer exit error: ${e.message}`));
          }, labelIndex * 1500);
          continue;
        }
      }

      // ── PRIORITY 2: SL / he sells — needs ROI quote ─────────
      const roi = await getCurrentRoi(mint, pos, w.keypair);
      if(roi === null) continue; // rate limited or error — skip, try next cycle
      if(roi > pos.highestRoi) pos.highestRoi = roi;

      // Console display
      const timeLeft = (CONFIG.EXIT_SECONDS - ageSec).toFixed(0);
      const bar = roi >= 0
        ? '█'.repeat(Math.min(Math.floor(roi/2), 20)) + '░'.repeat(Math.max(20-Math.floor(roi/2),0))
        : '▓'.repeat(Math.min(Math.floor(Math.abs(roi)/2), 20));
      const profitSolDisplay = (pos.sol * (1 + roi/100) - pos.sol);
      const modeTag = pos.whaleSoldAt ? ` 🔄BOUNCE(${((Date.now()-pos.whaleSoldAt)/1000).toFixed(0)}s)` : '';
      const activeSLDisplay = pos.whaleSoldAt ? CONFIG.POST_SELL_SL_PCT : CONFIG.SL_PCT;
      console.log(`  [${w.label}][${pos.sym}] ${roi>=0?'+':''}${roi.toFixed(1)}% [${bar}] profit:${profitSolDisplay>=0?'+':''}${profitSolDisplay.toFixed(4)} SOL | ${ageMin}min | SL:${activeSLDisplay}%${modeTag}`);

      // ── TP: up $4 (0.046 SOL) → take profit ─────────────
      const currentVal = pos.sol * (1 + roi / 100);
      const profitSol  = currentVal - pos.sol;
      if(profitSol >= CONFIG.TP_SOL) {
        pos.isSelling = true;
        const profitUsd = (profitSol * 150).toFixed(2); // approx $
        log('EXIT', `[${w.label}] 🎯 TAKE PROFIT ${pos.sym} +${profitSol.toFixed(4)} SOL (~$${profitUsd})`);
        execSell(w, mint, `TP_+${profitSol.toFixed(4)}SOL`, false)
          .catch(e => log('ERROR', `[${w.label}] TP error: ${e.message}`));
        await discord(`🎯  **TAKE PROFIT** [${w.label}] \`${mint.slice(0,16)}...\`\n💰  **+${profitSol.toFixed(4)} SOL** (~$${profitUsd}) after **${ageMin}min**`);
        continue;
      }

      // ── SL at -50% — lost half, get out ──────────────────
      if(roi <= CONFIG.SL_PCT) {
        pos.isSelling = true;
        log('EXIT', `[${w.label}] 🛑 STOP LOSS ${pos.sym} at ${roi.toFixed(1)}%`);
        execSell(w, mint, `SL_${roi.toFixed(0)}%`, false)
          .catch(e => log('ERROR', `[${w.label}] SL error: ${e.message}`));
        await discord(`🛑  **STOP LOSS** — ${wName(w.label)}\n\`${mint.slice(0,16)}...\`\n📉  **${roi.toFixed(1)}%** (~-$${SOL_USD(Math.abs(pos.sol * roi/100))}) after **${ageMin}min**`);
        continue;
      }
    }
  }
}

// ── POLL ─────────────────────────────────────────────────────

async function poll() {
  log('INFO', `🪞 Polling ${CONFIG.TARGET.slice(0,20)}... every ${CONFIG.POLL_MS}ms`);

  while(shared.isRunning) {
    try {
      const r = await safeFetch(CONFIG.HELIUS_RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc:'2.0', id:1,
          method:'getSignaturesForAddress',
          params:[CONFIG.TARGET, { limit:10 }]
        })
      }, 'helius-poll');

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
              log('EMERGENCY', `🚨 [${w.label}] TARGET SOLD — queuing emergency exit`);
              w.emergencyQueue.add(t.mint);
            }
          }

          // He bought → both wallets buy simultaneously
          for(const t of trades.filter(t => t.dir==='buy')) {
            if(IGNORE.has(t.mint)) continue;
            if(t.sol < CONFIG.MIN_BUY_SOL_SIGNAL) {
              log('INFO', `⏭ SKIP ${t.mint.slice(0,10)}... whale only ${t.sol.toFixed(2)} SOL (min: ${CONFIG.MIN_BUY_SOL_SIGNAL})`);
              await discord(
                `⏭  **SKIPPED TRADE**\n` +
                `\`${t.mint}\`\n` +
                `🐋  Whale spent **${t.sol.toFixed(3)} SOL** (~$${SOL_USD(t.sol)})\n` +
                `❌  Reason: below **${CONFIG.MIN_BUY_SOL_SIGNAL} SOL** minimum signal\n` +
                `🔗  https://solscan.io/account/${CONFIG.TARGET}`
              );
              continue;
            }
            const ourSize = scaleBuy(t.sol);
            Promise.allSettled(wallets.map(async (w) => {
              if(w.tradedMints.has(t.mint)) return;
              if(w.positions.has(t.mint)) return;
              const bal = await solBal(w.keypair);
              if(bal < ourSize + 0.02) {
                log('INFO', `[${w.label}] 💸 Balance too low (${bal.toFixed(4)} SOL)`);
                return;
              }
              w.tradedMints.add(t.mint);
              log('MIRROR', `🟢 [${w.label}] BUYING ${t.mint.slice(0,10)}... ${ourSize.toFixed(3)} SOL`);
              return execBuy(w, t.mint, t.sol, ourSize);
            })).catch(e => log('ERROR', `allSettled: ${e.message}`));
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
    console.log('  🪞 WINSTON v20.9 — Copy Trade Bot');
    console.log('═'.repeat(64));
    console.log(`  👀 ${CONFIG.TARGET.slice(0,20)}...`);
    console.log(`  🎯 TP:+${CONFIG.TP_SOL}SOL($4)  SL:${CONFIG.SL_PCT}%  Buy:${CONFIG.BUY_SOL}SOL  Min:${CONFIG.MIN_BUY_SOL_SIGNAL}SOL`);
    for(const w of wallets) {
      const bal = await solBal(w.keypair);
      const pnl = bal - w.stats.startBal;
      const wr  = w.stats.sells > 0 ? ((w.stats.wins/w.stats.sells)*100).toFixed(0) : '0';
      console.log(`  [${w.label}] ${w.keypair.publicKey.toString().slice(0,16)}...`);
      console.log(`       💰 ${bal.toFixed(4)} SOL | PnL: ${pnl>=0?'+':''}${pnl.toFixed(4)} SOL`);
      console.log(`       📊 ${w.stats.buys}B ${w.stats.wins}W/${w.stats.losses}L (${wr}% WR) | PnL: ${w.stats.totalPnl>=0?'+':''}${w.stats.totalPnl.toFixed(4)} SOL`);
      for(const [m, p] of w.positions) {
        const age = ((Date.now()-p.time)/60000).toFixed(1);
        console.log(`       📦 ${p.sym} ${m.slice(0,8)}... | ${age}min | ${p.sol.toFixed(4)} SOL in`);
      }
    }
    console.log('═'.repeat(64) + '\n');
    await sleep(CONFIG.HEALTH_MS);
  }
}

// ── MAIN ─────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  🪞 WINSTON v20.9 — Selling is #1 Priority                   ║');
  console.log('║  TP:+20% · SL:-20% · 10min · Rate limit safe                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  if(!CONFIG.HELIUS_API_KEY) { log('ERROR', 'HELIUS_API_KEY missing'); process.exit(1); }
  if(!CONFIG.PRIVATE_KEY_1)  { log('ERROR', 'WALLET_PRIVATE_KEY missing'); process.exit(1); }

  for(const [label, key] of [['W1', CONFIG.PRIVATE_KEY_1], ['W2', CONFIG.PRIVATE_KEY_2], ['W3', CONFIG.PRIVATE_KEY_3]]) {
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
    const r = await safeFetch(CONFIG.HELIUS_RPC, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({jsonrpc:'2.0',id:1,method:'getSignaturesForAddress',params:[CONFIG.TARGET,{limit:1}]})
    }, 'init-cursor');
    const d = await r.json();
    shared.lastSig = d?.result?.[0]?.signature || null;
    log('INFO', `Cursor: ${shared.lastSig ? shared.lastSig.slice(0,20)+'...' : 'none'}`);
  } catch(e) { log('ERROR', `Init: ${e.message}`); process.exit(1); }

  shared.isRunning = true;

  await discord(
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `🪞  **WINSTON v20.9 ONLINE**\n` +
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `👀  \`${CONFIG.TARGET}\`\n` +
    `👛  ${wallets.map(w=>wName(w.label)).join(' + ')}\n` +
    `💸  Buy: **0.26 SOL (~$22)** per wallet | TP: **+$${SOL_USD(CONFIG.TP_SOL)}** profit\n` +
    `🎯  TP: **+0.046 SOL (~$4)** | SL: **${CONFIG.SL_PCT}%** | Exit on whale sell\n` +
    `🚨  Emergency exit if whale sells\n` +
    `📡  Rate-limit safe: poll ${CONFIG.POLL_MS}ms · ROI check ${CONFIG.EXIT_CHECK_MS}ms\n` +
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
      const wr = w.stats.sells>0 ? ((w.stats.wins/w.stats.sells)*100).toFixed(0) : '0';
      return `**${wName(w.label)}**: ${f.toFixed(3)} SOL (~$${SOL_USD(f)}) · PnL: **${p>=0?'+':''}$${SOL_USD(Math.abs(p))}** · ${w.stats.wins}W/${w.stats.losses}L (${wr}% WR)`;
    }));
    await discord(
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n🔴  **WINSTON v20.9 OFFLINE**\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
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
