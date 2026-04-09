// FILE: src/sources/dexscreener.js
// DexScreener API client. Primary token discovery and market data source.
// Pulls trending/boosted tokens on Solana and enriches them with pair data.

const axios = require('axios');
const config = require('./config');
const { createLogger } = require('./logger');

const log = createLogger('DEXSCREENER');

const BASE = config.DEXSCREENER_BASE;
const TIMEOUT = 12000;

// ─── Fetch trending / boosted Solana tokens ───────────────────────────────────
// Returns a raw list of token addresses currently getting traction on Solana.

async function getTrendingTokens() {
  const results = new Map(); // address -> profile data

  // Source 1: active boosts (tokens with paid promotion = real attention signal)
  try {
    const res = await axios.get('https://api.dexscreener.com/token-boosts/active/v1', { timeout: TIMEOUT });
    const items = Array.isArray(res.data) ? res.data : [];
    for (const item of items) {
      if (item.chainId === 'solana' && item.tokenAddress) {
        results.set(item.tokenAddress, {
          tokenAddress: item.tokenAddress,
          boostAmount: item.totalAmount || 0,
          description: item.description || '',
          links: item.links || [],
        });
      }
    }
    log.info(`Active boosts: ${results.size} Solana tokens`);
  } catch (err) {
    log.warn(`Boost fetch failed: ${err.message}`);
  }

  // Source 2: latest token profiles (recently active tokens)
  try {
    const res = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: TIMEOUT });
    const items = Array.isArray(res.data) ? res.data : [];
    for (const item of items) {
      if (item.chainId === 'solana' && item.tokenAddress) {
        if (!results.has(item.tokenAddress)) {
          results.set(item.tokenAddress, {
            tokenAddress: item.tokenAddress,
            boostAmount: 0,
            description: item.description || '',
            links: item.links || [],
          });
        }
      }
    }
    log.info(`Profiles: ${results.size} total Solana candidates`);
  } catch (err) {
    log.warn(`Profile fetch failed: ${err.message}`);
  }

  return Array.from(results.values());
}

// ─── Fetch full pair data for a list of token addresses ───────────────────────
// DexScreener allows batches of up to 30 addresses.

async function getTokenPairs(addresses) {
  const allPairs = [];
  const batches = chunkArray(addresses, 30);

  for (const batch of batches) {
    try {
      const joined = batch.join(',');
      const res = await axios.get(`${BASE}/tokens/v1/solana/${joined}`, { timeout: TIMEOUT });
      const pairs = Array.isArray(res.data) ? res.data : (res.data?.pairs || []);
      allPairs.push(...pairs);
    } catch (err) {
      log.warn(`Pair fetch failed for batch: ${err.message}`);
    }
  }

  return allPairs;
}

// ─── Get single token's best pair ─────────────────────────────────────────────

async function getTokenData(address) {
  try {
    const res = await axios.get(`${BASE}/tokens/v1/solana/${address}`, { timeout: TIMEOUT });
    const pairs = Array.isArray(res.data) ? res.data : (res.data?.pairs || []);
    if (!pairs.length) return null;
    // Pick highest liquidity pair
    return pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  } catch (err) {
    log.warn(`Token data fetch failed for ${address}: ${err.message}`);
    return null;
  }
}

// ─── Normalize a DexScreener pair into Winston's candidate format ─────────────

function normalizePair(pair, profile = {}) {
  if (!pair) return null;

  const priceUsd = parseFloat(pair.priceUsd || 0);
  const liquidityUsd = pair.liquidity?.usd || 0;
  const volume24h = pair.volume?.h24 || 0;
  const volume6h = pair.volume?.h6 || 0;
  const volume1h = pair.volume?.h1 || 0;
  const priceChange24h = pair.priceChange?.h24 || 0;
  const priceChange6h = pair.priceChange?.h6 || 0;
  const priceChange1h = pair.priceChange?.h1 || 0;
  const priceChange5m = pair.priceChange?.m5 || 0;

  // Token age in hours
  const createdAt = pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : null;
  const ageHours = createdAt ? (Date.now() - createdAt.getTime()) / (1000 * 60 * 60) : null;

  // Transaction counts (buyer activity signal)
  const txns = pair.txns || {};
  const buys1h = txns.h1?.buys || 0;
  const sells1h = txns.h1?.sells || 0;
  const buys24h = txns.h24?.buys || 0;

  // Estimate pullback from ATH if we have 24h high — DexScreener doesn't expose ATH directly
  // We use 24h price range as proxy: if price is near 24h high, less pullback
  const high24h = pair.priceHighH24 || priceUsd;
  const pullbackFromHigh = high24h > 0 ? ((high24h - priceUsd) / high24h) * 100 : 0;

  // Social links from profile
  const socialLinks = (profile.links || []).map((l) => l.url || '').filter(Boolean);
  const twitterLink = socialLinks.find((l) => l.includes('twitter.com') || l.includes('x.com')) || '';

  return {
    tokenAddress: pair.baseToken?.address || '',
    tokenName: pair.baseToken?.name || 'Unknown',
    ticker: pair.baseToken?.symbol || '???',
    pairAddress: pair.pairAddress || '',
    priceUsd,
    liquidityUsd,
    volume24h,
    volume6h,
    volume1h,
    priceChange24h,
    priceChange6h,
    priceChange1h,
    priceChange5m,
    ageHours,
    createdAt: createdAt?.toISOString() || null,
    buys1h,
    sells1h,
    buys24h,
    pullbackFromHigh,
    boostAmount: profile.boostAmount || 0,
    description: profile.description || '',
    twitterLink,
    socialLinks,
    dataFetchedAt: new Date().toISOString(),
    // buy/sell ratio — higher is more bullish
    buySellRatio1h: sells1h > 0 ? buys1h / sells1h : buys1h > 0 ? 5 : 1,
    // volume acceleration proxy: 1h rate vs 24h average
    volumeAcceleration: volume24h > 0 ? (volume1h * 24) / volume24h : 1,
    marketCap: pair.marketCap || null,
    fdv: pair.fdv || null,
    dexId: pair.dexId || '',

    // ── Honeypot / security fields ─────────────────────────────────────────
    // DexScreener exposes some of these in pair info where available.
    // We default to null (unknown) so filters only reject when explicitly true.
    freezeAuthority: pair.info?.freezeAuthority ?? null,
    mintAuthority: pair.info?.mintAuthority ?? null,
    // Holder concentration — available from Birdeye/Helius, not DexScreener
    // Set to null here; can be enriched later with a secondary API call
    top10HolderPct: null,
    topHolderPct: null,
  };
}

// ─── Main discovery call ──────────────────────────────────────────────────────
// Returns array of normalized candidates ready for hard filtering.

async function discoverCandidates() {
  log.info('Starting DexScreener discovery scan...');

  const profiles = await getTrendingTokens();
  if (!profiles.length) {
    log.warn('No trending tokens found from DexScreener');
    return [];
  }

  const addresses = [...new Set(profiles.map((p) => p.tokenAddress))];
  log.info(`Fetching pair data for ${addresses.length} addresses`);

  const pairs = await getTokenPairs(addresses);
  log.info(`Got ${pairs.length} pairs back`);

  // Build profile map for enrichment
  const profileMap = new Map(profiles.map((p) => [p.tokenAddress, p]));

  // Normalize and deduplicate by token address (pick best liquidity pair per token)
  const byToken = new Map();
  for (const pair of pairs) {
    const addr = pair.baseToken?.address;
    if (!addr) continue;
    const existing = byToken.get(addr);
    if (!existing || (pair.liquidity?.usd || 0) > (existing.liquidity?.usd || 0)) {
      byToken.set(addr, pair);
    }
  }

  const candidates = [];
  for (const [addr, pair] of byToken) {
    const profile = profileMap.get(addr) || {};
    const normalized = normalizePair(pair, profile);
    if (normalized && normalized.tokenAddress) {
      candidates.push(normalized);
    }
  }

  log.info(`Normalized ${candidates.length} candidates`);
  return candidates;
}

// ─── Live price fetch for position management ─────────────────────────────────

async function getCurrentPrice(tokenAddress) {
  try {
    const pair = await getTokenData(tokenAddress);
    if (!pair) return null;
    return parseFloat(pair.priceUsd || 0);
  } catch (err) {
    log.warn(`Price fetch failed for ${tokenAddress}: ${err.message}`);
    return null;
  }
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

module.exports = {
  discoverCandidates,
  getCurrentPrice,
  getTokenData,
  normalizePair,
};
