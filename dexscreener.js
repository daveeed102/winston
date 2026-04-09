// FILE: dexscreener.js
// DexScreener API client. Uses the boosted + trending search endpoints
// to find Solana tokens with real current traction.

const axios = require('axios');
const config = require('./config');
const { createLogger } = require('./logger');

const log = createLogger('DEXSCREENER');
const TIMEOUT = 12000;

// ─── Fetch trending Solana tokens ─────────────────────────────────────────────

async function getTrendingTokens() {
  const results = new Map();

  // Source 1: Top boosted tokens (fixed URL)
  try {
    const res = await axios.get('https://api.dexscreener.com/token-boosts/top/v1', { timeout: TIMEOUT });
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
    log.info(`Top boosts: ${results.size} Solana tokens`);
  } catch (err) {
    log.warn(`Boost fetch failed: ${err.message}`);
  }

  // Source 2: Search for trending Solana tokens by volume
  const trendingQueries = ['solana', 'sol meme', 'pump fun'];
  for (const q of trendingQueries) {
    try {
      const res = await axios.get(
        `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
        { timeout: TIMEOUT }
      );
      const pairs = res.data?.pairs || [];
      for (const pair of pairs) {
        if (pair.chainId === 'solana' && pair.baseToken?.address) {
          const addr = pair.baseToken.address;
          if (!results.has(addr)) {
            results.set(addr, {
              tokenAddress: addr,
              boostAmount: 0,
              description: '',
              links: [],
              pairData: pair, // cache pair data to avoid re-fetching
            });
          }
        }
      }
    } catch (err) {
      log.warn(`Trending search failed for "${q}": ${err.message}`);
    }
  }

  // Source 3: Top gainers on Solana via search
  try {
    const res = await axios.get(
      'https://api.dexscreener.com/latest/dex/search?q=solana%20trending',
      { timeout: TIMEOUT }
    );
    const pairs = res.data?.pairs || [];
    for (const pair of pairs) {
      if (pair.chainId === 'solana' && pair.baseToken?.address) {
        const addr = pair.baseToken.address;
        if (!results.has(addr)) {
          results.set(addr, {
            tokenAddress: addr,
            boostAmount: 0,
            description: '',
            links: [],
            pairData: pair,
          });
        }
      }
    }
    log.info(`Total after search: ${results.size} Solana candidates`);
  } catch (err) {
    log.warn(`Trending search failed: ${err.message}`);
  }

  return Array.from(results.values());
}

// ─── Fetch pair data for token addresses ──────────────────────────────────────

async function getTokenPairs(addresses) {
  const allPairs = [];
  const batches = chunkArray(addresses, 30);

  for (const batch of batches) {
    try {
      const joined = batch.join(',');
      const res = await axios.get(
        `https://api.dexscreener.com/tokens/v1/solana/${joined}`,
        { timeout: TIMEOUT }
      );
      const pairs = Array.isArray(res.data) ? res.data : (res.data?.pairs || []);
      allPairs.push(...pairs);
    } catch (err) {
      log.warn(`Pair fetch failed for batch: ${err.message}`);
    }
  }

  return allPairs;
}

async function getTokenData(address) {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/tokens/v1/solana/${address}`,
      { timeout: TIMEOUT }
    );
    const pairs = Array.isArray(res.data) ? res.data : (res.data?.pairs || []);
    if (!pairs.length) return null;
    return pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  } catch (err) {
    log.warn(`Token data fetch failed for ${address}: ${err.message}`);
    return null;
  }
}

// ─── Normalize pair → Winston candidate format ────────────────────────────────

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

  const createdAt = pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : null;
  const ageHours = createdAt ? (Date.now() - createdAt.getTime()) / (1000 * 60 * 60) : null;

  const txns = pair.txns || {};
  const buys1h = txns.h1?.buys || 0;
  const sells1h = txns.h1?.sells || 0;
  const buys24h = txns.h24?.buys || 0;

  const high24h = pair.priceHighH24 || priceUsd;
  const pullbackFromHigh = high24h > 0 ? ((high24h - priceUsd) / high24h) * 100 : 0;

  const socialLinks = (profile.links || []).map(l => l.url || '').filter(Boolean);
  const twitterLink = socialLinks.find(l => l.includes('twitter.com') || l.includes('x.com')) || '';

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
    buySellRatio1h: sells1h > 0 ? buys1h / sells1h : buys1h > 0 ? 5 : 1,
    volumeAcceleration: volume24h > 0 ? (volume1h * 24) / volume24h : 1,
    marketCap: pair.marketCap || null,
    fdv: pair.fdv || null,
    dexId: pair.dexId || '',
    freezeAuthority: pair.info?.freezeAuthority ?? null,
    mintAuthority: pair.info?.mintAuthority ?? null,
    top10HolderPct: null,
    topHolderPct: null,
  };
}

// ─── Main discovery ───────────────────────────────────────────────────────────

async function discoverCandidates() {
  log.info('Starting DexScreener discovery scan...');

  const profiles = await getTrendingTokens();
  if (!profiles.length) {
    log.warn('No trending tokens found from DexScreener');
    return [];
  }

  // Split into those with cached pair data and those needing a fetch
  const needsFetch = [];
  const cachedPairs = [];

  for (const profile of profiles) {
    if (profile.pairData) {
      cachedPairs.push({ pair: profile.pairData, profile });
    } else {
      needsFetch.push(profile);
    }
  }

  // Fetch pair data for non-cached profiles
  const addresses = [...new Set(needsFetch.map(p => p.tokenAddress))];
  let fetchedPairs = [];
  if (addresses.length > 0) {
    log.info(`Fetching pair data for ${addresses.length} addresses`);
    fetchedPairs = await getTokenPairs(addresses);
    log.info(`Got ${fetchedPairs.length} pairs back`);
  }

  const profileMap = new Map(profiles.map(p => [p.tokenAddress, p]));

  // Deduplicate by token address, pick highest liquidity pair
  const byToken = new Map();

  for (const { pair, profile } of cachedPairs) {
    const addr = pair.baseToken?.address;
    if (!addr) continue;
    const existing = byToken.get(addr);
    if (!existing || (pair.liquidity?.usd || 0) > (existing.pair?.liquidity?.usd || 0)) {
      byToken.set(addr, { pair, profile });
    }
  }

  for (const pair of fetchedPairs) {
    const addr = pair.baseToken?.address;
    if (!addr) continue;
    const profile = profileMap.get(addr) || {};
    const existing = byToken.get(addr);
    if (!existing || (pair.liquidity?.usd || 0) > (existing.pair?.liquidity?.usd || 0)) {
      byToken.set(addr, { pair, profile });
    }
  }

  const candidates = [];
  for (const [, { pair, profile }] of byToken) {
    const normalized = normalizePair(pair, profile);
    if (normalized?.tokenAddress) candidates.push(normalized);
  }

  log.info(`Normalized ${candidates.length} candidates`);
  return candidates;
}

// ─── Live price for exit manager ─────────────────────────────────────────────

async function getCurrentPrice(tokenAddress) {
  try {
    const pair = await getTokenData(tokenAddress);
    return pair ? parseFloat(pair.priceUsd || 0) : null;
  } catch (err) {
    log.warn(`Price fetch failed for ${tokenAddress}: ${err.message}`);
    return null;
  }
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

module.exports = { discoverCandidates, getCurrentPrice, getTokenData, normalizePair };
