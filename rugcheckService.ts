/**
 * RugcheckService — The Critic / Security Bouncer
 * Audits a token via rugcheck.xyz and returns null (approved) or a rejection reason string.
 *
 * Rejection triggers:
 *   - Mint authority still active
 *   - Freeze authority still active
 *   - Overall risk score >= RISK_SCORE_THRESHOLD
 */

import { config } from '../config';

export class RugcheckService {
  private readonly baseUrl   = 'https://api.rugcheck.xyz/v1/tokens';
  private readonly timeoutMs = 15_000;

  // Reject if risk score is at or above this threshold (0–100 scale)
  // Adjust in config.ts to tune aggression vs. safety
  private get riskThreshold(): number {
    return config.RUGCHECK_RISK_THRESHOLD ?? 500;
  }

  /**
   * Audits the given token address.
   * @returns null if the token passes, or a human-readable rejection reason string.
   */
  async audit(tokenAddress: string): Promise<string | null> {
    const url = `${this.baseUrl}/${tokenAddress}/report/summary`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method:  'GET',
        signal:  controller.signal,
        headers: { 'Accept': 'application/json' },
      });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`Rugcheck API timed out after ${this.timeoutMs / 1000}s`);
      }
      throw new Error(`Rugcheck fetch failed: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      if (response.status === 404) {
        // Token not indexed — treat as unknown risk, reject it
        return 'Token not found on Rugcheck (unverified/unknown token)';
      }
      const body = await response.text().catch(() => '');
      throw new Error(`Rugcheck HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    return this.evaluate(data);
  }

  // ── Evaluation Logic ───────────────────────────────────────────────────

  private evaluate(report: any): string | null {
    const reasons: string[] = [];

    // ── Check Mint Authority ──────────────────────────────────────────────
    // rugcheck.xyz summary typically exposes this under `risks` array or top-level flags
    const mintAuthorityActive = this.detectFlag(report, [
      'mintAuthorityEnabled',
      'mintAuthority',
      'mint_authority',
    ]);

    if (mintAuthorityActive) {
      reasons.push('Mint authority is still active (dev can mint unlimited supply)');
    }

    // ── Check Freeze Authority ────────────────────────────────────────────
    const freezeAuthorityActive = this.detectFlag(report, [
      'freezeAuthorityEnabled',
      'freezeAuthority',
      'freeze_authority',
    ]);

    if (freezeAuthorityActive) {
      reasons.push('Freeze authority is still active (dev can freeze wallets)');
    }

    // ── Check Overall Risk Score ──────────────────────────────────────────
    // rugcheck.xyz returns a `score` field — higher = riskier
    const score: number = report?.score ?? report?.riskScore ?? report?.risk_score ?? 0;

    if (score >= this.riskThreshold) {
      reasons.push(`Risk score ${score} exceeds threshold of ${this.riskThreshold}`);
    }

    // ── Check Risks Array for Critical Flags ─────────────────────────────
    const risks: any[] = report?.risks ?? [];
    for (const risk of risks) {
      const name: string = (risk?.name ?? risk?.type ?? '').toLowerCase();
      const level: string = (risk?.level ?? risk?.severity ?? '').toLowerCase();

      if (level === 'danger' || level === 'critical') {
        reasons.push(`Critical risk flag: "${risk.name ?? name}" (${level})`);
      }
    }

    if (reasons.length === 0) {
      return null; // ✅ Approved
    }

    return reasons.join('; ');
  }

  // ── Helper: Check multiple possible field names for a truthy value ─────
  private detectFlag(obj: any, keys: string[]): boolean {
    for (const key of keys) {
      // Top-level check
      if (obj?.[key] === true || obj?.[key] === 'enabled') return true;

      // Nested under `tokenMeta` or `details`
      if (obj?.tokenMeta?.[key] === true) return true;
      if (obj?.details?.[key]   === true) return true;
    }

    // Also scan the risks array for matching names
    const risks: any[] = obj?.risks ?? [];
    for (const risk of risks) {
      const name: string = (risk?.name ?? '').toLowerCase().replace(/\s+/g, '_');
      if (keys.some(k => name.includes(k.toLowerCase()))) {
        // Only flag if it's not "none" level
        const level = (risk?.level ?? '').toLowerCase();
        if (level !== 'none' && level !== 'info') return true;
      }
    }

    return false;
  }
}
