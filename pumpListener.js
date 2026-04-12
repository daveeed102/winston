/**
 * Pump.fun Launch Listener - v6
 *
 * Uses Helius Enhanced WebSocket (transactionSubscribe) instead of
 * logsSubscribe. This streams the FULL parsed transaction in the
 * notification itself — zero secondary RPC calls needed.
 *
 * transactionSubscribe is available on all Helius plans including free.
 * It includes accountKeys, tokenBalances, etc. right in the message.
 *
 * Pump.fun program: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 */

const WebSocket = require('ws');
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
    logger.info('[LISTENER] Connecting to Helius Enhanced WebSocket...');
    this.ws = new WebSocket(config.HELIUS_WS_URL);

    this.ws.on('open', () => {
      logger.info('[LISTENER] Connected. Subscribing via transactionSubscribe...');
      this.reconnectDelay = 1000;

      // transactionSubscribe: streams full tx data for every Pump.fun transaction
      // accountInclude filters to only txs that mention the pump program
      this.ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'transactionSubscribe',
        params: [
          {
            accountInclude: [PUMP_PROGRAM_ID],
            failed: false,
          },
          {
            commitment: 'processed',
            encoding: 'jsonParsed',
            transactionDetails: 'full',
            maxSupportedTransactionVersion: 0,
          },
        ],
      }));
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.id === 1 && msg.result !== undefined) {
          logger.info(`[LISTENER] transactionSubscribe confirmed (sub ID: ${msg.result})`);
          return;
        }

        if (msg.method === 'transactionNotification') {
          this.handleTransaction(msg.params?.result);
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

  handleTransaction(result) {
    if (!result) return;

    const detectedAt = Date.now();
    const tx = result.transaction;
    const signature = result.signature;

    if (!tx) return;

    // Check this is a Create instruction by scanning log messages
    const logs = tx.meta?.logMessages || [];
    const isCreate = logs.some(log =>
      log.includes('Instruction: Create') ||
      log.includes('Program log: create')
    );
    if (!isCreate) return;

    // Extract mint from the transaction data that came WITH the notification
    const mint = extractMint(tx);

    if (!mint) {
      logger.debug(`[LISTENER] Create tx but no mint found: ${signature?.slice(0, 20)}`);
      return;
    }

    // Deduplicate
    if (this.seenMints.has(mint)) return;
    this.seenMints.add(mint);

    // Trim seen mints set to avoid memory leak
    if (this.seenMints.size > 500) {
      const first = this.seenMints.values().next().value;
      this.seenMints.delete(first);
    }

    logger.info(`[LISTENER] ✅ New token: ${mint} | Sig: ${signature?.slice(0, 20)}...`);

    this.onNewToken(mint, detectedAt).catch(err => {
      logger.error(`[LISTENER] onNewToken error: ${err.message}`);
    });
  }
}

/**
 * Extract mint address from the full transaction notification.
 * Tries multiple fields in order of reliability.
 */
function extractMint(tx) {
  // Method 1: postTokenBalances — most reliable, direct mint field
  const postBals = tx.meta?.postTokenBalances || [];
  for (const bal of postBals) {
    if (isGoodMint(bal.mint)) return bal.mint;
  }

  // Method 2: preTokenBalances
  const preBals = tx.meta?.preTokenBalances || [];
  for (const bal of preBals) {
    if (isGoodMint(bal.mint)) return bal.mint;
  }

  // Method 3: parsed inner instructions — look for initializeMint
  const innerIxGroups = tx.meta?.innerInstructions || [];
  for (const group of innerIxGroups) {
    for (const ix of (group.instructions || [])) {
      const parsed = ix.parsed;
      if (
        parsed?.type === 'initializeMint' ||
        parsed?.type === 'initializeMint2' ||
        parsed?.type === 'initializeMint3'
      ) {
        if (isGoodMint(parsed?.info?.mint)) return parsed.info.mint;
      }
    }
  }

  // Method 4: account keys — pump.fun create layout has mint at index 1
  const accountKeys = tx.transaction?.message?.accountKeys || [];
  for (let i = 1; i <= 4; i++) {
    const acct = accountKeys[i];
    const addr = typeof acct === 'string' ? acct : acct?.pubkey;
    if (isGoodMint(addr)) return addr;
  }

  return null;
}

function isGoodMint(addr) {
  if (!addr || typeof addr !== 'string') return false;
  if (addr.length < 32 || addr.length > 44) return false;
  if (SKIP_ADDRESSES.has(addr)) return false;
  return true;
}

module.exports = PumpListener;
