// ============================================================
// WINSTON v9.2 — Discord Alert + Grok Analysis Bot
// ============================================================
// Monitors top Dune wallets. On every buy/sell, sends a
// Discord alert with Grok AI analysis (momentum score,
// buy/skip recommendation, estimated hold time).
// NO auto-trading — David makes the final call.
// ============================================================

require('dotenv').config();
const { Connection, Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  get HELIUS_RPC() { return `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },
  PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || '',
  GROK_API_KEY: process.env.GROK_API_KEY || '',
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || '',
  JUPITER_PRICE: 'https://lite-api.jup.ag/price/v2',

  // Timing
  POLL_INTERVAL_MS: 3000,          // Check wallets every 3s
  HEALTH_LOG_INTERVAL_MS: 300000,  // Health log every 5min

  // Constants
  SOL_MINT: 'So11111111111111111111111111111111111111112',
  USDC_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT_MINT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  JUPITER_PROGRAM: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  RAYDIUM_AMM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',

  // ============================================================
  // WALLET DATABASE — Dune stats embedded for Grok context
  // FILTER: ≤21 days old, 15+ buy swaps, median hold > 1 minute
  // ============================================================
  TRACKED_WALLETS: {
    // Page 1 originals that qualify
    '8gDRLa498xXCdch3DvtvjCJ7C1joJ1BpftTDVZztxigv': { roi: '396%', wr: '50%', days: 16, pnl: 115.34, medianRoi: '1%', tokens: 24, buys: 27, medianHold: '00:01:47' },
    'AjKCctQtCnCj48tR3YaGm1ZrQtURoodjfg6YKLy97Uub': { roi: '286%', wr: '95%', days: 11, pnl: 75.23, medianRoi: '162%', tokens: 19, buys: 19, medianHold: '00:01:23' },
    '2M4Ka8W5i7eK9Z3zMpzbeYRsAVM4HtpwhtTnbmPDdiMn': { roi: '324%', wr: '60%', days: 8, pnl: 17.79, medianRoi: '12%', tokens: 10, buys: 10, medianHold: '00:07:28' },  // 10 buys but high ROI
    'H5G1btoS96YZ6fcaDDhAo99A9p4RkenV9XKLw2aPCeaF': { roi: '228%', wr: '50%', days: 5, pnl: 39.50, medianRoi: '1%', tokens: 16, buys: 18, medianHold: '00:33:26' },
    '9p7PFT2HYhVKXDsvCZd43d8GRm1jQcWBH7tmawe96b6X': { roi: '237%', wr: '67%', days: 12, pnl: 28.30, medianRoi: '8%', tokens: 9, buys: 23, medianHold: '16:02:59' },
    '3bLSiJ7RTMqypwhNqu6zNC2jcoQdknnGd5Y7feoaPXT9': { roi: '229%', wr: '50%', days: 12, pnl: 33.01, medianRoi: '4%', tokens: 10, buys: 23, medianHold: '16:02:16' },
    '8DqpugHmWXVcSAYaZs9W2jXnCE4Cx1XbNMsZYC8EU1JV': { roi: '237%', wr: '60%', days: 10, pnl: 21.99, medianRoi: '91%', tokens: 5, buys: 6, medianHold: '00:06:12' },  // fewer buys but elite ROI

    // Page 25 — ≤21d, 15+ buys, hold > 1min
    '4GoxdjKPJE3bdz6K6jdDGkp3JWdiE7B9o1GCfHHivFZX': { roi: '54%', wr: '75%', days: 8, pnl: 5.53, medianRoi: '31%', tokens: 10, buys: 10, medianHold: 'N/A' },
    '7k2ScNraqH7yCA84nmuJUbxh5sbtXeFtuMj8pVGKWb7v': { roi: '35%', wr: '75%', days: 21 /*approx*/, pnl: 11.26, medianRoi: '19%', tokens: 24, buys: 24, medianHold: 'N/A' },  // 23d but close
    'JEgaEgnUdYTArEXBJXcTZnR2HXXDS3J7zEMjiZPkD7A': { roi: '82%', wr: '75%', days: 15 /*est*/, pnl: 11.90, medianRoi: '48%', tokens: 15, buys: 15, medianHold: 'N/A' },
    'D4TTnojip152LikVL91CpxCMd6AY6ZoAP8wWEM5P8pi9': { roi: '5%', wr: '75%', days: 12, pnl: 3.08, medianRoi: '9%', tokens: 20, buys: 20, medianHold: 'N/A' },
    'DEEDBHXhgvno5ddCrwR4jHLJrMQCAEtAPMaMLmKJBNUL': { roi: '75%', wr: '76%', days: 21 /*approx*/, pnl: 19.94, medianRoi: '11%', tokens: 24, buys: 24, medianHold: 'N/A' },
    '9jYMojHaJxyXsvVMN2foih8knXb5AXYkMmUnxjQT5BoJ': { roi: '202%', wr: '77%', days: 11, pnl: 61.24, medianRoi: '17%', tokens: 22, buys: 24, medianHold: '00:00:06' },  // fast trader kept for high ROI

    // Page 26 — ≤21d, active
    'EdR13FZ278MsBsxaprh9tYywigXS83Dh8oPLu189Sgc2': { roi: '53%', wr: '78%', days: 19, pnl: 12.32, medianRoi: '10%', tokens: 24, buys: 24, medianHold: 'N/A' },
    '8Lh4ESqtGEVxfyYS74sdZzthKS84ZxJrDzJzdeTb46wv': { roi: '29%', wr: '78%', days: 21 /*approx*/, pnl: 22.39, medianRoi: '83%', tokens: 25, buys: 25, medianHold: 'N/A' },
    'EUvwByYdWD7aFW5C3FcoErnUAqToxavzwHZiyaQcRnxX': { roi: '14%', wr: '79%', days: 6, pnl: 6.28, medianRoi: '7%', tokens: 14, buys: 14, medianHold: 'N/A' },

    // Page 27 — ≤21d, active high WR
    '4PH7LPnrwC9y2xz6F8RNcPSa6MhVk5CV5mmGZCqe8WU6': { roi: '99%', wr: '80%', days: 7, pnl: 17.77, medianRoi: '41%', tokens: 20, buys: 20, medianHold: 'N/A' },
    'HCFg8YVKJJycWjnnu4GJoHjsrpwffHvwNhXVHUezVyyM': { roi: '85%', wr: '80%', days: 10 /*approx*/, pnl: 18.16, medianRoi: '92%', tokens: 10, buys: 10, medianHold: 'N/A' },
    '92ShpinZecEtxeR4ar9sKNCjveqfws1f2Dq99ec9wDkY': { roi: '74%', wr: '80%', days: 6, pnl: 13.32, medianRoi: '85%', tokens: 23, buys: 23, medianHold: 'N/A' },
    'kKxAre83Pu9GSqrejAbPi7tB1k8zLjUJpHgeSBjL7Lx': { roi: '13%', wr: '80%', days: 21 /*approx*/, pnl: 1.82, medianRoi: '10%', tokens: 10, buys: 10, medianHold: 'N/A' },
    'D8P3rD7hYU2o9nESxKqtsBHMP2C5C9vVcQneJjy16Qda': { roi: '47%', wr: '80%', days: 21 /*approx*/, pnl: 6.87, medianRoi: '49%', tokens: 14, buys: 14, medianHold: 'N/A' },

    // Page 28 — ≤21d, 82%+ WR
    '2FFnhYefCdARYfyiTY2GR7ZKA72Wt9QgY5ZEn7j1udUQ': { roi: '32%', wr: '82%', days: 0, pnl: 4.74, medianRoi: '25%', tokens: 25, buys: 25, medianHold: 'N/A' },
    '2Qizz6uSGUtNAhiR621H7YDbAsfad3vrqAWmyDmxwjHn': { roi: '12%', wr: '82%', days: 21 /*approx*/, pnl: 5.79, medianRoi: '13%', tokens: 25, buys: 25, medianHold: 'N/A' },
    'FX2fNGE3nXaCcuTw4133Nb5CLJqTjzhZGtxSpnSuapX8': { roi: '94%', wr: '82%', days: 21 /*approx*/, pnl: 10.56, medianRoi: '80%', tokens: 16, buys: 16, medianHold: 'N/A' },
    'DcL2q1oCMgFCTNNPQrUyzuQfHavNxzBWvUHW9fxo8wvU': { roi: '24%', wr: '82%', days: 21 /*approx*/, pnl: 5.82, medianRoi: '21%', tokens: 20, buys: 20, medianHold: 'N/A' },
    'DE4btrVmoq2CLWbQLWmL8yq4qC3daiBMsxwNdcsXa9cw': { roi: '56%', wr: '83%', days: 13, pnl: 9.14, medianRoi: '24%', tokens: 8, buys: 8, medianHold: 'N/A' },
    '2LTajgqXoPhfebjnKqb83BzDswAwPXrqU63KTcXhqHQq': { roi: '43%', wr: '83%', days: 21 /*approx*/, pnl: 12.01, medianRoi: '31%', tokens: 23, buys: 23, medianHold: 'N/A' },
    '3qau7RJjDAszMVY3W6dDsBtuqNUeTnP8YMqyXv3kocn3': { roi: '65%', wr: '83%', days: 9, pnl: 14.92, medianRoi: '103%', tokens: 20, buys: 20, medianHold: 'N/A' },

    // Page 29 — ≤21d, 85%+ WR
    '2Y9cjafAkHjyo4Ge7GKxa2nkpMh1tVwKuFAoXxhQCXmX': { roi: '43%', wr: '85%', days: 9, pnl: 15.37, medianRoi: '29%', tokens: 13, buys: 13, medianHold: 'N/A' },
    'F7HXUvhmCjkHM1ePFCSRReXXbnCAKdiJMDFNfH8u8khG': { roi: '215%', wr: '86%', days: 21 /*approx from page1*/, pnl: 23.62, medianRoi: '43%', tokens: 21, buys: 25, medianHold: '00:04:06' },
    'BBKnWA5u7xpWzMU9DD2gNaTVj7fK7bRXBgnf9QwGAk3H': { roi: '62%', wr: '86%', days: 21 /*approx*/, pnl: 9.91, medianRoi: '35%', tokens: 17, buys: 17, medianHold: 'N/A' },
    '81dtsioFgo7Y3Mes6oPaDiUdUGcYjsUx3XAnAfynD3mk': { roi: '43%', wr: '86%', days: 6, pnl: 18.24, medianRoi: '39%', tokens: 26, buys: 26, medianHold: 'N/A' },
    '8GPswY8JZddPqcnyur4asSSpUnTQ17rfRsDdnnPMZuNt': { roi: '37%', wr: '89%', days: 6, pnl: 16.85, medianRoi: '44%', tokens: 20, buys: 20, medianHold: 'N/A' },

    // Page 30 — ≤21d, 88%+ WR
    'DMYZW5Krh3c8Jf7R2GZ6Ftm9qNeoy1payx5ZoRpvCiXc': { roi: '112%', wr: '89%', days: 6, pnl: 14.99, medianRoi: '6%', tokens: 10, buys: 10, medianHold: 'N/A' },
    'CJSduQc6GLrNCpE4w8LigAb5AynNCc6142jP1u71kmLJ': { roi: '56%', wr: '88%', days: 7, pnl: 9.28, medianRoi: '32%', tokens: 19, buys: 19, medianHold: 'N/A' },
    '4cwDKZb97ck6815oqvbzyJE95CJ41VuHexMjeNJZ8K3T': { roi: '39%', wr: '88%', days: 1, pnl: 7.64, medianRoi: '36%', tokens: 10, buys: 10, medianHold: 'N/A' },

    // Page 31-32 — ≤21d, 90%+ WR
    'AFs5DZ92CZ8PCfwFE9WPrp9Ac6nmfq184Tao6Dx1C4rq': { roi: '32%', wr: '90%', days: 5, pnl: 6.29, medianRoi: '26%', tokens: 20, buys: 20, medianHold: 'N/A' },
    'AADuT157v1xrJPg1xrH2tVbVepxCGvdr6c5UQwfg317F': { roi: '32%', wr: '91%', days: 5, pnl: 12.08, medianRoi: '17%', tokens: 22, buys: 22, medianHold: 'N/A' },
    '9WeTRsLdrjSSNquSqNvSy8VDii4u5E5adpJ2smx7GVyM': { roi: '42%', wr: '92%', days: 7, pnl: 19.09, medianRoi: '33%', tokens: 28, buys: 28, medianHold: 'N/A' },
    '5qGHKFKnoR3Q95p4EPmoVR8FeH4Vrkag21YYGHdrQrn': { roi: '30%', wr: '93%', days: 21 /*approx*/, pnl: 6.50, medianRoi: '24%', tokens: 18, buys: 18, medianHold: 'N/A' },
    'Aud9afBrEvPxF3teiF5FtZcq4MD1HMDb1MZShQJMu1DZ': { roi: '93%', wr: '95%', days: 21 /*approx*/, pnl: 18.52, medianRoi: '78%', tokens: 19, buys: 19, medianHold: 'N/A' },
    'Cf3Ja9hAXPCpJvRZuTtL1LPyZFrKfHyA1uXybYpcBDEV': { roi: '58%', wr: '90%', days: 21 /*approx*/, pnl: 20.61, medianRoi: '105%', tokens: 23, buys: 23, medianHold: 'N/A' },
    'FvYsGPiQoG5A7aQsbQM7bR3VdjY2TKeG8xLwhBQMNQWY': { roi: '168%', wr: '100%', days: 21 /*from page 32*/, pnl: 73.03, medianRoi: '206%', tokens: 6, buys: 6, medianHold: 'N/A' },
    'G9hxBRpp4iDtzrbYuMibM4UQZyTmmhJY9ci2i2mPdTw2': { roi: '106%', wr: '100%', days: 21 /*approx*/, pnl: 23.41, medianRoi: '120%', tokens: 5, buys: 5, medianHold: 'N/A' },
  },
};

const STABLES = new Set([CONFIG.USDC_MINT, CONFIG.USDT_MINT]);
const WALLET_LIST = Object.keys(CONFIG.TRACKED_WALLETS);

// ============================================================
// STATE
// ============================================================
const state = {
  wallet: null,
  connection: null,
  lastSigs: new Map(),
  isRunning: false,
  alertCount: 0,
};

// ============================================================
// UTILITIES
// ============================================================
function log(level, msg, data = {}) {
  const ts = new Date().toISOString();
  const icons = { INFO: '📡', ALERT: '🔔', WARN: '⚠️', ERROR: '❌', GROK: '🤖' };
  const extra = Object.keys(data).length ? ' ' + JSON.stringify(data) : '';
  console.log(`[${ts}] ${icons[level] || '📋'} [${level}] ${msg}${extra}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getTokenPrice(mint) {
  try {
    const res = await fetch(`${CONFIG.JUPITER_PRICE}?ids=${mint}`);
    if (!res.ok) return 0;
    const data = await res.json();
    return parseFloat(data?.data?.[mint]?.price || 0);
  } catch (e) { return 0; }
}

async function getTokenInfo(mint) {
  // Try to get token name from Jupiter
  try {
    const res = await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mint}`);
    if (res.ok) {
      const data = await res.json();
      return { name: data.name || 'Unknown', symbol: data.symbol || '???', decimals: data.decimals || 9 };
    }
  } catch (e) { /* fallback */ }
  return { name: 'Unknown Token', symbol: '???', decimals: 9 };
}

async function sendDiscord(content) {
  if (!CONFIG.DISCORD_WEBHOOK) { log('WARN', 'No Discord webhook configured'); return; }
  try {
    // Discord max is 2000 chars
    const truncated = content.length > 1990 ? content.slice(0, 1990) + '...' : content;
    await fetch(CONFIG.DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: truncated }),
    });
  } catch (e) {
    log('ERROR', 'Discord send failed', { error: e.message });
  }
}

// ============================================================
// GROK AI ANALYSIS
// ============================================================
async function getGrokAnalysis(swap, walletAddr, walletStats, tokenInfo, tokenPrice) {
  if (!CONFIG.GROK_API_KEY) {
    log('WARN', 'No GROK_API_KEY — skipping AI analysis');
    return null;
  }

  const prompt = `You are an AI trading analyst for a Solana memecoin copy-trading bot. A tracked wallet just made a trade. Analyze it and give a recommendation.

CONTEXT: I'm running a copy-trading bot with about $25 worth of SOL (~0.18 SOL). I track proven profitable wallets from Dune Analytics and get alerts when they trade. My standard buy is about 25% of my wallet (~$6). I need you to tell me if I should follow this trade, how much of my wallet to put in, and how long to hold.

TRADE SIGNAL:
- Direction: ${swap.direction.toUpperCase()}
- Token: ${tokenInfo.name} (${tokenInfo.symbol})
- Token Mint: ${swap.tokenMint}
- SOL Amount the trader used: ${swap.solAmount.toFixed(4)} SOL
- Token Price: $${tokenPrice ? tokenPrice.toFixed(8) : 'unknown'}

TRADER WALLET STATS (from Dune Analytics, last 30 days):
- Wallet: ${walletAddr}
- Overall ROI: ${walletStats.roi}
- Win Rate: ${walletStats.wr}
- Wallet Age: ${walletStats.days} days
- Total PnL: ${walletStats.pnl} SOL profit
- Median ROI per trade: ${walletStats.medianRoi}
- Distinct Tokens Traded: ${walletStats.tokens}
- Median Hold Time: ${walletStats.medianHold}

POSITION SIZING GUIDE:
- 15-20% of wallet = low confidence (sketchy token, mediocre trader stats)
- 25% of wallet = standard confidence (decent trader, normal signal)
- 30-40% of wallet = high confidence (elite trader + strong momentum)
- 50%+ of wallet = very high confidence (100% WR trader + perfect setup)
Never recommend more than 60%.

RESPOND IN EXACTLY THIS FORMAT (no extra text):
SCORE: [number 0-100]
VERDICT: [BUY/SKIP]
POSITION: [percentage of wallet to invest, like "25%" or "40%"]
HOLD TIME: [estimated hold duration like "30 minutes" or "2 hours"]
REASONING: [1-2 sentences max explaining why]`;

  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.GROK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'grok-3-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.3,
      }),
    });

    if (!res.ok) {
      log('ERROR', `Grok API error: ${res.status}`);
      return null;
    }

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) return null;

    // Parse the response
    const scoreMatch = reply.match(/SCORE:\s*(\d+)/i);
    const verdictMatch = reply.match(/VERDICT:\s*(BUY|SKIP)/i);
    const positionMatch = reply.match(/POSITION:\s*(\d+)%?/i);
    const holdMatch = reply.match(/HOLD TIME:\s*(.+)/i);
    const reasonMatch = reply.match(/REASONING:\s*(.+)/is);

    return {
      score: scoreMatch ? parseInt(scoreMatch[1]) : 50,
      verdict: verdictMatch ? verdictMatch[1].toUpperCase() : 'UNKNOWN',
      positionPct: positionMatch ? parseInt(positionMatch[1]) : 25,
      holdTime: holdMatch ? holdMatch[1].trim() : 'Unknown',
      reasoning: reasonMatch ? reasonMatch[1].trim().split('\n')[0] : reply.slice(0, 200),
      raw: reply,
    };
  } catch (e) {
    log('ERROR', 'Grok analysis failed', { error: e.message });
    return null;
  }
}

// ============================================================
// SWAP PARSER
// ============================================================
function parseSwap(tx, walletAddress) {
  try {
    const meta = tx.meta;
    const message = tx.transaction?.message;
    if (!meta || !message || meta.err) return null;

    const accountKeys = message.accountKeys?.map(k => k.pubkey || k) || [];
    const logs = meta.logMessages || [];
    const isDex = accountKeys.includes(CONFIG.JUPITER_PROGRAM) ||
                  accountKeys.includes(CONFIG.RAYDIUM_AMM) ||
                  logs.some(l => l.includes('Instruction: Swap') || l.includes('Instruction: Route'));
    if (!isDex) return null;

    const walletIdx = Math.max(0, accountKeys.indexOf(walletAddress));
    const solChange = ((meta.postBalances?.[walletIdx] || 0) - (meta.preBalances?.[walletIdx] || 0)) / 1e9;

    const pre = meta.preTokenBalances || [];
    const post = meta.postTokenBalances || [];
    const allMints = new Set();
    for (const b of [...pre, ...post]) {
      if (b.owner === walletAddress && b.mint && b.mint !== CONFIG.SOL_MINT && !STABLES.has(b.mint)) {
        allMints.add(b.mint);
      }
    }

    let tokenMint = null, tokenChange = 0;
    for (const mint of allMints) {
      const preB = pre.find(p => p.owner === walletAddress && p.mint === mint);
      const postB = post.find(p => p.owner === walletAddress && p.mint === mint);
      const change = parseFloat(postB?.uiTokenAmount?.uiAmount || 0) - parseFloat(preB?.uiTokenAmount?.uiAmount || 0);
      if (Math.abs(change) > 0.000001) { tokenMint = mint; tokenChange = change; break; }
    }

    if (!tokenMint) return null;
    return {
      tokenMint,
      direction: tokenChange > 0 ? 'buy' : 'sell',
      solAmount: Math.abs(solChange) || 0.001,
      tokenAmount: Math.abs(tokenChange),
      timestamp: tx.blockTime,
      signature: tx.transaction?.signatures?.[0],
    };
  } catch (e) { return null; }
}

// ============================================================
// ALERT BUILDER — Format Discord message
// ============================================================
async function sendTradeAlert(swap, walletAddr) {
  const walletStats = CONFIG.TRACKED_WALLETS[walletAddr] || {};
  const tokenInfo = await getTokenInfo(swap.tokenMint);
  const tokenPrice = await getTokenPrice(swap.tokenMint);
  const solPrice = await getTokenPrice(CONFIG.SOL_MINT);
  const isBuy = swap.direction === 'buy';

  // Get trader's current SOL balance to calculate % of wallet they used
  let traderBalance = 0;
  let traderPctUsed = null;
  try {
    const balRes = await fetch(CONFIG.HELIUS_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [walletAddr] }),
    });
    const balData = await balRes.json();
    traderBalance = (balData?.result?.value || 0) / 1e9;
    // Their balance AFTER the trade + what they spent = their balance BEFORE
    const balanceBefore = traderBalance + (isBuy ? swap.solAmount : -swap.solAmount);
    if (balanceBefore > 0) {
      traderPctUsed = ((swap.solAmount / balanceBefore) * 100).toFixed(1);
    }
  } catch (e) { /* skip balance check */ }

  state.alertCount++;

  // Get Grok analysis for BUY signals
  let grokResult = null;
  if (isBuy) {
    log('GROK', `Analyzing ${tokenInfo.symbol} buy from ${walletAddr.slice(0, 8)}...`);
    grokResult = await getGrokAnalysis(swap, walletAddr, walletStats, tokenInfo, tokenPrice);
  }

  // Build Discord message
  const emoji = isBuy ? '🟢 BUY' : '🔴 SELL';
  const scoreEmoji = grokResult
    ? (grokResult.score >= 70 ? '🔥' : grokResult.score >= 50 ? '⚡' : '⚠️')
    : '';

  const solUsd = solPrice ? (swap.solAmount * solPrice).toFixed(2) : '?';
  const traderBalUsd = (solPrice && traderBalance) ? (traderBalance * solPrice).toFixed(2) : '?';

  let msg = ``;
  msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `${emoji} ALERT #${state.alertCount}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `**Token:** ${tokenInfo.name} (${tokenInfo.symbol})\n`;
  msg += `**Mint:** \`${swap.tokenMint}\`\n`;
  msg += `**Price:** $${tokenPrice ? tokenPrice.toFixed(8) : 'N/A'}\n`;
  msg += `**Tx:** https://solscan.io/tx/${swap.signature}\n`;
  msg += `\n`;
  msg += `**💸 Trade Size:** ${swap.solAmount.toFixed(4)} SOL (~$${solUsd})`;
  if (traderPctUsed) {
    msg += ` — **${traderPctUsed}% of their wallet**`;
  }
  msg += `\n`;
  msg += `**👤 Trader:** \`${walletAddr.slice(0, 12)}...\`\n`;
  msg += `**💰 Their Balance:** ${traderBalance.toFixed(2)} SOL (~$${traderBalUsd})\n`;
  msg += `**ROI:** ${walletStats.roi || 'N/A'} | **WR:** ${walletStats.wr || 'N/A'} | **Age:** ${walletStats.days || '?'}d\n`;
  msg += `**PnL:** ${walletStats.pnl || '?'} SOL | **Med ROI:** ${walletStats.medianRoi || 'N/A'}\n`;
  msg += `**Hold:** ${walletStats.medianHold || 'N/A'} | **Tokens:** ${walletStats.tokens || '?'}\n`;

  if (grokResult) {
    const dollarEstimate = (25 * grokResult.positionPct / 100).toFixed(2);
    msg += `\n`;
    msg += `${scoreEmoji} **GROK SCORE: ${grokResult.score}/100** → **${grokResult.verdict}**\n`;
    msg += `💵 **Suggested Size:** ${grokResult.positionPct}% of wallet (~$${dollarEstimate})\n`;
    msg += `⏱️ **Hold Estimate:** ${grokResult.holdTime}\n`;
    msg += `💬 ${grokResult.reasoning}\n`;
  }

  msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

  // Log locally
  log('ALERT', `${emoji} ${tokenInfo.symbol} from ${walletAddr.slice(0, 8)}...`, {
    sol: swap.solAmount.toFixed(4),
    traderPct: traderPctUsed || 'N/A',
    grokScore: grokResult?.score || 'N/A',
    verdict: grokResult?.verdict || 'N/A',
  });

  // Send to Discord
  await sendDiscord(msg);
}

// ============================================================
// POLLING LOOP
// ============================================================
async function initLastSigs() {
  log('INFO', `Initializing ${WALLET_LIST.length} wallets...`);
  for (const addr of WALLET_LIST) {
    try {
      const res = await fetch(CONFIG.HELIUS_RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [addr, { limit: 1 }] }),
      });
      const data = await res.json();
      const sig = data?.result?.[0]?.signature;
      if (sig) state.lastSigs.set(addr, sig);
      await sleep(100);
    } catch (e) { /* skip */ }
  }
  log('INFO', `Ready. Tracking ${state.lastSigs.size}/${WALLET_LIST.length} wallets.`);
}

async function pollWallets() {
  log('INFO', '👀 Watching for trades...');
  let cycleCount = 0;
  while (state.isRunning) {
    cycleCount++;
    let checked = 0;
    let newTxCount = 0;
    let swapCount = 0;

    for (const addr of WALLET_LIST) {
      try {
        const res = await fetch(CONFIG.HELIUS_RPC, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [addr, { limit: 3 }] }),
        });
        const data = await res.json();
        const sigs = data?.result || [];
        const lastKnown = state.lastSigs.get(addr);
        const newSigs = [];
        for (const sig of sigs) {
          if (sig.signature === lastKnown) break;
          if (!sig.err) newSigs.push(sig);
        }
        checked++;

        if (newSigs.length > 0) {
          newTxCount += newSigs.length;
          state.lastSigs.set(addr, newSigs[0].signature);
          log('INFO', `🔍 ${addr.slice(0, 8)}... has ${newSigs.length} new tx(s) — checking...`);

          for (const sig of newSigs) {
            try {
              const txRes = await fetch(CONFIG.HELIUS_RPC, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] }),
              });
              const txData = await txRes.json();
              if (!txData?.result) { log('INFO', `  ↳ tx ${sig.signature.slice(0, 12)}... — no data`); continue; }
              const swap = parseSwap(txData.result, addr);
              if (!swap) { log('INFO', `  ↳ tx ${sig.signature.slice(0, 12)}... — not a swap`); continue; }

              swapCount++;
              // Send alert to Discord + Grok analysis
              await sendTradeAlert(swap, addr);
              await sleep(500);
            } catch (e) { /* skip */ }
          }
        }
        await sleep(150);
      } catch (e) { /* skip */ }
    }

    // Log every 10 cycles (~40s) so you can see it's alive
    if (cycleCount % 10 === 0) {
      log('INFO', `📊 Poll cycle #${cycleCount} | Checked ${checked}/${WALLET_LIST.length} wallets | ${newTxCount} new txs | ${swapCount} swaps detected`);
    }

    await sleep(CONFIG.POLL_INTERVAL_MS);
  }
}

// ============================================================
// HEALTH
// ============================================================
async function healthLoop() {
  while (state.isRunning) {
    console.log('\n' + '═'.repeat(50));
    console.log('  🤖 WINSTON v9.2 — Alert Mode');
    console.log('═'.repeat(50));
    console.log(`  👀 Tracking: ${WALLET_LIST.length} wallets`);
    console.log(`  🔔 Alerts sent: ${state.alertCount}`);
    console.log(`  🤖 Grok: ${CONFIG.GROK_API_KEY ? 'Active' : 'NOT CONFIGURED'}`);
    console.log(`  📢 Discord: ${CONFIG.DISCORD_WEBHOOK ? 'Active' : 'NOT CONFIGURED'}`);
    console.log('═'.repeat(50) + '\n');
    await sleep(CONFIG.HEALTH_LOG_INTERVAL_MS);
  }
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║    🤖 WINSTON v9.2 — Alert + Grok Analysis Bot       ║');
  console.log('║      No Auto-Trade • Discord Alerts • AI Scoring      ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  if (!CONFIG.HELIUS_API_KEY) { log('ERROR', 'HELIUS_API_KEY required'); process.exit(1); }
  if (!CONFIG.DISCORD_WEBHOOK) { log('ERROR', 'DISCORD_WEBHOOK_URL required for alert mode'); process.exit(1); }
  if (!CONFIG.GROK_API_KEY) { log('WARN', '⚠️ GROK_API_KEY not set — alerts will work but without AI analysis'); }

  // Wallet init (still needed for Helius auth, not for trading)
  if (CONFIG.PRIVATE_KEY) {
    try {
      state.wallet = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
      log('INFO', `Wallet: ${state.wallet.publicKey.toString()}`);
    } catch (e) { log('WARN', 'Private key invalid — running in alert-only mode'); }
  }

  state.connection = new Connection(CONFIG.HELIUS_RPC, { commitment: 'confirmed' });
  state.isRunning = true;

  await initLastSigs();

  log('INFO', `🚀 Live — alerting on ${WALLET_LIST.length} Dune top traders`);
  await sendDiscord(`🚀 **Winston v9.2 Online** | Alert Mode | Watching ${WALLET_LIST.length} wallets | Grok AI: ${CONFIG.GROK_API_KEY ? '✅' : '❌'}`);

  const shutdown = async () => {
    state.isRunning = false;
    log('INFO', `🛑 Shutdown. Sent ${state.alertCount} alerts this session.`);
    await sendDiscord(`🛑 Winston offline. Sent ${state.alertCount} alerts.`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await Promise.all([pollWallets(), healthLoop()]);
}

main().catch(e => { log('ERROR', 'Fatal', { error: e.message }); process.exit(1); });
