// ============================================================
// MOMENTUM RIDER v1.0 — Pump.fun Graduated Coin Scalper
// Strategy: watch graduated coins on Raydium
// Enter on confirmed upward momentum
// Ride for 20 seconds, exit fast
// ============================================================
require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58   = require('bs58');
const fetch  = require('node-fetch');
const fs     = require('fs');
const path   = require('path');
const WebSocket = require('ws');

// ── CONFIG ────────────────────────────────────────────────────
const C = {
  DRY_RUN:        process.env.DRY_RUN !== 'false',
  PRIVATE_KEY:    process.env.PRIVATE_KEY || process.env.WALLET_SECRET_KEY || '',
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  DISCORD:        process.env.DISCORD_WEBHOOK_URL || '',

  // Trade
  TRADE_SIZE_USD:   parseFloat(process.env.TRADE_SIZE_USD)  || 15,
  TAKE_PROFIT_PCT:  parseFloat(process.env.TAKE_PROFIT_PCT) || 35,   // +35% = exit
  STOP_LOSS_PCT:    parseFloat(process.env.STOP_LOSS_PCT)   || 45,   // -45% = exit
  HOLD_SECS:        parseInt(process.env.HOLD_SECS)         || 300,  // 5 min max hold
  MAX_OPEN:         parseInt(process.env.MAX_OPEN)          || 1,
  MAX_PER_HOUR:     parseInt(process.env.MAX_PER_HOUR)      || 30,

  // Momentum filter — must pass ALL of these to enter
  MIN_PRICE_TICKS_UP:   parseInt(process.env.MIN_TICKS_UP)       || 3,    // 3 consecutive up ticks
  MIN_MOMENTUM_PCT:     parseFloat(process.env.MIN_MOMENTUM_PCT) || 8,    // +8% in last 10s
  MAX_PRICE_IMPACT_PCT: parseFloat(process.env.MAX_IMPACT)       || 4,
  MIN_LIQUIDITY_USD:    parseFloat(process.env.MIN_LIQUIDITY)     || 1000, // $1K min — fresh grads start low
  SLIPPAGE_BPS:         parseInt(process.env.SLIPPAGE_BPS)        || 2500,

  // Only watch coins that graduated (migrated to Raydium)
  // These come through the pump.fun migration program
  PUMPFUN_MIGRATION: 'FRSMJmtB3HHJWKyAWWHhNjwJQp7JDdBqgHMCCcbJjvkN',
  PUMPFUN_PROGRAM:   '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',

  SOL_PRICE_USD: parseFloat(process.env.SOL_PRICE_USD) || 96,
  SOL_MINT:      'So11111111111111111111111111111111111111112',
  JUPITER_API:   'https://lite-api.jup.ag/swap/v1',

  get HELIUS_RPC(){ return this.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}` : 'https://api.mainnet-beta.solana.com'; },
  get HELIUS_WS() { return this.HELIUS_API_KEY ? `wss://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}` : null; },
};

// ── LOGGER ────────────────────────────────────────────────────
const TRADE_FILE = path.join(__dirname, 'trades.json');
if(!fs.existsSync(TRADE_FILE)) fs.writeFileSync(TRADE_FILE, '[]');
const LOG_FILE = path.join(__dirname, 'bot.log');

const COLORS = {
  BOOT:'\x1b[37m', TICK:'\x1b[36m', MOMENTUM:'\x1b[35m',
  BUY:'\x1b[92m', SELL:'\x1b[91m', EXIT:'\x1b[93m',
  SKIP:'\x1b[90m', ERROR:'\x1b[31m', INFO:'\x1b[37m', WARN:'\x1b[33m',
};

function log(tag, msg) {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [${tag}] ${msg}`;
  console.log((COLORS[tag]||'\x1b[37m') + line + '\x1b[0m');
  try { fs.appendFileSync(LOG_FILE, line+'\n'); } catch(e){}
}

function saveTrade(t) {
  try {
    const arr = JSON.parse(fs.readFileSync(TRADE_FILE,'utf8'));
    arr.push(t);
    fs.writeFileSync(TRADE_FILE, JSON.stringify(arr,null,2));
  } catch(e){}
}

async function discord(msg) {
  if(!C.DISCORD) return;
  try {
    await fetch(C.DISCORD, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({content:msg.slice(0,1990)}),
    });
  } catch(e){}
}

// ── SESSION ───────────────────────────────────────────────────
const session = {
  keypair:        null,
  connection:     null,
  startBal:       0,
  openPositions:  new Map(),   // mint → position
  watchedCoins:   new Map(),   // mint → coinState
  blacklist:      new Set(),
  tradesThisHour: 0,
  hourResetAt:    Date.now() + 3600000,
  totalPnl:       0,
  wins:           0,
  losses:         0,
};

function canTrade() {
  if(Date.now() > session.hourResetAt) {
    session.tradesThisHour = 0;
    session.hourResetAt = Date.now() + 3600000;
  }
  return session.openPositions.size < C.MAX_OPEN &&
         session.tradesThisHour < C.MAX_PER_HOUR;
}

// ── SOLANA UTILS ──────────────────────────────────────────────
async function getSolBal() {
  try { return (await session.connection.getBalance(session.keypair.publicKey)) / LAMPORTS_PER_SOL; }
  catch(e) { return 0; }
}

async function getTokenBal(mint) {
  try {
    const accts = await session.connection.getParsedTokenAccountsByOwner(
      session.keypair.publicKey, { mint: new PublicKey(mint) }
    );
    const a = accts?.value?.[0];
    if(!a) return { ui:0, raw:0n, dec:6 };
    const i = a.account.data.parsed.info.tokenAmount;
    return { ui: parseFloat(i.uiAmount||0), raw: BigInt(i.amount||0), dec: i.decimals };
  } catch(e) { return { ui:0, raw:0n, dec:6 }; }
}

// ── JUPITER ───────────────────────────────────────────────────
async function jupQuote(inMint, outMint, amount, slipBps) {
  try {
    const r = await fetch(`${C.JUPITER_API}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${slipBps}`);
    if(!r.ok) return null;
    const q = await r.json();
    return q.outAmount ? q : null;
  } catch(e) { return null; }
}

async function jupSwap(quote, attempt=1) {
  try {
    const r = await fetch(`${C.JUPITER_API}/swap`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        quoteResponse:       quote,
        userPublicKey:       session.keypair.publicKey.toString(),
        wrapAndUnwrapSol:    true,
        dynamicSlippage:     { minBps:50, maxBps:C.SLIPPAGE_BPS },
        prioritizationFeeLamports: 500000, // 0.0005 SOL priority — fast execution
      }),
    });
    if(!r.ok) return null;
    const d = await r.json();
    if(!d.swapTransaction) return null;

    const buf = Buffer.from(d.swapTransaction,'base64');
    const tx  = VersionedTransaction.deserialize(buf);
    tx.sign([session.keypair]);

    const sig = await session.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries:    3,
    });

    // Fast confirm loop
    const end = Date.now() + 15000;
    while(Date.now() < end) {
      const s = await session.connection.getSignatureStatuses([sig]);
      const v = s?.value?.[0];
      if(v?.err) return null;
      if(v?.confirmationStatus === 'confirmed' || v?.confirmationStatus === 'finalized') return sig;
      await new Promise(r=>setTimeout(r,300));
    }
    return null;
  } catch(e) {
    if(attempt < 3) { await new Promise(r=>setTimeout(r,200)); return jupSwap(quote, attempt+1); }
    return null;
  }
}

// ── PRICE FEED ────────────────────────────────────────────────
// Use DexScreener for price + liquidity data on graduated coins

const priceCache = new Map(); // mint → { price, liq, ts }

async function getPrice(mint) {
  // Try DexScreener first
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      headers: { 'Accept': 'application/json' }
    });
    if(r.ok) {
      const d = await r.json();
      // Accept any pair — raydium, orca, meteora, etc
      const pairs = (d.pairs||[]).filter(p => parseFloat(p.priceUsd||0) > 0);
      if(pairs.length) {
        // Prefer raydium, else take highest liquidity
        const raydium = pairs.filter(p => p.dexId === 'raydium');
        const best    = raydium.length ? raydium[0] : pairs.sort((a,b) => parseFloat(b.liquidity?.usd||0) - parseFloat(a.liquidity?.usd||0))[0];
        const price   = parseFloat(best.priceUsd||0);
        const liq     = parseFloat(best.liquidity?.usd||0);
        if(price > 0) {
          priceCache.set(mint, { price, liq, ts: Date.now() });
          return { price, liq };
        }
      }
    }
  } catch(e) {}

  // Fallback: Jupiter quote — works immediately after graduation even before DexScreener indexes
  try {
    const lamports = 10000000; // 0.01 SOL
    const r = await fetch(
      `${C.JUPITER_API}/quote?inputMint=${C.SOL_MINT}&outputMint=${mint}&amount=${lamports}&slippageBps=5000`
    );
    if(r.ok) {
      const q = await r.json();
      if(q.outAmount && parseFloat(q.outAmount) > 0) {
        // price = 0.01 SOL worth of USD / tokens received
        const tokensOut = parseFloat(q.outAmount) / 1e6; // assume 6 decimals
        const price     = (lamports / LAMPORTS_PER_SOL * C.SOL_PRICE_USD) / tokensOut;
        // No liquidity data from Jupiter, estimate from price impact
        const impact  = parseFloat(q.priceImpactPct||0) * 100;
        const liqEst  = impact > 0 ? (C.TRADE_SIZE_USD / (impact / 100)) : 5000;
        priceCache.set(mint, { price, liq: liqEst, ts: Date.now() });
        return { price, liq: liqEst };
      }
    }
  } catch(e) {}

  return null;
}

// ── COIN STATE ────────────────────────────────────────────────
function makeCoinState(mint, price, liq) {
  return {
    mint,
    firstSeen:   Date.now(),
    prices:      [{ p: price, t: Date.now() }],  // rolling price history
    price,
    liq,
    ticksUp:     0,
    ticksDown:   0,
    phase:       'watching', // watching → momentum → entered → done
  };
}

function updateCoin(state, price, liq) {
  const prev = state.price;
  state.price = price;
  state.liq   = liq;
  state.prices.push({ p: price, t: Date.now() });
  if(state.prices.length > 20) state.prices.shift();

  if(price > prev)      { state.ticksUp++;   state.ticksDown = 0; }
  else if(price < prev) { state.ticksDown++; state.ticksUp   = 0; }
}

function getMomentumPct(state) {
  // % gain over last 10 seconds
  const now      = Date.now();
  const cutoff   = now - 10000;
  const recent   = state.prices.filter(p => p.t >= cutoff);
  if(recent.length < 2) return 0;
  const oldest   = recent[0].p;
  const newest   = recent[recent.length-1].p;
  return oldest > 0 ? ((newest - oldest) / oldest) * 100 : 0;
}

// ── BUY ───────────────────────────────────────────────────────
async function enterTrade(mint, state) {
  if(!canTrade()) return;
  if(session.blacklist.has(mint)) return;

  const solBal     = await getSolBal();
  const tradeSol   = C.TRADE_SIZE_USD / C.SOL_PRICE_USD;
  const lamports   = Math.floor(tradeSol * LAMPORTS_PER_SOL);

  if(solBal < tradeSol + 0.005) {
    log('WARN', `Low balance: ${solBal.toFixed(4)} SOL`);
    return;
  }

  // Final momentum check + Jupiter quote
  const quote = await jupQuote(C.SOL_MINT, mint, lamports, C.SLIPPAGE_BPS);
  if(!quote) { log('SKIP', `${mint.slice(0,10)} — no Jupiter route`); return; }

  const impact = parseFloat(quote.priceImpactPct||0) * 100;
  if(impact > C.MAX_PRICE_IMPACT_PCT) {
    log('SKIP', `${mint.slice(0,10)} — impact ${impact.toFixed(1)}% too high`);
    return;
  }

  const momentumPct = getMomentumPct(state);
  log('MOMENTUM', `${mint.slice(0,10)} | ticks↑:${state.ticksUp} mom:+${momentumPct.toFixed(1)}% liq:$${(state.liq/1000).toFixed(0)}K impact:${impact.toFixed(1)}%`);

  state.phase = 'entered';
  session.tradesThisHour++;

  let sig = null;

  if(C.DRY_RUN) {
    sig = 'DRY_' + Date.now();
    log('BUY', `[DRY] ${mint.slice(0,10)} $${C.TRADE_SIZE_USD} @ $${state.price.toFixed(8)}`);
  } else {
    const t0 = Date.now();
    sig      = await jupSwap(quote);
    const ms = Date.now() - t0;

    if(!sig) {
      log('ERROR', `Buy failed: ${mint.slice(0,10)}`);
      state.phase = 'watching';
      return;
    }
    log('BUY', `✅ ${mint.slice(0,10)} $${C.TRADE_SIZE_USD} @ $${state.price.toFixed(8)} | ${ms}ms | ${sig.slice(0,20)}...`);
  }

  const tokBal = C.DRY_RUN
    ? { ui: parseFloat(quote.outAmount)/1e6, raw: BigInt(quote.outAmount), dec: 6 }
    : await getTokenBal(mint);

  const pos = {
    mint,
    entryPrice:   state.price,
    entryTime:    Date.now(),
    tradeSol,
    tokenAmt:     tokBal.ui,
    tokenRaw:     tokBal.raw,
    sig,
    dryRun:       C.DRY_RUN,
  };

  session.openPositions.set(mint, pos);

  await discord([
    `${C.DRY_RUN?'📋 DRY':'⚡ LIVE'} **BUY** — \`${mint.slice(0,12)}\``,
    `💸 $${C.TRADE_SIZE_USD} | Price: $${state.price.toFixed(8)} | Liq: $${(state.liq/1000).toFixed(0)}K`,
    `📈 Momentum: +${momentumPct.toFixed(1)}% | Ticks↑: ${state.ticksUp} | Impact: ${impact.toFixed(1)}%`,
    `⏱ Riding for **${C.HOLD_SECS}s** max`,
  ].join('\n'));

  // Start fast exit monitor
  monitorExit(mint);
}

// ── EXIT ──────────────────────────────────────────────────────
async function monitorExit(mint) {
  const pos = session.openPositions.get(mint);
  if(!pos) return;

  const CHECK_MS = 1000; // check every 1s for fast exit
  let checks = 0;

  const timer = setInterval(async () => {
    checks++;
    const pos = session.openPositions.get(mint);
    if(!pos) { clearInterval(timer); return; }

    const heldMs   = Date.now() - pos.entryTime;
    const heldSecs = heldMs / 1000;
    let roi        = 0;
    let exitReason = null;

    // Get current sell value
    try {
      if(pos.tokenRaw > 0n) {
        const sq = await jupQuote(mint, C.SOL_MINT, pos.tokenRaw.toString(), C.SLIPPAGE_BPS);
        if(sq?.outAmount) {
          const solBack = parseFloat(sq.outAmount) / LAMPORTS_PER_SOL;
          roi = ((solBack - pos.tradeSol) / pos.tradeSol) * 100;
        }
      }
    } catch(e){}

    // Exit conditions
    if(heldSecs >= C.HOLD_SECS)       exitReason = `timeout_${C.HOLD_SECS}s`;
    else if(roi >= C.TAKE_PROFIT_PCT)  exitReason = `tp_+${roi.toFixed(1)}%`;
    else if(roi <= -C.STOP_LOSS_PCT)   exitReason = `sl_${roi.toFixed(1)}%`;

    if(exitReason) {
      clearInterval(timer);
      await doSell(mint, exitReason, roi, heldSecs);
    }
  }, CHECK_MS);
}

async function doSell(mint, reason, roi, heldSecs) {
  const pos = session.openPositions.get(mint);
  if(!pos) return;
  session.openPositions.delete(mint);

  const pnlUsd  = C.TRADE_SIZE_USD * (roi / 100);
  const sign    = pnlUsd >= 0 ? '+' : '';
  const won     = pnlUsd >= 0;

  log('EXIT', `${mint.slice(0,10)} | ${reason} | ${sign}${roi.toFixed(1)}% | ${sign}$${pnlUsd.toFixed(3)} | ${heldSecs.toFixed(1)}s`);

  // Sell
  if(!pos.dryRun && pos.tokenRaw > 0n) {
    let sold = false;

    // Layer 1: Jupiter normal
    const q1 = await jupQuote(mint, C.SOL_MINT, pos.tokenRaw.toString(), C.SLIPPAGE_BPS);
    if(q1) {
      const s1 = await jupSwap(q1);
      if(s1) { sold = true; log('SELL', `Jupiter sell: ${s1.slice(0,20)}...`); }
    }

    // Layer 2: Jupiter 50% slippage
    if(!sold) {
      const q2 = await jupQuote(mint, C.SOL_MINT, pos.tokenRaw.toString(), 5000);
      if(q2) {
        const s2 = await jupSwap(q2);
        if(s2) { sold = true; log('SELL', `Jupiter (50% slip) sell: ${s2.slice(0,20)}...`); }
      }
    }

    // Layer 3: PumpPortal direct sell
    if(!sold) {
      log('WARN', `Jupiter failed — PumpPortal fallback`);
      try {
        const r = await fetch('https://pumpportal.fun/api/trade-local', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({
            publicKey:   session.keypair.publicKey.toString(),
            action:      'sell',
            mint,
            amount:      '100%',
            slippage:    50,
            priorityFee: 0.0005,
            pool:        'pump',
          }),
        });
        if(r.ok) {
          const buf = Buffer.from(await r.arrayBuffer());
          const tx  = VersionedTransaction.deserialize(buf);
          tx.sign([session.keypair]);
          const s3 = await session.connection.sendRawTransaction(tx.serialize(), {skipPreflight:true});
          log('SELL', `PumpPortal sell: ${s3?.slice(0,20)}...`);
        }
      } catch(e) { log('ERROR', `PumpPortal: ${e.message}`); }
    }
  }

  // Stats
  session.totalPnl += pnlUsd;
  if(won) session.wins++; else session.losses++;
  const wr = session.wins + session.losses > 0
    ? ((session.wins / (session.wins+session.losses))*100).toFixed(0) : '0';

  saveTrade({
    ts: new Date().toISOString(),
    mint, reason,
    entryPrice: pos.entryPrice,
    roi: parseFloat(roi.toFixed(2)),
    pnlUsd: parseFloat(pnlUsd.toFixed(4)),
    heldSecs: parseFloat(heldSecs.toFixed(1)),
    dryRun: pos.dryRun,
  });

  const bal = await getSolBal();

  await discord([
    `${won?'✅':'❌'} **${reason.toUpperCase()}** — \`${mint.slice(0,12)}\``,
    `${sign}${roi.toFixed(1)}% | ${sign}$${pnlUsd.toFixed(3)} | held ${heldSecs.toFixed(1)}s`,
    `📊 ${session.wins}W/${session.losses}L (${wr}%WR) | Session PnL: ${session.totalPnl>=0?'+':''}$${session.totalPnl.toFixed(2)}`,
    `💰 Balance: ${bal.toFixed(4)} SOL`,
  ].join('\n'));

  // Blacklist after stop loss
  if(!won) session.blacklist.add(mint);
}

// ── GRADUATED COIN DETECTOR ───────────────────────────────────
// Watch pump.fun migration events via Helius WS
// A "graduation" = token migrates from bonding curve to Raydium

const recentGrads = new Set(); // prevent double-processing

let ws = null;

function connectWS() {
  const wsUrl = C.HELIUS_WS;
  if(!wsUrl) { log('WARN','No HELIUS_API_KEY — using DexScreener polling fallback'); startDexScreenerPoll(); return; }

  log('BOOT','Connecting to Helius WS for graduation events...');
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    log('BOOT','✅ Helius WS connected');
    // Subscribe to pump.fun migration program
    ws.send(JSON.stringify({
      jsonrpc:'2.0', id:1,
      method:'logsSubscribe',
      params:[{ mentions:[C.PUMPFUN_MIGRATION] }, { commitment:'confirmed' }],
    }));
    // Also watch pump.fun program for any graduation signals
    ws.send(JSON.stringify({
      jsonrpc:'2.0', id:2,
      method:'logsSubscribe',
      params:[{ mentions:[C.PUMPFUN_PROGRAM] }, { commitment:'confirmed' }],
    }));
  });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if(!msg.params?.result?.value) return;

      const { signature, logs } = msg.params.result.value;
      if(!signature || recentGrads.has(signature)) return;

      const logStr = (logs||[]).join(' ');

      // Look for migration/graduation signals
      const isGrad = logStr.includes('WithdrawLiquidity') ||
                     logStr.includes('MigrateToAMM') ||
                     logStr.includes('RaydiumMigration') ||
                     logStr.includes('migrat') ||
                     logStr.includes('Migrate');

      if(!isGrad) return;
      recentGrads.add(signature);
      if(recentGrads.size > 200) {
        const first = recentGrads.values().next().value;
        recentGrads.delete(first);
      }

      log('TICK', `Graduation event detected: ${signature.slice(0,20)}...`);
      // Slight delay then fetch the mint from the tx
      setTimeout(() => fetchGradMint(signature), 1000);
    } catch(e){}
  });

  ws.on('error', e => log('ERROR',`WS: ${e.message}`));
  ws.on('close', code => {
    log('WARN', `WS closed (${code}) — reconnect in 3s`);
    setTimeout(connectWS, 3000);
  });

  setInterval(() => { if(ws?.readyState===WebSocket.OPEN) ws.ping(); }, 20000);
}

const pendingMints = new Set(); // prevent parallel retries on same mint

async function fetchGradMint(sig) {
  try {
    const tx = await session.connection.getParsedTransaction(sig, {
      maxSupportedTransactionVersion:0, commitment:'confirmed'
    });
    if(!tx) return;

    const SKIP = new Set([
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      C.SOL_MINT,
    ]);

    for(const b of (tx.meta?.postTokenBalances||[])) {
      const mint = b.mint;
      if(!mint) continue;
      if(SKIP.has(mint)) continue;
      if(session.watchedCoins.has(mint) || session.blacklist.has(mint)) continue;
      if(pendingMints.has(mint)) continue; // already being retried

      pendingMints.add(mint);
      log('TICK', `Graduated coin: ${mint.slice(0,12)}... — checking price`);
      watchCoin(mint).finally(() => pendingMints.delete(mint));
      break;
    }
  } catch(e){}
}

// ── DEXSCREENER POLLING FALLBACK ──────────────────────────────
// If no Helius key, poll DexScreener for new Raydium pairs with
// pump.fun origin (high volume, just listed)

async function startDexScreenerPoll() {
  log('BOOT', 'Starting DexScreener new pairs polling...');

  const poll = async () => {
    try {
      // Get latest Raydium pairs — newest first
      const r = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
      if(!r.ok) return;
      const d    = await r.json();
      const pairs = Array.isArray(d) ? d : (d.pairs||[]);

      for(const pair of pairs.slice(0,20)) {
        if(pair.chainId !== 'solana') continue;
        const mint = pair.tokenAddress || pair.baseToken?.address;
        if(!mint) continue;
        if(session.watchedCoins.has(mint) || session.blacklist.has(mint)) continue;

        await watchCoin(mint);
      }
    } catch(e){}
  };

  poll();
  setInterval(poll, 8000); // poll every 8s
}

// ── WATCH A GRADUATED COIN ────────────────────────────────────
async function watchCoin(mint) {
  if(session.watchedCoins.size >= 20) return;
  if(session.watchedCoins.has(mint)) return;
  if(session.blacklist.has(mint)) return;

  // Retry up to 5 times with increasing delay — DexScreener lags after graduation
  for(let attempt = 0; attempt < 5; attempt++) {
    if(session.watchedCoins.has(mint)) return; // already added by another event
    const data = await getPrice(mint);
    if(data && data.price > 0) {
      // Accept any liquidity — fresh graduates start low
      const state = makeCoinState(mint, data.price, data.liq);
      session.watchedCoins.set(mint, state);
      log('TICK', `✅ Watching: ${mint.slice(0,10)} @ $${data.price.toFixed(8)} liq:$${(data.liq/1000).toFixed(1)}K`);
      startCoinTicker(mint);
      return;
    }
    // DexScreener not indexed yet — wait and retry
    const delay = [2000, 4000, 6000, 10000, 15000][attempt];
    log('TICK', `${mint.slice(0,10)} not on DexScreener yet (attempt ${attempt+1}) — retry in ${delay/1000}s`);
    await new Promise(r => setTimeout(r, delay));
  }
  log('SKIP', `${mint.slice(0,10)} never appeared on DexScreener — skip`);
}

// ── FAST PRICE TICKER ─────────────────────────────────────────
// Poll each watched coin every 1.5s for momentum detection

function startCoinTicker(mint) {
  const ticker = setInterval(async () => {
    const state = session.watchedCoins.get(mint);
    if(!state) { clearInterval(ticker); return; }

    // Remove old coins (>3 min)
    if(Date.now() - state.firstSeen > 180000) {
      session.watchedCoins.delete(mint);
      clearInterval(ticker);
      return;
    }

    // Don't track if we already entered or blacklisted
    if(state.phase === 'entered' || state.phase === 'done' || session.blacklist.has(mint)) {
      clearInterval(ticker);
      session.watchedCoins.delete(mint);
      return;
    }

    const data = await getPrice(mint);
    if(!data) return;

    updateCoin(state, data.price, data.liq);

    const mom = getMomentumPct(state);

    // Log interesting coins
    if(state.ticksUp >= 2 || mom > 3) {
      log('TICK', `${mint.slice(0,10)} $${data.price.toFixed(8)} ticks↑:${state.ticksUp} mom:${mom>=0?'+':''}${mom.toFixed(1)}% liq:$${(data.liq/1000).toFixed(1)}K`);
    }

    // ── MOMENTUM ENTRY CHECK ─────────────────────────────────
    if(!canTrade()) return;
    if(session.openPositions.has(mint)) return;

    const passedMomentum = state.ticksUp >= C.MIN_PRICE_TICKS_UP;
    const passedMomPct   = mom >= C.MIN_MOMENTUM_PCT;
    const passedLiq      = data.liq >= C.MIN_LIQUIDITY_USD;

    if(passedMomentum && passedMomPct && passedLiq) {
      log('MOMENTUM', `🚀 ${mint.slice(0,10)} ENTER — ticks↑:${state.ticksUp} mom:+${mom.toFixed(1)}% liq:$${(data.liq/1000).toFixed(1)}K`);
      await enterTrade(mint, state);
    }

  }, 1500); // 1.5s ticker — fast enough to catch momentum
}

// ── STATUS ────────────────────────────────────────────────────
function startStatus() {
  setInterval(async () => {
    const bal  = await getSolBal();
    const pnl  = session.totalPnl;
    const sign = pnl >= 0 ? '+' : '';
    const wr   = session.wins + session.losses > 0
      ? ((session.wins/(session.wins+session.losses))*100).toFixed(0) : '0';

    log('INFO', `━━ ${bal.toFixed(4)} SOL | pnl:${sign}$${pnl.toFixed(2)} | ${session.wins}W/${session.losses}L (${wr}%WR) | open:${session.openPositions.size} | watching:${session.watchedCoins.size} | t/hr:${session.tradesThisHour}`);
  }, 30000);
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  🚀 MOMENTUM RIDER v1.0 — Graduated Coin Scalper            ║');
  console.log(`║  ${C.DRY_RUN ? '📋 DRY RUN' : '⚡ LIVE — REAL MONEY'}                                    ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  if(!C.PRIVATE_KEY) { log('ERROR','PRIVATE_KEY not set'); process.exit(1); }

  try {
    session.keypair = Keypair.fromSecretKey(bs58.decode(C.PRIVATE_KEY));
    log('BOOT', `Wallet: ${session.keypair.publicKey.toString()}`);
  } catch(e) { log('ERROR','Bad PRIVATE_KEY'); process.exit(1); }

  session.connection = new Connection(C.HELIUS_RPC, { commitment:'confirmed' });
  session.startBal   = await getSolBal();

  log('BOOT', `Balance: ${session.startBal.toFixed(4)} SOL ($${(session.startBal*C.SOL_PRICE_USD).toFixed(2)})`);
  log('BOOT', `Mode: ${C.DRY_RUN ? 'DRY RUN' : '⚡ LIVE'}`);
  log('BOOT', `TP:+${C.TAKE_PROFIT_PCT}% SL:-${C.STOP_LOSS_PCT}% Hold:${C.HOLD_SECS}s`);
  log('BOOT', `Momentum: ${C.MIN_PRICE_TICKS_UP} ticks↑ + ${C.MIN_MOMENTUM_PCT}% in 10s | Min liq: $${C.MIN_LIQUIDITY_USD}`);

  if(!C.DRY_RUN && session.startBal < 0.02) { log('ERROR','Balance too low'); process.exit(1); }

  connectWS();
  startStatus();

  await discord([
    `🚀 **MOMENTUM RIDER v1.0 ONLINE**`,
    `Mode: **${C.DRY_RUN?'DRY RUN':'⚡ LIVE'}** | $${C.TRADE_SIZE_USD}/trade`,
    `TP:+${C.TAKE_PROFIT_PCT}% SL:-${C.STOP_LOSS_PCT}% Hold:${C.HOLD_SECS}s`,
    `Entry: ${C.MIN_PRICE_TICKS_UP} ticks↑ + +${C.MIN_MOMENTUM_PCT}% momentum`,
    `💰 ${session.startBal.toFixed(4)} SOL`,
  ].join('\n'));

  log('BOOT','✅ Watching for graduated coins with momentum...');
}

process.on('SIGINT', async () => {
  log('INFO','Shutting down...');
  await discord('🔴 Momentum Rider OFFLINE');
  process.exit(0);
});
process.on('unhandledRejection', e => log('ERROR',`Unhandled: ${e.message}`));
main().catch(e => { log('ERROR',`Fatal: ${e.message}`); process.exit(1); });
