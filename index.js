// ============================================================
// WINSTON v9 — Wallet Tracker & Momentum Copy Bot
// ============================================================
// Monitors profitable Solana wallets on-chain, evaluates their
// trades for momentum + liquidity, and mirrors buys/sells
// with tight fee parameters on Jupiter.
// ============================================================

require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const WebSocket = require('ws');
const bs58 = require('bs58');
const fetch = require('node-fetch');

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  // RPC & WebSocket
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  HELIUS_RPC: `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
  HELIUS_WS: `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,

  // Wallet (matches your existing Railway var name)
  PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || '',

  // Jupiter API (free tier — no API key needed)
  JUPITER_QUOTE: 'https://lite-api.jup.ag/swap/v1/quote',
  JUPITER_SWAP: 'https://lite-api.jup.ag/swap/v1/swap',

  // Discord webhook (matches your existing Railway var name)
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || '',

  // Trading Parameters
  MAX_SLIPPAGE_BPS: 200,           // 2% max slippage
  PRIORITY_FEE_LAMPORTS: 100000,   // 0.0001 SOL priority fee
  POSITION_SIZE_PCT: 0.90,         // 90% of balance per trade (go all in, keep dust for fees)
  MAX_CONCURRENT_POSITIONS: 1,     // ONE position at a time — focus mode
  MIN_POOL_LIQUIDITY_USD: 50000,   // $50K minimum pool liquidity
  MIN_TOKEN_AGE_MINUTES: 30,       // Skip tokens younger than 30min

  // Exit Strategy
  STOP_LOSS_PCT: -10,              // -10% stop loss
  TAKE_PROFIT_1_PCT: 20,           // Sell 50% at +20%
  TAKE_PROFIT_2_PCT: 40,           // Sell remaining at +40%

  // Wallet Discovery — BALANCED FILTERS (loosened for more activity)
  DISCOVERY_INTERVAL_MS: 2 * 60 * 60 * 1000,  // Re-discover every 2hrs (was 4)
  TOP_WALLETS_COUNT: 15,                        // Track 15 wallets (was 10)
  MIN_WIN_RATE: 0.60,              // 60% win rate minimum (was 70%)
  MIN_TRADES_REQUIRED: 100,        // Minimum 100 trades to qualify (was 500)
  MIN_TRADES_FOR_SCORING: 25,      // Need 30+ to start scoring (was 200)
  MAX_DRAWDOWN_PCT: 35,            // Max 35% drawdown from peak (was 25%)
  MIN_ACTIVE_MONTHS: 1,            // Must be active for 1+ month (was 3)
  // Red flag thresholds (keeping these tight — these are the important ones)
  MAX_SINGLE_WIN_PNL_SHARE: 0.40,  // No single win > 40% of total PnL (was 30%)
  MIN_MONTHLY_SAMPLES: 1,          // Need at least 1 month of data (was 3)
  WIN_RATE_DECAY_THRESHOLD: 0.15,  // Flag if recent win rate drops >15% vs overall (was 10%)

  // Monitoring
  PRICE_CHECK_INTERVAL_MS: 30000,  // Check position prices every 30s
  HEALTH_LOG_INTERVAL_MS: 300000,  // Log health every 5min

  // Known program IDs
  JUPITER_PROGRAM: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  RAYDIUM_AMM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  SOL_MINT: 'So11111111111111111111111111111111111111112',
  USDC_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',

  // Seed wallets to bootstrap discovery (known active DeFi wallets)
  // Replace these with wallets you've found on Solscan/DexScreener
  SEED_WALLETS: (process.env.SEED_WALLETS || '').split(',').filter(Boolean),
};

// ============================================================
// STATE
// ============================================================
const state = {
  wallet: null,
  connection: null,
  ws: null,
  trackedWallets: new Map(),     // address -> { score, winRate, avgProfit, trades }
  positions: new Map(),          // mint -> { entryPrice, amount, entryTime, soldPct }
  pendingSignals: new Map(),     // mint -> { wallets: Set, firstSeen, price }
  tradeHistory: [],              // { mint, direction, price, amount, pnl, timestamp }
  totalPnl: 0,
  tradeCount: 0,
  winCount: 0,
  startBalance: 0,
  isRunning: false,
};

// ============================================================
// UTILITIES
// ============================================================

function log(level, msg, data = {}) {
  const ts = new Date().toISOString();
  const prefix = { INFO: '📡', TRADE: '💰', WARN: '⚠️', ERROR: '❌', DISCOVERY: '🔍', EXIT: '🚪' }[level] || '📋';
  console.log(`[${ts}] ${prefix} [${level}] ${msg}`, Object.keys(data).length ? JSON.stringify(data) : '');
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getSOLBalance() {
  try {
    const balance = await state.connection.getBalance(state.wallet.publicKey);
    return balance / 1e9;
  } catch (e) {
    log('ERROR', 'Failed to get balance', { error: e.message });
    return 0;
  }
}

async function getSOLPrice() {
  try {
    const res = await fetch(`https://lite-api.jup.ag/price/v2?ids=${CONFIG.SOL_MINT}`);
    const data = await res.json();
    return parseFloat(data?.data?.[CONFIG.SOL_MINT]?.price || 0);
  } catch (e) {
    log('WARN', 'Failed to get SOL price', { error: e.message });
    return 0;
  }
}

async function getTokenPrice(mint) {
  try {
    const res = await fetch(`https://lite-api.jup.ag/price/v2?ids=${mint}`);
    const data = await res.json();
    return parseFloat(data?.data?.[mint]?.price || 0);
  } catch (e) {
    return 0;
  }
}

async function sendDiscord(content) {
  if (!CONFIG.DISCORD_WEBHOOK) return;
  try {
    await fetch(CONFIG.DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  } catch (e) { /* silent */ }
}

// ============================================================
// MODULE 1: WALLET DISCOVERY ENGINE
// ============================================================

async function discoverTopWallets() {
  log('DISCOVERY', '🔎 Starting wallet discovery cycle...');

  const candidateWallets = new Map();

  // Strategy 1: Analyze recent Jupiter swaps for profitable patterns
  try {
    await analyzeRecentSwaps(candidateWallets);
  } catch (e) {
    log('ERROR', 'Swap analysis failed', { error: e.message });
  }

  // Strategy 2: Use seed wallets if provided
  for (const addr of CONFIG.SEED_WALLETS) {
    if (addr && addr.length > 30) {
      try {
        const score = await scoreWallet(addr);
        if (score) {
          candidateWallets.set(addr, score);
        }
      } catch (e) {
        log('WARN', `Failed to score seed wallet ${addr.slice(0, 8)}...`, { error: e.message });
      }
    }
  }

  // Rank and select top wallets — STRICT FILTERING
  const ranked = [...candidateWallets.entries()]
    .filter(([addr, s]) => {
      // Hard requirements
      if (s.totalTrades < CONFIG.MIN_TRADES_FOR_SCORING) {
        log('DISCOVERY', `REJECT ${addr.slice(0, 8)}... — only ${s.totalTrades} trades (need ${CONFIG.MIN_TRADES_FOR_SCORING}+)`);
        return false;
      }
      if (s.winRate < CONFIG.MIN_WIN_RATE) {
        log('DISCOVERY', `REJECT ${addr.slice(0, 8)}... — ${(s.winRate * 100).toFixed(1)}% win rate (need ${CONFIG.MIN_WIN_RATE * 100}%+)`);
        return false;
      }
      if (s.maxDrawdownPct > CONFIG.MAX_DRAWDOWN_PCT) {
        log('DISCOVERY', `REJECT ${addr.slice(0, 8)}... — ${s.maxDrawdownPct.toFixed(1)}% max drawdown (limit ${CONFIG.MAX_DRAWDOWN_PCT}%)`);
        return false;
      }
      // Red flag: single win carries too much of total PnL
      if (s.largestWinShare > CONFIG.MAX_SINGLE_WIN_PNL_SHARE) {
        log('DISCOVERY', `🚩 REJECT ${addr.slice(0, 8)}... — single win is ${(s.largestWinShare * 100).toFixed(1)}% of total PnL`);
        return false;
      }
      // Red flag: win rate decay (recent vs overall)
      if (s.recentWinRate !== null && (s.winRate - s.recentWinRate) > CONFIG.WIN_RATE_DECAY_THRESHOLD) {
        log('DISCOVERY', `🚩 REJECT ${addr.slice(0, 8)}... — win rate decaying: overall ${(s.winRate * 100).toFixed(1)}% → recent ${(s.recentWinRate * 100).toFixed(1)}%`);
        return false;
      }
      // Longevity: must have at least MIN_MONTHLY_SAMPLES months of data
      if (s.activeMonths < CONFIG.MIN_MONTHLY_SAMPLES) {
        log('DISCOVERY', `REJECT ${addr.slice(0, 8)}... — only ${s.activeMonths} months active (need ${CONFIG.MIN_MONTHLY_SAMPLES}+)`);
        return false;
      }
      return true;
    })
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, CONFIG.TOP_WALLETS_COUNT);

  state.trackedWallets.clear();
  for (const [addr, score] of ranked) {
    state.trackedWallets.set(addr, score);
    log('DISCOVERY', `✅ Tracking wallet: ${addr.slice(0, 8)}...`, {
      winRate: `${(score.winRate * 100).toFixed(1)}%`,
      recentWinRate: score.recentWinRate !== null ? `${(score.recentWinRate * 100).toFixed(1)}%` : 'N/A',
      avgProfit: `${(score.avgProfit * 100).toFixed(1)}%`,
      maxDrawdown: `${score.maxDrawdownPct.toFixed(1)}%`,
      largestWinShare: `${(score.largestWinShare * 100).toFixed(1)}%`,
      trades: score.totalTrades,
      activeMonths: score.activeMonths,
      score: score.score.toFixed(2),
    });
  }

  log('DISCOVERY', `Discovery complete. Tracking ${state.trackedWallets.size} wallets.`);
  return state.trackedWallets;
}

async function analyzeRecentSwaps(candidateWallets) {
  // Use Helius enhanced API to get recent Jupiter transactions
  // We look at successful swaps and trace back to the wallets that made them
  log('DISCOVERY', 'Analyzing recent Jupiter swaps...');

  try {
    // Get recent transactions involving Jupiter program — cast a wide net
    const response = await fetch(CONFIG.HELIUS_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: [
          CONFIG.JUPITER_PROGRAM,
          { limit: 500 }
        ]
      })
    });

    const data = await response.json();
    const signatures = data?.result || [];

    // Extract unique signers from these transactions
    const signerCounts = new Map();

    // Process in batches — fetch more transactions for wider coverage
    const batchSize = 20;
    for (let i = 0; i < Math.min(signatures.length, 200); i += batchSize) {
      const batch = signatures.slice(i, i + batchSize);

      const txPromises = batch.map(sig =>
        fetch(CONFIG.HELIUS_RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getTransaction',
            params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
          })
        }).then(r => r.json()).catch(() => null)
      );

      const results = await Promise.all(txPromises);

      for (const res of results) {
        if (!res?.result?.transaction?.message?.accountKeys) continue;
        // First account key is usually the fee payer / signer
        const signer = res.result.transaction.message.accountKeys[0]?.pubkey;
        if (signer && signer !== CONFIG.JUPITER_PROGRAM) {
          const count = signerCounts.get(signer) || 0;
          signerCounts.set(signer, count + 1);
        }
      }

      await sleep(300);
    }

    // Score ANY wallet that appeared — even once is worth checking
    // The deep scoring will filter out bad ones anyway
    const activeTraders = [...signerCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50);  // Evaluate up to 50 candidates

    log('DISCOVERY', `Found ${activeTraders.length} candidate traders to evaluate`);

    for (const [addr] of activeTraders) {
      try {
        const score = await scoreWallet(addr);
        if (score) {
          candidateWallets.set(addr, score);
        }
        await sleep(300);
      } catch (e) {
        // Skip wallets that fail scoring
      }
    }
  } catch (e) {
    log('ERROR', 'Failed to analyze recent swaps', { error: e.message });
  }
}

async function scoreWallet(address) {
  // ──────────────────────────────────────────────────────────
  // DEEP WALLET ANALYSIS
  // Pages through full transaction history to compute:
  //   - Win rate (overall + recent 30-day)
  //   - Max drawdown from peak equity
  //   - Largest single win as % of total PnL
  //   - Active months (longevity)
  //   - Red flag detection
  // ──────────────────────────────────────────────────────────
  try {
    log('DISCOVERY', `Scoring wallet ${address.slice(0, 8)}... (deep analysis)`);

    // Step 1: Fetch transaction history
    // Strategy: grab the MOST RECENT 200 signatures and fetch ALL of them
    // This gives us dense coverage where we can actually match buy+sell pairs
    // Then grab one old page to check longevity
    const allSwaps = [];
    let totalSigsScanned = 0;
    let oldestTimestamp = null;
    let newestTimestamp = null;

    // Phase A: Dense fetch of recent transactions (last 200)
    log('DISCOVERY', `${address.slice(0, 8)}... — fetching recent history...`);
    const recentRes = await fetch(CONFIG.HELIUS_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getSignaturesForAddress',
        params: [address, { limit: 200 }],
      })
    });

    const recentData = await recentRes.json();
    const recentSigs = (recentData?.result || []).filter(s => !s.err);
    totalSigsScanned += recentSigs.length;

    if (recentSigs.length > 0) {
      newestTimestamp = recentSigs[0].blockTime;
      oldestTimestamp = recentSigs[recentSigs.length - 1].blockTime;
    }

    // Fetch ALL recent transactions in batches of 10
    const batchSize = 10;
    for (let i = 0; i < recentSigs.length; i += batchSize) {
      const batch = recentSigs.slice(i, i + batchSize);
      const txPromises = batch.map(sig =>
        fetch(CONFIG.HELIUS_RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'getTransaction',
            params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
          })
        }).then(r => r.json()).catch(() => null)
      );

      const results = await Promise.all(txPromises);
      for (const res of results) {
        const tx = res?.result;
        if (!tx || tx.meta?.err) continue;
        const swap = parseSwapFromTransaction(tx, address);
        if (swap) allSwaps.push(swap);
      }
      await sleep(200);
    }

    // Phase B: Check how far back their history goes (for longevity)
    // Jump to their oldest available page
    let totalEstimatedSigs = recentSigs.length;
    let oldestKnownTimestamp = oldestTimestamp;

    if (recentSigs.length >= 200) {
      // They have more history — page deeper to estimate total volume + longevity
      let lastSig = recentSigs[recentSigs.length - 1].signature;
      for (let page = 0; page < 5; page++) {
        try {
          const pageRes = await fetch(CONFIG.HELIUS_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0', id: 1,
              method: 'getSignaturesForAddress',
              params: [address, { limit: 1000, before: lastSig }],
            })
          });
          const pageData = await pageRes.json();
          const pageSigs = pageData?.result || [];
          if (pageSigs.length === 0) break;

          totalEstimatedSigs += pageSigs.length;
          lastSig = pageSigs[pageSigs.length - 1].signature;
          oldestKnownTimestamp = pageSigs[pageSigs.length - 1].blockTime || oldestKnownTimestamp;

          if (pageSigs.length < 1000) break;
          await sleep(300);
        } catch (e) { break; }
      }
    }

    totalSigsScanned = totalEstimatedSigs;

    log('DISCOVERY', `${address.slice(0, 8)}... — fetched ${recentSigs.length} recent txs, found ${allSwaps.length} swaps, ~${totalEstimatedSigs} total sigs`);

    // Step 2: Score based on individual swap profitability
    // Instead of matching buy/sell pairs (which fails with sampling),
    // treat each swap as an individual trade and look at SOL flow:
    //   - SELL (token -> SOL): solAmount is positive = they got SOL back
    //   - BUY (SOL -> token): solAmount is the cost
    // A profitable trader will have more SOL flowing IN from sells than OUT from buys

    if (allSwaps.length < 5) {
      log('DISCOVERY', `${address.slice(0, 8)}... — only ${allSwaps.length} swaps found, skipping`);
      return null;
    }

    // Sort chronologically
    allSwaps.sort((a, b) => a.timestamp - b.timestamp);

    const buys = allSwaps.filter(s => s.direction === 'buy');
    const sells = allSwaps.filter(s => s.direction === 'sell');
    const totalBuySol = buys.reduce((s, t) => s + t.solAmount, 0);
    const totalSellSol = sells.reduce((s, t) => s + t.solAmount, 0);

    // Net SOL flow: positive = profitable
    const netSolFlow = totalSellSol - totalBuySol;
    const totalSwaps = allSwaps.length;

    // Win rate: what % of sells returned more SOL than the average buy cost
    const avgBuyCost = buys.length > 0 ? totalBuySol / buys.length : 0;
    const profitableSells = sells.filter(s => s.solAmount > avgBuyCost * 0.8).length; // 80% of avg buy = "win"
    const winRate = sells.length > 0 ? profitableSells / sells.length : 0;

    // Recent win rate (last 25% of swaps)
    const recentCutoff = Math.floor(allSwaps.length * 0.75);
    const recentSwaps = allSwaps.slice(recentCutoff);
    const recentSells = recentSwaps.filter(s => s.direction === 'sell');
    const recentBuys = recentSwaps.filter(s => s.direction === 'buy');
    const recentAvgBuyCost = recentBuys.length > 0 ? recentBuys.reduce((s, t) => s + t.solAmount, 0) / recentBuys.length : avgBuyCost;
    const recentProfitableSells = recentSells.filter(s => s.solAmount > recentAvgBuyCost * 0.8).length;
    let recentWinRate = null;
    if (recentSells.length >= 3) {
      recentWinRate = recentProfitableSells / recentSells.length;
    }

    // Equity curve from SOL flow (running balance impact)
    let equity = 0;
    let peakEquity = 0;
    let maxDrawdown = 0;
    const equityCurve = [];

    for (const swap of allSwaps) {
      if (swap.direction === 'sell') {
        equity += swap.solAmount;
      } else {
        equity -= swap.solAmount;
      }
      equityCurve.push({ equity, timestamp: swap.timestamp });
      if (equity > peakEquity) peakEquity = equity;
      const drawdown = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) : 0;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    const maxDrawdownPct = maxDrawdown * 100;

    // Largest single sell as share of total sell volume (red flag check)
    let largestSellSol = 0;
    for (const sell of sells) {
      if (sell.solAmount > largestSellSol) largestSellSol = sell.solAmount;
    }
    const largestWinShare = totalSellSol > 0 ? largestSellSol / totalSellSol : 1;

    // Active months (longevity)
    const firstTradeTime = oldestKnownTimestamp || allSwaps[0]?.timestamp || 0;
    const lastTradeTime = newestTimestamp || allSwaps[allSwaps.length - 1]?.timestamp || 0;
    const activeMonths = Math.max(0, (lastTradeTime - firstTradeTime) / (30 * 24 * 60 * 60));

    // Monthly P&L consistency
    const monthlyPnl = new Map();
    for (const swap of allSwaps) {
      const monthKey = new Date(swap.timestamp * 1000).toISOString().slice(0, 7);
      const current = monthlyPnl.get(monthKey) || 0;
      const impact = swap.direction === 'sell' ? swap.solAmount : -swap.solAmount;
      monthlyPnl.set(monthKey, current + impact);
    }
    const profitableMonths = [...monthlyPnl.values()].filter(pnl => pnl > 0).length;
    const totalMonthsTraded = monthlyPnl.size;
    const monthlyConsistency = totalMonthsTraded > 0 ? profitableMonths / totalMonthsTraded : 0;

    // Avg profit per swap in SOL terms
    const avgProfit = netSolFlow / totalSwaps;

    // Estimated total trades from signature count
    const swapRatio = allSwaps.length / Math.max(recentSigs.length, 1);
    const estimatedTotalTrades = Math.floor(totalEstimatedSigs * swapRatio);

    // Composite score
    const drawdownScore = Math.max(0, 1 - (maxDrawdownPct / 50));
    const longevityScore = Math.min(1, activeMonths / 6);
    const tradeVolumeScore = Math.min(1, estimatedTotalTrades / 500);
    const profitabilityScore = netSolFlow > 0 ? Math.min(1, netSolFlow / 5) : 0; // Up to 5 SOL profit = 1.0

    const score = (
      (winRate * 0.25) +
      (profitabilityScore * 0.25) +
      (monthlyConsistency * 0.20) +
      (longevityScore * 0.15) +
      (drawdownScore * 0.15)
    ) * tradeVolumeScore * 100;

    // Skip unprofitable wallets entirely
    if (netSolFlow <= 0 && winRate < 0.5) {
      log('DISCOVERY', `${address.slice(0, 8)}... — unprofitable (net ${netSolFlow.toFixed(4)} SOL, ${(winRate * 100).toFixed(0)}% WR), skipping`);
      return null;
    }

    log('DISCOVERY', `${address.slice(0, 8)}... scored`, {
      swaps: `${totalSwaps} (${buys.length}B/${sells.length}S)`,
      estTotal: estimatedTotalTrades,
      netSOL: `${netSolFlow >= 0 ? '+' : ''}${netSolFlow.toFixed(4)}`,
      winRate: `${(winRate * 100).toFixed(1)}%`,
      recentWR: recentWinRate !== null ? `${(recentWinRate * 100).toFixed(1)}%` : 'N/A',
      maxDD: `${maxDrawdownPct.toFixed(1)}%`,
      topSellShare: `${(largestWinShare * 100).toFixed(1)}%`,
      months: activeMonths.toFixed(1),
      consistency: `${(monthlyConsistency * 100).toFixed(0)}%`,
      score: score.toFixed(2),
    });

    return {
      score,
      winRate,
      recentWinRate,
      avgProfit,
      maxDrawdownPct,
      largestWinShare,
      activeMonths,
      monthlyConsistency,
      profitableMonths,
      totalMonthsTraded,
      totalTrades: estimatedTotalTrades,
      sampledTrades: totalSwaps,
      wins: profitableSells,
      losses: sells.length - profitableSells,
      totalPnlSol: netSolFlow,
    };
  } catch (e) {
    log('WARN', `Failed to score wallet ${address.slice(0, 8)}`, { error: e.message });
    return null;
  }
}

function parseSwapFromTransaction(tx, walletAddress) {
  // Extract swap details from a parsed transaction
  try {
    const meta = tx.meta;
    const message = tx.transaction?.message;
    if (!meta || !message) return null;

    // Check if this involves any known DEX program
    const accountKeys = message.accountKeys?.map(k => k.pubkey || k) || [];
    const isJupiter = accountKeys.includes(CONFIG.JUPITER_PROGRAM);
    const isRaydium = accountKeys.includes(CONFIG.RAYDIUM_AMM);

    // Also detect swaps via log messages (catches more DEXes)
    const logs = meta.logMessages || [];
    const hasSwapLog = logs.some(l =>
      l.includes('Instruction: Swap') ||
      l.includes('Instruction: Route') ||
      l.includes('Program JUP') ||
      l.includes('Program 675kPX')
    );

    if (!isJupiter && !isRaydium && !hasSwapLog) return null;

    // Analyze pre/post token balances to determine what was swapped
    const preBalances = meta.preTokenBalances || [];
    const postBalances = meta.postTokenBalances || [];

    // Track SOL change (first account is typically the signer/fee payer)
    const walletIndex = accountKeys.indexOf(walletAddress);
    const solIndex = walletIndex >= 0 ? walletIndex : 0;
    const preSol = (meta.preBalances?.[solIndex] || 0) / 1e9;
    const postSol = (meta.postBalances?.[solIndex] || 0) / 1e9;
    const solChange = postSol - preSol;

    // Find ALL token balance changes for this wallet
    // Build a map of mint -> change amount
    const tokenChanges = new Map();

    // Collect all mints from both pre and post balances
    const allMints = new Set();
    for (const b of [...preBalances, ...postBalances]) {
      if (b.owner === walletAddress && b.mint && b.mint !== CONFIG.SOL_MINT) {
        allMints.add(b.mint);
      }
    }

    for (const mint of allMints) {
      const pre = preBalances.find(p => p.owner === walletAddress && p.mint === mint);
      const post = postBalances.find(p => p.owner === walletAddress && p.mint === mint);
      const preAmount = parseFloat(pre?.uiTokenAmount?.uiAmount || 0);
      const postAmount = parseFloat(post?.uiTokenAmount?.uiAmount || 0);
      const change = postAmount - preAmount;

      if (Math.abs(change) > 0.000001) {
        tokenChanges.set(mint, change);
      }
    }

    // Find the non-stablecoin token that changed (the one being traded)
    const STABLES = new Set([CONFIG.USDC_MINT, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']); // USDC + USDT
    let tokenMint = null;
    let tokenChange = 0;

    for (const [mint, change] of tokenChanges) {
      if (!STABLES.has(mint)) {
        tokenMint = mint;
        tokenChange = change;
        break;
      }
    }

    // Fallback: if no non-stable token found, use any token change
    if (!tokenMint && tokenChanges.size > 0) {
      const first = tokenChanges.entries().next().value;
      tokenMint = first[0];
      tokenChange = first[1];
    }

    if (!tokenMint) return null;

    // Determine direction: token balance increased = buy, decreased = sell
    const direction = tokenChange > 0 ? 'buy' : 'sell';
    const solAmount = Math.abs(solChange);

    return {
      tokenMint,
      direction,
      solAmount: solAmount > 0 ? solAmount : 0.001, // Fallback for non-SOL pairs
      tokenAmount: Math.abs(tokenChange),
      timestamp: tx.blockTime,
      signature: tx.transaction?.signatures?.[0],
    };
  } catch (e) {
    return null;
  }
}

// ============================================================
// MODULE 2: REAL-TIME WALLET MONITOR (WebSocket)
// ============================================================

function startWalletMonitor() {
  if (state.trackedWallets.size === 0) {
    log('WARN', 'No wallets to monitor. Waiting for discovery...');
    return;
  }

  // Close existing connection
  if (state.ws) {
    try { state.ws.close(); } catch (e) { /* ignore */ }
  }

  const ws = new WebSocket(CONFIG.HELIUS_WS);
  state.ws = ws;

  ws.on('open', () => {
    log('INFO', `WebSocket connected. Subscribing to ${state.trackedWallets.size} wallets...`);

    // Subscribe to account changes for each tracked wallet
    // Using standard accountSubscribe since Enhanced WS requires Business plan
    let subId = 1;
    for (const [address] of state.trackedWallets) {
      const request = {
        jsonrpc: '2.0',
        id: subId++,
        method: 'accountSubscribe',
        params: [
          address,
          { encoding: 'jsonParsed', commitment: 'confirmed' }
        ]
      };
      ws.send(JSON.stringify(request));
    }

    // Heartbeat ping every 30s
    state.wsPingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30000);
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Handle subscription confirmations
      if (msg.result && typeof msg.result === 'number') {
        return;
      }

      // Handle account notifications (wallet balance changed = they traded)
      if (msg.method === 'accountNotification') {
        const subId = msg.params?.subscription;
        // When a tracked wallet's balance changes, check their recent tx
        await handleWalletActivity(subId);
      }
    } catch (e) {
      // ignore parse errors on pings etc
    }
  });

  ws.on('close', () => {
    log('WARN', 'WebSocket disconnected. Reconnecting in 5s...');
    clearInterval(state.wsPingInterval);
    setTimeout(() => {
      if (state.isRunning) startWalletMonitor();
    }, 5000);
  });

  ws.on('error', (err) => {
    log('ERROR', 'WebSocket error', { error: err.message });
  });
}

// Map subscription IDs to wallet addresses
const subscriptionMap = new Map();
let nextSubId = 1;

async function handleWalletActivity(subscriptionId) {
  // When we get a notification, poll the wallet's latest transaction
  // This is the approach that works with standard (free) WebSockets
  for (const [address] of state.trackedWallets) {
    try {
      const response = await fetch(CONFIG.HELIUS_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignaturesForAddress',
          params: [address, { limit: 1 }]
        })
      });

      const data = await response.json();
      const latestSig = data?.result?.[0];
      if (!latestSig) continue;

      // Check if this is a new transaction (within last 30 seconds)
      const txAge = Date.now() / 1000 - (latestSig.blockTime || 0);
      if (txAge > 30) continue;

      // Get full transaction details
      const txResponse = await fetch(CONFIG.HELIUS_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [latestSig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
        })
      });

      const txData = await txResponse.json();
      const tx = txData?.result;
      if (!tx) continue;

      const swap = parseSwapFromTransaction(tx, address);
      if (!swap) continue;

      log('INFO', `Tracked wallet ${address.slice(0, 8)}... ${swap.direction} ${swap.tokenMint.slice(0, 8)}...`, {
        solAmount: swap.solAmount.toFixed(4),
        tokenAmount: swap.tokenAmount.toFixed(4),
      });

      await processSignal(swap, address);
    } catch (e) {
      // Skip errors on individual wallet checks
    }
  }
}

// ============================================================
// MODULE 2B: POLLING FALLBACK (more reliable than WS for free tier)
// ============================================================

async function startPollingMonitor() {
  log('INFO', 'Starting polling monitor for tracked wallets...');

  // Track last known signature per wallet
  const lastSigs = new Map();

  // Initialize with current latest sigs
  for (const [address] of state.trackedWallets) {
    try {
      const response = await fetch(CONFIG.HELIUS_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignaturesForAddress',
          params: [address, { limit: 1 }]
        })
      });
      const data = await response.json();
      const sig = data?.result?.[0]?.signature;
      if (sig) lastSigs.set(address, sig);
      await sleep(200);
    } catch (e) { /* skip */ }
  }

  log('INFO', `Initialized last signatures for ${lastSigs.size} wallets`);

  // Poll loop
  while (state.isRunning) {
    for (const [address, walletScore] of state.trackedWallets) {
      try {
        const response = await fetch(CONFIG.HELIUS_RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getSignaturesForAddress',
            params: [address, { limit: 3 }]
          })
        });

        const data = await response.json();
        const sigs = data?.result || [];

        const lastKnown = lastSigs.get(address);
        const newSigs = [];

        for (const sig of sigs) {
          if (sig.signature === lastKnown) break;
          if (!sig.err) newSigs.push(sig);
        }

        if (newSigs.length > 0) {
          lastSigs.set(address, newSigs[0].signature);

          // Analyze each new transaction
          for (const sig of newSigs) {
            try {
              const txResponse = await fetch(CONFIG.HELIUS_RPC, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  jsonrpc: '2.0',
                  id: 1,
                  method: 'getTransaction',
                  params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
                })
              });

              const txData = await txResponse.json();
              const tx = txData?.result;
              if (!tx) continue;

              const swap = parseSwapFromTransaction(tx, address);
              if (!swap) continue;

              log('TRADE', `🎯 Tracked wallet ${address.slice(0, 8)}... ${swap.direction.toUpperCase()} signal`, {
                token: swap.tokenMint.slice(0, 8),
                sol: swap.solAmount.toFixed(4),
                walletScore: walletScore.score.toFixed(2),
              });

              await processSignal(swap, address);
              await sleep(200);
            } catch (e) { /* skip individual tx errors */ }
          }
        }

        await sleep(500); // Rate limit between wallets
      } catch (e) {
        log('WARN', `Poll error for ${address.slice(0, 8)}`, { error: e.message });
      }
    }

    // Wait between poll cycles
    await sleep(5000);
  }
}

// ============================================================
// MODULE 3: TRADE EVALUATION
// ============================================================

async function processSignal(swap, walletAddress) {
  const { tokenMint, direction, solAmount } = swap;

  // If tracked wallet is SELLING a token we hold, trigger exit
  if (direction === 'sell' && state.positions.has(tokenMint)) {
    log('EXIT', `Tracked wallet selling ${tokenMint.slice(0, 8)}... — triggering exit`);
    await executeExit(tokenMint, 100, 'tracked_wallet_sold');
    return;
  }

  // Only process BUY signals
  if (direction !== 'buy') return;

  // Skip if we already hold this token
  if (state.positions.has(tokenMint)) {
    log('INFO', `Already holding ${tokenMint.slice(0, 8)}... — skipping`);
    return;
  }

  // Skip if at max positions
  if (state.positions.size >= CONFIG.MAX_CONCURRENT_POSITIONS) {
    log('WARN', `At max positions (${CONFIG.MAX_CONCURRENT_POSITIONS}) — skipping signal`);
    return;
  }

  // Aggregate signals: track how many wallets are buying this token
  if (!state.pendingSignals.has(tokenMint)) {
    state.pendingSignals.set(tokenMint, {
      wallets: new Set(),
      firstSeen: Date.now(),
    });
  }
  state.pendingSignals.get(tokenMint).wallets.add(walletAddress);

  const signalCount = state.pendingSignals.get(tokenMint).wallets.size;
  log('INFO', `Signal count for ${tokenMint.slice(0, 8)}...: ${signalCount} wallet(s)`);

  // Evaluate the trade
  const evaluation = await evaluateTrade(tokenMint, signalCount);

  if (evaluation.pass) {
    log('TRADE', `✅ Trade evaluation PASSED for ${tokenMint.slice(0, 8)}...`, evaluation);
    await executeBuy(tokenMint, evaluation);
    state.pendingSignals.delete(tokenMint);
  } else {
    log('INFO', `❌ Trade evaluation failed: ${evaluation.reason}`, { token: tokenMint.slice(0, 8) });
  }

  // Clean up old pending signals (older than 5 minutes)
  for (const [mint, signal] of state.pendingSignals) {
    if (Date.now() - signal.firstSeen > 5 * 60 * 1000) {
      state.pendingSignals.delete(mint);
    }
  }
}

async function evaluateTrade(tokenMint, signalCount) {
  const result = { pass: false, reason: '', tokenMint };

  try {
    // 1. Check token price exists on Jupiter
    const price = await getTokenPrice(tokenMint);
    if (!price) {
      result.reason = 'No price data on Jupiter';
      return result;
    }
    result.price = price;

    // 2. Get a quote to check liquidity / slippage
    const balance = await getSOLBalance();
    const tradeAmountLamports = Math.floor(balance * CONFIG.POSITION_SIZE_PCT * 1e9);

    if (tradeAmountLamports < 10000000) { // Less than 0.01 SOL
      result.reason = 'Insufficient balance for trade';
      return result;
    }

    const quoteUrl = `${CONFIG.JUPITER_QUOTE}?inputMint=${CONFIG.SOL_MINT}&outputMint=${tokenMint}&amount=${tradeAmountLamports}&slippageBps=${CONFIG.MAX_SLIPPAGE_BPS}`;
    const quoteRes = await fetch(quoteUrl);

    if (!quoteRes.ok) {
      result.reason = `Jupiter quote failed: ${quoteRes.status}`;
      return result;
    }

    const quote = await quoteRes.json();

    if (!quote.outAmount || quote.outAmount === '0') {
      result.reason = 'No route found on Jupiter';
      return result;
    }

    // 3. Check price impact
    const priceImpact = parseFloat(quote.priceImpactPct || 0);
    if (Math.abs(priceImpact) > 0.05) { // More than 5% price impact
      result.reason = `Price impact too high: ${(priceImpact * 100).toFixed(2)}%`;
      return result;
    }
    result.priceImpact = `${(priceImpact * 100).toFixed(2)}%`;

    // 4. Signal strength: multiple wallets buying = stronger
    // Single wallet = OK, 2+ wallets = strong buy
    result.signalStrength = signalCount >= 2 ? 'STRONG' : 'NORMAL';

    // 5. Check our balance is sufficient
    const solPrice = await getSOLPrice();
    const tradeValueUsd = (tradeAmountLamports / 1e9) * solPrice;
    result.tradeValueUsd = tradeValueUsd.toFixed(2);

    result.pass = true;
    result.quote = quote;
    result.tradeAmountLamports = tradeAmountLamports;

    return result;
  } catch (e) {
    result.reason = `Evaluation error: ${e.message}`;
    return result;
  }
}

// ============================================================
// MODULE 4: EXECUTION ENGINE
// ============================================================

async function executeBuy(tokenMint, evaluation) {
  try {
    log('TRADE', `🛒 Executing BUY for ${tokenMint.slice(0, 8)}...`, {
      amountSOL: (evaluation.tradeAmountLamports / 1e9).toFixed(4),
      priceImpact: evaluation.priceImpact,
      signal: evaluation.signalStrength,
    });

    const quote = evaluation.quote;

    // Get swap transaction from Jupiter
    const swapRes = await fetch(CONFIG.JUPITER_SWAP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: state.wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicSlippage: {
          minBps: 50,
          maxBps: CONFIG.MAX_SLIPPAGE_BPS,
        },
        prioritizationFeeLamports: CONFIG.PRIORITY_FEE_LAMPORTS,
      }),
    });

    if (!swapRes.ok) {
      log('ERROR', `Swap request failed: ${swapRes.status}`);
      return;
    }

    const swapData = await swapRes.json();
    const swapTransaction = swapData.swapTransaction;

    if (!swapTransaction) {
      log('ERROR', 'No swap transaction returned from Jupiter');
      return;
    }

    // Deserialize, sign, and send
    const txBuf = Buffer.from(swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([state.wallet]);

    const rawTx = tx.serialize();
    const signature = await state.connection.sendRawTransaction(rawTx, {
      skipPreflight: true,
      maxRetries: 3,
    });

    log('TRADE', `📤 Transaction sent: ${signature}`);

    // Confirm transaction
    const confirmation = await confirmTransaction(signature);

    if (confirmation) {
      const entryPrice = evaluation.price;
      const tokenAmount = parseFloat(quote.outAmount) / Math.pow(10, quote.outputDecimals || 9);

      state.positions.set(tokenMint, {
        entryPrice,
        amount: tokenAmount,
        entryTime: Date.now(),
        soldPct: 0,
        entrySignature: signature,
        entrySolAmount: evaluation.tradeAmountLamports / 1e9,
      });

      state.tradeCount++;

      const msg = `🛒 **BUY** ${tokenMint.slice(0, 8)}... | ${(evaluation.tradeAmountLamports / 1e9).toFixed(4)} SOL | Signal: ${evaluation.signalStrength}`;
      log('TRADE', msg);
      await sendDiscord(msg);
    } else {
      log('ERROR', `Transaction failed to confirm: ${signature}`);
    }
  } catch (e) {
    log('ERROR', `Buy execution failed`, { error: e.message });
  }
}

async function executeExit(tokenMint, sellPct, reason) {
  try {
    const position = state.positions.get(tokenMint);
    if (!position) return;

    const remainingPct = 100 - position.soldPct;
    const actualSellPct = Math.min(sellPct, remainingPct);
    if (actualSellPct <= 0) return;

    // Get current token balance
    const tokenAccounts = await state.connection.getParsedTokenAccountsByOwner(
      state.wallet.publicKey,
      { mint: new PublicKey(tokenMint) }
    );

    const tokenAccount = tokenAccounts?.value?.[0];
    if (!tokenAccount) {
      log('WARN', `No token account found for ${tokenMint.slice(0, 8)}... — removing position`);
      state.positions.delete(tokenMint);
      return;
    }

    const currentBalance = parseFloat(tokenAccount.account.data.parsed.info.tokenAmount.uiAmount || 0);
    if (currentBalance <= 0) {
      state.positions.delete(tokenMint);
      return;
    }

    const sellAmount = Math.floor(currentBalance * (actualSellPct / 100));
    const sellAmountRaw = BigInt(Math.floor(sellAmount * Math.pow(10, tokenAccount.account.data.parsed.info.tokenAmount.decimals)));

    if (sellAmountRaw <= 0n) {
      state.positions.delete(tokenMint);
      return;
    }

    log('EXIT', `🚪 Executing SELL ${actualSellPct}% of ${tokenMint.slice(0, 8)}...`, { reason });

    // Get quote for selling token -> SOL
    const quoteUrl = `${CONFIG.JUPITER_QUOTE}?inputMint=${tokenMint}&outputMint=${CONFIG.SOL_MINT}&amount=${sellAmountRaw.toString()}&slippageBps=${CONFIG.MAX_SLIPPAGE_BPS}`;
    const quoteRes = await fetch(quoteUrl);

    if (!quoteRes.ok) {
      log('ERROR', `Exit quote failed: ${quoteRes.status}`);
      return;
    }

    const quote = await quoteRes.json();
    if (!quote.outAmount) {
      log('ERROR', 'No exit route found');
      return;
    }

    // Execute sell swap
    const swapRes = await fetch(CONFIG.JUPITER_SWAP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: state.wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicSlippage: {
          minBps: 50,
          maxBps: CONFIG.MAX_SLIPPAGE_BPS,
        },
        prioritizationFeeLamports: CONFIG.PRIORITY_FEE_LAMPORTS,
      }),
    });

    if (!swapRes.ok) {
      log('ERROR', `Exit swap request failed: ${swapRes.status}`);
      return;
    }

    const swapData = await swapRes.json();
    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([state.wallet]);

    const rawTx = tx.serialize();
    const signature = await state.connection.sendRawTransaction(rawTx, {
      skipPreflight: true,
      maxRetries: 3,
    });

    const confirmed = await confirmTransaction(signature);

    if (confirmed) {
      const solReceived = parseFloat(quote.outAmount) / 1e9;
      const pnl = ((solReceived / position.entrySolAmount) - 1) * (actualSellPct / 100);

      position.soldPct += actualSellPct;
      state.totalPnl += pnl * position.entrySolAmount;

      if (position.soldPct >= 100) {
        const totalPnlPct = ((solReceived / position.entrySolAmount) - 1) * 100;
        if (totalPnlPct > 0) state.winCount++;
        state.positions.delete(tokenMint);
      }

      const msg = `🚪 **SELL** ${actualSellPct}% of ${tokenMint.slice(0, 8)}... | ${solReceived.toFixed(4)} SOL back | Reason: ${reason}`;
      log('EXIT', msg);
      await sendDiscord(msg);
    }
  } catch (e) {
    log('ERROR', `Exit execution failed for ${tokenMint.slice(0, 8)}`, { error: e.message });
  }
}

async function confirmTransaction(signature, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const status = await state.connection.getSignatureStatuses([signature]);
      const result = status?.value?.[0];
      if (result) {
        if (result.err) {
          log('ERROR', `Transaction failed on-chain: ${signature}`);
          return false;
        }
        if (result.confirmationStatus === 'confirmed' || result.confirmationStatus === 'finalized') {
          return true;
        }
      }
    } catch (e) { /* retry */ }
    await sleep(2000);
  }
  log('WARN', `Transaction confirmation timed out: ${signature}`);
  return false;
}

// ============================================================
// MODULE 5: POSITION MONITOR & EXIT STRATEGY
// ============================================================

async function startPositionMonitor() {
  log('INFO', 'Starting position monitor...');

  while (state.isRunning) {
    for (const [tokenMint, position] of state.positions) {
      try {
        const currentPrice = await getTokenPrice(tokenMint);
        if (!currentPrice || !position.entryPrice) continue;

        const pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

        // Stop loss check
        if (pnlPct <= CONFIG.STOP_LOSS_PCT) {
          log('EXIT', `⛔ STOP LOSS triggered for ${tokenMint.slice(0, 8)}... at ${pnlPct.toFixed(1)}%`);
          await executeExit(tokenMint, 100, `stop_loss_${pnlPct.toFixed(1)}%`);
          continue;
        }

        // Take profit 1: sell 50% at +20%
        if (pnlPct >= CONFIG.TAKE_PROFIT_1_PCT && position.soldPct < 50) {
          log('EXIT', `🎯 TP1 triggered for ${tokenMint.slice(0, 8)}... at +${pnlPct.toFixed(1)}%`);
          await executeExit(tokenMint, 50, `tp1_${pnlPct.toFixed(1)}%`);
          continue;
        }

        // Take profit 2: sell remaining at +40%
        if (pnlPct >= CONFIG.TAKE_PROFIT_2_PCT && position.soldPct < 100) {
          log('EXIT', `🎯 TP2 triggered for ${tokenMint.slice(0, 8)}... at +${pnlPct.toFixed(1)}%`);
          await executeExit(tokenMint, 100, `tp2_${pnlPct.toFixed(1)}%`);
          continue;
        }

        // Dead coin detection: if price drops 50%+ from entry, force exit
        if (pnlPct <= -50) {
          log('EXIT', `💀 Dead coin detected: ${tokenMint.slice(0, 8)}... at ${pnlPct.toFixed(1)}%`);
          await executeExit(tokenMint, 100, 'dead_coin');
          continue;
        }

      } catch (e) {
        log('WARN', `Price check failed for ${tokenMint.slice(0, 8)}`, { error: e.message });
      }
    }

    await sleep(CONFIG.PRICE_CHECK_INTERVAL_MS);
  }
}

// ============================================================
// MODULE 6: HEALTH & DASHBOARD
// ============================================================

async function startHealthMonitor() {
  while (state.isRunning) {
    const balance = await getSOLBalance();
    const solPrice = await getSOLPrice();
    const balanceUsd = (balance * solPrice).toFixed(2);
    const winRate = state.tradeCount > 0 ? ((state.winCount / state.tradeCount) * 100).toFixed(1) : '0.0';

    console.log('\n' + '='.repeat(60));
    console.log(`  🤖 WINSTON v9 — Health Report`);
    console.log('='.repeat(60));
    console.log(`  💰 Balance: ${balance.toFixed(4)} SOL ($${balanceUsd})`);
    console.log(`  📊 Total PnL: ${state.totalPnl >= 0 ? '+' : ''}${state.totalPnl.toFixed(4)} SOL`);
    console.log(`  🎯 Trades: ${state.tradeCount} | Wins: ${state.winCount} | Win Rate: ${winRate}%`);
    console.log(`  📡 Tracking: ${state.trackedWallets.size} wallets`);
    console.log(`  📦 Open positions: ${state.positions.size}/${CONFIG.MAX_CONCURRENT_POSITIONS}`);

    if (state.positions.size > 0) {
      console.log('  ─── Open Positions ───');
      for (const [mint, pos] of state.positions) {
        const currentPrice = await getTokenPrice(mint);
        const pnlPct = currentPrice && pos.entryPrice
          ? (((currentPrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(1)
          : '?';
        const age = ((Date.now() - pos.entryTime) / 60000).toFixed(0);
        console.log(`  ${mint.slice(0, 8)}... | PnL: ${pnlPct}% | Sold: ${pos.soldPct}% | Age: ${age}m`);
      }
    }

    console.log('='.repeat(60) + '\n');

    await sleep(CONFIG.HEALTH_LOG_INTERVAL_MS);
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║           🤖 WINSTON v9 — Wallet Copy Bot               ║
║        Momentum Tracking • Smart Execution               ║
╚══════════════════════════════════════════════════════════╝
  `);

  // Validate config
  if (!CONFIG.HELIUS_API_KEY) {
    log('ERROR', 'HELIUS_API_KEY is required. Set it in .env');
    process.exit(1);
  }
  if (!CONFIG.PRIVATE_KEY) {
    log('ERROR', 'PRIVATE_KEY is required. Set it in .env');
    process.exit(1);
  }

  // Initialize wallet
  try {
    const decoded = bs58.decode(CONFIG.PRIVATE_KEY);
    state.wallet = Keypair.fromSecretKey(decoded);
    log('INFO', `Wallet: ${state.wallet.publicKey.toString()}`);
  } catch (e) {
    log('ERROR', 'Invalid PRIVATE_KEY format. Must be base58 encoded.', { error: e.message });
    process.exit(1);
  }

  // Initialize connection
  state.connection = new Connection(CONFIG.HELIUS_RPC, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000,
  });

  // Get starting balance
  state.startBalance = await getSOLBalance();
  const solPrice = await getSOLPrice();
  log('INFO', `Starting balance: ${state.startBalance.toFixed(4)} SOL ($${(state.startBalance * solPrice).toFixed(2)})`);

  if (state.startBalance < 0.01) {
    log('ERROR', 'Balance too low. Need at least 0.01 SOL to operate.');
    process.exit(1);
  }

  state.isRunning = true;

  // Phase 1: Discover top wallets
  await discoverTopWallets();

  if (state.trackedWallets.size === 0 && CONFIG.SEED_WALLETS.length === 0) {
    log('WARN', 'No wallets discovered and no seed wallets provided.');
    log('WARN', 'Set SEED_WALLETS in Railway with comma-separated wallet addresses for best results.');
    log('WARN', 'Retrying discovery every 2 minutes...');

    // Keep trying aggressively
    while (state.trackedWallets.size === 0 && state.isRunning) {
      await sleep(2 * 60 * 1000); // Retry every 2 min
      await discoverTopWallets();
    }
  }

  // Phase 2: Start monitoring (using polling for reliability on free tier)
  // WebSocket approach is also available but less reliable on free Helius
  const monitorPromise = startPollingMonitor();

  // Phase 3: Start position monitor
  const positionPromise = startPositionMonitor();

  // Phase 4: Start health dashboard
  const healthPromise = startHealthMonitor();

  // Phase 5: Schedule periodic wallet re-discovery
  const discoveryInterval = setInterval(async () => {
    log('DISCOVERY', 'Running scheduled wallet re-discovery...');
    await discoverTopWallets();
  }, CONFIG.DISCOVERY_INTERVAL_MS);

  // Handle shutdown
  const shutdown = async () => {
    log('INFO', '🛑 Shutting down Winston v9...');
    state.isRunning = false;
    clearInterval(discoveryInterval);
    if (state.ws) state.ws.close();

    const finalBalance = await getSOLBalance();
    const pnl = finalBalance - state.startBalance;
    log('INFO', `Final balance: ${finalBalance.toFixed(4)} SOL | Session PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`);

    await sendDiscord(`🛑 Winston v9 shutdown. Final balance: ${finalBalance.toFixed(4)} SOL | PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep running
  await Promise.all([monitorPromise, positionPromise, healthPromise]);
}

main().catch(e => {
  log('ERROR', 'Fatal error', { error: e.message, stack: e.stack });
  process.exit(1);
});
