// ============================================================
// WINSTON v9.3 — Helius Enhanced TX + Grok Alert Bot
// ============================================================
// Uses Helius Enhanced Transactions API to detect swaps across
// ALL Solana DEXes (Jupiter, Raydium, Orca, Meteora, Pump.fun).
// Sends Discord alerts with Grok AI analysis.
// ============================================================

require('dotenv').config();
const { Connection, Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');

const CONFIG = {
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  get HELIUS_RPC() { return `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },
  get HELIUS_TX_API() { return `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${this.HELIUS_API_KEY}`; },
  get HELIUS_HISTORY_API() { return (addr) => `https://api-mainnet.helius-rpc.com/v0/addresses/${addr}/transactions?api-key=${this.HELIUS_API_KEY}&type=SWAP&limit=1`; },
  PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || '',
  GROK_API_KEY: process.env.GROK_API_KEY || '',
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || '',
  JUPITER_PRICE: 'https://lite-api.jup.ag/price/v2',
  SOL_MINT: 'So11111111111111111111111111111111111111112',
  POLL_INTERVAL_MS: 3000,
  HEALTH_LOG_INTERVAL_MS: 300000,

  // Combined wallet list: young active + proven older wallets
  // Each has Dune stats for Grok context
  WALLETS: {
    // === YOUNG & ACTIVE (≤21 days, actively trading) ===
    '8gDRLa498xXCdch3DvtvjCJ7C1joJ1BpftTDVZztxigv': { roi:'396%', wr:'50%', days:16, pnl:115.34, medRoi:'1%', buys:27 },
    'AjKCctQtCnCj48tR3YaGm1ZrQtURoodjfg6YKLy97Uub': { roi:'286%', wr:'95%', days:11, pnl:75.23, medRoi:'162%', buys:19 },
    '9p7PFT2HYhVKXDsvCZd43d8GRm1jQcWBH7tmawe96b6X': { roi:'237%', wr:'67%', days:12, pnl:28.30, medRoi:'8%', buys:23 },
    '3bLSiJ7RTMqypwhNqu6zNC2jcoQdknnGd5Y7feoaPXT9': { roi:'229%', wr:'50%', days:12, pnl:33.01, medRoi:'4%', buys:23 },
    'H5G1btoS96YZ6fcaDDhAo99A9p4RkenV9XKLw2aPCeaF': { roi:'228%', wr:'50%', days:5, pnl:39.50, medRoi:'1%', buys:18 },
    '9jYMojHaJxyXsvVMN2foih8knXb5AXYkMmUnxjQT5BoJ': { roi:'202%', wr:'77%', days:11, pnl:61.24, medRoi:'17%', buys:24 },
    '8DqpugHmWXVcSAYaZs9W2jXnCE4Cx1XbNMsZYC8EU1JV': { roi:'237%', wr:'60%', days:10, pnl:21.99, medRoi:'91%', buys:6 },
    '2M4Ka8W5i7eK9Z3zMpzbeYRsAVM4HtpwhtTnbmPDdiMn': { roi:'324%', wr:'60%', days:8, pnl:17.79, medRoi:'12%', buys:10 },
    'AnWgJ1csbod2tWS2mZNEyhxo1XWndhNVvzbchh81zZ8k': { roi:'404%', wr:'57%', days:3, pnl:190.98, medRoi:'43%', buys:14 },
    'CsKnRER9Sjpau8Mk9WTZkoBytB2uFnqdmLYR5GTGtaKz': { roi:'324%', wr:'71%', days:4, pnl:30.03, medRoi:'118%', buys:7 },
    '4ScXhkEPVkxhzcJdp89oybDH5LA4iCocxAn1u3oLmvbK': { roi:'496%', wr:'60%', days:8, pnl:37.86, medRoi:'2%', buys:14 },
    'CPQHDdLszLoagjM6MbM4S7DCiT3p4XC2zoe6CHJETanB': { roi:'651%', wr:'100%', days:1, pnl:116.12, medRoi:'86%', buys:6 },
    '81dtsioFgo7Y3Mes6oPaDiUdUGcYjsUx3XAnAfynD3mk': { roi:'43%', wr:'86%', days:6, pnl:18.24, medRoi:'39%', buys:26 },
    '8GPswY8JZddPqcnyur4asSSpUnTQ17rfRsDdnnPMZuNt': { roi:'37%', wr:'89%', days:6, pnl:16.85, medRoi:'44%', buys:20 },
    'DMYZW5Krh3c8Jf7R2GZ6Ftm9qNeoy1payx5ZoRpvCiXc': { roi:'112%', wr:'89%', days:6, pnl:14.99, medRoi:'6%', buys:10 },
    '9WeTRsLdrjSSNquSqNvSy8VDii4u5E5adpJ2smx7GVyM': { roi:'42%', wr:'92%', days:7, pnl:19.09, medRoi:'33%', buys:28 },
    '3qau7RJjDAszMVY3W6dDsBtuqNUeTnP8YMqyXv3kocn3': { roi:'65%', wr:'83%', days:9, pnl:14.92, medRoi:'103%', buys:20 },
    '2Y9cjafAkHjyo4Ge7GKxa2nkpMh1tVwKuFAoXxhQCXmX': { roi:'43%', wr:'85%', days:9, pnl:15.37, medRoi:'29%', buys:13 },
    '8GPswY8JZddPqcnyur4asSSpUnTQ17rfRsDdnnPMZuNt': { roi:'37%', wr:'89%', days:6, pnl:16.85, medRoi:'44%', buys:20 },
    '2FFnhYefCdARYfyiTY2GR7ZKA72Wt9QgY5ZEn7j1udUQ': { roi:'32%', wr:'82%', days:0, pnl:4.74, medRoi:'25%', buys:25 },
    '4PH7LPnrwC9y2xz6F8RNcPSa6MhVk5CV5mmGZCqe8WU6': { roi:'99%', wr:'80%', days:7, pnl:17.77, medRoi:'41%', buys:20 },
    '92ShpinZecEtxeR4ar9sKNCjveqfws1f2Dq99ec9wDkY': { roi:'74%', wr:'80%', days:6, pnl:13.32, medRoi:'85%', buys:23 },
    'CJSduQc6GLrNCpE4w8LigAb5AynNCc6142jP1u71kmLJ': { roi:'56%', wr:'88%', days:7, pnl:9.28, medRoi:'32%', buys:19 },
    'DE4btrVmoq2CLWbQLWmL8yq4qC3daiBMsxwNdcsXa9cw': { roi:'56%', wr:'83%', days:13, pnl:9.14, medRoi:'24%', buys:8 },
    'AFs5DZ92CZ8PCfwFE9WPrp9Ac6nmfq184Tao6Dx1C4rq': { roi:'32%', wr:'90%', days:5, pnl:6.29, medRoi:'26%', buys:20 },
    'AADuT157v1xrJPg1xrH2tVbVepxCGvdr6c5UQwfg317F': { roi:'32%', wr:'91%', days:5, pnl:12.08, medRoi:'17%', buys:22 },
    '8GPsWY8JZddPqcnyur4asSSpUnTQ17rfRsDdnnPMZuNt': { roi:'44%', wr:'89%', days:6, pnl:16.85, medRoi:'44%', buys:20 },

    // === PROVEN OLDER (>21d but high ROI, confirmed active recently) ===
    'FRhgF9TXCXyGfUiQ5WsdCGxHUmBXPseenTdnEA4UmUGi': { roi:'675%', wr:'73%', days:150, pnl:68.12, medRoi:'221%', buys:13 },
    '7z8hbNzmgYvRMNVk27TQm8xW3yXgAkwQVhA6Nht5WEkU': { roi:'420%', wr:'90%', days:299, pnl:99.88, medRoi:'108%', buys:10 },
    '61MQSdRgpe98pxMn6gcLH4M4MAFr8mAKuoTDFMwbpn6Y': { roi:'466%', wr:'100%', days:113, pnl:52.35, medRoi:'28%', buys:12 },
    'FEXornKkXE2u51WfCGVdEBsmrvquu9UvGPpM9gd986se': { roi:'242%', wr:'100%', days:99, pnl:43.32, medRoi:'66%', buys:12 },
    'ATFRUwvyMh61w2Ab6AZxUyxsAfiiuG1RqL6iv3Vi9q2B': { roi:'208%', wr:'100%', days:450, pnl:64.94, medRoi:'87%', buys:13 },
    'GJvBxoj79TqhvyafMpTPyu5CP5rEq2V9LnbfxtDqgYhS': { roi:'215%', wr:'81%', days:56, pnl:19.50, medRoi:'128%', buys:29 },
    'F7HXUvhmCjkHM1ePFCSRReXXbnCAKdiJMDFNfH8u8khG': { roi:'215%', wr:'86%', days:135, pnl:23.62, medRoi:'43%', buys:25 },
    '6wLkK9AKTcCLiB5mW7pyp9Fq9wchydyatk8XtxKdVHgn': { roi:'345%', wr:'60%', days:297, pnl:81.94, medRoi:'64%', buys:10 },
    'FYfSEsc5DxwKH2LbxNpWE9KiGvajN8bYVHSe1mk4oSDy': { roi:'204%', wr:'60%', days:45, pnl:10.82, medRoi:'44%', buys:5 },
    '5vXih4GeYcfQv88R59B5sZaRYEwJzorKpCGhqjAmqTqu': { roi:'177%', wr:'83%', days:503, pnl:24.32, medRoi:'126%', buys:8 },
    'Gc2WT9QnTCLffWc88nKXwtqKVWh7djZeMy9yqZYXevi1': { roi:'174%', wr:'86%', days:39, pnl:16.38, medRoi:'25%', buys:7 },
    'FvYsGPiQoG5A7aQsbQM7bR3VdjY2TKeG8xLwhBQMNQWY': { roi:'168%', wr:'100%', days:237, pnl:73.03, medRoi:'206%', buys:6 },
    'HXhnm8S1pd1KYjoYKrTFLAHnw6ED7nkrp3SmGGddtoLD': { roi:'167%', wr:'60%', days:137, pnl:50.53, medRoi:'101%', buys:12 },
    'BZWzvFQrqbT5Tb1T4F73SWKhM5auiPMDo9agb456HLTC': { roi:'156%', wr:'100%', days:46, pnl:16.32, medRoi:'65%', buys:9 },
    'EoC9UDaX4PgMPS49gnLkFJVjX4eoBWPi6iXAUZGwdTPj': { roi:'153%', wr:'58%', days:35, pnl:28.63, medRoi:'35%', buys:13 },
    'DJGm2u3ZRJJaaobyPPDQB9dvpaKTutUo5y4CdxoywRBJ': { roi:'121%', wr:'100%', days:303, pnl:58.69, medRoi:'115%', buys:10 },
    '2FzChsNvEqRvX36jy4Gvpu9Xjv1pk6TBJct7pPVyeTJL': { roi:'119%', wr:'77%', days:674, pnl:21.32, medRoi:'89%', buys:14 },
    'Aud9afBrEvPxF3teiF5FtZcq4MD1HMDb1MZShQJMu1DZ': { roi:'93%', wr:'95%', days:229, pnl:18.52, medRoi:'78%', buys:19 },
    'Cf3Ja9hAXPCpJvRZuTtL1LPyZFrKfHyA1uXybYpcBDEV': { roi:'58%', wr:'90%', days:26, pnl:20.61, medRoi:'105%', buys:23 },

    // === HIGH FREQUENCY PAGES 28-32 (active, high WR) ===
    'FX2fNGE3nXaCcuTw4133Nb5CLJqTjzhZGtxSpnSuapX8': { roi:'94%', wr:'82%', days:138, pnl:10.56, medRoi:'80%', buys:16 },
    'ArAh8V2UwkgGP12j2wpNMJHCVm4ZEoCHtKd2fXCKKi1K': { roi:'102%', wr:'80%', days:202, pnl:12.96, medRoi:'15%', buys:13 },
    '5vXih4GeYcfQv88R59B5sZaRYEwJzorKpCGhqjAmqTqu': { roi:'177%', wr:'83%', days:503, pnl:24.32, medRoi:'126%', buys:8 },
    'HbA7fZnpvFKS1ye3d6NFkkSfFghJJK6touZXHPJysAPq': { roi:'104%', wr:'86%', days:243, pnl:11.21, medRoi:'49%', buys:10 },
    'F7HXUvhmCjkHM1ePFCSRReXXbnCAKdiJMDFNfH8u8khG': { roi:'215%', wr:'86%', days:135, pnl:23.62, medRoi:'43%', buys:25 },
    'DEEDBHXhgvno5ddCrwR4jHLJrMQCAEtAPMaMLmKJBNUL': { roi:'75%', wr:'76%', days:474, pnl:19.94, medRoi:'11%', buys:24 },
    'GkNkdM5CxAUjnCyX3XAXv4q7vBqtFWjDcvjP9xCGQkym': { roi:'45%', wr:'86%', days:493, pnl:22.43, medRoi:'23%', buys:9 },
    'HCFg8YVKJJycWjnnu4GJoHjsrpwffHvwNhXVHUezVyyM': { roi:'85%', wr:'80%', days:50, pnl:18.16, medRoi:'92%', buys:10 },
    '5DqXu9GrX8MxWC5WrfDKK924cjdFwVdtDpSGmV6Qr4Yv': { roi:'99%', wr:'77%', days:62, pnl:8.41, medRoi:'6%', buys:13 },
    '8Lh4ESqtGEVxfyYS74sdZzthKS84ZxJrDzJzdeTb46wv': { roi:'29%', wr:'78%', days:67, pnl:22.39, medRoi:'83%', buys:25 },
  },
};

const WALLET_LIST = Object.keys(CONFIG.WALLETS);
const STABLES = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);

const state = { wallet: null, connection: null, lastSigs: new Map(), isRunning: false, alertCount: 0 };

// ============================================================
// UTILITIES
// ============================================================
function log(level, msg, data = {}) {
  const ts = new Date().toISOString();
  const icons = { INFO:'📡', ALERT:'🔔', WARN:'⚠️', ERROR:'❌', GROK:'🤖', SWAP:'💱' };
  const extra = Object.keys(data).length ? ' ' + JSON.stringify(data) : '';
  console.log(`[${ts}] ${icons[level]||'📋'} [${level}] ${msg}${extra}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  return { name: 'Unknown Token', symbol: '???' };
}

async function sendDiscord(content) {
  if (!CONFIG.DISCORD_WEBHOOK) return;
  try {
    const t = content.length > 1990 ? content.slice(0, 1990) + '...' : content;
    await fetch(CONFIG.DISCORD_WEBHOOK, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ content: t }) });
  } catch(e) { log('ERROR', 'Discord failed', { error: e.message }); }
}

// ============================================================
// HELIUS ENHANCED TX PARSER — catches ALL DEX swaps
// ============================================================
async function parseWithHelius(signatures) {
  // Helius Enhanced Transactions API auto-detects swaps across all DEXes
  try {
    const res = await fetch(CONFIG.HELIUS_TX_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: signatures }),
    });
    if (!res.ok) {
      log('WARN', `Helius enhanced TX API error: ${res.status}`);
      return [];
    }
    const parsed = await res.json();
    return parsed || [];
  } catch (e) {
    log('ERROR', 'Helius parse failed', { error: e.message });
    return [];
  }
}

function extractSwapFromEnhanced(tx, walletAddr) {
  // Helius returns type: 'SWAP' for any DEX swap
  if (tx.type !== 'SWAP') return null;
  if (tx.transactionError) return null;

  // Extract token transfers from the swap
  const transfers = tx.tokenTransfers || [];
  const nativeTransfers = tx.nativeTransfers || [];

  let solSpent = 0;
  let solReceived = 0;
  let tokenMint = null;
  let tokenAmount = 0;
  let direction = null;

  // Check native SOL transfers
  for (const t of nativeTransfers) {
    if (t.fromUserAccount === walletAddr) solSpent += (t.amount || 0) / 1e9;
    if (t.toUserAccount === walletAddr) solReceived += (t.amount || 0) / 1e9;
  }

  // Check token transfers for non-SOL, non-stablecoin tokens
  for (const t of transfers) {
    if (STABLES.has(t.mint) || t.mint === CONFIG.SOL_MINT) continue;

    if (t.toUserAccount === walletAddr && t.tokenAmount > 0) {
      // Received tokens = BUY
      tokenMint = t.mint;
      tokenAmount = t.tokenAmount;
      direction = 'buy';
    } else if (t.fromUserAccount === walletAddr && t.tokenAmount > 0) {
      // Sent tokens = SELL
      tokenMint = t.mint;
      tokenAmount = t.tokenAmount;
      direction = 'sell';
    }
  }

  if (!tokenMint || !direction) return null;

  const solAmount = direction === 'buy' ? solSpent : solReceived;

  return {
    tokenMint,
    direction,
    solAmount: solAmount || 0.001,
    tokenAmount,
    signature: tx.signature,
    timestamp: tx.timestamp,
    description: tx.description || '',
    source: tx.source || 'UNKNOWN',
  };
}

// ============================================================
// GROK AI ANALYSIS
// ============================================================
async function getGrokAnalysis(swap, walletAddr, stats, tokenInfo, price) {
  if (!CONFIG.GROK_API_KEY) return null;
  const prompt = `You are an AI trading analyst for a Solana copy-trading bot. A tracked wallet just bought a token. Analyze and recommend.

CONTEXT: I copy-trade with ~$25 SOL. Standard buy = 25% of wallet (~$6). I need: score, verdict, position size, hold time.

TRADE:
- Token: ${tokenInfo.name} (${tokenInfo.symbol}) on ${swap.source}
- Mint: ${swap.tokenMint}
- Trader spent: ${swap.solAmount.toFixed(4)} SOL
- Price: $${price ? price.toFixed(8) : 'unknown'}

TRADER STATS (30d from Dune):
- ROI: ${stats.roi} | Win Rate: ${stats.wr} | Age: ${stats.days}d
- PnL: ${stats.pnl} SOL | Median ROI: ${stats.medRoi} | Buys: ${stats.buys}

POSITION SIZING: 15-20% low confidence, 25% standard, 30-40% high, 50%+ very high (max 60%).

RESPOND EXACTLY:
SCORE: [0-100]
VERDICT: [BUY/SKIP]
POSITION: [percentage like 25%]
HOLD TIME: [duration like "30 minutes"]
REASONING: [1-2 sentences]`;

  try {
    const r = await fetch('https://api.x.ai/v1/chat/completions', {
      method:'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${CONFIG.GROK_API_KEY}` },
      body: JSON.stringify({ model:'grok-3-mini', messages:[{role:'user',content:prompt}], max_tokens:200, temperature:0.3 }),
    });
    if (!r.ok) { log('ERROR', `Grok ${r.status}`); return null; }
    const d = await r.json();
    const reply = d.choices?.[0]?.message?.content?.trim();
    if (!reply) return null;
    return {
      score: parseInt(reply.match(/SCORE:\s*(\d+)/i)?.[1] || 50),
      verdict: (reply.match(/VERDICT:\s*(BUY|SKIP)/i)?.[1] || 'UNKNOWN').toUpperCase(),
      positionPct: parseInt(reply.match(/POSITION:\s*(\d+)/i)?.[1] || 25),
      holdTime: reply.match(/HOLD TIME:\s*(.+)/i)?.[1]?.trim() || 'Unknown',
      reasoning: reply.match(/REASONING:\s*(.+)/is)?.[1]?.trim().split('\n')[0] || reply.slice(0, 200),
    };
  } catch(e) { log('ERROR', 'Grok failed', { error: e.message }); return null; }
}

// ============================================================
// ALERT BUILDER
// ============================================================
async function sendTradeAlert(swap, walletAddr) {
  const stats = CONFIG.WALLETS[walletAddr] || {};
  const tokenInfo = await getTokenInfo(swap.tokenMint);
  const tokenPrice = await getTokenPrice(swap.tokenMint);
  const solPrice = await getTokenPrice(CONFIG.SOL_MINT);
  const isBuy = swap.direction === 'buy';

  // Trader balance + % of wallet used
  let traderBal = 0, traderPct = null;
  try {
    const r = await fetch(CONFIG.HELIUS_RPC, { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({jsonrpc:'2.0',id:1,method:'getBalance',params:[walletAddr]}) });
    const d = await r.json();
    traderBal = (d?.result?.value || 0) / 1e9;
    const before = traderBal + (isBuy ? swap.solAmount : -swap.solAmount);
    if (before > 0) traderPct = ((swap.solAmount / before) * 100).toFixed(1);
  } catch(e) {}

  state.alertCount++;
  let grok = null;
  if (isBuy) {
    log('GROK', `Analyzing ${tokenInfo.symbol} from ${walletAddr.slice(0,8)}...`);
    grok = await getGrokAnalysis(swap, walletAddr, stats, tokenInfo, tokenPrice);
  }

  const emoji = isBuy ? '🟢 BUY' : '🔴 SELL';
  const scoreEmoji = grok ? (grok.score >= 70 ? '🔥' : grok.score >= 50 ? '⚡' : '⚠️') : '';
  const solUsd = solPrice ? (swap.solAmount * solPrice).toFixed(2) : '?';

  let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `${emoji} ALERT #${state.alertCount}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `**Token:** ${tokenInfo.name} (${tokenInfo.symbol})\n`;
  msg += `**Mint:** \`${swap.tokenMint}\`\n`;
  msg += `**DEX:** ${swap.source} | **Price:** $${tokenPrice ? tokenPrice.toFixed(8) : 'N/A'}\n`;
  msg += `\n`;
  msg += `**💸 Trade:** ${swap.solAmount.toFixed(4)} SOL (~$${solUsd})`;
  if (traderPct) msg += ` — **${traderPct}% of wallet**`;
  msg += `\n`;
  msg += `**👤 Trader:** \`${walletAddr.slice(0,12)}...\`\n`;
  msg += `**💰 Balance:** ${traderBal.toFixed(2)} SOL\n`;
  msg += `**ROI:** ${stats.roi||'?'} | **WR:** ${stats.wr||'?'} | **Age:** ${stats.days||'?'}d | **PnL:** ${stats.pnl||'?'} SOL\n`;
  msg += `**Tx:** https://solscan.io/tx/${swap.signature}\n`;

  if (grok) {
    const dollarEst = (25 * grok.positionPct / 100).toFixed(2);
    msg += `\n${scoreEmoji} **GROK: ${grok.score}/100** → **${grok.verdict}**\n`;
    msg += `💵 **Size:** ${grok.positionPct}% (~$${dollarEst}) | ⏱️ **Hold:** ${grok.holdTime}\n`;
    msg += `💬 ${grok.reasoning}\n`;
  }
  msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

  log('ALERT', `${emoji} ${tokenInfo.symbol} via ${swap.source} from ${walletAddr.slice(0,8)}...`, {
    sol: swap.solAmount.toFixed(4), traderPct: traderPct||'N/A', grok: grok?.score||'N/A'
  });
  await sendDiscord(msg);
}

// ============================================================
// POLLING WITH HELIUS ENHANCED PARSING
// ============================================================
async function initLastSigs() {
  log('INFO', `Initializing ${WALLET_LIST.length} wallets...`);
  let ok = 0;
  for (const addr of WALLET_LIST) {
    try {
      const r = await fetch(CONFIG.HELIUS_RPC, { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({jsonrpc:'2.0',id:1,method:'getSignaturesForAddress',params:[addr,{limit:1}]}) });
      const d = await r.json();
      const sig = d?.result?.[0]?.signature;
      if (sig) { state.lastSigs.set(addr, sig); ok++; }
      await sleep(100);
    } catch(e) {}
  }
  log('INFO', `Ready: ${ok}/${WALLET_LIST.length} wallets initialized`);
}

async function pollWallets() {
  log('INFO', '👀 Watching for trades (Helius Enhanced TX parser)...');
  let cycle = 0;
  while (state.isRunning) {
    cycle++;
    let checked = 0, newTxs = 0, swaps = 0;

    for (const addr of WALLET_LIST) {
      try {
        const r = await fetch(CONFIG.HELIUS_RPC, { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({jsonrpc:'2.0',id:1,method:'getSignaturesForAddress',params:[addr,{limit:3}]}) });
        const d = await r.json();
        const sigs = d?.result || [];
        const lastKnown = state.lastSigs.get(addr);
        const newSigs = [];
        for (const s of sigs) { if (s.signature === lastKnown) break; if (!s.err) newSigs.push(s); }
        checked++;

        if (newSigs.length > 0) {
          newTxs += newSigs.length;
          state.lastSigs.set(addr, newSigs[0].signature);
          const sigList = newSigs.map(s => s.signature);

          log('INFO', `🔍 ${addr.slice(0,8)}... → ${newSigs.length} new tx(s)`);

          // Use Helius Enhanced API to parse ALL of them at once
          const parsed = await parseWithHelius(sigList);

          for (const tx of parsed) {
            const swap = extractSwapFromEnhanced(tx, addr);
            if (swap) {
              swaps++;
              log('SWAP', `✅ ${swap.direction.toUpperCase()} detected: ${swap.tokenMint.slice(0,8)}... via ${swap.source}`, {
                sol: swap.solAmount.toFixed(4), wallet: addr.slice(0,8)
              });
              await sendTradeAlert(swap, addr);
              await sleep(500);
            } else {
              log('INFO', `  ↳ ${tx.signature?.slice(0,12)}... type=${tx.type||'?'} (not a token swap)`);
            }
          }
        }
        await sleep(150);
      } catch(e) {}
    }

    if (cycle % 10 === 0) {
      log('INFO', `📊 Cycle #${cycle} | ${checked}/${WALLET_LIST.length} checked | ${newTxs} new txs | ${swaps} swaps`);
    }
    await sleep(CONFIG.POLL_INTERVAL_MS);
  }
}

// ============================================================
// HEALTH + MAIN
// ============================================================
async function healthLoop() {
  while (state.isRunning) {
    console.log('\n' + '═'.repeat(50));
    console.log('  🤖 WINSTON v9.3 — Enhanced TX Alert Bot');
    console.log('═'.repeat(50));
    console.log(`  👀 ${WALLET_LIST.length} wallets | 🔔 ${state.alertCount} alerts`);
    console.log(`  🤖 Grok: ${CONFIG.GROK_API_KEY ? 'Active' : 'OFF'} | 📢 Discord: ${CONFIG.DISCORD_WEBHOOK ? 'Active' : 'OFF'}`);
    console.log(`  🔧 Parser: Helius Enhanced TX (all DEXes)`);
    console.log('═'.repeat(50) + '\n');
    await sleep(CONFIG.HEALTH_LOG_INTERVAL_MS);
  }
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║   🤖 WINSTON v9.3 — Helius Enhanced + Grok Alerts    ║');
  console.log('║     All DEXes • AI Scoring • Discord Notifications    ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  if (!CONFIG.HELIUS_API_KEY) { log('ERROR', 'HELIUS_API_KEY required'); process.exit(1); }
  if (!CONFIG.DISCORD_WEBHOOK) { log('ERROR', 'DISCORD_WEBHOOK_URL required'); process.exit(1); }
  if (!CONFIG.GROK_API_KEY) log('WARN', 'GROK_API_KEY not set — no AI analysis');

  if (CONFIG.PRIVATE_KEY) {
    try { state.wallet = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY)); log('INFO', `Wallet: ${state.wallet.publicKey}`); }
    catch(e) { log('WARN', 'Private key invalid — alert-only mode'); }
  }

  state.connection = new Connection(CONFIG.HELIUS_RPC, { commitment:'confirmed' });
  state.isRunning = true;
  await initLastSigs();

  log('INFO', `🚀 Live — ${WALLET_LIST.length} wallets — Helius Enhanced TX parser (catches ALL swaps)`);
  await sendDiscord(`🚀 **Winston v9.3** | ${WALLET_LIST.length} wallets | Helius Enhanced TX | All DEXes | Grok: ${CONFIG.GROK_API_KEY ? '✅' : '❌'}`);

  process.on('SIGINT', async () => { state.isRunning = false; await sendDiscord(`🛑 Winston offline. ${state.alertCount} alerts sent.`); process.exit(0); });
  process.on('SIGTERM', async () => { state.isRunning = false; await sendDiscord(`🛑 Winston offline. ${state.alertCount} alerts sent.`); process.exit(0); });

  await Promise.all([pollWallets(), healthLoop()]);
}

main().catch(e => { log('ERROR', 'Fatal', { error: e.message }); process.exit(1); });
