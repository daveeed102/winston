// ============================================================
// WINSTON v15 — Pure Mirror Bot
// ============================================================
// One wallet. One rule.
//   He buys → we buy instantly (0.050 SOL, max priority)
//   He sells → we sell instantly (max priority)
// No filters. No momentum check. No safety nets.
// Speed is everything. High fees = we exit with him.
// ============================================================

require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');

const CONFIG = {
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  get HELIUS_RPC() { return `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },
  get HELIUS_TX()  { return `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${this.HELIUS_API_KEY}`; },
  PRIVATE_KEY:     process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || '',
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || '',
  JUPITER_QUOTE:   'https://lite-api.jup.ag/swap/v1/quote',
  JUPITER_SWAP:    'https://lite-api.jup.ag/swap/v1/swap',

  // ── The one wallet we mirror ─────────────────────────────
  TARGET: 'pwZ5jRsFKyPGhgcS5uC9SrV3CxdsDptQuLQYiVhGz31',

  // ── Position sizing ──────────────────────────────────────
  BUY_SOL: 0.026,  // ~$4 at current SOL price

  // ── Auto exit ────────────────────────────────────────────
  HOLD_SECONDS:  25,    // sell after 25s no matter what
  EXIT_CHECK_MS: 500,   // check every 500ms

  // ── Speed fees — we pay to move first ───────────────────
  // Buy: high priority to snipe entry with him
  BUY_PRIORITY_LAMPORTS:  5000000,   // 0.005 SOL — max snipe priority
  BUY_SLIPPAGE_BPS:       2000,      // 20% slippage on buy — get in no matter what

  // Sell: even higher — we MUST exit when he does
  SELL_PRIORITY_LAMPORTS: 5000000,   // 0.005 SOL — match his exit speed
  SELL_SLIPPAGE_BPS:      3000,      // 30% slippage on sell — get out no matter what

  MAX_RETRIES: 3,
  POLL_MS:     500,   // poll every 500ms — as fast as Helius allows
  HEALTH_MS:  30000,
  SOL: 'So11111111111111111111111111111111111111112',
};

// Stablecoins/wrapped SOL — never trade these
const IGNORE = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
]);

const state = {
  wallet:      null,
  connection:  null,
  isRunning:   false,
  lastSig:     null,
  positions:   new Map(),   // mint → { time, sol, sym, soldPct, isSelling }
  tradedMints: new Set(),   // session blacklist — never re-enter
  stats: { buys:0, sells:0, errors:0, retries:0, startBal:0 },
};

// ── UTILS ────────────────────────────────────────────────────

function log(lv, msg, d={}) {
  const ts = new Date().toISOString();
  const ic = {INFO:'📡',BUY:'🟢',SELL:'🔴',EXEC:'⚡',ERROR:'❌',MIRROR:'🪞',EMERGENCY:'🚨'};
  console.log(`[${ts}] ${ic[lv]||'📋'} [${lv}] ${msg}${Object.keys(d).length?' '+JSON.stringify(d):''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function solBal() {
  try { return (await state.connection.getBalance(state.wallet.publicKey)) / 1e9; } catch(e) { return 0; }
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
      body: JSON.stringify({ content: msg.slice(0, 1990) })
    });
  } catch(e) {}
}

// ── HELIUS ───────────────────────────────────────────────────

async function heliusParse(sigs) {
  try {
    const r = await fetch(CONFIG.HELIUS_TX, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: sigs })
    });
    if(!r.ok) return [];
    return await r.json() || [];
  } catch(e) { return []; }
}

function extractTrades(tx) {
  if(tx.transactionError) return null;
  const w = CONFIG.TARGET;
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
    if(IGNORE.has(t.mint) || t.mint === CONFIG.SOL) continue;
    if(t.toUserAccount   === w && t.tokenAmount > 0) buys.push({ mint: t.mint });
    if(t.fromUserAccount === w && t.tokenAmount > 0) sells.push({ mint: t.mint });
  }

  // Aggregator fallback
  if(buys.length === 0 && sells.length === 0 && tfers.length > 0) {
    const mints = new Set();
    for(const t of tfers) {
      if(!IGNORE.has(t.mint) && t.mint !== CONFIG.SOL && t.tokenAmount > 0) mints.add(t.mint);
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
  return trades.length > 0 ? trades : null;
}

// ── CONFIRM ──────────────────────────────────────────────────

async function confirm(sig, timeout=60000) {
  const s = Date.now();
  while(Date.now()-s < timeout) {
    try {
      const r = await state.connection.getSignatureStatuses([sig]);
      const v = r?.value?.[0];
      if(v?.err) return false;
      if(v?.confirmationStatus==='confirmed' || v?.confirmationStatus==='finalized') return true;
    } catch(e) {}
    await sleep(1500);
  }
  return false;
}

// ── BUY — fires the instant we see his buy ───────────────────

async function execBuy(mint, whaleSol) {
  state.tradedMints.add(mint); // blacklist immediately — no re-entry ever
  const info = await tokenInfo(mint);
  const sol  = CONFIG.BUY_SOL;
  const lamports = Math.floor(sol * 1e9);

  log('EXEC', `🪞 MIRROR BUY ${info.sym} ${sol.toFixed(4)} SOL (whale spent ${whaleSol.toFixed(2)})`, { mint: mint.slice(0,12) });

  try {
    const qr = await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${CONFIG.SOL}&outputMint=${mint}&amount=${lamports}&slippageBps=${CONFIG.BUY_SLIPPAGE_BPS}`);
    if(!qr.ok) throw new Error(`Quote ${qr.status}`);
    const q = await qr.json();
    if(!q.outAmount || q.outAmount === '0') throw new Error('No route');

    const sr = await fetch(CONFIG.JUPITER_SWAP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: q,
        userPublicKey: state.wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicSlippage: { minBps: 50, maxBps: CONFIG.BUY_SLIPPAGE_BPS },
        prioritizationFeeLamports: CONFIG.BUY_PRIORITY_LAMPORTS
      })
    });
    if(!sr.ok) throw new Error(`Swap ${sr.status}`);
    const sd = await sr.json();
    if(!sd.swapTransaction) throw new Error('No swap tx');

    const buf = Buffer.from(sd.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(buf);
    tx.sign([state.wallet]);
    const sig = await state.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });

    if(await confirm(sig)) {
      state.positions.set(mint, { time: Date.now(), sol, sym: info.sym, soldPct: 0, isSelling: false });
      state.stats.buys++;
      log('BUY', `✅ ${info.sym} ${sol.toFixed(4)} SOL — waiting for his sell`);
      await discord(
        `🪞  **MIRROR BUY** \`${mint}\`\n` +
        `💸  **${sol.toFixed(4)} SOL** | Whale spent **${whaleSol.toFixed(2)} SOL**\n` +
        `⚡  Sell when he sells — no earlier\n` +
        `🔗  https://solscan.io/tx/${sig}`
      );
      return true;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    state.stats.errors++;
    log('ERROR', `Buy fail: ${e.message}`, { mint: mint.slice(0,12) });
    await discord(`❌ Buy failed: ${info.sym} \`${mint.slice(0,16)}\` — ${e.message}`);
    return false;
  }
}

// ── SELL — fires the instant we see his sell ─────────────────

async function execSell(mint, reason, attempt=1) {
  const info = await tokenInfo(mint);
  const pos  = state.positions.get(mint);
  if(!pos) return false;

  log('EXEC', `🪞 MIRROR SELL ${info.sym} — ${reason} (attempt ${attempt})`, { mint: mint.slice(0,12) });

  try {
    const accts = await state.connection.getParsedTokenAccountsByOwner(
      state.wallet.publicKey, { mint: new PublicKey(mint) }
    );
    const acct = accts?.value?.[0];
    if(!acct) { state.positions.delete(mint); return false; }
    const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount||0);
    if(bal <= 0) { state.positions.delete(mint); return false; }
    const dec = acct.account.data.parsed.info.tokenAmount.decimals;
    const raw = BigInt(Math.floor(bal * Math.pow(10, dec)));
    if(raw <= 0n) { state.positions.delete(mint); return false; }

    const qr = await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL}&amount=${raw.toString()}&slippageBps=${CONFIG.SELL_SLIPPAGE_BPS}`);
    if(!qr.ok) throw new Error(`Sell quote ${qr.status}`);
    const q = await qr.json();
    if(!q.outAmount) throw new Error('No sell route');

    const sr = await fetch(CONFIG.JUPITER_SWAP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: q,
        userPublicKey: state.wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicSlippage: { minBps: 50, maxBps: CONFIG.SELL_SLIPPAGE_BPS },
        prioritizationFeeLamports: CONFIG.SELL_PRIORITY_LAMPORTS
      })
    });
    if(!sr.ok) throw new Error(`Sell swap ${sr.status}`);
    const sd = await sr.json();
    if(!sd.swapTransaction) throw new Error('No sell tx');

    const buf = Buffer.from(sd.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(buf);
    tx.sign([state.wallet]);
    const sig = await state.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });

    if(await confirm(sig)) {
      const solBack    = parseFloat(q.outAmount) / 1e9;
      const pnl        = pos.sol ? solBack - pos.sol : 0;
      const pnlSign    = pnl >= 0 ? '+' : '';
      const pnlEmoji   = pnl >= 0 ? '📈' : '📉';
      state.positions.delete(mint);
      state.stats.sells++;
      log('SELL', `✅ ${info.sym} → ${solBack.toFixed(4)} SOL (${pnlSign}${pnl.toFixed(4)})`);
      await discord(
        `🪞  **MIRROR SELL** \`${mint}\`\n` +
        `💰  **${solBack.toFixed(4)} SOL** back  ·  ${pnlEmoji} **${pnlSign}${pnl.toFixed(4)} SOL**\n` +
        `📋  ${reason}\n` +
        `🔗  https://solscan.io/tx/${sig}`
      );
      return true;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    log('ERROR', `Sell fail: ${e.message}`, { attempt });
    if(attempt < CONFIG.MAX_RETRIES) {
      state.stats.retries++;
      await sleep(300); // tiny delay then retry — we want out ASAP
      return execSell(mint, reason, attempt+1);
    }
    state.stats.errors++;
    state.positions.delete(mint);
    await discord(`❌ Sell FAILED: ${info.sym} \`${mint.slice(0,16)}\` — ${e.message} — POSITION ABANDONED`);
    return false;
  }
}

// ── EXIT MANAGER — 25s hard exit ─────────────────────────────

async function exitManager() {
  log('INFO', `⏱ Exit manager active | hard exit at ${CONFIG.HOLD_SECONDS}s`);
  while(state.isRunning) {
    await sleep(CONFIG.EXIT_CHECK_MS);
    for(const [mint, pos] of state.positions) {
      if(pos.isSelling) continue;
      const ageSec = (Date.now() - pos.time) / 1000;
      if(ageSec >= CONFIG.HOLD_SECONDS) {
        log('EXIT', `⏱ 25s AUTO-EXIT ${pos.sym} — selling now`);
        pos.isSelling = true;
        execSell(mint, `25s_auto_exit`).catch(e =>
          log('ERROR', `Auto-exit sell error: ${e.message}`)
        );
      }
    }
  }
}

// ── POLL — single tight loop, 500ms ─────────────────────────

async function poll() {
  log('INFO', `🪞 Mirroring ${CONFIG.TARGET.slice(0,16)}... every ${CONFIG.POLL_MS}ms`);

  while(state.isRunning) {
    try {
      const r = await fetch(CONFIG.HELIUS_RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getSignaturesForAddress',
          params: [CONFIG.TARGET, { limit: 10 }]
        })
      });
      const d = await r.json();
      const sigs = d?.result || [];

      const newSigs = [];
      for(const s of sigs) {
        if(s.signature === state.lastSig) break;
        if(!s.err) newSigs.push(s);
      }

      if(newSigs.length > 0) {
        state.lastSig = newSigs[0].signature;
        const parsed = await heliusParse(newSigs.map(s => s.signature));

        for(const tx of parsed) {
          const trades = extractTrades(tx);
          if(!trades) continue;

          // ── HE SOLD → WE SELL ──────────────────────────
          for(const t of trades.filter(t => t.dir === 'sell')) {
            if(!state.positions.has(t.mint)) continue;
            const pos = state.positions.get(t.mint);
            if(pos.isSelling) continue;
            pos.isSelling = true;
            log('MIRROR', `🔴 WHALE SOLD ${t.mint.slice(0,10)}... — SELLING NOW`);
            // Fire sell without awaiting — don't block next trade detection
            execSell(t.mint, 'whale_sold').catch(e =>
              log('ERROR', `Mirror sell error: ${e.message}`)
            );
          }

          // ── HE BOUGHT → WE BUY ─────────────────────────
          for(const t of trades.filter(t => t.dir === 'buy')) {
            if(IGNORE.has(t.mint)) continue;
            if(state.tradedMints.has(t.mint)) continue;   // already traded this session
            if(state.positions.has(t.mint)) continue;     // already in position

            const bal = await solBal();
            if(bal < CONFIG.BUY_SOL + 0.01) {
              log('INFO', `💸 Balance too low (${bal.toFixed(4)} SOL) — skipping`);
              continue;
            }

            log('MIRROR', `🟢 WHALE BOUGHT ${t.mint.slice(0,10)}... ${t.sol.toFixed(2)} SOL — BUYING NOW`);
            // Fire buy without awaiting — don't block next signal
            execBuy(t.mint, t.sol).catch(e =>
              log('ERROR', `Mirror buy error: ${e.message}`)
            );
          }
        }
      }
    } catch(e) { log('ERROR', `Poll: ${e.message}`); }

    await sleep(CONFIG.POLL_MS);
  }
}

// ── HEALTH ───────────────────────────────────────────────────

async function health() {
  while(state.isRunning) {
    const bal = await solBal();
    const pnl = bal - state.stats.startBal;
    console.log('\n' + '═'.repeat(58));
    console.log('  🪞 WINSTON v15 — Pure Mirror Bot');
    console.log('═'.repeat(58));
    console.log(`  👀 ${CONFIG.TARGET.slice(0,20)}...`);
    console.log(`  💰 ${bal.toFixed(4)} SOL | PnL: ${pnl>=0?'+':''}${pnl.toFixed(4)} SOL`);
    console.log(`  🛒 ${state.stats.buys}B  🚪 ${state.stats.sells}S  ❌ ${state.stats.errors}E  🔄 ${state.stats.retries}R`);
    console.log(`  📦 ${state.positions.size} open | 🚫 ${state.tradedMints.size} blacklisted`);
    console.log(`  ⚡ Buy: ${CONFIG.BUY_SOL} SOL | Priority: ${CONFIG.BUY_PRIORITY_LAMPORTS/1e6}M lamps`);
    for(const [m, p] of state.positions) {
      const age = ((Date.now()-p.time)/1000).toFixed(0);
      console.log(`     ${p.sym} ${m.slice(0,8)}... | ${age}s holding | ${p.sol.toFixed(4)} SOL in`);
    }
    console.log('═'.repeat(58) + '\n');
    await sleep(CONFIG.HEALTH_MS);
  }
}

// ── MAIN ─────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  🪞 WINSTON v15 — Pure Mirror Bot                    ║');
  console.log('║  He buys → we buy. He sells → we sell. That\'s it.   ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  if(!CONFIG.HELIUS_API_KEY) { log('ERROR', 'HELIUS_API_KEY missing'); process.exit(1); }
  if(!CONFIG.PRIVATE_KEY)    { log('ERROR', 'WALLET_PRIVATE_KEY missing'); process.exit(1); }

  try { state.wallet = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY)); }
  catch(e) { log('ERROR', 'Bad private key'); process.exit(1); }
  log('INFO', `Wallet: ${state.wallet.publicKey}`);

  state.connection = new Connection(CONFIG.HELIUS_RPC, { commitment: 'confirmed' });
  state.stats.startBal = await solBal();
  log('INFO', `Balance: ${state.stats.startBal.toFixed(4)} SOL`);

  if(state.stats.startBal < 0.06) {
    log('ERROR', `Balance too low. Need at least 0.06 SOL (buy + fees).`);
    process.exit(1);
  }

  // Set cursor — don't replay old history
  try {
    const r = await fetch(CONFIG.HELIUS_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'getSignaturesForAddress', params:[CONFIG.TARGET,{limit:1}] })
    });
    const d = await r.json();
    state.lastSig = d?.result?.[0]?.signature || null;
    log('INFO', `Cursor: ${state.lastSig ? state.lastSig.slice(0,20)+'...' : 'none'}`);
  } catch(e) { log('ERROR', `Init failed: ${e.message}`); process.exit(1); }

  state.isRunning = true;
  log('INFO', `🪞 LIVE — mirroring ${CONFIG.TARGET} | ${CONFIG.BUY_SOL} SOL per trade | 500ms poll`);

  await discord(
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `🪞  **WINSTON v15 ONLINE**\n` +
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `👀  Mirroring: \`${CONFIG.TARGET}\`\n` +
    `💸  **${CONFIG.BUY_SOL} SOL** per trade (~$4)\n` +
    `⚡  Priority: **${CONFIG.BUY_PRIORITY_LAMPORTS/1e6}M lamports** buy & sell\n` +
    `🔁  He buys → we buy. Auto-exit at **25s**.\n` +
    `💰  Balance: **${state.stats.startBal.toFixed(4)} SOL**\n` +
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if(shuttingDown) return;
    shuttingDown = true;
    state.isRunning = false;
    const f = await solBal(); const p = f - state.stats.startBal;
    await discord(
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
      `🔴  **WINSTON v15 OFFLINE**\n` +
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
      `💰  **${f.toFixed(4)} SOL**  ·  PnL: **${p>=0?'+':''}${p.toFixed(4)} SOL**\n` +
      `🛒  ${state.stats.buys}B  🚪 ${state.stats.sells}S  ❌ ${state.stats.errors}E\n` +
      `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`
    );
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await Promise.all([poll(), exitManager(), health()]);
}

main().catch(e => { log('ERROR', 'Fatal', { err: e.message }); process.exit(1); });
