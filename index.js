// ============================================================
// WINSTON v24.0 — Copy Trade Bot
// ⚠️  HIGH RISK — for educational/personal use only
// ============================================================
// Target: 57ZJXaG4Y4CFzCNym2W3PzKSKYaayhijtTrR7TKB26x9
// Signal: Only copy buys of 0.9–3.0 SOL from target wallet
// Buy size: 0.026 SOL (~$2.50) — never increases
//
// Strategy:
//   1. Target buys 0.9–3.0 SOL → we buy 0.026 SOL immediately
//   2. Price up +30–50% → sell 75%, keep 25% as moonbag
//   3. Moonbag = pure profit tokens, rides indefinitely
//   4. Moonbag only exits on:
//        a) Hard dump: drops -40% FROM moonbag-entry price
//        b) Moon target: +200% from original entry
//        c) Manual: target sells while moonbag active (optional)
//   5. 10min timer ONLY applies if TP never fired (no profit)
//      → if no TP in 10min, exit full position
//   6. SL at -35% before TP fires → full exit
//   7. No-chase: if target already sold before our fill → exit
//
// Fee safety:
//   - Low priority fees — small buys can't absorb high fees
//   - Pre-flight fee check: skip if fees > 15% of trade value
//   - Min balance: 0.026 + 0.005 SOL buffer
//   - Conservative slippage
//
// Single wallet — WALLET_PRIVATE_KEY only
// ============================================================

require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const bs58  = require('bs58');
const fetch = require('node-fetch');

const CONFIG = {
  HELIUS_API_KEY:  process.env.HELIUS_API_KEY || '',
  PRIVATE_KEY:     process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || '',
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || '',

  get HELIUS_RPC() { return `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },
  get HELIUS_TX()  { return `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${this.HELIUS_API_KEY}`; },

  JUPITER_QUOTE: 'https://lite-api.jup.ag/swap/v1/quote',
  JUPITER_SWAP:  'https://lite-api.jup.ag/swap/v1/swap',

  // ── Target ───────────────────────────────────────────────
  TARGET: '57ZJXaG4Y4CFzCNym2W3PzKSKYaayhijtTrR7TKB26x9',

  // ── Signal filter ────────────────────────────────────────
  MIN_BUY_SOL_SIGNAL: 0.9,
  MAX_BUY_SOL_SIGNAL: 3.0,

  // ── Buy size — NEVER changes ──────────────────────────────
  BUY_SOL: 0.026,

  // ── Fee safety ───────────────────────────────────────────
  MIN_SOL_BALANCE:        0.031,   // 0.026 buy + 0.005 fee buffer
  MAX_FEE_PCT_OF_TRADE:   15,      // skip if total fees > 15% of trade value
  BUY_PRIORITY_LAMPORTS:  200000,  // 0.0002 SOL — low intentionally
  BUY_SLIPPAGE_BPS:        300,    // 3%
  SELL_PRIORITY_LAMPORTS:  300000, // 0.0003 SOL
  SELL_SLIPPAGE_BPS:        500,   // 5%
  EMERGENCY_PRIORITY_LAMPORTS: 1000000, // 0.001 SOL
  EMERGENCY_SLIPPAGE_BPS:  2000,   // 20%

  // ── Exit strategy ────────────────────────────────────────
  // Phase 1 — Main position (before TP):
  //   TP fires between +30% and +50% (we target +35% as trigger)
  //   → sell 75% at TP, keep 25% as moonbag
  //   SL at -35% → full exit, no moonbag
  //   10min timer ONLY if TP never fired → full exit
  //
  // Phase 2 — Moonbag (25% remaining, pure profit):
  //   NO time limit — rides until one of:
  //     a) Dump: -40% from the price AT moonbag entry
  //     b) Moon: +200% from original entry (take the win)
  //     c) Target sells while moonbag active → optional exit
  //   Moonbag SL is measured from moonbagEntryRoi (not entry)
  TP_ROI_PCT:           37,    // take profit trigger: +35–40% range, set at 37%
  TP_FULL_EXIT_PCT:     50,    // if +50% before TP executes → sell 100% immediately
  TP_SELL_FRACTION:     0.75,  // sell 75% at TP, keep 25% moonbag
  SL_PCT:              -35,   // stop loss: -30% to -40% range, set at -35%
  MOONBAG_DUMP_PCT:    -40,   // moonbag SL: -40% DROP from moonbag-entry price
  MOONBAG_MOON_PCT:    300,   // moonbag moon exit: +300% from original entry

  // ── No-chase check ───────────────────────────────────────
  NO_CHASE_CHECK_DELAY_MS: 8000,

  // ── Rate limits ──────────────────────────────────────────
  POLL_MS:       1200,
  EXIT_CHECK_MS: 3000,
  HEALTH_MS:     30000,

  SELL_MAX_RETRIES: 10,
  BUY_MAX_RETRIES:   3,
  SOL_MINT: 'So11111111111111111111111111111111111111112',
};

const IGNORE = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  // USDT
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
]);

// ── Single wallet state ───────────────────────────────────────
const wallet = {
  keypair:        null,
  positions:      new Map(),
  tradedMints:    new Set(),
  emergencyQueue: new Set(),
  stats: {
    buys: 0, sells: 0, wins: 0, losses: 0,
    totalPnl: 0, errors: 0, startBal: 0,
    skipped: 0, feesTotal: 0,
  },
};

const shared = { connection: null, isRunning: false, lastSig: null };

// ── UTILS ─────────────────────────────────────────────────────

function log(lv, msg, d={}) {
  const ts = new Date().toISOString();
  const ic = {
    INFO:'📡', BUY:'🟢', SELL:'🔴', EXEC:'⚡', ERROR:'❌',
    MIRROR:'🪞', EXIT:'🎯', EMERGENCY:'🚨', MOONBAG:'🌙',
    SKIP:'⏭', FEE:'💸',
  };
  console.log(`[${ts}] ${ic[lv]||'📋'} [${lv}] ${msg}${Object.keys(d).length?' '+JSON.stringify(d):''}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SOL_PRICE_USD = 96;
const SOL_USD       = (sol) => (sol * SOL_PRICE_USD).toFixed(2);
const pctStr        = (n)   => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

const PROFIT_GIFS = [
  'https://media.tenor.com/LxMBBtB7SWIAAAAC/lets-go-kevin-hart.gif',
  'https://media.tenor.com/7PMPpHm3tnsAAAAC/money-cash.gif',
  'https://media.tenor.com/g1jMbTKW_LEAAAAC/hell-yeah-yes.gif',
  'https://media.tenor.com/OVcRpMBMOdAAAAAC/spongebob-money.gif',
  'https://media.tenor.com/GfxAlL4YPRYAAAAC/make-it-rain-money.gif',
  'https://media.tenor.com/NHlHGCeHgkoAAAAC/wolf-of-wall-street-money.gif',
  'https://media.tenor.com/vxSLMNJoJlgAAAAC/yes-hell-yeah.gif',
];
const randomGif = () => PROFIT_GIFS[Math.floor(Math.random() * PROFIT_GIFS.length)];

async function safeFetch(url, opts={}, label='') {
  const r = await fetch(url, opts);
  if(r.status === 429) {
    log('ERROR', `429 on ${label || url.slice(0,40)} — sleeping 3s`);
    await sleep(3000);
    throw new Error('429 rate limit — retry');
  }
  return r;
}

async function solBal(keypair) {
  try { return (await shared.connection.getBalance(keypair.publicKey)) / 1e9; }
  catch(e) { return 0; }
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
      body: JSON.stringify({ content: msg.slice(0, 1990) }),
    });
  } catch(e) {}
}

// ── FEE SAFETY CHECK ──────────────────────────────────────────
// Estimates total round-trip fee cost and rejects if > 15% of trade

function estimateFeePct() {
  const buyFee  = CONFIG.BUY_PRIORITY_LAMPORTS  / 1e9; // SOL
  const sellFee = CONFIG.SELL_PRIORITY_LAMPORTS / 1e9;
  const totalFees = buyFee + sellFee;
  return (totalFees / CONFIG.BUY_SOL) * 100;
}

// ── HELIUS ────────────────────────────────────────────────────

async function heliusParse(sigs) {
  try {
    const r = await safeFetch(CONFIG.HELIUS_TX, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: sigs }),
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

// ── TARGET HOLDS CHECK ────────────────────────────────────────

async function targetStillHolds(mint) {
  try {
    const accts = await shared.connection.getParsedTokenAccountsByOwner(
      new PublicKey(CONFIG.TARGET), { mint: new PublicKey(mint) }
    );
    const acct = accts?.value?.[0];
    if(!acct) return false;
    return parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount || 0) > 0;
  } catch(e) { return true; } // assume holds on error — safer
}

// ── CONFIRM TX ────────────────────────────────────────────────

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

// ── GET ROI ───────────────────────────────────────────────────
// Returns ROI% based on original full buy cost (pos.sol)
// Works in both main and moonbag phase

async function getCurrentRoi(mint, pos) {
  try {
    const accts = await shared.connection.getParsedTokenAccountsByOwner(
      wallet.keypair.publicKey, { mint: new PublicKey(mint) }
    );
    const acct = accts?.value?.[0];
    if(!acct) return null;
    const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount||0);
    if(bal <= 0) return null;
    const dec = acct.account.data.parsed.info.tokenAmount.decimals;
    const raw = BigInt(Math.floor(bal * Math.pow(10, dec)));

    const qr = await safeFetch(
      `${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL_MINT}&amount=${raw.toString()}&slippageBps=1000`,
      {}, 'roi-quote'
    );
    if(!qr.ok) return null;
    const q = await qr.json();
    if(!q.outAmount) return null;
    // ROI vs original full buy — consistent across both phases
    return ((parseFloat(q.outAmount) / 1e9 / pos.sol) - 1) * 100;
  } catch(e) { return null; }
}

// ── FULL SELL ─────────────────────────────────────────────────

async function execSell(mint, reason, emergency=false, attempt=1) {
  const info     = await tokenInfo(mint);
  const pos      = wallet.positions.get(mint);
  if(!pos) return true;

  const slippage   = emergency ? CONFIG.EMERGENCY_SLIPPAGE_BPS : CONFIG.SELL_SLIPPAGE_BPS;
  const priority   = emergency ? CONFIG.EMERGENCY_PRIORITY_LAMPORTS : CONFIG.SELL_PRIORITY_LAMPORTS;
  const maxRetries = CONFIG.SELL_MAX_RETRIES;
  const feeSol     = priority / 1e9;

  log('EXEC', `${emergency?'🚨':'🔴'} SELL ${info.sym} — ${reason} (attempt ${attempt}/${maxRetries})`);

  try {
    const accts = await shared.connection.getParsedTokenAccountsByOwner(
      wallet.keypair.publicKey, { mint: new PublicKey(mint) }
    );
    const acct = accts?.value?.[0];
    if(!acct) { wallet.positions.delete(mint); return true; }
    const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount||0);
    if(bal <= 0) { wallet.positions.delete(mint); return true; }
    const dec = acct.account.data.parsed.info.tokenAmount.decimals;
    const raw = BigInt(Math.floor(bal * Math.pow(10, dec)));
    if(raw <= 0n) { wallet.positions.delete(mint); return true; }

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
        userPublicKey: wallet.keypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicSlippage: { minBps: 50, maxBps: slippage },
        prioritizationFeeLamports: priority,
      }),
    }, 'sell-swap');
    if(!sr.ok) throw new Error(`Sell swap ${sr.status}`);
    const sd = await sr.json();
    if(!sd.swapTransaction) throw new Error('No sell tx');

    const buf = Buffer.from(sd.swapTransaction, 'base64');
    const tx  = VersionedTransaction.deserialize(buf);
    tx.sign([wallet.keypair]);
    const sig = await shared.connection.sendRawTransaction(tx.serialize(), { skipPreflight:true, maxRetries:8 });

    if(await confirm(sig)) {
      const solBack  = parseFloat(q.outAmount) / 1e9;
      const pnl      = solBack - pos.sol;
      const roiPct   = ((solBack / pos.sol) - 1) * 100;
      const pnlSign  = pnl >= 0 ? '+' : '';
      const pnlEmoji = pnl >= 0 ? '📈' : '📉';

      wallet.stats.feesTotal += feeSol;
      if(pnl >= 0) wallet.stats.wins++; else wallet.stats.losses++;
      wallet.stats.totalPnl += pnl;
      wallet.stats.sells++;
      wallet.positions.delete(mint);

      const wr = wallet.stats.sells > 0 ? ((wallet.stats.wins/wallet.stats.sells)*100).toFixed(0) : '0';
      log('SELL', `✅ ${pos.moonbagMode?'🌙 MOONBAG ':''}${info.sym} → ${solBack.toFixed(4)} SOL (${pnlSign}${pnl.toFixed(4)}) | ${reason} | WR:${wr}%`);

      const exitLabel =
          reason.startsWith('no_chase')          ? '🚫 NO-CHASE EXIT'
        : reason.startsWith('SL')                ? '🛑 STOP LOSS'
        : reason.startsWith('moonbag_dump')      ? '🌙🛑 MOONBAG DUMP SL'
        : reason.startsWith('moonbag_moon')      ? '🌙🚀 MOONBAG MOON EXIT'
        : reason.startsWith('moonbag_target_sold')? '🌙🚨 MOONBAG TARGET SOLD'
        : reason.startsWith('target_sold')        ? '🚨 TARGET SOLD'
        : reason.startsWith('no_tp_timeout')      ? '⏱ NO-PROFIT TIMEOUT'
        : '🔴 SELL';

      const dMsg = [
        `${exitLabel} — **${info.sym}**`,
        '━━━━━━━━━━━━━━━━━━━━',
        `📥  Entry:   **$${SOL_USD(pos.sol)}** (${pos.sol.toFixed(4)} SOL)`,
        `📤  Exit:    **$${SOL_USD(solBack)}** (${solBack.toFixed(4)} SOL)`,
        `${pnlEmoji}  PnL:     **${pnlSign}$${SOL_USD(Math.abs(pnl))}** (${pnlSign}${pnl.toFixed(4)} SOL / ${pctStr(roiPct)})`,
        `💸  Fees:    ~$${SOL_USD(feeSol)} (${feeSol.toFixed(4)} SOL)`,
        '━━━━━━━━━━━━━━━━━━━━',
        `📊  Session: **${wallet.stats.wins}W / ${wallet.stats.losses}L** (${wr}% WR)`,
        `💰  Total PnL: **${wallet.stats.totalPnl>=0?'+':''}$${SOL_USD(Math.abs(wallet.stats.totalPnl))}** (${wallet.stats.totalPnl>=0?'+':''}${wallet.stats.totalPnl.toFixed(4)} SOL)`,
        `🔗  https://solscan.io/tx/${sig}`,
      ];
      if(pnl > 0) dMsg.push(randomGif());
      await discord(dMsg.join('\n'));
      return true;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    log('ERROR', `Sell fail (${attempt}/${maxRetries}): ${e.message}`);
    if(attempt < maxRetries) {
      const jitter = Math.floor(Math.random() * 1000);
      await sleep((emergency ? 2000 : 3000) * attempt + jitter);
      return execSell(mint, reason, emergency, attempt+1);
    }
    wallet.stats.errors++;
    await discord(
      `🆘  **SELL EXHAUSTED — ${info.sym}**\n` +
      `All ${maxRetries} retries failed — **SELL MANUALLY NOW**\n` +
      `🔗  https://jup.ag/swap/${mint}-SOL`
    );
    return false;
  }
}

// ── PARTIAL SELL → 75%, moonbag remaining 25% ────────────────

async function execPartialSell(mint, fraction, currentRoi, attempt=1) {
  const info     = await tokenInfo(mint);
  const pos      = wallet.positions.get(mint);
  if(!pos) return false;

  const maxRetries = CONFIG.SELL_MAX_RETRIES;
  const feeSol     = CONFIG.SELL_PRIORITY_LAMPORTS / 1e9;
  log('EXEC', `🎯 PARTIAL SELL ${(fraction*100).toFixed(0)}% ${info.sym} at ${pctStr(currentRoi)} (attempt ${attempt})`);

  try {
    const accts = await shared.connection.getParsedTokenAccountsByOwner(
      wallet.keypair.publicKey, { mint: new PublicKey(mint) }
    );
    const acct = accts?.value?.[0];
    if(!acct) return false;
    const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount||0);
    if(bal <= 0) return false;
    const dec = acct.account.data.parsed.info.tokenAmount.decimals;
    const raw = BigInt(Math.floor(bal * fraction * Math.pow(10, dec)));
    if(raw <= 0n) return false;

    const qr = await safeFetch(
      `${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL_MINT}&amount=${raw.toString()}&slippageBps=${CONFIG.SELL_SLIPPAGE_BPS}`,
      {}, 'partial-sell-quote'
    );
    if(!qr.ok) throw new Error(`Quote ${qr.status}`);
    const q = await qr.json();
    if(!q.outAmount) throw new Error('No sell route');

    const sr = await safeFetch(CONFIG.JUPITER_SWAP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: q,
        userPublicKey: wallet.keypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicSlippage: { minBps: 50, maxBps: CONFIG.SELL_SLIPPAGE_BPS },
        prioritizationFeeLamports: CONFIG.SELL_PRIORITY_LAMPORTS,
      }),
    }, 'partial-sell-swap');
    if(!sr.ok) throw new Error(`Swap ${sr.status}`);
    const sd = await sr.json();
    if(!sd.swapTransaction) throw new Error('No sell tx');

    const buf = Buffer.from(sd.swapTransaction, 'base64');
    const tx  = VersionedTransaction.deserialize(buf);
    tx.sign([wallet.keypair]);
    const sig = await shared.connection.sendRawTransaction(tx.serialize(), { skipPreflight:true, maxRetries:8 });

    if(await confirm(sig)) {
      const solBack   = parseFloat(q.outAmount) / 1e9;
      const costBasis = pos.sol * fraction;
      const pnl       = solBack - costBasis;
      const pnlSign   = pnl >= 0 ? '+' : '';

      wallet.stats.totalPnl += pnl;
      wallet.stats.feesTotal += feeSol;
      wallet.stats.sells++;
      if(pnl >= 0) wallet.stats.wins++;

      // Transition to moonbag — record ROI at this moment as moonbag entry
      pos.moonbagMode      = true;
      pos.moonbagStartMs   = Date.now();
      pos.moonbagEntryRoi  = currentRoi; // ROI when TP fired — moonbag dump SL is relative to this
      pos.tpFired          = true;

      log('MOONBAG', `✅ TP @ ${pctStr(currentRoi)} — sold ${(fraction*100).toFixed(0)}% → ${solBack.toFixed(4)} SOL (${pnlSign}${pnl.toFixed(4)}) | 🌙 moonbag riding FREE, no time limit`);

      await discord(
        `🎯  **TAKE PROFIT — ${info.sym}**\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💰  Sold **${(fraction*100).toFixed(0)}%** → **$${SOL_USD(solBack)}** (${solBack.toFixed(4)} SOL)\n` +
        `📈  Profit chunk: **${pnlSign}$${SOL_USD(Math.abs(pnl))}** (${pnlSign}${pnl.toFixed(4)} SOL)\n` +
        `💸  Fee: ~$${SOL_USD(feeSol)}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🌙  **MOONBAG ON** — 25% riding FREE (no time limit)\n` +
        `🛑  Dump SL: **-40%** from here | 🚀 Moon exit: **+200%** from entry\n` +
        `⚠️  Only exits on hard dump, moon target, or target sells\n` +
        `🔗  https://solscan.io/tx/${sig}\n` +
        randomGif()
      );
      return true;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    log('ERROR', `Partial sell fail (${attempt}/${maxRetries}): ${e.message}`);
    if(attempt < maxRetries) {
      await sleep(2000 * attempt + Math.floor(Math.random() * 500));
      return execPartialSell(mint, fraction, currentRoi, attempt+1);
    }
    wallet.stats.errors++;
    await discord(`❌  Partial sell FAILED: ${info.sym} — ${e.message}\nTrying full sell as fallback...\n🔗  https://jup.ag/swap/${mint}-SOL`);
    return false;
  }
}

// ── BUY ───────────────────────────────────────────────────────

async function execBuy(mint, whaleSol, attempt=1) {
  const info     = await tokenInfo(mint);
  const sol      = CONFIG.BUY_SOL;
  const lamports = Math.floor(sol * 1e9);
  const feeSol   = CONFIG.BUY_PRIORITY_LAMPORTS / 1e9;

  log('EXEC', `🪞 BUY ${info.sym} ${sol.toFixed(4)} SOL (target: ${whaleSol.toFixed(3)} SOL)`, { mint: mint.slice(0,12) });

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
        userPublicKey: wallet.keypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicSlippage: { minBps: 50, maxBps: CONFIG.BUY_SLIPPAGE_BPS },
        prioritizationFeeLamports: CONFIG.BUY_PRIORITY_LAMPORTS,
      }),
    }, 'buy-swap');
    if(!sr.ok) throw new Error(`Swap ${sr.status}`);
    const sd = await sr.json();
    if(!sd.swapTransaction) throw new Error('No swap tx');

    const buf = Buffer.from(sd.swapTransaction, 'base64');
    const tx  = VersionedTransaction.deserialize(buf);
    tx.sign([wallet.keypair]);
    const sig = await shared.connection.sendRawTransaction(tx.serialize(), { skipPreflight:true, maxRetries:5 });

    if(await confirm(sig)) {
      wallet.positions.set(mint, {
        time:           Date.now(),
        sol,                      // original cost basis — never changes
        sym:            info.sym,
        isSelling:      false,
        tpFired:        false,
        moonbagMode:    false,
        moonbagStartMs: null,
        moonbagEntryRoi: null,    // ROI when TP fired — for dump SL calculation
        highestRoi:     -Infinity,
        whaleSoldAt:    null,
      });
      wallet.stats.buys++;
      wallet.stats.feesTotal += feeSol;

      log('BUY', `✅ ${info.sym} ${sol.toFixed(4)} SOL (~$${SOL_USD(sol)}) | fee:${feeSol.toFixed(4)} SOL | TP:+${CONFIG.TP_ROI_PCT}% SL:${CONFIG.SL_PCT}%`);

      await discord(
        `🪞  **COPY BUY — ${info.sym}**\n` +
        `\`${mint}\`\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💸  Bought: **${sol.toFixed(4)} SOL** (~$${SOL_USD(sol)})\n` +
        `🐋  Target spent: **${whaleSol.toFixed(3)} SOL** (~$${SOL_USD(whaleSol)})\n` +
        `💸  Buy fee: ~$${SOL_USD(feeSol)} (${feeSol.toFixed(4)} SOL)\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🎯  TP: **+${CONFIG.TP_ROI_PCT}%** → sell 75%, moonbag 25% (no time limit)\n` +
        `🛑  SL: **${CONFIG.SL_PCT}%** → full exit\n` +
        `🌙  Moonbag exits: dump **-40% from TP** | moon **+${CONFIG.MOONBAG_MOON_PCT}%** | NO timer\n` +
        `🚫  No-chase check in 8s\n` +
        `🔗  https://solscan.io/tx/${sig}`
      );

      // No-chase: 8s after fill, check target still holds
      setTimeout(async () => {
        const pos = wallet.positions.get(mint);
        if(!pos || pos.isSelling || pos.tpFired) return;
        const stillHolds = await targetStillHolds(mint);
        if(!stillHolds) {
          log('EMERGENCY', `🚫 NO-CHASE — target already sold ${info.sym} before our fill`);
          pos.isSelling = true;
          await discord(
            `🚫  **NO-CHASE EXIT — ${info.sym}**\n` +
            `Target sold before our fill confirmed — exiting immediately\n` +
            `\`${mint}\``
          );
          execSell(mint, 'no_chase_target_sold', true)
            .catch(e => log('ERROR', `No-chase exit: ${e.message}`));
        }
      }, CONFIG.NO_CHASE_CHECK_DELAY_MS);

      return true;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    log('ERROR', `Buy fail (attempt ${attempt}): ${e.message}`);
    if(attempt < CONFIG.BUY_MAX_RETRIES) {
      await sleep(2000 * attempt);
      return execBuy(mint, whaleSol, attempt+1);
    }
    wallet.stats.errors++;
    await discord(`❌  **BUY FAILED** — ${info.sym}\n\`${mint.slice(0,20)}...\`\n${e.message}`);
    return false;
  }
}

// ── EXIT MANAGER ──────────────────────────────────────────────

async function exitManager() {
  log('INFO', `🎯 Exit manager | TP:+${CONFIG.TP_ROI_PCT}% SL:${CONFIG.SL_PCT}% | NO time-based exits`);

  while(shared.isRunning) {
    await sleep(CONFIG.EXIT_CHECK_MS);

    for(const [mint, pos] of wallet.positions) {
      if(pos.isSelling) continue;

      const ageMin = ((Date.now() - pos.time) / 60000).toFixed(1);

      // ── TARGET SOLD ───────────────────────────────────────
      if(wallet.emergencyQueue.has(mint)) {
        wallet.emergencyQueue.delete(mint);
        if(!pos.whaleSoldAt) {
          pos.whaleSoldAt = Date.now();
          if(!pos.tpFired) {
            // No profit taken yet — exit now
            pos.isSelling = true;
            log('EMERGENCY', `🚨 TARGET SOLD ${pos.sym} — no TP yet, exiting`);
            await discord(`🚨  **TARGET SOLD — ${pos.sym}**\nNo TP yet — exiting to protect capital`);
            execSell(mint, 'target_sold_before_TP', true)
              .catch(e => log('ERROR', `Target-sold exit: ${e.message}`));
          } else {
            // Moonbag is free money — keep riding, ignore target sell
            log('MOONBAG', `🌙 Target sold — moonbag on ${pos.sym} rides on (free money)`);
            await discord(
              `🌙  **Target sold — ${pos.sym}**\n` +
              `Moonbag is pure profit — continuing to ride\n` +
              `Exits: dump **-40% from TP** | moon **+${CONFIG.MOONBAG_MOON_PCT}%**`
            );
          }
        }
        continue;
      }

      // ── MOONBAG MODE — no time limit ──────────────────────
      // Only exits on: hard dump OR moon target OR manual
      if(pos.moonbagMode) {
        const roi = await getCurrentRoi(mint, pos);
        if(roi === null) continue;

        // dumpSLThreshold: if TP fired at +50%, threshold = 50 - 40 = +10%
        // Protects profit — won't let it fall back below ~breakeven
        const dumpSLThreshold = (pos.moonbagEntryRoi || CONFIG.TP_ROI_PCT) - CONFIG.MOONBAG_DUMP_PCT;
        const moonbagAge      = ((Date.now() - pos.moonbagStartMs) / 60000).toFixed(1);

        const bar = roi >= 0
          ? '█'.repeat(Math.min(Math.floor(roi/5),20)) + '░'.repeat(Math.max(20-Math.floor(roi/5),0))
          : '▓'.repeat(Math.min(Math.floor(Math.abs(roi)/5),20));
        console.log(`  🌙 [MOONBAG][${pos.sym}] ${pctStr(roi)} [${bar}] | ${moonbagAge}min | DumpSL@${pctStr(dumpSLThreshold)} Moon@+${CONFIG.MOONBAG_MOON_PCT}%`);

        // Moon target: pumped hard — take the win
        if(roi >= CONFIG.MOONBAG_MOON_PCT) {
          pos.isSelling = true;
          log('MOONBAG', `🚀 MOON TARGET ${pctStr(roi)} on ${pos.sym} — cashing moonbag`);
          await discord(`🌙🚀  **MOONBAG MOON EXIT — ${pos.sym}**\n🎉  **${pctStr(roi)}** from entry — cashing out!`);
          execSell(mint, `moonbag_moon_${roi.toFixed(0)}pct`, false)
            .catch(e => log('ERROR', `Moonbag moon exit: ${e.message}`));
          continue;
        }

        // Dump SL: fell -40% from where TP fired — cut before profit evaporates
        if(roi <= dumpSLThreshold) {
          pos.isSelling = true;
          log('MOONBAG', `🛑 MOONBAG DUMP SL ${pos.sym} at ${pctStr(roi)} (threshold: ${pctStr(dumpSLThreshold)})`);
          await discord(
            `🌙🛑  **MOONBAG DUMP SL — ${pos.sym}**\n` +
            `📉  Now **${pctStr(roi)}** — dropped 40% from TP entry\n` +
            `Cutting before profit erases`
          );
          execSell(mint, `moonbag_dump_SL_${roi.toFixed(0)}pct`, false)
            .catch(e => log('ERROR', `Moonbag dump SL: ${e.message}`));
        }
        continue;
      }

      // ── LIVE ROI CHECK (main position) ───────────────────
      // NO time-based exit — hold until TP or SL, period
      const roi = await getCurrentRoi(mint, pos);
      if(roi === null) continue;
      if(roi > pos.highestRoi) pos.highestRoi = roi;

      const bar = roi >= 0
        ? '█'.repeat(Math.min(Math.floor(roi/5),20)) + '░'.repeat(Math.max(20-Math.floor(roi/5),0))
        : '▓'.repeat(Math.min(Math.floor(Math.abs(roi)/5),20));
      console.log(`  [${pos.sym}] ${pctStr(roi)} [${bar}] | ${ageMin}min | SL:${CONFIG.SL_PCT}% TP:+${CONFIG.TP_ROI_PCT}% | holding until TP/SL`);

      // ── FULL EXIT if +50% before TP executes ─────────────
      // Rocket case — don't wait for partial, just take everything
      if(roi >= CONFIG.TP_FULL_EXIT_PCT && !pos.tpFired) {
        pos.isSelling = true;
        log('EXIT', `🚀 FULL EXIT ${pctStr(roi)} on ${pos.sym} — hit +${CONFIG.TP_FULL_EXIT_PCT}% before TP, selling 100%`);
        await discord(
          `🚀  **ROCKET EXIT — ${pos.sym}**\n` +
          `📈  Hit **${pctStr(roi)}** before TP could execute\n` +
          `Selling **100%** immediately`
        );
        execSell(mint, `rocket_${roi.toFixed(0)}pct`, false)
          .catch(e => log('ERROR', `Rocket exit: ${e.message}`));
        continue;
      }

      // ── TAKE PROFIT at +37% → sell 75%, moonbag 25% ──────
      if(roi >= CONFIG.TP_ROI_PCT && !pos.tpFired) {
        pos.tpFired = true;
        log('EXIT', `🎯 TP ${pctStr(roi)} on ${pos.sym} — selling 75%, moonbag 25% rides free`);
        execPartialSell(mint, CONFIG.TP_SELL_FRACTION, roi)
          .catch(e => {
            pos.tpFired = false; // reset so we retry next cycle
            log('ERROR', `TP partial sell failed: ${e.message}`);
          });
        continue;
      }

      // ── STOP LOSS at -35% ─────────────────────────────────
      if(roi <= CONFIG.SL_PCT) {
        pos.isSelling = true;
        log('EXIT', `🛑 STOP LOSS ${pos.sym} at ${pctStr(roi)}`);
        await discord(
          `🛑  **STOP LOSS — ${pos.sym}**\n` +
          `📉  **${pctStr(roi)}** (~-$${SOL_USD(Math.abs(pos.sol * roi/100))}) after **${ageMin}min**`
        );
        execSell(mint, `SL_${roi.toFixed(0)}pct`, false)
          .catch(e => log('ERROR', `SL exit: ${e.message}`));
      }
    }
  }
}

// ── POLL ──────────────────────────────────────────────────────

async function poll() {
  log('INFO', `🪞 Polling ${CONFIG.TARGET.slice(0,24)}... every ${CONFIG.POLL_MS}ms`);
  log('INFO', `📏 Signal: ${CONFIG.MIN_BUY_SOL_SIGNAL}–${CONFIG.MAX_BUY_SOL_SIGNAL} SOL | Buy: ${CONFIG.BUY_SOL} SOL`);

  while(shared.isRunning) {
    try {
      const r = await safeFetch(CONFIG.HELIUS_RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc:'2.0', id:1,
          method:'getSignaturesForAddress',
          params:[CONFIG.TARGET, { limit:10 }],
        }),
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

          // Target sold → emergency queue
          for(const t of trades.filter(t => t.dir==='sell')) {
            if(wallet.positions.has(t.mint) && !wallet.positions.get(t.mint).isSelling) {
              log('EMERGENCY', `🚨 TARGET SOLD ${t.mint.slice(0,10)}...`);
              wallet.emergencyQueue.add(t.mint);
            }
          }

          // Target bought → copy if in range
          for(const t of trades.filter(t => t.dir==='buy')) {
            if(IGNORE.has(t.mint)) continue;
            if(wallet.tradedMints.has(t.mint)) continue;
            if(wallet.positions.has(t.mint)) continue;

            // Signal range check
            const inRange = t.sol >= CONFIG.MIN_BUY_SOL_SIGNAL && t.sol <= CONFIG.MAX_BUY_SOL_SIGNAL;
            if(!inRange) {
              wallet.stats.skipped++;
              const reason = t.sol < CONFIG.MIN_BUY_SOL_SIGNAL ? 'below min' : 'above max';
              log('SKIP', `${t.mint.slice(0,10)}... — ${t.sol.toFixed(3)} SOL ${reason} (range: ${CONFIG.MIN_BUY_SOL_SIGNAL}–${CONFIG.MAX_BUY_SOL_SIGNAL})`);
              await discord(
                `⏭  **SKIPPED — out of range**\n` +
                `\`${t.mint}\`\n` +
                `🎯  Target: **${t.sol.toFixed(3)} SOL** | Range: **${CONFIG.MIN_BUY_SOL_SIGNAL}–${CONFIG.MAX_BUY_SOL_SIGNAL} SOL**\n` +
                `❌  Reason: ${reason}`
              );
              continue;
            }

            // Balance check
            const bal = await solBal(wallet.keypair);
            if(bal < CONFIG.MIN_SOL_BALANCE) {
              wallet.stats.skipped++;
              log('SKIP', `Low balance: ${bal.toFixed(4)} SOL — need ${CONFIG.MIN_SOL_BALANCE}`);
              await discord(
                `⚠️  **SKIPPED — LOW BALANCE**\n` +
                `💰  Have **${bal.toFixed(4)} SOL** (~$${SOL_USD(bal)})\n` +
                `❌  Need **${CONFIG.MIN_SOL_BALANCE} SOL** min (buy + fee buffer)\n` +
                `📥  Top up to resume trading`
              );
              continue;
            }

            // Fee sanity check
            const feePct = estimateFeePct();
            if(feePct > CONFIG.MAX_FEE_PCT_OF_TRADE) {
              wallet.stats.skipped++;
              log('FEE', `Fee check failed: ${feePct.toFixed(1)}% of trade — skipping`);
              await discord(
                `⏭  **SKIPPED — FEES TOO HIGH**\n` +
                `💸  Estimated fees: **${feePct.toFixed(1)}%** of trade value\n` +
                `❌  Max allowed: **${CONFIG.MAX_FEE_PCT_OF_TRADE}%** — not worth it`
              );
              continue;
            }

            wallet.tradedMints.add(t.mint);
            log('MIRROR', `🟢 COPY BUY ${t.mint.slice(0,10)}... | target:${t.sol.toFixed(3)} SOL | ours:${CONFIG.BUY_SOL} SOL | fee:${(CONFIG.BUY_PRIORITY_LAMPORTS/1e9).toFixed(4)} SOL`);
            execBuy(t.mint, t.sol)
              .catch(e => log('ERROR', `execBuy: ${e.message}`));
          }
        }
      }
    } catch(e) { log('ERROR', `Poll: ${e.message}`); }

    await sleep(CONFIG.POLL_MS);
  }
}

// ── HEALTH ────────────────────────────────────────────────────

async function health() {
  while(shared.isRunning) {
    const bal      = await solBal(wallet.keypair);
    const pnl      = bal - wallet.stats.startBal;
    const wr       = wallet.stats.sells > 0 ? ((wallet.stats.wins/wallet.stats.sells)*100).toFixed(0) : '0';
    const feesUsed = wallet.stats.feesTotal.toFixed(4);

    console.log('\n' + '═'.repeat(62));
    console.log('  🪞 WINSTON v24.0 — Moonbag Copy Bot');
    console.log('═'.repeat(62));
    console.log(`  👀 ${CONFIG.TARGET.slice(0,24)}...`);
    console.log(`  📏 Signal: ${CONFIG.MIN_BUY_SOL_SIGNAL}–${CONFIG.MAX_BUY_SOL_SIGNAL} SOL | Buy: ${CONFIG.BUY_SOL} SOL ($${SOL_USD(CONFIG.BUY_SOL)})`);
    console.log(`  🎯 TP:+${CONFIG.TP_ROI_PCT}%→75%sell | SL:${CONFIG.SL_PCT}% | Moonbag: no limit`);
    console.log(`  🌙 Moonbag exits: dump -40% from TP | moon +${CONFIG.MOONBAG_MOON_PCT}%`);
    console.log(`  💰 ${bal.toFixed(4)} SOL ($${SOL_USD(bal)}) | PnL: ${pnl>=0?'+':''}${pnl.toFixed(4)} SOL ($${SOL_USD(Math.abs(pnl))})`);
    console.log(`  📊 ${wallet.stats.buys}B ${wallet.stats.wins}W/${wallet.stats.losses}L (${wr}% WR) | Skipped:${wallet.stats.skipped} | Fees:${feesUsed} SOL`);

    if(wallet.positions.size > 0) {
      for(const [m, p] of wallet.positions) {
        const age  = ((Date.now()-p.time)/60000).toFixed(1);
        const mode = p.moonbagMode ? `🌙MOONBAG(${((Date.now()-p.moonbagStartMs)/60000).toFixed(1)}min)` : '📦HOLD';
        console.log(`  ${mode} ${p.sym} ${m.slice(0,8)}... | ${age}min total | ${p.sol.toFixed(4)} SOL in`);
      }
    } else {
      console.log('  📭 No open positions');
    }
    console.log('═'.repeat(62) + '\n');
    await sleep(CONFIG.HEALTH_MS);
  }
}

// ── MAIN ──────────────────────────────────────────────────────

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  🪞 WINSTON v24.0 — Moonbag Copy Bot                       ║');
  console.log('║  $2.50 buy · 0.9–3 SOL signal · TP+35% · SL-35%          ║');
  console.log('║  Moonbag: no time limit · dumps -40% · moons +200%        ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  if(!CONFIG.HELIUS_API_KEY) { log('ERROR', 'HELIUS_API_KEY missing'); process.exit(1); }
  if(!CONFIG.PRIVATE_KEY)    { log('ERROR', 'WALLET_PRIVATE_KEY missing'); process.exit(1); }

  try {
    wallet.keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
    log('INFO', `Wallet: ${wallet.keypair.publicKey.toString()}`);
  } catch(e) { log('ERROR', `Bad private key: ${e.message}`); process.exit(1); }

  shared.connection = new Connection(CONFIG.HELIUS_RPC, { commitment:'confirmed' });

  wallet.stats.startBal = await solBal(wallet.keypair);
  log('INFO', `Balance: ${wallet.stats.startBal.toFixed(4)} SOL (~$${SOL_USD(wallet.stats.startBal)})`);

  if(wallet.stats.startBal < CONFIG.MIN_SOL_BALANCE) {
    log('ERROR', `Balance too low — need at least ${CONFIG.MIN_SOL_BALANCE} SOL (buy + fees)`);
    process.exit(1);
  }

  // Pre-flight fee check
  const feePct = estimateFeePct();
  log('FEE', `Round-trip fee estimate: ${feePct.toFixed(1)}% of trade value (${CONFIG.MAX_FEE_PCT_OF_TRADE}% max)`);
  if(feePct > CONFIG.MAX_FEE_PCT_OF_TRADE) {
    log('ERROR', `Fees too high to trade (${feePct.toFixed(1)}%) — lower priority fees or increase buy size`);
    process.exit(1);
  }

  try {
    const r = await safeFetch(CONFIG.HELIUS_RPC, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({jsonrpc:'2.0',id:1,method:'getSignaturesForAddress',params:[CONFIG.TARGET,{limit:1}]}),
    }, 'init-cursor');
    const d = await r.json();
    shared.lastSig = d?.result?.[0]?.signature || null;
    log('INFO', `Cursor: ${shared.lastSig ? shared.lastSig.slice(0,20)+'...' : 'none'}`);
  } catch(e) { log('ERROR', `Init cursor: ${e.message}`); process.exit(1); }

  shared.isRunning = true;

  await discord(
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `🪞  **WINSTON v24.0 ONLINE**\n` +
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `👀  \`${CONFIG.TARGET}\`\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💸  Buy: **${CONFIG.BUY_SOL} SOL (~$${SOL_USD(CONFIG.BUY_SOL)})** — fixed, never increases\n` +
    `📏  Signal: **${CONFIG.MIN_BUY_SOL_SIGNAL}–${CONFIG.MAX_BUY_SOL_SIGNAL} SOL** buys only\n` +
    `💸  Est. fees: **${feePct.toFixed(1)}%** of trade\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎯  TP: **+${CONFIG.TP_ROI_PCT}%** → sell 75%, moonbag 25% **(no time limit)**\n` +
    `🌙  Moonbag exits: dump **-40%** from TP price | moon **+${CONFIG.MOONBAG_MOON_PCT}%** from entry\n` +
    `🛑  Main SL: **${CONFIG.SL_PCT}%** → full exit\n` +
    `⏳  **No time-based exits** — holds until TP or SL\n` +
    `🚫  No-chase: exits if target sold before our fill\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💰  Balance: **${wallet.stats.startBal.toFixed(4)} SOL** (~$${SOL_USD(wallet.stats.startBal)})\n` +
    `📡  Poll: ${CONFIG.POLL_MS}ms · Exit check: ${CONFIG.EXIT_CHECK_MS}ms\n` +
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if(shuttingDown) return;
    shuttingDown = true;
    shared.isRunning = false;
    const finalBal = await solBal(wallet.keypair);
    const pnl      = finalBal - wallet.stats.startBal;
    const wr       = wallet.stats.sells > 0 ? ((wallet.stats.wins/wallet.stats.sells)*100).toFixed(0) : '0';
    await discord(
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
      `🔴  **WINSTON v24.0 OFFLINE**\n` +
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
      `💰  Final: **${finalBal.toFixed(4)} SOL** (~$${SOL_USD(finalBal)})\n` +
      `📈  PnL: **${pnl>=0?'+':''}$${SOL_USD(Math.abs(pnl))}** (${pnl>=0?'+':''}${pnl.toFixed(4)} SOL)\n` +
      `📊  **${wallet.stats.wins}W / ${wallet.stats.losses}L** (${wr}% WR) | ${wallet.stats.buys} buys | ${wallet.stats.skipped} skipped\n` +
      `💸  Total fees paid: **${wallet.stats.feesTotal.toFixed(4)} SOL** (~$${SOL_USD(wallet.stats.feesTotal)})\n` +
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`
    );
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);

  await Promise.all([poll(), exitManager(), health()]);
}

main().catch(e => { log('ERROR', 'Fatal', { err: e.message }); process.exit(1); });
