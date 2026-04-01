'use strict';

/**
 * JupiterService — Swap Execution Stubs
 *
 * ═══════════════════════════════════════════════════════════════════
 * Replace sellTokenForSol() and buySolForToken() with your existing
 * Jupiter swap logic. Both must return a transaction signature string
 * and throw on failure.
 * ═══════════════════════════════════════════════════════════════════
 */

const { config } = require('./config');

class JupiterService {
  constructor() {
    this.SOL_MINT = config.SOL_MINT;
  }

  /**
   * Sell full token balance → SOL.
   * REPLACE THIS with your Jupiter swap implementation.
   */
  async sellTokenForSol(tokenAddress) {
    // ── REPLACE FROM HERE ─────────────────────────────────────────────
    // const balance = await this.getTokenBalance(tokenAddress);
    // if (balance === 0) return 'no-balance';
    // const quote  = await this.getQuote({ inputMint: tokenAddress, outputMint: this.SOL_MINT, amount: balance, slippageBps: config.SLIPPAGE_BPS });
    // const swapTx = await this.buildSwapTransaction(quote);
    // return await this.signAndSend(swapTx);
    // ── TO HERE ───────────────────────────────────────────────────────
    console.warn(`[JUPITER STUB] sellTokenForSol(${tokenAddress}) — implement me!`);
    throw new Error('JupiterService.sellTokenForSol not implemented. See jupiterService.js.');
  }

  /**
   * Buy token with exactly 0.1813 SOL (181300000 lamports).
   * REPLACE THIS with your Jupiter swap implementation.
   */
  async buySolForToken(tokenAddress) {
    // ── REPLACE FROM HERE ─────────────────────────────────────────────
    // const quote  = await this.getQuote({ inputMint: this.SOL_MINT, outputMint: tokenAddress, amount: config.BUY_AMOUNT_LAMPORTS, slippageBps: config.SLIPPAGE_BPS });
    // const swapTx = await this.buildSwapTransaction(quote);
    // return await this.signAndSend(swapTx);
    // ── TO HERE ───────────────────────────────────────────────────────
    console.warn(`[JUPITER STUB] buySolForToken(${tokenAddress}) — implement me!`);
    throw new Error('JupiterService.buySolForToken not implemented. See jupiterService.js.');
  }

  async getTokenBalance(tokenAddress) {
    throw new Error('JupiterService.getTokenBalance not implemented.');
  }
}

module.exports = { JupiterService };
