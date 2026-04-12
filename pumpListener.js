/**
 * Pump.fun Launch Listener - v5
 *
 * Detection: logsSubscribe on Pump.fun program ID
 * Mint resolution: Helius getParsedTransaction REST API
 * (more reliable than WS getTransaction for brand new txs)
 */

const WebSocket = require('ws');
const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

// System/program addresses to exclude when scanning for the mint
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
]);

class PumpListener {
  constructor(onNewToken) {
    this.onNewToken = onNewToken;
    this.ws = null;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.running = false;
    this.pendingSigs = new Set();
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
          logger.info(`[LISTENER] Subscribed (sub ID: ${msg.result})`);
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

    // Must be full length sig (88 chars), not truncated
    if (!signature || signature.length < 80) return;

    const isCreate = logs.some(log =>
      log.includes('Instruction: Create') ||
      log.includes('Program log: create')
    );
    if (!isCreate) return;
    if (this.pendingSigs.has(signature)) return;

    this.pendingSigs.add(signature);
    const detectedAt = Date.now();
    logger.info(`[LISTENER] Create detected: ${signature.slice(0, 24)}...`);

    this.resolveAndBuy(signature, detectedAt).finally(() => {
      this.pendingSigs.delete(signature);
    });
  }

  async resolveAndBuy(signature, detectedAt) {
    const mint = await resolveMintViaHelius(signature);

    if (!mint) {
      logger.warn(`[LISTENER] Could not resolve mint for ${signature.slice(0, 24)}`);
      return;
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
 * Use Helius REST API to get the parsed transaction.
 * Retries with escalating delays — tx needs to confirm first.
 * Extracts mint from postTokenBalances (most reliable field).
 */
async function resolveMintViaHelius(signature) {
  const url = `${config.HELIUS_RPC_URL}`;
  const delays = [800, 1500, 3000, 5000];

  for (let i = 0; i < delays.length; i++) {
    await sleep(delays[i]);

    try {
      const response = await axios.post(url, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getParsedTransaction',
        params: [
          signature,
          {
            encoding: 'jsonParsed',
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          },
        ],
      }, { timeout: 8000 });

      const tx = response.data?.result;
      if (!tx) {
        logger.debug(`[LISTENER] TX not ready yet (attempt ${i + 1})`);
        continue;
      }

      // Method 1: postTokenBalances — most reliable
      const postBals = tx.meta?.postTokenBalances || [];
      for (const bal of postBals) {
        if (bal.mint && !SKIP_ADDRESSES.has(bal.mint) && bal.mint.length >= 32) {
          logger.debug(`[LISTENER] Mint from postTokenBalances: ${bal.mint}`);
          return bal.mint;
        }
      }

      // Method 2: parsed account keys — look for newly initialized mint
      const accounts = tx.transaction?.message?.accountKeys || [];
      // On pump.fun creates, index 1 is the mint
      for (let idx = 1; idx <= 3; idx++) {
        const acct = accounts[idx];
        const addr = acct?.pubkey || acct;
        if (addr && typeof addr === 'string' && !SKIP_ADDRESSES.has(addr) && addr.length >= 32) {
          logger.debug(`[LISTENER] Mint from accountKeys[${idx}]: ${addr}`);
          return addr;
        }
      }

      // Method 3: innerInstructions — look for initializeMint
      const innerIxs = tx.meta?.innerInstructions || [];
      for (const group of innerIxs) {
        for (const ix of (group.instructions || [])) {
          if (ix.parsed?.type === 'initializeMint' || ix.parsed?.type === 'initializeMint2') {
            const mint = ix.parsed?.info?.mint;
            if (mint && !SKIP_ADDRESSES.has(mint)) {
              logger.debug(`[LISTENER] Mint from initializeMint instruction: ${mint}`);
              return mint;
            }
          }
        }
      }

      logger.debug(`[LISTENER] TX found but no mint extracted (attempt ${i + 1})`);
      return null;

    } catch (err) {
      logger.debug(`[LISTENER] Attempt ${i + 1} error: ${err.message}`);
    }
  }

  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = PumpListener;
