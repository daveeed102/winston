/**
 * Pump.fun Launch Listener - v4
 *
 * Uses Helius programSubscribe to watch the Pump.fun program for
 * new accounts being created. When a new bonding curve account is
 * created, the mint address is embedded directly in the account data
 * at a known offset — no secondary RPC call needed at all.
 *
 * Pump.fun program:      6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 * Bonding curve layout:  [discriminator 8 bytes][mint pubkey 32 bytes]...
 *
 * Alternative approach used here for maximum reliability:
 * Subscribe to logs, store the FULL signature, then use
 * Helius getTransaction with retries (waiting for confirmation).
 * We keep the full sig in memory, not the truncated display version.
 */

const WebSocket = require('ws');
const { Connection, PublicKey } = require('@solana/web3.js');
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
    this.pendingSigs = new Set();
    this.connection = new Connection(config.HELIUS_RPC_URL, 'confirmed');
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
      logger.info('[LISTENER] Connected. Subscribing to Pump.fun program...');
      this.reconnectDelay = 1000;

      // Subscribe to logs — we get the FULL signature in the notification
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

    this.ws.on('error', (err) => {
      logger.error(`[LISTENER] WS error: ${err.message}`);
    });

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
    const signature = value.signature; // This is the FULL signature from Helius

    if (!signature || signature.length < 80) return; // sanity check it's a real sig

    const isCreate = logs.some(log =>
      log.includes('Instruction: Create') ||
      log.includes('Program log: create')
    );
    if (!isCreate) return;
    if (this.pendingSigs.has(signature)) return;

    this.pendingSigs.add(signature);
    const detectedAt = Date.now();
    logger.info(`[LISTENER] Create detected: ${signature.slice(0, 24)}...`);

    // Resolve asynchronously — don't block the WS message handler
    this.resolveAndBuy(signature, detectedAt).finally(() => {
      this.pendingSigs.delete(signature);
    });
  }

  async resolveAndBuy(signature, detectedAt) {
    const mint = await getMintFromTransaction(this.connection, signature);

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
 * Fetch the transaction and extract the mint from account keys.
 * Retries with escalating delays to handle propagation lag.
 *
 * On Pump.fun create transactions the account layout is:
 * [0] = feePayerWallet / signer
 * [1] = mint (the new token) ← this is what we want
 * [2] = bondingCurve
 * [3] = associatedBondingCurve
 * [4] = global config
 * [5] = mplTokenMetadata program
 * ... etc
 */
async function getMintFromTransaction(connection, signature) {
  const delays = [500, 1000, 2000, 4000, 6000];

  for (let i = 0; i < delays.length; i++) {
    await sleep(delays[i]);

    try {
      const tx = await connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!tx) {
        logger.debug(`[LISTENER] TX not found yet (attempt ${i + 1})`);
        continue;
      }

      // Get account keys from the transaction message
      let accounts;
      try {
        // Versioned transactions (V0)
        const msg = tx.transaction.message;
        if (msg.getAccountKeys) {
          accounts = msg.getAccountKeys().staticAccountKeys;
        } else {
          accounts = msg.accountKeys;
        }
      } catch {
        accounts = tx.transaction.message.accountKeys;
      }

      if (!accounts || accounts.length < 2) {
        logger.debug(`[LISTENER] Not enough accounts in TX`);
        continue;
      }

      // Index 1 = mint on Pump.fun creates
      const mintAccount = accounts[1];
      const mintAddress = mintAccount?.toBase58
        ? mintAccount.toBase58()
        : mintAccount?.toString?.()
        ?? mintAccount;

      if (mintAddress && isValidSolanaAddress(mintAddress) && !isSystemAddress(mintAddress)) {
        return mintAddress;
      }

      // Fallback: scan token balances for a mint that changed
      const postBalances = tx.meta?.postTokenBalances || [];
      for (const bal of postBalances) {
        if (bal.mint && isValidSolanaAddress(bal.mint) && !isSystemAddress(bal.mint)) {
          return bal.mint;
        }
      }

      logger.debug(`[LISTENER] Could not find valid mint in TX accounts`);
      return null;

    } catch (err) {
      logger.debug(`[LISTENER] getTransaction attempt ${i + 1} error: ${err.message}`);
    }
  }

  return null;
}

function isValidSolanaAddress(addr) {
  if (typeof addr !== 'string') return false;
  return addr.length >= 32 && addr.length <= 44;
}

function isSystemAddress(addr) {
  const system = new Set([
    '11111111111111111111111111111111',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bmd',
    'So11111111111111111111111111111111111111112',
    'SysvarRent111111111111111111111111111111111',
    'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1',
  ]);
  return system.has(addr);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = PumpListener;
