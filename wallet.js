/**
 * Wallet loader
 * Accepts WALLET_PRIVATE_KEY in two formats:
 *   - Raw base58 string (what Phantom exports directly)
 *   - JSON byte array [1,2,3,...] (old format)
 */

const { Keypair } = require('@solana/web3.js');
const config = require('./config');
const logger = require('./logger');

let _keypair = null;

function getKeypair() {
  if (_keypair) return _keypair;

  const raw = config.WALLET_PRIVATE_KEY.trim();

  try {
    if (raw.startsWith('[')) {
      // Format: JSON byte array [1,2,3,...]
      const bytes = JSON.parse(raw);
      _keypair = Keypair.fromSecretKey(Uint8Array.from(bytes));
    } else {
      // Format: raw base58 string directly from Phantom/Solflare
      const bs58 = require('bs58');
      const bytes = bs58.decode(raw);
      _keypair = Keypair.fromSecretKey(bytes);
    }

    logger.info(`[WALLET] Loaded wallet: ${_keypair.publicKey.toBase58()}`);
    return _keypair;

  } catch (err) {
    throw new Error(`Failed to load wallet keypair: ${err.message}. Check WALLET_PRIVATE_KEY in .env`);
  }
}

function getPublicKey() {
  return getKeypair().publicKey;
}

module.exports = { getKeypair, getPublicKey };
