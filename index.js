// ============================================================
// WINSTON v32.0 — Ultra-Fast Copy Scalp Bot
// ⚠️  HIGH RISK — for educational/personal use only
// ============================================================
// Target: CFPhuaGoS1R8EKQdVjqqoB2T4VkzCsGfGBqdG1fLg5a5
// Strategy: copy ENTRY only, own fast scalp exit
//
// Exit modes (set MODE in .env):
//   DEFAULT:    TP +12% | SL -7%  | Max 25s
//   AGGRESSIVE: TP +15% | SL -8%  | Max 25s
//   SAFER:      TP +9%  | SL -5%  | Max 20s
//
// Rules:
//   - Single full sell at TP — no tiers, no moonbag
//   - Hard stop loss
//   - Hard time exit
//   - Signal older than 5s → skip
//   - Never copy target wallet sells
// ============================================================

require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const bs58  = require('bs58');
const fetch = require('node-fetch');
const WebSocket = require('ws');

// ── MODES ─────────────────────────────────────────────────────
const MODES = {
  DEFAULT:    { tp: 12, sl: 7,  maxHold: 45 },
  AGGRESSIVE: { tp: 15, sl: 8,  maxHold: 45 },
  SAFER:      { tp: 9,  sl: 5,  maxHold: 35 },
};

const MODE_KEY = (process.env.MODE || 'DEFAULT').toUpperCase();
const MODE     = MODES[MODE_KEY] || MODES.DEFAULT;

// ── CONFIG ────────────────────────────────────────────────────
const CONFIG = {
  TARGET_WALLET:  process.env.TARGET_WALLET  || 'Ev7kp4NfhVjvUqKMwhKCcvXRb2t828gDaSqWsD2gtPzT',
  PRIVATE_KEY:    process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || '',
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  DISCORD_WEBHOOK:process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || '',

  get HELIUS_RPC(){ return `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },
  get HELIUS_TX() { return `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${this.HELIUS_API_KEY}`; },
  get HELIUS_WS() { return process.env.HELIUS_WS_URL || `wss://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },

  JUPITER_QUOTE: 'https://lite-api.jup.ag/swap/v1/quote',
  JUPITER_SWAP:  'https://lite-api.jup.ag/swap/v1/swap',

  // Trade
  BUY_AMOUNT_SOL:          parseFloat(process.env.BUY_AMOUNT_SOL)          || 0.11,
  MAX_SIGNAL_AGE_SECONDS:  parseInt(process.env.MAX_SIGNAL_AGE_SECONDS)    || 5,

  // Exit (from mode, overridable via env)
  TAKE_PROFIT_PERCENT: parseFloat(process.env.TAKE_PROFIT_PERCENT) || MODE.tp,
  STOP_LOSS_PERCENT:   parseFloat(process.env.STOP_LOSS_PERCENT)   || MODE.sl,
  MAX_HOLD_SECONDS:    parseInt(process.env.MAX_HOLD_SECONDS)      || 45,

  // Speed
  SLIPPAGE_BPS:                 Math.round((parseFloat(process.env.SLIPPAGE_PERCENT)||15)*100),
  PRIORITY_FEE_MICRO_LAMPORTS:  parseInt(process.env.PRIORITY_FEE_MICRO_LAMPORTS) || 500000,
  JITO_TIP_SOL:                 parseFloat(process.env.JITO_TIP_SOL) || 0,

  // Mode
  DRY_RUN: process.env.DRY_RUN === 'true',

  get MIN_SOL_BALANCE(){ return this.BUY_AMOUNT_SOL + 0.01; },
  EXIT_CHECK_MS: 300,  // check every 300ms — fast scalp
  HEALTH_MS:     30000,
  SELL_MAX_RETRIES: 4,
  SOL_MINT: 'So11111111111111111111111111111111111111112',
};

// ── IGNORE LIST ───────────────────────────────────────────────
const IGNORE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
  CONFIG.SOL_MINT,
]);

// ── STATE ─────────────────────────────────────────────────────
const state = {
  keypair:       null,
  connection:    null,
  ws:            null,
  isRunning:     false,
  position:      null,
  tradedMints:   new Set(),
  processedSigs: new Set(),
  buyInProgress: false,
  wsEvents:      0,
  stats: {
    signalsDetected: 0,
    signalsSkipped:  0,
    buys: 0, sells: 0,
    wins: 0, losses: 0,
    totalPnl: 0, feesTotal: 0,
    startBal: 0, startTime: Date.now(),
  },
};

// ── UTILS ─────────────────────────────────────────────────────

function log(lv, msg, d={}) {
  const ts  = new Date().toISOString();
  const ic  = { INFO:'📡',BUY:'🟢',SELL:'🔴',EXEC:'⚡',ERROR:'❌',
                SIGNAL:'🎯',EXIT:'🏁',SKIP:'⏭',WARN:'⚠️',DRY:'🔵' };
  const dry = CONFIG.DRY_RUN ? '[DRY] ' : '';
  console.log(`[${ts}] ${ic[lv]||'📋'} [${lv}] ${dry}${msg}${Object.keys(d).length?' '+JSON.stringify(d):''}`);
}

const sleep   = ms  => new Promise(r => setTimeout(r, ms));
const SOL_USD = sol => (sol * 96).toFixed(2);
const pctStr  = n   => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const nowMs   = ()  => Date.now();

const PROFIT_GIFS = [
  'https://media.tenor.com/LxMBBtB7SWIAAAAC/lets-go-kevin-hart.gif',
  'https://media.tenor.com/7PMPpHm3tnsAAAAC/money-cash.gif',
  'https://media.tenor.com/g1jMbTKW_LEAAAAC/hell-yeah-yes.gif',
  'https://media.tenor.com/GfxAlL4YPRYAAAAC/make-it-rain-money.gif',
];
const randomGif = () => PROFIT_GIFS[Math.floor(Math.random()*PROFIT_GIFS.length)];

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

async function tokenSymbol(mint) {
  try {
    const r = await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mint}`);
    if(r.ok){ const d = await r.json(); return d.symbol||'???'; }
  } catch(e){}
  return '???';
}

// ── CONFIRM ───────────────────────────────────────────────────

async function confirm(sig, timeoutMs=15000) {
  const start = nowMs();
  while(nowMs()-start < timeoutMs) {
    try {
      const r = await state.connection.getSignatureStatuses([sig]);
      const v = r?.value?.[0];
      if(v?.err) return false;
      if(v?.confirmationStatus==='confirmed'||v?.confirmationStatus==='finalized') return true;
    } catch(e){}
    await sleep(300);
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
    return { solValue: parseFloat(q.outAmount)/1e9, raw };
  } catch(e){ return null; }
}

// ── SELL 100% ─────────────────────────────────────────────────

async function execSell(mint, reason, attempt=1) {
  if(CONFIG.DRY_RUN) {
    log('DRY', `SELL 100% — ${reason}`);
    return { success:true, solBack: CONFIG.BUY_AMOUNT_SOL*(1+(CONFIG.TAKE_PROFIT_PERCENT/100)), dry:true };
  }

  const feeSol = CONFIG.PRIORITY_FEE_MICRO_LAMPORTS/1e9;
  try {
    const accts = await state.connection.getParsedTokenAccountsByOwner(
      state.keypair.publicKey, { mint: new PublicKey(mint) }
    );
    const acct = accts?.value?.[0];
    if(!acct){ return {success:false, reason:'no_account'}; }
    const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount||0);
    if(bal<=0){ return {success:false, reason:'zero_balance'}; }
    const dec = acct.account.data.parsed.info.tokenAmount.decimals;
    const raw = BigInt(Math.floor(bal * Math.pow(10,dec)));
    if(raw<=0n){ return {success:false, reason:'zero_raw'}; }

    const qr = await fetch(
      `${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL_MINT}&amount=${raw.toString()}&slippageBps=${CONFIG.SLIPPAGE_BPS}`
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
    const sig = await state.connection.sendRawTransaction(tx.serialize(),{
      skipPreflight:true, maxRetries:2,
    });

    if(await confirm(sig, 12000)){
      state.stats.feesTotal += feeSol;
      return { success:true, solBack: parseFloat(q.outAmount)/1e9, sig };
    }
    throw new Error('Confirm timeout');
  } catch(e) {
    log('ERROR',`Sell fail (${attempt}/${CONFIG.SELL_MAX_RETRIES}): ${e.message}`);
    if(attempt < CONFIG.SELL_MAX_RETRIES){
      await sleep(200*attempt);
      return execSell(mint, reason, attempt+1);
    }
    return { success:false, error:e.message };
  }
}

// ── CLOSE POSITION ────────────────────────────────────────────

async function closePosition(reason, label) {
  const pos = state.position;
  if(!pos) return;

  const ageSec = ((nowMs()-pos.entryTime)/1000).toFixed(2);

  if(CONFIG.DRY_RUN) {
    log('DRY', `CLOSE — ${label} | ${pos.sym} | held ${ageSec}s`);
    state.position = null;
    return;
  }

  log('EXIT', `${label} — selling 100% of ${pos.sym} after ${ageSec}s`);
  const res = await execSell(pos.mint, reason);

  if(res.success) {
    const solBack = res.solBack;
    const pnl     = solBack - pos.sol;
    const roi     = ((solBack/pos.sol)-1)*100;
    const sign    = pnl>=0?'+':'';
    const emoji   = pnl>=0?'📈':'📉';

    state.stats.totalPnl += pnl;
    state.stats.sells++;
    if(pnl>=0) state.stats.wins++; else state.stats.losses++;

    const wr = state.stats.sells>0
      ? ((state.stats.wins/state.stats.sells)*100).toFixed(0):'0';

    log('SELL', `✅ ${pos.sym} → ${solBack.toFixed(4)} SOL | pnl:${sign}${pnl.toFixed(4)} (${pctStr(roi)}) | held:${ageSec}s | WR:${wr}%`);

    const exitType =
        reason==='take_profit' ? '🏁 TAKE PROFIT'
      : reason==='stop_loss'   ? '🛑 STOP LOSS'
      : reason==='max_hold'    ? '⏱ TIME EXIT'
      : '🔴 EXIT';

    const dMsg = [
      `${exitType} — **${pos.sym}**`,
      '━━━━━━━━━━━━━━━━━━━━',
      `📥  Entry: **$${SOL_USD(pos.sol)}** (${pos.sol} SOL)`,
      `📤  Exit:  **$${SOL_USD(solBack)}** (${solBack.toFixed(4)} SOL)`,
      `${emoji}  PnL:   **${sign}$${SOL_USD(Math.abs(pnl))}** (${pctStr(roi)})`,
      `⏱  Held:  **${ageSec}s** | Peak: **${pctStr(pos.peakRoi||0)}**`,
      '━━━━━━━━━━━━━━━━━━━━',
      `📊  Session: **${state.stats.wins}W/${state.stats.losses}L** (${wr}% WR)`,
      `💰  Total PnL: **${state.stats.totalPnl>=0?'+':''}$${SOL_USD(Math.abs(state.stats.totalPnl))}**`,
      `🔗  https://solscan.io/tx/${res.sig}`,
    ];
    if(pnl>0) dMsg.push(randomGif());
    await discord(dMsg.join('\n'));
  } else {
    log('ERROR',`Close failed: ${res.error}`);
    await discord(`🆘  **SELL FAILED — ${pos.sym}**\nSell manually: https://jup.ag/swap/${pos.mint}-SOL`);
  }
  state.position = null;
}

// ── BUY ───────────────────────────────────────────────────────

async function execBuy(mint, signalAgeMs) {
  const sol      = CONFIG.BUY_AMOUNT_SOL;
  const lamports = Math.floor(sol*1e9);
  const sym      = await tokenSymbol(mint);
  const feeSol   = CONFIG.PRIORITY_FEE_MICRO_LAMPORTS/1e9;

  log('SIGNAL', `TARGET BUY: ${sym} | age:${(signalAgeMs/1000).toFixed(2)}s | ${mint.slice(0,16)}...`);

  if(CONFIG.DRY_RUN) {
    log('DRY', `Would buy ${sol} SOL of ${sym}`);
    state.position = {
      mint, sym, sol,
      entryTime: nowMs(),
      peakRoi: 0, lastRoi: 0,
    };
    state.stats.buys++;
    await discord(
      `🔵 **[DRY] SIGNAL — ${sym}**\n\`${mint}\`\n` +
      `⚡ Age: **${(signalAgeMs/1000).toFixed(2)}s** | Would buy **${sol} SOL**\n` +
      `📊 https://dexscreener.com/solana/${mint}`
    );
    return true;
  }

  try {
    const t0 = nowMs();

    // Quote
    const qr = await fetch(
      `${CONFIG.JUPITER_QUOTE}?inputMint=${CONFIG.SOL_MINT}&outputMint=${mint}&amount=${lamports}&slippageBps=${CONFIG.SLIPPAGE_BPS}`
    );
    if(!qr.ok) throw new Error(`Quote ${qr.status}`);
    const q = await qr.json();
    if(!q.outAmount||q.outAmount==='0') throw new Error('No route');

    // Swap
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
    const sig = await state.connection.sendRawTransaction(tx.serialize(),{
      skipPreflight:true, maxRetries:2,
    });

    if(!await confirm(sig, 15000)) throw new Error('Confirm timeout');

    const latency = nowMs()-t0;
    state.stats.buys++;
    state.stats.feesTotal += feeSol;
    state.position = {
      mint, sym, sol,
      entryTime: nowMs(),
      peakRoi: -Infinity, lastRoi: 0,
      sig,
    };

    log('BUY', `✅ ${sym} | ${sol} SOL | latency:${latency}ms | sig:${sig.slice(0,20)}...`);
    await discord(
      `🟢  **COPY BUY — ${sym}**\n\`${mint}\`\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `⚡  Signal: **${(signalAgeMs/1000).toFixed(2)}s** old | Latency: **${latency}ms**\n` +
      `💸  Bought: **${sol} SOL** (~$${SOL_USD(sol)}) | Mode: **${MODE_KEY}**\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🏁  TP: **+${CONFIG.TAKE_PROFIT_PERCENT}%** → sell 100%\n` +
      `🛑  SL: **-${CONFIG.STOP_LOSS_PERCENT}%** | Max: **${CONFIG.MAX_HOLD_SECONDS}s**\n` +
      `🔗  https://solscan.io/tx/${sig}\n` +
      `📊  https://dexscreener.com/solana/${mint}`
    );
    return true;
  } catch(e) {
    log('ERROR',`Buy failed: ${e.message}`);
    await discord(`❌  **BUY FAILED** — ${sym}\n${e.message}`);
    return false;
  }
}

// ── EXIT MANAGER ──────────────────────────────────────────────

async function exitManager() {
  log('INFO',`🏁 Exit | TP:+${CONFIG.TAKE_PROFIT_PERCENT}% SL:-${CONFIG.STOP_LOSS_PERCENT}% Max:${CONFIG.MAX_HOLD_SECONDS}s | check every ${CONFIG.EXIT_CHECK_MS}ms`);

  while(state.isRunning) {
    await sleep(CONFIG.EXIT_CHECK_MS);
    const pos = state.position;
    if(!pos) continue;

    const ageSec = (nowMs()-pos.entryTime)/1000;

    // ── HARD TIME EXIT ────────────────────────────────────
    if(ageSec >= CONFIG.MAX_HOLD_SECONDS) {
      await closePosition('max_hold', `⏱ ${CONFIG.MAX_HOLD_SECONDS}s MAX HOLD`);
      continue;
    }

    // DRY RUN: just simulate
    if(CONFIG.DRY_RUN) {
      // Simulate a ramp up to TP then fade
      const simRoi = Math.sin(ageSec/CONFIG.MAX_HOLD_SECONDS*Math.PI)*CONFIG.TAKE_PROFIT_PERCENT*1.2;
      pos.lastRoi = simRoi;
      const bar = simRoi>=0
        ? '█'.repeat(Math.min(Math.floor(simRoi/2),20))+'░'.repeat(Math.max(20-Math.floor(simRoi/2),0))
        : '▓'.repeat(Math.min(Math.floor(Math.abs(simRoi)/2),20));
      console.log(`  🔵 [DRY][${pos.sym}] ${pctStr(simRoi)} [${bar}] | ${ageSec.toFixed(1)}s/${CONFIG.MAX_HOLD_SECONDS}s`);
      if(simRoi >= CONFIG.TAKE_PROFIT_PERCENT) {
        log('DRY',`Simulated TP hit at ${pctStr(simRoi)}`);
        state.position = null;
      }
      continue;
    }

    // ── GET VALUE ─────────────────────────────────────────
    const result = await getTokenValue(pos.mint);
    if(!result) continue;

    const roi = ((result.solValue/pos.sol)-1)*100;
    if(roi > (pos.peakRoi||0)) pos.peakRoi = roi;
    pos.lastRoi = roi;

    const bar = roi>=0
      ? '█'.repeat(Math.min(Math.floor(roi/2),20))+'░'.repeat(Math.max(20-Math.floor(roi/2),0))
      : '▓'.repeat(Math.min(Math.floor(Math.abs(roi)/2),20));
    const left = (CONFIG.MAX_HOLD_SECONDS-ageSec).toFixed(1);
    console.log(`  [${pos.sym}] ${pctStr(roi)} [${bar}] | ${ageSec.toFixed(1)}s | ${left}s left | TP:+${CONFIG.TAKE_PROFIT_PERCENT}% SL:-${CONFIG.STOP_LOSS_PERCENT}%`);

    // ── TAKE PROFIT ───────────────────────────────────────
    if(roi >= CONFIG.TAKE_PROFIT_PERCENT) {
      log('EXIT',`🏁 TP ${pctStr(roi)} on ${pos.sym}`);
      await closePosition('take_profit', `🏁 TP ${pctStr(roi)}`);
      continue;
    }

    // ── STOP LOSS ─────────────────────────────────────────
    if(roi <= -CONFIG.STOP_LOSS_PERCENT) {
      log('EXIT',`🛑 SL ${pctStr(roi)} on ${pos.sym}`);
      await closePosition('stop_loss', `🛑 SL ${pctStr(roi)}`);
      continue;
    }
  }
}

// ── PARSE TARGET TX ───────────────────────────────────────────

async function parseBuyFromSig(sig) {
  const detectTime = nowMs();
  try {
    const r = await fetch(CONFIG.HELIUS_TX, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ transactions:[sig] }),
    });
    if(!r.ok) throw new Error(`TX ${r.status}`);
    const txs = await r.json();
    const tx  = txs?.[0];
    if(!tx||tx.transactionError) return;

    // Age check immediately after parsing
    // blockTime is in seconds; if missing use detectTime
    const blockTimeMs = tx.timestamp ? tx.timestamp*1000 : detectTime;
    const signalAgeMs = nowMs() - blockTimeMs;

    if(signalAgeMs > CONFIG.MAX_SIGNAL_AGE_SECONDS*1000) {
      log('SKIP',`Too old: ${(signalAgeMs/1000).toFixed(2)}s (max ${CONFIG.MAX_SIGNAL_AGE_SECONDS}s)`);
      state.stats.signalsSkipped++;
      return;
    }

    const tfers  = tx.tokenTransfers||[];
    const native = tx.nativeTransfers||[];
    const desc   = (tx.description||'').toLowerCase();
    const txType = tx.type||'';

    // Skip non-swap types
    if(txType==='TRANSFER') return;
    if(desc.includes('claim')||desc.includes('close')) return;

    // Find mints received by target
    const mintsBought = [];
    for(const t of tfers){
      if(IGNORE_MINTS.has(t.mint)||t.mint===CONFIG.SOL_MINT) continue;
      if(t.toUserAccount===CONFIG.TARGET_WALLET&&t.tokenAmount>0){
        mintsBought.push(t.mint);
      }
    }

    // Fallback: check token balance increases for target
    if(mintsBought.length===0){
      for(const a of (tx.accountData||[])){
        for(const c of (a.tokenBalanceChanges||[])){
          if(c.userAccount===CONFIG.TARGET_WALLET&&
             !IGNORE_MINTS.has(c.mint)&&
             parseFloat(c.rawTokenAmount?.tokenAmount||0)>0){
            mintsBought.push(c.mint);
          }
        }
      }
    }

    if(!mintsBought.length){
      log('SKIP',`No token buy found — type:${txType}`);
      return;
    }

    const mint = mintsBought[0];

    if(state.tradedMints.has(mint)){
      log('SKIP',`Already traded ${mint.slice(0,16)}...`);
      state.stats.signalsSkipped++;
      return;
    }
    if(state.position){
      log('SKIP',`In position (${state.position.sym}) — skipping`);
      state.stats.signalsSkipped++;
      return;
    }
    if(state.buyInProgress){
      log('SKIP','Buy in progress');
      return;
    }

    // Final age check after full parse
    const finalAge = nowMs()-blockTimeMs;
    if(finalAge > CONFIG.MAX_SIGNAL_AGE_SECONDS*1000){
      log('SKIP',`Expired after parse: ${(finalAge/1000).toFixed(2)}s`);
      state.stats.signalsSkipped++;
      return;
    }

    const bal = await solBal();
    if(bal < CONFIG.MIN_SOL_BALANCE){
      log('WARN',`Low balance: ${bal.toFixed(4)} SOL`);
      await discord(`⚠️  **LOW BALANCE** — ${bal.toFixed(4)} SOL | Need ${CONFIG.MIN_SOL_BALANCE} SOL`);
      return;
    }

    state.stats.signalsDetected++;
    state.tradedMints.add(mint);
    state.buyInProgress = true;

    const success = await execBuy(mint, finalAge);
    state.buyInProgress = false;
    if(!success) state.tradedMints.delete(mint);

  } catch(e){
    log('ERROR',`parseBuyFromSig: ${e.message}`);
    state.buyInProgress = false;
  }
}

// ── HELIUS WEBSOCKET ──────────────────────────────────────────

function connectHelius() {
  log('INFO',`🔌 Connecting — watching ${CONFIG.TARGET_WALLET.slice(0,20)}...`);
  const ws = new WebSocket(CONFIG.HELIUS_WS);
  state.ws = ws;

  ws.on('open',()=>{
    log('INFO','✅ WS connected');
    ws.send(JSON.stringify({
      jsonrpc:'2.0', id:1,
      method:'logsSubscribe',
      params:[
        { mentions:[CONFIG.TARGET_WALLET] },
        { commitment:'confirmed' },
      ],
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

      // Dedup
      if(state.processedSigs.has(sig)) return;
      state.processedSigs.add(sig);
      if(state.processedSigs.size>500){
        const first = state.processedSigs.values().next().value;
        state.processedSigs.delete(first);
      }

      // Fast pre-filter — skip obvious non-buys
      const logStr = logs.join(' ');
      if(logStr.includes('CloseAccount')) return;
      if(logStr.includes('claim_cashback')) return;

      // Must involve a DEX/swap program
      const isSwap =
        logStr.includes('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')||  // pump.fun
        logStr.includes('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')||   // pumpswap
        logStr.includes('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8')||  // raydium v4
        logStr.includes('JUP')||
        logStr.includes('Instruction: Buy')||
        logStr.includes('ray_log');

      if(!isSwap) return;

      log('INFO',`📨 Potential buy — ${sig.slice(0,20)}...`);
      parseBuyFromSig(sig).catch(e=>log('ERROR',`parse: ${e.message}`));

    } catch(e){ log('ERROR',`WS: ${e.message}`); }
  });

  ws.on('error', e=>log('ERROR',`WS: ${e.message}`));
  ws.on('close', code=>{
    log('INFO',`WS closed (${code}) — reconnect in 2s`);
    state.ws = null;
    if(state.isRunning) setTimeout(connectHelius, 2000);
  });

  const ping = setInterval(()=>{
    if(ws.readyState===WebSocket.OPEN) ws.ping();
    else clearInterval(ping);
  }, 20000);
}

// ── HEALTH ────────────────────────────────────────────────────

async function health() {
  while(state.isRunning) {
    await sleep(CONFIG.HEALTH_MS);
    const bal    = await solBal();
    const pnl    = bal-state.stats.startBal;
    const wr     = state.stats.sells>0
      ? ((state.stats.wins/state.stats.sells)*100).toFixed(0):'0';
    const uptime = ((nowMs()-state.stats.startTime)/60000).toFixed(0);
    const wsOk   = state.ws?.readyState===WebSocket.OPEN;
    const mode   = CONFIG.DRY_RUN ? '🔵 DRY' : '🔴 LIVE';

    const lines = [
      '', '═'.repeat(62),
      `  ⚡ WINSTON v32.0 | ${mode} | MODE: ${MODE_KEY}`,
      '═'.repeat(62),
      `  📡 WS: ${wsOk?'🟢 LIVE':'🔴 RECONN'} | Events:${state.wsEvents} | Uptime:${uptime}min`,
      `  🎯 ${CONFIG.TARGET_WALLET.slice(0,24)}...`,
      `  💸  Buy:${CONFIG.BUY_AMOUNT_SOL} SOL | TP:+${CONFIG.TAKE_PROFIT_PERCENT}% SL:-${CONFIG.STOP_LOSS_PERCENT}% Max:${CONFIG.MAX_HOLD_SECONDS}s`,
      `  💰  ${bal.toFixed(4)} SOL ($${SOL_USD(bal)}) | PnL:${pnl>=0?'+':''}${pnl.toFixed(4)} SOL`,
      `  📊  ${state.stats.wins}W/${state.stats.losses}L (${wr}%WR) | Sigs:${state.stats.signalsDetected}/${state.stats.signalsSkipped}skip | Fees:${state.stats.feesTotal.toFixed(4)}`,
    ];
    if(state.position){
      const p   = state.position;
      const age = ((nowMs()-p.entryTime)/1000).toFixed(1);
      const lft = Math.max(0,CONFIG.MAX_HOLD_SECONDS-parseFloat(age)).toFixed(1);
      lines.push(`  📦 ${p.sym} | roi:${pctStr(p.lastRoi)} | ${age}s | ${lft}s left`);
    } else {
      lines.push('  📭 Watching...');
    }
    lines.push('═'.repeat(62));
    console.log(lines.join('\n'));
  }
}

// ── MAIN ──────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  ⚡ WINSTON v32.0 — Ultra-Fast Copy Scalp Bot                 ║`);
  console.log(`║  Mode: ${MODE_KEY.padEnd(10)} | TP:+${String(CONFIG.TAKE_PROFIT_PERCENT).padEnd(4)}% SL:-${String(CONFIG.STOP_LOSS_PERCENT).padEnd(3)}% Max:${CONFIG.MAX_HOLD_SECONDS}s         ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  if(!CONFIG.HELIUS_API_KEY){ log('ERROR','HELIUS_API_KEY missing'); process.exit(1); }
  if(!CONFIG.PRIVATE_KEY)   { log('ERROR','WALLET_PRIVATE_KEY missing'); process.exit(1); }

  try {
    state.keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
    log('INFO',`Wallet: ${state.keypair.publicKey.toString()}`);
  } catch(e){ log('ERROR',`Bad key: ${e.message}`); process.exit(1); }

  state.connection     = new Connection(CONFIG.HELIUS_RPC, {commitment:'confirmed'});
  state.stats.startBal = await solBal();
  log('INFO',`Balance: ${state.stats.startBal.toFixed(4)} SOL | Mode: ${MODE_KEY} | TP:+${CONFIG.TAKE_PROFIT_PERCENT}% SL:-${CONFIG.STOP_LOSS_PERCENT}% Max:${CONFIG.MAX_HOLD_SECONDS}s`);
  log('INFO',`Priority: ${CONFIG.PRIORITY_FEE_MICRO_LAMPORTS}μL | Slippage: ${CONFIG.SLIPPAGE_BPS/100}% | DRY_RUN: ${CONFIG.DRY_RUN}`);

  if(!CONFIG.DRY_RUN && state.stats.startBal < CONFIG.MIN_SOL_BALANCE){
    log('ERROR',`Balance too low — need ${CONFIG.MIN_SOL_BALANCE} SOL`);
    process.exit(1);
  }

  state.isRunning = true;
  connectHelius();

  await discord(
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `⚡  **WINSTON v32.0 ONLINE**\n` +
    `${CONFIG.DRY_RUN?'🔵 **DRY RUN**\n':''}` +
    `**Ultra-Fast Copy Scalp** | Mode: **${MODE_KEY}**\n` +
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `🎯  \`${CONFIG.TARGET_WALLET}\`\n` +
    `💸  Buy: **${CONFIG.BUY_AMOUNT_SOL} SOL** (~$${SOL_USD(CONFIG.BUY_AMOUNT_SOL)})\n` +
    `⚡  Max signal age: **${CONFIG.MAX_SIGNAL_AGE_SECONDS}s**\n` +
    `🏁  TP: **+${CONFIG.TAKE_PROFIT_PERCENT}%** | SL: **-${CONFIG.STOP_LOSS_PERCENT}%** | Max: **${CONFIG.MAX_HOLD_SECONDS}s**\n` +
    `⚙️  Priority: **${CONFIG.PRIORITY_FEE_MICRO_LAMPORTS}μL** | Slip: **${CONFIG.SLIPPAGE_BPS/100}%**\n` +
    `💰  Balance: **${state.stats.startBal.toFixed(4)} SOL**\n` +
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`
  );

  let down = false;
  const shutdown = async () => {
    if(down) return; down = true;
    state.isRunning = false;
    if(state.ws) state.ws.close();
    const fin = await solBal();
    const pnl = fin-state.stats.startBal;
    const wr  = state.stats.sells>0?((state.stats.wins/state.stats.sells)*100).toFixed(0):'0';
    await discord(
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n🔴  **WINSTON v32.0 OFFLINE**\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
      `💰  Final: **${fin.toFixed(4)} SOL** (~$${SOL_USD(fin)})\n` +
      `📈  PnL: **${pnl>=0?'+':''}$${SOL_USD(Math.abs(pnl))}** (${pnl>=0?'+':''}${pnl.toFixed(4)} SOL)\n` +
      `📊  **${state.stats.wins}W/${state.stats.losses}L** (${wr}%WR) | Fees: ${state.stats.feesTotal.toFixed(4)} SOL\n` +
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`
    );
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
          body: JSON.stringify({content:`💥 **WINSTON v32 CRASHED #${n}**\n❌ ${e.message}\nRestarting in 3s...`}),
        });
      } catch(_){}
      if(state.ws){ try{state.ws.close();}catch(_){} }
      state.isRunning = state.buyInProgress = false;
      state.ws = state.position = null;
      await new Promise(r=>setTimeout(r,3000));
    }
  }
}

runWithFailsafe();
