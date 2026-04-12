/**
 * Discord notifications for the sniper
 */

const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

const COLOR = {
  GREEN:  0x00c853,
  RED:    0xe53935,
  YELLOW: 0xf9a825,
  BLUE:   0x1565c0,
  ORANGE: 0xef6c00,
  GREY:   0x607d8b,
};

async function send(embed) {
  if (!config.DISCORD_WEBHOOK_URL) return;
  try {
    await axios.post(config.DISCORD_WEBHOOK_URL, {
      username: 'Winston Sniper',
      embeds: [embed],
    }, { timeout: 5000 });
  } catch (err) {
    logger.warn(`[DISCORD] Failed: ${err.message}`);
  }
}

function shortMint(mint) {
  return `${mint.slice(0, 6)}...${mint.slice(-4)}`;
}

async function sendStartup(walletAddress, solBalance) {
  await send({
    title: '🟢 Winston Sniper Online',
    color: COLOR.GREEN,
    fields: [
      { name: 'Wallet', value: `\`${walletAddress}\``, inline: false },
      { name: 'SOL Balance', value: `${solBalance.toFixed(4)} SOL`, inline: true },
      { name: 'Buy Size', value: `${config.BUY_AMOUNT_SOL} SOL`, inline: true },
      { name: 'Max Positions', value: config.MAX_POSITIONS.toString(), inline: true },
      { name: 'Take Profit', value: `${config.TAKE_PROFIT_MULTIPLIER}x`, inline: true },
      { name: 'Time Stop', value: `${config.TIME_STOP_SECONDS}s`, inline: true },
      { name: 'Max Token Age', value: `${config.MAX_TOKEN_AGE_SECONDS}s`, inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Winston Sniper v1.0' },
  });
}

async function sendBuySuccess({ mint, solSpent, tokenAmount, txSig, positionCount }) {
  await send({
    title: `🟢 Bought: ${shortMint(mint)}`,
    color: COLOR.GREEN,
    fields: [
      { name: 'Mint', value: `\`${mint}\``, inline: false },
      { name: 'SOL Spent', value: `${solSpent} SOL`, inline: true },
      { name: 'Tokens', value: tokenAmount.toLocaleString(), inline: true },
      { name: 'Positions', value: `${positionCount}/${config.MAX_POSITIONS}`, inline: true },
      { name: 'TX', value: `[View](https://solscan.io/tx/${txSig})`, inline: true },
      { name: 'Target', value: `${config.TAKE_PROFIT_MULTIPLIER}x or ${config.TIME_STOP_SECONDS}s`, inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Winston Sniper v1.0' },
  });
}

async function sendBuyFailed(mint, reason) {
  await send({
    title: `❌ Buy Failed: ${shortMint(mint)}`,
    color: COLOR.RED,
    fields: [
      { name: 'Mint', value: `\`${mint}\``, inline: false },
      { name: 'Reason', value: reason, inline: false },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Winston Sniper v1.0' },
  });
}

async function sendSkipped(mint, reason) {
  await send({
    title: `⏭️ Skipped: ${shortMint(mint)}`,
    color: COLOR.GREY,
    fields: [
      { name: 'Mint', value: `\`${mint}\``, inline: false },
      { name: 'Reason', value: reason, inline: false },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Winston Sniper v1.0' },
  });
}

async function sendSellAttempt(mint, reason) {
  await send({
    title: `🔄 Selling: ${shortMint(mint)}`,
    color: COLOR.YELLOW,
    fields: [
      { name: 'Mint', value: `\`${mint}\``, inline: false },
      { name: 'Reason', value: reason, inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Winston Sniper v1.0' },
  });
}

async function sendSellSuccess({ mint, reason, solReceived, solSpent, pnlSol, multiplier, txSig, attempts }) {
  const isWin = pnlSol >= 0;
  await send({
    title: `${isWin ? '💰' : '🛑'} Sold: ${shortMint(mint)}`,
    color: isWin ? COLOR.GREEN : COLOR.RED,
    fields: [
      { name: 'Mint', value: `\`${mint}\``, inline: false },
      { name: 'Reason', value: reason, inline: true },
      { name: 'Multiplier', value: `${multiplier.toFixed(2)}x`, inline: true },
      { name: 'SOL Spent', value: `${solSpent.toFixed(6)}`, inline: true },
      { name: 'SOL Received', value: `${solReceived.toFixed(6)}`, inline: true },
      { name: 'PnL', value: `${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(6)} SOL`, inline: true },
      { name: 'Sell Attempts', value: attempts.toString(), inline: true },
      { name: 'TX', value: `[View](https://solscan.io/tx/${txSig})`, inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Winston Sniper v1.0' },
  });
}

async function sendSellFailed(mint, reason, attempts) {
  await send({
    title: `🚨 SELL FAILED: ${shortMint(mint)}`,
    description: `**All ${attempts} sell attempts failed. Emergency retry loop started. Manual check may be needed.**`,
    color: COLOR.ORANGE,
    fields: [
      { name: 'Mint', value: `\`${mint}\``, inline: false },
      { name: 'Exit Reason', value: reason, inline: true },
      { name: 'Attempts Failed', value: attempts.toString(), inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Winston Sniper v1.0' },
  });
}

async function sendEmergencySellSuccess(mint, solReceived, attempt) {
  await send({
    title: `✅ Emergency Sell Succeeded: ${shortMint(mint)}`,
    color: COLOR.GREEN,
    fields: [
      { name: 'Mint', value: `\`${mint}\``, inline: false },
      { name: 'SOL Received', value: `${solReceived.toFixed(6)}`, inline: true },
      { name: 'Emergency Attempt #', value: attempt.toString(), inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Winston Sniper v1.0' },
  });
}

async function sendHeartbeat(positionCount, solBalance) {
  await send({
    title: '💓 Sniper Heartbeat',
    color: COLOR.GREY,
    fields: [
      { name: 'Open Positions', value: `${positionCount}/${config.MAX_POSITIONS}`, inline: true },
      { name: 'SOL Balance', value: `${solBalance.toFixed(4)} SOL`, inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Winston Sniper v1.0' },
  });
}

async function sendError(title, message) {
  await send({
    title: `⚠️ Error: ${title}`,
    description: `\`\`\`${String(message).slice(0, 1000)}\`\`\``,
    color: COLOR.ORANGE,
    timestamp: new Date().toISOString(),
    footer: { text: 'Winston Sniper v1.0' },
  });
}

module.exports = {
  sendStartup,
  sendBuySuccess,
  sendBuyFailed,
  sendSkipped,
  sendSellAttempt,
  sendSellSuccess,
  sendSellFailed,
  sendEmergencySellSuccess,
  sendHeartbeat,
  sendError,
};
