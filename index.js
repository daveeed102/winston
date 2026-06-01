// ============================================================
// WINSTON v35.0 — Low MC Copy Trader
// ⚠️  HIGH RISK — for educational/personal use only
// ============================================================
// Target: 97K6nsFhBWDKwQf6heDDhDtsCRC4779LPHSFZkc2zqK4
//
// Rules:
//   1. Watch target wallet in real time via Helius WebSocket
//   2. When target buys a token with MC < $20K → buy $5 (0.061 SOL)
//   3. Skip if MC > $20K or target already sold that token
//   4. No duplicate buys unless target buys again after selling
//
// Exit strategy (tiered):
//   TP1: +20-30% → sell 50%
//   TP2: +50-75% → sell 50% of remainder (25% original)
//   MOONBAG: final 25% rides until:
//     a) 10 min elapsed, OR
//     b) target wallet sells → we sell too
//   SL: -25% → full exit
//
// Logging: every buy/sell/hold time/MC/PnL logged to console + Discord
// ============================================================

require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const bs58  = require('bs58');
const fetch = require('node-fetch');
const WebSocket = require('ws');

// ── CONFIG ────────────────────────────────────────────────────
const CONFIG = {
  TARGET_WALLET:  process.env.TARGET_WALLET  || '97K6nsFhBWDKwQf6heDDhDtsCRC4779LPHSFZkc2zqK4',
  PRIVATE_KEY:    process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || '',
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  DISCORD_WEBHOOK:process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || '',

  get HELIUS_RPC(){ return `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },
  get HELIUS_TX() { return `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${this.HELIUS_API_KEY}`; },
  get HELIUS_WS() { return process.env.HELIUS_WS_URL || `wss://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },

  JUPITER_QUOTE: 'https://lite-api.jup.ag/swap/v1/quote',
  JUPITER_SWAP:  'https://lite-api.jup.ag/swap/v1/swap',

  // ── Buy config ────────────────────────────────────────────
  BUY_SOL:         parseFloat(process.env.BUY_SOL)    || 0.061, // ~$5
  MAX_MC_USD:      parseFloat(process.env.MAX_MC_USD) || 20000, // skip if MC > $20K
  MAX_POSITIONS:   parseInt(process.env.MAX_POSITIONS) || 5,

  // ── Exit tiers ────────────────────────────────────────────
  TP1_PCT:         parseFloat(process.env.TP1_PCT)    || 25,   // +25% → sell 50%
  TP1_SELL_PCT:    parseFloat(process.env.TP1_SELL)   || 50,
  TP2_PCT:         parseFloat(process.env.TP2_PCT)    || 60,   // +60% → sell 50% of remainder
  TP2_SELL_PCT:    parseFloat(process.env.TP2_SELL)   || 50,
  SL_PCT:          parseFloat(process.env.SL_PCT)     || -65,  // -65% → full exit
  MOONBAG_MAX_MS:  (parseInt(process.env.MOONBAG_MINS)||10) * 60000, // 10 min moonbag

  // ── Speed ─────────────────────────────────────────────────
  SLIPPAGE_BPS:                1500,    // 15%
  PRIORITY_FEE_MICRO_LAMPORTS: 500000,  // 0.0005 SOL
  MAX_SIGNAL_AGE_SECONDS:      10,

  get MIN_SOL_BALANCE(){ return this.BUY_SOL + 0.01; },
  EXIT_CHECK_MS: 2000,   // check every 2s — need fast TP/SL
  HEALTH_MS:     30000,
  SOL_MINT: 'So11111111111111111111111111111111111111112',
  SOL_PRICE: 96,
};

const IGNORE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  CONFIG.SOL_MINT,
]);

// ── STATE ─────────────────────────────────────────────────────
const state = {
  keypair:       null,
  connection:    null,
  ws:            null,
  isRunning:     false,
  positions:     new Map(),    // mint → position
  targetHoldings:new Set(),    // mints target currently holds
  tradedMints:   new Set(),    // mints we've ever bought this session
  processedSigs: new Set(),
  buyInProgress: false,
  wsEvents:      0,
  tradeLog:      [],           // full trade history for review
  stats: {
    buys: 0, sells: 0, wins: 0, losses: 0,
    totalPnl: 0, feesTotal: 0,
    skippedMC: 0, skippedOther: 0,
    startBal: 0, startTime: Date.now(),
  },
};

// ── UTILS ─────────────────────────────────────────────────────

function log(lv, msg, d={}) {
  const ts = new Date().toISOString();
  const ic = { INFO:'📡',BUY:'🟢',SELL:'🔴',EXEC:'⚡',ERROR:'❌',
               SIGNAL:'🎯',EXIT:'🏁',SKIP:'⏭',WARN:'⚠️',LOG:'📋' };
  const line = `[${ts}] ${ic[lv]||'📋'} [${lv}] ${msg}${Object.keys(d).length?' '+JSON.stringify(d):''}`;
  console.log(line);
  return line;
}

const sleep   = ms  => new Promise(r => setTimeout(r, ms));
const usd     = sol => `$${(sol * CONFIG.SOL_PRICE).toFixed(2)}`;
const pct     = n   => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
const nowMs   = ()  => Date.now();
const age     = ms  => ms < 60000 ? `${(ms/1000).toFixed(0)}s` : `${(ms/60000).toFixed(1)}m`;

// Trade log entry
function logTrade(entry) {
  state.tradeLog.push({ ...entry, time: new Date().toISOString() });
  log('LOG', JSON.stringify(entry));
}

async function discord(msg) {
  if(!CONFIG.DISCORD_WEBHOOK) return;
  try {
    await fetch(CONFIG.DISCORD_WEBHOOK, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ content: msg.slice(0,1990) }),
    });
  } catch(e){}
}

async function solBal() {
  try { return (await state.connection.getBalance(state.keypair.publicKey))/1e9; }
  catch(e){ return 0; }
}

async function getSymbol(mint) {
  try {
    const r = await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mint}`);
    if(r.ok){ const d = await r.json(); return d.symbol||mint.slice(0,8); }
  } catch(e){}
  return mint.slice(0,8);
}

// ── MARKET CAP CHECK ──────────────────────────────────────────

async function getMC(mint) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if(!r.ok) return null;
    const d = await r.json();
    const pair = d?.pairs?.[0];
    if(!pair) return null;
    return parseFloat(pair.marketCap || pair.fdv || 0);
  } catch(e){ return null; }
}

// ── CONFIRM TX ────────────────────────────────────────────────

async function confirm(sig, ms=25000) {
  const end = nowMs()+ms;
  while(nowMs()<end) {
    try {
      const r = await state.connection.getSignatureStatuses([sig]);
      const v = r?.value?.[0];
      if(v?.err) return false;
      if(v?.confirmationStatus==='confirmed'||v?.confirmationStatus==='finalized') return true;
    } catch(e){}
    await sleep(400);
  }
  return false;
}

// ── GET TOKEN VALUE ───────────────────────────────────────────

async function getTokenValue(mint) {
  try {
    const accts = await state.connection.getParsedTokenAccountsByOwner(
      state.keypair.publicKey, { mint: new PublicKey(mint) }
    );
    const acct = accts?.value?.[0];
    if(!acct) return null;
    const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount||0);
    if(bal<=0) return null;
    const dec = acct.account.data.parsed.info.tokenAmount.decimals;
    const raw = BigInt(Math.floor(bal * Math.pow(10,dec)));
    const r   = await fetch(
      `${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL_MINT}&amount=${raw.toString()}&slippageBps=500`
    );
    if(!r.ok) return null;
    const q = await r.json();
    if(!q.outAmount) return null;
    return { solValue: parseFloat(q.outAmount)/1e9, raw, bal };
  } catch(e){ return null; }
}

// ── SELL ──────────────────────────────────────────────────────

async function execSell(mint, fraction, reason, attempt=1) {
  const pos    = state.positions.get(mint);
  const feeSol = CONFIG.PRIORITY_FEE_MICRO_LAMPORTS/1e9;

  try {
    const result = await getTokenValue(mint);
    if(!result){ if(fraction>=1) state.positions.delete(mint); return 0; }
    const { raw: fullRaw } = result;
    const sellRaw = fraction >= 1
      ? fullRaw
      : BigInt(Math.floor(Number(fullRaw) * fraction));
    if(sellRaw <= 0n){ if(fraction>=1) state.positions.delete(mint); return 0; }

    const qr = await fetch(
      `${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL_MINT}&amount=${sellRaw.toString()}&slippageBps=${CONFIG.SLIPPAGE_BPS}`
    );
    if(!qr.ok) throw new Error(`Quote ${qr.status}`);
    const q = await qr.json();
    if(!q.outAmount) throw new Error('No route');

    const sr = await fetch(CONFIG.JUPITER_SWAP, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        quoteResponse: q,
        userPublicKey: state.keypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicSlippage: { minBps:50, maxBps:CONFIG.SLIPPAGE_BPS },
        prioritizationFeeLamports: CONFIG.PRIORITY_FEE_MICRO_LAMPORTS,
      }),
    });
    if(!sr.ok) throw new Error(`Swap ${sr.status}`);
    const sd = await sr.json();
    if(!sd.swapTransaction) throw new Error('No tx');

    const buf = Buffer.from(sd.swapTransaction,'base64');
    const tx  = VersionedTransaction.deserialize(buf);
    tx.sign([state.keypair]);
    const sig = await state.connection.sendRawTransaction(tx.serialize(),{skipPreflight:true,maxRetries:5});

    if(await confirm(sig, 20000)){
      const solBack = parseFloat(q.outAmount)/1e9;
      state.stats.feesTotal += feeSol;
      state.stats.sells++;
      if(pos) pos.totalRecovered += solBack;
      if(fraction >= 1) state.positions.delete(mint);
      log('SELL', `✅ ${pos?.sym||mint.slice(0,8)} ${(fraction*100).toFixed(0)}% → ${solBack.toFixed(4)} SOL | ${reason}`);
      return solBack;
    }
    throw new Error('Confirm timeout');
  } catch(e) {
    log('ERROR',`Sell fail (${attempt}): ${e.message}`);
    if(attempt < 6){ await sleep(800*attempt); return execSell(mint, fraction, reason, attempt+1); }
    await discord(`🆘 **SELL FAILED — ${pos?.sym||mint.slice(0,8)}**\nhttps://jup.ag/swap/${mint}-SOL`);
    if(fraction>=1) state.positions.delete(mint);
    return 0;
  }
}

// ── BUY ───────────────────────────────────────────────────────

async function execBuy(mint, mcUsd, attempt=1) {
  const sol      = CONFIG.BUY_SOL;
  const lamports = Math.floor(sol*1e9);
  const sym      = await getSymbol(mint);
  const t0       = nowMs();

  try {
    const qr = await fetch(
      `${CONFIG.JUPITER_QUOTE}?inputMint=${CONFIG.SOL_MINT}&outputMint=${mint}&amount=${lamports}&slippageBps=${CONFIG.SLIPPAGE_BPS}`
    );
    if(!qr.ok) throw new Error(`Quote ${qr.status}`);
    const q = await qr.json();
    if(!q.outAmount||q.outAmount==='0') throw new Error('No route');

    const sr = await fetch(CONFIG.JUPITER_SWAP, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        quoteResponse: q,
        userPublicKey: state.keypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicSlippage: { minBps:50, maxBps:CONFIG.SLIPPAGE_BPS },
        prioritizationFeeLamports: CONFIG.PRIORITY_FEE_MICRO_LAMPORTS,
      }),
    });
    if(!sr.ok) throw new Error(`Swap ${sr.status}`);
    const sd = await sr.json();
    if(!sd.swapTransaction) throw new Error('No swap tx');

    const buf = Buffer.from(sd.swapTransaction,'base64');
    const tx  = VersionedTransaction.deserialize(buf);
    tx.sign([state.keypair]);
    const sig = await state.connection.sendRawTransaction(tx.serialize(),{skipPreflight:true,maxRetries:5});

    if(!await confirm(sig, 30000)) throw new Error('Confirm timeout');

    const latency = nowMs()-t0;
    const bal     = await solBal();

    const pos = {
      mint, sym, sol,
      mcAtEntry:      mcUsd,
      entryTime:      nowMs(),
      totalRecovered: 0,
      tp1Done:        false,
      tp2Done:        false,
      moonbagStartMs: null, // set when TP2 fires
      isSelling:      false,
    };
    state.positions.set(mint, pos);
    state.stats.buys++;
    state.stats.feesTotal += CONFIG.PRIORITY_FEE_MICRO_LAMPORTS/1e9;

    logTrade({
      event: 'BUY', sym, mint,
      sol, usd: usd(sol),
      mcAtEntry: mcUsd?.toFixed(0)||'?',
      latencyMs: latency,
    });

    log('BUY', `✅ ${sym} | ${sol} SOL (${usd(sol)}) | MC:$${mcUsd?.toFixed(0)||'?'} | ${latency}ms | bal:${bal.toFixed(4)}`);

    await discord([
      `🟢 **BUY — ${sym}**`,
      `\`${mint}\``,
      '━━━━━━━━━━━━━━━━━━━━',
      `💸 Bought: **${sol} SOL** (${usd(sol)})`,
      `📊 MC at entry: **$${mcUsd?.toFixed(0)||'?'}**`,
      `⚡ Latency: **${latency}ms**`,
      '━━━━━━━━━━━━━━━━━━━━',
      `🏁 TP1: **+${CONFIG.TP1_PCT}%** → sell ${CONFIG.TP1_SELL_PCT}%`,
      `🏁 TP2: **+${CONFIG.TP2_PCT}%** → sell ${CONFIG.TP2_SELL_PCT}% more`,
      `🌙 Moonbag: **10min** or target sells → exit`,
      `🛑 SL: **${CONFIG.SL_PCT}%** → full exit`,
      `📊 https://dexscreener.com/solana/${mint}`,
    ].join('\n'));
    return true;
  } catch(e) {
    log('ERROR',`Buy fail (${attempt}): ${e.message}`);
    if(attempt < 8){ await sleep(500); return execBuy(mint, mcUsd, attempt+1); }
    state.tradedMints.delete(mint);
    await discord(`❌ **BUY FAILED — ${sym}**\n${e.message}`);
    return false;
  }
}

// ── EXIT MANAGER ──────────────────────────────────────────────

async function exitManager() {
  log('INFO',`🏁 Exit | TP1:+${CONFIG.TP1_PCT}% TP2:+${CONFIG.TP2_PCT}% SL:${CONFIG.SL_PCT}% Moonbag:10min`);

  while(state.isRunning) {
    await sleep(CONFIG.EXIT_CHECK_MS);

    for(const [mint, pos] of state.positions) {
      if(pos.isSelling) continue;

      const heldMs = nowMs() - pos.entryTime;

      // ── TARGET SOLD → exit moonbag ───────────────────────
      // If target no longer holds this mint, exit whatever remains
      if(pos.moonbagStartMs && !state.targetHoldings.has(mint)){
        pos.isSelling = true;
        const heldStr = age(heldMs);
        log('EXIT',`🎯 TARGET SOLD ${pos.sym} — exiting moonbag after ${heldStr}`);
        await discord(`🎯 **TARGET SOLD — ${pos.sym}**\nExiting moonbag after **${heldStr}**`);
        const solBack = await execSell(mint, 1.0, 'target_sold_moonbag_exit');
        await logFinalExit(pos, solBack, 'target_sold', heldMs);
        continue;
      }

      // ── MOONBAG TIME LIMIT: 10 min ────────────────────────
      if(pos.moonbagStartMs && (nowMs() - pos.moonbagStartMs) >= CONFIG.MOONBAG_MAX_MS){
        pos.isSelling = true;
        log('EXIT',`⏱ MOONBAG 10MIN ${pos.sym} — time limit reached`);
        await discord(`⏱ **MOONBAG 10MIN EXIT — ${pos.sym}**\nTime limit reached — selling remainder`);
        const solBack = await execSell(mint, 1.0, 'moonbag_10min');
        await logFinalExit(pos, solBack, 'moonbag_10min', heldMs);
        continue;
      }

      // ── GET CURRENT VALUE ─────────────────────────────────
      const result = await getTokenValue(mint);
      if(!result) continue;

      const currentSol = result.solValue;
      const roi        = ((currentSol / pos.sol) - 1) * 100;

      const bar = roi >= 0
        ? '█'.repeat(Math.min(Math.floor(roi/5),20))+'░'.repeat(Math.max(20-Math.floor(roi/5),0))
        : '▓'.repeat(Math.min(Math.floor(Math.abs(roi)/5),20));

      console.log(
        `  [${pos.sym}] ${pct(roi)} [${bar}] | ` +
        `${age(heldMs)} | MC:$${pos.mcAtEntry?.toFixed(0)||'?'} | ` +
        `${pos.tp1Done?'✅TP1':'⏳TP1'} ${pos.tp2Done?'✅TP2':'⏳TP2'} | ` +
        `SL:${CONFIG.SL_PCT}%`
      );

      // ── STOP LOSS: -25% ───────────────────────────────────
      if(roi <= CONFIG.SL_PCT && !pos.tp1Done) {
        pos.isSelling = true;
        log('EXIT',`🛑 SL ${pct(roi)} on ${pos.sym} after ${age(heldMs)}`);
        await discord([
          `🛑 **STOP LOSS — ${pos.sym}**`,
          `📉 **${pct(roi)}** after **${age(heldMs)}**`,
          `💸 Entry: ${usd(pos.sol)} | MC was: $${pos.mcAtEntry?.toFixed(0)||'?'}`,
        ].join('\n'));
        const solBack = await execSell(mint, 1.0, 'stop_loss');
        await logFinalExit(pos, solBack, 'stop_loss', heldMs);
        continue;
      }

      // ── TP1: +25% → sell 50% ─────────────────────────────
      if(roi >= CONFIG.TP1_PCT && !pos.tp1Done) {
        pos.tp1Done   = true;
        pos.isSelling = true;
        log('EXIT',`🏁 TP1 ${pct(roi)} on ${pos.sym} — selling ${CONFIG.TP1_SELL_PCT}%`);
        const fraction = CONFIG.TP1_SELL_PCT/100;
        const solBack  = await execSell(mint, fraction, `tp1_${roi.toFixed(0)}pct`);
        if(solBack > 0) {
          const chunk = solBack - (pos.sol * fraction);
          await discord([
            `🏁 **TP1 HIT — ${pos.sym}**`,
            `📈 **${pct(roi)}** → sold **${CONFIG.TP1_SELL_PCT}%**`,
            `💰 Got back: **${solBack.toFixed(4)} SOL** (${usd(solBack)})`,
            `⚡ Chunk profit: **+${usd(Math.max(0,chunk))}**`,
            `🎯 Remaining ${100-CONFIG.TP1_SELL_PCT}% rides to +${CONFIG.TP2_PCT}%`,
            `https://media.tenor.com/LxMBBtB7SWIAAAAC/lets-go-kevin-hart.gif`,
          ].join('\n'));
          logTrade({ event:'TP1_SELL', sym:pos.sym, roi:roi.toFixed(1), solBack, heldMs:age(heldMs) });
        } else {
          pos.tp1Done = false; // retry
        }
        pos.isSelling = false;
        continue;
      }

      // ── TP2: +60% → sell 50% of remainder ────────────────
      if(roi >= CONFIG.TP2_PCT && pos.tp1Done && !pos.tp2Done) {
        pos.tp2Done      = true;
        pos.isSelling    = true;
        pos.moonbagStartMs = nowMs(); // start moonbag timer
        log('EXIT',`🏁 TP2 ${pct(roi)} on ${pos.sym} — selling ${CONFIG.TP2_SELL_PCT}% more → moonbag`);
        const fraction = CONFIG.TP2_SELL_PCT/100;
        const solBack  = await execSell(mint, fraction, `tp2_${roi.toFixed(0)}pct`);
        if(solBack > 0) {
          await discord([
            `🏁 **TP2 HIT — ${pos.sym}**`,
            `📈 **${pct(roi)}** → sold **${CONFIG.TP2_SELL_PCT}%** more`,
            `💰 Got back: **${solBack.toFixed(4)} SOL** (${usd(solBack)})`,
            `🌙 Final **${100-CONFIG.TP1_SELL_PCT-CONFIG.TP2_SELL_PCT*(100-CONFIG.TP1_SELL_PCT)/100}%** rides as moonbag (10min or target sells)`,
            `https://media.tenor.com/g1jMbTKW_LEAAAAC/hell-yeah-yes.gif`,
          ].join('\n'));
          logTrade({ event:'TP2_SELL', sym:pos.sym, roi:roi.toFixed(1), solBack, heldMs:age(heldMs) });
        } else {
          pos.tp2Done = false;
          pos.moonbagStartMs = null;
        }
        pos.isSelling = false;
        continue;
      }
    }
  }
}

// ── FINAL EXIT LOGGER ─────────────────────────────────────────

async function logFinalExit(pos, finalSolBack, reason, heldMs) {
  const totalOut = pos.totalRecovered + finalSolBack;
  const pnl      = totalOut - pos.sol;
  const roi      = ((totalOut/pos.sol)-1)*100;
  const sign     = pnl>=0?'+':'';
  const bal      = await solBal();

  state.stats.totalPnl += pnl;
  if(pnl>=0) state.stats.wins++; else state.stats.losses++;
  const wr = state.stats.sells>0?((state.stats.wins/state.stats.sells)*100).toFixed(0):'0';

  logTrade({
    event:    'FINAL_EXIT',
    sym:      pos.sym,
    reason,
    entrySOL: pos.sol,
    totalOut: totalOut.toFixed(4),
    pnlSOL:   pnl.toFixed(4),
    pnlUSD:   usd(Math.abs(pnl)),
    roi:      roi.toFixed(1)+'%',
    heldMs:   age(heldMs),
    mcEntry:  pos.mcAtEntry?.toFixed(0)||'?',
    win:      pnl>=0,
  });

  log(pnl>=0?'SELL':'EXIT',
    `FINAL ${pos.sym} | total:${totalOut.toFixed(4)} SOL | pnl:${sign}${pnl.toFixed(4)} (${pct(roi)}) | held:${age(heldMs)} | ${reason}`
  );

  const exitLabel =
      reason==='stop_loss'             ? '🛑 STOP LOSS'
    : reason==='moonbag_10min'         ? '⏱ 10MIN MOONBAG'
    : reason==='target_sold_moonbag_exit' ? '🎯 TARGET SOLD'
    : '🔴 EXIT';

  await discord([
    `${exitLabel} — **${pos.sym}**`,
    '━━━━━━━━━━━━━━━━━━━━',
    `📥 Entry:     **${usd(pos.sol)}** (${pos.sol} SOL)`,
    `📤 Total out: **${usd(totalOut)}** (${totalOut.toFixed(4)} SOL)`,
    `${pnl>=0?'📈':'📉'} PnL:      **${sign}${usd(Math.abs(pnl))}** (${sign}${pnl.toFixed(4)} SOL / ${pct(roi)})`,
    `⏱  Held:     **${age(heldMs)}**`,
    `📊 MC entry:  **$${pos.mcAtEntry?.toFixed(0)||'?'}**`,
    '━━━━━━━━━━━━━━━━━━━━',
    `📊 Session: **${state.stats.wins}W/${state.stats.losses}L** (${wr}%WR) | Total PnL: **${sign}${usd(Math.abs(state.stats.totalPnl))}**`,
    `💰 Balance: **${bal.toFixed(4)} SOL**`,
    pnl>0?'https://media.tenor.com/7PMPpHm3tnsAAAAC/money-cash.gif':'',
  ].filter(Boolean).join('\n'));
}

// ── PARSE TARGET TX ───────────────────────────────────────────

async function parseTx(sig) {
  try {
    const r = await fetch(CONFIG.HELIUS_TX, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ transactions:[sig] }),
    });
    if(!r.ok) return;
    const txs = await r.json();
    const tx  = txs?.[0];
    if(!tx||tx.transactionError) return;

    const ageMs  = nowMs() - (tx.timestamp ? tx.timestamp*1000 : nowMs());
    if(ageMs > CONFIG.MAX_SIGNAL_AGE_SECONDS*1000){
      log('SKIP',`Too old: ${(ageMs/1000).toFixed(1)}s`); return;
    }

    const tfers  = tx.tokenTransfers||[];
    const native = tx.nativeTransfers||[];
    const txType = tx.type||'';
    const desc   = (tx.description||'').toLowerCase();

    if(txType==='TRANSFER') return;
    if(desc.includes('claim')||desc.includes('close')) return;

    let solOut = 0;
    for(const t of native){
      if(t.fromUserAccount===CONFIG.TARGET_WALLET) solOut += (t.amount||0)/1e9;
    }

    // Detect sells — target giving tokens away
    const mintsSold = [];
    for(const t of tfers){
      if(IGNORE_MINTS.has(t.mint)||t.mint===CONFIG.SOL_MINT) continue;
      if(t.fromUserAccount===CONFIG.TARGET_WALLET&&parseFloat(t.tokenAmount||0)>0){
        mintsSold.push(t.mint);
      }
    }

    // Track target sells — update targetHoldings
    for(const mint of mintsSold){
      if(state.targetHoldings.has(mint)){
        state.targetHoldings.delete(mint);
        log('INFO',`🎯 Target sold ${mint.slice(0,12)}... — removed from holdings`);
        // If we're in this position in moonbag mode, exit manager will handle it
      }
    }

    // Detect buys — target receiving tokens
    const mintsBought = [];
    for(const t of tfers){
      if(IGNORE_MINTS.has(t.mint)||t.mint===CONFIG.SOL_MINT) continue;
      if(t.toUserAccount===CONFIG.TARGET_WALLET&&parseFloat(t.tokenAmount||0)>0) mintsBought.push(t.mint);
    }
    if(!mintsBought.length){
      for(const a of (tx.accountData||[])){
        for(const c of (a.tokenBalanceChanges||[])){
          if(c.userAccount===CONFIG.TARGET_WALLET&&!IGNORE_MINTS.has(c.mint)&&
             c.mint!==CONFIG.SOL_MINT&&parseFloat(c.rawTokenAmount?.tokenAmount||0)>0){
            mintsBought.push(c.mint);
          }
        }
      }
    }
    if(!mintsBought.length&&solOut>0.001){
      for(const t of tfers){
        if(!IGNORE_MINTS.has(t.mint)&&t.mint!==CONFIG.SOL_MINT&&parseFloat(t.tokenAmount||0)>0){
          mintsBought.push(t.mint); break;
        }
      }
    }

    for(const mint of mintsBought){
      // Track target holdings
      state.targetHoldings.add(mint);

      // Skip if we already hold this
      if(state.positions.has(mint)) continue;

      // Skip if we already traded and target hasn't sold since
      // (re-buy allowed only if target sold and bought again)
      if(state.tradedMints.has(mint)){
        log('SKIP',`Already traded ${mint.slice(0,12)}... and target hasn't sold — skip`);
        state.stats.skippedOther++;
        continue;
      }

      if(state.positions.size >= CONFIG.MAX_POSITIONS){
        log('SKIP',`Max positions (${CONFIG.MAX_POSITIONS})`);
        state.stats.skippedOther++;
        continue;
      }

      if(state.buyInProgress) continue;

      const bal = await solBal();
      if(bal < CONFIG.MIN_SOL_BALANCE){
        log('WARN',`Low balance: ${bal.toFixed(4)} SOL`);
        await discord(`⚠️ **LOW BALANCE** — ${bal.toFixed(4)} SOL`);
        continue;
      }

      // ── MC CHECK ────────────────────────────────────────
      log('INFO',`🔍 Checking MC for ${mint.slice(0,12)}...`);
      const mc = await getMC(mint);

      if(mc !== null && mc > CONFIG.MAX_MC_USD){
        log('SKIP',`MC too high: $${mc.toFixed(0)} > $${CONFIG.MAX_MC_USD}`);
        state.stats.skippedMC++;
        await discord(`⏭ **SKIPPED — MC $${mc.toFixed(0)}** > $${CONFIG.MAX_MC_USD}\n\`${mint.slice(0,20)}...\``);
        continue;
      }

      // When target re-buys after selling: allow re-entry
      // by not adding to tradedMints until after buy succeeds
      state.buyInProgress = true;
      state.tradedMints.add(mint);

      const success = await execBuy(mint, mc);
      state.buyInProgress = false;
      if(!success) state.tradedMints.delete(mint);
    }

  } catch(e){
    log('ERROR',`parseTx: ${e.message}`);
    state.buyInProgress = false;
  }
}

// ── WEBSOCKET ─────────────────────────────────────────────────

function connectHelius() {
  log('INFO',`🔌 Connecting — watching ${CONFIG.TARGET_WALLET.slice(0,20)}...`);
  const ws = new WebSocket(CONFIG.HELIUS_WS);
  state.ws = ws;

  ws.on('open',()=>{
    log('INFO','✅ WS connected');
    ws.send(JSON.stringify({
      jsonrpc:'2.0', id:1,
      method:'logsSubscribe',
      params:[{ mentions:[CONFIG.TARGET_WALLET] },{ commitment:'confirmed' }],
    }));
  });

  ws.on('message', async (raw)=>{
    state.wsEvents++;
    try {
      const msg = JSON.parse(raw.toString());
      if(msg.id===1&&msg.result!==undefined){
        log('INFO',`✅ Subscribed subId:${msg.result}`);
        return;
      }
      if(!msg.params?.result?.value) return;
      const value = msg.params.result.value;
      const sig   = value.signature;
      const logs  = value.logs||[];

      if(state.processedSigs.has(sig)) return;
      state.processedSigs.add(sig);
      if(state.processedSigs.size>500){
        state.processedSigs.delete(state.processedSigs.values().next().value);
      }

      const logStr = logs.join(' ');
      if(logStr.includes('CloseAccount')||logStr.includes('claim_cashback')) return;

      parseTx(sig).catch(e=>log('ERROR',`parse: ${e.message}`));
    } catch(e){ log('ERROR',`WS: ${e.message}`); }
  });

  ws.on('error', e=>log('ERROR',`WS: ${e.message}`));
  ws.on('close', code=>{
    log('INFO',`WS closed (${code}) — reconnect in 2s`);
    state.ws = null;
    if(state.isRunning) setTimeout(connectHelius, 2000);
  });

  setInterval(()=>{
    if(ws.readyState===WebSocket.OPEN) ws.ping();
  }, 20000);
}

// ── HEALTH + TRADE LOG SUMMARY ────────────────────────────────

async function health() {
  while(state.isRunning) {
    await sleep(CONFIG.HEALTH_MS);
    const bal    = await solBal();
    const pnl    = bal - state.stats.startBal;
    const wr     = state.stats.sells>0?((state.stats.wins/state.stats.sells)*100).toFixed(0):'0';
    const uptime = ((nowMs()-state.stats.startTime)/60000).toFixed(0);

    const lines = [
      '', '═'.repeat(66),
      '  📋 WINSTON v35.0 — Low MC Copy Trader',
      '═'.repeat(66),
      `  📡 WS: ${state.ws?.readyState===WebSocket.OPEN?'🟢 LIVE':'🔴 RECONN'} | Events:${state.wsEvents} | Up:${uptime}min`,
      `  🎯 ${CONFIG.TARGET_WALLET.slice(0,30)}...`,
      `  💸 Buy:${CONFIG.BUY_SOL} SOL | MC<$${CONFIG.MAX_MC_USD.toLocaleString()} | TP1:+${CONFIG.TP1_PCT}% TP2:+${CONFIG.TP2_PCT}% SL:${CONFIG.SL_PCT}%`,
      `  💰 ${bal.toFixed(4)} SOL | PnL:${pnl>=0?'+':''}${usd(Math.abs(pnl))} | Fees:${state.stats.feesTotal.toFixed(4)} SOL`,
      `  📊 ${state.stats.wins}W/${state.stats.losses}L (${wr}%WR) | Buys:${state.stats.buys} | SkippedMC:${state.stats.skippedMC}`,
      `  🎯 Target holdings: ${state.targetHoldings.size} tokens`,
    ];

    if(state.positions.size > 0){
      lines.push(`  📦 OPEN POSITIONS (${state.positions.size}/${CONFIG.MAX_POSITIONS}):`);
      for(const [m, p] of state.positions){
        const phases = `${p.tp1Done?'✅':'⏳'}TP1 ${p.tp2Done?'✅':'⏳'}TP2${p.moonbagStartMs?' 🌙':''}`
        lines.push(`    [${p.sym}] MC:$${p.mcAtEntry?.toFixed(0)||'?'} | ${age(nowMs()-p.entryTime)} | ${phases}`);
      }
    } else {
      lines.push('  📭 No positions — watching for MC < $'+CONFIG.MAX_MC_USD.toLocaleString());
    }

    // Recent trade log
    if(state.tradeLog.length > 0){
      lines.push(`  📋 Last 3 trades:`);
      for(const t of state.tradeLog.slice(-3)){
        lines.push(`    ${t.event} ${t.sym} ${t.roi||''} ${t.heldMs||''}`);
      }
    }

    lines.push('═'.repeat(66));
    console.log(lines.join('\n'));
  }
}

// ── MAIN ──────────────────────────────────────────────────────

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  📋 WINSTON v35.0 — Low MC Copy Trader                         ║');
  console.log(`║  $5 buys | MC<$20K | TP1:+25% TP2:+60% | Moonbag:10min       ║`);
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  if(!CONFIG.HELIUS_API_KEY){ log('ERROR','HELIUS_API_KEY missing'); process.exit(1); }
  if(!CONFIG.PRIVATE_KEY)   { log('ERROR','WALLET_PRIVATE_KEY missing'); process.exit(1); }

  try {
    state.keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
    log('INFO',`Wallet: ${state.keypair.publicKey.toString()}`);
  } catch(e){ log('ERROR',`Bad key`); process.exit(1); }

  state.connection     = new Connection(CONFIG.HELIUS_RPC,{commitment:'confirmed'});
  state.stats.startBal = await solBal();
  log('INFO',`Balance: ${state.stats.startBal.toFixed(4)} SOL | Target: ${CONFIG.TARGET_WALLET}`);
  log('INFO',`Buy: ${CONFIG.BUY_SOL} SOL | Max MC: $${CONFIG.MAX_MC_USD.toLocaleString()} | TP1:+${CONFIG.TP1_PCT}% TP2:+${CONFIG.TP2_PCT}% SL:${CONFIG.SL_PCT}%`);

  if(state.stats.startBal < CONFIG.MIN_SOL_BALANCE){
    log('ERROR',`Balance too low — need ${CONFIG.MIN_SOL_BALANCE} SOL`);
    process.exit(1);
  }

  state.isRunning = true;
  connectHelius();

  await discord([
    '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬',
    '📋  **WINSTON v35.0 ONLINE**',
    '**Low MC Copy Trader**',
    '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬',
    `🎯  Copying: \`${CONFIG.TARGET_WALLET}\``,
    '━━━━━━━━━━━━━━━━━━━━',
    `💸  Buy: **${CONFIG.BUY_SOL} SOL** (~$${(CONFIG.BUY_SOL*CONFIG.SOL_PRICE).toFixed(2)}) per trade`,
    `📊  Only buys MC **< $${CONFIG.MAX_MC_USD.toLocaleString()}**`,
    `🏁  TP1: **+${CONFIG.TP1_PCT}%** → sell ${CONFIG.TP1_SELL_PCT}%`,
    `🏁  TP2: **+${CONFIG.TP2_PCT}%** → sell ${CONFIG.TP2_SELL_PCT}% more`,
    `🌙  Moonbag: exits after **10min** or when **target sells**`,
    `🛑  SL: **${CONFIG.SL_PCT}%** → full exit`,
    `📋  Full trade log in console`,
    '━━━━━━━━━━━━━━━━━━━━',
    `💰  Balance: **${state.stats.startBal.toFixed(4)} SOL**`,
    '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬',
  ].join('\n'));

  let down = false;
  const shutdown = async () => {
    if(down) return; down = true;
    state.isRunning = false;
    if(state.ws) state.ws.close();
    const fin = await solBal();
    const pnl = fin-state.stats.startBal;
    const wr  = state.stats.sells>0?((state.stats.wins/state.stats.sells)*100).toFixed(0):'0';

    // Print full trade log
    console.log('\n📋 FULL TRADE LOG:');
    for(const t of state.tradeLog) console.log(JSON.stringify(t));

    await discord([
      '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬',
      '🔴  **WINSTON v35.0 OFFLINE**',
      '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬',
      `💰 Final: **${fin.toFixed(4)} SOL**`,
      `📈 PnL: **${pnl>=0?'+':''}${usd(Math.abs(pnl))}** (${pnl>=0?'+':''}${pnl.toFixed(4)} SOL)`,
      `📊 **${state.stats.wins}W/${state.stats.losses}L** (${wr}%WR) | ${state.stats.buys} buys`,
      `💸 Total fees: **${state.stats.feesTotal.toFixed(4)} SOL**`,
      `📋 **${state.tradeLog.length}** trade events logged`,
      '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬',
    ].join('\n'));
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await Promise.all([exitManager(), health()]);
}

// ── CRASH FAILSAFE ────────────────────────────────────────────

async function runWithFailsafe() {
  let n = 0;
  while(true) {
    try { await main(); break; }
    catch(e) {
      n++;
      log('ERROR',`CRASH #${n}: ${e.message}`);
      try {
        if(CONFIG.DISCORD_WEBHOOK) await fetch(CONFIG.DISCORD_WEBHOOK,{
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({content:`💥 **WINSTON v35 CRASHED #${n}**\n❌ ${e.message}\nRestart in 3s...`}),
        });
      } catch(_){}
      if(state.ws){ try{state.ws.close();}catch(_){} }
      state.isRunning = state.buyInProgress = false;
      state.ws = null;
      await new Promise(r=>setTimeout(r,3000));
    }
  }
}

runWithFailsafe();
