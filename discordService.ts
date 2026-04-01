/**
 * DiscordService — Rich Embed Webhook Alerts
 * Covers: Startup, Buy, Sell, Rejection, Circuit Breaker, and Errors.
 */

import { config } from '../config';

// Discord embed color constants
const COLORS = {
  GREEN:   0x57f287, // Buy / success
  RED:     0xed4245, // Sell / error
  YELLOW:  0xfee75c, // Rejection / warning
  ORANGE:  0xe67e22, // Circuit breaker
  BLUE:    0x5865f2, // Startup / info
  GRAY:    0x99aab5, // Neutral
} as const;

interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

interface DiscordEmbed {
  title:       string;
  description?: string;
  color:       number;
  fields?:     EmbedField[];
  footer?:     { text: string };
  timestamp?:  string;
}

// ─────────────────────────────────────────────
// Alert Param Types
// ─────────────────────────────────────────────

export interface BuyAlertParams {
  symbol:       string;
  tokenAddress: string;
  amountSol:    number;
  confidence:   number;
  reasoning:    string;
  txSig?:       string;
}

export interface SellAlertParams {
  symbol:        string;
  tokenAddress:  string;
  buyTimestamp:  string;
  sellTimestamp: string;
  txSig?:        string;
}

export interface RejectionAlertParams {
  attempt:      number;
  maxAttempts:  number;
  symbol:       string;
  tokenAddress: string;
  reason:       string;
  confidence:   number;
}

export interface CircuitBreakerAlertParams {
  rejectedPicks: { symbol: string; tokenAddress: string; reason: string }[];
  timestamp:     string;
}

// ─────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────

export class DiscordService {
  private readonly webhookUrl: string;
  private readonly timeoutMs = 10_000;

  constructor() {
    if (!config.DISCORD_WEBHOOK_URL) {
      console.warn('[DISCORD] No webhook URL configured — Discord alerts disabled.');
    }
    this.webhookUrl = config.DISCORD_WEBHOOK_URL ?? '';
  }

  // ── Public Alert Methods ───────────────────────────────────────────────

  async sendStartupAlert(): Promise<void> {
    await this.send({
      title:       '🤖 Winston Online',
      description: 'Actor-Critic trading bot has started. Running 2-hour cycles.',
      color:       COLORS.BLUE,
      fields: [
        { name: 'Strategy',   value: 'Grok (Actor) + Rugcheck (Critic)',    inline: true },
        { name: 'Hold Window', value: '120 minutes per cycle',              inline: true },
        { name: 'Max Retries', value: '3 picks before SOL fallback',        inline: true },
      ],
      timestamp: new Date().toISOString(),
    });
  }

  async sendBuyAlert(p: BuyAlertParams): Promise<void> {
    const solscanUrl = `https://solscan.io/token/${p.tokenAddress}`;
    const txUrl      = p.txSig ? `https://solscan.io/tx/${p.txSig}` : null;

    await this.send({
      title:       `🟢 BUY — ${p.symbol}`,
      description: `Purchased **${p.symbol}** for **${p.amountSol} SOL**. Holding for 120 minutes.`,
      color:       COLORS.GREEN,
      fields: [
        { name: 'Token',        value: `[${p.symbol}](${solscanUrl})`,            inline: true  },
        { name: 'Amount',       value: `${p.amountSol} SOL`,                      inline: true  },
        { name: 'Confidence',   value: `${p.confidence}/100`,                     inline: true  },
        { name: 'Mint Address', value: `\`${p.tokenAddress}\``,                   inline: false },
        { name: 'Reasoning',    value: p.reasoning,                               inline: false },
        ...(txUrl ? [{ name: 'Transaction', value: `[View on Solscan](${txUrl})`, inline: false }] : []),
      ],
      footer:    { text: 'Winston Actor-Critic Bot' },
      timestamp: new Date().toISOString(),
    });
  }

  async sendSellAlert(p: SellAlertParams): Promise<void> {
    const solscanUrl  = `https://solscan.io/token/${p.tokenAddress}`;
    const txUrl       = p.txSig ? `https://solscan.io/tx/${p.txSig}` : null;
    const holdMinutes = Math.round(
      (new Date(p.sellTimestamp).getTime() - new Date(p.buyTimestamp).getTime()) / 60_000
    );

    await this.send({
      title:       `🔴 SELL — ${p.symbol}`,
      description: `Sold **${p.symbol}** back to SOL after **${holdMinutes}m** hold.`,
      color:       COLORS.RED,
      fields: [
        { name: 'Token',        value: `[${p.symbol}](${solscanUrl})`,             inline: true  },
        { name: 'Hold Time',    value: `${holdMinutes} minutes`,                   inline: true  },
        { name: 'Mint Address', value: `\`${p.tokenAddress}\``,                    inline: false },
        ...(txUrl ? [{ name: 'Transaction', value: `[View on Solscan](${txUrl})`,  inline: false }] : []),
      ],
      footer:    { text: 'Winston Actor-Critic Bot' },
      timestamp: new Date().toISOString(),
    });
  }

  async sendRejectionAlert(p: RejectionAlertParams): Promise<void> {
    await this.send({
      title:       `⚠️ REJECTED — ${p.symbol} (Attempt ${p.attempt}/${p.maxAttempts})`,
      description: `Grok's pick **${p.symbol}** was rejected by Rugcheck security audit. Querying Grok for a new pick...`,
      color:       COLORS.YELLOW,
      fields: [
        { name: 'Rejected Token',  value: `\`${p.tokenAddress}\``, inline: false },
        { name: 'Grok Confidence', value: `${p.confidence}/100`,   inline: true  },
        { name: 'Rejection Reason', value: p.reason,               inline: false },
        { name: 'Attempts Left',   value: `${p.maxAttempts - p.attempt} remaining`, inline: true },
      ],
      footer:    { text: 'Winston Actor-Critic Bot' },
      timestamp: new Date().toISOString(),
    });
  }

  async sendCircuitBreakerAlert(p: CircuitBreakerAlertParams): Promise<void> {
    const rejectedList = p.rejectedPicks
      .map((r, i) => `**${i + 1}. ${r.symbol}** — ${r.reason}`)
      .join('\n');

    await this.send({
      title:       '🔴 CIRCUIT BREAKER — Holding SOL',
      description: `All **${p.rejectedPicks.length}** Grok picks were rejected by security audit. Holding SOL for this 2-hour window.`,
      color:       COLORS.ORANGE,
      fields: [
        { name: 'Session Start', value: p.timestamp,    inline: false },
        { name: 'Failed Picks',  value: rejectedList || 'None logged', inline: false },
        { name: 'Next Cycle',    value: 'In ~120 minutes',             inline: true  },
      ],
      footer:    { text: 'Winston Actor-Critic Bot' },
      timestamp: new Date().toISOString(),
    });
  }

  async sendErrorAlert(message: string): Promise<void> {
    await this.send({
      title:       '❌ Bot Error',
      description: message,
      color:       COLORS.RED,
      footer:      { text: 'Winston Actor-Critic Bot' },
      timestamp:   new Date().toISOString(),
    });
  }

  // ── Internal Sender ────────────────────────────────────────────────────

  private async send(embed: DiscordEmbed): Promise<void> {
    if (!this.webhookUrl) return;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.webhookUrl, {
        method:  'POST',
        signal:  controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ embeds: [embed] }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        console.error(`[DISCORD] Webhook HTTP ${response.status}: ${body.slice(0, 200)}`);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.error('[DISCORD] Webhook timed out');
      } else {
        console.error('[DISCORD] Webhook error:', err.message);
      }
      // Never throw from Discord — it must never crash the main cycle
    } finally {
      clearTimeout(timeout);
    }
  }
}
