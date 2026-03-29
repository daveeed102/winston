// ============================================================
// WINSTON v10 — Single Wallet Mirror Bot
// ============================================================
// Mirrors EVERY trade from one proven trader automatically.
// When he buys → we buy. When he sells → we sell.
// Uses Helius Enhanced TX API (catches all DEXes).
// Proportional position sizing based on wallet ratio.
// ============================================================

require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  get HELIUS_RPC() { return `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },
  get HELIUS_TX_API() { return `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${this.HELIUS_API_KEY}`; },
  PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || '',
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || '',

  // Jupiter
  JUPITER_QUOTE: 'https://lite-api.jup.ag/swap/v1/quote',
  JUPITER_SWAP: 'https://lite-api.jup.ag/swap/v1/swap',
  JUPITER_PRICE: 'https://lite-api.jup.ag/price/v2',

  // The ONE trader we mirror
  TARGET_WALLET: 'ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn',

  // His total value ~$1818, our total ~$25
  // We scale every trade proportionally
  // He bets $100 → we bet ~$1.38
  // But we set a minimum of $2 and max of 50% of our balance per trade
  // so we don't get stuck on dust trades or blow the whole wallet
  TARGET_TOTAL_VALUE_USD: 1818,
  OUR_TOTAL_VALUE_USD: 25,
  MIN_TRADE_PCT: 0.08,     // Minimum 8% of our balance per trade (~$2)
  MAX_TRADE_PCT: 0.50,     // Maximum 50% of our balance per trade
  PROPORTIONAL_BOOST: 1.5, // Boost our ratio slightly to be more aggressive

  // Execution
  MAX_SLIPPAGE_BPS: 250,          // 2.5% slippage (needs to be fast)
  PRIORITY_FEE_LAMPORTS: 200000,  // 0.0002 SOL priority (speed matters)

  // Polling — as fast as possible without getting rate limited
  POLL_INTERVAL_MS: 2000,         // Check every 2 seconds
  HEALTH_LOG_INTERVAL_MS: 120000, // Health every 2 min

  // Constants
  SOL_MINT: 'So11111111111111111111111111111111111111112',
};

const STABLES = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

// ============================================================
// STATE
// ============================================================
const state = {
  wallet: null,
  connection: null,
  lastSig: null,
  isRunning: false,
  positions: new Map(),  // mint -> { entryTime, entrySolAmount }
  stats: {
    trades: 0,
    buys: 0,
    sells: 0,
    totalPnlSol: 0,
    startBalance: 0,
    errors: 0,
  },
};

// ============================================================
// UTILITIES
// ============================================================
function log(level, msg, data = {}) {
  const ts = new Date().toISOString();
  const icons = { INFO:'📡', BUY:'🟢', SELL:'🔴', WARN:'⚠️', ERROR:'❌', EXEC:'⚡', MIRROR:'🪞' };
  const extra = Object.keys(data).length ? ' ' + JSON.stringify(data) : '';
  console.log(`[${ts}] ${icons[level]||'📋'} [${level}] ${msg}${extra}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getSOLBalance() {
  try { return (await state.connection.getBalance(state.wallet.publicKey)) / 1e9; }
  catch(e) { return 0; }
}

async function getTokenPrice(mint) {
  try {
    const r = await fetch(`${CONFIG.JUPITER_PRICE}?ids=${mint}`);
    if (!r.ok) return 0;
    const d = await r.json();
    return parseFloat(d?.data?.[mint]?.price || 0);
  } catch(e) { return 0; }
}

async function getTokenInfo(mint) {
  try {
    const r = await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mint}`);
    if (r.ok) { const d = await r.json(); return { name: d.name||'Unknown', symbol: d.symbol||'???' }; }
  } catch(e) {}
  return { name: 'Unknown', symbol: '???' };
}

async function discord(msg) {
  if (!CONFIG.DISCORD_WEBHOOK) return;
  try {
    const t = msg.length > 1990 ? msg.slice(0, 1990) + '...' : msg;
    await fetch(CONFIG.DISCORD_WEBHOOK, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ content: t }) });
  } catch(e) {}
}

// ============================================================
// POSITION SIZING — Proportional to the target trader
// ============================================================
function calculateTradeSize(targetSolAmount, ourBalance) {
  // What % of his portfolio did he use?
  // His SOL balance is ~8.37 SOL, total ~$1818
  // We scale proportionally with a small boost
  const ratio = (CONFIG.OUR_TOTAL_VALUE_USD / CONFIG.TARGET_TOTAL_VALUE_USD) * CONFIG.PROPORTIONAL_BOOST;
  let ourAmount = targetSolAmount * ratio;

  // Apply min/max bounds
  const minAmount = ourBalance * CONFIG.MIN_TRADE_PCT;
  const maxAmount = ourBalance * CONFIG.MAX_TRADE_PCT;

  ourAmount = Math.max(ourAmount, minAmount);
  ourAmount = Math.min(ourAmount, maxAmount);

  // Never trade more than we have (leave 0.005 SOL for fees)
  ourAmount = Math.min(ourAmount, ourBalance - 0.005);

  if (ourAmount < 0.003) return 0; // Dust guard

  return ourAmount;
}

// ============================================================
// HELIUS ENHANCED TX PARSER
// ============================================================
async function parseWithHelius(signatures) {
  try {
    const res = await fetch(CONFIG.HELIUS_TX_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: signatures }),
    });
    if (!res.ok) { log('WARN', `Helius API ${res.status}`); return []; }
    return await res.json() || [];
  } catch(e) { log('ERROR', 'Helius parse fail', { error: e.message }); return []; }
}

function extractTrade(tx) {
  if (tx.transactionError) return null;

  const walletAddr = CONFIG.TARGET_WALLET;
  const transfers = tx.tokenTransfers || [];
  const nativeTransfers = tx.nativeTransfers || [];

  let solSpent = 0, solReceived = 0;
  let tokenMint = null, tokenAmount = 0, direction = null;

  for (const t of nativeTransfers) {
    if (t.fromUserAccount === walletAddr) solSpent += (t.amount || 0) / 1e9;
    if (t.toUserAccount === walletAddr) solReceived += (t.amount || 0) / 1e9;
  }

  for (const t of transfers) {
    if (STABLES.has(t.mint) || t.mint === CONFIG.SOL_MINT) continue;
    if (t.toUserAccount === walletAddr && t.tokenAmount > 0) {
      tokenMint = t.mint; tokenAmount = t.tokenAmount; direction = 'buy';
    } else if (t.fromUserAccount === walletAddr && t.tokenAmount > 0) {
      tokenMint = t.mint; tokenAmount = t.tokenAmount; direction = 'sell';
    }
  }

  if (!tokenMint || !direction) return null;

  return {
    tokenMint, direction,
    solAmount: (direction === 'buy' ? solSpent : solReceived) || 0.001,
    tokenAmount, signature: tx.signature, timestamp: tx.timestamp,
    source: tx.source || 'UNKNOWN', txType: tx.type || 'UNKNOWN',
    description: tx.description || '',
  };
}

// ============================================================
// EXECUTION ENGINE
// ============================================================
async function executeBuy(tokenMint, solAmount, trade) {
  const tokenInfo = await getTokenInfo(tokenMint);
  const lamports = Math.floor(solAmount * 1e9);

  log('EXEC', `🛒 BUYING ${tokenInfo.symbol} (${tokenMint.slice(0,12)}...) for ${solAmount.toFixed(4)} SOL`);

  try {
    // Get quote
    const quoteUrl = `${CONFIG.JUPITER_QUOTE}?inputMint=${CONFIG.SOL_MINT}&outputMint=${tokenMint}&amount=${lamports}&slippageBps=${CONFIG.MAX_SLIPPAGE_BPS}`;
    const quoteRes = await fetch(quoteUrl);
    if (!quoteRes.ok) {
      log('ERROR', `Quote failed: ${quoteRes.status}`);
      await discord(`❌ Quote failed for ${tokenInfo.symbol} (\`${tokenMint}\`)`);
      return false;
    }
    const quote = await quoteRes.json();
    if (!quote.outAmount || quote.outAmount === '0') {
      log('ERROR', 'No route/liquidity');
      await discord(`❌ No route for ${tokenInfo.symbol} (\`${tokenMint}\`)`);
      return false;
    }

    // Swap
    const swapRes = await fetch(CONFIG.JUPITER_SWAP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: state.wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicSlippage: { minBps: 50, maxBps: CONFIG.MAX_SLIPPAGE_BPS },
        prioritizationFeeLamports: CONFIG.PRIORITY_FEE_LAMPORTS,
      }),
    });
    if (!swapRes.ok) { log('ERROR', `Swap req failed: ${swapRes.status}`); state.stats.errors++; return false; }
    const swapData = await swapRes.json();
    if (!swapData.swapTransaction) { log('ERROR', 'No swap tx'); state.stats.errors++; return false; }

    // Sign & send
    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([state.wallet]);
    const sig = await state.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    log('EXEC', `📤 TX sent: ${sig}`);

    // Confirm
    const confirmed = await confirmTx(sig);
    if (confirmed) {
      state.positions.set(tokenMint, { entryTime: Date.now(), entrySolAmount: solAmount });
      state.stats.trades++;
      state.stats.buys++;

      const price = await getTokenPrice(tokenMint);
      const msg = `🪞 **MIRROR BUY** #${state.stats.buys}\n` +
        `**Token:** ${tokenInfo.name} (${tokenInfo.symbol})\n` +
        `**Mint:** \`${tokenMint}\`\n` +
        `**Amount:** ${solAmount.toFixed(4)} SOL\n` +
        `**Price:** $${price ? price.toFixed(8) : 'N/A'}\n` +
        `**Target spent:** ${trade.solAmount.toFixed(4)} SOL\n` +
        `**Via:** ${trade.source}\n` +
        `**Tx:** https://solscan.io/tx/${sig}`;
      log('BUY', msg);
      await discord(msg);
      return true;
    } else {
      log('ERROR', `TX failed to confirm: ${sig}`);
      state.stats.errors++;
      await discord(`❌ Buy TX failed to confirm for ${tokenInfo.symbol} (\`${tokenMint}\`)`);
      return false;
    }
  } catch(e) {
    log('ERROR', 'Buy failed', { error: e.message });
    state.stats.errors++;
    return false;
  }
}

async function executeSell(tokenMint, trade) {
  const tokenInfo = await getTokenInfo(tokenMint);

  log('EXEC', `🚪 SELLING ${tokenInfo.symbol} (${tokenMint.slice(0,12)}...)`);

  try {
    // Get our token balance
    const accts = await state.connection.getParsedTokenAccountsByOwner(
      state.wallet.publicKey, { mint: new PublicKey(tokenMint) }
    );
    const acct = accts?.value?.[0];
    if (!acct) {
      log('WARN', `No token account for ${tokenMint.slice(0,8)}... — nothing to sell`);
      state.positions.delete(tokenMint);
      return false;
    }

    const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount || 0);
    if (bal <= 0) {
      log('WARN', 'Zero balance — clearing position');
      state.positions.delete(tokenMint);
      return false;
    }

    const dec = acct.account.data.parsed.info.tokenAmount.decimals;
    // Sell 100% — mirror his exit completely
    const sellAmtRaw = BigInt(Math.floor(bal * Math.pow(10, dec)));
    if (sellAmtRaw <= 0n) { state.positions.delete(tokenMint); return false; }

    // Quote
    const quoteUrl = `${CONFIG.JUPITER_QUOTE}?inputMint=${tokenMint}&outputMint=${CONFIG.SOL_MINT}&amount=${sellAmtRaw.toString()}&slippageBps=${CONFIG.MAX_SLIPPAGE_BPS}`;
    const quoteRes = await fetch(quoteUrl);
    if (!quoteRes.ok) { log('ERROR', `Sell quote failed: ${quoteRes.status}`); return false; }
    const quote = await quoteRes.json();
    if (!quote.outAmount) { log('ERROR', 'No sell route'); return false; }

    // Swap
    const swapRes = await fetch(CONFIG.JUPITER_SWAP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: state.wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicSlippage: { minBps: 50, maxBps: CONFIG.MAX_SLIPPAGE_BPS },
        prioritizationFeeLamports: CONFIG.PRIORITY_FEE_LAMPORTS,
      }),
    });
    if (!swapRes.ok) { log('ERROR', `Sell swap failed: ${swapRes.status}`); return false; }
    const swapData = await swapRes.json();

    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([state.wallet]);
    const sig = await state.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    log('EXEC', `📤 Sell TX: ${sig}`);

    const confirmed = await confirmTx(sig);
    if (confirmed) {
      const solBack = parseFloat(quote.outAmount) / 1e9;
      const entry = state.positions.get(tokenMint);
      const pnlSol = entry ? (solBack - entry.entrySolAmount) : 0;
      state.stats.totalPnlSol += pnlSol;
      state.stats.trades++;
      state.stats.sells++;
      state.positions.delete(tokenMint);

      const msg = `🪞 **MIRROR SELL** #${state.stats.sells}\n` +
        `**Token:** ${tokenInfo.name} (${tokenInfo.symbol})\n` +
        `**Mint:** \`${tokenMint}\`\n` +
        `**Got back:** ${solBack.toFixed(4)} SOL\n` +
        `**PnL:** ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL\n` +
        `**Tx:** https://solscan.io/tx/${sig}`;
      log('SELL', msg);
      await discord(msg);
      return true;
    } else {
      log('ERROR', 'Sell TX failed to confirm');
      state.stats.errors++;
      return false;
    }
  } catch(e) {
    log('ERROR', 'Sell failed', { error: e.message });
    state.stats.errors++;
    return false;
  }
}

async function confirmTx(sig, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const s = await state.connection.getSignatureStatuses([sig]);
      const r = s?.value?.[0];
      if (r?.err) return false;
      if (r?.confirmationStatus === 'confirmed' || r?.confirmationStatus === 'finalized') return true;
    } catch(e) {}
    await sleep(2000);
  }
  return false;
}

// ============================================================
// CORE POLLING LOOP — Watch target wallet, mirror instantly
// ============================================================
async function pollTarget() {
  log('INFO', `👀 Watching ${CONFIG.TARGET_WALLET.slice(0,12)}... every ${CONFIG.POLL_INTERVAL_MS/1000}s`);
  let cycle = 0;

  while (state.isRunning) {
    cycle++;
    try {
      // Get latest signatures
      const r = await fetch(CONFIG.HELIUS_RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'getSignaturesForAddress',
          params: [CONFIG.TARGET_WALLET, { limit: 5 }] }),
      });
      const d = await r.json();
      const sigs = d?.result || [];

      // Find new transactions
      const newSigs = [];
      for (const s of sigs) {
        if (s.signature === state.lastSig) break;
        if (!s.err) newSigs.push(s);
      }

      if (newSigs.length > 0) {
        state.lastSig = newSigs[0].signature;
        const sigList = newSigs.map(s => s.signature);

        log('MIRROR', `🔍 Target has ${newSigs.length} new tx(s) — parsing...`);

        // Parse with Helius Enhanced API
        const parsed = await parseWithHelius(sigList);

        for (const tx of parsed) {
          const trade = extractTrade(tx);
          if (!trade) {
            const hasTokens = (tx.tokenTransfers || []).length > 0;
            log('INFO', `  ↳ ${tx.signature?.slice(0,12)}... type=${tx.type||'?'}${hasTokens ? ' (tokens but no match)' : ' (no tokens)'}`);
            continue;
          }

          log('MIRROR', `🎯 Target ${trade.direction.toUpperCase()} ${trade.tokenMint.slice(0,8)}... (${trade.solAmount.toFixed(4)} SOL) via ${trade.source}`);

          if (trade.direction === 'buy') {
            const ourBal = await getSOLBalance();
            const tradeSize = calculateTradeSize(trade.solAmount, ourBal);

            if (tradeSize <= 0) {
              log('WARN', `Trade too small or balance too low (bal: ${ourBal.toFixed(4)} SOL)`);
              await discord(`⚠️ Skipped BUY — balance too low (${ourBal.toFixed(4)} SOL)\nTarget bought \`${trade.tokenMint}\``);
              continue;
            }

            log('MIRROR', `Mirroring BUY: target=${trade.solAmount.toFixed(4)} SOL → us=${tradeSize.toFixed(4)} SOL`, {
              balance: ourBal.toFixed(4), pctOfBal: ((tradeSize / ourBal) * 100).toFixed(1) + '%'
            });

            await executeBuy(trade.tokenMint, tradeSize, trade);

          } else if (trade.direction === 'sell') {
            // Check if we hold this token
            if (state.positions.has(trade.tokenMint)) {
              log('MIRROR', `Mirroring SELL for ${trade.tokenMint.slice(0,8)}...`);
              await executeSell(trade.tokenMint, trade);
            } else {
              // We might hold it from a previous session — try to sell anyway
              try {
                const accts = await state.connection.getParsedTokenAccountsByOwner(
                  state.wallet.publicKey, { mint: new PublicKey(trade.tokenMint) }
                );
                const bal = parseFloat(accts?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
                if (bal > 0) {
                  log('MIRROR', `Found ${bal} tokens from previous session — selling`);
                  state.positions.set(trade.tokenMint, { entryTime: 0, entrySolAmount: 0 });
                  await executeSell(trade.tokenMint, trade);
                } else {
                  log('INFO', `Target sold ${trade.tokenMint.slice(0,8)}... but we don't hold it`);
                }
              } catch(e) {
                log('INFO', `Target sold ${trade.tokenMint.slice(0,8)}... but we don't hold it`);
              }
            }
          }

          await sleep(300); // Brief pause between executions
        }
      }

      // Log every 15 cycles (~30s)
      if (cycle % 15 === 0) {
        log('INFO', `📊 Cycle #${cycle} | Watching target | ${state.positions.size} open positions | ${state.stats.trades} trades`);
      }

    } catch(e) {
      log('ERROR', 'Poll error', { error: e.message });
    }

    await sleep(CONFIG.POLL_INTERVAL_MS);
  }
}

// ============================================================
// HEALTH DASHBOARD
// ============================================================
async function healthLoop() {
  while (state.isRunning) {
    const bal = await getSOLBalance();
    const solP = await getTokenPrice(CONFIG.SOL_MINT);
    const usd = (bal * solP).toFixed(2);
    const sessionPnl = bal - state.stats.startBalance;

    console.log('\n' + '═'.repeat(55));
    console.log('  🪞 WINSTON v10 — Mirror Bot');
    console.log('═'.repeat(55));
    console.log(`  🎯 Mirroring: ${CONFIG.TARGET_WALLET.slice(0,16)}...`);
    console.log(`  💰 Balance: ${bal.toFixed(4)} SOL ($${usd})`);
    console.log(`  📊 Session PnL: ${sessionPnl >= 0 ? '+' : ''}${sessionPnl.toFixed(4)} SOL`);
    console.log(`  🛒 Buys: ${state.stats.buys} | 🚪 Sells: ${state.stats.sells} | ❌ Errors: ${state.stats.errors}`);
    console.log(`  📦 Open positions: ${state.positions.size}`);
    if (state.positions.size > 0) {
      for (const [mint, pos] of state.positions) {
        const age = ((Date.now() - pos.entryTime) / 60000).toFixed(0);
        const price = await getTokenPrice(mint);
        const info = await getTokenInfo(mint);
        console.log(`     ${info.symbol} (${mint.slice(0,8)}...) | ${age}m | entry: ${pos.entrySolAmount.toFixed(4)} SOL`);
      }
    }
    console.log('═'.repeat(55) + '\n');
    await sleep(CONFIG.HEALTH_LOG_INTERVAL_MS);
  }
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║     🪞 WINSTON v10 — Single Wallet Mirror Bot             ║');
  console.log('║     Auto-Buy • Auto-Sell • Proportional Sizing            ║');
  console.log('║     Target: ARu4n5...SZn                                  ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  // Validate
  if (!CONFIG.HELIUS_API_KEY) { log('ERROR', 'HELIUS_API_KEY required'); process.exit(1); }
  if (!CONFIG.PRIVATE_KEY) { log('ERROR', 'WALLET_PRIVATE_KEY required'); process.exit(1); }

  // Init wallet
  try {
    state.wallet = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
    log('INFO', `Our wallet: ${state.wallet.publicKey.toString()}`);
  } catch(e) {
    log('ERROR', 'Invalid private key');
    process.exit(1);
  }

  // Init connection
  state.connection = new Connection(CONFIG.HELIUS_RPC, { commitment: 'confirmed' });

  // Check balance
  state.stats.startBalance = await getSOLBalance();
  const solPrice = await getTokenPrice(CONFIG.SOL_MINT);
  const usd = (state.stats.startBalance * solPrice).toFixed(2);
  log('INFO', `Balance: ${state.stats.startBalance.toFixed(4)} SOL ($${usd})`);

  if (state.stats.startBalance < 0.01) {
    log('ERROR', 'Balance too low — need at least 0.01 SOL');
    process.exit(1);
  }

  // Initialize — get target's latest signature so we only mirror NEW trades
  try {
    const r = await fetch(CONFIG.HELIUS_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'getSignaturesForAddress',
        params: [CONFIG.TARGET_WALLET, { limit: 1 }] }),
    });
    const d = await r.json();
    state.lastSig = d?.result?.[0]?.signature || null;
    log('INFO', `Target wallet initialized. Last sig: ${state.lastSig?.slice(0,16)}...`);
  } catch(e) {
    log('ERROR', 'Failed to init target wallet');
    process.exit(1);
  }

  state.isRunning = true;

  // Calculate sizing info
  const ratio = ((CONFIG.OUR_TOTAL_VALUE_USD / CONFIG.TARGET_TOTAL_VALUE_USD) * CONFIG.PROPORTIONAL_BOOST * 100).toFixed(2);
  log('INFO', `📐 Sizing: ${ratio}% of target's trades (boosted ${CONFIG.PROPORTIONAL_BOOST}x)`);
  log('INFO', `📐 Bounds: ${(CONFIG.MIN_TRADE_PCT * 100)}% min — ${(CONFIG.MAX_TRADE_PCT * 100)}% max of our balance`);
  log('INFO', `🚀 LIVE — Mirroring ${CONFIG.TARGET_WALLET.slice(0,16)}...`);

  await discord(
    `🪞 **Winston v10 LIVE**\n` +
    `**Mirroring:** \`${CONFIG.TARGET_WALLET}\`\n` +
    `**Balance:** ${state.stats.startBalance.toFixed(4)} SOL ($${usd})\n` +
    `**Sizing:** ~${ratio}% of target (min ${(CONFIG.MIN_TRADE_PCT*100)}%, max ${(CONFIG.MAX_TRADE_PCT*100)}% of balance)\n` +
    `**Speed:** Checking every ${CONFIG.POLL_INTERVAL_MS/1000}s`
  );

  // Shutdown
  const shutdown = async () => {
    state.isRunning = false;
    const finalBal = await getSOLBalance();
    const pnl = finalBal - state.stats.startBalance;
    log('INFO', `🛑 Shutdown | Final: ${finalBal.toFixed(4)} SOL | PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`);
    await discord(
      `🛑 **Winston v10 Offline**\n` +
      `Final: ${finalBal.toFixed(4)} SOL | PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL\n` +
      `Trades: ${state.stats.buys} buys, ${state.stats.sells} sells, ${state.stats.errors} errors`
    );
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Run
  await Promise.all([pollTarget(), healthLoop()]);
}

main().catch(e => { log('ERROR', 'Fatal', { error: e.message }); process.exit(1); });
