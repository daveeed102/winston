// ============================================================
// WINSTON v11 — Exact Mirror Bot
// ============================================================
// Target: Fw8Cwufb3ELmS5pVN6SaZGVy9KsfZ35zrRp2WrUFvSDg
// He buys 5 SOL each, his total ~$990. Ours ~$25.
// Ratio: ~2.5%. He buys 5 SOL → we buy ~0.125 SOL (~$10).
// Mirror exactly. Retry on fail. Discord for trades only.
// ============================================================

require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');

const CONFIG = {
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  get HELIUS_RPC() { return `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },
  get HELIUS_TX() { return `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${this.HELIUS_API_KEY}`; },
  PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || '',
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || '',
  JUPITER_QUOTE: 'https://lite-api.jup.ag/swap/v1/quote',
  JUPITER_SWAP: 'https://lite-api.jup.ag/swap/v1/swap',

  TARGET: 'Fw8Cwufb3ELmS5pVN6SaZGVy9KsfZ35zrRp2WrUFvSDg',

  // His $990, ours $25 → 2.5% ratio, boost to 4% to be slightly more aggressive
  // He buys 5 SOL → we buy 0.20 SOL (~$16). He buys 6 SOL → we buy 0.24 SOL
  RATIO: 0.04,
  MIN_BUY_SOL: 0.04,      // Don't trade less than ~$3
  MAX_BUY_PCT: 0.60,      // Never use more than 60% of balance
  MAX_RETRIES: 3,          // Retry failed trades 3 times

  // Minimal fees
  MAX_SLIPPAGE_BPS: 300,         // 3% for pump.fun tokens
  PRIORITY_FEE_LAMPORTS: 30000,  // 0.00003 SOL — bare minimum

  POLL_MS: 3000,
  HEALTH_MS: 120000,
  SOL: 'So11111111111111111111111111111111111111112',
};

const IGNORE = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
]);

const state = {
  wallet: null, connection: null, lastSig: null, isRunning: false,
  positions: new Map(),
  stats: { buys:0, sells:0, errors:0, retries:0, startBal:0 },
};

// === UTILS ===
function log(lv, msg, d={}) {
  const ts = new Date().toISOString();
  const ic = {INFO:'📡',BUY:'🟢',SELL:'🔴',EXEC:'⚡',ERROR:'❌',RETRY:'🔄',MIRROR:'🪞'};
  console.log(`[${ts}] ${ic[lv]||'📋'} [${lv}] ${msg}${Object.keys(d).length?' '+JSON.stringify(d):''}`);
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function solBal() {
  try { return (await state.connection.getBalance(state.wallet.publicKey))/1e9; } catch(e) { return 0; }
}

async function tokenInfo(mint) {
  try { const r=await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mint}`); if(r.ok){const d=await r.json(); return {name:d.name||'Unknown',sym:d.symbol||'???'};} } catch(e){}
  return {name:'Unknown',sym:'???'};
}

async function discord(msg) {
  if(!CONFIG.DISCORD_WEBHOOK) return;
  try { await fetch(CONFIG.DISCORD_WEBHOOK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:msg.slice(0,1990)})}); } catch(e){}
}

// === HELIUS PARSE ===
async function heliusParse(sigs) {
  try {
    const r = await fetch(CONFIG.HELIUS_TX,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transactions:sigs})});
    if(!r.ok) return [];
    return await r.json() || [];
  } catch(e) { return []; }
}

function extractTrades(tx) {
  if(tx.transactionError) return null;
  const w = CONFIG.TARGET;
  const tfers = tx.tokenTransfers || [];
  const native = tx.nativeTransfers || [];
  const desc = (tx.description||'').toLowerCase();

  let solOut=0, solIn=0;
  for(const t of native) {
    if(t.fromUserAccount===w) solOut += (t.amount||0)/1e9;
    if(t.toUserAccount===w) solIn += (t.amount||0)/1e9;
  }

  const buys=[], sells=[];
  for(const t of tfers) {
    if(IGNORE.has(t.mint) || t.mint===CONFIG.SOL) continue;
    if(t.toUserAccount===w && t.tokenAmount>0) buys.push({mint:t.mint, amt:t.tokenAmount});
    if(t.fromUserAccount===w && t.tokenAmount>0) sells.push({mint:t.mint, amt:t.tokenAmount});
  }

  // Fallback for aggregator routing
  if(buys.length===0 && sells.length===0 && tfers.length>0) {
    const mints = new Set();
    for(const t of tfers) { if(!IGNORE.has(t.mint) && t.mint!==CONFIG.SOL && t.tokenAmount>0) mints.add(t.mint); }
    for(const mint of mints) {
      if(tx.type!=='SWAP' && !desc.includes('swap') && !desc.includes('buy') && !desc.includes('sell')) continue;
      if(solOut>0.01) buys.push({mint, amt:tfers.find(t=>t.mint===mint)?.tokenAmount||0});
      else if(solIn>0.01) sells.push({mint, amt:tfers.find(t=>t.mint===mint)?.tokenAmount||0});
      break;
    }
  }

  const trades = [];
  for(const b of buys) trades.push({mint:b.mint, dir:'buy', sol:solOut||0.01, sig:tx.signature, src:tx.source||'?'});
  for(const s of sells) trades.push({mint:s.mint, dir:'sell', sol:solIn||0.01, sig:tx.signature, src:tx.source||'?'});
  return trades.length > 0 ? trades : null;
}

// === EXECUTION WITH RETRY ===
async function execBuy(mint, sol, targetSol, attempt=1) {
  const info = await tokenInfo(mint);
  const lamports = Math.floor(sol * 1e9);
  log('EXEC', `🛒 BUY ${info.sym} ${sol.toFixed(4)} SOL (attempt ${attempt})`, {mint:mint.slice(0,12)});

  try {
    const qr = await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${CONFIG.SOL}&outputMint=${mint}&amount=${lamports}&slippageBps=${CONFIG.MAX_SLIPPAGE_BPS}`);
    if(!qr.ok) throw new Error(`Quote ${qr.status}`);
    const q = await qr.json();
    if(!q.outAmount || q.outAmount==='0') throw new Error('No route');

    const sr = await fetch(CONFIG.JUPITER_SWAP,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({quoteResponse:q, userPublicKey:state.wallet.publicKey.toString(), wrapAndUnwrapSol:true,
        dynamicSlippage:{minBps:50,maxBps:CONFIG.MAX_SLIPPAGE_BPS}, prioritizationFeeLamports:CONFIG.PRIORITY_FEE_LAMPORTS})});
    if(!sr.ok) throw new Error(`Swap ${sr.status}`);
    const sd = await sr.json();
    if(!sd.swapTransaction) throw new Error('No swap tx');

    const buf = Buffer.from(sd.swapTransaction,'base64');
    const tx = VersionedTransaction.deserialize(buf);
    tx.sign([state.wallet]);
    const sig = await state.connection.sendRawTransaction(tx.serialize(),{skipPreflight:true,maxRetries:3});

    if(await confirm(sig)) {
      state.positions.set(mint, {time:Date.now(), sol, sym:info.sym});
      state.stats.buys++;
      const msg = `🪞🟢 **BUY** ${info.name} (${info.sym})\n\`${mint}\`\n${sol.toFixed(4)} SOL (target: ${targetSol.toFixed(2)} SOL)\nhttps://solscan.io/tx/${sig}`;
      log('BUY', `✅ ${info.sym} ${sol.toFixed(4)} SOL`);
      await discord(msg);
      return true;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    log('ERROR', `Buy fail: ${e.message}`, {attempt});
    if(attempt < CONFIG.MAX_RETRIES) {
      state.stats.retries++;
      log('RETRY', `Retrying in 2s... (${attempt}/${CONFIG.MAX_RETRIES})`);
      await sleep(2000);
      return execBuy(mint, sol, targetSol, attempt+1);
    }
    state.stats.errors++;
    await discord(`❌ Buy failed after ${CONFIG.MAX_RETRIES} tries: ${info.sym} \`${mint}\` — ${e.message}`);
    return false;
  }
}

async function execSell(mint, reason, attempt=1) {
  const info = await tokenInfo(mint);
  log('EXEC', `🚪 SELL ${info.sym} — ${reason} (attempt ${attempt})`, {mint:mint.slice(0,12)});

  try {
    const accts = await state.connection.getParsedTokenAccountsByOwner(state.wallet.publicKey,{mint:new PublicKey(mint)});
    const acct = accts?.value?.[0];
    if(!acct) { state.positions.delete(mint); return false; }
    const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount||0);
    if(bal<=0) { state.positions.delete(mint); return false; }
    const dec = acct.account.data.parsed.info.tokenAmount.decimals;
    const raw = BigInt(Math.floor(bal * Math.pow(10, dec)));
    if(raw<=0n) { state.positions.delete(mint); return false; }

    const qr = await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL}&amount=${raw.toString()}&slippageBps=${CONFIG.MAX_SLIPPAGE_BPS}`);
    if(!qr.ok) throw new Error(`Sell quote ${qr.status}`);
    const q = await qr.json();
    if(!q.outAmount) throw new Error('No sell route');

    const sr = await fetch(CONFIG.JUPITER_SWAP,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({quoteResponse:q, userPublicKey:state.wallet.publicKey.toString(), wrapAndUnwrapSol:true,
        dynamicSlippage:{minBps:50,maxBps:CONFIG.MAX_SLIPPAGE_BPS}, prioritizationFeeLamports:CONFIG.PRIORITY_FEE_LAMPORTS})});
    if(!sr.ok) throw new Error(`Sell swap ${sr.status}`);
    const sd = await sr.json();
    if(!sd.swapTransaction) throw new Error('No sell tx');

    const buf = Buffer.from(sd.swapTransaction,'base64');
    const tx = VersionedTransaction.deserialize(buf);
    tx.sign([state.wallet]);
    const sig = await state.connection.sendRawTransaction(tx.serialize(),{skipPreflight:true,maxRetries:3});

    if(await confirm(sig)) {
      const solBack = parseFloat(q.outAmount)/1e9;
      const entry = state.positions.get(mint);
      const pnl = entry ? (solBack - entry.sol) : 0;
      state.stats.sells++;
      state.positions.delete(mint);
      const msg = `🪞🔴 **SELL** ${info.name} (${info.sym})\n\`${mint}\`\n${solBack.toFixed(4)} SOL back | PnL: ${pnl>=0?'+':''}${pnl.toFixed(4)} SOL\n${reason}\nhttps://solscan.io/tx/${sig}`;
      log('SELL', `✅ ${info.sym} → ${solBack.toFixed(4)} SOL (${pnl>=0?'+':''}${pnl.toFixed(4)})`);
      await discord(msg);
      return true;
    } else { throw new Error('Confirm timeout'); }
  } catch(e) {
    log('ERROR', `Sell fail: ${e.message}`, {attempt});
    if(attempt < CONFIG.MAX_RETRIES) {
      state.stats.retries++;
      log('RETRY', `Retry sell in 2s... (${attempt}/${CONFIG.MAX_RETRIES})`);
      await sleep(2000);
      return execSell(mint, reason, attempt+1);
    }
    state.stats.errors++;
    await discord(`❌ Sell failed after ${CONFIG.MAX_RETRIES} tries: ${info.sym} \`${mint}\` — ${e.message}`);
    return false;
  }
}

async function confirm(sig, timeout=60000) {
  const s=Date.now();
  while(Date.now()-s<timeout) {
    try {
      const r=await state.connection.getSignatureStatuses([sig]);
      const v=r?.value?.[0];
      if(v?.err) return false;
      if(v?.confirmationStatus==='confirmed'||v?.confirmationStatus==='finalized') return true;
    } catch(e){}
    await sleep(2000);
  }
  return false;
}

// === SIZING ===
function calcSize(targetSol, ourBal) {
  let amt = targetSol * CONFIG.RATIO;
  amt = Math.max(amt, CONFIG.MIN_BUY_SOL);
  amt = Math.min(amt, ourBal * CONFIG.MAX_BUY_PCT);
  amt = Math.min(amt, ourBal - 0.003);
  return amt >= CONFIG.MIN_BUY_SOL ? amt : 0;
}

// === POLL ===
async function poll() {
  log('INFO', `👀 Watching ${CONFIG.TARGET.slice(0,12)}... every ${CONFIG.POLL_MS/1000}s`);
  let cycle = 0;

  while(state.isRunning) {
    cycle++;
    try {
      const r = await fetch(CONFIG.HELIUS_RPC,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getSignaturesForAddress',params:[CONFIG.TARGET,{limit:5}]})});
      const d = await r.json();
      const sigs = d?.result || [];
      const newSigs = [];
      for(const s of sigs) { if(s.signature===state.lastSig) break; if(!s.err) newSigs.push(s); }

      if(newSigs.length > 0) {
        state.lastSig = newSigs[0].signature;
        const parsed = await heliusParse(newSigs.map(s=>s.signature));

        for(const tx of parsed) {
          const trades = extractTrades(tx);
          if(!trades) continue;

          // Process sells first
          for(const t of trades.filter(t=>t.dir==='sell')) {
            if(state.positions.has(t.mint)) {
              log('MIRROR', `🎯 Target SELL ${t.mint.slice(0,8)}...`);
              await execSell(t.mint, 'target_sold');
              await sleep(500);
            } else {
              // Check if we have leftover tokens
              try {
                const a = await state.connection.getParsedTokenAccountsByOwner(state.wallet.publicKey,{mint:new PublicKey(t.mint)});
                const b = parseFloat(a?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount||0);
                if(b > 0) {
                  state.positions.set(t.mint, {time:0, sol:0, sym:'?'});
                  await execSell(t.mint, 'target_sold_leftover');
                  await sleep(500);
                }
              } catch(e){}
            }
          }

          // Then buys
          for(const t of trades.filter(t=>t.dir==='buy')) {
            if(state.positions.has(t.mint)) continue;

            const bal = await solBal();
            const size = calcSize(t.sol, bal);
            if(size <= 0) {
              log('INFO', `Low bal (${bal.toFixed(4)}) — skip`);
              break;
            }

            log('MIRROR', `🎯 Target BUY ${t.mint.slice(0,8)}... ${t.sol.toFixed(2)} SOL → us: ${size.toFixed(4)} SOL`);
            await execBuy(t.mint, size, t.sol);
            await sleep(500);
          }
        }
      }

      if(cycle % 20 === 0) {
        log('INFO', `📊 #${cycle} | ${state.positions.size} pos | ${state.stats.buys}B ${state.stats.sells}S ${state.stats.errors}E ${state.stats.retries}R`);
      }
    } catch(e) { log('ERROR', 'Poll', {err:e.message}); }
    await sleep(CONFIG.POLL_MS);
  }
}

// === HEALTH ===
async function health() {
  while(state.isRunning) {
    const bal = await solBal();
    const pnl = bal - state.stats.startBal;
    console.log('\n' + '═'.repeat(50));
    console.log('  🪞 WINSTON v11 — Exact Mirror');
    console.log('═'.repeat(50));
    console.log(`  🎯 ${CONFIG.TARGET.slice(0,20)}...`);
    console.log(`  💰 ${bal.toFixed(4)} SOL | PnL: ${pnl>=0?'+':''}${pnl.toFixed(4)}`);
    console.log(`  🛒 ${state.stats.buys}B 🚪 ${state.stats.sells}S ❌ ${state.stats.errors}E 🔄 ${state.stats.retries}R`);
    console.log(`  📦 ${state.positions.size} positions`);
    for(const [m,p] of state.positions) {
      const age = ((Date.now()-p.time)/60000).toFixed(0);
      console.log(`     ${p.sym} ${m.slice(0,8)}... | ${age}m | ${p.sol.toFixed(4)} SOL`);
    }
    console.log('═'.repeat(50) + '\n');
    await sleep(CONFIG.HEALTH_MS);
  }
}

// === MAIN ===
async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  🪞 WINSTON v11 — Exact Mirror Bot            ║');
  console.log('║  Target: Fw8Cwufb...FvSDg                     ║');
  console.log('║  Retry on fail • Minimal fees • Discord only   ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  if(!CONFIG.HELIUS_API_KEY) { log('ERROR','HELIUS_API_KEY needed'); process.exit(1); }
  if(!CONFIG.PRIVATE_KEY) { log('ERROR','WALLET_PRIVATE_KEY needed'); process.exit(1); }

  try { state.wallet = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY)); }
  catch(e) { log('ERROR','Bad key'); process.exit(1); }
  log('INFO', `Wallet: ${state.wallet.publicKey}`);

  state.connection = new Connection(CONFIG.HELIUS_RPC, {commitment:'confirmed'});
  state.stats.startBal = await solBal();
  log('INFO', `Balance: ${state.stats.startBal.toFixed(4)} SOL`);

  try {
    const r = await fetch(CONFIG.HELIUS_RPC,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getSignaturesForAddress',params:[CONFIG.TARGET,{limit:1}]})});
    const d = await r.json();
    state.lastSig = d?.result?.[0]?.signature || null;
  } catch(e) { log('ERROR','Init fail'); process.exit(1); }

  state.isRunning = true;
  log('INFO', `📐 Ratio: ${(CONFIG.RATIO*100).toFixed(1)}% | Min: ${CONFIG.MIN_BUY_SOL} SOL | Max: ${(CONFIG.MAX_BUY_PCT*100)}% of bal`);
  log('INFO', `💨 Priority: ${CONFIG.PRIORITY_FEE_LAMPORTS/1e9} SOL | Slippage: ${CONFIG.MAX_SLIPPAGE_BPS/100}%`);
  log('INFO', `🔄 Retries: ${CONFIG.MAX_RETRIES} per trade`);

  await discord(`🪞 **Winston v11 LIVE**\nTarget: \`${CONFIG.TARGET}\`\nBalance: ${state.stats.startBal.toFixed(4)} SOL\nRatio: ${(CONFIG.RATIO*100).toFixed(1)}% | Retry: ${CONFIG.MAX_RETRIES}x | Fee: ${CONFIG.PRIORITY_FEE_LAMPORTS/1e9} SOL`);

  const shutdown = async () => {
    state.isRunning = false;
    const f = await solBal(); const p = f - state.stats.startBal;
    await discord(`🛑 **Offline** | ${f.toFixed(4)} SOL | PnL: ${p>=0?'+':''}${p.toFixed(4)} | ${state.stats.buys}B ${state.stats.sells}S ${state.stats.errors}E`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await Promise.all([poll(), health()]);
}

main().catch(e => { log('ERROR','Fatal',{err:e.message}); process.exit(1); });
