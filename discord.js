// FILE: discord.js
// All Discord webhook messages for Winston.

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

const WALLET_NAMES = config.WALLET_NAMES || ['Daveeed', 'Kindude', 'Reshawnda'];

async function send(payload) {
  if (!config.DISCORD_WEBHOOK_URL) return;
  try {
    await axios.post(config.DISCORD_WEBHOOK_URL, payload, { timeout: 8000 });
  } catch (err) {
    log.warn('Discord send failed: ' + err.message);
  }
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function usd(n) {
  if (n == null) return 'N/A';
  const v = Number(n);
  if (v === 0) return '$0.00';
  if (v >= 1) return '$' + v.toFixed(2);
  if (v >= 0.01) return '$' + v.toFixed(4);
  if (v >= 0.0001) return '$' + v.toFixed(6);
  return '$' + v.toFixed(10);
}

function pct(n, decimals) {
  if (n == null) return 'N/A';
  var d = decimals != null ? decimals : 1;
  var sign = n >= 0 ? '+' : '';
  return sign + Number(n).toFixed(d) + '%';
}

function score(n) {
  return n != null ? Number(n).toFixed(1) : 'N/A';
}

function confidenceEmoji(c) {
  if (c >= 90) return 'ELITE';
  if (c >= 85) return 'STRONG';
  if (c >= 80) return 'GOOD';
  if (c >= 75) return 'SMALL';
  return 'SKIP';
}

function walletResultsField(allWalletResults) {
  if (!allWalletResults || !allWalletResults.length) return 'N/A';
  return allWalletResults.map(function(r, i) {
    var icon = r.success ? '[OK]' : '[FAIL]';
    var name = WALLET_NAMES[i] || ('Wallet ' + (i + 1));
    var tx = r.signature
      ? ('[tx](https://solscan.io/tx/' + r.signature + ')')
      : (r.reason || 'failed');
    return icon + ' ' + name + ': ' + tx;
  }).join('\n');
}

// ─── Bot lifecycle ────────────────────────────────────────────────────────────

async function notifyStartup(version, walletAddresses) {
  var walletList = walletAddresses && walletAddresses.length > 0
    ? walletAddresses.map(function(w) {
        var name = WALLET_NAMES[w.index - 1] || ('Wallet ' + w.index);
        return name + ': ' + w.address;
      }).join('\n')
    : 'Not loaded';

  await send({
    embeds: [{
      title: 'Winston Online v' + version,
      description: 'Bot started. Live trading mode.',
      color: COLORS.BLUE,
      fields: [
        { name: 'Mode', value: 'LIVE', inline: true },
        { name: 'Min Confidence', value: String(config.MIN_CONFIDENCE_TO_TRADE), inline: true },
        { name: 'Max Positions', value: String(config.MAX_CONCURRENT_POSITIONS), inline: true },
        { name: 'Kill Switch', value: config.KILL_SWITCH ? 'ON' : 'OFF', inline: true },
        { name: 'Active Wallets', value: walletList, inline: false },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

async function notifyHeartbeat(state) {
  var walletFields = (state.wallets || []).map(function(w) {
    var solLine = w.sol != null
      ? (w.sol.toFixed(4) + ' SOL (' + usd(w.solUsd) + ')')
      : 'Error fetching balance';

    var holdingLines = w.holdings && w.holdings.length > 0
      ? w.holdings.map(function(h) {
          return h.ticker + ': ' + h.tokenBal.toFixed(0) + ' tokens (~' + usd(h.usdValue) + ')';
        }).join('\n')
      : 'No open positions';

    return {
      name: 'Wallet: ' + w.name,
      value: solLine + '\n' + holdingLines,
      inline: false,
    };
  });

  await send({
    embeds: [{
      title: 'Winston Heartbeat',
      color: COLORS.DARK,
      fields: [
        { name: 'Open Positions', value: String(state.openPositions), inline: true },
        { name: "Today's Trades", value: String(state.todayTrades), inline: true },
        { name: "Today's PnL", value: usd(state.todayPnl), inline: true },
        { name: 'SOL Price', value: usd(state.solPrice), inline: true },
        { name: 'Last Scan', value: state.lastScan || 'N/A', inline: true },
        { name: 'Kill Switch', value: state.killSwitch ? 'ON' : 'OFF', inline: true },
      ].concat(walletFields),
      timestamp: new Date().toISOString(),
    }],
  });
}

async function notifyKillSwitch(reason) {
  await send({
    embeds: [{
      title: 'KILL SWITCH ACTIVATED',
      description: 'Winston has halted all trading.\nReason: ' + reason,
      color: COLORS.RED,
      timestamp: new Date().toISOString(),
    }],
  });
}

async function notifyPause(reason) {
  await send({
    embeds: [{
      title: 'New Entries Paused',
      description: 'Reason: ' + reason + '\nExiting existing positions normally.',
      color: COLORS.ORANGE,
      timestamp: new Date().toISOString(),
    }],
  });
}

// ─── Candidate / scoring ──────────────────────────────────────────────────────

async function notifyCandidateFound(candidate) {
  await send({
    embeds: [{
      title: 'Candidate: ' + candidate.tokenName + ' (' + candidate.ticker + ')',
      description: 'Passed hard filters. Sending to Grok for scoring.',
      color: COLORS.GREY,
      fields: [
        { name: 'Address', value: '`' + candidate.tokenAddress + '`', inline: false },
        { name: '1h Change', value: pct(candidate.priceChange1h), inline: true },
        { name: '6h Change', value: pct(candidate.priceChange6h), inline: true },
        { name: '24h Change', value: pct(candidate.priceChange24h), inline: true },
        { name: 'Liquidity', value: usd(candidate.liquidityUsd), inline: true },
        { name: '24h Volume', value: usd(candidate.volume24h), inline: true },
        { name: 'Age', value: (candidate.ageHours ? candidate.ageHours.toFixed(1) : '?') + 'h', inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

async function notifyScoreCreated(candidate) {
  var g = candidate.grokScore || {};
  var tier = confidenceEmoji(candidate.confidenceScore);
  var color = candidate.confidenceScore >= config.MIN_CONFIDENCE_TO_TRADE ? COLORS.PURPLE : COLORS.GREY;
  var willTrade = candidate.confidenceScore >= config.MIN_CONFIDENCE_TO_TRADE ? 'Will attempt entry.' : 'Below threshold. Skipping.';

  await send({
    embeds: [{
      title: 'Score: ' + candidate.tokenName + ' (' + candidate.ticker + ') - ' + tier,
      description: 'Confidence score computed. ' + willTrade,
      color: color,
      fields: [
        { name: 'Confidence', value: score(candidate.confidenceScore) + '/100', inline: true },
        { name: '24h Continuation', value: pct((g.continuation_24h_prob || 0) * 100, 0), inline: true },
        { name: '48h Continuation', value: pct((g.continuation_48h_prob || 0) * 100, 0), inline: true },
        { name: 'Dump Risk', value: pct((g.dump_risk_prob || 0) * 100, 0), inline: true },
        { name: 'Hype Quality', value: score(g.hype_quality_score), inline: true },
        { name: 'Narrative', value: score(g.narrative_strength_score), inline: true },
        { name: 'Trend Health', value: score(g.trend_health_score), inline: true },
        { name: 'Grok Verdict', value: g.verdict || 'N/A', inline: true },
        { name: 'Grok Summary', value: g.summary_reason || 'N/A', inline: false },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

// ─── Trade entry ──────────────────────────────────────────────────────────────

async function notifyTradeEntry(position, candidate) {
  var g = candidate && candidate.grokScore ? candidate.grokScore : {};
  var tier = confidenceEmoji(position.confidenceScore);
  var walletField = walletResultsField(position.allWalletResults);

  await send({
    embeds: [{
      title: 'BUY: ' + position.tokenName + ' (' + position.ticker + ')',
      description: 'Winston entered a position. ' + tier,
      color: COLORS.GREEN,
      fields: [
        { name: 'Chain', value: 'Solana', inline: true },
        { name: 'Address', value: '`' + position.tokenAddress + '`', inline: false },
        { name: 'Entry Price', value: usd(position.entryPrice), inline: true },
        { name: 'Size (SOL)', value: (position.allocationPct || 0).toFixed(2) + ' SOL', inline: true },
        { name: '1h / 6h / 24h', value: pct(candidate && candidate.priceChange1h) + ' / ' + pct(candidate && candidate.priceChange6h) + ' / ' + pct(candidate && candidate.priceChange24h), inline: false },
        { name: 'Vol 1h/24h', value: usd(candidate && candidate.volume1h) + ' / ' + usd(candidate && candidate.volume24h), inline: true },
        { name: 'Liquidity', value: usd(candidate && candidate.liquidityUsd), inline: true },
        { name: 'Confidence', value: score(position.confidenceScore) + '/100', inline: true },
        { name: '24h Cont.', value: pct((g.continuation_24h_prob || 0) * 100, 0), inline: true },
        { name: '48h Cont.', value: pct((g.continuation_48h_prob || 0) * 100, 0), inline: true },
        { name: 'Dump Risk', value: pct((g.dump_risk_prob || 0) * 100, 0), inline: true },
        { name: 'Stop Loss', value: usd(position.stopLossPrice) + ' (max -0.096 SOL)', inline: true },
        { name: 'TP1 (+20%)', value: usd(position.tp1Price) + ' — sell 25%', inline: true },
        { name: 'TP2 (+50%)', value: usd(position.tp2Price) + ' — sell 25%', inline: true },
        { name: 'Trailing', value: 'Activates at +6%, trails 4% below peak', inline: false },
        { name: 'Wallet Results', value: walletField, inline: false },
        { name: 'Summary', value: g.summary_reason || 'N/A', inline: false },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

// ─── Stop / trailing ──────────────────────────────────────────────────────────

async function notifyStopArmed(position) {
  await send({
    embeds: [{
      title: 'Stop Armed: ' + position.tokenName,
      color: COLORS.YELLOW,
      fields: [
        { name: 'Entry', value: usd(position.entryPrice), inline: true },
        { name: 'Stop Price', value: usd(position.stopLossPrice), inline: true },
        { name: 'Max Loss', value: '0.096 SOL (~$8)', inline: true },
        { name: 'TP1 (+20%)', value: usd(position.tp1Price) + ' — 25%', inline: true },
        { name: 'TP2 (+50%)', value: usd(position.tp2Price) + ' — 25%', inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

async function notifyTrailingArmed(position, currentPrice) {
  await send({
    embeds: [{
      title: 'Trailing Stop Armed: ' + position.tokenName,
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
      title: 'Trailing Stop Raised: ' + position.tokenName,
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

async function notifyPartialTp(position, currentPrice, closedUsd, label) {
  await send({
    embeds: [{
      title: 'Partial TP: ' + position.tokenName,
      description: label || 'Partial position closed.',
      color: COLORS.GREEN,
      fields: [
        { name: 'Current Price', value: usd(currentPrice), inline: true },
        { name: 'Closed USD', value: usd(closedUsd), inline: true },
        { name: 'Remaining', value: 'Still holding — trailing stop active', inline: false },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

// ─── Exit ─────────────────────────────────────────────────────────────────────

async function notifyExit(trade) {
  var isWin = trade.realizedPnlUsd > 0;
  var color = isWin ? COLORS.GREEN : COLORS.RED;
  var emoji = isWin ? 'WIN' : 'LOSS';

  await send({
    embeds: [{
      title: emoji + ' EXIT: ' + trade.tokenName + ' (' + trade.ticker + ')',
      description: 'Position closed. Reason: **' + trade.exitReason + '**',
      color: color,
      fields: [
        { name: 'Entry', value: usd(trade.entryPrice), inline: true },
        { name: 'Exit', value: usd(trade.exitPrice), inline: true },
        { name: 'PnL', value: usd(trade.realizedPnlUsd) + ' (' + pct(trade.realizedPnlPct) + ')', inline: true },
        { name: 'Hold Time', value: (trade.holdTimeMinutes ? trade.holdTimeMinutes.toFixed(0) : '?') + ' min', inline: true },
        { name: 'Peak Gain', value: pct(trade.peakUnrealizedPct), inline: true },
        { name: 'Confidence Was', value: score(trade.confidenceScore), inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

// ─── Errors / alerts ──────────────────────────────────────────────────────────

async function notifyError(module, message, detail) {
  await send({
    embeds: [{
      title: 'Error: ' + module,
      description: message + '\n```' + String(detail || '').slice(0, 500) + '```',
      color: COLORS.RED,
      timestamp: new Date().toISOString(),
    }],
  });
}

async function notifyDailySummary(summary) {
  var color = summary.grossPnlUsd >= 0 ? COLORS.GREEN : COLORS.RED;
  await send({
    embeds: [{
      title: 'Daily Summary - ' + summary.date,
      color: color,
      fields: [
        { name: 'Trades', value: String(summary.tradesCount), inline: true },
        { name: 'Wins / Losses', value: summary.wins + ' / ' + summary.losses, inline: true },
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
