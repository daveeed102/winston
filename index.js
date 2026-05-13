// ============================================================
// WINSTON v28.0 — Pump.fun Graduation Sniper
// ⚠️  HIGH RISK — for educational/personal use only
// ============================================================
// Strategy:
//   1. Listen to PumpPortal WebSocket for graduation events
//      (fires the instant a token completes its bonding curve)
//   2. Buy 0.055 SOL (~$5) immediately via Jupiter
//   3. TP at +35% → full exit
//   4. SL at -30% → full exit
//   5. 10min max hold → full exit (graduation pumps are fast)
//   6. Skip token if rug check fails
//
// Why this works:
//   - Graduation injects ~$12K liquidity into a fresh pool
//   - Creates immediate price discovery pump as traders pile in
//   - We detect it at the SOURCE (Helius WS) not by
//     polling someone else's wallet — faster than copy trading
//
// Detection method:
//   PumpPortal subscribeMigration WebSocket — fires instantly
//   on graduation, no polling delay
//
// Fee config — minimum viable for $5 buys:
//   Buy:       0.0002 SOL
//   Sell:      0.0003 SOL
//   Emergency: 0.001  SOL
//
// Crash failsafe: auto-restarts on any unhandled error
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

  JUPITER_QUOTE: 'https://lite-api.jup.ag/swap/v1/quote',
  JUPITER_SWAP:  'https://lite-api.jup.ag/swap/v1/swap',

  // Helius WebSocket — uses your existing env var
  get HELIUS_WS() { return process.env.HELIUS_WS_URL || `wss://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },

  // Pump.fun program IDs — both old (Raydium) and new (PumpSwap) graduation
  PUMPFUN_PROGRAM:  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  PUMPSWAP_PROGRAM: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  // Migration account — triggers when bonding curve completes
  MIGRATION_ACCOUNT: '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg',

  // ── Trade config ─────────────────────────────────────────
  BUY_SOL:         0.055,   // ~$5
  MIN_SOL_BALANCE: 0.065,   // 0.055 buy + 0.01 fee buffer

  // ── Exit ─────────────────────────────────────────────────
  TP_ROI_PCT:   35,     // full exit at +35%
  SL_PCT:      -30,    // full exit at -30%
  MAX_HOLD_MS:  600000, // 10min — graduation pumps are fast

  // ── Rug check ────────────────────────────────────────────
  // Skip tokens with rugcheck score below this
  // 500+ = relatively safe, 0-499 = risky
  MIN_RUGCHECK_SCORE: 300,
  RUGCHECK_ENABLED:   true,

  // ── Fees — minimum viable ────────────────────────────────
  BUY_PRIORITY_LAMPORTS:       200000,  // 0.0002 SOL
  BUY_SLIPPAGE_BPS:             500,    // 5% — graduation pools have low liquidity initially
  SELL_PRIORITY_LAMPORTS:      300000,  // 0.0003 SOL
  SELL_SLIPPAGE_BPS:            800,    // 8%
  EMERGENCY_PRIORITY_LAMPORTS: 1000000, // 0.001 SOL
  EMERGENCY_SLIPPAGE_BPS:      2500,    // 25% — get out no matter what

  // ── Rate limits ──────────────────────────────────────────
  EXIT_CHECK_MS: 2000,
  HEALTH_MS:     60000,

  MAX_CONCURRENT_POSITIONS: 3, // don't overextend on $5 buys
  SELL_MAX_RETRIES: 10,
  BUY_MAX_RETRIES:   2,   // fast fail on buys — graduation window is short
  SOL_MINT: 'So11111111111111111111111111111111111111112',
};

// ── State ─────────────────────────────────────────────────────
const wallet = {
  keypair:        null,
  positions:      new Map(),   // mint → position
  snipedMints:    new Set(),   // mints already attempted this session
  stats: {
    attempts: 0, buys: 0, sells: 0,
    wins: 0, losses: 0, totalPnl: 0,
    errors: 0, skipped: 0, feesTotal: 0,
    startBal: 0, startTime: Date.now(),
  },
};

const shared = { connection: null, isRunning: false, ws: null, wsEvents: 0, graduations: 0 };

// ── UTILS ─────────────────────────────────────────────────────

function log(lv, msg, d={}) {
  const ts = new Date().toISOString();
  const ic = {
    INFO:'📡', BUY:'🟢', SELL:'🔴', EXEC:'⚡', ERROR:'❌',
    SNIPE:'🎯', EXIT:'🏁', EMERGENCY:'🚨', SKIP:'⏭', GRAD:'🎓',
  };
  console.log(`[${ts}] ${ic[lv]||'📋'} [${lv}] ${msg}${Object.keys(d).length?' '+JSON.stringify(d):''}`);
}

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const SOL_USD = (sol) => (sol * 96).toFixed(2);
const pctStr  = (n)   => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

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
    log('ERROR', `429 on ${label || url.slice(0,40)} — sleeping 3s`);
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
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg.slice(0, 1990) }),
    });
  } catch(e) {}
}

// ── RUG CHECK ─────────────────────────────────────────────────
// Uses rugcheck.xyz — free, no API key needed
// Returns score 0-1000 (higher = safer)

async function rugCheck(mint) {
  if(!CONFIG.RUGCHECK_ENABLED) return { pass: true, score: 999, reason: 'disabled' };
  try {
    const r = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, {
      headers: { 'Accept': 'application/json' },
    });
    if(!r.ok) return { pass: true, score: 500, reason: 'rugcheck unavailable' }; // fail open
    const d = await r.json();
    const score = d?.score || 0;
    const risks = (d?.risks || []).map(r => r.name).join(', ');
    const pass  = score >= CONFIG.MIN_RUGCHECK_SCORE;
    return { pass, score, risks: risks || 'none' };
  } catch(e) {
    return { pass: true, score: 500, reason: 'rugcheck error — proceeding' }; // fail open
  }
}

// ── CONFIRM TX ────────────────────────────────────────────────

async function confirm(sig, timeout=60000) {
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

    const qr = await safeFetch(
      `${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL_MINT}&amount=${raw.toString()}&slippageBps=1000`,
      {}, 'roi-quote'
    );
    if(!qr.ok) return null;
    const q = await qr.json();
    if(!q.outAmount) return null;
    return ((parseFloat(q.outAmount) / 1e9 / pos.sol) - 1) * 100;
  } catch(e) { return null; }
}

// ── SELL ──────────────────────────────────────────────────────

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
    const sig = await shared.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true, maxRetries: 8,
    });

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

      const wr = wallet.stats.sells > 0
        ? ((wallet.stats.wins/wallet.stats.sells)*100).toFixed(0) : '0';

      log('SELL', `✅ ${info.sym} → ${solBack.toFixed(4)} SOL (${pnlSign}${pnl.toFixed(4)}) | ${reason} | WR:${wr}%`);

      const exitLabel =
          reason.startsWith('TP')         ? '🏁 TAKE PROFIT'
        : reason.startsWith('SL')         ? '🛑 STOP LOSS'
        : reason.startsWith('max_hold')   ? '⏱ 10MIN EXIT'
        : reason.startsWith('emergency')  ? '🚨 EMERGENCY'
        : '🔴 SELL';

      const dMsg = [
        `${exitLabel} — **${info.sym}** 🎓`,
        '━━━━━━━━━━━━━━━━━━━━',
        `📥  Entry:  **$${SOL_USD(pos.sol)}** (${pos.sol.toFixed(4)} SOL)`,
        `📤  Exit:   **$${SOL_USD(solBack)}** (${solBack.toFixed(4)} SOL)`,
        `${pnlEmoji}  PnL:    **${pnlSign}$${SOL_USD(Math.abs(pnl))}** (${pnlSign}${pnl.toFixed(4)} SOL / ${pctStr(roiPct)})`,
        `💸  Fee:    ~$${SOL_USD(feeSol)}`,
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
      await sleep((emergency ? 1500 : 2500) * attempt + Math.floor(Math.random()*500));
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

// ── BUY ───────────────────────────────────────────────────────

async function execBuy(mint, tokenName, attempt=1) {
  const sol      = CONFIG.BUY_SOL;
  const lamports = Math.floor(sol * 1e9);
  const feeSol   = CONFIG.BUY_PRIORITY_LAMPORTS / 1e9;
  const sym      = tokenName || '???';

  log('SNIPE', `⚡ SNIPING ${sym} ${sol} SOL (attempt ${attempt})`, { mint: mint.slice(0,12) });

  try {
    const qr = await safeFetch(
      `${CONFIG.JUPITER_QUOTE}?inputMint=${CONFIG.SOL_MINT}&outputMint=${mint}&amount=${lamports}&slippageBps=${CONFIG.BUY_SLIPPAGE_BPS}`,
      {}, 'buy-quote'
    );
    if(!qr.ok) throw new Error(`Quote ${qr.status}`);
    const q = await qr.json();
    if(!q.outAmount || q.outAmount==='0') throw new Error('No route yet — pool may not be live');

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
    const sig = await shared.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true, maxRetries: 5,
    });

    if(await confirm(sig)) {
      wallet.positions.set(mint, {
        time:       Date.now(),
        sol,
        sym,
        isSelling:  false,
        tpFired:    false,
        highestRoi: -Infinity,
      });
      wallet.stats.buys++;
      wallet.stats.feesTotal += feeSol;

      log('BUY', `✅ SNIPED ${sym} — ${sol} SOL | TP:+${CONFIG.TP_ROI_PCT}% SL:${CONFIG.SL_PCT}% Max:10min`);
      await discord(
        `🎓  **GRADUATION SNIPE — ${sym}**\n` +
        `\`${mint}\`\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💸  Bought: **${sol} SOL** (~$${SOL_USD(sol)})\n` +
        `💸  Buy fee: ~$${SOL_USD(feeSol)}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🏁  TP: **+${CONFIG.TP_ROI_PCT}%** → full exit\n` +
        `🛑  SL: **${CONFIG.SL_PCT}%** → full exit\n` +
        `⏱  Max hold: **10 minutes**\n` +
        `🔗  https://solscan.io/tx/${sig}\n` +
        `📊  https://dexscreener.com/solana/${mint}`
      );
      return true;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    log('ERROR', `Buy fail (attempt ${attempt}): ${e.message}`);
    // If "no route" — pool not live yet, retry quickly
    const isNoRoute = e.message.includes('No route') || e.message.includes('no route');
    if(attempt < CONFIG.BUY_MAX_RETRIES) {
      const delay = isNoRoute ? 1500 : 2000; // faster retry for no-route
      await sleep(delay);
      return execBuy(mint, tokenName, attempt+1);
    }
    wallet.stats.errors++;
    await discord(`❌  **SNIPE FAILED** — ${sym}\n\`${mint.slice(0,20)}\`\n${e.message}`);
    return false;
  }
}

// ── EXIT MANAGER ──────────────────────────────────────────────

async function exitManager() {
  log('INFO', `🏁 Exit manager | TP:+${CONFIG.TP_ROI_PCT}% SL:${CONFIG.SL_PCT}% Max:10min`);

  while(shared.isRunning) {
    await sleep(CONFIG.EXIT_CHECK_MS);

    for(const [mint, pos] of wallet.positions) {
      if(pos.isSelling) continue;

      const ageMs  = Date.now() - pos.time;
      const ageMin = (ageMs / 60000).toFixed(1);

      // 10min hard exit — graduation pumps fade fast
      if(ageMs >= CONFIG.MAX_HOLD_MS) {
        pos.isSelling = true;
        log('EXIT', `⏱ 10MIN EXIT ${pos.sym}`);
        await discord(`⏱  **10MIN EXIT — ${pos.sym}**\nGraduation window expired — full exit`);
        execSell(mint, 'max_hold_10min', false)
          .catch(e => log('ERROR', `10min exit: ${e.message}`));
        continue;
      }

      const roi = await getCurrentRoi(mint, pos);
      if(roi === null) continue;
      if(roi > pos.highestRoi) pos.highestRoi = roi;

      const timeLeft = ((CONFIG.MAX_HOLD_MS - ageMs) / 60000).toFixed(1);
      const bar = roi >= 0
        ? '█'.repeat(Math.min(Math.floor(roi/5),20)) + '░'.repeat(Math.max(20-Math.floor(roi/5),0))
        : '▓'.repeat(Math.min(Math.floor(Math.abs(roi)/5),20));
      console.log(`  🎓 [${pos.sym}] ${pctStr(roi)} [${bar}] | ${ageMin}min | SL:${CONFIG.SL_PCT}% TP:+${CONFIG.TP_ROI_PCT}% | ${timeLeft}min left`);

      // Take profit
      if(roi >= CONFIG.TP_ROI_PCT && !pos.tpFired) {
        pos.tpFired   = true;
        pos.isSelling = true;
        log('EXIT', `🏁 TP ${pctStr(roi)} on ${pos.sym} — full exit`);
        execSell(mint, `TP_${roi.toFixed(0)}pct`, false)
          .catch(e => {
            pos.tpFired   = false;
            pos.isSelling = false;
            log('ERROR', `TP sell failed, retrying: ${e.message}`);
          });
        continue;
      }

      // Stop loss
      if(roi <= CONFIG.SL_PCT) {
        pos.isSelling = true;
        log('EXIT', `🛑 STOP LOSS ${pos.sym} at ${pctStr(roi)}`);
        await discord(
          `🛑  **STOP LOSS — ${pos.sym}**\n` +
          `📉  **${pctStr(roi)}** after **${ageMin}min**`
        );
        execSell(mint, `SL_${roi.toFixed(0)}pct`, false)
          .catch(e => log('ERROR', `SL exit: ${e.message}`));
      }
    }
  }
}

// ── HELIUS WEBSOCKET ─────────────────────────────────────────
// ── HELIUS WEBSOCKET — GRADUATION DETECTOR ────────────────────
// Uses logsSubscribe to watch the Pump.fun migration account
// Fires the instant a token completes its bonding curve

function connectHelius() {
  log('INFO', `🎓 Connecting to Helius WebSocket...`);

  const ws = new WebSocket(CONFIG.HELIUS_WS);
  shared.ws = ws;
  let subId = null;

  ws.on('open', () => {
    log('INFO', `✅ Helius WS connected — subscribing to Pump.fun migration logs`);
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'logsSubscribe',
      params: [
        { mentions: [CONFIG.MIGRATION_ACCOUNT] },
        { commitment: 'confirmed' },
      ],
    }));
    log('INFO', `📡 Watching migration account: ${CONFIG.MIGRATION_ACCOUNT.slice(0,20)}...`);
  });

  ws.on('message', async (raw) => {
    shared.wsEvents++;
    try {
      const msg = JSON.parse(raw.toString());

      // Subscription confirmation
      if(msg.id === 1 && msg.result !== undefined) {
        subId = msg.result;
        log('INFO', `✅ logsSubscribe confirmed subId:${subId} — watching for graduations`);
        return;
      }

      if(!msg.params?.result?.value) return;

      const value = msg.params.result.value;
      const logs  = value.logs || [];
      const sig   = value.signature;

      // Filter for graduation/migration instructions
      const isMigration = logs.some(l =>
        l.includes('MigrateFunds') || l.includes('migrate') || l.includes('Migrate')
      );
      if(!isMigration) return;

      log('GRAD', `🎓 GRADUATION TX — sig:${sig?.slice(0,20)}...`);
      shared.graduations++;

      fetchGraduationMint(sig)
        .catch(e => log('ERROR', `fetchGraduationMint: ${e.message}`));

    } catch(e) { log('ERROR', `WS msg error: ${e.message}`); }
  });

  ws.on('error', (e) => log('ERROR', `Helius WS error: ${e.message}`));

  ws.on('close', (code) => {
    log('INFO', `Helius WS closed (${code}) — reconnecting in 3s...`);
    shared.ws = null;
    if(shared.isRunning) setTimeout(connectHelius, 3000);
  });

  const ping = setInterval(() => {
    if(ws.readyState === WebSocket.OPEN) ws.ping();
    else clearInterval(ping);
  }, 30000);
}

// ── FETCH MINT FROM GRADUATION TX ─────────────────────────────

async function fetchGraduationMint(sig) {
  try {
    const r = await safeFetch(
      `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${CONFIG.HELIUS_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: [sig] }),
      }, 'graduation-tx'
    );
    if(!r.ok) throw new Error(`TX fetch ${r.status}`);
    const txs = await r.json();
    const tx  = txs?.[0];
    if(!tx) throw new Error('No tx data');

    const IGNORE_MINTS = new Set([
      'So11111111111111111111111111111111111111112',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    ]);

    let mint = null;
    for(const t of (tx.tokenTransfers||[])) {
      if(t.mint && !IGNORE_MINTS.has(t.mint)) { mint = t.mint; break; }
    }
    if(!mint) {
      for(const a of (tx.accountData||[])) {
        for(const c of (a.tokenBalanceChanges||[])) {
          if(c.mint && !IGNORE_MINTS.has(c.mint)) { mint = c.mint; break; }
        }
        if(mint) break;
      }
    }

    if(!mint) { log('INFO', `⚠️  No mint found in graduation tx`); return; }
    log('GRAD', `🎓 Mint: ${mint.slice(0,20)}...`);
    await handleGraduation(mint, sig);
  } catch(e) { log('ERROR', `fetchGraduationMint: ${e.message}`); }
}

// ── HANDLE GRADUATION ─────────────────────────────────────────

async function handleGraduation(mint, sig) {
  const info = await tokenInfo(mint);
  const sym  = info.sym;
  const name = info.name;

  if(wallet.snipedMints.has(mint)) { log('SKIP', `Already sniped ${sym}`); return; }

  if(wallet.positions.size >= CONFIG.MAX_CONCURRENT_POSITIONS) {
    wallet.stats.skipped++;
    log('SKIP', `Max positions — skipping ${sym}`);
    await discord(`⏭  **SKIPPED — max positions**
🎓 **${sym}**
\`${mint}\``);
    return;
  }

  const bal = await solBal();
  if(bal < CONFIG.MIN_SOL_BALANCE) {
    wallet.stats.skipped++;
    log('SKIP', `Low balance ${bal.toFixed(4)} SOL`);
    await discord(`⚠️  **LOW BALANCE — SKIPPED**
💰  ${bal.toFixed(4)} SOL | Need ${CONFIG.MIN_SOL_BALANCE} SOL`);
    return;
  }

  wallet.stats.attempts++;
  wallet.snipedMints.add(mint);

  log('INFO', `🔍 Rug checking ${sym}...`);
  const rug = await rugCheck(mint);
  if(!rug.pass) {
    wallet.stats.skipped++;
    log('SKIP', `Rug FAILED ${sym} score:${rug.score}`);
    await discord(`⏭  **SKIPPED — RUG CHECK**
🎓 **${sym}**
🚨 Score: ${rug.score}/1000
\`${mint}\``);
    return;
  }

  log('INFO', `✅ Rug passed ${sym} score:${rug.score} — BUYING`);
  await discord(
    `🎓  **GRADUATION — ${name} (${sym})**
` +
    `\`${mint}\`
━━━━━━━━━━━━━━━━━━━━
` +
    `✅  Rug score: **${rug.score}/1000**
` +
    `🚀  Sniping **${CONFIG.BUY_SOL} SOL** (~$${SOL_USD(CONFIG.BUY_SOL)}) NOW
` +
    `🔗  https://solscan.io/tx/${sig}
` +
    `📊  https://dexscreener.com/solana/${mint}`
  );

  execBuy(mint, sym).catch(e => log('ERROR', `execBuy: ${e.message}`));
}


// ── HEALTH ────────────────────────────────────────────────────

async function health() {
  while(shared.isRunning) {
    await sleep(CONFIG.HEALTH_MS);
    const bal      = await solBal();
    const pnl      = bal - wallet.stats.startBal;
    const wr       = wallet.stats.sells > 0
      ? ((wallet.stats.wins/wallet.stats.sells)*100).toFixed(0) : '0';
    const wsStatus = shared.ws?.readyState === WebSocket.OPEN ? '🟢 LIVE' : '🔴 RECONNECTING';
    const uptime   = ((Date.now() - wallet.stats.startTime) / 60000).toFixed(0);

    const lines = [
      '',
      '═'.repeat(62),
      '  🎓 WINSTON v28.0 — Graduation Sniper',
      '═'.repeat(62),
      `  📡 PumpPortal: ${wsStatus} | WS events: ${shared.wsEvents} | Uptime: ${uptime}min`,
      `  🎓 Graduations seen: ${shared.graduations} | Sniped: ${wallet.stats.buys} | Skipped: ${wallet.stats.skipped}`,
      `  💸  Buy: ${CONFIG.BUY_SOL} SOL ($${SOL_USD(CONFIG.BUY_SOL)}) | TP:+${CONFIG.TP_ROI_PCT}% | SL:${CONFIG.SL_PCT}% | Max:10min`,
      `  💰  ${bal.toFixed(4)} SOL ($${SOL_USD(bal)}) | PnL: ${pnl>=0?'+':''}${pnl.toFixed(4)} SOL`,
      `  📊  ${wallet.stats.wins}W/${wallet.stats.losses}L (${wr}% WR) | Fees: ${wallet.stats.feesTotal.toFixed(4)} SOL`,
    ];

    if(wallet.positions.size > 0) {
      for(const [m, p] of wallet.positions) {
        const age      = ((Date.now()-p.time)/60000).toFixed(1);
        const timeLeft = ((CONFIG.MAX_HOLD_MS-(Date.now()-p.time))/60000).toFixed(1);
        lines.push(`  📦 ${p.sym} ${m.slice(0,8)}... | ${age}min | ${timeLeft}min left`);
      }
    } else {
      lines.push('  📭 Watching for graduations...');
    }
    lines.push('═'.repeat(62));

    // Print all at once to avoid interleaving
    console.log(lines.join('\n'));
  }
}

// ── MAIN ──────────────────────────────────────────────────────

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  🎓 WINSTON v28.0 — Pump.fun Graduation Sniper             ║');
  console.log('║  $5 buy · TP+35% · SL-30% · 10min max · rug check        ║');
  console.log('║  Listens via Helius logsSubscribe — your own RPC          ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  if(!CONFIG.HELIUS_API_KEY) { log('ERROR', 'HELIUS_API_KEY missing'); process.exit(1); }
  if(!CONFIG.PRIVATE_KEY)    { log('ERROR', 'WALLET_PRIVATE_KEY missing'); process.exit(1); }

  try {
    wallet.keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
    log('INFO', `Wallet: ${wallet.keypair.publicKey.toString()}`);
  } catch(e) { log('ERROR', `Bad private key: ${e.message}`); process.exit(1); }

  shared.connection = new Connection(CONFIG.HELIUS_RPC, { commitment: 'confirmed' });

  wallet.stats.startBal = await solBal();
  log('INFO', `Balance: ${wallet.stats.startBal.toFixed(4)} SOL (~$${SOL_USD(wallet.stats.startBal)})`);

  if(wallet.stats.startBal < CONFIG.MIN_SOL_BALANCE) {
    log('ERROR', `Balance too low — need at least ${CONFIG.MIN_SOL_BALANCE} SOL`);
    process.exit(1);
  }

  shared.isRunning = true;

  // Connect to PumpPortal WebSocket
  connectHelius();

  await discord(
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `🎓  **WINSTON v28.1 ONLINE**\n` +
    `**Pump.fun Graduation Sniper**\n` +
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `📡  Listening for Pump.fun graduations via Helius logsSubscribe\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💸  Buy: **${CONFIG.BUY_SOL} SOL (~$${SOL_USD(CONFIG.BUY_SOL)})** per graduation\n` +
    `🏁  TP: **+${CONFIG.TP_ROI_PCT}%** → full exit\n` +
    `🛑  SL: **${CONFIG.SL_PCT}%** → full exit\n` +
    `⏱  Max hold: **10 minutes**\n` +
    `🔍  Rug check: **enabled** (min score: ${CONFIG.MIN_RUGCHECK_SCORE})\n` +
    `📦  Max concurrent: **${CONFIG.MAX_CONCURRENT_POSITIONS}** positions\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💰  Balance: **${wallet.stats.startBal.toFixed(4)} SOL** (~$${SOL_USD(wallet.stats.startBal)})\n` +
    `🔄  Crash failsafe: **active**\n` +
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
    const wr       = wallet.stats.sells > 0
      ? ((wallet.stats.wins/wallet.stats.sells)*100).toFixed(0) : '0';
    await discord(
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
      `🔴  **WINSTON v28.1 OFFLINE**\n` +
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
      `💰  Final: **${finalBal.toFixed(4)} SOL** (~$${SOL_USD(finalBal)})\n` +
      `📈  PnL: **${pnl>=0?'+':''}$${SOL_USD(Math.abs(pnl))}** (${pnl>=0?'+':''}${pnl.toFixed(4)} SOL)\n` +
      `📊  **${wallet.stats.wins}W / ${wallet.stats.losses}L** (${wr}% WR)\n` +
      `🎓  Graduations sniped: **${wallet.stats.buys}** | Skipped: **${wallet.stats.skipped}**\n` +
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
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: `💥  **WINSTON v28 CRASHED — restarting (#${crashCount})**\n❌  ${e.message}\nBack in 5s...`
            }),
          });
        }
      } catch(_) {}
      if(shared.ws) { try { shared.ws.close(); } catch(_) {} }
      shared.isRunning = false;
      shared.ws        = null;
      wallet.positions.clear();
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

runWithFailsafe();
