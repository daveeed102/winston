/**
 * GrokService — The Actor
 * Queries the Grok API to pick a token to hold for exactly 120 minutes.
 * Includes timestamp injection and rejection feedback loop prompting.
 */

import { config } from '../config';

export interface GrokPick {
  token_address: string;
  symbol: string;
  confidence_score_out_of_100: number;
  short_reasoning: string;
}

interface PickTokenParams {
  timestamp: string;
  rejectedPicks: { symbol: string; tokenAddress: string; reason: string }[];
}

export class GrokService {
  private readonly apiUrl = 'https://api.x.ai/v1/chat/completions';
  private readonly model  = 'grok-3-latest';
  private readonly timeoutMs = 30_000;

  // ── Prompt Construction ────────────────────────────────────────────────

  private buildSystemPrompt(): string {
    return `You are Winston, an aggressive Solana memecoin trading bot optimized for 2-hour hold windows.

Your job is to identify ONE token that will be profitable at the EXACT 2-hour mark — not in 5 minutes, not in 24 hours. EXACTLY 2 hours from now.

Your selection criteria:
- HIGH social buzz and momentum RIGHT NOW (Twitter/X volume, Telegram activity, trending on DEX screeners)
- NOT a 5-minute pump-and-dump. The coin must have staying power and narrative depth beyond a single spike.
- NOT a slow-moving "safe" bluechip. You need something with real upside potential in 120 minutes.
- SWEET SPOT: Find coins with building momentum, not peaked momentum. Early-to-mid pump phase preferred.
- The token must be tradeable on Jupiter aggregator (Solana ecosystem only).
- Prefer tokens with existing liquidity pools and actual trading volume.

You MUST respond with ONLY a valid JSON object — no markdown, no backticks, no preamble. Strict format:
{
  "token_address": "<full Solana token mint address>",
  "symbol": "<ticker symbol>",
  "confidence_score_out_of_100": <integer 0-100>,
  "short_reasoning": "<1-2 sentences explaining why this token survives the 2-hour window>"
}`;
  }

  private buildUserPrompt(params: PickTokenParams): string {
    const { timestamp, rejectedPicks } = params;

    let prompt = `Current UTC Time: ${timestamp}

You are picking a token to hold for EXACTLY 120 minutes. You must pick a coin that will not just pump now, but will survive, sustain momentum, and be profitable at the 2-hour mark. Ignore 5-minute pump-and-dumps and ignore slow-moving "safe" coins. Find the sweet spot of high buzz and 2-hour survivability.`;

    // ── Rejection Feedback Injection ──────────────────────────────────────
    if (rejectedPicks.length > 0) {
      prompt += `\n\nPREVIOUS REJECTIONS — DO NOT pick these coins again:`;
      for (const r of rejectedPicks) {
        prompt += `\n- ${r.symbol} (${r.tokenAddress}) was REJECTED because: ${r.reason}`;
      }
      prompt += `\n\nYou must find a completely different token that both meets the 2-hour survivability criteria AND passes standard security checks (no active mint authority, no active freeze authority, low rug risk score).`;
    }

    prompt += `\n\nRespond ONLY with the JSON object. No other text.`;

    return prompt;
  }

  // ── API Call ───────────────────────────────────────────────────────────

  async pickToken(params: PickTokenParams): Promise<GrokPick> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(this.apiUrl, {
        method:  'POST',
        signal:  controller.signal,
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${config.GROK_API_KEY}`,
        },
        body: JSON.stringify({
          model:       this.model,
          temperature: 0.7,     // Some creativity but not hallucination territory
          max_tokens:  512,
          messages: [
            { role: 'system', content: this.buildSystemPrompt() },
            { role: 'user',   content: this.buildUserPrompt(params) },
          ],
        }),
      });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`Grok API timed out after ${this.timeoutMs / 1000}s`);
      }
      throw new Error(`Grok API fetch failed: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Grok API HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    const raw: string = data?.choices?.[0]?.message?.content ?? '';

    if (!raw) {
      throw new Error('Grok returned an empty response');
    }

    return this.parseGrokResponse(raw);
  }

  // ── Response Parser ────────────────────────────────────────────────────

  private parseGrokResponse(raw: string): GrokPick {
    // Strip any accidental markdown fences
    const cleaned = raw
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error(`Grok returned non-JSON: ${raw.slice(0, 300)}`);
    }

    // Validate required fields
    const required = ['token_address', 'symbol', 'confidence_score_out_of_100', 'short_reasoning'];
    for (const field of required) {
      if (parsed[field] === undefined || parsed[field] === null) {
        throw new Error(`Grok response missing field: ${field}`);
      }
    }

    // Basic Solana address sanity check (base58, 32-44 chars)
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(parsed.token_address)) {
      throw new Error(`Grok returned invalid token address: ${parsed.token_address}`);
    }

    return {
      token_address:               parsed.token_address,
      symbol:                      String(parsed.symbol).toUpperCase(),
      confidence_score_out_of_100: Math.min(100, Math.max(0, Number(parsed.confidence_score_out_of_100))),
      short_reasoning:             String(parsed.short_reasoning),
    };
  }
}
