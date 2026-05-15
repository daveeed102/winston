// ============================================================
// WINSTON v33.0 — Momentum Copy Scalper
// ⚠️  HIGH RISK — for educational/personal use only
// ============================================================
// Target: 7L3siTX5mM4XPZSaS8NphTu5y641SnKKwth8Z2e3QFwu
//
// Strategy:
//   Copy FIRST buy only per token — ignore repeat buys.
//   His subsequent buys push price up — we ride that wave.
//   Exit on own rules before he starts selling.
//   Keep cycling: buy → profit → buy again.
//
// Buy size: random between MIN_BUY_SOL and MAX_BUY_SOL
//   Default: 0.055 - 0.088 SOL (~$5-$8)
//   Randomized each trade to avoid pattern detection.
//
// Exit:
//   TP:      +12% → sell 100%
//   SL:      -8%  → sell 100%
//   Max hold: 3 minutes
//   No moonbag. No tiers. Fast cycle.
//
// Fee minimization:
//   Priority: 200,000 micro-lamports (reduced from 500k)
//   Slippage: 10% (tighter than before)
//   Both configurable via env.
// ============================================================

require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const bs58  = require('bs58');
const fetch = require('node-fetch');
const WebSocket = require('ws');

// ── CONFIG ────────────────────────────────────────────────────
const CONFIG = {
  TARGET_WALLET:  process.env.TARGET_WALLET || '7L3siTX5mM4XPZSaS8NphTu5y641SnKKwth8Z2e3QFwu',
  PRIVATE_KEY:    process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || '',
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  DISCORD_WEBHOOK:process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || '',

  get HELIUS_RPC(){ return `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },
  get HELIUS_TX() { return `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${this.HELIUS_API_KEY}`; },
  get HELIUS_WS() { return process.env.HELIUS_WS_URL || `wss://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },

  JUPITER_QUOTE: 'https://lite-api.jup.ag/swap/v1/quote',
  JUPITER_SWAP:  'https://lite-api.jup.ag/swap/v1/swap',

  // ── Buy size — randomized each trade ─────────────────────
  MIN_BUY_SOL: parseFloat(process.env.MIN_BUY_SOL) || 0.033, // $3 fixed
  MAX_BUY_SOL: parseFloat(process.env.MAX_BUY_SOL) || 0.033, // $3 fixed — same as min

  // ── Signal filter ─────────────────────────────────────────
  MAX_SIGNAL_AGE_SECONDS:    parseInt(process.env.MAX_SIGNAL_AGE_SECONDS) || 8,
  MIN_BUYS_BEFORE_ENTRY:     parseInt(process.env.MIN_BUYS_BEFORE_ENTRY) || 8, // wait for 8 buys

  // ── Exit rules ────────────────────────────────────────────
  TAKE_PROFIT_PERCENT: parseFloat(process.env.TAKE_PROFIT_PERCENT) || 12,
  STOP_LOSS_PERCENT:   0, // NO stop loss — wait for profit
  MAX_HOLD_SECONDS:    parseInt(process.env.MAX_HOLD_SECONDS)      || 300, // 5 min — wait it out

  // ── Fees — minimized ──────────────────────────────────────
  // Reduced from 500k to 200k — saves ~$0.03 per trade
  // Still fast enough for this wallet's pace (he's not sub-second)
  SLIPPAGE_BPS:                1500, // 15% — hardcoded, ignores env var
  PRIORITY_FEE_MICRO_LAMPORTS: parseInt(process.env.PRIORITY_FEE_MICRO_LAMPORTS) || 1000000, // 1M — competitive

  // ── Mode ──────────────────────────────────────────────────

  get MIN_SOL_BALANCE(){ return 0.043; }, // 0.033 buy + 0.01 fees
  EXIT_CHECK_MS: 500,
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
  mintBuyCounts: new Map(), // mint → how many times target bought it
  tradedMints:   new Set(), // mints we've entered (cleared after sell)
  processedSigs: new Set(),
  buyInProgress: false,
  wsEvents:      0,
  cycleCount:    0,         // total completed buy-sell cycles
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
                SIGNAL:'🎯',EXIT:'🏁',SKIP:'⏭',WARN:'⚠️' };
  console.log(`[${ts}] ${ic[lv]||'📋'} [${lv}] ${msg}${Object.keys(d).length?' '+JSON.stringify(d):''}`);
}

const sleep   = ms  => new Promise(r => setTimeout(r, ms));
const SOL_USD = sol => (sol * 96).toFixed(2);
const pctStr  = n   => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const nowMs   = ()  => Date.now();

// Smart buy sizing based on signal quality
// signalAgeMs: how old the signal is when we act
// targetSolSpent: how much SOL the target wallet put in
//
// HIGH (0.088 SOL): age < 3s AND target spent >= 1.0 SOL
// LOW  (0.055 SOL): age > 5s OR target spent < 0.3 SOL
// MID  (interpolated): everything in between
function smartBuySol(signalAgeMs, targetSolSpent) {
  const min    = CONFIG.MIN_BUY_SOL;
  const max    = CONFIG.MAX_BUY_SOL;
  const ageSec = signalAgeMs / 1000;

  // Low confidence → minimum
  if(ageSec > 5 || targetSolSpent < 0.3) return min;

  // High confidence → maximum
  if(ageSec < 3 && targetSolSpent >= 1.0) return max;

  // Medium — blend age + size into a confidence score
  const ageScore  = Math.min(Math.max((ageSec - 1) / 4, 0), 1); // 0=fresh, 1=old
  const sizeScore = Math.min(Math.max((targetSolSpent - 0.3) / 1.2, 0), 1); // 0=small, 1=big
  const confidence = (1 - ageScore) * 0.6 + sizeScore * 0.4;
  const raw = min + confidence * (max - min);
  return Math.round(raw * 1000) / 1000;
}

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

async function confirm(sig, timeoutMs=20000) {
  const start = nowMs();
  while(nowMs()-start < timeoutMs) {
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
    return parseFloat(q.outAmount)/1e9;
  } catch(e){ return null; }
}

// ── SELL 100% ─────────────────────────────────────────────────

async function execSell(mint, reason, attempt=1) {
  const feeSol = CONFIG.PRIORITY_FEE_MICRO_LAMPORTS/1e9;
  try {
    const accts = await state.connection.getParsedTokenAccountsByOwner(
      state.keypair.publicKey, { mint: new PublicKey(mint) }
    );
    const acct = accts?.value?.[0];
    if(!acct) return {success:false, reason:'no_account'};
    const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount||0);
    if(bal<=0) return {success:false, reason:'zero_balance'};
    const dec = acct.account.data.parsed.info.tokenAmount.decimals;
    const raw = BigInt(Math.floor(bal * Math.pow(10,dec)));
    if(raw<=0n) return {success:false, reason:'zero_raw'};

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

    if(await confirm(sig, 15000)){
      state.stats.feesTotal += feeSol;
      return { success:true, solBack:parseFloat(q.outAmount)/1e9, sig };
    }
    throw new Error('Confirm timeout');
  } catch(e) {
    log('ERROR',`Sell fail (${attempt}/${CONFIG.SELL_MAX_RETRIES}): ${e.message}`);
    if(attempt < CONFIG.SELL_MAX_RETRIES){
      await sleep(300*attempt);
      return execSell(mint, reason, attempt+1);
    }
    // ── FALLBACK: try with emergency slippage ────────────────
    // If all retries failed, one last attempt with max slippage
    log('ERROR', `All retries failed — trying emergency sell with 50% slippage`);
    try {
      const accts2 = await state.connection.getParsedTokenAccountsByOwner(
        state.keypair.publicKey, { mint: new PublicKey(mint) }
      );
      const acct2 = accts2?.value?.[0];
      if(acct2) {
        const bal2 = parseFloat(acct2.account.data.parsed.info.tokenAmount.uiAmount||0);
        const dec2 = acct2.account.data.parsed.info.tokenAmount.decimals;
        const raw2 = BigInt(Math.floor(bal2 * Math.pow(10,dec2)));
        if(raw2 > 0n) {
          const qr2 = await fetch(
            `${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL_MINT}&amount=${raw2.toString()}&slippageBps=5000`
          );
          if(qr2.ok) {
            const q2 = await qr2.json();
            if(q2.outAmount) {
              const sr2 = await fetch(CONFIG.JUPITER_SWAP, {
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({
                  quoteResponse: q2,
                  userPublicKey: state.keypair.publicKey.toString(),
                  wrapAndUnwrapSol: true,
                  dynamicSlippage: { minBps:50, maxBps:5000 },
                  prioritizationFeeLamports: 1000000, // 0.001 SOL — max priority
                }),
              });
              if(sr2.ok) {
                const sd2 = await sr2.json();
                if(sd2.swapTransaction) {
                  const buf2 = Buffer.from(sd2.swapTransaction,'base64');
                  const tx2  = VersionedTransaction.deserialize(buf2);
                  tx2.sign([state.keypair]);
                  const sig2 = await state.connection.sendRawTransaction(tx2.serialize(),{skipPreflight:true,maxRetries:5});
                  if(await confirm(sig2, 20000)){
                    const solBack2 = parseFloat(q2.outAmount)/1e9;
                    log('SELL', `✅ EMERGENCY SELL succeeded → ${solBack2.toFixed(4)} SOL`);
                    return { success:true, solBack:solBack2, sig:sig2 };
                  }
                }
              }
            }
          }
        }
      }
    } catch(e2) { log('ERROR', `Emergency sell also failed: ${e2.message}`); }

    // ── LAST RESORT: Pump.fun direct sell ────────────────────
    // When Jupiter has no route (bonding curve drained), try
    // selling directly through Pump.fun's own sell instruction
    log('ERROR', `Jupiter exhausted — trying Pump.fun direct sell`);
    try {
      const pumpResult = await pumpFunDirectSell(mint);
      if(pumpResult) {
        log('SELL', `✅ Pump.fun direct sell succeeded`);
        return { success:true, solBack: pumpResult, sig:'pump_direct' };
      }
    } catch(e3) { log('ERROR', `Pump.fun direct sell failed: ${e3.message}`); }

    await discord(
      `🆘  **COMPLETELY STUCK — ${mint.slice(0,16)}**\n` +
      `All sell methods failed. Check wallet manually:\n` +
      `https://jup.ag/swap/${mint}-SOL\n` +
      `https://pump.fun/${mint}`
    );
    return { success:false, error:e.message };
  }
}

// ── PUMP.FUN DIRECT SELL ──────────────────────────────────────
// Last resort when Jupiter has no route
// Sells directly through Pump.fun bonding curve program
// Works even when liquidity is very thin

async function pumpFunDirectSell(mint) {
  try {
    // Get our token balance
    const accts = await state.connection.getParsedTokenAccountsByOwner(
      state.keypair.publicKey, { mint: new PublicKey(mint) }
    );
    const acct = accts?.value?.[0];
    if(!acct) return null;
    const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount||0);
    if(bal <= 0) return null;

    // Use Pump.fun API to get sell transaction
    const dec = acct.account.data.parsed.info.tokenAmount.decimals;
    const raw = Math.floor(bal * Math.pow(10, dec));

    // Pump.fun trade API — works for bonding curve tokens
    const r = await fetch('https://pumpportal.fun/api/trade-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey:        state.keypair.publicKey.toString(),
        action:           'sell',
        mint:             mint,
        amount:           raw,
        denominatedInSol: 'false', // amount is in tokens not SOL
        slippage:         50,      // 50% slippage — get out at any cost
        priorityFee:      0.001,   // 0.001 SOL priority
        pool:             'pump',
      }),
    });

    if(!r.ok) throw new Error(`Pump API ${r.status}`);
    const data = await r.arrayBuffer();
    const tx   = VersionedTransaction.deserialize(new Uint8Array(data));
    tx.sign([state.keypair]);

    const sig = await state.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true, maxRetries: 5,
    });

    if(await confirm(sig, 20000)) {
      log('SELL', `✅ Pump.fun direct sell confirmed: ${sig.slice(0,20)}`);
      // Return estimate — actual amount unknown without parsing
      return 0.001; // minimal SOL, but at least we're out
    }
    return null;
  } catch(e) {
    log('ERROR', `pumpFunDirectSell: ${e.message}`);
    return null;
  }
}

// ── CLOSE POSITION ────────────────────────────────────────────

async function closePosition(reason, label) {
  const pos = state.position;
  if(!pos) return;

  const ageSec = ((nowMs()-pos.entryTime)/1000).toFixed(1);
  log('EXIT', `${label} — selling 100% of ${pos.sym} after ${ageSec}s`);

  const res = await execSell(pos.mint, reason);

  if(res.success) {
    const solBack  = res.solBack;
    const pnl      = solBack - pos.sol;
    const roi      = ((solBack/pos.sol)-1)*100;
    const sign     = pnl>=0?'+':'';
    const emoji    = pnl>=0?'📈':'📉';

    state.stats.totalPnl += pnl;
    state.stats.sells++;
    state.cycleCount++;
    if(pnl>=0) state.stats.wins++; else state.stats.losses++;

    const wr  = state.stats.sells>0 ? ((state.stats.wins/state.stats.sells)*100).toFixed(0):'0';
    const bal = await solBal();

    log('SELL',
      `✅ CYCLE #${state.cycleCount} | ${pos.sym} | ` +
      `in:${pos.sol.toFixed(3)} out:${solBack.toFixed(4)} | ` +
      `pnl:${sign}${pnl.toFixed(4)} SOL (${pctStr(roi)}) | ` +
      `held:${ageSec}s | bal:${bal.toFixed(4)} SOL | WR:${wr}%`
    );

    const exitType =
        reason==='take_profit' ? '🏁 TAKE PROFIT'
      : reason==='stop_loss'   ? '🛑 STOP LOSS'
      : '⏱ TIME EXIT';

    const feeRoundTrip = (CONFIG.PRIORITY_FEE_MICRO_LAMPORTS*2)/1e9;
    const netPnl = pnl - feeRoundTrip;

    const dMsg = [
      `${exitType} — **${pos.sym}** | Cycle #${state.cycleCount}`,
      '━━━━━━━━━━━━━━━━━━━━',
      `📥  Entry:    **$${SOL_USD(pos.sol)}** (${pos.sol.toFixed(3)} SOL)`,
      `📤  Exit:     **$${SOL_USD(solBack)}** (${solBack.toFixed(4)} SOL)`,
      `${emoji}  Gross PnL: **${sign}$${SOL_USD(Math.abs(pnl))}** (${pctStr(roi)})`,
      `💸  Est. fees: ~$${SOL_USD(feeRoundTrip)} | Net: **${sign}$${SOL_USD(Math.abs(netPnl))}**`,
      `⏱  Held: **${ageSec}s** | Peak: **${pctStr(pos.peakRoi||0)}**`,
      '━━━━━━━━━━━━━━━━━━━━',
      `📊  Session: **${state.stats.wins}W/${state.stats.losses}L** (${wr}% WR) | ${state.cycleCount} cycles`,
      `💰  Total PnL: **${state.stats.totalPnl>=0?'+':''}$${SOL_USD(Math.abs(state.stats.totalPnl))}** | Bal: **${bal.toFixed(4)} SOL**`,
      `🔗  https://solscan.io/tx/${res.sig}`,
    ];
    if(pnl>0) dMsg.push(randomGif());
    await discord(dMsg.join('\n'));
  } else {
    log('ERROR',`Close failed: ${res.error}`);
    await discord(`🆘  **SELL FAILED — ${pos.sym}**\nhttps://jup.ag/swap/${pos.mint}-SOL`);
  }
  state.position = null;

  // ── Reset tracking so we can re-enter on next conviction ───────
  // After sell: clear tradedMints entry + reset buy count to 0
  // So next time he hits 8 buys again on this token, we jump back in
  if(pos.mint) {
    state.tradedMints.delete(pos.mint);
    state.mintBuyCounts.delete(pos.mint); // reset count — need fresh 8 buys to re-enter
    log('INFO', `♻️  ${pos.sym} — tracking reset, need ${CONFIG.MIN_BUYS_BEFORE_ENTRY} new buys to re-enter`);
  }

  // ── BUY BACK IN immediately after any profitable exit ────────
  if(reason === 'take_profit') {
    log('INFO', '🔄 Sold for profit — back in watching mode, will buy next signal');
    await discord('🔄  **Profit taken! Watching for next buy signal...**');
  } else if(reason === 'max_hold' || reason === 'rug_detected') {
    log('INFO', `🔄 Position closed (${reason}) — watching for next signal`);
  }
}

// ── BUY ───────────────────────────────────────────────────────

async function execBuy(mint, signalAgeMs, targetSolSpent=0) {
  // Smart sizing: bigger buy when signal is fresh + target spent more
  const sol      = smartBuySol(signalAgeMs, targetSolSpent);
  const lamports = Math.floor(sol*1e9);
  const sym      = await tokenSymbol(mint);
  const feeSol   = CONFIG.PRIORITY_FEE_MICRO_LAMPORTS/1e9;

  // Confidence label for logging
  const confidence =
    sol >= CONFIG.MAX_BUY_SOL              ? '🔥 HIGH'  :
    sol <= CONFIG.MIN_BUY_SOL              ? '🧊 LOW'   : '⚡ MED';

  log('SIGNAL',
    `TARGET BUY: ${sym} | age:${(signalAgeMs/1000).toFixed(2)}s | ` +
    `target spent:${targetSolSpent.toFixed(3)} SOL | ` +
    `confidence:${confidence} → buying ${sol} SOL (~$${SOL_USD(sol)}) | ${mint.slice(0,16)}...`
  );

  try {
    const t0 = nowMs();

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
    const sig = await state.connection.sendRawTransaction(tx.serialize(),{
      skipPreflight:true, maxRetries:5,
    });

    if(!await confirm(sig, 30000)) throw new Error('Confirm timeout');

    const latency = nowMs()-t0;
    state.stats.buys++;
    state.stats.feesTotal += feeSol;
    state.position = {
      mint, sym, sol,
      entryTime: nowMs(),
      peakRoi: -Infinity, lastRoi: 0,
      sig,
    };

    const bal = await solBal();
    log('BUY',
      `✅ Cycle #${state.cycleCount+1} | ${sym} | ${sol} SOL (~$${SOL_USD(sol)}) | ` +
      `latency:${latency}ms | bal after:${bal.toFixed(4)} SOL`
    );

    await discord(
      `🟢  **COPY BUY — ${sym}** | Cycle #${state.cycleCount+1}\n` +
      `\`${mint}\`\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `⚡  Signal age: **${(signalAgeMs/1000).toFixed(2)}s** | Latency: **${latency}ms**\n` +
      `🎯  Target spent: **${targetSolSpent.toFixed(3)} SOL** | Confidence: **${confidence}**\n` +
      `💸  Bought: **${sol} SOL** (~$${SOL_USD(sol)}) | Fee: ~$${SOL_USD(feeSol)}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🏁  TP: **+${CONFIG.TAKE_PROFIT_PERCENT}%** | **No SL** — wait for profit | Max: **${CONFIG.MAX_HOLD_SECONDS}s**\n` +
      `💰  Remaining balance: **${bal.toFixed(4)} SOL** (~$${SOL_USD(bal)})\n` +
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
  log('INFO',`🏁 Exit | TP:+${CONFIG.TAKE_PROFIT_PERCENT}% | NO SL — wait for profit | Max:${CONFIG.MAX_HOLD_SECONDS}s`);

  while(state.isRunning) {
    await sleep(CONFIG.EXIT_CHECK_MS);
    const pos = state.position;
    if(!pos) continue;

    const ageSec = (nowMs()-pos.entryTime)/1000;

    // Hard time exit
    if(ageSec >= CONFIG.MAX_HOLD_SECONDS) {
      await closePosition('max_hold', `⏱ ${CONFIG.MAX_HOLD_SECONDS}s MAX HOLD`);
      continue;
    }

    const currentVal = await getTokenValue(pos.mint);
    if(!currentVal) continue;

    const roi = ((currentVal/pos.sol)-1)*100;
    if(roi > (pos.peakRoi||-Infinity)) pos.peakRoi = roi;
    pos.lastRoi = roi;

    const timeLeft = (CONFIG.MAX_HOLD_SECONDS-ageSec).toFixed(0);
    const bar = roi>=0
      ? '█'.repeat(Math.min(Math.floor(roi/2),20))+'░'.repeat(Math.max(20-Math.floor(roi/2),0))
      : '▓'.repeat(Math.min(Math.floor(Math.abs(roi)/2),20));
    console.log(
      `  [${pos.sym}] ${pctStr(roi)} [${bar}] | ${ageSec.toFixed(1)}s | ${timeLeft}s left | ` +
      `peak:${pctStr(pos.peakRoi)} | in:$${SOL_USD(pos.sol)}`
    );

    if(roi <= -90) {
      log('EXIT', `🚨 RUG DETECTED ${pos.sym} at ${pctStr(roi)} — emergency exit`);
      await closePosition('rug_detected', `🚨 RUG ${pctStr(roi)}`);
      continue;
    }

    if(roi >= CONFIG.TAKE_PROFIT_PERCENT) {
      await closePosition('take_profit', `🏁 TP ${pctStr(roi)}`);
      continue;
    }
    // No stop loss — we wait for profit or time exit
    // if(roi <= -CONFIG.STOP_LOSS_PERCENT) { ... }
  }
}

// ── PARSE TARGET TX ───────────────────────────────────────────

async function parseBuyFromSig(sig) {
  try {
    const r = await fetch(CONFIG.HELIUS_TX, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ transactions:[sig] }),
    });
    if(!r.ok) throw new Error(`TX ${r.status}`);
    const txs = await r.json();
    const tx  = txs?.[0];
    if(!tx||tx.transactionError) return;

    // Age check
    const blockTimeMs = tx.timestamp ? tx.timestamp*1000 : nowMs();
    const signalAgeMs = nowMs()-blockTimeMs;
    if(signalAgeMs > CONFIG.MAX_SIGNAL_AGE_SECONDS*1000) {
      log('SKIP',`Too old: ${(signalAgeMs/1000).toFixed(2)}s`);
      state.stats.signalsSkipped++;
      return;
    }

    const tfers   = tx.tokenTransfers||[];
    const native  = tx.nativeTransfers||[];
    const txType  = tx.type||'';
    const desc    = (tx.description||'').toLowerCase();

    if(txType==='TRANSFER') return;
    if(desc.includes('claim')||desc.includes('close')) return;

    // How much SOL did target spend on this buy?
    let solOut = 0;
    for(const t of native){
      if(t.fromUserAccount===CONFIG.TARGET_WALLET) solOut += (t.amount||0)/1e9;
    }

    // Find mints received by target wallet
    // Method 1: direct token transfers to target
    const mintsBought = [];
    for(const t of tfers){
      if(IGNORE_MINTS.has(t.mint)||t.mint===CONFIG.SOL_MINT) continue;
      if(t.toUserAccount===CONFIG.TARGET_WALLET&&parseFloat(t.tokenAmount||0)>0){
        mintsBought.push(t.mint);
      }
    }

    // Method 2: token balance changes (catches token→token swaps)
    if(!mintsBought.length){
      for(const a of (tx.accountData||[])){
        for(const c of (a.tokenBalanceChanges||[])){
          if(c.userAccount===CONFIG.TARGET_WALLET&&
             !IGNORE_MINTS.has(c.mint)&&
             c.mint!==CONFIG.SOL_MINT&&
             parseFloat(c.rawTokenAmount?.tokenAmount||0)>0){
            mintsBought.push(c.mint);
          }
        }
      }
    }

    // Method 3: any token arriving when SOL was sent (broad fallback)
    if(!mintsBought.length&&solOut>0.001&&tfers.length>0){
      for(const t of tfers){
        if(!IGNORE_MINTS.has(t.mint)&&t.mint!==CONFIG.SOL_MINT&&parseFloat(t.tokenAmount||0)>0){
          mintsBought.push(t.mint);
          break;
        }
      }
    }

    if(!mintsBought.length){
      log('SKIP',`No buy — type:${txType} solOut:${solOut.toFixed(3)} tfers:${tfers.length}`);
      return;
    }

    const mint = mintsBought[0];

    // ── CONVICTION COUNTER ────────────────────────────────
    // Track how many times target has bought this mint
    // Only enter after MIN_BUYS_BEFORE_ENTRY consecutive buys
    // This confirms real momentum, not a test/feeler buy
    const prevCount = state.mintBuyCounts.get(mint) || 0;
    const newCount  = prevCount + 1;
    state.mintBuyCounts.set(mint, newCount);

    const sym = await tokenSymbol(mint);

    // Clean up old mint counts to save memory (keep last 50)
    if(state.mintBuyCounts.size > 50){
      const firstKey = state.mintBuyCounts.keys().next().value;
      state.mintBuyCounts.delete(firstKey);
    }

    // Not enough buys yet — log progress and wait
    if(newCount < CONFIG.MIN_BUYS_BEFORE_ENTRY){
      log('INFO',`📊 ${sym} buy #${newCount}/${CONFIG.MIN_BUYS_BEFORE_ENTRY} — waiting for conviction`);
      return;
    }

    // Already in this position (we entered on buy #8, now he's on buy #12)
    // Re-enter after we sell — tradedMints cleared on sell
    if(state.tradedMints.has(mint)){
      log('SKIP',`Already in/traded ${sym} — buy #${newCount}, waiting for next entry`);
      return;
    }

    if(state.position){
      log('SKIP',`In position (${state.position.sym}) — skipping ${sym} buy #${newCount}`);
      state.stats.signalsSkipped++;
      return;
    }
    if(state.buyInProgress) return;

    const bal = await solBal();
    if(bal < CONFIG.MIN_SOL_BALANCE){
      log('WARN',`Low balance: ${bal.toFixed(4)} SOL — need ${CONFIG.MIN_SOL_BALANCE.toFixed(3)}`);
      await discord(
        `⚠️  **LOW BALANCE — PAUSING**\n` +
        `💰  Have: **${bal.toFixed(4)} SOL** (~$${SOL_USD(bal)})\n` +
        `Need: **${CONFIG.MIN_SOL_BALANCE.toFixed(3)} SOL** to continue cycling\n` +
        `Top up wallet to resume`
      );
      return;
    }

    // ── ENTRY CONFIRMED — buy #${newCount} hit the threshold ──
    log('INFO', `🎯 CONVICTION CONFIRMED — ${sym} buy #${newCount}/${CONFIG.MIN_BUYS_BEFORE_ENTRY} — ENTERING`);
    await discord(
      `🎯 **CONVICTION CONFIRMED — ${sym}**\n` +
      `📊 Target bought **${newCount}x** in a row — entering now\n` +
      `\`${mint}\``
    );

    state.stats.signalsDetected++;
    state.tradedMints.add(mint);
    state.buyInProgress = true;

    const success = await execBuy(mint, signalAgeMs, solOut);
    state.buyInProgress = false;
    if(!success) state.tradedMints.delete(mint); // allow retry if buy failed

  } catch(e){
    log('ERROR',`parseBuyFromSig: ${e.message}`);
    state.buyInProgress = false;
  }
}

// ── WEBSOCKET ─────────────────────────────────────────────────

function connectHelius() {
  log('INFO',`🔌 Watching ${CONFIG.TARGET_WALLET.slice(0,20)}...`);
  const ws = new WebSocket(CONFIG.HELIUS_WS);
  state.ws = ws;

  ws.on('open',()=>{
    log('INFO','✅ WS connected');
    ws.send(JSON.stringify({
      jsonrpc:'2.0', id:1,
      method:'logsSubscribe',
      params:[{ mentions:[CONFIG.TARGET_WALLET] }, { commitment:'confirmed' }],
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
        const first = state.processedSigs.values().next().value;
        state.processedSigs.delete(first);
      }

      const logStr = logs.join(' ');

      // Skip obvious non-trades immediately
      if(logStr.includes('CloseAccount')) return;
      if(logStr.includes('claim_cashback')) return;

      // Parse every other transaction — let Helius enhanced API
      // determine if it's a buy. Don't pre-filter by program ID
      // because the target wallet may route through aggregators
      // that don't show standard program IDs in logs.
      log('INFO', `📨 TX detected — ${sig.slice(0,20)}...`);
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
    const wr     = state.stats.sells>0?((state.stats.wins/state.stats.sells)*100).toFixed(0):'0';
    const uptime = ((nowMs()-state.stats.startTime)/60000).toFixed(0);
    const wsOk   = state.ws?.readyState===WebSocket.OPEN;
    const feeEst = (CONFIG.PRIORITY_FEE_MICRO_LAMPORTS*2)/1e9;

    const lines = [
      '', '═'.repeat(64),
      `  ⚡ WINSTON v33.0 | 🔴 LIVE | Cycles: ${state.cycleCount}`,
      '═'.repeat(64),
      `  📡 WS: ${wsOk?'🟢 LIVE':'🔴 RECONN'} | Events:${state.wsEvents} | Uptime:${uptime}min`,
      `  🎯 ${CONFIG.TARGET_WALLET.slice(0,28)}...`,
      `  💸  Buy: $${SOL_USD(CONFIG.MIN_BUY_SOL)}-$${SOL_USD(CONFIG.MAX_BUY_SOL)} (${CONFIG.MIN_BUY_SOL}-${CONFIG.MAX_BUY_SOL} SOL, random)`,
      `  🏁  TP:+${CONFIG.TAKE_PROFIT_PERCENT}% | No SL — wait for profit | Max:${CONFIG.MAX_HOLD_SECONDS}s`,
      `  💰  ${bal.toFixed(4)} SOL ($${SOL_USD(bal)}) | PnL:${pnl>=0?'+':''}$${SOL_USD(Math.abs(pnl))} (${pnl>=0?'+':''}${pnl.toFixed(4)} SOL)`,
      `  📊  ${state.stats.wins}W/${state.stats.losses}L (${wr}%WR) | Sigs:${state.stats.signalsDetected} | Fees/trade:~$${SOL_USD(feeEst)}`,
    ];

    if(state.position){
      const p   = state.position;
      const age = ((nowMs()-p.entryTime)/1000).toFixed(1);
      const lft = Math.max(0,CONFIG.MAX_HOLD_SECONDS-parseFloat(age)).toFixed(0);
      lines.push(`  📦 ${p.sym} | ${pctStr(p.lastRoi)} | ${age}s | ${lft}s left | in:$${SOL_USD(p.sol)}`);
    } else {
      lines.push(`  📭 Ready — watching for buys (${state.tradedMints.size} mints seen this session)`);
    }
    lines.push('═'.repeat(64));
    console.log(lines.join('\n'));
  }
}

// ── MAIN ──────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  ⚡ WINSTON v33.0 — Momentum Copy Scalper                     ║`);
  console.log(`║  Buy: $3 fixed (0.033 SOL) | TP:+12% | No SL | Max:5min           ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  if(!CONFIG.HELIUS_API_KEY){ log('ERROR','HELIUS_API_KEY missing'); process.exit(1); }
  if(!CONFIG.PRIVATE_KEY)   { log('ERROR','WALLET_PRIVATE_KEY missing'); process.exit(1); }

  try {
    state.keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
    log('INFO',`Wallet: ${state.keypair.publicKey.toString()}`);
  } catch(e){ log('ERROR',`Bad key: ${e.message}`); process.exit(1); }

  state.connection     = new Connection(CONFIG.HELIUS_RPC,{commitment:'confirmed'});
  state.stats.startBal = await solBal();

  log('INFO',`Balance: ${state.stats.startBal.toFixed(4)} SOL (~$${SOL_USD(state.stats.startBal)})`);
  log('INFO',`Buy range: ${CONFIG.MIN_BUY_SOL}-${CONFIG.MAX_BUY_SOL} SOL | Priority: ${CONFIG.PRIORITY_FEE_MICRO_LAMPORTS}μL | Slip: ${CONFIG.SLIPPAGE_BPS/100}%`);
  log('INFO',`Est. fee per round trip: ~$${SOL_USD((CONFIG.PRIORITY_FEE_MICRO_LAMPORTS*2)/1e9)}`);

  if(state.stats.startBal < CONFIG.MIN_SOL_BALANCE){
    log('ERROR',`Balance too low — need ${CONFIG.MIN_SOL_BALANCE.toFixed(3)} SOL`);
    process.exit(1);
  }

  state.isRunning = true;
  connectHelius();

  const feeEst = SOL_USD((CONFIG.PRIORITY_FEE_MICRO_LAMPORTS*2)/1e9);
  await discord(
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `⚡  **WINSTON v33.0 ONLINE**\n` +
    `**Momentum Copy Scalper**\n` +
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `🎯  \`${CONFIG.TARGET_WALLET}\`\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💸  Buy: **$${SOL_USD(CONFIG.MIN_BUY_SOL)}-$${SOL_USD(CONFIG.MAX_BUY_SOL)}** (random each trade)\n` +
    `⚡  Max signal age: **${CONFIG.MAX_SIGNAL_AGE_SECONDS}s**\n` +
    `🏁  TP: **+${CONFIG.TAKE_PROFIT_PERCENT}%** | **No SL** — wait for profit | Max: **${CONFIG.MAX_HOLD_SECONDS}s**\n` +
    `💸  Fee per trade: ~**$${feeEst}** (${CONFIG.PRIORITY_FEE_MICRO_LAMPORTS}μL priority)\n` +
    `📋  First buy only — skips repeat buys on same token\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💰  Balance: **${state.stats.startBal.toFixed(4)} SOL** (~$${SOL_USD(state.stats.startBal)})\n` +
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
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n🔴  **WINSTON v33.0 OFFLINE**\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
      `💰  Final: **${fin.toFixed(4)} SOL** (~$${SOL_USD(fin)})\n` +
      `📈  PnL: **${pnl>=0?'+':''}$${SOL_USD(Math.abs(pnl))}** (${pnl>=0?'+':''}${pnl.toFixed(4)} SOL)\n` +
      `📊  **${state.stats.wins}W/${state.stats.losses}L** (${wr}%WR) | ${state.cycleCount} cycles\n` +
      `💸  Total fees: **${state.stats.feesTotal.toFixed(4)} SOL** (~$${SOL_USD(state.stats.feesTotal)})\n` +
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
          body: JSON.stringify({content:`💥 **WINSTON v33 CRASHED #${n}**\n❌ ${e.message}\nRestart in 3s...`}),
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
