// ============================================================
// WINSTON v27.0 — Copy Trade Bot
// ⚠️  HIGH RISK — for educational/personal use only
// ============================================================
// Target: 57ZJXaG4Y4CFzCNym2W3PzKSKYaayhijtTrR7TKB26x9
// Signal: Only copy buys of 0.9–2.0 SOL from target wallet
// Buy size: 0.13 SOL (~$12) — never increases
//
// Strategy — SIMPLE, FAST, FULL EXIT:
//   1. Target buys 0.9–2.0 SOL → we buy 0.13 SOL immediately
//   2. Hit +35% → FULL EXIT, take everything, done
//   3. SL at -35% → full exit
//   4. 60min max hold → full exit no matter what
//   5. No moonbag, no partial sells, no complexity
//   6. No-chase: if target sold before our fill → exit immediately
//
// Fees — minimum viable:
//   Buy:       0.0001 SOL (100k lamports)
//   Sell:      0.0002 SOL (200k lamports)
//   Emergency: 0.001  SOL (keep fast for emergencies)
//
// Failsafe: uncaught exceptions restart the main loop, never die
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
  MAX_BUY_SOL_SIGNAL: 2.0,

  // ── Buy size — NEVER changes ──────────────────────────────
  BUY_SOL: 0.13,  // ~$12

  // ── Fee safety — minimum viable ──────────────────────────
  MIN_SOL_BALANCE:             0.14,    // 0.13 buy + 0.01 fee buffer
  MAX_FEE_PCT_OF_TRADE:        15,      // skip if fees > 15% of trade value
  BUY_PRIORITY_LAMPORTS:       100000,  // 0.0001 SOL — minimum viable
  BUY_SLIPPAGE_BPS:             300,    // 3%
  SELL_PRIORITY_LAMPORTS:      200000,  // 0.0002 SOL — minimum viable
  SELL_SLIPPAGE_BPS:            500,    // 5%
  EMERGENCY_PRIORITY_LAMPORTS: 1000000, // 0.001 SOL — keep fast
  EMERGENCY_SLIPPAGE_BPS:      2000,    // 20%

  // ── Exit strategy — SIMPLE FULL EXIT ─────────────────────
  // TP at +35% → sell 100%, done. No moonbag, no partial.
  // SL at -35% → sell 100%, done.
  // 60min → sell 100%, done.
  TP_ROI_PCT:   35,      // full exit at +35%
  SL_PCT:      -35,     // full exit at -35%
  MAX_HOLD_MS:  3600000, // 60min hard exit

  // ── No-chase ─────────────────────────────────────────────
  NO_CHASE_CHECK_DELAY_MS: 8000,

  // ── Rate limits ──────────────────────────────────────────
  POLL_MS:       1200,
  EXIT_CHECK_MS: 2000,  // check every 2s — faster for quick scalper
  HEALTH_MS:     30000,

  SELL_MAX_RETRIES: 10,
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

function estimateFeePct() {
  const totalFees = (CONFIG.BUY_PRIORITY_LAMPORTS + CONFIG.SELL_PRIORITY_LAMPORTS) / 1e9;
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
  } catch(e) { return true; }
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

// ── GET TOKEN BALANCE + CURRENT VALUE ────────────────────────

async function getTokenBalanceAndValue(mint) {
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
      {}, 'val-quote'
    );
    if(!qr.ok) return null;
    const q = await qr.json();
    if(!q.outAmount) return null;

    const currentSolValue = parseFloat(q.outAmount) / 1e9;
    return { bal, dec, raw, currentSolValue };
  } catch(e) { return null; }
}

// ── GET ROI ───────────────────────────────────────────────────

async function getCurrentRoi(mint, pos) {
  const result = await getTokenBalanceAndValue(mint);
  if(!result) return null;
  return ((result.currentSolValue / pos.sol) - 1) * 100;
}

// ── FULL SELL ─────────────────────────────────────────────────

async function execSell(mint, reason, emergency=false, attempt=1) {
  const info     = await tokenInfo(mint);
  const pos      = wallet.positions.get(mint);
  if(!pos) return true;

  const slippage   = emergency ? CONFIG.EMERGENCY_SLIPPAGE_BPS : CONFIG.SELL_SLIPPAGE_BPS;
  const priority   = emergency ? CONFIG.EMERGENCY_PRIORITY_LAMPORTS : CONFIG.SELL_PRIORITY_LAMPORTS;
  const feeSol     = priority / 1e9;
  const maxRetries = CONFIG.SELL_MAX_RETRIES;

  log('EXEC', `${emergency?'🚨':'🔴'} SELL `✅ ${info.sym} — ${reason} (attempt ${attempt}/${maxRetries})`);

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
      log('SELL', `✅ ${info.sym} → ${solBack.toFixed(4)} SOL (${pnlSign}${pnl.toFixed(4)}) | ${reason} | WR:${wr}%`);

      const exitLabel =
          reason.startsWith('no_chase')           ? '🚫 NO-CHASE EXIT'
        : reason.startsWith('SL')                 ? '🛑 STOP LOSS'
        : reason.startsWith('target_sold')        ? '🚨 TARGET SOLD'
        : reason.startsWith('max_hold')           ? '⏱ 60MIN EXIT'
        : '🔴 SELL';

      const dMsg = [
        `${exitLabel} — **`✅ ${info.sym}**`,
        '━━━━━━━━━━━━━━━━━━━━',
        `📥  Entry:  **$${SOL_USD(pos.sol)}** (${pos.sol.toFixed(4)} SOL)`,
        `📤  Exit:   **$${SOL_USD(solBack)}** (${solBack.toFixed(4)} SOL)`,
        `${pnlEmoji}  PnL:    **${pnlSign}$${SOL_USD(Math.abs(pnl))}** (${pnlSign}${pnl.toFixed(4)} SOL / ${pctStr(roiPct)})`,
        `💸  Fee:    ~$${SOL_USD(feeSol)} (${feeSol.toFixed(4)} SOL)`,
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
      `🆘  **SELL EXHAUSTED — `✅ ${info.sym}**\n` +
      `All ${maxRetries} retries failed — **SELL MANUALLY NOW**\n` +
      `🔗  https://jup.ag/swap/${mint}-SOL`
    );
    return false;
  }
}

// ── TP SELL — full exit at +35%, no moonbag ──────────────────
async function execTpSell(mint, currentRoi) {
  log('EXIT', `🎯 TP ${pctStr(currentRoi)} on ${(wallet.positions.get(mint)||{sym:'?'}).sym} — FULL EXIT`);
  return execSell(mint, `TP_${currentRoi.toFixed(0)}pct_full_exit`, false);
}

// ── BUY ───────────────────────────────────────────────────────

async function execBuy(mint, whaleSol, attempt=1) {
  const info     = await tokenInfo(mint);
  const sol      = CONFIG.BUY_SOL;
  const lamports = Math.floor(sol * 1e9);
  const feeSol   = CONFIG.BUY_PRIORITY_LAMPORTS / 1e9;

  log('EXEC', `🪞 BUY `✅ ${info.sym} ${sol.toFixed(4)} SOL (target: ${whaleSol.toFixed(3)} SOL)`, { mint: mint.slice(0,12) });

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
        time:        Date.now(),
        sol,
        sym:         info.sym,
        isSelling:   false,
        tpFired:     false,
        highestRoi:  -Infinity,
        whaleSoldAt: null,
      });
      wallet.stats.buys++;
      wallet.stats.feesTotal += feeSol;

      log('BUY', `✅ `✅ ${info.sym} ${sol.toFixed(4)} SOL (~$${SOL_USD(sol)}) | fee:${feeSol.toFixed(4)} SOL | TP:+${CONFIG.TP_ROI_PCT}% SL:${CONFIG.SL_PCT}% Max:60min`);

      await discord(
        `🪞  **COPY BUY — `✅ ${info.sym}**\n` +
        `\`${mint}\`\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💸  Bought: **${sol.toFixed(4)} SOL** (~$${SOL_USD(sol)})\n` +
        `🐋  Target spent: **${whaleSol.toFixed(3)} SOL** (~$${SOL_USD(whaleSol)})\n` +
        `💸  Buy fee: ~$${SOL_USD(feeSol)} (${feeSol.toFixed(4)} SOL)\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🎯  TP: **+${CONFIG.TP_ROI_PCT}%** → FULL EXIT, take everything\n` +
        `🛑  SL: **${CONFIG.SL_PCT}%** → full exit\n` +
        `⏱  Max hold: **60 minutes**\n` +
        `🚫  No-chase check in 8s\n` +
        `🔗  https://solscan.io/tx/${sig}`
      );

      // No-chase: 8s after fill, verify target still holds
      setTimeout(async () => {
        const pos = wallet.positions.get(mint);
        if(!pos || pos.isSelling || pos.tpFired) return;
        const stillHolds = await targetStillHolds(mint);
        if(!stillHolds) {
          log('EMERGENCY', `🚫 NO-CHASE — target already sold `✅ ${info.sym}`);
          pos.isSelling = true;
          await discord(`🚫  **NO-CHASE EXIT — `✅ ${info.sym}**\nTarget sold before our fill — exiting`);
          execSell(mint, 'no_chase_target_sold', true)
            .catch(e => log('ERROR', `No-chase: ${e.message}`));
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
    await discord(`❌  **BUY FAILED** — `✅ ${info.sym}\n${e.message}`);
    return false;
  }
}

// ── EXIT MANAGER ──────────────────────────────────────────────

async function exitManager() {
  log('INFO', `🎯 Exit manager | TP:+${CONFIG.TP_ROI_PCT}% FULL EXIT | SL:${CONFIG.SL_PCT}% | Max:60min`);

  while(shared.isRunning) {
    await sleep(CONFIG.EXIT_CHECK_MS);

    for(const [mint, pos] of wallet.positions) {
      if(pos.isSelling) continue;

      const ageMs  = Date.now() - pos.time;
      const ageMin = (ageMs / 60000).toFixed(1);

      // ── TARGET SOLD → exit immediately ───────────────────
      if(wallet.emergencyQueue.has(mint)) {
        wallet.emergencyQueue.delete(mint);
        if(!pos.whaleSoldAt) {
          pos.whaleSoldAt = Date.now();
          pos.isSelling   = true;
          log('EMERGENCY', `🚨 TARGET SOLD ${pos.sym} — exiting`);
          await discord(`🚨  **TARGET SOLD — ${pos.sym}**\nExiting immediately`);
          execSell(mint, 'target_sold', true)
            .catch(e => log('ERROR', `Target-sold exit: ${e.message}`));
        }
        continue;
      }

      // ── 60MIN HARD EXIT ───────────────────────────────────
      if(ageMs >= CONFIG.MAX_HOLD_MS) {
        pos.isSelling = true;
        log('EXIT', `⏱ 60MIN MAX HOLD ${pos.sym} — exiting`);
        await discord(`⏱  **60MIN EXIT — ${pos.sym}**\nTime's up — full exit`);
        execSell(mint, 'max_hold_60min', false)
          .catch(e => log('ERROR', `60min exit: ${e.message}`));
        continue;
      }

      // ── ROI CHECK ─────────────────────────────────────────
      const roi = await getCurrentRoi(mint, pos);
      if(roi === null) continue;
      if(roi > pos.highestRoi) pos.highestRoi = roi;

      const timeLeftMin = ((CONFIG.MAX_HOLD_MS - ageMs) / 60000).toFixed(1);
      const bar = roi >= 0
        ? '█'.repeat(Math.min(Math.floor(roi/5),20)) + '░'.repeat(Math.max(20-Math.floor(roi/5),0))
        : '▓'.repeat(Math.min(Math.floor(Math.abs(roi)/5),20));
      console.log(`  [${pos.sym}] ${pctStr(roi)} [${bar}] | ${ageMin}min | SL:${CONFIG.SL_PCT}% TP:+${CONFIG.TP_ROI_PCT}% | ${timeLeftMin}min left`);

      // ── TAKE PROFIT → full exit ───────────────────────────
      if(roi >= CONFIG.TP_ROI_PCT && !pos.tpFired) {
        pos.tpFired   = true;
        pos.isSelling = true;
        log('EXIT', `🎯 TP ${pctStr(roi)} on ${pos.sym} — FULL EXIT`);
        execTpSell(mint, roi)
          .catch(e => {
            pos.tpFired   = false;
            pos.isSelling = false;
            log('ERROR', `TP sell failed, will retry: ${e.message}`);
          });
        continue;
      }

      // ── STOP LOSS ─────────────────────────────────────────
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
  log('INFO', `📏 Signal: ${CONFIG.MIN_BUY_SOL_SIGNAL}–${CONFIG.MAX_BUY_SOL_SIGNAL} SOL | Buy: ${CONFIG.BUY_SOL} SOL (~$${SOL_USD(CONFIG.BUY_SOL)})`);

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

          // Target sold
          for(const t of trades.filter(t => t.dir==='sell')) {
            if(wallet.positions.has(t.mint) && !wallet.positions.get(t.mint).isSelling) {
              log('EMERGENCY', `🚨 TARGET SOLD ${t.mint.slice(0,10)}...`);
              wallet.emergencyQueue.add(t.mint);
            }
          }

          // Target bought
          for(const t of trades.filter(t => t.dir==='buy')) {
            if(IGNORE.has(t.mint)) continue;
            if(wallet.tradedMints.has(t.mint)) continue;
            if(wallet.positions.has(t.mint)) continue;

            const inRange = t.sol >= CONFIG.MIN_BUY_SOL_SIGNAL && t.sol <= CONFIG.MAX_BUY_SOL_SIGNAL;
            if(!inRange) {
              wallet.stats.skipped++;
              const reason = t.sol < CONFIG.MIN_BUY_SOL_SIGNAL ? 'below min' : 'above max';
              log('SKIP', `${t.mint.slice(0,10)}... — ${t.sol.toFixed(3)} SOL ${reason}`);
              await discord(
                `⏭  **SKIPPED — out of range**\n` +
                `\`${t.mint}\`\n` +
                `🎯  Target: **${t.sol.toFixed(3)} SOL** | Range: **${CONFIG.MIN_BUY_SOL_SIGNAL}–${CONFIG.MAX_BUY_SOL_SIGNAL} SOL**\n` +
                `❌  ${reason}`
              );
              continue;
            }

            const bal = await solBal(wallet.keypair);
            if(bal < CONFIG.MIN_SOL_BALANCE) {
              wallet.stats.skipped++;
              log('SKIP', `Low balance: ${bal.toFixed(4)} SOL — need ${CONFIG.MIN_SOL_BALANCE}`);
              await discord(
                `⚠️  **SKIPPED — LOW BALANCE**\n` +
                `💰  Have **${bal.toFixed(4)} SOL** | Need **${CONFIG.MIN_SOL_BALANCE} SOL**\n` +
                `📥  Top up wallet to resume`
              );
              continue;
            }

            const feePct = estimateFeePct();
            if(feePct > CONFIG.MAX_FEE_PCT_OF_TRADE) {
              wallet.stats.skipped++;
              log('FEE', `Fee check: ${feePct.toFixed(1)}% — skipping`);
              await discord(`⏭  **SKIPPED — FEES TOO HIGH**\n💸  ${feePct.toFixed(1)}% of trade — max ${CONFIG.MAX_FEE_PCT_OF_TRADE}%`);
              continue;
            }

            wallet.tradedMints.add(t.mint);
            log('MIRROR', `🟢 COPY BUY ${t.mint.slice(0,10)}... | target:${t.sol.toFixed(3)} SOL | ours:${CONFIG.BUY_SOL} SOL`);
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

    console.log('\n' + '═'.repeat(62));
    console.log('  🪞 WINSTON v27.0 — Copy Bot (Full Exit)');
    console.log('═'.repeat(62));
    console.log(`  👀 ${CONFIG.TARGET.slice(0,24)}...`);
    console.log(`  📏 Signal: ${CONFIG.MIN_BUY_SOL_SIGNAL}–${CONFIG.MAX_BUY_SOL_SIGNAL} SOL | Buy: ${CONFIG.BUY_SOL} SOL ($${SOL_USD(CONFIG.BUY_SOL)})`);
    console.log(`  🎯 TP:+${CONFIG.TP_ROI_PCT}% FULL EXIT | SL:${CONFIG.SL_PCT}% | Max:60min`);
    console.log(`  💰 ${bal.toFixed(4)} SOL ($${SOL_USD(bal)}) | PnL: ${pnl>=0?'+':''}${pnl.toFixed(4)} SOL ($${SOL_USD(Math.abs(pnl))})`);
    console.log(`  📊 ${wallet.stats.buys}B ${wallet.stats.wins}W/${wallet.stats.losses}L (${wr}% WR) | Skip:${wallet.stats.skipped} | Fees:${wallet.stats.feesTotal.toFixed(4)} SOL`);

    if(wallet.positions.size > 0) {
      for(const [m, p] of wallet.positions) {
        const age      = ((Date.now()-p.time)/60000).toFixed(1);
        const timeLeft = ((CONFIG.MAX_HOLD_MS-(Date.now()-p.time))/60000).toFixed(1);
        console.log(`  📦 ${p.sym} ${m.slice(0,8)}... | ${age}min | ${timeLeft}min left | ${p.sol.toFixed(4)} SOL`);
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
  console.log('║  🪞 WINSTON v27.0 — Copy Bot (Full Exit)                   ║');
  console.log('║  $12 buy · 0.9–2.0 SOL signal · TP+35% FULL · SL-35%     ║');
  console.log('║  60min max hold · no moonbag · crash failsafe active      ║');
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
    log('ERROR', `Balance too low — need at least ${CONFIG.MIN_SOL_BALANCE} SOL`);
    process.exit(1);
  }

  const feePct = estimateFeePct();
  log('FEE', `Round-trip fee estimate: ${feePct.toFixed(2)}% of trade (~$${SOL_USD((CONFIG.BUY_PRIORITY_LAMPORTS+CONFIG.SELL_PRIORITY_LAMPORTS)/1e9)} per trade)`);

  try {
    const r = await safeFetch(CONFIG.HELIUS_RPC, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({jsonrpc:'2.0',id:1,method:'getSignaturesForAddress',params:[CONFIG.TARGET,{limit:1}]}),
    }, 'init-cursor');
    const d = await r.json();
    shared.lastSig = d?.result?.[0]?.signature || null;
    log('INFO', `Cursor: ${shared.lastSig ? shared.lastSig.slice(0,20)+'...' : 'none'}`);
  } catch(e) { log('ERROR', `Init: ${e.message}`); process.exit(1); }

  shared.isRunning = true;

  await discord(
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `🪞  **WINSTON v27.0 ONLINE**\n` +
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `👀  \`${CONFIG.TARGET}\`\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💸  Buy: **${CONFIG.BUY_SOL} SOL (~$${SOL_USD(CONFIG.BUY_SOL)})** — fixed\n` +
    `📏  Signal: **${CONFIG.MIN_BUY_SOL_SIGNAL}–${CONFIG.MAX_BUY_SOL_SIGNAL} SOL** only\n` +
    `💸  Est. fee/trade: ~**$${SOL_USD((CONFIG.BUY_PRIORITY_LAMPORTS+CONFIG.SELL_PRIORITY_LAMPORTS)/1e9)}** (${feePct.toFixed(2)}%)\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎯  TP: **+${CONFIG.TP_ROI_PCT}%** → **FULL EXIT**, take everything\n` +
    `🛑  SL: **${CONFIG.SL_PCT}%** → full exit\n` +
    `⏱  Max hold: **60 minutes**\n` +
    `🚫  No-chase: exits if target sold before our fill\n` +
    `🔄  Crash failsafe: auto-restarts on any error\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💰  Balance: **${wallet.stats.startBal.toFixed(4)} SOL** (~$${SOL_USD(wallet.stats.startBal)})\n` +
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
      `🔴  **WINSTON v27.0 OFFLINE**\n` +
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
      `💰  Final: **${finalBal.toFixed(4)} SOL** (~$${SOL_USD(finalBal)})\n` +
      `📈  PnL: **${pnl>=0?'+':''}$${SOL_USD(Math.abs(pnl))}** (${pnl>=0?'+':''}${pnl.toFixed(4)} SOL)\n` +
      `📊  **${wallet.stats.wins}W / ${wallet.stats.losses}L** (${wr}% WR) | ${wallet.stats.buys} buys | ${wallet.stats.skipped} skipped\n` +
      `💸  Total fees: **${wallet.stats.feesTotal.toFixed(4)} SOL** (~$${SOL_USD(wallet.stats.feesTotal)})\n` +
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`
    );
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);

  await Promise.all([poll(), exitManager(), health()]);
}

// ── CRASH FAILSAFE ────────────────────────────────────────────
// If main crashes for any reason, wait 5s and restart
// Sends Discord alert so you know it happened
async function runWithFailsafe() {
  let crashCount = 0;
  while(true) {
    try {
      await main();
      break; // clean shutdown via SIGINT/SIGTERM
    } catch(e) {
      crashCount++;
      const msg = `💥  **WINSTON CRASHED — restarting (crash #${crashCount})**\n❌  ${e.message}\nRestarting in 5s...`;
      log('ERROR', `CRASH #${crashCount}: ${e.message}`);
      console.error(e);
      try {
        if(CONFIG.DISCORD_WEBHOOK) {
          await fetch(CONFIG.DISCORD_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: msg }),
          });
        }
      } catch(_) {}
      // Reset shared state for restart
      shared.isRunning = false;
      shared.lastSig   = null;
      wallet.positions.clear();
      wallet.emergencyQueue.clear();
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

runWithFailsafe();
