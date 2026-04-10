// FILE: src/index.js
// Winston – Solana Continuation Hunter
// Main entry point. Boots all modules, starts scan and exit loops.

require('dotenv').config();
const config = require('./config');

// Validate config before doing anything else
try {
  config.validate();
} catch (err) {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
}

const { createLogger } = require('./logger');
const { initDb } = require('./db');
const db = require('./db');
const { startHealthServer } = require('./server');
const { initExecutor, getWalletAddresses } = require('./executor');
const { runScanCycle, getLastScanTime, getLastCandidatesFound } = require('./candidateScanner');
const { checkAllPositions, forceCloseAll } = require('./exitManager');
const discord = require('./discord');

const log = createLogger('WINSTON');

let scanInterval = null;
let exitInterval = null;
let heartbeatInterval = null;
let isShuttingDown = false;

// ─── Clean slate on startup ──────────────────────────────────────────────────
// On every redeploy, sell all token balances back to SOL across all wallets.
// This keeps everyone in sync and prevents orphaned positions from old deploys.

async function cleanSlateAllWallets() {
  const { Connection, PublicKey } = require('@solana/web3.js');
  const { sellToken, getSolPriceUsd, getWalletAddresses } = require('./executor');

  log.info('Clean slate: checking all wallets for token balances...');

  const walletAddresses = getWalletAddresses();
  const rpcUrl = config.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`
    : config.SOLANA_RPC_URL;
  const connection = new (require('@solana/web3.js').Connection)(rpcUrl, 'confirmed');
  const bs58 = require('bs58');
  const { Keypair } = require('@solana/web3.js');

  const keys = [
    process.env.WALLET_PRIVATE_KEY,
    process.env.WALLET_PRIVATE_KEY_2,
    process.env.WALLET_PRIVATE_KEY_3,
  ].filter(Boolean);

  let totalSold = 0;
  const soldTokens = [];

  for (let i = 0; i < keys.length; i++) {
    const walletName = config.WALLET_NAMES[i] || ('Wallet ' + (i + 1));
    try {
      const keypair = Keypair.fromSecretKey(bs58.decode(keys[i]));
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(keypair.publicKey, {
        programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      });

      const nonZero = tokenAccounts.value.filter(a => {
        const bal = a.account.data.parsed.info.tokenAmount.uiAmount;
        return bal && bal > 0;
      });

      if (nonZero.length === 0) {
        log.info(`${walletName}: no token balances to clear`);
        continue;
      }

      log.info(`${walletName}: found ${nonZero.length} token(s) to sell`);

      for (const account of nonZero) {
        const mint = account.account.data.parsed.info.mint;
        const balance = account.account.data.parsed.info.tokenAmount.uiAmount;
        try {
          log.info(`${walletName}: selling ${balance} of ${mint}`);
          await sellToken(mint, 1.0);
          soldTokens.push({ wallet: walletName, mint, balance });
          totalSold++;
          await new Promise(r => setTimeout(r, 2000)); // small delay between sells
        } catch (err) {
          log.warn(`${walletName}: failed to sell ${mint}: ${err.message}`);
        }
      }
    } catch (err) {
      log.warn(`Clean slate failed for wallet ${i + 1}: ${err.message}`);
    }
  }

  if (totalSold > 0) {
    log.info(`Clean slate complete: sold ${totalSold} token position(s)`);
    await discord.notifyError('STARTUP', `Clean slate: sold ${totalSold} leftover token(s) back to SOL before starting fresh.`,
      soldTokens.map(t => `${t.wallet}: ${t.mint}`).join(', ')
    );
  } else {
    log.info('Clean slate: all wallets already clean');
  }
}

// ─── Startup liquidation ──────────────────────────────────────────────────────
// Sells all non-SOL token balances back to SOL on startup.
// Called on every deploy to ensure clean state.

async function liquidateAllTokens() {
  const { getWalletAddresses, getTokenBalance, sellToken, getSolPriceUsd } = require('./executor');
  const { Connection, PublicKey } = require('@solana/web3.js');
  const axios = require('axios');

  const wallets = getWalletAddresses();

  for (const wallet of wallets) {
    try {
      // Get all token accounts for this wallet
      const rpcUrl = config.HELIUS_API_KEY
        ? `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`
        : config.SOLANA_RPC_URL;

      const res = await axios.post(rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenAccountsByOwner',
        params: [
          wallet.address,
          { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
          { encoding: 'jsonParsed' },
        ],
      }, { timeout: 15000 });

      const accounts = res.data?.result?.value || [];
      const tokensWithBalance = accounts.filter(a => {
        const amount = a.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
        return amount && amount > 0;
      });

      if (tokensWithBalance.length === 0) {
        log.info(`Wallet ${wallet.index} (${config.WALLET_NAMES[wallet.index-1]}): no tokens to liquidate`);
        continue;
      }

      log.info(`Wallet ${wallet.index} (${config.WALLET_NAMES[wallet.index-1]}): found ${tokensWithBalance.length} token(s) to sell`);

      for (const account of tokensWithBalance) {
        const mint = account.account?.data?.parsed?.info?.mint;
        const uiAmount = account.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
        if (!mint || !uiAmount) continue;

        // Skip wrapped SOL
        if (mint === config.SOL_MINT) continue;

        try {
          log.info(`Liquidating ${uiAmount.toFixed(4)} tokens of ${mint} from wallet ${wallet.index}`);
          const result = await sellToken(mint, 1.0, wallet.index - 1);
          if (result.success) {
            log.info(`Sold ${mint} for $${result.usdReceived?.toFixed(2)} — wallet ${wallet.index} clean`);
            await discord.notifyError('STARTUP', `Liquidated leftover ${mint.slice(0,8)}... from ${config.WALLET_NAMES[wallet.index-1]} — $${result.usdReceived?.toFixed(2)} recovered`);
          }
        } catch (err) {
          log.warn(`Could not liquidate ${mint} from wallet ${wallet.index}: ${err.message}`);
        }
      }
    } catch (err) {
      log.warn(`Startup liquidation failed for wallet ${wallet.index}: ${err.message}`);
    }
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────

async function boot() {
  log.info(`╔══════════════════════════════════╗`);
  log.info(`║   Winston v${config.VERSION} — LIVE MODE    ║`);
  log.info(`╚══════════════════════════════════╝`);

  // Init DB
  await initDb();
  log.info('Database initialized');

  // Init Solana executor
  initExecutor();
  log.info('Executor initialized');

  // ── Startup liquidation ───────────────────────────────────────────────────
  // On every redeploy the DB resets, so we sell ALL token holdings back to SOL
  // This ensures wallets start clean and Winston doesn't re-buy tokens it forgot about
  log.info('Running startup liquidation — selling any existing token holdings...');
  await liquidateAllTokens();
  log.info('Startup liquidation complete. Wallets are clean.');

  // Start health server (keeps Railway container alive)
  startHealthServer();

  // Notify Discord
  await discord.notifyStartup(config.VERSION, getWalletAddresses());

  // Run first scan immediately on boot
  if (!config.KILL_SWITCH) {
    log.info('Running initial scan...');
    await runScanCycle();
    // Also immediately check existing positions
    await checkAllPositions();
  }

  // ── Scan loop ────────────────────────────────────────────────────────────
  const scanMs = config.SCAN_INTERVAL_MINUTES * 60 * 1000;
  scanInterval = setInterval(async () => {
    if (isShuttingDown) return;
    try {
      await runScanCycle();
    } catch (err) {
      log.error(`Scan loop error: ${err.message}`);
    }
  }, scanMs);
  log.info(`Scan loop started (every ${config.SCAN_INTERVAL_MINUTES} min)`);

  // ── Position check loop ──────────────────────────────────────────────────
  const exitMs = config.POSITION_CHECK_INTERVAL_SECONDS * 1000;
  exitInterval = setInterval(async () => {
    if (isShuttingDown) return;
    try {
      await checkAllPositions();
    } catch (err) {
      log.error(`Exit check loop error: ${err.message}`);
    }
  }, exitMs);
  log.info(`Exit check loop started (every ${config.POSITION_CHECK_INTERVAL_SECONDS}s)`);

  // ── Heartbeat ────────────────────────────────────────────────────────────
  const heartbeatMs = config.HEARTBEAT_INTERVAL_MINUTES * 60 * 1000;
  heartbeatInterval = setInterval(async () => {
    if (isShuttingDown) return;
    try {
      await sendHeartbeat();
    } catch (err) {
      log.error(`Heartbeat error: ${err.message}`);
    }
  }, heartbeatMs);
  log.info(`Heartbeat started (every ${config.HEARTBEAT_INTERVAL_MINUTES} min)`);

  // ── Daily summary at midnight ─────────────────────────────────────────────
  scheduleDailySummary();

  log.info('Winston fully operational ✅');
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

async function sendHeartbeat() {
  const openPositions = db.getOpenPositions();
  const todayTrades = db.getTodayTrades();
  const todayPnl = db.getDailyPnl();

  // Fetch real SOL balances + token holdings from chain for all wallets
  const { getSolBalance, getTokenBalance, getWalletAddresses, getSolPriceUsd } = require('./executor');
  const walletAddresses = getWalletAddresses();
  const solPrice = await getSolPriceUsd();

  const wallets = [];
  for (const w of walletAddresses) {
    try {
      const sol = await getSolBalance(w.index - 1);
      const name = config.WALLET_NAMES[w.index - 1] || `Wallet ${w.index}`;

      // Get token holdings for each open position
      const holdings = [];
      for (const pos of openPositions) {
        try {
          const tokenBal = await getTokenBalance(pos.tokenAddress, w.index - 1);
          if (tokenBal > 0) {
            const usdValue = tokenBal * (pos.entryPrice || 0);
            holdings.push({
              ticker: pos.ticker,
              tokenBal,
              usdValue,
            });
          }
        } catch {}
      }

      wallets.push({ index: w.index, name, address: w.address, sol, solUsd: sol * solPrice, holdings });
    } catch (err) {
      const name = config.WALLET_NAMES[w.index - 1] || `Wallet ${w.index}`;
      wallets.push({ index: w.index, name, address: w.address, sol: null, solUsd: null, holdings: [] });
    }
  }

  await discord.notifyHeartbeat({
    openPositions: openPositions.length,
    todayTrades: todayTrades.length,
    todayPnl,
    lastScan: getLastScanTime(),
    candidatesFound: getLastCandidatesFound(),
    killSwitch: config.KILL_SWITCH,
    wallets,
    solPrice,
  });
}

// ─── Daily summary scheduler ──────────────────────────────────────────────────

function scheduleDailySummary() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(23, 55, 0, 0); // 11:55pm
  if (midnight <= now) midnight.setDate(midnight.getDate() + 1);

  const msUntilMidnight = midnight.getTime() - now.getTime();
  setTimeout(async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const todayTrades = db.getTodayTrades();
      const todayPnl = db.getDailyPnl();
      const wins = todayTrades.filter((t) => t.realized_pnl_usd > 0).length;
      const losses = todayTrades.filter((t) => t.realized_pnl_usd <= 0).length;
      const bestPct = todayTrades.length ? Math.max(...todayTrades.map((t) => t.realized_pnl_pct || 0)) : 0;
      const worstPct = todayTrades.length ? Math.min(...todayTrades.map((t) => t.realized_pnl_pct || 0)) : 0;

      await discord.notifyDailySummary({
        date: today,
        tradesCount: todayTrades.length,
        wins,
        losses,
        grossPnlUsd: todayPnl,
        bestTradePct: bestPct,
        worstTradePct: worstPct,
      });
    } catch (err) {
      log.error(`Daily summary failed: ${err.message}`);
    }
    scheduleDailySummary(); // reschedule for next day
  }, msUntilMidnight);

  log.info(`Daily summary scheduled in ${(msUntilMidnight / 1000 / 60).toFixed(0)} min`);
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.warn(`Shutdown signal received: ${signal}`);

  clearInterval(scanInterval);
  clearInterval(exitInterval);
  clearInterval(heartbeatInterval);

  // Save open positions info
  const openPositions = db.getOpenPositions();
  log.info(`Shutting down with ${openPositions.length} open position(s) — they will be monitored on restart`);

  if (openPositions.length > 0) {
    await discord.notifyError(
      'Winston',
      `Bot shutting down (${signal}) with ${openPositions.length} open position(s). Will resume on restart.`,
      openPositions.map((p) => `${p.ticker} @ $${p.entryPrice?.toFixed(8)}`).join(', ')
    );
  }

  log.info('Shutdown complete. Goodbye.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', async (err) => {
  log.error(`Uncaught exception: ${err.message}`, err.stack);
  await discord.notifyError('UNCAUGHT_EXCEPTION', err.message, err.stack?.slice(0, 500));
  // Don't exit — let Railway restart handle truly fatal cases
});
process.on('unhandledRejection', async (reason) => {
  log.error(`Unhandled rejection: ${reason}`);
  await discord.notifyError('UNHANDLED_REJECTION', String(reason).slice(0, 300));
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
boot().catch(async (err) => {
  log.error(`Boot failed: ${err.message}`, err.stack);
  try {
    await discord.notifyError('BOOT_FAILURE', err.message, err.stack?.slice(0, 500));
  } catch {}
  process.exit(1);
});
