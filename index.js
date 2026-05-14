// ============================================================
// WINSTON v30.0 — Pump.fun Creator Sniper
// ⚠️  HIGH RISK — for educational/personal use only
// ============================================================
//
// Strategy:
//   Watch one specific creator wallet on Pump.fun.
//   The instant they create a new token → buy immediately.
//   Then manage exits automatically:
//
//   - Every time position doubles (+100%) → sell 75%, keep 25%
//   - That 25% moonbag resets: when IT doubles → sell 75% again
//   - Repeat recursively every 2x
//   - Hard exit at exactly 20 minutes — sell 100% of whatever remains
//   - No early sells unless 2x hit
//   - No stop loss — hold until 2x or 20min
//
// Detection:
//   Helius logsSubscribe WebSocket watching creator wallet.
//   Pump.fun token creation uses program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
//   CreateToken instruction fires when new token is minted.
//   We extract the mint from the transaction and buy immediately.
//
// Creator wallet: BiCQ7k6afuhQ9qjta32pxwaEWTTKYnF7unBVL3wg8aB8
// Buy size: 0.22 SOL (~$20)
// Max hold: 20 minutes hard exit
// ============================================================

require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const bs58  = require('bs58');
const fetch = require('node-fetch');
const WebSocket = require('ws');

const CONFIG = {
  HELIUS_API_KEY:  process.env.HELIUS_API_KEY || '',
  PRIVATE_KEY:     process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || '',
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || '',

  get HELIUS_RPC() { return `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },
  get HELIUS_TX()  { return `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${this.HELIUS_API_KEY}`; },
  get HELIUS_WS()  { return process.env.HELIUS_WS_URL || `wss://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },

  JUPITER_QUOTE: 'https://lite-api.jup.ag/swap/v1/quote',
  JUPITER_SWAP:  'https://lite-api.jup.ag/swap/v1/swap',

  // ── Creator wallets to watch (any of these creates → we buy) ─
  CREATORS: new Set([
    'BiCQ7k6afuhQ9qjta32pxwaEWTTKYnF7unBVL3wg8aB8',
    'EP4eybwbNifUHFxgTGPHVqLxupSfgWncmiiSCrEWMNE3',
    '7CYT7Beui1y8Ky26H8CeDSiyyHmrhXzhFFM4CKZCoLS1',
  ]),
  // Keep CREATOR for backward compat in skip addresses
  CREATOR: 'BiCQ7k6afuhQ9qjta32pxwaEWTTKYnF7unBVL3wg8aB8',

  // ── Pump.fun program ID ───────────────────────────────────
  PUMPFUN_PROGRAM: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',

  // ── Buy config ────────────────────────────────────────────
  BUY_SOL:         0.16,  // ~$15
  MIN_SOL_BALANCE: 0.17,  // 0.16 + 0.01 fee buffer

  // ── Exit strategy ─────────────────────────────────────────
  // Every 2x (+100%) → sell 75%, keep 25% moonbag
  // That moonbag resets and does the same on its next 2x
  // At exactly 20min → sell 100% of whatever remains
  TAKE_PROFIT_MULTIPLIER: 2.0,   // 2x = sell 75%
  SELL_FRACTION_AT_TP:    0.75,  // sell 75% at each 2x
  MAX_HOLD_MS:           1200000, // 20 minutes exactly

  // ── Fees — fast but not wasteful ─────────────────────────
  // Higher priority than usual — new token, first mover matters
  BUY_PRIORITY_LAMPORTS:       500000,  // 0.0005 SOL — fast entry
  BUY_SLIPPAGE_BPS:             1000,   // 10% — new pools have thin liquidity
  SELL_PRIORITY_LAMPORTS:      300000,  // 0.0003 SOL
  SELL_SLIPPAGE_BPS:            800,    // 8%
  EMERGENCY_PRIORITY_LAMPORTS: 2000000, // 0.002 SOL — fast final exit
  EMERGENCY_SLIPPAGE_BPS:      3000,    // 30%

  // ── Timing ───────────────────────────────────────────────
  EXIT_CHECK_MS: 2000,  // check position every 2s
  HEALTH_MS:     60000,

  SELL_MAX_RETRIES: 10,
  BUY_MAX_RETRIES:   3,
  SOL_MINT: 'So11111111111111111111111111111111111111112',
};

// ── State ─────────────────────────────────────────────────────
const wallet = {
  keypair:     null,
  position:    null,  // only one position at a time — one creator, one token
  stats: {
    attempts: 0, buys: 0, sells: 0,
    wins: 0, losses: 0, totalPnl: 0,
    feesTotal: 0, startBal: 0, startTime: Date.now(),
    tpHits: 0, // how many 2x targets hit this session
  },
};

const shared = { connection: null, isRunning: false, ws: null, wsEvents: 0, processedSigs: new Set(), buyInProgress: false };

// ── UTILS ─────────────────────────────────────────────────────

function log(lv, msg, d={}) {
  const ts = new Date().toISOString();
  const ic = { INFO:'📡',BUY:'🟢',SELL:'🔴',EXEC:'⚡',ERROR:'❌',SNIPE:'🎯',EXIT:'🏁',EMERGENCY:'🚨',CREATE:'🆕' };
  console.log(`[${ts}] ${ic[lv]||'📋'} [${lv}] ${msg}${Object.keys(d).length?' '+JSON.stringify(d):''}`);
}

const sleep   = ms  => new Promise(r => setTimeout(r, ms));
const SOL_USD = sol => (sol * 96).toFixed(2);
const pctStr  = n   => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

const PROFIT_GIFS = [
  'https://media.tenor.com/LxMBBtB7SWIAAAAC/lets-go-kevin-hart.gif',
  'https://media.tenor.com/7PMPpHm3tnsAAAAC/money-cash.gif',
  'https://media.tenor.com/g1jMbTKW_LEAAAAC/hell-yeah-yes.gif',
  'https://media.tenor.com/GfxAlL4YPRYAAAAC/make-it-rain-money.gif',
  'https://media.tenor.com/vxSLMNJoJlgAAAAC/yes-hell-yeah.gif',
];
const randomGif = () => PROFIT_GIFS[Math.floor(Math.random() * PROFIT_GIFS.length)];

async function safeFetch(url, opts={}, label='') {
  const r = await fetch(url, opts);
  if(r.status === 429) {
    log('ERROR', `429 on ${label||url.slice(0,40)} — sleeping 3s`);
    await sleep(3000);
    throw new Error('429 rate limit');
  }
  return r;
}

async function solBal() {
  try { return (await shared.connection.getBalance(wallet.keypair.publicKey)) / 1e9; }
  catch(e) { return 0; }
}

async function tokenInfo(mint) {
  try {
    const r = await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mint}`);
    if(r.ok) { const d = await r.json(); return { sym: d.symbol||'???', name: d.name||'???' }; }
  } catch(e) {}
  return { sym: '???', name: '???' };
}

async function discord(msg) {
  if(!CONFIG.DISCORD_WEBHOOK) return;
  try {
    await fetch(CONFIG.DISCORD_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg.slice(0, 1990) }),
    });
  } catch(e) {}
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
    await sleep(1000);
  }
  return false;
}

// ── GET CURRENT POSITION VALUE ────────────────────────────────
// Returns current SOL value of the ENTIRE remaining token balance
// Used to detect 2x from last reset point

async function getCurrentValue(mint) {
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
    return parseFloat(q.outAmount) / 1e9;
  } catch(e) { return null; }
}

// ── PARTIAL SELL ──────────────────────────────────────────────
// Sells a fraction of the current token balance
// Returns SOL received

async function execPartialSell(mint, fraction, reason, emergency=false, attempt=1) {
  const pos      = wallet.position;
  if(!pos || pos.mint !== mint) return 0;

  const slippage   = emergency ? CONFIG.EMERGENCY_SLIPPAGE_BPS : CONFIG.SELL_SLIPPAGE_BPS;
  const priority   = emergency ? CONFIG.EMERGENCY_PRIORITY_LAMPORTS : CONFIG.SELL_PRIORITY_LAMPORTS;
  const feeSol     = priority / 1e9;
  const sym        = pos.sym || '???';

  log('EXEC', `🔴 PARTIAL ${(fraction*100).toFixed(0)}% ${sym} — ${reason} (attempt ${attempt})`);

  try {
    const accts = await shared.connection.getParsedTokenAccountsByOwner(
      wallet.keypair.publicKey, { mint: new PublicKey(mint) }
    );
    const acct = accts?.value?.[0];
    if(!acct) return 0;
    const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount||0);
    if(bal <= 0) return 0;
    const dec = acct.account.data.parsed.info.tokenAmount.decimals;
    const raw = BigInt(Math.floor(bal * fraction * Math.pow(10, dec)));
    if(raw <= 0n) return 0;

    const qr = await safeFetch(
      `${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL_MINT}&amount=${raw.toString()}&slippageBps=${slippage}`,
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
        dynamicSlippage: { minBps: 50, maxBps: slippage },
        prioritizationFeeLamports: priority,
      }),
    }, 'partial-sell-swap');
    if(!sr.ok) throw new Error(`Swap ${sr.status}`);
    const sd = await sr.json();
    if(!sd.swapTransaction) throw new Error('No sell tx');

    const buf = Buffer.from(sd.swapTransaction, 'base64');
    const tx  = VersionedTransaction.deserialize(buf);
    tx.sign([wallet.keypair]);
    const txSig = await shared.connection.sendRawTransaction(tx.serialize(), { skipPreflight:true, maxRetries:8 });

    if(await confirm(txSig)) {
      const solBack = parseFloat(q.outAmount) / 1e9;
      wallet.stats.feesTotal += feeSol;
      wallet.stats.sells++;
      wallet.stats.tpHits++;

      log('SELL', `✅ PARTIAL ${(fraction*100).toFixed(0)}% ${sym} → ${solBack.toFixed(4)} SOL | ${reason}`);
      return solBack;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    log('ERROR', `Partial sell fail (${attempt}): ${e.message}`);
    if(attempt < CONFIG.SELL_MAX_RETRIES) {
      await sleep(2000 * attempt + Math.floor(Math.random()*500));
      return execPartialSell(mint, fraction, reason, emergency, attempt+1);
    }
    wallet.stats.errors++;
    await discord(`🆘  **SELL EXHAUSTED — ${sym}**\nSell manually: https://jup.ag/swap/${mint}-SOL`);
    return 0;
  }
}

// ── FULL SELL ─────────────────────────────────────────────────

async function execFullSell(mint, reason, emergency=false, attempt=1) {
  const pos      = wallet.position;
  if(!pos || pos.mint !== mint) return;

  const slippage   = emergency ? CONFIG.EMERGENCY_SLIPPAGE_BPS : CONFIG.SELL_SLIPPAGE_BPS;
  const priority   = emergency ? CONFIG.EMERGENCY_PRIORITY_LAMPORTS : CONFIG.SELL_PRIORITY_LAMPORTS;
  const feeSol     = priority / 1e9;
  const sym        = pos.sym || '???';

  log('EXEC', `${emergency?'🚨':'🔴'} FULL SELL ${sym} — ${reason} (attempt ${attempt})`);

  try {
    const accts = await shared.connection.getParsedTokenAccountsByOwner(
      wallet.keypair.publicKey, { mint: new PublicKey(mint) }
    );
    const acct = accts?.value?.[0];
    if(!acct) { wallet.position = null; return; }
    const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount||0);
    if(bal <= 0) { wallet.position = null; return; }
    const dec = acct.account.data.parsed.info.tokenAmount.decimals;
    const raw = BigInt(Math.floor(bal * Math.pow(10, dec)));
    if(raw <= 0n) { wallet.position = null; return; }

    const qr = await safeFetch(
      `${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL_MINT}&amount=${raw.toString()}&slippageBps=${slippage}`,
      {}, 'full-sell-quote'
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
        dynamicSlippage: { minBps: 50, maxBps: slippage },
        prioritizationFeeLamports: priority,
      }),
    }, 'full-sell-swap');
    if(!sr.ok) throw new Error(`Swap ${sr.status}`);
    const sd = await sr.json();
    if(!sd.swapTransaction) throw new Error('No sell tx');

    const buf = Buffer.from(sd.swapTransaction, 'base64');
    const tx  = VersionedTransaction.deserialize(buf);
    tx.sign([wallet.keypair]);
    const txSig = await shared.connection.sendRawTransaction(tx.serialize(), { skipPreflight:true, maxRetries:8 });

    if(await confirm(txSig)) {
      const solBack  = parseFloat(q.outAmount) / 1e9;
      // Total PnL = all partial sells + this final sell - original buy
      const totalOut = pos.totalSolRecovered + solBack;
      const pnl      = totalOut - pos.originalSol;
      const pnlSign  = pnl >= 0 ? '+' : '';
      const pnlEmoji = pnl >= 0 ? '📈' : '📉';

      wallet.stats.feesTotal += feeSol;
      wallet.stats.sells++;
      wallet.stats.totalPnl += pnl;
      if(pnl >= 0) wallet.stats.wins++; else wallet.stats.losses++;

      const wr = wallet.stats.sells > 0
        ? ((wallet.stats.wins/wallet.stats.sells)*100).toFixed(0) : '0';

      log('SELL', `✅ FULL EXIT ${sym} | final:${solBack.toFixed(4)} SOL | total recovered:${totalOut.toFixed(4)} | pnl:${pnlSign}${pnl.toFixed(4)}`);

      const exitLabel = reason.startsWith('20min') ? '⏱ 20MIN FINAL EXIT'
        : reason.startsWith('2x')                 ? '🎯 2X SELL'
        : '🔴 EXIT';

      const dMsg = [
        `${exitLabel} — **${sym}**`,
        '━━━━━━━━━━━━━━━━━━━━',
        `📥  Original buy: **$${SOL_USD(pos.originalSol)}** (${pos.originalSol.toFixed(4)} SOL)`,
        `💰  Total recovered: **$${SOL_USD(totalOut)}** (${totalOut.toFixed(4)} SOL)`,
        `${pnlEmoji}  Net PnL: **${pnlSign}$${SOL_USD(Math.abs(pnl))}** (${pnlSign}${pnl.toFixed(4)} SOL)`,
        `🎯  2x targets hit: **${pos.tpCount}**`,
        `💸  Fees: ~$${SOL_USD(wallet.stats.feesTotal)}`,
        '━━━━━━━━━━━━━━━━━━━━',
        `📊  Session: **${wallet.stats.wins}W/${wallet.stats.losses}L** (${wr}% WR)`,
        `💰  Total PnL: **${wallet.stats.totalPnl>=0?'+':''}$${SOL_USD(Math.abs(wallet.stats.totalPnl))}**`,
        `🔗  https://solscan.io/tx/${txSig}`,
      ];
      if(pnl > 0) dMsg.push(randomGif());
      await discord(dMsg.join('\n'));

      wallet.position = null;
      return;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    log('ERROR', `Full sell fail (${attempt}): ${e.message}`);
    if(attempt < CONFIG.SELL_MAX_RETRIES) {
      await sleep((emergency?2000:3000)*attempt + Math.floor(Math.random()*1000));
      return execFullSell(mint, reason, emergency, attempt+1);
    }
    wallet.stats.errors++;
    await discord(`🆘  **FULL SELL EXHAUSTED — ${sym}**\nSell manually NOW:\n🔗  https://jup.ag/swap/${mint}-SOL`);
  }
}

// ── BUY ───────────────────────────────────────────────────────

async function execBuy(mint, sym, attempt=1) {
  const sol      = CONFIG.BUY_SOL;
  const lamports = Math.floor(sol * 1e9);
  const feeSol   = CONFIG.BUY_PRIORITY_LAMPORTS / 1e9;

  log('SNIPE', `⚡ BUYING new token ${sym} — ${sol} SOL (attempt ${attempt})`, { mint: mint.slice(0,16) });

  try {
    // Small retry delay on first attempt if pool not yet live
    const qr = await safeFetch(
      `${CONFIG.JUPITER_QUOTE}?inputMint=${CONFIG.SOL_MINT}&outputMint=${mint}&amount=${lamports}&slippageBps=${CONFIG.BUY_SLIPPAGE_BPS}`,
      {}, 'buy-quote'
    );
    if(!qr.ok) throw new Error(`Quote ${qr.status}`);
    const q = await qr.json();
    if(!q.outAmount || q.outAmount==='0') throw new Error('No route yet');

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
    const txSig = await shared.connection.sendRawTransaction(tx.serialize(), { skipPreflight:true, maxRetries:5 });

    if(await confirm(txSig)) {
      wallet.position = {
        mint,
        sym,
        originalSol:       sol,          // what we paid
        currentBasisSol:   sol,          // resets each 2x — tracks moonbag cost basis
        totalSolRecovered: 0,            // running total of all partial sells
        tpCount:           0,            // how many 2x targets hit
        time:              Date.now(),
        isSelling:         false,
      };
      wallet.stats.buys++;
      wallet.stats.feesTotal += feeSol;

      log('BUY', `✅ BOUGHT ${sym} — ${sol} SOL | 2x target: ${(sol*2).toFixed(4)} SOL | 20min exit`);

      await discord(
        `🆕  **NEW TOKEN SNIPED — ${sym}**\n` +
        `\`${mint}\`\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤  Creator: \`${CONFIG.CREATOR.slice(0,20)}...\`\n` +
        `💸  Bought: **${sol} SOL** (~$${SOL_USD(sol)})\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🎯  Strategy: sell **75%** at every **2x**\n` +
        `🌙  Keep **25%** moonbag — repeats on each 2x\n` +
        `⏱  Hard exit at exactly **20 minutes**\n` +
        `🔗  https://solscan.io/tx/${txSig}\n` +
        `📊  https://dexscreener.com/solana/${mint}`
      );
      return true;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    log('ERROR', `Buy fail (attempt ${attempt}): ${e.message}`);
    const isNoRoute = e.message.includes('No route') || e.message.includes('400');
    if(attempt < CONFIG.BUY_MAX_RETRIES) {
      // If no route yet, wait 1.5s for pool to initialize, then retry
      await sleep(isNoRoute ? 1500 : 2000);
      return execBuy(mint, sym, attempt+1);
    }
    wallet.stats.errors++;
    await discord(`❌  **BUY FAILED** — ${sym}\n\`${mint}\`\n${e.message}`);
    return false;
  }
}

// ── EXIT MANAGER ──────────────────────────────────────────────
// Core logic:
//   Every 2s, check if position value >= 2x the currentBasisSol
//   If yes → sell 75%, reset currentBasisSol to remaining value
//   At 20min → full exit regardless

async function exitManager() {
  log('INFO', `🏁 Exit manager | 2x trigger → sell 75% recursive | 20min hard exit`);

  while(shared.isRunning) {
    await sleep(CONFIG.EXIT_CHECK_MS);

    const pos = wallet.position;
    if(!pos || pos.isSelling) continue;

    const ageMs  = Date.now() - pos.time;
    const ageMin = (ageMs / 60000).toFixed(1);

    // ── 20 MINUTE HARD EXIT ───────────────────────────────
    if(ageMs >= CONFIG.MAX_HOLD_MS) {
      pos.isSelling = true;
      log('EXIT', `⏱ 20MIN HARD EXIT — ${pos.sym}`);
      await discord(
        `⏱  **20MIN HARD EXIT — ${pos.sym}**\n` +
        `Selling 100% of remaining tokens\n` +
        `${pos.tpCount > 0 ? `✅ Hit ${pos.tpCount}x 2x target(s) before exit` : '⚠️  No 2x hit — exiting flat'}`
      );
      execFullSell(pos.mint, '20min_final_exit', true)
        .catch(e => log('ERROR', `20min exit: ${e.message}`));
      continue;
    }

    // ── GET CURRENT VALUE ─────────────────────────────────
    const currentVal = await getCurrentValue(pos.mint);
    if(currentVal === null) continue;

    const timeLeft  = ((CONFIG.MAX_HOLD_MS - ageMs) / 60000).toFixed(1);
    const roiVsBasis = ((currentVal / pos.currentBasisSol) - 1) * 100;
    const roiVsOriginal = ((currentVal / pos.originalSol) - 1) * 100;
    const target2x  = pos.currentBasisSol * CONFIG.TAKE_PROFIT_MULTIPLIER;

    const bar = currentVal >= pos.currentBasisSol
      ? '█'.repeat(Math.min(Math.floor(roiVsBasis/5),20)) + '░'.repeat(Math.max(20-Math.floor(roiVsBasis/5),0))
      : '▓'.repeat(Math.min(Math.floor(Math.abs(roiVsBasis)/5),20));

    console.log(
      `  🎯 [${pos.sym}] val:${currentVal.toFixed(4)} SOL | basis:${pos.currentBasisSol.toFixed(4)} | ` +
      `${pctStr(roiVsBasis)} to 2x [${bar}] | ${ageMin}min | ${timeLeft}min left | 2x hits:${pos.tpCount}`
    );

    // ── CHECK FOR 2X ──────────────────────────────────────
    if(currentVal >= target2x) {
      pos.isSelling = true;
      pos.tpCount++;
      log('EXIT', `🎯 2X HIT #${pos.tpCount} on ${pos.sym}! val:${currentVal.toFixed(4)} basis:${pos.currentBasisSol.toFixed(4)} — selling 75%`);

      // Sell 75% of current balance
      const solFromSell = await execPartialSell(
        pos.mint,
        CONFIG.SELL_FRACTION_AT_TP,
        `2x_hit_${pos.tpCount}`,
        false
      );

      if(solFromSell > 0) {
        pos.totalSolRecovered += solFromSell;

        // Reset basis: remaining 25% of current value becomes new basis
        const remainingValue = currentVal * (1 - CONFIG.SELL_FRACTION_AT_TP);
        pos.currentBasisSol  = remainingValue;
        pos.isSelling        = false; // allow next check

        const profitSoFar = pos.totalSolRecovered - pos.originalSol;
        const profitSign  = profitSoFar >= 0 ? '+' : '';

        await discord(
          `🎯  **2X HIT #${pos.tpCount} — ${pos.sym}**\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `💰  Sold **75%** → **$${SOL_USD(solFromSell)}** (${solFromSell.toFixed(4)} SOL)\n` +
          `🌙  25% moonbag rides on — new 2x target: **$${SOL_USD(remainingValue*2)}**\n` +
          `📈  Profit locked so far: **${profitSign}$${SOL_USD(Math.abs(profitSoFar))}**\n` +
          `⏱  ${timeLeft}min remaining\n` +
          randomGif()
        );

        log('INFO', `🌙 Moonbag active — new basis:${remainingValue.toFixed(4)} SOL | next 2x target:${(remainingValue*2).toFixed(4)} SOL`);
      } else {
        // Partial sell failed completely — log and continue
        pos.isSelling = false;
        pos.tpCount--;
      }
    }
  }
}

// ── HELIUS WEBSOCKET — WATCH CREATOR WALLET ───────────────────
// Subscribes to all logs mentioning the creator wallet
// Filters for Pump.fun CreateToken instructions

function connectHelius() {
  log('INFO', `🆕 Connecting to Helius — watching creator ${CONFIG.CREATOR.slice(0,20)}...`);

  const ws = new WebSocket(CONFIG.HELIUS_WS);
  shared.ws = ws;

  ws.on('open', () => {
    log('INFO', `✅ Helius WS connected — subscribing to creator wallet logs`);
    // Subscribe to each creator wallet separately
    // Helius logsSubscribe only supports one address per subscription
    let subId = 1;
    for(const creator of CONFIG.CREATORS) {
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: subId++,
        method: 'logsSubscribe',
        params: [
          { mentions: [creator] },
          { commitment: 'confirmed' },
        ],
      }));
    }
  });

  ws.on('message', async (raw) => {
    shared.wsEvents++;
    try {
      const msg = JSON.parse(raw.toString());

      if(msg.id === 1 && msg.result !== undefined) {
        log('INFO', `✅ logsSubscribe confirmed subId:${msg.result}`);
        return;
      }

      if(!msg.params?.result?.value) return;
      const value = msg.params.result.value;
      const sig   = value.signature;
      const logs  = value.logs || [];

      // Detect Pump.fun token creation
      // Pump.fun logs "Instruction: Create" or "Program 6EF8rr...invoke"
      // Strict check: must have BOTH Pump.fun program invoke AND Create instruction
      // This filters out swaps, transfers, and other txs that mention the creator
      const hasPumpfunInvoke = logs.some(l =>
        l.includes('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P') && l.includes('invoke')
      );
      const hasCreateInstruction = logs.some(l =>
        l.includes('Instruction: Create') || l.includes('Instruction: InitializeMint')
      );

      if(!hasPumpfunInvoke || !hasCreateInstruction) return;

      // Deduplicate — same sig can fire from multiple subscriptions
      if(shared.processedSigs.has(sig)) return;
      shared.processedSigs.add(sig);
      // Keep set from growing forever
      if(shared.processedSigs.size > 200) {
        const first = shared.processedSigs.values().next().value;
        shared.processedSigs.delete(first);
      }

      // Don't process if we already have an open position
      if(wallet.position) {
        log('INFO', `⏭ Already in position (${wallet.position.sym}) — skipping new create`);
        await discord(`⏭  **New token by creator — already in position** (${wallet.position.sym})\nWill catch next one after 20min exit`);
        return;
      }

      log('CREATE', `🆕 CREATOR MADE NEW TOKEN — sig:${sig.slice(0,20)}...`);
      wallet.stats.attempts++;

      // Extract mint from transaction
      extractMintFromCreate(sig)
        .catch(e => log('ERROR', `extractMintFromCreate: ${e.message}`));

    } catch(e) { log('ERROR', `WS msg: ${e.message}`); }
  });

  ws.on('error', e => log('ERROR', `Helius WS: ${e.message}`));
  ws.on('close', code => {
    log('INFO', `Helius WS closed (${code}) — reconnecting in 3s`);
    shared.ws = null;
    if(shared.isRunning) setTimeout(connectHelius, 3000);
  });

  const ping = setInterval(() => {
    if(ws.readyState === WebSocket.OPEN) ws.ping();
    else clearInterval(ping);
  }, 30000);
}

// ── EXTRACT MINT FROM CREATE TX ───────────────────────────────
// Pump.fun creates a new mint account in the CreateToken instruction
// We parse the transaction to find that mint address

async function extractMintFromCreate(sig) {
  try {
    // Try Helius enhanced API first
    let mint = null;
    let sym  = '???';

    try {
      const r = await safeFetch(CONFIG.HELIUS_TX, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: [sig] }),
      }, 'create-tx');

      if(r.ok) {
        const txs = await r.json();
        const tx  = txs?.[0];
        if(tx) {
          // Token name/symbol from description
          const desc = tx.description || '';
          const symMatch = desc.match(/created\s+(\S+)/i);
          if(symMatch) sym = symMatch[1];

          // Mint from token transfers or account data
          const SKIP = new Set([
            'So11111111111111111111111111111111111111112',
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            CONFIG.CREATOR,
            CONFIG.PUMPFUN_PROGRAM,
          ]);

          for(const t of (tx.tokenTransfers||[])) {
            if(t.mint && !SKIP.has(t.mint)) { mint = t.mint; break; }
          }
          if(!mint) {
            for(const a of (tx.accountData||[])) {
              for(const c of (a.tokenBalanceChanges||[])) {
                if(c.mint && !SKIP.has(c.mint)) { mint = c.mint; break; }
              }
              if(mint) break;
            }
          }
        }
      }
    } catch(e) { log('ERROR', `Helius enhanced TX: ${e.message}`); }

    // Fallback: getParsedTransaction
    if(!mint) {
      try {
        const tx = await shared.connection.getParsedTransaction(sig, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
        if(tx) {
          const SKIP = new Set([
            ...CONFIG.CREATORS,
            CONFIG.PUMPFUN_PROGRAM,
            '11111111111111111111111111111111',
            'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
            'SysvarRent111111111111111111111111111111111',
          ]);

          // New mint = account with no pre-balance but has post-balance
          const pre  = new Map((tx.meta?.preTokenBalances||[]).map(b => [b.mint, b]));
          const post = tx.meta?.postTokenBalances || [];
          for(const b of post) {
            if(b.mint && !SKIP.has(b.mint) && !pre.has(b.mint)) {
              mint = b.mint; break;
            }
          }

          // Also check account keys ending in 'pump'
          if(!mint) {
            const keys = tx.transaction?.message?.accountKeys || [];
            for(const k of keys) {
              const addr = k.pubkey?.toString() || k.toString();
              if(addr.endsWith('pump') && !SKIP.has(addr)) { mint = addr; break; }
            }
          }
        }
      } catch(e) { log('ERROR', `getParsedTransaction: ${e.message}`); }
    }

    if(!mint) {
      log('INFO', `⚠️  Could not extract mint from create tx ${sig.slice(0,20)}`);
      return;
    }

    // Fetch proper token name
    const info = await tokenInfo(mint);
    sym = info.sym !== '???' ? info.sym : sym;

    log('CREATE', `🆕 New token: ${sym} | mint: ${mint.slice(0,20)}...`);

    await discord(
      `🆕  **CREATOR MADE NEW TOKEN**\n` +
      `👤  \`${CONFIG.CREATOR.slice(0,20)}...\`\n` +
      `🪙  **${sym}** | \`${mint}\`\n` +
      `🚀  Buying **${CONFIG.BUY_SOL} SOL** (~$${SOL_USD(CONFIG.BUY_SOL)}) NOW\n` +
      `📊  https://dexscreener.com/solana/${mint}`
    );

    // BUY IMMEDIATELY — guard against duplicate concurrent buys
    if(shared.buyInProgress) {
      log('INFO', `⏭ Buy already in progress — skipping duplicate`);
      return;
    }
    if(wallet.position) {
      log('INFO', `⏭ Position already exists — skipping`);
      return;
    }
    shared.buyInProgress = true;
    execBuy(mint, sym)
      .catch(e => log('ERROR', `execBuy: ${e.message}`))
      .finally(() => { shared.buyInProgress = false; });

  } catch(e) { log('ERROR', `extractMintFromCreate: ${e.message}`); }
}

// ── HEALTH ────────────────────────────────────────────────────

async function health() {
  while(shared.isRunning) {
    await sleep(CONFIG.HEALTH_MS);
    const bal    = await solBal();
    const pnl    = bal - wallet.stats.startBal;
    const wr     = wallet.stats.sells > 0 ? ((wallet.stats.wins/wallet.stats.sells)*100).toFixed(0) : '0';
    const uptime = ((Date.now() - wallet.stats.startTime) / 60000).toFixed(0);
    const wsState = shared.ws?.readyState === WebSocket.OPEN ? '🟢 LIVE' : '🔴 RECONNECTING';

    const lines = [
      '',
      '═'.repeat(64),
      '  🆕 WINSTON v30.0 — Pump.fun Creator Sniper',
      '═'.repeat(64),
      `  📡 Helius: ${wsState} | Events: ${shared.wsEvents} | Uptime: ${uptime}min`,
      `  👤 Watching: ${[...CONFIG.CREATORS].map(c=>c.slice(0,8)).join(' | ')}`,
      `  💸  Buy: ${CONFIG.BUY_SOL} SOL ($${SOL_USD(CONFIG.BUY_SOL)}) | 2x→sell 75% | 20min hard exit`,
      `  💰  ${bal.toFixed(4)} SOL ($${SOL_USD(bal)}) | PnL: ${pnl>=0?'+':''}${pnl.toFixed(4)} SOL`,
      `  📊  Buys:${wallet.stats.buys} 2x-hits:${wallet.stats.tpHits} ${wallet.stats.wins}W/${wallet.stats.losses}L (${wr}% WR)`,
    ];

    if(wallet.position) {
      const pos     = wallet.position;
      const age     = ((Date.now()-pos.time)/60000).toFixed(1);
      const left    = ((CONFIG.MAX_HOLD_MS-(Date.now()-pos.time))/60000).toFixed(1);
      const recovered = pos.totalSolRecovered > 0 ? ` | recovered:${pos.totalSolRecovered.toFixed(4)} SOL` : '';
      lines.push(`  🎯 ACTIVE: ${pos.sym} ${pos.mint.slice(0,8)}... | ${age}min | ${left}min left | 2x:${pos.tpCount}${recovered}`);
    } else {
      lines.push('  📭 No position — watching for new token creates');
    }
    lines.push('═'.repeat(64));
    console.log(lines.join('\n'));
  }
}

// ── MAIN ──────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  🆕 WINSTON v30.0 — Pump.fun Creator Sniper                  ║');
  console.log('║  $15 buy · 2x→sell 75% recursive · 20min hard exit          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  if(!CONFIG.HELIUS_API_KEY) { log('ERROR', 'HELIUS_API_KEY missing'); process.exit(1); }
  if(!CONFIG.PRIVATE_KEY)    { log('ERROR', 'WALLET_PRIVATE_KEY missing'); process.exit(1); }

  try {
    wallet.keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
    log('INFO', `Wallet: ${wallet.keypair.publicKey.toString()}`);
  } catch(e) { log('ERROR', `Bad key: ${e.message}`); process.exit(1); }

  shared.connection = new Connection(CONFIG.HELIUS_RPC, { commitment: 'confirmed' });
  wallet.stats.startBal = await solBal();
  log('INFO', `Balance: ${wallet.stats.startBal.toFixed(4)} SOL (~$${SOL_USD(wallet.stats.startBal)})`);

  if(wallet.stats.startBal < CONFIG.MIN_SOL_BALANCE) {
    log('ERROR', `Balance too low — need ${CONFIG.MIN_SOL_BALANCE} SOL`);
    process.exit(1);
  }

  shared.isRunning = true;
  connectHelius();

  await discord(
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `🆕  **WINSTON v30.0 ONLINE**\n` +
    `**Pump.fun Creator Sniper**\n` +
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `👤  Watching **${CONFIG.CREATORS.size} wallets**:\n` +
    `${[...CONFIG.CREATORS].map(c=>`\`${c.slice(0,20)}...\``).join('\n')}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💸  Buy: **${CONFIG.BUY_SOL} SOL (~$${SOL_USD(CONFIG.BUY_SOL)})** on each new token\n` +
    `🎯  At **2x**: sell **75%**, keep **25%** moonbag\n` +
    `🔄  Moonbag resets: every 2x → sell 75% again\n` +
    `⏱  **20 minute hard exit** — sell 100% of remainder\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💰  Balance: **${wallet.stats.startBal.toFixed(4)} SOL** (~$${SOL_USD(wallet.stats.startBal)})\n` +
    `🔄  Crash failsafe: active\n` +
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if(shuttingDown) return;
    shuttingDown = true;
    shared.isRunning = false;
    if(shared.ws) shared.ws.close();
    const finalBal = await solBal();
    const pnl      = finalBal - wallet.stats.startBal;
    const wr       = wallet.stats.sells > 0 ? ((wallet.stats.wins/wallet.stats.sells)*100).toFixed(0) : '0';
    await discord(
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
      `🔴  **WINSTON v30.0 OFFLINE**\n` +
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
      `💰  Final: **${finalBal.toFixed(4)} SOL** (~$${SOL_USD(finalBal)})\n` +
      `📈  PnL: **${pnl>=0?'+':''}$${SOL_USD(Math.abs(pnl))}** (${pnl>=0?'+':''}${pnl.toFixed(4)} SOL)\n` +
      `📊  **${wallet.stats.wins}W/${wallet.stats.losses}L** (${wr}% WR) | 2x hits: ${wallet.stats.tpHits}\n` +
      `💸  Total fees: **${wallet.stats.feesTotal.toFixed(4)} SOL**\n` +
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`
    );
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);

  await Promise.all([exitManager(), health()]);
}

// ── CRASH FAILSAFE ────────────────────────────────────────────

async function runWithFailsafe() {
  let crashCount = 0;
  while(true) {
    try {
      await main();
      break;
    } catch(e) {
      crashCount++;
      log('ERROR', `CRASH #${crashCount}: ${e.message}`);
      console.error(e);
      try {
        if(CONFIG.DISCORD_WEBHOOK) {
          await fetch(CONFIG.DISCORD_WEBHOOK, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: `💥  **WINSTON v30 CRASHED #${crashCount}**\n❌  ${e.message}\nRestarting in 5s...` }),
          });
        }
      } catch(_) {}
      if(shared.ws) { try { shared.ws.close(); } catch(_) {} }
      shared.isRunning = false;
      shared.ws        = null;
      wallet.position  = null;
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

runWithFailsafe();
