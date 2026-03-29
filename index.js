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
  // ============================================================
  TRACKED_WALLETS: {
    'FRhgF9TXCXyGfUiQ5WsdCGxHUmBXPseenTdnEA4UmUGi': { roi: '675%', wr: '73%', days: 150, pnl: 68.12, medianRoi: '221%', tokens: 11, medianHold: '02:32:23' },
    '7z8hbNzmgYvRMNVk27TQm8xW3yXgAkwQVhA6Nht5WEkU': { roi: '420%', wr: '90%', days: 299, pnl: 99.88, medianRoi: '108%', tokens: 10, medianHold: '00:00:43' },
    '61MQSdRgpe98pxMn6gcLH4M4MAFr8mAKuoTDFMwbpn6Y': { roi: '466%', wr: '100%', days: 113, pnl: 52.35, medianRoi: '28%', tokens: 9, medianHold: '00:00:10' },
    'AjKCctQtCnCj48tR3YaGm1ZrQtURoodjfg6YKLy97Uub': { roi: '286%', wr: '95%', days: 11, pnl: 75.23, medianRoi: '162%', tokens: 19, medianHold: '00:01:23' },
    'FEXornKkXE2u51WfCGVdEBsmrvquu9UvGPpM9gd986se': { roi: '242%', wr: '100%', days: 99, pnl: 43.32, medianRoi: '66%', tokens: 6, medianHold: '02:22:52' },
    'CsKnRER9Sjpau8Mk9WTZkoBytB2uFnqdmLYR5GTGtaKz': { roi: '324%', wr: '71%', days: 4, pnl: 30.03, medianRoi: '118%', tokens: 7, medianHold: '00:00:29' },
    'ATFRUwvyMh61w2Ab6AZxUyxsAfiiuG1RqL6iv3Vi9q2B': { roi: '208%', wr: '100%', days: 450, pnl: 64.94, medianRoi: '87%', tokens: 7, medianHold: '00:00:37' },
    'GJvBxoj79TqhvyafMpTPyu5CP5rEq2V9LnbfxtDqgYhS': { roi: '215%', wr: '81%', days: 56, pnl: 19.50, medianRoi: '128%', tokens: 16, medianHold: '18:38:21' },
    'F7HXUvhmCjkHM1ePFCSRReXXbnCAKdiJMDFNfH8u8khG': { roi: '215%', wr: '86%', days: 135, pnl: 23.62, medianRoi: '43%', tokens: 21, medianHold: '00:04:06' },
    '9jYMojHaJxyXsvVMN2foih8knXb5AXYkMmUnxjQT5BoJ': { roi: '202%', wr: '77%', days: 11, pnl: 61.24, medianRoi: '17%', tokens: 22, medianHold: '00:00:06' },
    '8gDRLa498xXCdch3DvtvjCJ7C1joJ1BpftTDVZztxigv': { roi: '396%', wr: '50%', days: 16, pnl: 115.34, medianRoi: '1%', tokens: 24, medianHold: '00:01:47' },
    '6wLkK9AKTcCLiB5mW7pyp9Fq9wchydyatk8XtxKdVHgn': { roi: '345%', wr: '60%', days: 297, pnl: 81.94, medianRoi: '64%', tokens: 10, medianHold: '00:00:43' },
    'AnWgJ1csbod2tWS2mZNEyhxo1XWndhNVvzbchh81zZ8k': { roi: '404%', wr: '57%', days: 3, pnl: 190.98, medianRoi: '43%', tokens: 14, medianHold: '00:00:44' },
    '2M4Ka8W5i7eK9Z3zMpzbeYRsAVM4HtpwhtTnbmPDdiMn': { roi: '324%', wr: '60%', days: 8, pnl: 17.79, medianRoi: '12%', tokens: 10, medianHold: '00:07:28' },
    'H5G1btoS96YZ6fcaDDhAo99A9p4RkenV9XKLw2aPCeaF': { roi: '228%', wr: '50%', days: 5, pnl: 39.50, medianRoi: '1%', tokens: 16, medianHold: '00:33:26' },
    'FYfSEsc5DxwKH2LbxNpWE9KiGvajN8bYVHSe1mk4oSDy': { roi: '204%', wr: '60%', days: 45, pnl: 10.82, medianRoi: '44%', tokens: 5, medianHold: '06:22:07' },
    '5VXyg5nXWtpjsNQvt6EXQPQ5ziZBnxhoXDYaz9ZBbXao': { roi: '199%', wr: '100%', days: 529, pnl: 14.52, medianRoi: '83%', tokens: 7, medianHold: 'N/A' },
    'FvYsGPiQoG5A7aQsbQM7bR3VdjY2TKeG8xLwhBQMNQWY': { roi: '168%', wr: '100%', days: 237, pnl: 73.03, medianRoi: '206%', tokens: 6, medianHold: 'N/A' },
    'EY8kS2GvTL4vQmQFi6nN2dnGJSFQhwmEMdktYpyLRvtP': { roi: '167%', wr: '85%', days: 79, pnl: 47.94, medianRoi: '14%', tokens: 14, medianHold: 'N/A' },
    'HXhnm8S1pd1KYjoYKrTFLAHnw6ED7nkrp3SmGGddtoLD': { roi: '167%', wr: '60%', days: 137, pnl: 50.53, medianRoi: '101%', tokens: 12, medianHold: 'N/A' },
    'BZWzvFQrqbT5Tb1T4F73SWKhM5auiPMDo9agb456HLTC': { roi: '156%', wr: '100%', days: 46, pnl: 16.32, medianRoi: '65%', tokens: 9, medianHold: 'N/A' },
    '6WLquntFTiEh84JvH3R6fA1k5PQLSUouY7CmEMQwaj34': { roi: '153%', wr: '55%', days: 71, pnl: 38.00, medianRoi: '1%', tokens: 13, medianHold: 'N/A' },
    '4i88267TQpasJoL3Zv5C9Szq9XctMSHExmmQMWgBbFeB': { roi: '152%', wr: '60%', days: 90, pnl: 13.91, medianRoi: '8%', tokens: 7, medianHold: 'N/A' },
    '4ypxvwdjg7wDvEFLkhKBqCioRmDtKzu1z55C1Sah12Xv': { roi: '151%', wr: '100%', days: 482, pnl: 32.85, medianRoi: '147%', tokens: 8, medianHold: 'N/A' },
    'DJGm2u3ZRJJaaobyPPDQB9dvpaKTutUo5y4CdxoywRBJ': { roi: '121%', wr: '100%', days: 303, pnl: 58.69, medianRoi: '115%', tokens: 10, medianHold: 'N/A' },
    '2FzChsNvEqRvX36jy4Gvpu9Xjv1pk6TBJct7pPVyeTJL': { roi: '119%', wr: '77%', days: 674, pnl: 21.32, medianRoi: '89%', tokens: 14, medianHold: 'N/A' },
    'AqpY5YrdXqsYyhCrXkSwqD6G8Umi1PL8hz4MJkjizrA7w': { roi: '118%', wr: '73%', days: 58, pnl: 47.59, medianRoi: '17%', tokens: 16, medianHold: 'N/A' },
    '85Aq4c1xQUDcHbb7z521pKysZVpf1YTXiZodkK9nPhov': { roi: '116%', wr: '56%', days: 133, pnl: 12.94, medianRoi: '5%', tokens: 17, medianHold: 'N/A' },
    'FPp4xGY1pnCnGx1zDgiykUW9sssaY8kgkQBZrLCi1drD': { roi: '115%', wr: '57%', days: 680, pnl: 15.12, medianRoi: '18%', tokens: 11, medianHold: 'N/A' },
    'GvAyrpEM88uMYLp8QLUf7SRfqfsLNBEFhLctj2Hn8y9P': { roi: '131%', wr: '100%', days: 91, pnl: 39.88, medianRoi: '128%', tokens: 9, medianHold: 'N/A' },
    '12KuEro7Cr7WjjxKTQ56TPdmUfVSuP6z7otP9KnNHWhK': { roi: '126%', wr: '60%', days: 200, pnl: 8.64, medianRoi: '68%', tokens: 8, medianHold: 'N/A' },
    '6LZs9rk7nKQWYgeb6XnUvLp8XaMyQdaog2VU87dsPuSj': { roi: '87%', wr: '100%', days: 41, pnl: 37.67, medianRoi: '78%', tokens: 8, medianHold: 'N/A' },
    'HCFg8YVKJJycWjnnu4GJoHjsrpwffHvwNhXVHUezVyyM': { roi: '85%', wr: '80%', days: 50, pnl: 18.16, medianRoi: '92%', tokens: 10, medianHold: 'N/A' },
    '2xdqw5qvFovVwUJgAUJzcKNvy3qXgAhPSZHVu6hcFyZM': { roi: '82%', wr: '91%', days: 131, pnl: 17.11, medianRoi: '14%', tokens: 18, medianHold: 'N/A' },
    'EJEWyg2ZLmCq1uyKeWZz9L7z6FQWJCyP5pNR3smD6RXu': { roi: '105%', wr: '58%', days: 763, pnl: 19.18, medianRoi: '19%', tokens: 22, medianHold: 'N/A' },
    '5PiqYRfJDhS8sMjRyBXW3eyTtfh7GgAuYWFtqaRdDH9T': { roi: '102%', wr: '67%', days: 290, pnl: 15.22, medianRoi: '13%', tokens: 15, medianHold: 'N/A' },
    'ArAh8V2UwkgGP12j2wpNMJHCVm4ZEoCHtKd2fXCKKi1K': { roi: '102%', wr: '80%', days: 202, pnl: 12.96, medianRoi: '15%', tokens: 13, medianHold: 'N/A' },
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
  while (state.isRunning) {
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

        if (newSigs.length > 0) {
          state.lastSigs.set(addr, newSigs[0].signature);
          for (const sig of newSigs) {
            try {
              const txRes = await fetch(CONFIG.HELIUS_RPC, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] }),
              });
              const txData = await txRes.json();
              if (!txData?.result) continue;
              const swap = parseSwap(txData.result, addr);
              if (!swap) continue;

              // Send alert to Discord + Grok analysis
              await sendTradeAlert(swap, addr);
              await sleep(500);
            } catch (e) { /* skip */ }
          }
        }
        await sleep(150);
      } catch (e) { /* skip */ }
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
