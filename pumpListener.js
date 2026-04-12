/**
 * Pump.fun Launch Listener
 *
 * Subscribes to Pump.fun program logs via Helius WebSocket.
 * Extracts the mint address directly from the log data —
 * no separate getTransaction call needed, which was causing
 * the "Could not extract mint" errors due to propagation delay.
 *
 * Pump.fun program ID: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 *
 * The logsNotification payload includes the full account list
 * in value.logs and the accounts in the transaction message.
 * We pull the mint from the accountKeys in the notification itself.
 */

const WebSocket = require('ws');
const config = require('./config');
const logger = require('./logger');

const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

class PumpListener {
  constructor(onNewToken) {
    this.onNewToken = onNewToken;
    this.ws = null;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.running = false;
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
      logger.info('[LISTENER] WebSocket connected. Subscribing to Pump.fun logs...');
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

    this.ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.id === 1 && msg.result !== undefined) {
          logger.info(`[LISTENER] Subscribed to Pump.fun logs (sub ID: ${msg.result})`);
          return;
        }

        if (msg.method === 'logsNotification') {
          await this.handleLog(msg.params?.result);
        }
      } catch (err) {
        logger.debug(`[LISTENER] Message parse error: ${err.message}`);
      }
    });

    this.ws.on('error', (err) => {
      logger.error(`[LISTENER] WebSocket error: ${err.message}`);
    });

    this.ws.on('close', () => {
      logger.warn('[LISTENER] WebSocket closed');
      if (this.running) {
        logger.info(`[LISTENER] Reconnecting in ${this.reconnectDelay}ms...`);
        setTimeout(() => {
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
          this.connect();
        }, this.reconnectDelay);
      }
    });
  }

  async handleLog(result) {
    if (!result?.value) return;

    const { value } = result;
    const logs = value.logs || [];
    const signature = value.signature;

    // Skip errored transactions
    if (value.err) return;

    // Must be a create instruction
    const isCreate = logs.some(log =>
      log.includes('Instruction: Create') ||
      log.includes('Program log: create')
    );
    if (!isCreate) return;

    const detectedAt = Date.now();
    logger.info(`[LISTENER] New token create! Sig: ${signature.slice(0, 20)}...`);

    // ── Extract mint from log text ──
    // Pump.fun logs the mint address in a line like:
    // "Program log: mint: <ADDRESS>"
    // Try that first — zero extra RPC calls, instant.
    let mint = extractMintFromLogs(logs);

    // ── Fallback: parse from accountKeys in the notification ──
    // Helius enriched WS sometimes includes accounts in the payload
    if (!mint) {
      mint = extractMintFromAccounts(value);
    }

    if (!mint) {
      logger.warn(`[LISTENER] Could not extract mint from logs for ${signature.slice(0, 20)}... — skipping`);
      return;
    }

    logger.info(`[LISTENER] Mint: ${mint} | Detection latency: ${Date.now() - detectedAt}ms`);

    this.onNewToken(mint, detectedAt).catch(err => {
      logger.error(`[LISTENER] onNewToken error: ${err.message}`);
    });
  }
}

/**
 * Try to extract mint address from Pump.fun log lines.
 * Pump.fun emits lines like:
 *   "Program log: mint: So11111..."
 *   "Program data: <base64>"  <- sometimes contains mint info
 */
function extractMintFromLogs(logs) {
  for (const log of logs) {
    // Pattern: "Program log: mint: <ADDR>"
    const mintMatch = log.match(/mint:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (mintMatch) return mintMatch[1];

    // Pattern: address appearing after "create" in log
    const createMatch = log.match(/create.*?([1-9A-HJ-NP-Za-km-z]{43,44})/);
    if (createMatch) return createMatch[1];
  }
  return null;
}

/**
 * Helius enriched websocket notifications sometimes include
 * account keys directly in the notification payload.
 * On Pump.fun creates, index 1 is the mint.
 */
function extractMintFromAccounts(value) {
  try {
    // Helius may include accountKeys at various paths depending on version
    const accounts =
      value?.transaction?.message?.accountKeys ||
      value?.transaction?.message?.staticAccountKeys ||
      value?.accountKeys ||
      null;

    if (!accounts || accounts.length < 2) return null;

    const mint = accounts[1];
    if (typeof mint === 'string' && mint.length >= 32) return mint;
    if (mint?.pubkey) return mint.pubkey;
    if (mint?.toBase58) return mint.toBase58();
  } catch {
    // ignore
  }
  return null;
}

module.exports = PumpListener;
