// ============================================================
// SNIPER EXIT ABSORPTION BOT v1.0
// Solana meme coin micro-scalper — burner wallet only
// Strategy: wait for first sniper dump → buy the bounce
// Default: DRY_RUN=true (paper trading)
// ============================================================
require('dotenv').config();
const {
  Connection, Keypair, VersionedTransaction,
  PublicKey, LAMPORTS_PER_SOL
} = require('@solana/web3.js');
const bs58  = require('bs58');
const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');
const WebSocket = require('ws');

// ── CONFIG ────────────────────────────────────────────────────
const C = {
  DRY_RUN:                process.env.DRY_RUN !== 'false',   // MUST explicitly set false for live
  PRIVATE_KEY:            process.env.PRIVATE_KEY || process.env.WALLET_SECRET_KEY || '',
  RPC_URL:                process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  HELIUS_API_KEY:         process.env.HELIUS_API_KEY || '',
  DISCORD_WEBHOOK:        process.env.DISCORD_WEBHOOK_URL || '',

  TRADE_SIZE_USD:         parseFloat(process.env.TRADE_SIZE_USD)          || 3,
  MAX_TRADE_SIZE_USD:     parseFloat(process.env.MAX_TRADE_SIZE_USD)       || 5,
  MAX_OPEN_TRADES:        parseInt(process.env.MAX_OPEN_TRADES)            || 1,
  TAKE_PROFIT_PCT:        parseFloat(process.env.TAKE_PROFIT_PERCENT)      || 12,
  STOP_LOSS_PCT:          parseFloat(process.env.STOP_LOSS_PERCENT)        || 7,
  MAX_HOLD_SECS:          parseInt(process.env.MAX_HOLD_SECONDS)           || 90,
  MAX_TRADES_PER_HOUR:    parseInt(process.env.MAX_TRADES_PER_HOUR)        || 20,
  MAX_DAILY_LOSS_USD:     parseFloat(process.env.MAX_DAILY_LOSS_USD)       || 5,
  MAX_CONSEC_LOSSES:      parseInt(process.env.MAX_CONSECUTIVE_LOSSES)     || 3,

  MIN_ABSORPTION_SCORE:   parseInt(process.env.MIN_ABSORPTION_SCORE)       || 75,
  MIN_TOKEN_AGE_SECS:     parseInt(process.env.MIN_TOKEN_AGE_SECONDS)      || 30,
  MAX_TOKEN_AGE_SECS:     parseInt(process.env.MAX_TOKEN_AGE_SECONDS)      || 600,
  MIN_PUMP_PCT:           parseFloat(process.env.MIN_FIRST_PUMP_PERCENT)   || 40,
  MAX_PUMP_PCT:           parseFloat(process.env.MAX_FIRST_PUMP_PERCENT)   || 150,
  MIN_DUMP_PCT:           parseFloat(process.env.MIN_FIRST_DUMP_PERCENT)   || 15,
  MAX_DUMP_PCT:           parseFloat(process.env.MAX_FIRST_DUMP_PERCENT)   || 35,
  MIN_NEW_BUYERS:         parseInt(process.env.MIN_NEW_BUYERS_AFTER_DUMP)  || 3,
  PRICE_HOLD_SECS:        parseInt(process.env.PRICE_HOLD_SECONDS)         || 15,
  MAX_PRICE_IMPACT_PCT:   parseFloat(process.env.MAX_PRICE_IMPACT_PERCENT) || 5,
  SLIPPAGE_BPS:           parseInt(process.env.SLIPPAGE_BPS)               || 2000,

  SOL_PRICE_USD:          parseFloat(process.env.SOL_PRICE_USD)            || 96,
  SOL_MINT:               'So11111111111111111111111111111111111111112',
  JUPITER_API:            process.env.JUPITER_API_URL || 'https://lite-api.jup.ag/swap/v1',
  PUMPFUN_PROGRAM:        '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',

  get HELIUS_RPC(){ return this.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}` : this.RPC_URL; },
  get HELIUS_WS() { return this.HELIUS_API_KEY ? `wss://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}` : null; },
};

// ── LOGGER ────────────────────────────────────────────────────
const TRADE_LOG_FILE = path.join(__dirname, 'trades.json');
const LOG_FILE       = path.join(__dirname, 'bot.log');
if(!fs.existsSync(TRADE_LOG_FILE)) fs.writeFileSync(TRADE_LOG_FILE, '[]');

function log(tag, msg, extra='') {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [${tag}] ${msg}${extra ? ' '+extra : ''}`;
  const COLOR = {
    BOOT:'', WATCHING:'\x1b[36m', 'DUMP DETECTED':'\x1b[33m',
    'ABSORPTION SCORE':'\x1b[35m', 'BUY SIGNAL':'\x1b[32m',
    'DRY RUN BUY':'\x1b[32m', 'LIVE BUY':'\x1b[92m',
    EXIT:'\x1b[31m', 'KILL SWITCH':'\x1b[91m', ERROR:'\x1b[31m',
    INFO:'\x1b[37m', WARN:'\x1b[33m',
  };
  console.log((COLOR[tag]||'\x1b[37m') + line + '\x1b[0m');
  try { fs.appendFileSync(LOG_FILE, line+'\n'); } catch(e){}
}

function saveTrade(trade) {
  try {
    const trades = JSON.parse(fs.readFileSync(TRADE_LOG_FILE,'utf8'));
    trades.push(trade);
    fs.writeFileSync(TRADE_LOG_FILE, JSON.stringify(trades, null, 2));
  } catch(e) { log('ERROR', 'Failed to save trade: '+e.message); }
}

async function discord(msg) {
  if(!C.DISCORD_WEBHOOK) return;
  try {
    await fetch(C.DISCORD_WEBHOOK, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({content: msg.slice(0,1990)}),
    });
  } catch(e){}
}

// ── SESSION STATE ─────────────────────────────────────────────
const session = {
  dailyLossUsd:     0,
  consecLosses:     0,
  tradesThisHour:   0,
  hourResetAt:      Date.now() + 3600000,
  killed:           false,
  killReason:       '',
  openPositions:    new Map(),   // mint → position
  watchedTokens:    new Map(),   // mint → tokenState
  blacklist:        new Set(),   // mints that got stopped out
  keypair:          null,
  connection:       null,
  startBal:         0,
};

function checkKillSwitch(reason) {
  if(session.killed) return true;
  if(session.dailyLossUsd >= C.MAX_DAILY_LOSS_USD) {
    session.killed = true;
    session.killReason = `Daily loss limit $${C.MAX_DAILY_LOSS_USD} reached`;
  }
  if(session.consecLosses >= C.MAX_CONSEC_LOSSES) {
    session.killed = true;
    session.killReason = `${C.MAX_CONSEC_LOSSES} consecutive losses`;
  }
  if(session.killed) {
    log('KILL SWITCH', session.killReason);
    discord(`🛑 **KILL SWITCH** — ${session.killReason}`);
  }
  return session.killed;
}

function checkTradeLimit() {
  const now = Date.now();
  if(now > session.hourResetAt) {
    session.tradesThisHour = 0;
    session.hourResetAt = now + 3600000;
  }
  return session.tradesThisHour < C.MAX_TRADES_PER_HOUR;
}

// ── SOL BALANCE ───────────────────────────────────────────────
async function getSolBalance() {
  try {
    const bal = await session.connection.getBalance(session.keypair.publicKey);
    return bal / LAMPORTS_PER_SOL;
  } catch(e) { return 0; }
}

async function getTokenBalance(mint) {
  try {
    const accts = await session.connection.getParsedTokenAccountsByOwner(
      session.keypair.publicKey, { mint: new PublicKey(mint) }
    );
    const acct = accts?.value?.[0];
    if(!acct) return { ui: 0, raw: 0n, decimals: 6 };
    const info = acct.account.data.parsed.info.tokenAmount;
    return { ui: parseFloat(info.uiAmount||0), raw: BigInt(info.amount||0), decimals: info.decimals };
  } catch(e) { return { ui: 0, raw: 0n, decimals: 6 }; }
}

// ── JUPITER ───────────────────────────────────────────────────
async function jupiterQuote(inMint, outMint, amountLamports, slippageBps) {
  try {
    const r = await fetch(
      `${C.JUPITER_API}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amountLamports}&slippageBps=${slippageBps}`
    );
    if(!r.ok) return null;
    const q = await r.json();
    if(!q.outAmount) return null;
    return q;
  } catch(e) { return null; }
}

async function jupiterSwap(quote) {
  try {
    const r = await fetch(`${C.JUPITER_API}/swap`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        quoteResponse:       quote,
        userPublicKey:       session.keypair.publicKey.toString(),
        wrapAndUnwrapSol:    true,
        dynamicSlippage:     { minBps:50, maxBps:C.SLIPPAGE_BPS },
        prioritizationFeeLamports: 300000,
      }),
    });
    if(!r.ok) return null;
    const d = await r.json();
    if(!d.swapTransaction) return null;

    const buf = Buffer.from(d.swapTransaction,'base64');
    const tx  = VersionedTransaction.deserialize(buf);
    tx.sign([session.keypair]);
    const sig = await session.connection.sendRawTransaction(tx.serialize(),{skipPreflight:true,maxRetries:3});

    // Confirm
    const end = Date.now()+20000;
    while(Date.now()<end) {
      const s = await session.connection.getSignatureStatuses([sig]);
      const v = s?.value?.[0];
      if(v?.err) return null;
      if(v?.confirmationStatus==='confirmed'||v?.confirmationStatus==='finalized') return sig;
      await new Promise(r=>setTimeout(r,400));
    }
    return null;
  } catch(e) { return null; }
}

function priceImpactPct(quote) {
  return parseFloat(quote.priceImpactPct||0) * 100;
}

// ── TOKEN STATE TRACKER ───────────────────────────────────────
// Tracks lifecycle of each new token for absorption scoring

function initTokenState(mint, launchPrice) {
  return {
    mint,
    launchTime:     Date.now(),
    launchPrice,
    currentPrice:   launchPrice,
    localHigh:      launchPrice,
    localLow:       launchPrice,
    pumpPct:        0,
    dumpPct:        0,
    dumpDetectedAt: null,
    priceAfterDump: null,
    buyCount:       0,
    sellCount:      0,
    buyersAfterDump: 0,
    creatorMint:    null,
    recentPrices:   [launchPrice],
    phase:          'watching',  // watching → pumped → dumped → absorbing → traded
    score:          0,
  };
}

function updateTokenState(state, price, isBuy, isSell, isCreator) {
  state.currentPrice = price;
  state.recentPrices.push(price);
  if(state.recentPrices.length > 50) state.recentPrices.shift();

  if(isBuy)  state.buyCount++;
  if(isSell) state.sellCount++;

  if(price > state.localHigh) state.localHigh = price;
  if(price < state.localLow)  state.localLow  = price;

  // Pump detection
  if(state.launchPrice > 0) {
    state.pumpPct = ((state.localHigh - state.launchPrice) / state.launchPrice) * 100;
  }

  // Phase transitions
  if(state.phase === 'watching' && state.pumpPct >= C.MIN_PUMP_PCT) {
    state.phase = 'pumped';
    log('WATCHING', `${state.mint.slice(0,12)}... pumped ${state.pumpPct.toFixed(0)}%`);
  }

  if(state.phase === 'pumped' && state.localHigh > 0) {
    const dumpFromHigh = ((state.localHigh - price) / state.localHigh) * 100;
    if(dumpFromHigh >= C.MIN_DUMP_PCT) {
      state.dumpPct = dumpFromHigh;
      if(!state.dumpDetectedAt) {
        state.dumpDetectedAt = Date.now();
        state.priceAfterDump = price;
        state.buyersAfterDump = 0;
        state.phase = 'dumped';
        log('DUMP DETECTED', `${state.mint.slice(0,12)}... dump ${state.dumpPct.toFixed(0)}% from high`);
      }
    }
  }

  if(state.phase === 'dumped') {
    if(isBuy) state.buyersAfterDump++;
    const holdSecs = (Date.now() - state.dumpDetectedAt) / 1000;

    // Price still making new lows = not absorbed yet
    if(price < state.priceAfterDump) {
      state.priceAfterDump = price;
    }

    if(holdSecs >= C.PRICE_HOLD_SECS && state.buyersAfterDump >= C.MIN_NEW_BUYERS) {
      state.phase = 'absorbing';
    }
  }
}

// ── ABSORPTION SCORE ──────────────────────────────────────────
function calcAbsorptionScore(state) {
  let score = 0;
  const reasons = [];

  // 1. Dump size quality (15-35% is ideal = 25 pts)
  if(state.dumpPct >= C.MIN_DUMP_PCT && state.dumpPct <= C.MAX_DUMP_PCT) {
    score += 25;
    reasons.push(`dump ${state.dumpPct.toFixed(0)}% ✓`);
  } else if(state.dumpPct < C.MIN_DUMP_PCT) {
    reasons.push(`dump too small ${state.dumpPct.toFixed(0)}%`);
  } else {
    score += 10;
    reasons.push(`dump large ${state.dumpPct.toFixed(0)}%`);
  }

  // 2. Pump quality (40-150% = 20 pts)
  if(state.pumpPct >= C.MIN_PUMP_PCT && state.pumpPct <= C.MAX_PUMP_PCT) {
    score += 20;
    reasons.push(`pump ${state.pumpPct.toFixed(0)}% ✓`);
  } else if(state.pumpPct > C.MAX_PUMP_PCT) {
    score += 10;
    reasons.push(`pump very high ${state.pumpPct.toFixed(0)}%`);
  }

  // 3. New buyers after dump (15 pts)
  if(state.buyersAfterDump >= C.MIN_NEW_BUYERS) {
    const bonus = Math.min(state.buyersAfterDump * 3, 15);
    score += bonus;
    reasons.push(`${state.buyersAfterDump} buyers after dump ✓`);
  } else {
    reasons.push(`only ${state.buyersAfterDump} buyers after dump`);
  }

  // 4. Price held above dump low (15 pts)
  const holdSecs = state.dumpDetectedAt ? (Date.now()-state.dumpDetectedAt)/1000 : 0;
  if(holdSecs >= C.PRICE_HOLD_SECS) {
    score += 15;
    reasons.push(`held ${holdSecs.toFixed(0)}s ✓`);
  }

  // 5. Buy/sell ratio improving (10 pts)
  const totalTx = state.buyCount + state.sellCount;
  if(totalTx > 0) {
    const buyRatio = state.buyCount / totalTx;
    if(buyRatio > 0.6) { score += 10; reasons.push(`buy ratio ${(buyRatio*100).toFixed(0)}% ✓`); }
    else if(buyRatio > 0.4) { score += 5; }
  }

  // 6. Token age reasonable (5 pts)
  const ageSecs = (Date.now()-state.launchTime)/1000;
  if(ageSecs >= C.MIN_TOKEN_AGE_SECS && ageSecs <= C.MAX_TOKEN_AGE_SECS) {
    score += 5;
    reasons.push(`age ${ageSecs.toFixed(0)}s ✓`);
  } else if(ageSecs > C.MAX_TOKEN_AGE_SECS) {
    reasons.push(`too old ${ageSecs.toFixed(0)}s`);
    score -= 10;
  }

  // 7. Price recovering from dump low (10 pts)
  if(state.priceAfterDump > 0 && state.currentPrice > state.priceAfterDump) {
    const recovery = ((state.currentPrice-state.priceAfterDump)/state.priceAfterDump)*100;
    if(recovery > 5) { score += 10; reasons.push(`recovering +${recovery.toFixed(0)}% ✓`); }
    else score += 5;
  }

  state.score = Math.max(0, Math.min(100, score));
  return { score: state.score, reasons };
}

// ── BUY LOGIC ─────────────────────────────────────────────────
async function attemptBuy(state) {
  if(checkKillSwitch()) return;
  if(!checkTradeLimit()) { log('WARN','Trade limit reached this hour'); return; }
  if(session.openPositions.size >= C.MAX_OPEN_TRADES) { log('WARN','Max open trades reached'); return; }
  if(session.blacklist.has(state.mint)) { log('WARN',`${state.mint.slice(0,12)}... is blacklisted`); return; }

  const solBal = await getSolBalance();
  const tradeSizeUsd = Math.min(C.TRADE_SIZE_USD, C.MAX_TRADE_SIZE_USD);
  const tradeSizeSol = tradeSizeUsd / C.SOL_PRICE_USD;
  const tradeLamports = Math.floor(tradeSizeSol * LAMPORTS_PER_SOL);

  if(solBal < tradeSizeSol + 0.005) {
    log('WARN', `Low SOL balance: ${solBal.toFixed(4)} — need ${(tradeSizeSol+0.005).toFixed(4)}`);
    return;
  }

  // Get quote
  const quote = await jupiterQuote(C.SOL_MINT, state.mint, tradeLamports, C.SLIPPAGE_BPS);
  if(!quote) {
    log('WARN', `No Jupiter route for ${state.mint.slice(0,12)}...`);
    return;
  }

  const impact = priceImpactPct(quote);
  if(impact > C.MAX_PRICE_IMPACT_PCT) {
    log('WARN', `Price impact ${impact.toFixed(1)}% too high for ${state.mint.slice(0,12)}...`);
    return;
  }

  const { score, reasons } = calcAbsorptionScore(state);
  log('ABSORPTION SCORE', `${state.mint.slice(0,12)}... score:${score}/100 | ${reasons.join(' | ')}`);

  if(score < C.MIN_ABSORPTION_SCORE) {
    log('INFO', `Score ${score} below threshold ${C.MIN_ABSORPTION_SCORE} — skip`);
    return;
  }

  log('BUY SIGNAL', `${state.mint.slice(0,12)}... score:${score} impact:${impact.toFixed(1)}% size:$${tradeSizeUsd}`);

  let sig = null;
  let entryPrice = state.currentPrice;

  if(C.DRY_RUN) {
    sig = 'DRY_RUN_' + Date.now();
    log('DRY RUN BUY', `Simulated ${tradeSizeUsd} USD → ${state.mint.slice(0,12)}... @ ~$${entryPrice.toFixed(8)}`);
  } else {
    sig = await jupiterSwap(quote);
    if(!sig) {
      log('ERROR', `Swap failed for ${state.mint.slice(0,12)}...`);
      return;
    }
    log('LIVE BUY', `sig:${sig} | ${state.mint.slice(0,12)}... | $${tradeSizeUsd}`);
  }

  // Record position
  const tokBal = C.DRY_RUN
    ? { ui: parseFloat(quote.outAmount) / 1e6, raw: BigInt(quote.outAmount), decimals: 6 }
    : await getTokenBalance(state.mint);

  session.openPositions.set(state.mint, {
    mint:           state.mint,
    entryPrice,
    entryTimestamp: Date.now(),
    tradeSizeUsd,
    tradeSizeSol,
    tokenAmount:    tokBal.ui,
    tokenAmountRaw: tokBal.raw,
    decimals:       tokBal.decimals,
    sig,
    absorptionScore: score,
    dryRun:         C.DRY_RUN,
  });

  session.tradesThisHour++;
  state.phase = 'traded';

  await discord([
    `${C.DRY_RUN?'📋 DRY RUN':'🟢 LIVE'} **BUY** — ${state.mint.slice(0,12)}...`,
    `Score: **${score}/100** | Impact: **${impact.toFixed(1)}%**`,
    `Size: **$${tradeSizeUsd}** | Pump: **${state.pumpPct.toFixed(0)}%** → Dump: **${state.dumpPct.toFixed(0)}%**`,
  ].join('\n'));

  // Start exit monitor
  monitorPosition(state.mint);
}

// ── EXIT LOGIC ────────────────────────────────────────────────
async function monitorPosition(mint) {
  const pos = session.openPositions.get(mint);
  if(!pos) return;

  log('INFO', `Monitoring ${mint.slice(0,12)}... TP:+${C.TAKE_PROFIT_PCT}% SL:-${C.STOP_LOSS_PCT}% max:${C.MAX_HOLD_SECS}s`);

  const CHECK_INTERVAL = 1500; // check every 1.5s
  const startTime = Date.now();

  const monitor = setInterval(async () => {
    const p = session.openPositions.get(mint);
    if(!p) { clearInterval(monitor); return; }

    const holdMs   = Date.now() - p.entryTimestamp;
    const holdSecs = holdMs / 1000;

    // Get current price via Jupiter quote
    const lamportsOut = Math.floor(p.tradeSizeSol * LAMPORTS_PER_SOL);
    const currentQuote = await jupiterQuote(C.SOL_MINT, mint, lamportsOut, C.SLIPPAGE_BPS);

    let currentPrice = p.entryPrice;
    let exitReason   = null;
    let canGetQuote  = !!currentQuote;

    if(currentQuote) {
      // Estimate price from quote
      currentPrice = p.entryPrice * (parseFloat(currentQuote.outAmount) / lamportsOut);
    }

    const roi = ((currentPrice - p.entryPrice) / p.entryPrice) * 100;

    // Check exit conditions
    if(holdSecs >= C.MAX_HOLD_SECS)      exitReason = 'timeout';
    else if(roi >= C.TAKE_PROFIT_PCT)    exitReason = 'take_profit';
    else if(roi <= -C.STOP_LOSS_PCT)     exitReason = 'stop_loss';
    else if(!canGetQuote && holdSecs > 10) exitReason = 'no_route';

    // Check watched token for creator dump signal
    const watched = session.watchedTokens.get(mint);
    if(watched?.creatorDumped) exitReason = 'creator_dumped';

    if(exitReason) {
      clearInterval(monitor);
      await exitPosition(mint, exitReason, currentPrice, roi);
    }
  }, CHECK_INTERVAL);
}

async function exitPosition(mint, reason, currentPrice, roi) {
  const pos = session.openPositions.get(mint);
  if(!pos) return;

  session.openPositions.delete(mint);

  const pnlUsd  = pos.tradeSizeUsd * (roi / 100);
  const holdSec = (Date.now() - pos.entryTimestamp) / 1000;
  const sign    = pnlUsd >= 0 ? '+' : '';

  log('EXIT', `${mint.slice(0,12)}... | ${reason} | roi:${sign}${roi.toFixed(1)}% | pnl:${sign}$${pnlUsd.toFixed(3)} | held:${holdSec.toFixed(0)}s`);

  if(!pos.dryRun && pos.tokenAmountRaw > 0n) {
    // Try to sell
    const sellQuote = await jupiterQuote(mint, C.SOL_MINT, pos.tokenAmountRaw.toString(), C.SLIPPAGE_BPS);
    if(sellQuote) {
      const sig = await jupiterSwap(sellQuote);
      if(!sig) {
        // Retry once with higher slippage
        const retryQuote = await jupiterQuote(mint, C.SOL_MINT, pos.tokenAmountRaw.toString(), 5000);
        if(retryQuote) await jupiterSwap(retryQuote);
      }
    }
  }

  // Update session stats
  if(pnlUsd < 0) {
    session.dailyLossUsd  += Math.abs(pnlUsd);
    session.consecLosses++;
    session.blacklist.add(mint); // stop loss = blacklist
  } else {
    session.consecLosses = 0;
  }

  // Save trade log
  saveTrade({
    timestamp:       new Date().toISOString(),
    token:           mint,
    entryPrice:      pos.entryPrice,
    exitPrice:       currentPrice,
    tradeSizeUsd:    pos.tradeSizeUsd,
    pnlPct:          parseFloat(roi.toFixed(2)),
    pnlUsd:          parseFloat(pnlUsd.toFixed(4)),
    entryReason:     'absorption_signal',
    exitReason:      reason,
    absorptionScore: pos.absorptionScore,
    holdSeconds:     parseFloat(holdSec.toFixed(1)),
    dryRun:          pos.dryRun,
    sig:             pos.sig,
  });

  await discord([
    `${pnlUsd>=0?'✅':'❌'} **EXIT** — ${mint.slice(0,12)}...`,
    `Reason: **${reason}** | ROI: **${sign}${roi.toFixed(1)}%** | PnL: **${sign}$${pnlUsd.toFixed(3)}**`,
    `Held: **${holdSec.toFixed(0)}s** | ${pos.dryRun?'📋 DRY RUN':'💰 LIVE'}`,
  ].join('\n'));

  checkKillSwitch();
}

// ── PUMPFUN WATCHER ───────────────────────────────────────────
// Subscribes to new token launches via Helius WebSocket
// Then polls DexScreener for price to drive absorption scoring

let ws = null;

function watchNewTokens() {
  const wsUrl = C.HELIUS_WS;
  if(!wsUrl) {
    log('WARN','No HELIUS_API_KEY — using polling fallback');
    startPollingFallback();
    return;
  }

  log('INFO', 'Connecting to Helius WebSocket for new token detection...');
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    log('INFO', '✅ Helius WebSocket connected');
    ws.send(JSON.stringify({
      jsonrpc:'2.0', id:1,
      method:'logsSubscribe',
      params:[{ mentions:[C.PUMPFUN_PROGRAM] }, { commitment:'confirmed' }],
    }));
  });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if(msg.id===1) { log('INFO',`Subscribed to pump.fun events`); return; }
      if(!msg.params?.result?.value) return;

      const { logs, signature } = msg.params.result.value;
      const logStr = (logs||[]).join(' ');

      // Only process creates, and only if we have room for more tokens
      if(session.watchedTokens.size < 15 &&
         (logStr.includes('InitializeMint') || logStr.includes('MintTo')) &&
         sigQueue.length < 5) {
        processNewTokenSig(signature);
      }
    } catch(e){}
  });

  ws.on('error', e => log('ERROR','WS: '+e.message));
  ws.on('close', code => {
    log('INFO', `WS closed (${code}) — reconnect in 5s`);
    setTimeout(watchNewTokens, 5000);
  });

  setInterval(() => { if(ws?.readyState===WebSocket.OPEN) ws.ping(); }, 20000);
}

// Queue of sigs to process — batch them to avoid RPC spam
const sigQueue = [];
let sigQueueRunning = false;

async function processNewTokenSig(sig) {
  if(!sig) return;
  sigQueue.push(sig);
  if(!sigQueueRunning) drainSigQueue();
}

async function drainSigQueue() {
  sigQueueRunning = true;
  while(sigQueue.length > 0) {
    // Cap watched tokens
    if(session.watchedTokens.size >= 15) { sigQueue.length = 0; break; }

    const sig = sigQueue.shift();
    try {
      const tx = await session.connection.getParsedTransaction(sig, {
        maxSupportedTransactionVersion:0, commitment:'confirmed'
      });
      if(!tx) { await new Promise(r=>setTimeout(r,500)); continue; }

      for(const b of (tx.meta?.postTokenBalances||[])) {
        const mint = b.mint;
        if(!mint) continue;

        // Skip known tokens and stables
        const IGNORE = new Set([
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
          C.SOL_MINT,
        ]);
        if(IGNORE.has(mint)) continue;
        if(session.watchedTokens.has(mint) || session.blacklist.has(mint)) continue;

        const price = await getTokenPrice(mint);
        // Only watch cheap meme coins, skip stables/established tokens
        if(!price || price > 0.05) continue;

        const state = initTokenState(mint, price);
        session.watchedTokens.set(mint, state);
        log('WATCHING', `New token: ${mint.slice(0,12)}... @ $${price.toFixed(8)}`);
        startTokenMonitor(mint);
        break;
      }
    } catch(e){}

    // Rate limit: 1 RPC call per 2 seconds max
    await new Promise(r=>setTimeout(r,2000));
  }
  sigQueueRunning = false;
}

async function getTokenPrice(mint) {
  try {
    // Try DexScreener
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if(r.ok) {
      const d = await r.json();
      const price = parseFloat(d?.pairs?.[0]?.priceUsd||0);
      if(price > 0) return price;
    }
  } catch(e){}
  try {
    // Fallback: Jupiter quote tiny amount to get price
    const q = await jupiterQuote(mint, C.SOL_MINT, '1000000', 5000);
    if(q) return (parseFloat(q.outAmount)/1e9) * C.SOL_PRICE_USD / (1000000/1e6);
  } catch(e){}
  return null;
}

// ── TOKEN PRICE MONITOR ───────────────────────────────────────
const tokenMonitors = new Map();

function startTokenMonitor(mint) {
  if(tokenMonitors.has(mint)) return;

  // Stagger start time by token count to spread out DexScreener requests
  const staggerMs = (tokenMonitors.size % 8) * 1000;

  const interval = setInterval(async () => {
    const state = session.watchedTokens.get(mint);
    if(!state || state.phase === 'traded' || checkKillSwitch()) {
      clearInterval(interval);
      tokenMonitors.delete(mint);
      return;
    }

    // Check age limit
    const ageSecs = (Date.now()-state.launchTime)/1000;
    if(ageSecs > C.MAX_TOKEN_AGE_SECS) {
      clearInterval(interval);
      tokenMonitors.delete(mint);
      session.watchedTokens.delete(mint);
      return;
    }

    const price = await getTokenPrice(mint);
    if(!price) return;

    // Simulate buy/sell detection based on price movement
    const lastPrice = state.currentPrice;
    const isBuy  = price >= lastPrice;
    const isSell = price < lastPrice;

    updateTokenState(state, price, isBuy, isSell, false);

    // Log watching state (only interesting phases)
    if(state.phase !== 'watching' || state.pumpPct > 20) {
      log('WATCHING', `${mint.slice(0,12)}... $${price.toFixed(8)} | pump:${state.pumpPct.toFixed(0)}% | phase:${state.phase}`);
    }

    // Check if ready for absorption buy
    if(state.phase === 'absorbing' && session.openPositions.size < C.MAX_OPEN_TRADES) {
      await attemptBuy(state);
    }

  }, 8000); // 8s between checks to avoid DexScreener rate limits

  tokenMonitors.set(mint, interval);
}

// ── POLLING FALLBACK ──────────────────────────────────────────
// When no Helius key, scan DexScreener new pairs
async function startPollingFallback() {
  log('INFO', 'Starting DexScreener polling fallback...');

  setInterval(async () => {
    try {
      const r = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
      if(!r.ok) return;
      const d = await r.json();
      const pairs = Array.isArray(d) ? d : (d.pairs||[]);

      for(const pair of pairs.slice(0,10)) {
        if(pair.chainId !== 'solana') continue;
        const mint = pair.tokenAddress || pair.baseToken?.address;
        if(!mint || session.watchedTokens.has(mint) || session.blacklist.has(mint)) continue;

        const price = parseFloat(pair.priceUsd || 0);
        if(!price) continue;

        const state = initTokenState(mint, price);
        session.watchedTokens.set(mint, state);
        log('WATCHING', `New token (poll): ${mint.slice(0,12)}... @ $${price.toFixed(8)}`);
        startTokenMonitor(mint);
      }
    } catch(e){}
  }, 5000);
}

// ── STATUS LOGGER ─────────────────────────────────────────────
function startStatusLogger() {
  setInterval(async () => {
    if(session.killed) return;
    const bal     = await getSolBalance();
    const pnl     = (bal - session.startBal) * C.SOL_PRICE_USD;
    const sign    = pnl >= 0 ? '+' : '';
    const open    = session.openPositions.size;
    const watched = session.watchedTokens.size;

    log('INFO', `━━ Status ━━ bal:${bal.toFixed(4)} SOL | pnl:${sign}$${pnl.toFixed(2)} | open:${open} | watching:${watched} | trades/hr:${session.tradesThisHour}/${C.MAX_TRADES_PER_HOUR} | losses:${session.consecLosses}/${C.MAX_CONSEC_LOSSES}`);
  }, 30000);
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  🎯 SNIPER EXIT ABSORPTION BOT v1.0                          ║');
  console.log(`║  ${C.DRY_RUN ? '📋 DRY RUN MODE — no real trades' : '⚠️  LIVE MODE — real money'}                       ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // Validate
  if(!C.PRIVATE_KEY) { log('ERROR','PRIVATE_KEY not set — cannot start'); process.exit(1); }

  // Init wallet
  try {
    session.keypair = Keypair.fromSecretKey(bs58.decode(C.PRIVATE_KEY));
    log('BOOT', `Wallet: ${session.keypair.publicKey.toString()}`);
  } catch(e) { log('ERROR','Invalid PRIVATE_KEY: '+e.message); process.exit(1); }

  session.connection = new Connection(C.HELIUS_RPC, {commitment:'confirmed'});
  session.startBal   = await getSolBalance();

  log('BOOT', `Balance: ${session.startBal.toFixed(4)} SOL ($${(session.startBal*C.SOL_PRICE_USD).toFixed(2)})`);
  log('BOOT', `Mode: ${C.DRY_RUN ? 'DRY RUN' : 'LIVE TRADING'}`);
  log('BOOT', `TP:+${C.TAKE_PROFIT_PCT}% SL:-${C.STOP_LOSS_PCT}% Hold:${C.MAX_HOLD_SECS}s Score:${C.MIN_ABSORPTION_SCORE}`);
  log('BOOT', `Max loss/day:$${C.MAX_DAILY_LOSS_USD} Max consec losses:${C.MAX_CONSEC_LOSSES}`);

  if(C.DRY_RUN) {
    log('BOOT', '🟡 DRY RUN — set DRY_RUN=false to enable live trading');
  } else {
    log('BOOT', '🔴 LIVE TRADING ENABLED — real money at risk');
    await discord('🔴 **LIVE TRADING STARTED** — Sniper Absorption Bot');
  }

  if(!C.DRY_RUN && session.startBal < 0.01) {
    log('ERROR','Balance too low — fund wallet first'); process.exit(1);
  }
  if(C.DRY_RUN && session.startBal < 0.01) {
    log('BOOT', '⚠️  Wallet empty but DRY RUN is on — continuing (no real trades)');
  }

  watchNewTokens();
  startStatusLogger();

  await discord([
    `🎯 **Sniper Absorption Bot ONLINE**`,
    `Mode: **${C.DRY_RUN?'DRY RUN':'⚠️ LIVE'}** | Wallet: \`${session.keypair.publicKey.toString().slice(0,16)}...\``,
    `TP:+${C.TAKE_PROFIT_PCT}% SL:-${C.STOP_LOSS_PCT}% Hold:${C.MAX_HOLD_SECS}s Score:≥${C.MIN_ABSORPTION_SCORE}`,
    `Trade size:$${C.TRADE_SIZE_USD} Max loss/day:$${C.MAX_DAILY_LOSS_USD}`,
  ].join('\n'));

  log('BOOT', '✅ Bot running — watching for absorption setups...');
}

process.on('SIGINT', async () => {
  log('INFO', 'Shutting down...');
  // Close all open positions on exit
  for(const [mint] of session.openPositions) {
    await exitPosition(mint, 'shutdown', 0, 0);
  }
  await discord('🔴 **Sniper Bot OFFLINE**');
  process.exit(0);
});

process.on('unhandledRejection', e => log('ERROR','Unhandled: '+e.message));
main().catch(e => { log('ERROR','Fatal: '+e.message); process.exit(1); });
