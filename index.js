// ============================================================
// WINSTON v9.1 — Dune Top Trader Copy Bot
// ============================================================
// Copies trades from proven profitable wallets sourced from
// Dune Analytics. One position at a time, tight fees.
// ============================================================

require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  get HELIUS_RPC() { return `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`; },
  PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || '',
  JUPITER_QUOTE: 'https://lite-api.jup.ag/swap/v1/quote',
  JUPITER_SWAP: 'https://lite-api.jup.ag/swap/v1/swap',
  JUPITER_PRICE: 'https://lite-api.jup.ag/price/v2',
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || '',

  // Trading
  MAX_SLIPPAGE_BPS: 200,
  PRIORITY_FEE_LAMPORTS: 100000,
  POSITION_SIZE_PCT: 0.85,
  MAX_PRICE_IMPACT_PCT: 0.05,

  // Exit strategy
  STOP_LOSS_PCT: -15,
  TAKE_PROFIT_1_PCT: 25,
  TAKE_PROFIT_2_PCT: 50,

  // Timing
  POLL_INTERVAL_MS: 4000,
  PRICE_CHECK_INTERVAL_MS: 15000,
  HEALTH_LOG_INTERVAL_MS: 120000,

  // Constants
  SOL_MINT: 'So11111111111111111111111111111111111111112',
  USDC_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT_MINT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  JUPITER_PROGRAM: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  RAYDIUM_AMM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',

  // Top wallets from Dune: https://dune.com/couldbebasic/top-traders
  // Curated: 100%+ ROI, 50%+ WR, 5+ SOL balance, wallet age > 5 days
  // Red flags removed: brand new wallets, low WR, 0% median ROI
  TRACKED_WALLETS: [
    // === PAGE 1 — Elite (200%+ ROI) ===
    'FRhgF9TXCXyGfUiQ5WsdCGxHUmBXPseenTdnEA4UmUGi',  // 675% ROI, 73% WR, 150d old
    '7z8hbNzmgYvRMNVk27TQm8xW3yXgAkwQVhA6Nht5WEkU',  // 420% ROI, 90% WR, 299d old
    '61MQSdRgpe98pxMn6gcLH4M4MAFr8mAKuoTDFMwbpn6Y',  // 466% ROI, 100% WR, 113d old
    'AjKCctQtCnCj48tR3YaGm1ZrQtURoodjfg6YKLy97Uub',  // 286% ROI, 95% WR, 11d old
    'FEXornKkXE2u51WfCGVdEBsmrvquu9UvGPpM9gd986se',  // 242% ROI, 100% WR, 99d old
    'CsKnRER9Sjpau8Mk9WTZkoBytB2uFnqdmLYR5GTGtaKz',  // 324% ROI, 71% WR
    'ATFRUwvyMh61w2Ab6AZxUyxsAfiiuG1RqL6iv3Vi9q2B',  // 208% ROI, 100% WR, 450d old
    'GJvBxoj79TqhvyafMpTPyu5CP5rEq2V9LnbfxtDqgYhS',  // 215% ROI, 81% WR, 56d old
    'F7HXUvhmCjkHM1ePFCSRReXXbnCAKdiJMDFNfH8u8khG',  // 215% ROI, 86% WR, 135d old
    '9jYMojHaJxyXsvVMN2foih8knXb5AXYkMmUnxjQT5BoJ',  // 202% ROI, 77% WR, 11d old
    '8gDRLa498xXCdch3DvtvjCJ7C1joJ1BpftTDVZztxigv',  // 396% ROI, 50% WR, 16d old
    '6wLkK9AKTcCLiB5mW7pyp9Fq9wchydyatk8XtxKdVHgn',  // 345% ROI, 60% WR, 297d old
    '2M4Ka8W5i7eK9Z3zMpzbeYRsAVM4HtpwhtTnbmPDdiMn',  // 324% ROI, 60% WR
    '8DqpugHmWXVcSAYaZs9W2jXnCE4Cx1XbNMsZYC8EU1JV',  // 237% ROI, 60% WR
    '9p7PFT2HYhVKXDsvCZd43d8GRm1jQcWBH7tmawe96b6X',  // 237% ROI, 67% WR
    'AnWgJ1csbod2tWS2mZNEyhxo1XWndhNVvzbchh81zZ8k',  // 404% ROI, 57% WR
    'H5G1btoS96YZ6fcaDDhAo99A9p4RkenV9XKLw2aPCeaF',  // 228% ROI, 50% WR
    'FYfSEsc5DxwKH2LbxNpWE9KiGvajN8bYVHSe1mk4oSDy',  // 204% ROI, 60% WR, 45d old

    // === PAGE 1 — Strong (150-199% ROI) ===
    '5VXyg5nXWtpjsNQvt6EXQPQ5ziZBnxhoXDYaz9ZBbXao',  // 199% ROI, 100% WR, 529d old
    '683qAwQbpkiWpSfUsi49BKUcP4XqdJaxGaiBMK4etRvv',  // 186% ROI, 100% WR
    's69tyCAuNtaXUFT6AXoTMPQnHbsSG4nW34qu8oRK9vG',   // 185% ROI, 50% WR, 210d old
    'HfY4gNZUhicrjt8FHrHPhx41HtavVVYGmgpmPvaMDx6n',  // 181% ROI, 75% WR
    '5vXih4GeYcfQv88R59B5sZaRYEwJzorKpCGhqjAmqTqu',  // 177% ROI, 83% WR, 503d old
    '3P8JV5CSTvngRZv84v82ASD5mo8kBVxKMbk9Yx3TbosU',  // 177% ROI, 75% WR
    'HWWaEmQCcVFaYweovWdPB2db44Kk7w5P1vMDLkoX8kFP',  // 176% ROI, 50% WR
    'Gc2WT9QnTCLffWc88nKXwtqKVWh7djZeMy9yqZYXevi1',  // 174% ROI, 86% WR
    '66svXsZH7NEEsSG6w8RZKmLCDX2csR5y9XFuYQSgszE8',  // 174% ROI, 70% WR
    'AZZcxmxS89iv4bbu2t15i1xTaRafpDcAXGBfdTizS4AN',  // 173% ROI, 71% WR
    'BpZB8BhLwCn8SG2cHieUCoK6Lq8f9hrohj1c5yGtGnZe',  // 171% ROI, 56% WR
    'FvYsGPiQoG5A7aQsbQM7bR3VdjY2TKeG8xLwhBQMNQWY',  // 168% ROI, 100% WR, 237d old
    'EY8kS2GvTL4vQmQFi6nN2dnGJSFQhwmEMdktYpyLRvtP',  // 167% ROI, 85% WR
    'HXhnm8S1pd1KYjoYKrTFLAHnw6ED7nkrp3SmGGddtoLD',  // 167% ROI, 60% WR, 137d old
    'BPHQrgjM2rBzxNMebMJsPCLki36X2tiNFLU2c1W8pD7q',  // 165% ROI, 50% WR
    'GeSVoLkL3DQSxcw2zwTq8GrZ6HEGfqWH8BVcChj4UZcQ',  // 164% ROI, 67% WR
    'BZWzvFQrqbT5Tb1T4F73SWKhM5auiPMDo9agb456HLTC',  // 156% ROI, 100% WR
    '6WLquntFTiEh84JvH3R6fA1k5PQLSUouY7CmEMQwaj34',  // 153% ROI, 55% WR, 71d old
    'EoC9UDaX4PgMPS49gnLkFJVjX4eoBWPi6iXAUZGwdTPj',  // 153% ROI, 58% WR
    '4i88267TQpasJoL3Zv5C9Szq9XctMSHExmmQMWgBbFeB',  // 152% ROI, 60% WR, 90d old

    // === PAGE 2 — Solid (120-149% ROI) ===
    '4tzVuWHootaHdbY8DoguYpMe1RaNYd8xNiYYjWF8ZYit',  // 135% ROI, 75% WR
    '55oiTxTRNAKP72hc1yuKd5LiMSkjp4drmPHnsmJvdE3c',  // 132% ROI, 50% WR
    '7rtqMoobKfNKz7DyKTEdPQAQ9xk7Kpk75VZQQX8c6FxM',  // 132% ROI, 57% WR
    'GvAyrpEM88uMYLp8QLUf7SRfqfsLNBEFhLctj2Hn8y9P',  // 131% ROI, 100% WR, 91d old
    'tsZNG3Xo5kKJn8xmTAcCqeskarTQsrPnBFW4736jtWu',  // 128% ROI, 74% WR
    '12KuEro7Cr7WjjxKTQ56TPdmUfVSuP6z7otP9KnNHWhK',  // 126% ROI, 60% WR, 200d old
    '82hYg8UYV6VjEczaWT2Rrh3miMjHL2vfBwKApT9hV59u',  // 124% ROI, 56% WR
    '9WTsj8VvY3QBLY69Z153upbLSS1thEqCeE5AK28GRG8X',  // 122% ROI, 75% WR
    'DJGm2u3ZRJJaaobyPPDQB9dvpaKTutUo5y4CdxoywRBJ',  // 121% ROI, 100% WR, 303d old
    '2FzChsNvEqRvX36jy4Gvpu9Xjv1pk6TBJct7pPVyeTJL',  // 119% ROI, 77% WR, 674d old
    '8XjdJLcw5G7qzhh1tAUaHEsPHjyoU6Yr6QRD1kT43zKJ',  // 118% ROI, 57% WR
    'AqpY5YrdXqsYyhCrXkSwqD6G8Umi1PL8hz4MJkjizrA7w',  // 118% ROI, 73% WR, 58d old
    'ARchqCp5pSjGd6Bt6HAY1YF1dNMgCbZ91mVygBC6LdWT',  // 117% ROI, 67% WR
    '85Aq4c1xQUDcHbb7z521pKysZVpf1YTXiZodkK9nPhov',  // 116% ROI, 56% WR, 133d old
    'FWir4vJBJrDsKMmTLy9cPorrgtUhKRcr1n5CRCvciyFZ',  // 115% ROI, 60% WR
    'ATHGRiHxar9FB7hTF2awkjzQjxKAUSNGPTAixqEUjX9M',  // 115% ROI, 77% WR
    'FPp4xGY1pnCnGx1zDgiykUW9sssaY8kgkQBZrLCi1drD',  // 115% ROI, 57% WR, 680d old
    '4ypxvwdjg7wDvEFLkhKBqCioRmDtKzu1z55C1Sah12Xv',  // 151% ROI, 100% WR, 482d old

    // === PAGE 3 — Consistent (100-119% ROI) ===
    'D9Eoby4puakYU3QX8aLGmQ3vqotWYk7V6YD7WtrKDfxw',  // 107% ROI, 56% WR, 126d old
    'G9hxBRpp4iDtzrbYuMibM4UQZyTmmhJY9ci2i2mPdTw2',  // 106% ROI, 100% WR
    '6i1UngrDzzdXur2kfXengdeDFRQRRz2KDCSkn5QAQMTP',  // 106% ROI, 60% WR
    'EJEWyg2ZLmCq1uyKeWZz9L7z6FQWJCyP5pNR3smD6RXu',  // 105% ROI, 58% WR, 763d old
    'HbA7fZnpvFKS1ye3d6NFkkSfFghJJK6touZXHPJysAPq',  // 104% ROI, 86% WR
    '6JXxsX1e1jxn4sSAU1X3HKpBDZfwFTBx4ZcrdqsFWiEw',  // 103% ROI, 67% WR
    'AEwdbcEaLpp5vdfBFYaxgKQyLoDrAGJu5cMGNn6S6jGA',  // 102% ROI, 91% WR
    '5PiqYRfJDhS8sMjRyBXW3eyTtfh7GgAuYWFtqaRdDH9T',  // 102% ROI, 67% WR, 290d old
    'ArAh8V2UwkgGP12j2wpNMJHCVm4ZEoCHtKd2fXCKKi1K',  // 102% ROI, 80% WR, 202d old

    // === PAGE 4-5 — Active High WR (80%+ ROI, high frequency) ===
    'BQqG1qRkhqkidYAgYh7T9RcL7AEmhfG9Sd8esaZWw51P',  // 89% ROI, 62% WR, 490d old
    '4MdtaDSqc6G6g6N9Pt79A2Zj9wUC9wJcnf62YP6bssfu',  // 88% ROI, 57% WR
    '6LZs9rk7nKQWYgeb6XnUvLp8XaMyQdaog2VU87dsPuSj',  // 87% ROI, 100% WR
    'HCFg8YVKJJycWjnnu4GJoHjsrpwffHvwNhXVHUezVyyM',  // 85% ROI, 80% WR
    '2xdqw5qvFovVwUJgAUJzcKNvy3qXgAhPSZHVu6hcFyZM',  // 82% ROI, 91% WR, 131d old
  ],
};

const STABLES = new Set([CONFIG.USDC_MINT, CONFIG.USDT_MINT]);

// ============================================================
// STATE
// ============================================================
const state = {
  wallet: null,
  connection: null,
  position: null,
  lastSigs: new Map(),
  isRunning: false,
  stats: { trades: 0, wins: 0, totalPnlSol: 0, startBalance: 0 },
};

// ============================================================
// UTILITIES
// ============================================================
function log(level, msg, data = {}) {
  const ts = new Date().toISOString();
  const icons = { INFO: '📡', TRADE: '💰', WARN: '⚠️', ERROR: '❌', EXIT: '🚪', COPY: '🎯' };
  const extra = Object.keys(data).length ? ' ' + JSON.stringify(data) : '';
  console.log(`[${ts}] ${icons[level] || '📋'} [${level}] ${msg}${extra}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getSOLBalance() {
  try { return (await state.connection.getBalance(state.wallet.publicKey)) / 1e9; }
  catch (e) { return 0; }
}

async function getTokenPrice(mint) {
  try {
    const res = await fetch(`${CONFIG.JUPITER_PRICE}?ids=${mint}`);
    if (!res.ok) return 0;
    const data = await res.json();
    return parseFloat(data?.data?.[mint]?.price || 0);
  } catch (e) { return 0; }
}

async function discord(msg) {
  if (!CONFIG.DISCORD_WEBHOOK) return;
  try { await fetch(CONFIG.DISCORD_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: msg }) }); }
  catch (e) { /* silent */ }
}

// ============================================================
// SWAP PARSER
// ============================================================
function parseSwap(tx, walletAddress) {
  try {
    const meta = tx.meta;
    const message = tx.transaction?.message;
    if (!meta || !message || meta.err) return null;

    const accountKeys = message.accountKeys?.map(k => k.pubkey || k) || [];
    const logs = meta.logMessages || [];
    const isDex = accountKeys.includes(CONFIG.JUPITER_PROGRAM) ||
                  accountKeys.includes(CONFIG.RAYDIUM_AMM) ||
                  logs.some(l => l.includes('Instruction: Swap') || l.includes('Instruction: Route'));
    if (!isDex) return null;

    const walletIdx = Math.max(0, accountKeys.indexOf(walletAddress));
    const solChange = ((meta.postBalances?.[walletIdx] || 0) - (meta.preBalances?.[walletIdx] || 0)) / 1e9;

    const pre = meta.preTokenBalances || [];
    const post = meta.postTokenBalances || [];
    const allMints = new Set();
    for (const b of [...pre, ...post]) {
      if (b.owner === walletAddress && b.mint && b.mint !== CONFIG.SOL_MINT && !STABLES.has(b.mint)) {
        allMints.add(b.mint);
      }
    }

    let tokenMint = null, tokenChange = 0;
    for (const mint of allMints) {
      const preB = pre.find(p => p.owner === walletAddress && p.mint === mint);
      const postB = post.find(p => p.owner === walletAddress && p.mint === mint);
      const change = parseFloat(postB?.uiTokenAmount?.uiAmount || 0) - parseFloat(preB?.uiTokenAmount?.uiAmount || 0);
      if (Math.abs(change) > 0.000001) { tokenMint = mint; tokenChange = change; break; }
    }

    if (!tokenMint) return null;
    return {
      tokenMint,
      direction: tokenChange > 0 ? 'buy' : 'sell',
      solAmount: Math.abs(solChange) || 0.001,
      tokenAmount: Math.abs(tokenChange),
      timestamp: tx.blockTime,
      signature: tx.transaction?.signatures?.[0],
    };
  } catch (e) { return null; }
}

// ============================================================
// POLLING LOOP
// ============================================================
async function initLastSigs() {
  log('INFO', `Initializing ${CONFIG.TRACKED_WALLETS.length} wallets...`);
  for (const addr of CONFIG.TRACKED_WALLETS) {
    try {
      const res = await fetch(CONFIG.HELIUS_RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [addr, { limit: 1 }] }),
      });
      const data = await res.json();
      const sig = data?.result?.[0]?.signature;
      if (sig) state.lastSigs.set(addr, sig);
      await sleep(150);
    } catch (e) { /* skip */ }
  }
  log('INFO', `Ready. Tracking ${state.lastSigs.size}/${CONFIG.TRACKED_WALLETS.length} wallets.`);
}

async function pollWallets() {
  log('INFO', '👀 Watching for trades...');
  while (state.isRunning) {
    for (const addr of CONFIG.TRACKED_WALLETS) {
      try {
        const res = await fetch(CONFIG.HELIUS_RPC, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [addr, { limit: 3 }] }),
        });
        const data = await res.json();
        const sigs = data?.result || [];
        const lastKnown = state.lastSigs.get(addr);
        const newSigs = [];
        for (const sig of sigs) {
          if (sig.signature === lastKnown) break;
          if (!sig.err) newSigs.push(sig);
        }

        if (newSigs.length > 0) {
          state.lastSigs.set(addr, newSigs[0].signature);
          for (const sig of newSigs) {
            try {
              const txRes = await fetch(CONFIG.HELIUS_RPC, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] }),
              });
              const txData = await txRes.json();
              if (!txData?.result) continue;
              const swap = parseSwap(txData.result, addr);
              if (!swap) continue;
              log('COPY', `${addr.slice(0, 8)}... ${swap.direction.toUpperCase()} ${swap.tokenMint.slice(0, 8)}...`, { sol: swap.solAmount.toFixed(4) });
              await handleSignal(swap, addr);
              await sleep(200);
            } catch (e) { /* skip */ }
          }
        }
        await sleep(200);
      } catch (e) { /* skip */ }
    }
    await sleep(CONFIG.POLL_INTERVAL_MS);
  }
}

// ============================================================
// SIGNAL HANDLER
// ============================================================
async function handleSignal(swap, walletAddr) {
  const { tokenMint, direction } = swap;

  if (direction === 'sell' && state.position?.mint === tokenMint) {
    log('EXIT', `Tracked wallet selling our token — exiting`);
    await executeSell(100, 'tracked_wallet_sold');
    return;
  }

  if (direction !== 'buy') return;
  if (state.position) {
    log('INFO', `Already holding ${state.position.mint.slice(0, 8)}... — skipping`);
    return;
  }

  const balance = await getSOLBalance();
  const tradeLamports = Math.floor(balance * CONFIG.POSITION_SIZE_PCT * 1e9);
  if (tradeLamports < 5000000) { log('WARN', 'Balance too low'); return; }

  try {
    const quoteRes = await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${CONFIG.SOL_MINT}&outputMint=${tokenMint}&amount=${tradeLamports}&slippageBps=${CONFIG.MAX_SLIPPAGE_BPS}`);
    if (!quoteRes.ok) { log('WARN', `No route for ${tokenMint.slice(0, 8)}...`); return; }
    const quote = await quoteRes.json();
    if (!quote.outAmount || quote.outAmount === '0') { log('WARN', 'No liquidity'); return; }

    const impact = Math.abs(parseFloat(quote.priceImpactPct || 0));
    if (impact > CONFIG.MAX_PRICE_IMPACT_PCT) { log('WARN', `Impact too high: ${(impact * 100).toFixed(2)}%`); return; }

    await executeBuy(tokenMint, quote, tradeLamports, walletAddr);
  } catch (e) {
    log('ERROR', 'Quote failed', { error: e.message });
  }
}

// ============================================================
// EXECUTION
// ============================================================
async function executeBuy(tokenMint, quote, lamports, copiedWallet) {
  try {
    const sol = lamports / 1e9;
    log('TRADE', `🛒 BUYING ${tokenMint.slice(0, 8)}... for ${sol.toFixed(4)} SOL (copied ${copiedWallet.slice(0, 8)}...)`);

    const swapRes = await fetch(CONFIG.JUPITER_SWAP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: state.wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicSlippage: { minBps: 50, maxBps: CONFIG.MAX_SLIPPAGE_BPS },
        prioritizationFeeLamports: CONFIG.PRIORITY_FEE_LAMPORTS,
      }),
    });

    if (!swapRes.ok) { log('ERROR', `Swap request failed: ${swapRes.status}`); return; }
    const swapData = await swapRes.json();
    if (!swapData.swapTransaction) { log('ERROR', 'No swap tx returned'); return; }

    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([state.wallet]);
    const sig = await state.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    log('TRADE', `📤 Sent: ${sig}`);

    if (await confirmTx(sig)) {
      const price = await getTokenPrice(tokenMint);
      state.position = { mint: tokenMint, entryPrice: price, entrySolAmount: sol, entryTime: Date.now(), soldPct: 0, signature: sig, copiedFrom: copiedWallet };
      state.stats.trades++;
      const msg = `🛒 **BUY** \`${tokenMint.slice(0, 8)}...\` | ${sol.toFixed(4)} SOL | Copied ${copiedWallet.slice(0, 8)}...`;
      log('TRADE', msg);
      await discord(msg);
    } else {
      log('ERROR', 'Buy failed to confirm');
    }
  } catch (e) {
    log('ERROR', 'Buy failed', { error: e.message });
  }
}

async function executeSell(pct, reason) {
  if (!state.position) return;
  const { mint, entrySolAmount, soldPct } = state.position;
  const actualPct = Math.min(pct, 100 - soldPct);
  if (actualPct <= 0) return;

  try {
    log('EXIT', `🚪 SELLING ${actualPct}% of ${mint.slice(0, 8)}...`, { reason });
    const accts = await state.connection.getParsedTokenAccountsByOwner(state.wallet.publicKey, { mint: new PublicKey(mint) });
    const acct = accts?.value?.[0];
    if (!acct) { state.position = null; return; }

    const bal = parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmount || 0);
    if (bal <= 0) { state.position = null; return; }

    const dec = acct.account.data.parsed.info.tokenAmount.decimals;
    const sellAmt = BigInt(Math.floor(bal * (actualPct / 100) * Math.pow(10, dec)));
    if (sellAmt <= 0n) { state.position = null; return; }

    const quoteRes = await fetch(`${CONFIG.JUPITER_QUOTE}?inputMint=${mint}&outputMint=${CONFIG.SOL_MINT}&amount=${sellAmt.toString()}&slippageBps=${CONFIG.MAX_SLIPPAGE_BPS}`);
    if (!quoteRes.ok) { log('ERROR', 'Sell quote failed'); return; }
    const quote = await quoteRes.json();
    if (!quote.outAmount) { log('ERROR', 'No sell route'); return; }

    const swapRes = await fetch(CONFIG.JUPITER_SWAP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: state.wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicSlippage: { minBps: 50, maxBps: CONFIG.MAX_SLIPPAGE_BPS },
        prioritizationFeeLamports: CONFIG.PRIORITY_FEE_LAMPORTS,
      }),
    });

    if (!swapRes.ok) { log('ERROR', 'Sell swap failed'); return; }
    const swapData = await swapRes.json();
    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([state.wallet]);
    const sig = await state.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });

    if (await confirmTx(sig)) {
      const solBack = parseFloat(quote.outAmount) / 1e9;
      const pnlSol = solBack - (entrySolAmount * (actualPct / 100));
      state.stats.totalPnlSol += pnlSol;
      state.position.soldPct += actualPct;

      if (state.position.soldPct >= 100) {
        if (pnlSol > 0) state.stats.wins++;
        const msg = `🚪 **SOLD** \`${mint.slice(0, 8)}...\` | ${solBack.toFixed(4)} SOL | PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL | ${reason}`;
        log('EXIT', msg); await discord(msg);
        state.position = null;
      } else {
        const msg = `🚪 **PARTIAL** ${actualPct}% of \`${mint.slice(0, 8)}...\` | ${solBack.toFixed(4)} SOL | ${reason}`;
        log('EXIT', msg); await discord(msg);
      }
    }
  } catch (e) {
    log('ERROR', 'Sell failed', { error: e.message });
  }
}

async function confirmTx(sig, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const s = await state.connection.getSignatureStatuses([sig]);
      const r = s?.value?.[0];
      if (r?.err) return false;
      if (r?.confirmationStatus === 'confirmed' || r?.confirmationStatus === 'finalized') return true;
    } catch (e) { /* retry */ }
    await sleep(2000);
  }
  return false;
}

// ============================================================
// POSITION MONITOR
// ============================================================
async function monitorPosition() {
  while (state.isRunning) {
    if (state.position && state.position.entryPrice > 0) {
      const { mint, entryPrice, soldPct } = state.position;
      const price = await getTokenPrice(mint);
      if (price > 0) {
        const pnl = ((price - entryPrice) / entryPrice) * 100;
        if (pnl <= CONFIG.STOP_LOSS_PCT) { await executeSell(100, `stop_loss_${pnl.toFixed(1)}%`); }
        else if (pnl >= CONFIG.TAKE_PROFIT_1_PCT && soldPct < 50) { await executeSell(50, `tp1_+${pnl.toFixed(1)}%`); }
        else if (pnl >= CONFIG.TAKE_PROFIT_2_PCT && soldPct < 100) { await executeSell(100, `tp2_+${pnl.toFixed(1)}%`); }
        else if (pnl <= -50) { await executeSell(100, 'dead_coin'); }
      }
    }
    await sleep(CONFIG.PRICE_CHECK_INTERVAL_MS);
  }
}

// ============================================================
// HEALTH
// ============================================================
async function healthLoop() {
  while (state.isRunning) {
    const bal = await getSOLBalance();
    const solP = await getTokenPrice(CONFIG.SOL_MINT);
    const wr = state.stats.trades > 0 ? ((state.stats.wins / state.stats.trades) * 100).toFixed(0) : '0';

    console.log('\n' + '═'.repeat(55));
    console.log('  🤖 WINSTON v9.1 — Dune Copy Trader');
    console.log('═'.repeat(55));
    console.log(`  💰 ${bal.toFixed(4)} SOL ($${(bal * solP).toFixed(2)})`);
    console.log(`  📊 PnL: ${state.stats.totalPnlSol >= 0 ? '+' : ''}${state.stats.totalPnlSol.toFixed(4)} SOL`);
    console.log(`  🎯 ${state.stats.trades} trades | ${state.stats.wins} wins | ${wr}% WR`);
    console.log(`  👀 ${CONFIG.TRACKED_WALLETS.length} wallets`);

    if (state.position) {
      const p = state.position;
      const pr = await getTokenPrice(p.mint);
      const pnl = pr && p.entryPrice ? (((pr - p.entryPrice) / p.entryPrice) * 100).toFixed(1) : '?';
      console.log(`  📦 ${p.mint.slice(0, 8)}... | ${pnl}% | ${((Date.now() - p.entryTime) / 60000).toFixed(0)}m | sold ${p.soldPct}%`);
    } else {
      console.log('  📦 Waiting for signal...');
    }
    console.log('═'.repeat(55) + '\n');
    await sleep(CONFIG.HEALTH_LOG_INTERVAL_MS);
  }
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║      🤖 WINSTON v9.1 — Dune Top Trader Copy Bot      ║');
  console.log('║         One Trade • Tight Fees • Proven Wallets       ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  if (!CONFIG.HELIUS_API_KEY) { log('ERROR', 'HELIUS_API_KEY required'); process.exit(1); }
  if (!CONFIG.PRIVATE_KEY) { log('ERROR', 'WALLET_PRIVATE_KEY required'); process.exit(1); }

  try { state.wallet = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY)); }
  catch (e) { log('ERROR', 'Bad private key'); process.exit(1); }

  log('INFO', `Wallet: ${state.wallet.publicKey.toString()}`);
  state.connection = new Connection(CONFIG.HELIUS_RPC, { commitment: 'confirmed' });

  state.stats.startBalance = await getSOLBalance();
  const solP = await getTokenPrice(CONFIG.SOL_MINT);
  log('INFO', `Balance: ${state.stats.startBalance.toFixed(4)} SOL ($${(state.stats.startBalance * solP).toFixed(2)})`);
  if (state.stats.startBalance < 0.01) { log('ERROR', 'Balance too low'); process.exit(1); }

  state.isRunning = true;
  await initLastSigs();

  log('INFO', `🚀 Live — watching ${CONFIG.TRACKED_WALLETS.length} Dune top traders`);
  await discord(`🚀 Winston v9.1 | ${state.stats.startBalance.toFixed(4)} SOL | ${CONFIG.TRACKED_WALLETS.length} wallets`);

  const shutdown = async () => {
    state.isRunning = false;
    const f = await getSOLBalance();
    const pnl = f - state.stats.startBalance;
    log('INFO', `🛑 Final: ${f.toFixed(4)} SOL | ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`);
    await discord(`🛑 Shutdown | ${f.toFixed(4)} SOL | ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await Promise.all([pollWallets(), monitorPosition(), healthLoop()]);
}

main().catch(e => { log('ERROR', 'Fatal', { error: e.message }); process.exit(1); });
