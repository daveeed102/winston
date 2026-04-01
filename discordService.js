'use strict';

const { config } = require('./config');

const COLORS = {
  GREEN:  0x57f287,
  RED:    0xed4245,
  YELLOW: 0xfee75c,
  ORANGE: 0xe67e22,
  BLUE:   0x5865f2,
};

class DiscordService {
  constructor() {
    this.webhookUrl = config.DISCORD_WEBHOOK_URL || null;
    this.timeoutMs  = 10000;
    if (!this.webhookUrl) console.warn('[DISCORD] No webhook URL — alerts disabled.');
  }

  async sendStartupAlert() {
    await this.send({
      title:       '🤖 Winston Online',
      description: 'Actor-Critic trading bot has started. Running 2-hour cycles.',
      color:       COLORS.BLUE,
      fields: [
        { name: 'Strategy',    value: 'Grok (Actor) + Rugcheck (Critic)', inline: true },
        { name: 'Hold Window', value: '120 minutes per cycle',            inline: true },
        { name: 'Buy Size',    value: `${config.BUY_AMOUNT_SOL} SOL`,    inline: true },
      ],
      timestamp: new Date().toISOString(),
    });
  }

  async sendBuyAlert({ symbol, tokenAddress, amountSol, confidence, reasoning, txSig }) {
    const solscanToken = `https://solscan.io/token/${tokenAddress}`;
    const solscanTx    = txSig ? `https://solscan.io/tx/${txSig}` : null;
    await this.send({
      title:       `🟢 BUY — ${symbol}`,
      description: `Purchased **${symbol}** for **${amountSol} SOL**. Holding 120 minutes.`,
      color:       COLORS.GREEN,
      fields: [
        { name: 'Token',       value: `[${symbol}](${solscanToken})`,                              inline: true  },
        { name: 'Amount',      value: `${amountSol} SOL`,                                          inline: true  },
        { name: 'Confidence',  value: `${confidence}/100`,                                         inline: true  },
        { name: 'Mint',        value: `\`${tokenAddress}\``,                                       inline: false },
        { name: 'Reasoning',   value: reasoning,                                                   inline: false },
        ...(solscanTx ? [{ name: 'Tx', value: `[View on Solscan](${solscanTx})`, inline: false }] : []),
      ],
      timestamp: new Date().toISOString(),
    });
  }

  async sendSellAlert({ symbol, tokenAddress, buyTimestamp, sellTimestamp, txSig }) {
    const holdMins  = Math.round((new Date(sellTimestamp) - new Date(buyTimestamp)) / 60000);
    const solscanTx = txSig ? `https://solscan.io/tx/${txSig}` : null;
    await this.send({
      title:       `🔴 SELL — ${symbol}`,
      description: `Sold **${symbol}** → SOL after **${holdMins}m** hold.`,
      color:       COLORS.RED,
      fields: [
        { name: 'Hold Time', value: `${holdMins} minutes`,                                         inline: true  },
        { name: 'Mint',      value: `\`${tokenAddress}\``,                                         inline: false },
        ...(solscanTx ? [{ name: 'Tx', value: `[View on Solscan](${solscanTx})`, inline: false }] : []),
      ],
      timestamp: new Date().toISOString(),
    });
  }

  async sendRejectionAlert({ attempt, maxAttempts, symbol, tokenAddress, reason, confidence }) {
    await this.send({
      title:       `⚠️ REJECTED — ${symbol} (Attempt ${attempt}/${maxAttempts})`,
      description: `**${symbol}** failed Rugcheck audit. Querying Grok for a new pick...`,
      color:       COLORS.YELLOW,
      fields: [
        { name: 'Mint',           value: `\`${tokenAddress}\``,              inline: false },
        { name: 'Confidence',     value: `${confidence}/100`,                inline: true  },
        { name: 'Reason',         value: reason,                             inline: false },
        { name: 'Attempts Left',  value: `${maxAttempts - attempt} left`,    inline: true  },
      ],
      timestamp: new Date().toISOString(),
    });
  }

  async sendCircuitBreakerAlert({ rejectedPicks, timestamp }) {
    const list = rejectedPicks.map((r, i) => `**${i + 1}. ${r.symbol}** — ${r.reason}`).join('\n');
    await this.send({
      title:       '🔴 CIRCUIT BREAKER — Holding SOL',
      description: `All **${rejectedPicks.length}** picks rejected. Holding SOL this cycle.`,
      color:       COLORS.ORANGE,
      fields: [
        { name: 'Session Start', value: timestamp,              inline: false },
        { name: 'Failed Picks',  value: list || 'None logged',  inline: false },
        { name: 'Next Cycle',    value: 'In ~120 minutes',      inline: true  },
      ],
      timestamp: new Date().toISOString(),
    });
  }

  async sendErrorAlert(message) {
    await this.send({
      title:       '❌ Bot Error',
      description: message,
      color:       COLORS.RED,
      timestamp:   new Date().toISOString(),
    });
  }

  async send(embed) {
    if (!this.webhookUrl) return;

    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(this.webhookUrl, {
        method:  'POST',
        signal:  controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ embeds: [embed] }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[DISCORD] HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
    } catch (err) {
      // Never crash the main cycle over a Discord failure
      console.error('[DISCORD] Webhook error:', err.name === 'AbortError' ? 'timed out' : err.message);
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = { DiscordService };
