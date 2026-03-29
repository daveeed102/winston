# Winston v2.0 — Multi-Position Grok Sniper

A Solana momentum trading bot. Grok is the sole decision maker.
$2 per trade, up to 5 concurrent positions.

---

## How It Works

1. **Every 15 minutes**, bot fetches 20–40 trending Solana tokens from Dexscreener
2. **Grok scores each token 1–100** for short-term momentum potential
3. **Only tokens scoring ≥ 75** get purchased — Grok is the gatekeeper
4. **Up to 5 positions open simultaneously**, each using $2 (configurable)
5. **Per-position exit ladder** runs continuously in background:
   - +15% → sell 50% (lock profit)
   - +25% → sell 25% more
   - +40% → sell remaining 25%
   - -7% → stop loss, full exit immediately
6. **Safety exits**: dead coin, price stall, volume dry-up, 2hr max hold
7. **All logging** goes to Discord (startup, every buy, every sell, heartbeat every 5min)

---

## Environment Variables

### REQUIRED (bot will not start without these)

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `WALLET_PRIVATE_KEY` | Phantom wallet private key (base58) | Phantom → Settings → Security & Privacy → Export Private Key |
| `SOLANA_RPC_URL` | Helius RPC endpoint | [helius.dev](https://helius.dev) → free account → Create API Key → copy mainnet URL |
| `GROK_API_KEY` | Grok AI API key | [console.x.ai](https://console.x.ai) → API Keys |
| `DISCORD_WEBHOOK_URL` | Discord webhook for logs | Discord → channel → Settings → Integrations → Webhooks → New |

### OPTIONAL

| Variable | Default | Description |
|----------|---------|-------------|
| `JUPITER_API_KEY` | (empty) | Jupiter portal key — works without it, but gets better routing with it |
| `TRADE_AMOUNT_SOL` | `0.012` | ~$2 at $165/SOL. Adjust if SOL price changes |
| `MAX_POSITIONS` | `5` | Max concurrent positions |
| `SCAN_INTERVAL_MINS` | `15` | How often Grok scans (minutes) |
| `GROK_MIN_SCORE` | `75` | Minimum Grok score to buy (1–100) |
| `TP1_PCT` | `15` | Take profit 1 — sell 50% at +15% |
| `TP2_PCT` | `25` | Take profit 2 — sell 25% at +25% |
| `TP3_PCT` | `40` | Take profit 3 — sell rest at +40% |
| `STOP_LOSS_PCT` | `7` | Stop loss — exit 100% at -7% |
| `MAX_HOLD_MINUTES` | `120` | Max hold per position (2 hours) |
| `DAILY_MAX_LOSS_SOL` | `0.07` | Daily loss limit (~$10) — halts trading |
| `SLIPPAGE_BPS` | `1000` | Slippage tolerance in bps (1000 = 10%) |
| `MAX_TOP_HOLDER_PCT` | `20` | Anti-rug: max % owned by single wallet |
| `STALL_MINUTES` | `12` | Exit if price doesn't move for this many minutes |

---

## Deploy to Railway

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "winston v2.0"
git remote add origin https://github.com/YOUR_USER/winston-v2.git
git push -u origin main
```

### Step 2 — Create Railway project

1. Go to [railway.app](https://railway.app)
2. New Project → Deploy from GitHub Repo → select your repo
3. Railway auto-detects the Dockerfile and builds

### Step 3 — Set environment variables

In Railway → your service → **Variables** tab, add every variable from the table above.

Minimum required:
```
WALLET_PRIVATE_KEY   = <your key>
SOLANA_RPC_URL       = https://mainnet.helius-rpc.com/?api-key=<key>
GROK_API_KEY         = xai-<key>
DISCORD_WEBHOOK_URL  = https://discord.com/api/webhooks/...
```

### Step 4 — Deploy

Railway will auto-deploy after you set variables. Watch logs in Railway → Deployments → View Logs.

You should see in logs within 60 seconds:
```
WINSTON v2.0 — Multi-Position Grok Sniper
Balance: X.XXXX SOL
```
And a startup message in your Discord channel.

---

## Phantom Wallet Setup

1. Create a **dedicated trading wallet** in Phantom — do NOT use your main wallet
2. Fund it with the amount you want to trade (recommended: $30–50 to start)
3. Keep some SOL for gas (~0.05 SOL reserve minimum)
4. Export private key: Settings → Security & Privacy → Export Private Key
5. Paste into `WALLET_PRIVATE_KEY`

**IMPORTANT**: The bot needs SOL in the wallet to trade. Each `TRADE_AMOUNT_SOL` buy also costs ~0.000025 SOL in gas.

---

## Discord Logging

The bot posts to Discord for every event:

| Message | When |
|---------|------|
| 🤖 Winston v2.0 — Online | Bot starts |
| 🔍 Grok scan started | Each scan cycle |
| 🤖 Grok approved X/Y tokens | After Grok scoring |
| 💸 BOUGHT — TOKEN | New position opened |
| ✅ SOLD — TOKEN (profit) | Profitable exit |
| ❌ SOLD — TOKEN (loss) | Loss exit |
| 🛡️ Anti-rug BLOCK | Token failed rug check |
| 💓 Heartbeat | Every 5 minutes |
| 🚫 Daily loss limit | $10 daily stop |

---

## Monitoring

- **Discord**: All trade events logged in real time
- **Railway logs**: Raw Python logs with every price poll visible
- **Heartbeat**: Every 5 minutes, Discord posts all open positions with current P&L

---

## Adjusting Trade Size

$2 per trade at $165/SOL = `0.012 SOL`

If SOL price changes:
- $150/SOL → set `TRADE_AMOUNT_SOL=0.0133`
- $180/SOL → set `TRADE_AMOUNT_SOL=0.011`
- $200/SOL → set `TRADE_AMOUNT_SOL=0.010`

---

## Key Differences from v8

| Feature | v8 | v2.0 |
|---------|-----|-------|
| Positions | 1 at a time | Up to 5 simultaneously |
| Trade size | 0.0625 SOL | 0.012 SOL (~$2) |
| Grok role | Picks one coin every hour | Scores ALL candidates, decides what to buy |
| Exit | Timeout at 60min | TP ladder (+15/25/40%), -7% stop |
| Graduation sniper | Yes | Removed (Grok only) |
| Scanning | Grok picks from known list | Dexscreener trending/new pairs |
| Daily risk | None | $10 daily loss halts trading |
