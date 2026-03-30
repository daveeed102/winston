// ============================================================
// WINSTON v10.2 — Momentum Filter Mirror Bot
// ============================================================
// Watches target trader. When he buys, checks momentum first.
// Only buys tokens showing upward price movement.
// $5 fixed size, max 3 positions, 5min auto-sell.
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

  // Fixed $5 per trade (~0.037 SOL at ~$135/SOL)
  TRADE_AMOUNT_SOL: 0.037,
  MAX_POSITIONS: 3,

  // Momentum: take 2 price snapshots 3s apart, need >0% gain
  MOMENTUM_DELAY_MS: 3000,
  MIN_MOMENTUM_PCT: 0,  // Any positive movement = go

  // Fees — minimal
  MAX_SLIPPAGE_BPS: 200,
  PRIORITY_FEE_LAMPORTS: 50000,

  // ============================================================
  // EXIT STRATEGY — Smart multi-layer exit
  // ============================================================
  // Stop loss: dump everything if down this much
  STOP_LOSS_PCT: -12,

  // Take profit ladder:
  //   TP1: sell 40% at +15%
  //   TP2: sell another 30% at +30%
  //   TP3: sell remaining at +50%
  TP1_PCT: 15,   TP1_SELL: 40,
  TP2_PCT: 30,   TP2_SELL: 30,
  TP3_PCT: 50,   TP3_SELL: 100,  // Sell all remaining

  // Trailing stop: once we're up 10%+, if price drops 8% from peak → sell all
  TRAILING_ACTIVATE_PCT: 10,  // Activate trailing stop after +10%
  TRAILING_DROP_PCT: 8,       // Sell if drops 8% from highest seen price

  // Time safety net: force sell everything after 15 min no matter what
  MAX_HOLD_MINUTES: 15,

  // How often to check positions for exit conditions
  EXIT_CHECK_MS: 5000,  // Every 5 seconds

  POLL_INTERVAL_MS: 2000,
  HEALTH_LOG_INTERVAL_MS: 60000,
  SOL_MINT: 'So11111111111111111111111111111111111111112',
};

const STABLES = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
const state = {
  wallet:null, connection:null, lastSig:null, isRunning:false,
  positions: new Map(),
  recentlyChecked: new Map(), // mint -> timestamp (skip duplicates within 30s)
  stats: { trades:0, buys:0, sells:0, errors:0, skipped:0, momentumFails:0, startBalance:0 },
};

// ============================================================
// UTILITIES
// ============================================================
function log(lv, msg, data={}) {
  const ts=new Date().toISOString();
  const ic={INFO:'📡',BUY:'🟢',SELL:'🔴',WARN:'⚠️',ERROR:'❌',EXEC:'⚡',MIRROR:'🪞',MOMENTUM:'📈',STALE:'🧹'};
  console.log(`[${ts}] ${ic[lv]||'📋'} [${lv}] ${msg}${Object.keys(data).length?' '+JSON.stringify(data):''}`);
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function getSOLBalance() {
  try{return(await state.connection.getBalance(state.wallet.publicKey))/1e9;}catch(e){return 0;}
}
async function getTokenPrice(mint) {
  // Source 1: Jupiter Price API (works for established tokens)
  try {
    const r = await fetch(`${CONFIG.JUPITER_PRICE}?ids=${mint}`);
    if (r.ok) {
      const d = await r.json();
      const p = parseFloat(d?.data?.[mint]?.price || 0);
      if (p > 0) return p;
    }
  } catch(e) {}

  // Source 2: Get price via Jupiter quote (works for ANY tradeable token including pump.fun)
  // Ask "how much SOL would I get for 1M units of this token?" and derive price
  try {
    const testAmount = '1000000000'; // 1 billion raw units (covers most decimals)
    const r = await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL_MINT}&amount=${testAmount}&slippageBps=500`);
    if (r.ok) {
      const q = await r.json();
      if (q.outAmount && q.outAmount !== '0') {
        const solOut = parseFloat(q.outAmount) / 1e9;
        const inputDecimals = q.inputMint === mint ? (q.routePlan?.[0]?.swapInfo?.inputMint === mint ? 9 : 6) : 9;
        // outAmount is in lamports, inAmount is in raw token units
        const inAmount = parseFloat(q.inAmount || testAmount);
        if (inAmount > 0 && solOut > 0) {
          // Price per token in SOL, then we'd need SOL price to get USD
          // But for momentum comparison, SOL-denominated price works fine
          const solPrice = solOut / (inAmount / Math.pow(10, 9)); // approximate
          return solPrice; // Returns price in SOL terms — good enough for momentum
        }
      }
    }
  } catch(e) {}

  // Source 3: Try with a smaller amount (some tokens have very different decimals)
  try {
    const r = await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${CONFIG.SOL_MINT}&outputMint=${mint}&amount=10000000&slippageBps=500`);
    if (r.ok) {
      const q = await r.json();
      if (q.outAmount && q.outAmount !== '0') {
        // We're asking "how many tokens for 0.01 SOL?"
        // If we get tokens back, the token is tradeable — return a synthetic price
        const tokensOut = parseFloat(q.outAmount);
        if (tokensOut > 0) {
          return 10000000 / tokensOut; // lamports per token unit — consistent for momentum
        }
      }
    }
  } catch(e) {}

  return 0;
}
async function getTokenInfo(mint) {
  try{const r=await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mint}`);if(r.ok){const d=await r.json();return{name:d.name||'Unknown',symbol:d.symbol||'???'};}}catch(e){}
  return{name:'Unknown',symbol:'???'};
}
async function discord(msg) {
  if(!CONFIG.DISCORD_WEBHOOK)return;
  try{await fetch(CONFIG.DISCORD_WEBHOOK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:msg.slice(0,1990)})});}catch(e){}
}

// ============================================================
// MOMENTUM CHECK — 2 price snapshots, need upward movement
// ============================================================
async function hasMomentum(mint) {
  const price1 = await getTokenPrice(mint);
  if(!price1 || price1 <= 0) {
    log('MOMENTUM', `${mint.slice(0,8)}... — no price data, skipping`);
    return { pass: false, reason: 'no_price' };
  }

  log('MOMENTUM', `${mint.slice(0,8)}... price1: $${price1.toFixed(10)} — waiting ${CONFIG.MOMENTUM_DELAY_MS/1000}s...`);
  await sleep(CONFIG.MOMENTUM_DELAY_MS);

  const price2 = await getTokenPrice(mint);
  if(!price2 || price2 <= 0) {
    return { pass: false, reason: 'price_disappeared' };
  }

  const changePct = ((price2 - price1) / price1) * 100;

  if(changePct > CONFIG.MIN_MOMENTUM_PCT) {
    log('MOMENTUM', `✅ ${mint.slice(0,8)}... PASS: $${price1.toFixed(10)} → $${price2.toFixed(10)} (+${changePct.toFixed(2)}%)`);
    return { pass: true, changePct, price1, price2 };
  } else {
    log('MOMENTUM', `❌ ${mint.slice(0,8)}... FAIL: $${price1.toFixed(10)} → $${price2.toFixed(10)} (${changePct.toFixed(2)}%)`);
    return { pass: false, changePct, price1, price2, reason: 'no_momentum' };
  }
}

// ============================================================
// HELIUS PARSER
// ============================================================
async function parseHelius(sigs) {
  try{const r=await fetch(CONFIG.HELIUS_TX_API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transactions:sigs})});
    if(!r.ok)return[];return await r.json()||[];}catch(e){return[];}
}

function extractTrade(tx) {
  if(tx.transactionError) return null;
  const w=CONFIG.TARGET_WALLET;
  const transfers=tx.tokenTransfers||[];
  const native=tx.nativeTransfers||[];
  const desc=(tx.description||'').toLowerCase();

  let solOut=0,solIn=0;
  for(const t of native){
    if(t.fromUserAccount===w)solOut+=(t.amount||0)/1e9;
    if(t.toUserAccount===w)solIn+=(t.amount||0)/1e9;
  }

  const buying=[],selling=[];
  for(const t of transfers){
    if(STABLES.has(t.mint)||t.mint===CONFIG.SOL_MINT)continue;
    if(t.toUserAccount===w&&t.tokenAmount>0)buying.push({mint:t.mint,amount:t.tokenAmount});
    if(t.fromUserAccount===w&&t.tokenAmount>0)selling.push({mint:t.mint,amount:t.tokenAmount});
  }

  // Fallback for OkxDex/aggregator routing
  if(buying.length===0&&selling.length===0&&transfers.length>0){
    const mints=new Set();
    for(const t of transfers){if(!STABLES.has(t.mint)&&t.mint!==CONFIG.SOL_MINT&&t.tokenAmount>0)mints.add(t.mint);}
    for(const mint of mints){
      if(tx.type!=='SWAP'&&!desc.includes('swap'))continue;
      if(solOut>0.001)buying.push({mint,amount:transfers.find(t=>t.mint===mint)?.tokenAmount||0});
      else if(solIn>0.001)selling.push({mint,amount:transfers.find(t=>t.mint===mint)?.tokenAmount||0});
      break;
    }
  }

  const trades=[];
  for(const b of buying)trades.push({tokenMint:b.mint,direction:'buy',solAmount:solOut||0.001,tokenAmount:b.amount,signature:tx.signature,timestamp:tx.timestamp,source:tx.source||'UNKNOWN'});
  for(const s of selling)trades.push({tokenMint:s.mint,direction:'sell',solAmount:solIn||0.001,tokenAmount:s.amount,signature:tx.signature,timestamp:tx.timestamp,source:tx.source||'UNKNOWN'});
  return trades.length>0?trades:null;
}

// ============================================================
// EXECUTION
// ============================================================
async function executeBuy(mint, sol, momentum) {
  const info=await getTokenInfo(mint);
  const lamports=Math.floor(sol*1e9);
  log('EXEC',`🛒 BUY ${info.symbol} (${mint.slice(0,12)}...) ${sol.toFixed(4)} SOL`);

  try{
    const qr=await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${CONFIG.SOL_MINT}&outputMint=${mint}&amount=${lamports}&slippageBps=${CONFIG.MAX_SLIPPAGE_BPS}`);
    if(!qr.ok){log('ERROR',`Quote ${qr.status}`);state.stats.errors++;return false;}
    const q=await qr.json();
    if(!q.outAmount||q.outAmount==='0'){log('ERROR','No route');state.stats.errors++;return false;}

    const sr=await fetch(CONFIG.JUPITER_SWAP,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({quoteResponse:q,userPublicKey:state.wallet.publicKey.toString(),wrapAndUnwrapSol:true,
        dynamicSlippage:{minBps:50,maxBps:CONFIG.MAX_SLIPPAGE_BPS},prioritizationFeeLamports:CONFIG.PRIORITY_FEE_LAMPORTS})});
    if(!sr.ok){log('ERROR',`Swap ${sr.status}`);state.stats.errors++;return false;}
    const sd=await sr.json();
    if(!sd.swapTransaction){log('ERROR','No tx');state.stats.errors++;return false;}

    const buf=Buffer.from(sd.swapTransaction,'base64');
    const tx=VersionedTransaction.deserialize(buf);
    tx.sign([state.wallet]);
    const sig=await state.connection.sendRawTransaction(tx.serialize(),{skipPreflight:true,maxRetries:3});

    if(await confirmTx(sig)){
      const price=await getTokenPrice(mint);
      state.positions.set(mint,{entryTime:Date.now(),entrySolAmount:sol,symbol:info.symbol,entryPrice:price||0,peakPrice:price||0,soldPct:0});
      state.stats.trades++;state.stats.buys++;
      const msg=`🪞📈 **MOMENTUM BUY** #${state.stats.buys}\n`+
        `**${info.name}** (${info.symbol})\n`+
        `**Mint:** \`${mint}\`\n`+
        `**Amount:** ${sol.toFixed(4)} SOL (~$5)\n`+
        `**Price:** $${price?price.toFixed(10):'?'}\n`+
        `**Momentum:** +${momentum.changePct.toFixed(2)}% in ${CONFIG.MOMENTUM_DELAY_MS/1000}s\n`+
        `**Auto-sell:** ${CONFIG.MAX_HOLD_MINUTES}min\n`+
        `**Tx:** https://solscan.io/tx/${sig}`;
      log('BUY',`✅ ${info.symbol} ${sol.toFixed(4)} SOL | momentum +${momentum.changePct.toFixed(2)}%`);
      await discord(msg);
      return true;
    }else{log('ERROR','TX fail');state.stats.errors++;return false;}
  }catch(e){log('ERROR','Buy err',{error:e.message});state.stats.errors++;return false;}
}

async function executeSell(mint, pct, reason) {
  const info=await getTokenInfo(mint);
  const pos=state.positions.get(mint);
  const remainPct = pos ? (100 - pos.soldPct) : 100;
  const actualPct = Math.min(pct, remainPct);
  if(actualPct <= 0){state.positions.delete(mint);return false;}

  log('EXEC',`🚪 SELL ${actualPct}% of ${info.symbol} (${mint.slice(0,12)}...) — ${reason}`);

  try{
    const accts=await state.connection.getParsedTokenAccountsByOwner(state.wallet.publicKey,{mint:new PublicKey(mint)});
    const acct=accts?.value?.[0];
    if(!acct){state.positions.delete(mint);return false;}
    const bal=parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount||0);
    if(bal<=0){state.positions.delete(mint);return false;}
    const dec=acct.account.data.parsed.info.tokenAmount.decimals;
    const sellBal = bal * (actualPct / 100);
    const raw=BigInt(Math.floor(sellBal*Math.pow(10,dec)));
    if(raw<=0n){state.positions.delete(mint);return false;}

    const qr=await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL_MINT}&amount=${raw.toString()}&slippageBps=${CONFIG.MAX_SLIPPAGE_BPS}`);
    if(!qr.ok){log('ERROR',`Sell quote ${qr.status}`);state.stats.errors++;return false;}
    const q=await qr.json();
    if(!q.outAmount){log('ERROR','No sell route');state.stats.errors++;return false;}

    const sr=await fetch(CONFIG.JUPITER_SWAP,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({quoteResponse:q,userPublicKey:state.wallet.publicKey.toString(),wrapAndUnwrapSol:true,
        dynamicSlippage:{minBps:50,maxBps:CONFIG.MAX_SLIPPAGE_BPS},prioritizationFeeLamports:CONFIG.PRIORITY_FEE_LAMPORTS})});
    if(!sr.ok){log('ERROR',`Sell swap ${sr.status}`);state.stats.errors++;return false;}
    const sd=await sr.json();
    if(!sd.swapTransaction){state.stats.errors++;return false;}

    const buf=Buffer.from(sd.swapTransaction,'base64');
    const tx=VersionedTransaction.deserialize(buf);
    tx.sign([state.wallet]);
    const sig=await state.connection.sendRawTransaction(tx.serialize(),{skipPreflight:true,maxRetries:3});

    if(await confirmTx(sig)){
      const solBack=parseFloat(q.outAmount)/1e9;
      const pnlPortion = pos?.entrySolAmount ? (solBack - (pos.entrySolAmount * actualPct / 100)) : 0;
      state.stats.totalPnlSol += pnlPortion;
      state.stats.trades++; state.stats.sells++;

      if(pos) pos.soldPct += actualPct;
      if(!pos || pos.soldPct >= 100) {
        state.positions.delete(mint);
      }

      const msg=`🪞🚪 **SELL ${actualPct}%** #${state.stats.sells}\n`+
        `**${info.name}** (${info.symbol})\n`+
        `**Mint:** \`${mint}\`\n`+
        `**Back:** ${solBack.toFixed(4)} SOL | **PnL:** ${pnlPortion>=0?'+':''}${pnlPortion.toFixed(4)} SOL\n`+
        `**Reason:** ${reason}\n`+
        `**Tx:** https://solscan.io/tx/${sig}`;
      log('SELL',`✅ ${info.symbol} ${actualPct}% → ${solBack.toFixed(4)} SOL (${pnlPortion>=0?'+':''}${pnlPortion.toFixed(4)})`);
      await discord(msg);
      return true;
    }else{log('ERROR','Sell TX fail');state.stats.errors++;return false;}
  }catch(e){log('ERROR','Sell err',{error:e.message});state.stats.errors++;return false;}
}

async function confirmTx(sig,timeout=60000){
  const s=Date.now();while(Date.now()-s<timeout){
    try{const r=await state.connection.getSignatureStatuses([sig]);const v=r?.value?.[0];
      if(v?.err)return false;if(v?.confirmationStatus==='confirmed'||v?.confirmationStatus==='finalized')return true;}catch(e){}
    await sleep(2000);}return false;
}

// ============================================================
// SMART EXIT MANAGER
// Checks every 5s:
//   1. Stop loss (-12%) → sell 100%
//   2. TP1 (+15%) → sell 40%
//   3. TP2 (+30%) → sell 30%
//   4. TP3 (+50%) → sell remaining
//   5. Trailing stop: once up 10%, if drops 8% from peak → sell all
//   6. Time limit: 15min → sell all remaining
// ============================================================
async function exitManager() {
  log('INFO', '🎯 Exit manager started — checking every 5s');
  while(state.isRunning) {
    await sleep(CONFIG.EXIT_CHECK_MS);

    for(const [mint, pos] of state.positions) {
      if(!pos.entryPrice || pos.entryPrice <= 0) continue;

      const price = await getTokenPrice(mint);
      if(!price || price <= 0) continue;

      const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
      const ageMin = (Date.now() - pos.entryTime) / 60000;

      // Update peak price for trailing stop
      if(price > pos.peakPrice) pos.peakPrice = price;

      // --- 1. STOP LOSS ---
      if(pnlPct <= CONFIG.STOP_LOSS_PCT) {
        log('SELL', `⛔ STOP LOSS ${pos.symbol} at ${pnlPct.toFixed(1)}%`);
        await executeSell(mint, 100, `stop_loss_${pnlPct.toFixed(1)}%`);
        await sleep(300);
        continue;
      }

      // --- 2. TAKE PROFIT LADDER ---
      if(pnlPct >= CONFIG.TP3_PCT && pos.soldPct < 100) {
        log('SELL', `🎯 TP3 ${pos.symbol} at +${pnlPct.toFixed(1)}% — selling remaining`);
        await executeSell(mint, 100, `tp3_+${pnlPct.toFixed(1)}%`);
        await sleep(300);
        continue;
      }
      if(pnlPct >= CONFIG.TP2_PCT && pos.soldPct < (CONFIG.TP1_SELL + CONFIG.TP2_SELL)) {
        log('SELL', `🎯 TP2 ${pos.symbol} at +${pnlPct.toFixed(1)}% — selling ${CONFIG.TP2_SELL}%`);
        await executeSell(mint, CONFIG.TP2_SELL, `tp2_+${pnlPct.toFixed(1)}%`);
        await sleep(300);
        continue;
      }
      if(pnlPct >= CONFIG.TP1_PCT && pos.soldPct < CONFIG.TP1_SELL) {
        log('SELL', `🎯 TP1 ${pos.symbol} at +${pnlPct.toFixed(1)}% — selling ${CONFIG.TP1_SELL}%`);
        await executeSell(mint, CONFIG.TP1_SELL, `tp1_+${pnlPct.toFixed(1)}%`);
        await sleep(300);
        continue;
      }

      // --- 3. TRAILING STOP ---
      if(pos.peakPrice > 0 && pnlPct >= CONFIG.TRAILING_ACTIVATE_PCT) {
        const dropFromPeak = ((pos.peakPrice - price) / pos.peakPrice) * 100;
        if(dropFromPeak >= CONFIG.TRAILING_DROP_PCT) {
          log('SELL', `📉 TRAILING STOP ${pos.symbol} — peak $${pos.peakPrice.toFixed(10)}, dropped ${dropFromPeak.toFixed(1)}%`);
          await executeSell(mint, 100, `trailing_stop_-${dropFromPeak.toFixed(1)}%_from_peak`);
          await sleep(300);
          continue;
        }
      }

      // --- 4. TIME LIMIT ---
      if(ageMin >= CONFIG.MAX_HOLD_MINUTES) {
        log('SELL', `⏰ TIME LIMIT ${pos.symbol} — held ${ageMin.toFixed(0)}min`);
        await executeSell(mint, 100, `time_limit_${ageMin.toFixed(0)}min`);
        await sleep(300);
        continue;
      }
    }
  }
}

// ============================================================
// POLL + MOMENTUM FILTER
// ============================================================
async function pollTarget() {
  log('INFO',`👀 Watching ${CONFIG.TARGET_WALLET.slice(0,12)}... | Momentum filter ON`);
  let cycle=0;

  while(state.isRunning) {
    cycle++;
    try{
      const r=await fetch(CONFIG.HELIUS_RPC,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getSignaturesForAddress',params:[CONFIG.TARGET_WALLET,{limit:5}]})});
      const d=await r.json();
      const sigs=d?.result||[];
      const newSigs=[];
      for(const s of sigs){if(s.signature===state.lastSig)break;if(!s.err)newSigs.push(s);}

      if(newSigs.length>0){
        state.lastSig=newSigs[0].signature;
        log('MIRROR',`🔍 ${newSigs.length} new tx(s)`);
        const parsed=await parseHelius(newSigs.map(s=>s.signature));

        for(const tx of parsed){
          const trades=extractTrade(tx);
          if(!trades)continue;

          // Sells first — if he sells something we hold, dump it
          for(const trade of trades.filter(t=>t.direction==='sell')){
            if(state.positions.has(trade.tokenMint)){
              log('MIRROR',`🎯 Target SOLD ${trade.tokenMint.slice(0,8)}... — mirroring exit`);
              await executeSell(trade.tokenMint, 100, 'target_sold');
              await sleep(300);
            }
          }

          // Buys — only with momentum
          for(const trade of trades.filter(t=>t.direction==='buy')){
            const mint=trade.tokenMint;

            // Skip if full
            if(state.positions.size>=CONFIG.MAX_POSITIONS){state.stats.skipped++;continue;}
            // Skip if already holding
            if(state.positions.has(mint))continue;
            // Skip if we just checked this mint in last 30s
            const lastCheck=state.recentlyChecked.get(mint)||0;
            if(Date.now()-lastCheck<30000)continue;
            state.recentlyChecked.set(mint,Date.now());

            // Check balance
            const bal=await getSOLBalance();
            if(bal<CONFIG.TRADE_AMOUNT_SOL+0.003){
              log('WARN',`Balance low (${bal.toFixed(4)}) — waiting`);
              break; // Stop trying buys this cycle
            }

            // MOMENTUM CHECK
            log('MOMENTUM',`🔎 Checking momentum for ${mint.slice(0,8)}...`);
            const m=await hasMomentum(mint);

            if(m.pass){
              const size=Math.min(CONFIG.TRADE_AMOUNT_SOL, bal-0.003);
              await executeBuy(mint, size, m);
              await sleep(300);
            }else{
              state.stats.momentumFails++;
              const info=await getTokenInfo(mint);
              log('MOMENTUM',`⏭️ Skip ${info.symbol} (${mint.slice(0,8)}...) — ${m.reason||'no momentum'}`);
              // Only Discord-notify momentum fails, not "no price" (reduces spam)
              if(m.reason !== 'no_price' && m.reason !== 'price_disappeared') {
                await discord(`⏭️ **SKIP** ${info.name} (${info.symbol})\n**Mint:** \`${mint}\`\n**Momentum:** ${m.changePct?.toFixed(2)||'?'}% — not enough`);
              }
            }
          }
        }
      }

      if(cycle%15===0){
        log('INFO',`📊 #${cycle} | ${state.positions.size}/${CONFIG.MAX_POSITIONS} pos | ${state.stats.buys}B ${state.stats.sells}S | ${state.stats.momentumFails} momentum fails | ${state.stats.errors}E`);
      }
    }catch(e){log('ERROR','Poll err',{error:e.message});}
    await sleep(CONFIG.POLL_INTERVAL_MS);

    // Clean old recentlyChecked entries
    for(const [m,t] of state.recentlyChecked){if(Date.now()-t>60000)state.recentlyChecked.delete(m);}
  }
}

// ============================================================
// HEALTH
// ============================================================
async function healthLoop(){
  while(state.isRunning){
    const bal=await getSOLBalance();const sp=await getTokenPrice(CONFIG.SOL_MINT);
    const pnl=bal-state.stats.startBalance;
    console.log('\n'+'═'.repeat(55));
    console.log('  🪞📈 WINSTON v10.2 — Momentum Mirror');
    console.log('═'.repeat(55));
    console.log(`  🎯 ${CONFIG.TARGET_WALLET.slice(0,16)}...`);
    console.log(`  💰 ${bal.toFixed(4)} SOL ($${(bal*sp).toFixed(2)}) | PnL: ${pnl>=0?'+':''}${pnl.toFixed(4)}`);
    console.log(`  🛒 ${state.stats.buys}B 🚪 ${state.stats.sells}S ❌ ${state.stats.errors}E 📈 ${state.stats.momentumFails} mom-fails`);
    console.log(`  📦 ${state.positions.size}/${CONFIG.MAX_POSITIONS} | ⏰ ${CONFIG.MAX_HOLD_MINUTES}min auto-sell`);
    for(const[m,p]of state.positions){
      const age=((Date.now()-p.entryTime)/60000).toFixed(1);
      const pr=await getTokenPrice(m);const ep=p.entryPrice||0;
      const pnlPct=pr&&ep?((pr-ep)/ep*100).toFixed(1):'?';
      console.log(`     ${p.symbol||'???'} ${m.slice(0,8)}... | ${age}m | ${pnlPct}%`);
    }
    console.log('═'.repeat(55)+'\n');
    await sleep(CONFIG.HEALTH_LOG_INTERVAL_MS);
  }
}

// ============================================================
// MAIN
// ============================================================
async function main(){
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  🪞📈 WINSTON v10.2 — Momentum Filter Mirror Bot          ║');
  console.log('║  $5 Trades • Momentum Only • 3 Max • 5min Auto-Sell       ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  if(!CONFIG.HELIUS_API_KEY){log('ERROR','HELIUS_API_KEY required');process.exit(1);}
  if(!CONFIG.PRIVATE_KEY){log('ERROR','WALLET_PRIVATE_KEY required');process.exit(1);}

  try{state.wallet=Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));}
  catch(e){log('ERROR','Bad key');process.exit(1);}
  log('INFO',`Wallet: ${state.wallet.publicKey}`);

  state.connection=new Connection(CONFIG.HELIUS_RPC,{commitment:'confirmed'});
  state.stats.startBalance=await getSOLBalance();
  const sp=await getTokenPrice(CONFIG.SOL_MINT);
  log('INFO',`Balance: ${state.stats.startBalance.toFixed(4)} SOL ($${(state.stats.startBalance*sp).toFixed(2)})`);

  try{const r=await fetch(CONFIG.HELIUS_RPC,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getSignaturesForAddress',params:[CONFIG.TARGET_WALLET,{limit:1}]})});
    const d=await r.json();state.lastSig=d?.result?.[0]?.signature||null;
  }catch(e){log('ERROR','Init fail');process.exit(1);}

  state.isRunning=true;
  log('INFO',`📈 Momentum filter: ${CONFIG.MOMENTUM_DELAY_MS/1000}s check, need >0% gain`);
  log('INFO',`💵 Fixed $5 trades (${CONFIG.TRADE_AMOUNT_SOL} SOL) | Max ${CONFIG.MAX_POSITIONS} positions`);
  log('INFO',`🎯 Exit: SL ${CONFIG.STOP_LOSS_PCT}% | TP1 +${CONFIG.TP1_PCT}% (${CONFIG.TP1_SELL}%) | TP2 +${CONFIG.TP2_PCT}% (${CONFIG.TP2_SELL}%) | TP3 +${CONFIG.TP3_PCT}% (rest)`);
  log('INFO',`📉 Trailing: activate +${CONFIG.TRAILING_ACTIVATE_PCT}%, drop ${CONFIG.TRAILING_DROP_PCT}% from peak → sell`);
  log('INFO',`⏰ Max hold: ${CONFIG.MAX_HOLD_MINUTES}min`);

  await discord(`🪞📈 **Winston v10.2 LIVE**\n`+
    `Target: \`${CONFIG.TARGET_WALLET}\`\n`+
    `Balance: ${state.stats.startBalance.toFixed(4)} SOL\n`+
    `$5 trades | Momentum filter | Max ${CONFIG.MAX_POSITIONS} pos\n`+
    `**Exit:** SL ${CONFIG.STOP_LOSS_PCT}% | TP +${CONFIG.TP1_PCT}%/${CONFIG.TP2_PCT}%/${CONFIG.TP3_PCT}% | Trail ${CONFIG.TRAILING_DROP_PCT}% | Max ${CONFIG.MAX_HOLD_MINUTES}min`);

  const shutdown=async()=>{
    state.isRunning=false;const f=await getSOLBalance();const p=f-state.stats.startBalance;
    await discord(`🛑 **Offline** | ${f.toFixed(4)} SOL | PnL: ${p>=0?'+':''}${p.toFixed(4)} | ${state.stats.buys}B ${state.stats.sells}S ${state.stats.momentumFails}MF`);
    process.exit(0);};
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);

  await Promise.all([pollTarget(),exitManager(),healthLoop()]);
}

main().catch(e=>{log('ERROR','Fatal',{error:e.message});process.exit(1);});
