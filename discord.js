// FILE: src/notifications/discord.js
// All Discord webhook messages. Clean, detailed, emoji-coded.

const axios = require('axios');
const config = require('./config');
const { createLogger } = require('./logger');

const log = createLogger('DISCORD');

const COLORS = {
  GREEN: 0x2ecc71,
  RED: 0xe74c3c,
  ORANGE: 0xe67e22,
  BLUE: 0x3498db,
  PURPLE: 0x9b59b6,
  GREY: 0x95a5a6,
  YELLOW: 0xf1c40f,
  DARK: 0x2c2f33,
};

async function send(payload) {
  if (!config.DISCORD_WEBHOOK_URL) return;
  try {
    await axios.post(config.DISCORD_WEBHOOK_URL, payload, { timeout: 8000 });
  } catch (err) {
    log.warn(`Discord send failed: ${err.message}`);
  }
}

function pct(n, decimals = 1) {
  if (n == null) return 'N/A';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${Number(n).toFixed(decimals)}%`;
}

function usd(n) {
  if (n == null) return 'N/A';
  const v = Number(n);
  if (v === 0) return '$0.00';
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(4)}`;
  if (v >= 0.0001) return `$${v.toFixed(6)}`;
  return `$${v.toFixed(10)}`;
}

function score(n) {
  return n != null ? Number(n).toFixed(1) : 'N/A';
}

function confidenceEmoji(c) {
  if (c >= 90) return '🟣 ELITE';
  if (c >= 85) return '🟢 STRONG';
  if (c >= 80) return '🔵 GOOD';
  if (c >= 75) return '🟡 SMALL';
  return '⚪ SKIP';
}

// ─── Bot lifecycle ────────────────────────────────────────────────────────────

async function notifyStartup(version, walletAddresses = []) {
  const walletList = walletAddresses.length > 0
    ? walletAddresses.map((w) => `Wallet ${w.index}: \`${w.address}\``).join('\n')
    : 'Not loaded yet';

  await send({
    embeds: [{
      title: '🤖 Winston Online',
      description: `Bot started. Version **${version}**. Live trading mode.`,
      color: COLORS.BLUE,
      fields: [
        { name: 'Mode', value: 'LIVE 🟢', inline: true },
        { name: 'Min Confidence', value: `${config.MIN_CONFIDENCE_TO_TRADE}`, inline: true },
        { name: 'Max Positions', value: `${config.MAX_CONCURRENT_POSITIONS}`, inline: true },
        { name: 'Portfolio Size', value: usd(config.PORTFOLIO_SIZE_USD), inline: true },
        { name: 'Max Daily Loss', value: usd(config.MAX_DAILY_LOSS_USD), inline: true },
        { name: 'Kill Switch', value: config.KILL_SWITCH ? '🔴 ON' : '🟢 OFF', inline: true },
        { name: `👛 Active Wallets (${walletAddresses.length})`, value: walletList, inline: false },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

async function notifyHeartbeat(state) {
  const walletFields = (state.wallets || []).map((w) => {
    const solLine = w.sol != null
      ? `${w.sol.toFixed(4)} SOL (${usd(w.solUsd)})`
      : 'Error fetching balance';

    const holdingLines = w.holdings && w.holdings.length > 0
      ? w.holdings.map(h => `${h.ticker}: ${h.tokenBal.toFixed(0)} tokens ≈ ${usd(h.usdValue)}`).join('
')
      : 'No open positions';

    return {
      name: `👛 ${w.name}`,
      value: `${solLine}
${holdingLines}`,
      inline: false,
    };
  });

  await send({
    embeds: [{
      title: '💓 Winston Heartbeat',
      color: COLORS.DARK,
      fields: [
        { name: 'Open Positions', value: `${state.openPositions}`, inline: true },
        { name: "Today's Trades", value: `${state.todayTrades}`, inline: true },
        { name: "Today's PnL", value: usd(state.todayPnl), inline: true },
        { name: 'SOL Price', value: usd(state.solPrice), inline: true },
        { name: 'Last Scan', value: state.lastScan || 'N/A', inline: true },
        { name: 'Kill Switch', value: state.killSwitch ? '🔴 ON' : '🟢 OFF', inline: true },
        ...walletFields,
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

async function notifyKillSwitch(reason) {
  await send({
    embeds: [{
      title: '🔴 KILL SWITCH ACTIVATED',
      description: `Winston has halted all trading.\n**Reason:** ${reason}`,
      color: COLORS.RED,
      timestamp: new Date().toISOString(),
    }],
  });
}

async function notifyPause(reason) {
  await send({
    embeds: [{
      title: '⏸️ New Entries Paused',
      description: `**Reason:** ${reason}\nExiting existing positions normally.`,
      color: COLORS.ORANGE,
      timestamp: new Date().toISOString(),
    }],
  });
}

// ─── Candidate / scoring ──────────────────────────────────────────────────────

async function notifyCandidateFound(candidate) {
  await send({
    embeds: [{
      title: `🔍 Candidate: ${candidate.tokenName} (${candidate.ticker})`,
      description: `Passed hard filters. Sending to Grok for scoring.`,
      color: COLORS.GREY,
      fields: [
        { name: 'Address', value: `\`${candidate.tokenAddress}\``, inline: false },
        { name: '1h Change', value: pct(candidate.priceChange1h), inline: true },
        { name: '6h Change', value: pct(candidate.priceChange6h), inline: true },
        { name: '24h Change', value: pct(candidate.priceChange24h), inline: true },
        { name: 'Liquidity', value: usd(candidate.liquidityUsd), inline: true },
        { name: '24h Volume', value: usd(candidate.volume24h), inline: true },
        { name: 'Age', value: `${candidate.ageHours?.toFixed(1) || '?'}h`, inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

async function notifyScoreCreated(candidate) {
  const g = candidate.grokScore || {};
  const tier = confidenceEmoji(candidate.confidenceScore);
  const color = candidate.confidenceScore >= config.MIN_CONFIDENCE_TO_TRADE ? COLORS.PURPLE : COLORS.GREY;

  await send({
    embeds: [{
      title: `📊 Score: ${candidate.tokenName} (${candidate.ticker}) — ${tier}`,
      description: `Confidence score computed. ${candidate.confidenceScore >= config.MIN_CONFIDENCE_TO_TRADE ? '**Will attempt entry.**' : 'Below threshold. Skipping.'}`,
      color,
      fields: [
        { name: '🎯 Confidence', value: `**${score(candidate.confidenceScore)}/100**`, inline: true },
        { name: '🔮 24h Continuation', value: pct((g.continuation_24h_prob || 0) * 100, 0), inline: true },
        { name: '🔮 48h Continuation', value: pct((g.continuation_48h_prob || 0) * 100, 0), inline: true },
        { name: '💀 Dump Risk', value: pct((g.dump_risk_prob || 0) * 100, 0), inline: true },
        { name: '📣 Hype Quality', value: score(g.hype_quality_score), inline: true },
        { name: '📖 Narrative', value: score(g.narrative_strength_score), inline: true },
        { name: '📈 Trend Health', value: score(g.trend_health_score), inline: true },
        { name: '🤖 Grok Verdict', value: g.verdict || 'N/A', inline: true },
        { name: '💬 Grok Summary', value: g.summary_reason || 'N/A', inline: false },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

// ─── Trade entry ──────────────────────────────────────────────────────────────

async function notifyTradeEntry(position, candidate) {
  const g = candidate?.grokScore || {};
  const tier = confidenceEmoji(position.confidenceScore);

  // Build per-wallet tx summary
  const walletResults = position.allWalletResults || [];
  const walletNames = require('./config').WALLET_NAMES || ['Wallet 1', 'Wallet 2', 'Wallet 3'];
  const walletField = walletResults.length > 0
    ? walletResults.map((r, i) => {
        const icon = r.success ? '✅' : '❌';
        const name = walletNames[i] || `Wallet ${i + 1}`;
        const tx = r.signature ? `[tx](https://solscan.io/tx/${r.signature})` : r.reason || 'failed';
        return `${icon} ${name}: ${tx}`;
      }).join('\n')
    : 'N/A';

  await send({
    embeds: [{
      title: `✅ BUY: ${position.tokenName} (${position.ticker})`,
      description: `Winston entered a position. ${tier}`,
      color: COLORS.GREEN,
      fields: [
        { name: 'Chain', value: 'Solana', inline: true },
        { name: 'Address', value: `\`${position.tokenAddress}\``, inline: false },
        { name: 'Entry Price', value: usd(position.entryPrice), inline: true },
        { name: 'Size (USD)', value: usd(position.sizeUsd), inline: true },
        { name: 'Size', value: `${Number(position.allocationPct).toFixed(2)} SOL`, inline: true },
        { name: '1h / 6h / 24h', value: `${pct(candidate?.priceChange1h)} / ${pct(candidate?.priceChange6h)} / ${pct(candidate?.priceChange24h)}`, inline: false },
        { name: 'Vol 1h/24h', value: `${usd(candidate?.volume1h)} / ${usd(candidate?.volume24h)}`, inline: true },
        { name: 'Liquidity', value: usd(candidate?.liquidityUsd), inline: true },
        { name: '🎯 Confidence', value: `${score(position.confidenceScore)}/100`, inline: true },
        { name: '24h Cont.', value: pct((g.continuation_24h_prob || 0) * 100, 0), inline: true },
        { name: '48h Cont.', value: pct((g.continuation_48h_prob || 0) * 100, 0), inline: true },
        { name: 'Dump Risk', value: pct((g.dump_risk_prob || 0) * 100, 0), inline: true },
        { name: '🛑 Stop Loss', value: `${usd(position.stopLossPrice)} (-$7 / -0.084 SOL)`, inline: true },
        { name: '🎯 Take Profit', value: `${usd(position.takeProfitPrice)} (+$8 / +0.096 SOL)`, inline: true },
        { name: '📉 Trailing', value: `Activates at +${config.EXIT.TRAILING_ACTIVATE_PCT}%, trails ${config.EXIT.TRAILING_DISTANCE_PCT}% below peak`, inline: false },
        { name: '👛 Wallet Results', value: walletField, inline: false },
        { name: '💬 Summary', value: g.summary_reason || 'N/A', inline: false },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

// ─── Stop / trailing updates ──────────────────────────────────────────────────

async function notifyStopArmed(position) {
  await send({
    embeds: [{
      title: `🛑 Stop Armed: ${position.tokenName}`,
      color: COLORS.YELLOW,
      fields: [
        { name: 'Entry', value: usd(position.entryPrice), inline: true },
        { name: 'Stop Price', value: usd(position.stopLossPrice), inline: true },
        { name: 'Max Loss', value: '0.096 SOL', inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

async function notifyTrailingArmed(position, currentPrice) {
  await send({
    embeds: [{
      title: `📐 Trailing Stop Armed: ${position.tokenName}`,
      color: COLORS.PURPLE,
      fields: [
        { name: 'Current Price', value: usd(currentPrice), inline: true },
        { name: 'Trail Stop', value: usd(position.trailingStopPrice), inline: true },
        { name: 'Peak', value: usd(position.trailingPeakPrice), inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

async function notifyTrailingMoved(position, currentPrice) {
  await send({
    embeds: [{
      title: `🔼 Trailing Stop Raised: ${position.tokenName}`,
      color: COLORS.BLUE,
      fields: [
        { name: 'Current Price', value: usd(currentPrice), inline: true },
        { name: 'New Trail Stop', value: usd(position.trailingStopPrice), inline: true },
        { name: 'Peak', value: usd(position.trailingPeakPrice), inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

async function notifyPartialTp(position, currentPrice, closedUsd) {
  await send({
    embeds: [{
      title: `💰 Partial TP: ${position.tokenName}`,
      description: `Took ${pct(config.EXIT.PARTIAL_TP_SIZE * 100, 0)} of position at target.`,
      color: COLORS.GREEN,
      fields: [
        { name: 'Current Price', value: usd(currentPrice), inline: true },
        { name: 'Closed USD', value: usd(closedUsd), inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

// ─── Exit ─────────────────────────────────────────────────────────────────────

async function notifyExit(trade) {
  const isWin = trade.realizedPnlUsd > 0;
  const color = isWin ? COLORS.GREEN : COLORS.RED;
  const emoji = isWin ? '🟢' : '🔴';

  await send({
    embeds: [{
      title: `${emoji} EXIT: ${trade.tokenName} (${trade.ticker})`,
      description: `Position closed. Reason: **${trade.exitReason}**`,
      color,
      fields: [
        { name: 'Entry', value: usd(trade.entryPrice), inline: true },
        { name: 'Exit', value: usd(trade.exitPrice), inline: true },
        { name: 'PnL', value: `${usd(trade.realizedPnlUsd)} (${pct(trade.realizedPnlPct)})`, inline: true },
        { name: 'Hold Time', value: `${trade.holdTimeMinutes?.toFixed(0)} min`, inline: true },
        { name: 'Peak Gain', value: pct(trade.peakUnrealizedPct), inline: true },
        { name: 'Confidence Was', value: score(trade.confidenceScore), inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

// ─── Errors / alerts ──────────────────────────────────────────────────────────

async function notifyError(module, message, detail = '') {
  await send({
    embeds: [{
      title: `⚠️ Error: ${module}`,
      description: `${message}\n\`\`\`${String(detail).slice(0, 500)}\`\`\``,
      color: COLORS.RED,
      timestamp: new Date().toISOString(),
    }],
  });
}

async function notifyDailySummary(summary) {
  const color = summary.grossPnlUsd >= 0 ? COLORS.GREEN : COLORS.RED;
  await send({
    embeds: [{
      title: `📅 Daily Summary — ${summary.date}`,
      color,
      fields: [
        { name: 'Trades', value: `${summary.tradesCount}`, inline: true },
        { name: 'Wins / Losses', value: `${summary.wins} / ${summary.losses}`, inline: true },
        { name: 'Gross PnL', value: usd(summary.grossPnlUsd), inline: true },
        { name: 'Best Trade', value: pct(summary.bestTradePct), inline: true },
        { name: 'Worst Trade', value: pct(summary.worstTradePct), inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

module.exports = {
  notifyStartup,
  notifyHeartbeat,
  notifyKillSwitch,
  notifyPause,
  notifyCandidateFound,
  notifyScoreCreated,
  notifyTradeEntry,
  notifyStopArmed,
  notifyTrailingArmed,
  notifyTrailingMoved,
  notifyPartialTp,
  notifyExit,
  notifyError,
  notifyDailySummary,
};
