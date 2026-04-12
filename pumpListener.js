/**
 * Pump.fun Launch Listener - v7
 *
 * Uses logsSubscribe (works on all Helius tiers) but resolves the mint
 * via the Helius Enhanced Transactions REST API which parses the tx
 * server-side and returns clean JSON — much more reliable than getTransaction.
 *
 * Endpoint: GET https://api.helius.xyz/v0/transactions?api-key=KEY&transactions=SIG
 */

const WebSocket = require('ws');
const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

const SKIP_ADDRESSES = new Set([
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bmd',
  'So11111111111111111111111111111111111111112',
  'SysvarRent111111111111111111111111111111111',
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1',
  'SysvarC1ock11111111111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  'TokenzQdBNbTqFELkCAV1hChMvnhugn5YBnbWEKFRso',
]);

class PumpListener {
  constructor(onNewToken) {
    this.onNewToken = onNewToken;
    this.ws = null;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.running = false;
    this.pendingSigs = new Set();
    this.seenMints = new Set();
  }

  start() {
    this.running = true;
    this.connect();
  }

  stop() {
    this.running = false;
    if (this.ws) this.ws.close();
  }

  connect() {
    logger.info('[LISTENER] Connecting to Helius WebSocket...');
    this.ws = new WebSocket(config.HELIUS_WS_URL);

    this.ws.on('open', () => {
      logger.info('[LISTENER] Connected. Subscribing to Pump.fun logs...');
      this.reconnectDelay = 1000;

      this.ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'logsSubscribe',
        params: [
          { mentions: [PUMP_PROGRAM_ID] },
          { commitment: 'processed' },
        ],
      }));
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.id === 1 && msg.result !== undefined) {
          logger.info(`[LISTENER] Subscribed to logs (sub ID: ${msg.result})`);
          return;
        }

        if (msg.method === 'logsNotification') {
          this.handleLog(msg.params?.result);
        }
      } catch (err) {
        logger.debug(`[LISTENER] Parse error: ${err.message}`);
      }
    });

    this.ws.on('error', (err) => logger.error(`[LISTENER] WS error: ${err.message}`));

    this.ws.on('close', () => {
      logger.warn('[LISTENER] WS closed');
      if (this.running) {
        setTimeout(() => {
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
          this.connect();
        }, this.reconnectDelay);
      }
    });
  }

  handleLog(result) {
    if (!result?.value) return;
    const { value } = result;
    if (value.err) return;

    const logs = value.logs || [];
    const signature = value.signature;

    if (!signature || signature.length < 80) return;

    const isCreate = logs.some(log =>
      log.includes('Instruction: Create') ||
      log.includes('Program log: create')
    );
    if (!isCreate) return;
    if (this.pendingSigs.has(signature)) return;

    this.pendingSigs.add(signature);
    const detectedAt = Date.now();
    logger.info(`[LISTENER] Create detected: ${signature.slice(0, 20)}...`);

    this.resolveAndBuy(signature, detectedAt).finally(() => {
      this.pendingSigs.delete(signature);
    });
  }

  async resolveAndBuy(signature, detectedAt) {
    const mint = await resolveMint(signature);

    if (!mint) {
      logger.warn(`[LISTENER] Could not resolve mint for ${signature.slice(0, 20)}`);
      return;
    }

    // Deduplicate mints
    if (this.seenMints.has(mint)) return;
    this.seenMints.add(mint);
    if (this.seenMints.size > 500) {
      this.seenMints.delete(this.seenMints.values().next().value);
    }

    const ageMs = Date.now() - detectedAt;
    logger.info(`[LISTENER] ✅ Mint: ${mint} | Latency: ${ageMs}ms`);

    try {
      await this.onNewToken(mint, detectedAt);
    } catch (err) {
      logger.error(`[LISTENER] onNewToken error: ${err.message}`);
    }
  }
}

/**
 * Resolve mint using Helius Enhanced Transactions API
 * GET https://api.helius.xyz/v0/transactions?api-key=KEY
 * Body: { transactions: [signature] }
 *
 * This returns a fully parsed transaction object with tokenTransfers,
 * accountData, etc. — much easier to extract mint from than raw RPC.
 */
async function resolveMint(signature) {
  const delays = [600, 1200, 2500, 5000];

  for (let i = 0; i < delays.length; i++) {
    await sleep(delays[i]);

    try {
      // Helius Enhanced Transactions API
      const response = await axios.post(
        `https://api.helius.xyz/v0/transactions/?api-key=${config.HELIUS_API_KEY}`,
        { transactions: [signature] },
        { timeout: 8000 }
      );

      const txList = response.data;
      if (!Array.isArray(txList) || txList.length === 0) {
        logger.debug(`[LISTENER] No tx data yet (attempt ${i + 1})`);
        continue;
      }

      const tx = txList[0];
      if (!tx) continue;

      // Method 1: tokenTransfers — cleanest field, has mint directly
      const transfers = tx.tokenTransfers || [];
      for (const t of transfers) {
        if (isGoodMint(t.mint)) return t.mint;
      }

      // Method 2: accountData with tokenBalanceChanges
      const accountData = tx.accountData || [];
      for (const acct of accountData) {
        for (const change of (acct.tokenBalanceChanges || [])) {
          if (isGoodMint(change.mint)) return change.mint;
        }
      }

      // Method 3: nativeTransfers won't have mint, but instructions might
      const ixs = tx.instructions || [];
      for (const ix of ixs) {
        for (const inner of (ix.innerInstructions || [])) {
          if (inner.parsed?.type?.includes('initializeMint')) {
            const mint = inner.parsed?.info?.mint;
            if (isGoodMint(mint)) return mint;
          }
          // accounts array on inner instructions
          const accts = inner.accounts || [];
          for (const addr of accts) {
            if (isGoodMint(addr)) return addr;
          }
        }
      }

      logger.debug(`[LISTENER] TX parsed but mint not found (attempt ${i + 1}), tx type: ${tx.type}`);

    } catch (err) {
      logger.debug(`[LISTENER] Resolve attempt ${i + 1} error: ${err.message}`);
    }
  }

  return null;
}

function isGoodMint(addr) {
  if (!addr || typeof addr !== 'string') return false;
  if (addr.length < 32 || addr.length > 44) return false;
  if (SKIP_ADDRESSES.has(addr)) return false;
  return true;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = PumpListener;
