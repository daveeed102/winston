/**
 * Wallet loader
 * Loads keypair from WALLET_PRIVATE_KEY env var (byte array format)
 */

const { Keypair } = require('@solana/web3.js');
const config = require('./config');
const logger = require('./logger');

let _keypair = null;

function getKeypair() {
  if (_keypair) return _keypair;

  try {
    const raw = JSON.parse(config.WALLET_PRIVATE_KEY);
    _keypair = Keypair.fromSecretKey(Uint8Array.from(raw));
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
