'use strict';

const { config } = require('./config');

class RugcheckService {
  constructor() {
    this.baseUrl   = 'https://api.rugcheck.xyz/v1/tokens';
    this.timeoutMs = 15000;
  }

  get riskThreshold() {
    return config.RUGCHECK_RISK_THRESHOLD || 500;
  }

  /**
   * Returns null if token passes, or a rejection reason string.
   */
  async audit(tokenAddress) {
    const url        = `${this.baseUrl}/${tokenAddress}/report/summary`;
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), this.timeoutMs);

    let response;
    try {
      response = await fetch(url, {
        method:  'GET',
        signal:  controller.signal,
        headers: { 'Accept': 'application/json' },
      });
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`Rugcheck timed out after ${this.timeoutMs / 1000}s`);
      throw new Error(`Rugcheck fetch failed: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      if (response.status === 404) return 'Token not found on Rugcheck (unverified/unknown token)';
      const body = await response.text().catch(() => '');
      throw new Error(`Rugcheck HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    return this.evaluate(data);
  }

  evaluate(report) {
    const reasons = [];

    if (this.detectFlag(report, ['mintAuthorityEnabled', 'mintAuthority', 'mint_authority'])) {
      reasons.push('Mint authority is still active (dev can mint unlimited supply)');
    }

    if (this.detectFlag(report, ['freezeAuthorityEnabled', 'freezeAuthority', 'freeze_authority'])) {
      reasons.push('Freeze authority is still active (dev can freeze wallets)');
    }

    const score = report?.score ?? report?.riskScore ?? report?.risk_score ?? 0;
    if (score >= this.riskThreshold) {
      reasons.push(`Risk score ${score} exceeds threshold of ${this.riskThreshold}`);
    }

    const risks = report?.risks ?? [];
    for (const risk of risks) {
      const level = (risk?.level ?? risk?.severity ?? '').toLowerCase();
      if (level === 'danger' || level === 'critical') {
        reasons.push(`Critical risk flag: "${risk.name}" (${level})`);
      }
    }

    return reasons.length === 0 ? null : reasons.join('; ');
  }

  detectFlag(obj, keys) {
    for (const key of keys) {
      if (obj?.[key] === true || obj?.[key] === 'enabled') return true;
      if (obj?.tokenMeta?.[key] === true) return true;
      if (obj?.details?.[key]   === true) return true;
    }
    const risks = obj?.risks ?? [];
    for (const risk of risks) {
      const name  = (risk?.name ?? '').toLowerCase().replace(/\s+/g, '_');
      const level = (risk?.level ?? '').toLowerCase();
      if (keys.some(k => name.includes(k.toLowerCase())) && level !== 'none' && level !== 'info') return true;
    }
    return false;
  }
}

module.exports = { RugcheckService };
