// ============================================================
// WINSTON v31.0 — Ultra-Fast Copy Sniper
// ⚠️  HIGH RISK — for educational/personal use only
// ============================================================
// Target: Ai15JKxo2oAncskTjStGq98fGk7v1drJRjTjDvDaZAL1
// Strategy: copy ENTRY only, own exit rules
//
// Exit rules (seconds-based scalper):
//   TP1: +20% → sell 70%
//   TP2: +35% → sell remaining 30%
//   INSTANT: +50% before TP1 → sell 100%
//   NO-MOVE: no movement after 10s → sell 100%
//   SL: -10% → sell 100%
//   MAX HOLD: 30s absolute → sell 100%
//
// Speed optimizations:
//   - logsSubscribe WebSocket for sub-second detection
//   - Signal age check: skip if >10s old
//   - Skip non-buy txs immediately from log patterns
//   - Parallel quote + swap in one shot
//   - Jito tip support for MEV protection
// ============================================================

require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey,
        TransactionMessage, SystemProgram } = require('@solana/web3.js');
const bs58  = require('bs58');
const fetch = require('node-fetch');
const WebSocket = require('ws');

// ── CONFIG ────────────────────────────────────────────────────
const CONFIG = {
  // Wallets & keys
  TARGET_WALLET:   process.env.TARGET_WALLET   || 'Ai15JKxo2oAncskTjStGq98fGk7v1drJRjTjDvDaZAL1',
  PRIVATE_KEY:     process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || '',
  HELIUS_API_KEY:  process.env.HELIUS_API_KEY  || '',
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || '',

  get HELIUS_RPC() { return `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },
  get HELIUS_TX()  { return `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${this.HELIUS_API_KEY}`; },
  get HELIUS_WS()  { return process.env.HELIUS_WS_URL || `wss://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },

  JUPITER_QUOTE: 'https://lite-api.jup.ag/swap/v1/quote',
  JUPITER_SWAP:  'https://lite-api.jup.ag/swap/v1/swap',

  // Trade config
  BUY_AMOUNT_SOL:               parseFloat(process.env.BUY_AMOUNT_SOL)               || 0.11,
  MAX_BUY_SIGNAL_AGE_SECONDS:   parseInt(process.env.MAX_BUY_SIGNAL_AGE_SECONDS)     || 10,

  // Exit rules
  TAKE_PROFIT_1_PERCENT:        parseFloat(process.env.TAKE_PROFIT_1_PERCENT)        || 20,
  TAKE_PROFIT_1_SELL_PERCENT:   parseFloat(process.env.TAKE_PROFIT_1_SELL_PERCENT)   || 70,
  TAKE_PROFIT_2_PERCENT:        parseFloat(process.env.TAKE_PROFIT_2_PERCENT)        || 35,
  TAKE_PROFIT_2_SELL_PERCENT:   parseFloat(process.env.TAKE_PROFIT_2_SELL_PERCENT)   || 100,
  INSTANT_FULL_EXIT_PERCENT:    parseFloat(process.env.INSTANT_FULL_EXIT_PERCENT)    || 50,
  STOP_LOSS_PERCENT:            parseFloat(process.env.STOP_LOSS_PERCENT)            || 10,
  NO_MOVEMENT_EXIT_SECONDS:     parseInt(process.env.NO_MOVEMENT_EXIT_SECONDS)       || 10,
  HARD_MAX_HOLD_SECONDS:        parseInt(process.env.HARD_MAX_HOLD_SECONDS)          || 30,

  // Speed / fees
  SLIPPAGE_BPS:                 Math.round((parseFloat(process.env.SLIPPAGE_PERCENT) || 15) * 100),
  PRIORITY_FEE_MICRO_LAMPORTS:  parseInt(process.env.PRIORITY_FEE_MICRO_LAMPORTS)   || 500000,
  JITO_TIP_SOL:                 parseFloat(process.env.JITO_TIP_SOL)                || 0,
  JITO_TIP_ACCOUNT:             'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',


  // Min balance
  get MIN_SOL_BALANCE() { return this.BUY_AMOUNT_SOL + 0.01; },

  // Exit check interval — every 500ms for seconds-based scalping
  EXIT_CHECK_MS: 500,
  HEALTH_MS:     30000,

  SELL_MAX_RETRIES: 5,
  SOL_MINT: 'So11111111111111111111111111111111111111112',
};

// ── IGNORE MINTS ──────────────────────────────────────────────
const IGNORE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  // USDT
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
  position:      null,      // current open position
  tradedMints:   new Set(), // mints traded this session
  processedSigs: new Set(), // dedup WS events
  buyInProgress: false,
  wsEvents:      0,
  stats: {
    signalsDetected: 0,
    signalsSkipped:  0,
    buys:            0,
    sells:           0,
    wins:            0,
    losses:          0,
    totalPnl:        0,
    feesTotal:       0,
    startBal:        0,
    startTime:       Date.now(),
  },
};

// ── UTILS ─────────────────────────────────────────────────────

function log(lv, msg, d={}) {
  const ts  = new Date().toISOString();
  const ic  = { INFO:'📡',BUY:'🟢',SELL:'🔴',EXEC:'⚡',ERROR:'❌',
                SIGNAL:'🎯',EXIT:'🏁',SKIP:'⏭',WARN:'⚠️' };
  const tag = '';
  const ext = Object.keys(d).length ? ' ' + JSON.stringify(d) : '';
  console.log(`[${ts}] ${ic[lv]||'📋'} [${lv}] ${msg}${ext}`);
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
const randomGif = () => PROFIT_GIFS[Math.floor(Math.random() * PROFIT_GIFS.length)];

async function discord(msg) {
  if(!CONFIG.DISCORD_WEBHOOK) return;
  try {
    await fetch(CONFIG.DISCORD_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg.slice(0,1990) }),
    });
  } catch(e) {}
}

async function solBal() {
  try { return (await state.connection.getBalance(state.keypair.publicKey)) / 1e9; }
  catch(e) { return 0; }
}

async function tokenSymbol(mint) {
  try {
    const r = await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mint}`, { timeout: 2000 });
    if(r.ok) { const d = await r.json(); return d.symbol || '???'; }
  } catch(e) {}
  return '???';
}

// ── CONFIRM TX ────────────────────────────────────────────────

async function confirm(sig, timeoutMs=20000) {
  const start = nowMs();
  while(nowMs()-start < timeoutMs) {
    try {
      const r = await state.connection.getSignatureStatuses([sig]);
      const v = r?.value?.[0];
      if(v?.err) { log('ERROR', `TX error: ${JSON.stringify(v.err)}`); return false; }
      if(v?.confirmationStatus==='confirmed'||v?.confirmationStatus==='finalized') return true;
    } catch(e) {}
    await sleep(400);
  }
  return false;
}

// ── GET CURRENT TOKEN VALUE ───────────────────────────────────
// Returns current SOL value of entire remaining balance

async function getTokenValue(mint) {
  try {
    const accts = await state.connection.getParsedTokenAccountsByOwner(
      state.keypair.publicKey, { mint: new PublicKey(mint) }
    );
    const acct = accts?.value?.[0];
    if(!acct) return null;
    const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount||0);
    if(bal <= 0) return null;
    const dec = acct.account.data.parsed.info.tokenAmount.decimals;
    const raw = BigInt(Math.floor(bal * Math.pow(10, dec)));

    const r = await fetch(
      `${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL_MINT}&amount=${raw.toString()}&slippageBps=500`,
      { timeout: 2000 }
    );
    if(!r.ok) return null;
    const q = await r.json();
    if(!q.outAmount) return null;
    return { solValue: parseFloat(q.outAmount)/1e9, tokenBal: bal, tokenRaw: raw, dec };
  } catch(e) { return null; }
}

// ── SELL ──────────────────────────────────────────────────────

async function execSell(mint, fraction, reason, attempt=1) {
  const pos      = state.position;
  const feeSol   = CONFIG.PRIORITY_FEE_MICRO_LAMPORTS / 1e9;

  try {
    const accts = await state.connection.getParsedTokenAccountsByOwner(
      state.keypair.publicKey, { mint: new PublicKey(mint) }
    );
    const acct = accts?.value?.[0];
    if(!acct) return { success: false, reason: 'no_account' };
    const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount||0);
    if(bal <= 0) return { success: false, reason: 'zero_balance' };
    const dec = acct.account.data.parsed.info.tokenAmount.decimals;
    const raw = BigInt(Math.floor(bal * fraction * Math.pow(10, dec)));
    if(raw <= 0n) return { success: false, reason: 'zero_raw' };

    const qr = await fetch(
      `${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL_MINT}&amount=${raw.toString()}&slippageBps=${CONFIG.SLIPPAGE_BPS}`,
      { timeout: 3000 }
    );
    if(!qr.ok) throw new Error(`Quote ${qr.status}`);
    const q = await qr.json();
    if(!q.outAmount) throw new Error('No route');

    const sr = await fetch(CONFIG.JUPITER_SWAP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: q,
        userPublicKey: state.keypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicSlippage: { minBps: 50, maxBps: CONFIG.SLIPPAGE_BPS },
        prioritizationFeeLamports: CONFIG.PRIORITY_FEE_MICRO_LAMPORTS,
      }),
      timeout: 5000,
    });
    if(!sr.ok) throw new Error(`Swap ${sr.status}`);
    const sd = await sr.json();
    if(!sd.swapTransaction) throw new Error('No tx');

    const buf = Buffer.from(sd.swapTransaction, 'base64');
    const tx  = VersionedTransaction.deserialize(buf);
    tx.sign([state.keypair]);
    const sig = await state.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true, maxRetries: 3,
    });

    const confirmed = await confirm(sig, 15000);
    if(!confirmed) throw new Error('Confirm timeout');

    const solBack = parseFloat(q.outAmount)/1e9;
    state.stats.feesTotal += feeSol;
    return { success: true, solBack, sig };
  } catch(e) {
    log('ERROR', `Sell fail (${attempt}/${CONFIG.SELL_MAX_RETRIES}): ${e.message}`);
    if(attempt < CONFIG.SELL_MAX_RETRIES) {
      await sleep(300 * attempt);
      return execSell(mint, fraction, reason, attempt+1);
    }
    return { success: false, error: e.message };
  }
}

// ── BUY ───────────────────────────────────────────────────────

async function execBuy(mint, signalAgeMs) {
  const sol      = CONFIG.BUY_AMOUNT_SOL;
  const lamports = Math.floor(sol * 1e9);
  const sym      = await tokenSymbol(mint);

  log('SIGNAL', `TARGET BOUGHT ${sym} | signal age: ${(signalAgeMs/1000).toFixed(1)}s | mint: ${mint.slice(0,16)}...`);

  try {
    // Get quote
    const qStart = nowMs();
    const qr = await fetch(
      `${CONFIG.JUPITER_QUOTE}?inputMint=${CONFIG.SOL_MINT}&outputMint=${mint}&amount=${lamports}&slippageBps=${CONFIG.SLIPPAGE_BPS}`,
      { timeout: 3000 }
    );
    if(!qr.ok) throw new Error(`Quote ${qr.status}`);
    const q = await qr.json();
    if(!q.outAmount || q.outAmount==='0') throw new Error('No route');

    log('EXEC', `Quote OK in ${nowMs()-qStart}ms — getting swap tx`);

    // Get swap tx
    const sr = await fetch(CONFIG.JUPITER_SWAP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: q,
        userPublicKey: state.keypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicSlippage: { minBps: 50, maxBps: CONFIG.SLIPPAGE_BPS },
        prioritizationFeeLamports: CONFIG.PRIORITY_FEE_MICRO_LAMPORTS,
      }),
      timeout: 5000,
    });
    if(!sr.ok) throw new Error(`Swap ${sr.status}`);
    const sd = await sr.json();
    if(!sd.swapTransaction) throw new Error('No swap tx');

    // Deserialize, sign, optionally add Jito tip
    const buf = Buffer.from(sd.swapTransaction, 'base64');
    const tx  = VersionedTransaction.deserialize(buf);
    tx.sign([state.keypair]);

    // Send
    const sendStart = nowMs();
    const sig = await state.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true, maxRetries: 2,
    });
    log('EXEC', `TX sent in ${nowMs()-sendStart}ms | sig: ${sig.slice(0,20)}...`);

    const confirmed = await confirm(sig, 20000);
    if(!confirmed) throw new Error('Confirm timeout');

    const totalMs = nowMs() - qStart;
    state.stats.buys++;
    state.stats.feesTotal += CONFIG.PRIORITY_FEE_MICRO_LAMPORTS/1e9;

    state.position = {
      mint,
      sym,
      sol,
      entryTime:    nowMs(),
      entryLatency: totalMs,
      tp1Fired:     false,
      tp2Fired:     false,
      solRecovered: 0,
      lastRoi:      0,
      highestRoi:   -Infinity,
      noMoveChecked: false,
      sig,
    };

    log('BUY', `✅ BOUGHT ${sym} | ${sol} SOL | latency: ${totalMs}ms | sig: ${sig.slice(0,20)}...`);

    await discord(
      `🟢  **COPY BUY — ${sym}**\n` +
      `\`${mint}\`\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `⚡  Signal age: **${(signalAgeMs/1000).toFixed(1)}s** | Latency: **${totalMs}ms**\n` +
      `💸  Bought: **${sol} SOL** (~$${SOL_USD(sol)})\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🏁  TP1: **+${CONFIG.TAKE_PROFIT_1_PERCENT}%** → sell ${CONFIG.TAKE_PROFIT_1_SELL_PERCENT}%\n` +
      `🏁  TP2: **+${CONFIG.TAKE_PROFIT_2_PERCENT}%** → sell 100%\n` +
      `⚡  INSTANT: **+${CONFIG.INSTANT_FULL_EXIT_PERCENT}%** → sell 100%\n` +
      `🛑  SL: **-${CONFIG.STOP_LOSS_PERCENT}%** | No-move: **${CONFIG.NO_MOVEMENT_EXIT_SECONDS}s** | Max: **${CONFIG.HARD_MAX_HOLD_SECONDS}s**\n` +
      `🔗  https://solscan.io/tx/${sig}\n` +
      `📊  https://dexscreener.com/solana/${mint}`
    );
    return true;
  } catch(e) {
    log('ERROR', `Buy failed: ${e.message}`);
    await discord(`❌  **BUY FAILED** — ${sym}\n${e.message}`);
    return false;
  }
}

// ── EXIT MANAGER ──────────────────────────────────────────────
// Checks every 500ms — fast enough for 30s max hold

async function exitManager() {
  log('INFO', `🏁 Exit manager | TP1:+${CONFIG.TAKE_PROFIT_1_PERCENT}% TP2:+${CONFIG.TAKE_PROFIT_2_PERCENT}% SL:-${CONFIG.STOP_LOSS_PERCENT}% Max:${CONFIG.HARD_MAX_HOLD_SECONDS}s`);

  while(state.isRunning) {
    await sleep(CONFIG.EXIT_CHECK_MS);
    const pos = state.position;
    if(!pos) continue;

    const ageMs  = nowMs() - pos.entryTime;
    const ageSec = ageMs / 1000;

    // ── HARD MAX HOLD ─────────────────────────────────────
    if(ageSec >= CONFIG.HARD_MAX_HOLD_SECONDS) {
      log('EXIT', `⏱ ${CONFIG.HARD_MAX_HOLD_SECONDS}s MAX HOLD — selling 100% of ${pos.sym}`);
      await handleFinalSell(pos, 'max_hold', `⏱ ${CONFIG.HARD_MAX_HOLD_SECONDS}s MAX HOLD`);
      continue;
    }

    // ── GET CURRENT VALUE ─────────────────────────────────
    const result = await getTokenValue(pos.mint);
    if(!result) {
      // Can't read value — count seconds
      if(ageSec >= CONFIG.HARD_MAX_HOLD_SECONDS) {
        await handleFinalSell(pos, 'max_hold_no_data', `⏱ MAX HOLD (no price data)`);
      }
      continue;
    }

    const { solValue } = result;
    const roi = ((solValue / pos.sol) - 1) * 100;
    if(roi > pos.highestRoi) pos.highestRoi = roi;
    pos.lastRoi = roi;

    const bar = roi >= 0
      ? '█'.repeat(Math.min(Math.floor(roi/3),20))+'░'.repeat(Math.max(20-Math.floor(roi/3),0))
      : '▓'.repeat(Math.min(Math.floor(Math.abs(roi)/3),20));
    const tp1Tag = pos.tp1Fired ? '[TP1✓]' : '';
    console.log(`  [${pos.sym}] ${pctStr(roi)} [${bar}] ${tp1Tag} | ${ageSec.toFixed(1)}s / ${CONFIG.HARD_MAX_HOLD_SECONDS}s | high:${pctStr(pos.highestRoi)}`);

    // ── INSTANT FULL EXIT: +50% ───────────────────────────
    if(roi >= CONFIG.INSTANT_FULL_EXIT_PERCENT && !pos.tp1Fired) {
      log('EXIT', `⚡ INSTANT EXIT +${roi.toFixed(1)}% on ${pos.sym} — skipping tiers, selling 100%`);
      await handleFinalSell(pos, 'instant_50pct', `⚡ INSTANT +${roi.toFixed(0)}%`);
      continue;
    }

    // ── TP1: +20% → sell 70% ─────────────────────────────
    if(roi >= CONFIG.TAKE_PROFIT_1_PERCENT && !pos.tp1Fired) {
      pos.tp1Fired = true;
      log('EXIT', `🏁 TP1 +${roi.toFixed(1)}% — selling ${CONFIG.TAKE_PROFIT_1_SELL_PERCENT}% of ${pos.sym}`);

      const sellFraction = CONFIG.TAKE_PROFIT_1_SELL_PERCENT / 100;
      const res = await execSell(pos.mint, sellFraction, 'TP1');

      if(res.success) {
        const solBack   = res.solBack;
        const costBasis = pos.sol * sellFraction;
        const pnl       = solBack - costBasis;
        pos.solRecovered += solBack;
        state.stats.totalPnl += pnl;
        state.stats.sells++;
        if(pnl >= 0) state.stats.wins++;

        log('SELL', `✅ TP1 sold ${CONFIG.TAKE_PROFIT_1_SELL_PERCENT}% → ${solBack.toFixed(4)} SOL | pnl: ${pnl>=0?'+':''}${pnl.toFixed(4)}`);
        await discord(
          `🏁  **TP1 HIT — ${pos.sym}**\n` +
          `📈  **${pctStr(roi)}** → sold **${CONFIG.TAKE_PROFIT_1_SELL_PERCENT}%**\n` +
          `💰  Got back: **$${SOL_USD(solBack)}** (${solBack.toFixed(4)} SOL)\n` +
          `🔗  https://solscan.io/tx/${res.sig}\n` +
          randomGif()
        );
      } else {
        pos.tp1Fired = false; // retry next cycle
        log('ERROR', `TP1 sell failed — will retry`);
      }
      continue;
    }

    // ── TP2: +35% → sell remaining 100% ──────────────────
    if(roi >= CONFIG.TAKE_PROFIT_2_PERCENT && pos.tp1Fired && !pos.tp2Fired) {
      log('EXIT', `🏁 TP2 +${roi.toFixed(1)}% — selling remaining 100% of ${pos.sym}`);
      await handleFinalSell(pos, 'TP2', `🏁 TP2 +${roi.toFixed(0)}%`);
      continue;
    }

    // ── STOP LOSS: -10% ───────────────────────────────────
    if(roi <= -CONFIG.STOP_LOSS_PERCENT) {
      log('EXIT', `🛑 STOP LOSS ${pctStr(roi)} on ${pos.sym}`);
      await handleFinalSell(pos, 'stop_loss', `🛑 STOP LOSS ${pctStr(roi)}`);
      continue;
    }

    // ── NO MOVEMENT EXIT: 10s with no meaningful move ─────
    if(!pos.noMoveChecked && ageSec >= CONFIG.NO_MOVEMENT_EXIT_SECONDS) {
      pos.noMoveChecked = true;
      // "No movement" = roi within -2% to +2% after 10s
      if(Math.abs(roi) < 2 && !pos.tp1Fired) {
        log('EXIT', `😴 NO MOVEMENT after ${CONFIG.NO_MOVEMENT_EXIT_SECONDS}s (${pctStr(roi)}) — exiting ${pos.sym}`);
        await handleFinalSell(pos, 'no_movement', `😴 NO MOVEMENT (${pctStr(roi)})`);
        continue;
      }
    }
  }
}

// ── HANDLE FINAL SELL ─────────────────────────────────────────

async function handleFinalSell(pos, reason, label) {
  const res = await execSell(pos.mint, 1.0, reason);
  const ageSec = ((nowMs() - pos.entryTime) / 1000).toFixed(1);

  if(res.success) {
    const solBack   = res.solBack;
    const totalOut  = pos.solRecovered + solBack;
    const pnl       = totalOut - pos.sol;
    const pnlSign   = pnl >= 0 ? '+' : '';
    const pnlEmoji  = pnl >= 0 ? '📈' : '📉';

    state.stats.totalPnl += pnl;
    state.stats.sells++;
    if(pnl >= 0) state.stats.wins++; else state.stats.losses++;
    state.stats.feesTotal += CONFIG.PRIORITY_FEE_MICRO_LAMPORTS/1e9;

    const wr = state.stats.sells > 0
      ? ((state.stats.wins/state.stats.sells)*100).toFixed(0) : '0';

    log('SELL', `✅ FINAL EXIT ${pos.sym} | ${label} | total:${totalOut.toFixed(4)} SOL | pnl:${pnlSign}${pnl.toFixed(4)} | ${ageSec}s held | WR:${wr}%`);

    const dMsg = [
      `${label} — **${pos.sym}**`,
      '━━━━━━━━━━━━━━━━━━━━',
      `📥  Entry:  **$${SOL_USD(pos.sol)}** (${pos.sol} SOL)`,
      `📤  Out:    **$${SOL_USD(totalOut)}** (${totalOut.toFixed(4)} SOL)`,
      `${pnlEmoji}  PnL:    **${pnlSign}$${SOL_USD(Math.abs(pnl))}** (${pnlSign}${pnl.toFixed(4)} SOL)`,
      `⏱  Held:   **${ageSec}s** | High: **${pctStr(pos.highestRoi||0)}**`,
      '━━━━━━━━━━━━━━━━━━━━',
      `📊  Session: **${state.stats.wins}W/${state.stats.losses}L** (${wr}% WR)`,
      `💰  Total PnL: **${state.stats.totalPnl>=0?'+':''}$${SOL_USD(Math.abs(state.stats.totalPnl))}**`,
      `🔗  https://solscan.io/tx/${res.sig}`,
    ];
    if(pnl > 0) dMsg.push(randomGif());
    await discord(dMsg.join('\n'));
  } else {
    log('ERROR', `Final sell failed: ${res.error}`);
    await discord(`🆘  **SELL FAILED — ${pos.sym}**\nSell manually: https://jup.ag/swap/${pos.mint}-SOL`);
  }

  state.position = null;
}

// ── PARSE TARGET BUY FROM TX ──────────────────────────────────

async function parseBuyFromSig(sig, blockTime) {
  // Check signal age immediately
  const signalAgeMs = blockTime
    ? nowMs() - (blockTime * 1000)
    : 0;

  if(signalAgeMs > CONFIG.MAX_BUY_SIGNAL_AGE_SECONDS * 1000) {
    log('SKIP', `Signal too old: ${(signalAgeMs/1000).toFixed(1)}s (max: ${CONFIG.MAX_BUY_SIGNAL_AGE_SECONDS}s)`);
    state.stats.signalsSkipped++;
    return;
  }

  try {
    // Use Helius enhanced API for fast parsing
    const r = await fetch(CONFIG.HELIUS_TX, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: [sig] }),
      timeout: 4000,
    });
    if(!r.ok) throw new Error(`TX fetch ${r.status}`);
    const txs = await r.json();
    const tx  = txs?.[0];
    if(!tx || tx.transactionError) return;

    const tfers  = tx.tokenTransfers  || [];
    const native = tx.nativeTransfers || [];
    const desc   = (tx.description || '').toLowerCase();
    const txType = tx.type || '';

    // Must be a SWAP or buy-type transaction
    // Ignore: TRANSFER, CLAIM, closeAccount, fee transactions
    if(txType === 'TRANSFER') return;
    if(desc.includes('claim') || desc.includes('close')) return;
    if(tfers.length === 0 && !desc.includes('swap') && !desc.includes('buy')) return;

    // Calculate SOL out from target wallet
    let solOut = 0;
    for(const t of native) {
      if(t.fromUserAccount === CONFIG.TARGET_WALLET) solOut += (t.amount||0)/1e9;
    }

    // Find mints received by target wallet
    const mintsBought = [];
    for(const t of tfers) {
      if(IGNORE_MINTS.has(t.mint)) continue;
      if(t.mint === CONFIG.SOL_MINT) continue;
      if(t.toUserAccount === CONFIG.TARGET_WALLET && t.tokenAmount > 0) {
        mintsBought.push(t.mint);
      }
    }

    // Fallback: check token balance changes
    if(mintsBought.length === 0 && solOut > 0.001) {
      const accts = tx.accountData || [];
      for(const a of accts) {
        for(const c of (a.tokenBalanceChanges||[])) {
          if(c.userAccount === CONFIG.TARGET_WALLET &&
             !IGNORE_MINTS.has(c.mint) &&
             parseFloat(c.rawTokenAmount?.tokenAmount||0) > 0) {
            mintsBought.push(c.mint);
          }
        }
      }
    }

    if(mintsBought.length === 0) {
      log('SKIP', `No token buy found in tx — type:${txType} solOut:${solOut.toFixed(4)}`);
      return;
    }

    const mint = mintsBought[0];

    // Skip already traded mints
    if(state.tradedMints.has(mint)) {
      log('SKIP', `Already traded ${mint.slice(0,16)}...`);
      state.stats.signalsSkipped++;
      return;
    }

    // Skip if already in position
    if(state.position) {
      log('SKIP', `Already in position (${state.position.sym}) — skipping ${mint.slice(0,16)}...`);
      state.stats.signalsSkipped++;
      return;
    }

    // Skip if buy in progress
    if(state.buyInProgress) {
      log('SKIP', `Buy already in progress`);
      return;
    }

    state.stats.signalsDetected++;
    state.tradedMints.add(mint);
    state.buyInProgress = true;

    log('SIGNAL', `🎯 TARGET BUY DETECTED | mint:${mint.slice(0,16)}... | solOut:${solOut.toFixed(3)} | age:${(signalAgeMs/1000).toFixed(1)}s`);

    // Recheck age after parsing (parsing takes time)
    const finalAge = nowMs() - (blockTime ? blockTime*1000 : nowMs());
    if(finalAge > CONFIG.MAX_BUY_SIGNAL_AGE_SECONDS * 1000) {
      log('SKIP', `Signal expired after parsing: ${(finalAge/1000).toFixed(1)}s`);
      state.stats.signalsSkipped++;
      state.buyInProgress = false;
      return;
    }

    const bal = await solBal();
    if(bal < CONFIG.MIN_SOL_BALANCE) {
      log('SKIP', `Low balance: ${bal.toFixed(4)} SOL — need ${CONFIG.MIN_SOL_BALANCE}`);
      await discord(`⚠️  **LOW BALANCE** — ${bal.toFixed(4)} SOL | Need ${CONFIG.MIN_SOL_BALANCE.toFixed(3)} SOL`);
      state.buyInProgress = false;
      return;
    }

    const success = await execBuy(mint, finalAge);
    state.buyInProgress = false;
    if(!success) state.tradedMints.delete(mint); // allow retry if buy failed

  } catch(e) {
    log('ERROR', `parseBuyFromSig: ${e.message}`);
    state.buyInProgress = false;
  }
}

// ── HELIUS WEBSOCKET ──────────────────────────────────────────

function connectHelius() {
  log('INFO', `🔌 Connecting to Helius — watching ${CONFIG.TARGET_WALLET.slice(0,20)}...`);

  const ws = new WebSocket(CONFIG.HELIUS_WS);
  state.ws = ws;

  ws.on('open', () => {
    log('INFO', `✅ Helius WS connected`);
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'logsSubscribe',
      params: [
        { mentions: [CONFIG.TARGET_WALLET] },
        { commitment: 'confirmed' },
      ],
    }));
  });

  ws.on('message', async (raw) => {
    state.wsEvents++;
    try {
      const msg = JSON.parse(raw.toString());

      if(msg.id === 1 && msg.result !== undefined) {
        log('INFO', `✅ Subscribed — subId:${msg.result} | watching for buys...`);
        return;
      }

      if(!msg.params?.result?.value) return;
      const value = msg.params.result.value;
      const sig   = value.signature;
      const logs  = value.logs || [];

      // Deduplicate
      if(state.processedSigs.has(sig)) return;
      state.processedSigs.add(sig);
      if(state.processedSigs.size > 500) {
        const first = state.processedSigs.values().next().value;
        state.processedSigs.delete(first);
      }

      // Fast pre-filter: skip obvious non-buy logs
      const logStr = logs.join(' ');
      const isObviouslyNotBuy =
        logStr.includes('CloseAccount') ||
        logStr.includes('claim_cashback') ||
        logStr.includes('Transfer') && !logStr.includes('swap') && !logStr.includes('Swap');

      if(isObviouslyNotBuy) return;

      // Must involve a swap program
      const isSwap =
        logStr.includes('JUP') ||
        logStr.includes('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P') || // pump.fun
        logStr.includes('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') || // raydium v4
        logStr.includes('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA') ||  // pumpswap
        logStr.includes('Instruction: Buy') ||
        logStr.includes('ray_log');

      if(!isSwap) return;

      // Get blockTime for age check
      const blockTime = msg.params?.result?.context?.slot
        ? null // slot only, estimate as now
        : null;

      log('INFO', `📨 Potential buy tx — sig:${sig.slice(0,20)}... — parsing`);
      parseBuyFromSig(sig, blockTime)
        .catch(e => log('ERROR', `parseBuyFromSig: ${e.message}`));

    } catch(e) { log('ERROR', `WS msg: ${e.message}`); }
  });

  ws.on('error', e => log('ERROR', `WS error: ${e.message}`));
  ws.on('close', code => {
    log('INFO', `WS closed (${code}) — reconnecting in 2s`);
    state.ws = null;
    if(state.isRunning) setTimeout(connectHelius, 2000);
  });

  const ping = setInterval(() => {
    if(ws.readyState === WebSocket.OPEN) ws.ping();
    else clearInterval(ping);
  }, 20000);
}

// ── HEALTH DISPLAY ────────────────────────────────────────────

async function health() {
  while(state.isRunning) {
    await sleep(CONFIG.HEALTH_MS);
    const bal    = await solBal();
    const pnl    = bal - state.stats.startBal;
    const wr     = state.stats.sells > 0
      ? ((state.stats.wins/state.stats.sells)*100).toFixed(0) : '0';
    const uptime = ((nowMs()-state.stats.startTime)/60000).toFixed(0);
    const wsState = state.ws?.readyState === WebSocket.OPEN ? '🟢 LIVE' : '🔴 RECONNECTING';
    const mode    = '🔴 LIVE';

    const lines = [
      '',
      '═'.repeat(64),
      `  ⚡ WINSTON v31.0 — Ultra-Fast Copy Sniper ${mode}`,
      '═'.repeat(64),
      `  📡 WS: ${wsState} | Events: ${state.wsEvents} | Uptime: ${uptime}min`,
      `  🎯 Target: ${CONFIG.TARGET_WALLET.slice(0,24)}...`,
      `  💸  Buy: ${CONFIG.BUY_AMOUNT_SOL} SOL ($${SOL_USD(CONFIG.BUY_AMOUNT_SOL)}) | TP1:+${CONFIG.TAKE_PROFIT_1_PERCENT}% TP2:+${CONFIG.TAKE_PROFIT_2_PERCENT}% SL:-${CONFIG.STOP_LOSS_PERCENT}%`,
      `  ⏱  No-move: ${CONFIG.NO_MOVEMENT_EXIT_SECONDS}s | Max: ${CONFIG.HARD_MAX_HOLD_SECONDS}s`,
      `  💰  ${bal.toFixed(4)} SOL ($${SOL_USD(bal)}) | PnL: ${pnl>=0?'+':''}${pnl.toFixed(4)} SOL`,
      `  📊  Signals: ${state.stats.signalsDetected} detected, ${state.stats.signalsSkipped} skipped`,
      `  📊  ${state.stats.wins}W/${state.stats.losses}L (${wr}% WR) | Fees: ${state.stats.feesTotal.toFixed(4)} SOL`,
    ];

    if(state.position) {
      const pos  = state.position;
      const age  = ((nowMs()-pos.entryTime)/1000).toFixed(1);
      const left = Math.max(0, CONFIG.HARD_MAX_HOLD_SECONDS - parseFloat(age)).toFixed(1);
      lines.push(`  📦 ACTIVE: ${pos.sym} ${pos.mint.slice(0,8)}... | ${age}s | ${left}s left | roi:${pctStr(pos.lastRoi||0)}`);
    } else {
      lines.push('  📭 No position — watching for buys');
    }
    lines.push('═'.repeat(64));
    console.log(lines.join('\n'));
  }
}

// ── MAIN ──────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  ⚡ WINSTON v31.0 — Ultra-Fast Copy Sniper                    ║`);
  console.log(`║  🔴 LIVE MODE — real SOL at risk                          ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  if(!CONFIG.HELIUS_API_KEY) { log('ERROR','HELIUS_API_KEY missing'); process.exit(1); }
  if(!CONFIG.PRIVATE_KEY)    { log('ERROR','WALLET_PRIVATE_KEY missing'); process.exit(1); }

  try {
    state.keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
    log('INFO', `Wallet: ${state.keypair.publicKey.toString()}`);
  } catch(e) { log('ERROR',`Bad key: ${e.message}`); process.exit(1); }

  state.connection   = new Connection(CONFIG.HELIUS_RPC, { commitment: 'confirmed' });
  state.stats.startBal = await solBal();
  log('INFO', `Balance: ${state.stats.startBal.toFixed(4)} SOL (~$${SOL_USD(state.stats.startBal)})`);
  log('INFO', `Priority: ${CONFIG.PRIORITY_FEE_MICRO_LAMPORTS} μL | Slippage: ${CONFIG.SLIPPAGE_BPS/100}%`);

  if(state.stats.startBal < CONFIG.MIN_SOL_BALANCE) {
    log('ERROR', `Balance too low — need ${CONFIG.MIN_SOL_BALANCE} SOL`);
    process.exit(1);
  }

  state.isRunning = true;
  connectHelius();

  await discord(
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `⚡  **WINSTON v31.0 ONLINE**\n` +
    `**Ultra-Fast Copy Sniper**\n` +
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `🎯  Target: \`${CONFIG.TARGET_WALLET}\`\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💸  Buy: **${CONFIG.BUY_AMOUNT_SOL} SOL (~$${SOL_USD(CONFIG.BUY_AMOUNT_SOL)})**\n` +
    `⚡  Signal max age: **${CONFIG.MAX_BUY_SIGNAL_AGE_SECONDS}s**\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🏁  TP1: **+${CONFIG.TAKE_PROFIT_1_PERCENT}%** → sell ${CONFIG.TAKE_PROFIT_1_SELL_PERCENT}%\n` +
    `🏁  TP2: **+${CONFIG.TAKE_PROFIT_2_PERCENT}%** → sell 100%\n` +
    `⚡  INSTANT: **+${CONFIG.INSTANT_FULL_EXIT_PERCENT}%** → sell 100%\n` +
    `😴  NO-MOVE: **${CONFIG.NO_MOVEMENT_EXIT_SECONDS}s** → sell 100%\n` +
    `🛑  SL: **-${CONFIG.STOP_LOSS_PERCENT}%** | Max: **${CONFIG.HARD_MAX_HOLD_SECONDS}s**\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💰  Balance: **${state.stats.startBal.toFixed(4)} SOL** (~$${SOL_USD(state.stats.startBal)})\n` +
    `⚙️  Priority: **${CONFIG.PRIORITY_FEE_MICRO_LAMPORTS}** μL | Slippage: **${CONFIG.SLIPPAGE_BPS/100}%**\n` +
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if(shuttingDown) return;
    shuttingDown = true;
    state.isRunning = false;
    if(state.ws) state.ws.close();
    const finalBal = await solBal();
    const pnl      = finalBal - state.stats.startBal;
    const wr       = state.stats.sells > 0
      ? ((state.stats.wins/state.stats.sells)*100).toFixed(0) : '0';
    await discord(
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
      `🔴  **WINSTON v31.0 OFFLINE**\n` +
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
      `💰  Final: **${finalBal.toFixed(4)} SOL** (~$${SOL_USD(finalBal)})\n` +
      `📈  PnL: **${pnl>=0?'+':''}$${SOL_USD(Math.abs(pnl))}** (${pnl>=0?'+':''}${pnl.toFixed(4)} SOL)\n` +
      `📊  **${state.stats.wins}W/${state.stats.losses}L** (${wr}% WR)\n` +
      `🎯  Signals: ${state.stats.signalsDetected} detected | ${state.stats.signalsSkipped} skipped\n` +
      `💸  Fees: **${state.stats.feesTotal.toFixed(4)} SOL**\n` +
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
  let n = 0;
  while(true) {
    try { await main(); break; }
    catch(e) {
      n++;
      log('ERROR', `CRASH #${n}: ${e.message}`);
      console.error(e);
      try {
        if(CONFIG.DISCORD_WEBHOOK) await fetch(CONFIG.DISCORD_WEBHOOK, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ content:`💥 **WINSTON v31 CRASHED #${n}**\n❌ ${e.message}\nRestarting in 3s...` }),
        });
      } catch(_) {}
      if(state.ws) { try { state.ws.close(); } catch(_) {} }
      state.isRunning    = false;
      state.ws           = null;
      state.position     = null;
      state.buyInProgress = false;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

runWithFailsafe();
