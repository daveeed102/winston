// ============================================================
// WINSTON v10.1 — Single Wallet Mirror Bot (Fixed)
// ============================================================
// FIXES: Lower fees, max 3 positions, auto-sell stale holds,
// handles token-to-token swaps, better sell detection
// ============================================================

require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');

const CONFIG = {
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  get HELIUS_RPC() { return `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },
  get HELIUS_TX_API() { return `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${this.HELIUS_API_KEY}`; },
  PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || '',
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || '',
  JUPITER_QUOTE: 'https://lite-api.jup.ag/swap/v1/quote',
  JUPITER_SWAP: 'https://lite-api.jup.ag/swap/v1/swap',
  JUPITER_PRICE: 'https://lite-api.jup.ag/price/v2',

  TARGET_WALLET: 'ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn',

  // Sizing — his ~$1818 vs our ~$25
  TARGET_VALUE_USD: 1818,
  OUR_VALUE_USD: 25,
  PROPORTIONAL_BOOST: 2.5,
  MIN_TRADE_SOL: 0.02,     // Min trade ~$2.50
  MAX_TRADE_PCT: 0.50,     // Max 50% of balance per trade
  MAX_POSITIONS: 5,         // Hold up to 5 at once

  // Fees — LOWERED
  MAX_SLIPPAGE_BPS: 200,
  PRIORITY_FEE_LAMPORTS: 50000,  // 0.00005 SOL (was 0.0002 — cut 4x)

  // Stale position auto-sell: if we hold something for 10min and target sold it, dump it
  STALE_CHECK_INTERVAL_MS: 15000,  // Check stale positions every 15s
  MAX_HOLD_MINUTES: 2,            // Auto-sell anything held > 2min

  POLL_INTERVAL_MS: 2000,
  HEALTH_LOG_INTERVAL_MS: 120000,
  SOL_MINT: 'So11111111111111111111111111111111111111112',
};

const STABLES = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);

const state = {
  wallet: null, connection: null, lastSig: null, isRunning: false,
  positions: new Map(), // mint -> { entryTime, entrySolAmount }
  stats: { trades:0, buys:0, sells:0, totalPnlSol:0, startBalance:0, errors:0, skipped:0 },
};

// ============================================================
// UTILITIES
// ============================================================
function log(level, msg, data={}) {
  const ts = new Date().toISOString();
  const icons = {INFO:'📡',BUY:'🟢',SELL:'🔴',WARN:'⚠️',ERROR:'❌',EXEC:'⚡',MIRROR:'🪞',STALE:'🧹'};
  const extra = Object.keys(data).length ? ' '+JSON.stringify(data) : '';
  console.log(`[${ts}] ${icons[level]||'📋'} [${level}] ${msg}${extra}`);
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function getSOLBalance() {
  try { return (await state.connection.getBalance(state.wallet.publicKey))/1e9; } catch(e){return 0;}
}
async function getTokenPrice(mint) {
  try { const r=await fetch(`${CONFIG.JUPITER_PRICE}?ids=${mint}`); if(!r.ok)return 0; const d=await r.json(); return parseFloat(d?.data?.[mint]?.price||0); } catch(e){return 0;}
}
async function getTokenInfo(mint) {
  try { const r=await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mint}`); if(r.ok){const d=await r.json(); return {name:d.name||'Unknown',symbol:d.symbol||'???'};} } catch(e){}
  return {name:'Unknown',symbol:'???'};
}
async function discord(msg) {
  if(!CONFIG.DISCORD_WEBHOOK)return;
  try{const t=msg.length>1990?msg.slice(0,1990)+'...':msg; await fetch(CONFIG.DISCORD_WEBHOOK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:t})});}catch(e){}
}

// ============================================================
// SIZING — Proportional but capped
// ============================================================
function calcSize(targetSol, ourBal) {
  const ratio = (CONFIG.OUR_VALUE_USD / CONFIG.TARGET_VALUE_USD) * CONFIG.PROPORTIONAL_BOOST;
  let amt = targetSol * ratio;
  const maxAmt = ourBal * CONFIG.MAX_TRADE_PCT;
  amt = Math.max(amt, CONFIG.MIN_TRADE_SOL);
  amt = Math.min(amt, maxAmt);
  amt = Math.min(amt, ourBal - 0.003); // Leave gas
  return amt > CONFIG.MIN_TRADE_SOL ? amt : 0;
}

// ============================================================
// HELIUS ENHANCED PARSER
// ============================================================
async function parseHelius(sigs) {
  try {
    const r = await fetch(CONFIG.HELIUS_TX_API, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transactions:sigs})});
    if(!r.ok){log('WARN',`Helius ${r.status}`);return[];} return await r.json()||[];
  }catch(e){return[];}
}

function extractTrade(tx) {
  if(tx.transactionError) return null;
  const w = CONFIG.TARGET_WALLET;
  const transfers = tx.tokenTransfers||[];
  const native = tx.nativeTransfers||[];

  let solOut=0, solIn=0;
  for(const t of native) {
    if(t.fromUserAccount===w) solOut+=(t.amount||0)/1e9;
    if(t.toUserAccount===w) solIn+=(t.amount||0)/1e9;
  }

  // Collect ALL token movements for this wallet
  const buying = []; // tokens flowing IN
  const selling = []; // tokens flowing OUT
  for(const t of transfers) {
    if(STABLES.has(t.mint)||t.mint===CONFIG.SOL_MINT) continue;
    if(t.toUserAccount===w && t.tokenAmount>0) buying.push({mint:t.mint, amount:t.tokenAmount});
    if(t.fromUserAccount===w && t.tokenAmount>0) selling.push({mint:t.mint, amount:t.tokenAmount});
  }

  // Return ALL movements — both buys and sells from a single tx
  const trades = [];

  for(const b of buying) {
    trades.push({
      tokenMint:b.mint, direction:'buy', solAmount:solOut||0.001,
      tokenAmount:b.amount, signature:tx.signature, timestamp:tx.timestamp,
      source:tx.source||'UNKNOWN', txType:tx.type||'UNKNOWN',
    });
  }
  for(const s of selling) {
    trades.push({
      tokenMint:s.mint, direction:'sell', solAmount:solIn||0.001,
      tokenAmount:s.amount, signature:tx.signature, timestamp:tx.timestamp,
      source:tx.source||'UNKNOWN', txType:tx.type||'UNKNOWN',
    });
  }

  return trades.length > 0 ? trades : null;
}

// ============================================================
// EXECUTION
// ============================================================
async function executeBuy(mint, sol, trade) {
  const info = await getTokenInfo(mint);
  const lamports = Math.floor(sol*1e9);
  log('EXEC',`🛒 BUY ${info.symbol} (${mint.slice(0,12)}...) ${sol.toFixed(4)} SOL`);

  try {
    const qr = await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${CONFIG.SOL_MINT}&outputMint=${mint}&amount=${lamports}&slippageBps=${CONFIG.MAX_SLIPPAGE_BPS}`);
    if(!qr.ok){log('ERROR',`Quote ${qr.status} for ${mint.slice(0,8)}`);state.stats.errors++;return false;}
    const q = await qr.json();
    if(!q.outAmount||q.outAmount==='0'){log('ERROR',`No route ${mint.slice(0,8)}`);state.stats.errors++;return false;}

    const sr = await fetch(CONFIG.JUPITER_SWAP,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({quoteResponse:q,userPublicKey:state.wallet.publicKey.toString(),wrapAndUnwrapSol:true,
        dynamicSlippage:{minBps:50,maxBps:CONFIG.MAX_SLIPPAGE_BPS},prioritizationFeeLamports:CONFIG.PRIORITY_FEE_LAMPORTS})});
    if(!sr.ok){log('ERROR',`Swap req ${sr.status}`);state.stats.errors++;return false;}
    const sd = await sr.json();
    if(!sd.swapTransaction){log('ERROR','No swap tx');state.stats.errors++;return false;}

    const buf = Buffer.from(sd.swapTransaction,'base64');
    const tx = VersionedTransaction.deserialize(buf);
    tx.sign([state.wallet]);
    const sig = await state.connection.sendRawTransaction(tx.serialize(),{skipPreflight:true,maxRetries:3});

    if(await confirmTx(sig)) {
      state.positions.set(mint,{entryTime:Date.now(),entrySolAmount:sol});
      state.stats.trades++; state.stats.buys++;
      const price = await getTokenPrice(mint);
      const msg = `🪞 **MIRROR BUY** #${state.stats.buys}\n**${info.name}** (${info.symbol})\n**Mint:** \`${mint}\`\n**Amount:** ${sol.toFixed(4)} SOL | **Price:** $${price?price.toFixed(8):'?'}\n**Target:** ${trade.solAmount.toFixed(4)} SOL via ${trade.source}\n**Tx:** https://solscan.io/tx/${sig}`;
      log('BUY',`✅ ${info.symbol} ${sol.toFixed(4)} SOL`); await discord(msg);
      return true;
    } else {
      log('ERROR',`TX fail: ${sig.slice(0,16)}`); state.stats.errors++;
      await discord(`❌ Buy failed: ${info.symbol} \`${mint}\``);
      return false;
    }
  }catch(e){log('ERROR','Buy error',{error:e.message});state.stats.errors++;return false;}
}

async function executeSell(mint, reason) {
  const info = await getTokenInfo(mint);
  log('EXEC',`🚪 SELL ${info.symbol} (${mint.slice(0,12)}...) reason: ${reason}`);

  try {
    const accts = await state.connection.getParsedTokenAccountsByOwner(state.wallet.publicKey,{mint:new PublicKey(mint)});
    const acct = accts?.value?.[0];
    if(!acct){state.positions.delete(mint);return false;}

    const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount||0);
    if(bal<=0){state.positions.delete(mint);return false;}

    const dec = acct.account.data.parsed.info.tokenAmount.decimals;
    const raw = BigInt(Math.floor(bal*Math.pow(10,dec)));
    if(raw<=0n){state.positions.delete(mint);return false;}

    const qr = await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL_MINT}&amount=${raw.toString()}&slippageBps=${CONFIG.MAX_SLIPPAGE_BPS}`);
    if(!qr.ok){log('ERROR',`Sell quote ${qr.status}`);state.stats.errors++;return false;}
    const q = await qr.json();
    if(!q.outAmount){log('ERROR','No sell route');state.stats.errors++;return false;}

    const sr = await fetch(CONFIG.JUPITER_SWAP,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({quoteResponse:q,userPublicKey:state.wallet.publicKey.toString(),wrapAndUnwrapSol:true,
        dynamicSlippage:{minBps:50,maxBps:CONFIG.MAX_SLIPPAGE_BPS},prioritizationFeeLamports:CONFIG.PRIORITY_FEE_LAMPORTS})});
    if(!sr.ok){log('ERROR',`Sell swap ${sr.status}`);state.stats.errors++;return false;}
    const sd = await sr.json();
    if(!sd.swapTransaction){log('ERROR','No sell tx');state.stats.errors++;return false;}

    const buf = Buffer.from(sd.swapTransaction,'base64');
    const tx = VersionedTransaction.deserialize(buf);
    tx.sign([state.wallet]);
    const sig = await state.connection.sendRawTransaction(tx.serialize(),{skipPreflight:true,maxRetries:3});

    if(await confirmTx(sig)) {
      const solBack = parseFloat(q.outAmount)/1e9;
      const entry = state.positions.get(mint);
      const pnl = entry?.entrySolAmount ? (solBack-entry.entrySolAmount) : 0;
      state.stats.totalPnlSol+=pnl; state.stats.trades++; state.stats.sells++;
      state.positions.delete(mint);

      const msg = `🪞 **MIRROR SELL** #${state.stats.sells}\n**${info.name}** (${info.symbol})\n**Mint:** \`${mint}\`\n**Back:** ${solBack.toFixed(4)} SOL | **PnL:** ${pnl>=0?'+':''}${pnl.toFixed(4)} SOL\n**Reason:** ${reason}\n**Tx:** https://solscan.io/tx/${sig}`;
      log('SELL',`✅ ${info.symbol} → ${solBack.toFixed(4)} SOL (${pnl>=0?'+':''}${pnl.toFixed(4)})`); await discord(msg);
      return true;
    } else {
      log('ERROR','Sell TX failed'); state.stats.errors++;
      return false;
    }
  }catch(e){log('ERROR','Sell error',{error:e.message});state.stats.errors++;return false;}
}

async function confirmTx(sig, timeout=60000) {
  const start=Date.now();
  while(Date.now()-start<timeout){
    try{const s=await state.connection.getSignatureStatuses([sig]);const r=s?.value?.[0];
      if(r?.err)return false; if(r?.confirmationStatus==='confirmed'||r?.confirmationStatus==='finalized')return true;
    }catch(e){} await sleep(2000);
  } return false;
}

// ============================================================
// STALE POSITION CLEANUP — Auto-sell holds older than 10min
// ============================================================
async function staleChecker() {
  while(state.isRunning) {
    await sleep(CONFIG.STALE_CHECK_INTERVAL_MS);

    for(const [mint, pos] of state.positions) {
      const ageMin = (Date.now()-pos.entryTime)/60000;
      if(ageMin >= CONFIG.MAX_HOLD_MINUTES) {
        log('STALE',`🧹 Position ${mint.slice(0,8)}... is ${ageMin.toFixed(0)}m old — auto-selling`);
        await executeSell(mint, `stale_${ageMin.toFixed(0)}min`);
        await sleep(500);
      }
    }
  }
}

// ============================================================
// POLLING LOOP
// ============================================================
async function pollTarget() {
  log('INFO',`👀 Watching ${CONFIG.TARGET_WALLET.slice(0,12)}... every ${CONFIG.POLL_INTERVAL_MS/1000}s`);
  let cycle=0;

  while(state.isRunning) {
    cycle++;
    try {
      const r = await fetch(CONFIG.HELIUS_RPC,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getSignaturesForAddress',params:[CONFIG.TARGET_WALLET,{limit:5}]})});
      const d = await r.json();
      const sigs = d?.result||[];
      const newSigs=[];
      for(const s of sigs){if(s.signature===state.lastSig)break;if(!s.err)newSigs.push(s);}

      if(newSigs.length>0) {
        state.lastSig=newSigs[0].signature;
        log('MIRROR',`🔍 ${newSigs.length} new tx(s)`);

        const parsed = await parseHelius(newSigs.map(s=>s.signature));

        for(const tx of parsed) {
          const trades = extractTrade(tx);
          if(!trades){
            log('INFO',`  ↳ ${tx.signature?.slice(0,12)}... type=${tx.type||'?'} — no token trades`);
            continue;
          }

          // Process sells FIRST (free up positions before buying new ones)
          const sellTrades = trades.filter(t=>t.direction==='sell');
          const buyTrades = trades.filter(t=>t.direction==='buy');

          for(const trade of sellTrades) {
            if(state.positions.has(trade.tokenMint)) {
              log('MIRROR',`🎯 Target SELL ${trade.tokenMint.slice(0,8)}... — mirroring`);
              await executeSell(trade.tokenMint, 'target_sold');
              await sleep(300);
            } else {
              // Check if we have it from previous session
              try {
                const a = await state.connection.getParsedTokenAccountsByOwner(state.wallet.publicKey,{mint:new PublicKey(trade.tokenMint)});
                const b = parseFloat(a?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount||0);
                if(b>0) {
                  log('MIRROR',`Found leftover ${trade.tokenMint.slice(0,8)}... — selling`);
                  state.positions.set(trade.tokenMint,{entryTime:0,entrySolAmount:0});
                  await executeSell(trade.tokenMint, 'target_sold_leftover');
                  await sleep(300);
                }
              }catch(e){}
            }
          }

          for(const trade of buyTrades) {
            // Skip if at max positions
            if(state.positions.size >= CONFIG.MAX_POSITIONS) {
              log('INFO',`⏭️ At max ${CONFIG.MAX_POSITIONS} positions — skipping buy ${trade.tokenMint.slice(0,8)}...`);
              state.stats.skipped++;
              continue;
            }
            // Skip if already holding this token
            if(state.positions.has(trade.tokenMint)) {
              log('INFO',`Already holding ${trade.tokenMint.slice(0,8)}... — skip`);
              continue;
            }

            const bal = await getSOLBalance();
            const size = calcSize(trade.solAmount, bal);
            if(size<=0) {
              log('WARN',`Balance too low (${bal.toFixed(4)}) — skip`);
              state.stats.skipped++;
              continue;
            }

            log('MIRROR',`🎯 Target BUY ${trade.tokenMint.slice(0,8)}... ${trade.solAmount.toFixed(4)} SOL → us: ${size.toFixed(4)} SOL (${((size/bal)*100).toFixed(0)}%)`);
            await executeBuy(trade.tokenMint, size, trade);
            await sleep(300);
          }
        }
      }

      if(cycle%15===0) {
        log('INFO',`📊 #${cycle} | ${state.positions.size}/${CONFIG.MAX_POSITIONS} pos | ${state.stats.buys}B ${state.stats.sells}S ${state.stats.errors}E ${state.stats.skipped}skip`);
      }
    }catch(e){log('ERROR','Poll err',{error:e.message});}
    await sleep(CONFIG.POLL_INTERVAL_MS);
  }
}

// ============================================================
// HEALTH
// ============================================================
async function healthLoop() {
  while(state.isRunning) {
    const bal=await getSOLBalance(); const sp=await getTokenPrice(CONFIG.SOL_MINT);
    const usd=(bal*sp).toFixed(2); const pnl=bal-state.stats.startBalance;
    console.log('\n'+'═'.repeat(55));
    console.log('  🪞 WINSTON v10.1 — Mirror Bot');
    console.log('═'.repeat(55));
    console.log(`  🎯 Target: ${CONFIG.TARGET_WALLET.slice(0,16)}...`);
    console.log(`  💰 ${bal.toFixed(4)} SOL ($${usd}) | PnL: ${pnl>=0?'+':''}${pnl.toFixed(4)} SOL`);
    console.log(`  🛒 ${state.stats.buys}B | 🚪 ${state.stats.sells}S | ❌ ${state.stats.errors}E | ⏭️ ${state.stats.skipped} skipped`);
    console.log(`  📦 ${state.positions.size}/${CONFIG.MAX_POSITIONS} positions | ⏰ Auto-sell: ${CONFIG.MAX_HOLD_MINUTES}min`);
    for(const [m,p] of state.positions){
      const age=((Date.now()-p.entryTime)/60000).toFixed(0);
      const info=await getTokenInfo(m);
      console.log(`     ${info.symbol} ${m.slice(0,8)}... | ${age}m | ${p.entrySolAmount.toFixed(4)} SOL`);
    }
    console.log('═'.repeat(55)+'\n');
    await sleep(CONFIG.HEALTH_LOG_INTERVAL_MS);
  }
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║     🪞 WINSTON v10.1 — Mirror Bot (Fixed)                 ║');
  console.log('║     Lower Fees • Max 3 Pos • Auto-Sell Stale • T2T Fix    ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  if(!CONFIG.HELIUS_API_KEY){log('ERROR','HELIUS_API_KEY required');process.exit(1);}
  if(!CONFIG.PRIVATE_KEY){log('ERROR','WALLET_PRIVATE_KEY required');process.exit(1);}

  try{state.wallet=Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));}
  catch(e){log('ERROR','Bad key');process.exit(1);}
  log('INFO',`Wallet: ${state.wallet.publicKey}`);

  state.connection = new Connection(CONFIG.HELIUS_RPC,{commitment:'confirmed'});
  state.stats.startBalance = await getSOLBalance();
  const sp = await getTokenPrice(CONFIG.SOL_MINT);
  log('INFO',`Balance: ${state.stats.startBalance.toFixed(4)} SOL ($${(state.stats.startBalance*sp).toFixed(2)})`);
  if(state.stats.startBalance<0.01){log('ERROR','Balance too low');process.exit(1);}

  // Init last sig
  try{
    const r=await fetch(CONFIG.HELIUS_RPC,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getSignaturesForAddress',params:[CONFIG.TARGET_WALLET,{limit:1}]})});
    const d=await r.json(); state.lastSig=d?.result?.[0]?.signature||null;
  }catch(e){log('ERROR','Init fail');process.exit(1);}

  state.isRunning=true;
  const ratio=((CONFIG.OUR_VALUE_USD/CONFIG.TARGET_VALUE_USD)*CONFIG.PROPORTIONAL_BOOST*100).toFixed(2);
  log('INFO',`📐 ${ratio}% of target | Min ${CONFIG.MIN_TRADE_SOL} SOL | Max ${(CONFIG.MAX_TRADE_PCT*100)}% | ${CONFIG.MAX_POSITIONS} max pos`);
  log('INFO',`💨 Priority fee: ${CONFIG.PRIORITY_FEE_LAMPORTS/1e9} SOL (lowered)`);
  log('INFO',`🧹 Auto-sell stale positions after ${CONFIG.MAX_HOLD_MINUTES}min`);

  await discord(`🪞 **Winston v10.1 LIVE**\nTarget: \`${CONFIG.TARGET_WALLET}\`\nBalance: ${state.stats.startBalance.toFixed(4)} SOL\nMax ${CONFIG.MAX_POSITIONS} positions | Auto-sell ${CONFIG.MAX_HOLD_MINUTES}min\nFee: ${CONFIG.PRIORITY_FEE_LAMPORTS/1e9} SOL`);

  const shutdown=async()=>{
    state.isRunning=false;const f=await getSOLBalance();const p=f-state.stats.startBalance;
    await discord(`🛑 **Offline** | ${f.toFixed(4)} SOL | PnL: ${p>=0?'+':''}${p.toFixed(4)} | ${state.stats.buys}B ${state.stats.sells}S ${state.stats.errors}E`);
    process.exit(0);
  };
  process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);

  await Promise.all([pollTarget(), staleChecker(), healthLoop()]);
}

main().catch(e=>{log('ERROR','Fatal',{error:e.message});process.exit(1);});
