/**
 * Pump.fun Launch Listener
 *
 * Subscribes to Pump.fun's program logs via Helius WebSocket.
 * Fires a callback the instant a new token "create" event is detected.
 *
 * Pump.fun program ID: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 *
 * Strategy:
 *  - Subscribe to logsSubscribe for the Pump.fun program
 *  - Parse each log for the "create" instruction signature
 *  - Extract mint address from the transaction accounts
 *  - Emit the mint + detected timestamp immediately
 */

const WebSocket = require('ws');
const { Connection, PublicKey } = require('@solana/web3.js');
const config = require('./config');
const logger = require('./logger');

const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

class PumpListener {
  constructor(onNewToken) {
    this.onNewToken = onNewToken; // async callback(mintAddress, detectedAt)
    this.ws = null;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.running = false;
    this.subId = null;
    this.connection = new Connection(config.HELIUS_RPC_URL, 'confirmed');
  }

  start() {
    this.running = true;
    this.connect();
  }

  stop() {
    this.running = false;
    if (this.ws) {
      this.ws.close();
    }
  }

  connect() {
    logger.info('[LISTENER] Connecting to Helius WebSocket...');

    this.ws = new WebSocket(config.HELIUS_WS_URL);

    this.ws.on('open', () => {
      logger.info('[LISTENER] WebSocket connected. Subscribing to Pump.fun logs...');
      this.reconnectDelay = 1000; // reset backoff on success

      // Subscribe to all logs mentioning the Pump.fun program
      const subscribeMsg = {
        jsonrpc: '2.0',
        id: 1,
        method: 'logsSubscribe',
        params: [
          { mentions: [PUMP_PROGRAM_ID] },
          { commitment: 'processed' }, // fastest commitment level
        ],
      };
      this.ws.send(JSON.stringify(subscribeMsg));
    });

    this.ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Subscription confirmation
        if (msg.id === 1 && msg.result !== undefined) {
          this.subId = msg.result;
          logger.info(`[LISTENER] Subscribed to Pump.fun logs (sub ID: ${this.subId})`);
          return;
        }

        // Log notification
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
    if (!result) return;

    const { value, context } = result;
    if (!value) return;

    const logs = value.logs || [];
    const signature = value.signature;

    // Quick check: does this transaction contain a "create" instruction?
    // Pump.fun logs "Program log: Instruction: Create" for new token launches
    const isCreate = logs.some(log =>
      log.includes('Instruction: Create') ||
      log.includes('Program log: create')
    );

    if (!isCreate) return;

    // Also verify it's not an error transaction
    if (value.err) return;

    logger.info(`[LISTENER] New token create detected! Sig: ${signature}`);

    // Fetch the full transaction to get the mint address
    const detectedAt = Date.now();

    try {
      const mintAddress = await this.extractMintFromTransaction(signature);
      if (!mintAddress) {
        logger.warn(`[LISTENER] Could not extract mint from ${signature}`);
        return;
      }

      logger.info(`[LISTENER] Mint address: ${mintAddress} | Age: ${Date.now() - detectedAt}ms`);

      // Fire the callback - don't await here so we don't block the listener
      this.onNewToken(mintAddress, detectedAt).catch(err => {
        logger.error(`[LISTENER] onNewToken callback error: ${err.message}`);
      });

    } catch (err) {
      logger.error(`[LISTENER] Failed to extract mint from ${signature}: ${err.message}`);
    }
  }

  async extractMintFromTransaction(signature) {
    try {
      const tx = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!tx) return null;

      // On Pump.fun creates, the new mint is typically the 2nd account key
      // Account layout for Pump.fun create:
      // [0] = signer/payer
      // [1] = mint (the new token)
      // [2] = mint authority / bonding curve
      // ... etc
      const accounts = tx.transaction.message.getAccountKeys
        ? tx.transaction.message.getAccountKeys().staticAccountKeys
        : tx.transaction.message.accountKeys;

      if (!accounts || accounts.length < 2) return null;

      // Index 1 is the mint on Pump.fun creates
      const mint = accounts[1];
      return mint.toBase58 ? mint.toBase58() : mint.toString();

    } catch (err) {
      logger.debug(`[LISTENER] getTransaction error for ${signature}: ${err.message}`);
      return null;
    }
  }
}

module.exports = PumpListener;
