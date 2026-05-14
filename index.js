// ============================================================
// WINSTON v29.0 — Wallet Copy Bot
// ⚠️  HIGH RISK — for educational/personal use only
// ============================================================
// Target: EqiFgyNw6kgrmYstWyrP8VjKhka7XEmKTZzHSmwpr1Zb
// Strategy:
//   1. Watch target wallet via Helius logsSubscribe (WebSocket)
//   2. When target buys 1.0–2.1 SOL → we buy 0.055 SOL immediately
//   3. TP at +25% → full exit (small quick profit, get out clean)
//   4. SL at -20% → full exit (tight, don't let losers run)
//   5. 15min max hold → exit regardless
//   6. No-chase: if target already sold before our fill → exit
//
// Why these numbers:
//   Target buys exactly 1.01 or 2.02 SOL every time (it's a bot)
//   We take +25% before he exits, cutting our losses tighter than him
//   15min max because his average hold is 5-20 minutes
//
// Fees — minimum viable:
//   Buy:  0.0002 SOL | Sell: 0.0003 SOL | Emergency: 0.001 SOL
//
// Crash failsafe: auto-restarts on any error
// Single wallet — WALLET_PRIVATE_KEY only
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

  // ── Target wallet to copy ────────────────────────────────
  TARGET: 'EqiFgyNw6kgrmYstWyrP8VjKhka7XEmKTZzHSmwpr1Zb',

  // ── Signal filter — only copy his intentional buys ───────
  // He buys exactly 1.01 or 2.02 SOL — filter for that range
  // Ignore tiny 0.002115 SOL fee transactions
  MIN_BUY_SOL_SIGNAL: 0.9,
  MAX_BUY_SOL_SIGNAL: 2.1,

  // ── Our buy size — fixed ──────────────────────────────────
  BUY_SOL: 0.055, // ~$5

  // ── Fee config ───────────────────────────────────────────
  MIN_SOL_BALANCE:             0.065,  // 0.055 + 0.01 buffer
  BUY_PRIORITY_LAMPORTS:       200000, // 0.0002 SOL
  BUY_SLIPPAGE_BPS:             300,   // 3%
  SELL_PRIORITY_LAMPORTS:      300000, // 0.0003 SOL
  SELL_SLIPPAGE_BPS:            500,   // 5%
  EMERGENCY_PRIORITY_LAMPORTS: 1000000,// 0.001 SOL
  EMERGENCY_SLIPPAGE_BPS:      2000,   // 20%

  // ── Exit strategy ────────────────────────────────────────
  // Simple: get in, take small profit fast, get out clean
  // No tiers — just a clean +25% exit
  TP_PCT:       25,    // take profit — get out before he does
  SL_PCT:      -20,   // stop loss — tight, don't let losers run
  MAX_HOLD_MS:  900000, // 15min max hold

  // ── No-chase ─────────────────────────────────────────────
  NO_CHASE_CHECK_DELAY_MS: 6000, // check 6s after our fill

  // ── Rate limits ──────────────────────────────────────────
  POLL_MS:       1200,
  EXIT_CHECK_MS: 2000,
  HEALTH_MS:     60000,

  MAX_CONCURRENT_POSITIONS: 3,
  SELL_MAX_RETRIES: 10,
  BUY_MAX_RETRIES:   3,
  SOL_MINT: 'So11111111111111111111111111111111111111112',
};

const IGNORE_MINTS = new Set([
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
    totalPnl: 0, errors: 0, skipped: 0,
    feesTotal: 0, startBal: 0, startTime: Date.now(),
  },
};

const shared = { connection: null, isRunning: false, ws: null, wsEvents: 0, copiedBuys: 0 };

// ── UTILS ─────────────────────────────────────────────────────

function log(lv, msg, d={}) {
  const ts = new Date().toISOString();
  const ic = { INFO:'📡',BUY:'🟢',SELL:'🔴',EXEC:'⚡',ERROR:'❌',COPY:'🪞',EXIT:'🎯',SKIP:'⏭',EMERGENCY:'🚨' };
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
    await sleep(1500);
  }
  return false;
}

// ── GET ROI ───────────────────────────────────────────────────

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
    const qr  = await safeFetch(
      `${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL_MINT}&amount=${raw.toString()}&slippageBps=1000`,
      {}, 'roi-quote'
    );
    if(!qr.ok) return null;
    const q = await qr.json();
    if(!q.outAmount) return null;
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
  const feeSol     = priority / 1e9;
  const maxRetries = CONFIG.SELL_MAX_RETRIES;

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
      log('SELL', `✅ ${info.sym} → ${solBack.toFixed(4)} SOL (${pnlSign}${pnl.toFixed(4)}) | ${reason} | WR:${wr}%`);

      const exitLabel =
          reason.startsWith('TP')           ? '🎯 TAKE PROFIT'
        : reason.startsWith('SL')           ? '🛑 STOP LOSS'
        : reason.startsWith('target_sold')  ? '🚨 TARGET SOLD'
        : reason.startsWith('max_hold')     ? '⏱ 15MIN EXIT'
        : reason.startsWith('no_chase')     ? '🚫 NO-CHASE'
        : '🔴 SELL';

      const dMsg = [
        `${exitLabel} — **${info.sym}**`,
        '━━━━━━━━━━━━━━━━━━━━',
        `📥  Entry: **$${SOL_USD(pos.sol)}** (${pos.sol.toFixed(4)} SOL)`,
        `📤  Exit:  **$${SOL_USD(solBack)}** (${solBack.toFixed(4)} SOL)`,
        `${pnlEmoji}  PnL:   **${pnlSign}$${SOL_USD(Math.abs(pnl))}** (${pnlSign}${pnl.toFixed(4)} SOL / ${pctStr(roiPct)})`,
        `💸  Fee:   ~$${SOL_USD(feeSol)}`,
        '━━━━━━━━━━━━━━━━━━━━',
        `📊  Session: **${wallet.stats.wins}W / ${wallet.stats.losses}L** (${wr}% WR)`,
        `💰  Total PnL: **${wallet.stats.totalPnl>=0?'+':''}$${SOL_USD(Math.abs(wallet.stats.totalPnl))}**`,
        `🔗  https://solscan.io/tx/${sig}`,
      ];
      if(pnl > 0) dMsg.push(randomGif());
      await discord(dMsg.join('\n'));
      return true;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    log('ERROR', `Sell fail (${attempt}/${maxRetries}): ${e.message}`);
    if(attempt < maxRetries) {
      await sleep((emergency?2000:3000)*attempt + Math.floor(Math.random()*1000));
      return execSell(mint, reason, emergency, attempt+1);
    }
    wallet.stats.errors++;
    await discord(`🆘  **SELL EXHAUSTED — ${info.sym}**\nAll retries failed — **SELL MANUALLY**\n🔗  https://jup.ag/swap/${mint}-SOL`);
    return false;
  }
}

// ── BUY ───────────────────────────────────────────────────────

async function execBuy(mint, targetSol, attempt=1) {
  const info     = await tokenInfo(mint);
  const sol      = CONFIG.BUY_SOL;
  const lamports = Math.floor(sol * 1e9);
  const feeSol   = CONFIG.BUY_PRIORITY_LAMPORTS / 1e9;

  log('COPY', `🪞 COPYING ${info.sym} ${sol} SOL (target spent: ${targetSol.toFixed(3)})`, { mint: mint.slice(0,12) });

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

      log('BUY', `✅ ${info.sym} ${sol} SOL | TP:+${CONFIG.TP_PCT}% SL:${CONFIG.SL_PCT}% Max:15min`);

      await discord(
        `🪞  **COPY BUY — ${info.sym}**\n` +
        `\`${mint}\`\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💸  Bought: **${sol} SOL** (~$${SOL_USD(sol)})\n` +
        `🎯  Target spent: **${targetSol.toFixed(3)} SOL** (~$${SOL_USD(targetSol)})\n` +
        `💸  Fee: ~$${SOL_USD(feeSol)}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🎯  TP: **+${CONFIG.TP_PCT}%** → full exit\n` +
        `🛑  SL: **${CONFIG.SL_PCT}%** → full exit\n` +
        `⏱  Max hold: **15 minutes**\n` +
        `🔗  https://solscan.io/tx/${sig}\n` +
        `📊  https://dexscreener.com/solana/${mint}`
      );

      // No-chase: 6s after fill, check target still holds
      setTimeout(async () => {
        const pos = wallet.positions.get(mint);
        if(!pos || pos.isSelling || pos.tpFired) return;
        try {
          const accts = await shared.connection.getParsedTokenAccountsByOwner(
            new PublicKey(CONFIG.TARGET), { mint: new PublicKey(mint) }
          );
          const acct = accts?.value?.[0];
          const targetBal = parseFloat(acct?.account?.data?.parsed?.info?.tokenAmount?.uiAmount||0);
          if(targetBal <= 0) {
            log('EMERGENCY', `🚫 NO-CHASE — target already sold ${info.sym}`);
            pos.isSelling = true;
            await discord(`🚫  **NO-CHASE EXIT — ${info.sym}**\nTarget sold before our fill — exiting`);
            execSell(mint, 'no_chase_target_sold', true)
              .catch(e => log('ERROR', `No-chase: ${e.message}`));
          }
        } catch(e) {}
      }, CONFIG.NO_CHASE_CHECK_DELAY_MS);

      return true;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    log('ERROR', `Buy fail (attempt ${attempt}): ${e.message}`);
    if(attempt < CONFIG.BUY_MAX_RETRIES) {
      await sleep(2000 * attempt);
      return execBuy(mint, targetSol, attempt+1);
    }
    wallet.stats.errors++;
    await discord(`❌  **BUY FAILED** — ${info.sym}\n${e.message}`);
    return false;
  }
}

// ── EXIT MANAGER ──────────────────────────────────────────────

async function exitManager() {
  log('INFO', `🎯 Exit manager | TP:+${CONFIG.TP_PCT}% SL:${CONFIG.SL_PCT}% Max:15min`);

  while(shared.isRunning) {
    await sleep(CONFIG.EXIT_CHECK_MS);

    for(const [mint, pos] of wallet.positions) {
      if(pos.isSelling) continue;

      const ageMs  = Date.now() - pos.time;
      const ageMin = (ageMs / 60000).toFixed(1);

      // Target sold → exit immediately
      if(wallet.emergencyQueue.has(mint)) {
        wallet.emergencyQueue.delete(mint);
        if(!pos.whaleSoldAt) {
          pos.whaleSoldAt = Date.now();
          pos.isSelling   = true;
          log('EMERGENCY', `🚨 TARGET SOLD ${pos.sym} — exiting`);
          await discord(`🚨  **TARGET SOLD — ${pos.sym}**\nExiting immediately`);
          execSell(mint, 'target_sold', true)
            .catch(e => log('ERROR', `Target-sold: ${e.message}`));
        }
        continue;
      }

      // 15min hard exit
      if(ageMs >= CONFIG.MAX_HOLD_MS) {
        pos.isSelling = true;
        log('EXIT', `⏱ 15MIN EXIT ${pos.sym}`);
        await discord(`⏱  **15MIN EXIT — ${pos.sym}**\nMax hold reached — full exit`);
        execSell(mint, 'max_hold_15min', false)
          .catch(e => log('ERROR', `15min exit: ${e.message}`));
        continue;
      }

      // ROI check
      const roi = await getCurrentRoi(mint, pos);
      if(roi === null) continue;
      if(roi > pos.highestRoi) pos.highestRoi = roi;

      const timeLeft = ((CONFIG.MAX_HOLD_MS - ageMs) / 60000).toFixed(1);
      const bar = roi >= 0
        ? '█'.repeat(Math.min(Math.floor(roi/3),20)) + '░'.repeat(Math.max(20-Math.floor(roi/3),0))
        : '▓'.repeat(Math.min(Math.floor(Math.abs(roi)/3),20));
      console.log(`  🪞 [${pos.sym}] ${pctStr(roi)} [${bar}] | ${ageMin}min | SL:${CONFIG.SL_PCT}% TP:+${CONFIG.TP_PCT}% | ${timeLeft}min left`);

      // Take profit at +25%
      if(roi >= CONFIG.TP_PCT && !pos.tpFired) {
        pos.tpFired   = true;
        pos.isSelling = true;
        log('EXIT', `🎯 TP ${pctStr(roi)} on ${pos.sym} — full exit`);
        execSell(mint, `TP_${roi.toFixed(0)}pct`, false)
          .catch(e => {
            pos.tpFired   = false;
            pos.isSelling = false;
            log('ERROR', `TP sell failed, retrying: ${e.message}`);
          });
        continue;
      }

      // Stop loss at -20%
      if(roi <= CONFIG.SL_PCT) {
        pos.isSelling = true;
        log('EXIT', `🛑 STOP LOSS ${pos.sym} at ${pctStr(roi)}`);
        await discord(
          `🛑  **STOP LOSS — ${pos.sym}**\n` +
          `📉  **${pctStr(roi)}** (~-$${SOL_USD(Math.abs(pos.sol*roi/100))}) after **${ageMin}min**`
        );
        execSell(mint, `SL_${roi.toFixed(0)}pct`, false)
          .catch(e => log('ERROR', `SL exit: ${e.message}`));
      }
    }
  }
}

// ── HELIUS WEBSOCKET — WATCH TARGET WALLET ────────────────────
// Subscribes to all logs that mention the target wallet address
// Fires every time target does anything on-chain

function connectHelius() {
  log('INFO', `🪞 Connecting to Helius — watching ${CONFIG.TARGET.slice(0,20)}...`);

  const ws = new WebSocket(CONFIG.HELIUS_WS);
  shared.ws = ws;

  ws.on('open', () => {
    log('INFO', `✅ Helius WS connected — subscribing to target wallet logs`);
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'logsSubscribe',
      params: [
        { mentions: [CONFIG.TARGET] },
        { commitment: 'confirmed' },
      ],
    }));
  });

  ws.on('message', async (raw) => {
    shared.wsEvents++;
    try {
      const msg = JSON.parse(raw.toString());

      if(msg.id === 1 && msg.result !== undefined) {
        log('INFO', `✅ logsSubscribe confirmed subId:${msg.result} — watching target`);
        return;
      }

      if(!msg.params?.result?.value) return;
      const value = msg.params.result.value;
      const sig   = value.signature;
      const logs  = value.logs || [];

      // Only process swap/trade transactions — skip transfers, fees, etc
      const isSwap = logs.some(l =>
        l.includes('Instruction: Buy') ||
        l.includes('Instruction: Sell') ||
        l.includes('swap') || l.includes('Swap') ||
        l.includes('ray_log')
      );
      if(!isSwap) return;

      // Fetch full transaction to determine buy/sell and mint
      fetchTargetTrade(sig)
        .catch(e => log('ERROR', `fetchTargetTrade: ${e.message}`));

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

// ── PARSE TARGET TRADE ────────────────────────────────────────

async function fetchTargetTrade(sig) {
  try {
    // Use Helius enhanced API to parse the transaction
    const r = await safeFetch(CONFIG.HELIUS_TX, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: [sig] }),
    }, 'target-trade');
    if(!r.ok) throw new Error(`TX fetch ${r.status}`);

    const txs = await r.json();
    const tx  = txs?.[0];
    if(!tx || tx.transactionError) return;

    const tfers  = tx.tokenTransfers  || [];
    const native = tx.nativeTransfers || [];

    // Calculate SOL in/out for target wallet
    let solOut = 0, solIn = 0;
    for(const t of native) {
      if(t.fromUserAccount === CONFIG.TARGET) solOut += (t.amount||0) / 1e9;
      if(t.toUserAccount   === CONFIG.TARGET) solIn  += (t.amount||0) / 1e9;
    }

    const buys = [], sells = [];
    for(const t of tfers) {
      if(IGNORE_MINTS.has(t.mint) || t.mint === CONFIG.SOL_MINT) continue;
      if(t.toUserAccount   === CONFIG.TARGET && t.tokenAmount > 0) buys.push(t.mint);
      if(t.fromUserAccount === CONFIG.TARGET && t.tokenAmount > 0) sells.push(t.mint);
    }

    // Handle sells — queue emergency exit if we hold it
    for(const mint of sells) {
      if(wallet.positions.has(mint) && !wallet.positions.get(mint).isSelling) {
        log('EMERGENCY', `🚨 TARGET SOLD ${mint.slice(0,12)}...`);
        wallet.emergencyQueue.add(mint);
      }
    }

    // Handle buys — copy if in signal range
    for(const mint of buys) {
      if(wallet.tradedMints.has(mint)) continue;
      if(wallet.positions.has(mint)) continue;
      if(IGNORE_MINTS.has(mint)) continue;

      const inRange = solOut >= CONFIG.MIN_BUY_SOL_SIGNAL && solOut <= CONFIG.MAX_BUY_SOL_SIGNAL;
      if(!inRange) {
        log('SKIP', `${mint.slice(0,10)} — ${solOut.toFixed(3)} SOL outside ${CONFIG.MIN_BUY_SOL_SIGNAL}–${CONFIG.MAX_BUY_SOL_SIGNAL} range`);
        return;
      }

      // Max positions check
      if(wallet.positions.size >= CONFIG.MAX_CONCURRENT_POSITIONS) {
        wallet.stats.skipped++;
        log('SKIP', `Max positions (${CONFIG.MAX_CONCURRENT_POSITIONS}) — skipping`);
        await discord(`⏭  **MAX POSITIONS** — skipped copy of \`${mint.slice(0,16)}\``);
        return;
      }

      // Balance check
      const bal = await solBal();
      if(bal < CONFIG.MIN_SOL_BALANCE) {
        wallet.stats.skipped++;
        log('SKIP', `Low balance ${bal.toFixed(4)} SOL`);
        await discord(`⚠️  **LOW BALANCE** — ${bal.toFixed(4)} SOL | Need ${CONFIG.MIN_SOL_BALANCE} SOL`);
        return;
      }

      shared.copiedBuys++;
      wallet.tradedMints.add(mint);
      log('COPY', `🪞 COPYING BUY — target:${solOut.toFixed(3)} SOL ours:${CONFIG.BUY_SOL} SOL | ${mint.slice(0,12)}...`);
      execBuy(mint, solOut)
        .catch(e => log('ERROR', `execBuy: ${e.message}`));
    }
  } catch(e) { log('ERROR', `fetchTargetTrade: ${e.message}`); }
}

// ── HEALTH ────────────────────────────────────────────────────

async function health() {
  while(shared.isRunning) {
    await sleep(CONFIG.HEALTH_MS);
    const bal     = await solBal();
    const pnl     = bal - wallet.stats.startBal;
    const wr      = wallet.stats.sells > 0 ? ((wallet.stats.wins/wallet.stats.sells)*100).toFixed(0) : '0';
    const uptime  = ((Date.now() - wallet.stats.startTime) / 60000).toFixed(0);
    const wsState = shared.ws?.readyState === WebSocket.OPEN ? '🟢 LIVE' : '🔴 RECONNECTING';

    const lines = [
      '',
      '═'.repeat(62),
      '  🪞 WINSTON v29.0 — Wallet Copy Bot',
      '═'.repeat(62),
      `  📡 Helius WS: ${wsState} | Events: ${shared.wsEvents} | Uptime: ${uptime}min`,
      `  🎯 Target: ${CONFIG.TARGET.slice(0,24)}...`,
      `  💸  Buy: ${CONFIG.BUY_SOL} SOL ($${SOL_USD(CONFIG.BUY_SOL)}) | TP:+${CONFIG.TP_PCT}% | SL:${CONFIG.SL_PCT}% | Max:15min`,
      `  🪞  Copied: ${shared.copiedBuys} | Skipped: ${wallet.stats.skipped}`,
      `  💰  ${bal.toFixed(4)} SOL ($${SOL_USD(bal)}) | PnL: ${pnl>=0?'+':''}${pnl.toFixed(4)} SOL`,
      `  📊  ${wallet.stats.wins}W/${wallet.stats.losses}L (${wr}% WR) | Fees: ${wallet.stats.feesTotal.toFixed(4)} SOL`,
    ];

    if(wallet.positions.size > 0) {
      for(const [m, p] of wallet.positions) {
        const age  = ((Date.now()-p.time)/60000).toFixed(1);
        const left = ((CONFIG.MAX_HOLD_MS-(Date.now()-p.time))/60000).toFixed(1);
        lines.push(`  📦 ${p.sym} ${m.slice(0,8)}... | ${age}min | ${left}min left`);
      }
    } else {
      lines.push('  📭 No open positions — watching target');
    }
    lines.push('═'.repeat(62));
    console.log(lines.join('\n'));
  }
}

// ── MAIN ──────────────────────────────────────────────────────

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  🪞 WINSTON v29.0 — Wallet Copy Bot                        ║');
  console.log('║  $5 buy · TP+25% · SL-20% · 15min max · copy EqiFgy...   ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

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
    `🪞  **WINSTON v29.0 ONLINE**\n` +
    `**Wallet Copy Bot**\n` +
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `🎯  Copying: \`${CONFIG.TARGET}\`\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💸  Buy: **${CONFIG.BUY_SOL} SOL (~$${SOL_USD(CONFIG.BUY_SOL)})** fixed\n` +
    `📏  Signal: **${CONFIG.MIN_BUY_SOL_SIGNAL}–${CONFIG.MAX_BUY_SOL_SIGNAL} SOL** buys only\n` +
    `🎯  TP: **+${CONFIG.TP_PCT}%** → full exit\n` +
    `🛑  SL: **${CONFIG.SL_PCT}%** → full exit\n` +
    `⏱  Max: **15 minutes**\n` +
    `🚨  Target sells → we exit immediately\n` +
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
      `🔴  **WINSTON v29.0 OFFLINE**\n` +
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
      `💰  Final: **${finalBal.toFixed(4)} SOL** (~$${SOL_USD(finalBal)})\n` +
      `📈  PnL: **${pnl>=0?'+':''}$${SOL_USD(Math.abs(pnl))}** (${pnl>=0?'+':''}${pnl.toFixed(4)} SOL)\n` +
      `📊  **${wallet.stats.wins}W / ${wallet.stats.losses}L** (${wr}% WR) | ${wallet.stats.buys} buys\n` +
      `💸  Fees: **${wallet.stats.feesTotal.toFixed(4)} SOL**\n` +
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
            body: JSON.stringify({ content: `💥  **WINSTON v29 CRASHED #${crashCount}**\n❌  ${e.message}\nRestarting in 5s...` }),
          });
        }
      } catch(_) {}
      if(shared.ws) { try { shared.ws.close(); } catch(_) {} }
      shared.isRunning = false;
      shared.ws        = null;
      wallet.positions.clear();
      wallet.emergencyQueue.clear();
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

runWithFailsafe();
