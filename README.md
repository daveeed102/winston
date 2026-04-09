# Winston v3 — Solana Continuation Hunter

Winston scans for already-hot Solana coins, filters out garbage, scores them with Grok AI + real-time social search, computes a confidence score (0–100), and auto-buys/sells through Jupiter on Solana.

---

## Architecture

```
src/
├── index.js                  ← Boot, main loops, graceful shutdown
├── config.js                 ← All thresholds, keys, sizing
├── health/
│   └── server.js             ← Express health server (Railway keepalive + /status)
├── utils/
│   └── logger.js             ← Structured logger
├── persistence/
│   └── db.js                 ← SQLite — positions, trades, cooldowns, state
├── notifications/
│   └── discord.js            ← All Discord webhook messages
├── sources/
│   └── dexscreener.js        ← DexScreener discovery + market data
├── filters/
│   └── tokenFilters.js       ← Hard filter rules (reject trash before Grok)
├── scoring/
│   ├── grokScorer.js         ← Grok AI prompt + parsing + validation
│   └── confidenceCalculator.js ← Weighted 0–100 confidence score
├── scanner/
│   └── candidateScanner.js   ← Pipeline orchestrator (discover→filter→score→decide)
└── trading/
    ├── executor.js           ← Jupiter swap buy/sell + Solana RPC
    ├── positionManager.js    ← Entry logic, pre-trade validation, sizing
    └── exitManager.js        ← All exit rules (stop, trail, TP, time, momentum)
```

---

## Pipeline

```
[DexScreener Discovery]
         ↓
[Hard Filters] — reject: thin liquidity, low volume, too new, overextended
         ↓
[Grok Scoring] — AI scores: continuation prob, dump risk, hype quality, trend health
  (Grok also searches X/Twitter live for social sentiment)
         ↓
[Confidence Calculator] — weighted 0–100 score combining market + Grok + penalties
         ↓
[Entry Decision] — confidence >= 80, dump risk <= 30%, all safety checks pass
         ↓
[Jupiter Buy] → SOL → token
         ↓
[Position Manager] — persists position, arms stop loss, notifies Discord
         ↓
[Exit Manager loop every 30s]
  ├── Hard stop: -6%
  ├── Trailing stop: activates at +6%, trails 4% below peak
  ├── Partial TP: 50% close at +9%
  ├── Momentum failure: reversal without trailing
  └── Time stop: 48h max hold
```

---

## Setup (Local)

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your keys
```

### 3. Required keys
| Key | Where to get it |
|-----|----------------|
| `WALLET_PRIVATE_KEY` | Your Solana wallet private key (base58). Export from Phantom: Settings → Security → Export Private Key |
| `GROK_API_KEY` | x.ai API console → https://console.x.ai |
| `DISCORD_WEBHOOK_URL` | Discord channel → Edit Channel → Integrations → Webhooks → New Webhook |
| `HELIUS_API_KEY` | (Recommended) Free tier at https://helius.dev — much faster RPC |

### 4. Test run
```bash
node src/index.js
```
Watch Discord for the startup message and first scan cycle.

---

## Railway Deployment

### 1. Push code to GitHub
```bash
git init
git add .
git commit -m "Winston v3 — Solana continuation hunter"
git remote add origin https://github.com/YOUR_USERNAME/winston-bot.git
git push -u origin main
```

### 2. Connect Railway
- Go to https://railway.app → New Project → Deploy from GitHub repo
- Select your `winston-bot` repository
- Railway will auto-detect `railway.toml` and start building

### 3. Set environment variables in Railway
Go to your Railway project → Variables tab → Add all variables from `.env.example`:
```
WALLET_PRIVATE_KEY = <your base58 key>
GROK_API_KEY       = <your grok key>
DISCORD_WEBHOOK_URL = <your webhook>
HELIUS_API_KEY     = <optional but recommended>
KILL_SWITCH        = false
PAUSE_NEW_ENTRIES  = false
```
Add the rest from `.env.example` as needed.

### 4. Database persistence
Winston uses SQLite. In Railway, add a **Volume** to your service:
- Service → Settings → Volumes → Add Volume
- Mount path: `/app` (or wherever Railway runs your project)
- This ensures `winston.db` survives redeploys

Without a volume, the DB resets on each redeploy. Positions are lost but the bot recovers gracefully (it won't re-buy tokens since cooldowns reset).

### 5. Verify
- Railway dashboard → Deployments → check logs for Winston startup message
- Check Discord for `🤖 Winston Online` alert
- Check `/health` endpoint: `https://YOUR-APP.railway.app/health`

---

## Replacing into Existing Repo

1. Delete all existing bot files from your repo
2. Copy the entire `src/` folder from this build into your repo root
3. Replace `package.json`, `railway.toml`, `.gitignore`
4. **Do not overwrite your `.env` file** — just reference `.env.example` for new variables
5. `git add . && git commit -m "Winston v3 rebuild" && git push`
6. Railway auto-deploys on push

---

## Confidence Score Tiers

| Tier | Score | Allocation | Behavior |
|------|-------|-----------|---------|
| 🟣 ELITE | 90–100 | 20% of portfolio | Max size trade |
| 🟢 STRONG | 85–89 | 12% | Large trade |
| 🔵 GOOD | 80–84 | 8% | Standard trade |
| 🟡 SMALL | 75–79 | 5% | Minimum size |
| ⚪ SKIP | < 75 | 0% | No trade |

Default: only GOOD and above trade (MIN_CONFIDENCE=80). Change `MIN_CONFIDENCE` to 75 to include SMALL trades.

---

## Safety Controls

| Control | How to use |
|---------|-----------|
| Kill switch | Set `KILL_SWITCH=true` in Railway env vars, redeploy, or POST to `/kill` |
| Pause entries | Set `PAUSE_NEW_ENTRIES=true` — exits continue, no new buys |
| Max daily loss | Set `MAX_DAILY_LOSS_USD=50` — bot halts new trades after losing this much |
| Max positions | `MAX_CONCURRENT_POSITIONS=4` — never holds more than this many at once |
| Position cap | `MAX_POSITION_USD=40` — hard dollar cap per trade |

---

## Turning On Live Trading Safely

**First time checklist:**
1. Start with `PORTFOLIO_SIZE_USD=50` and `MAX_POSITION_USD=10` — small risk
2. Set `MIN_CONFIDENCE=85` initially — only STRONG and ELITE trades
3. Watch the first 2–3 scans on Discord before any trade fires
4. Verify your wallet has enough SOL (minimum 0.1 SOL + position size in SOL equivalent)
5. Check `/status` endpoint shows correct open positions
6. Only increase size after you trust the output

---

## Debugging / Failure Notes

**"Grok returns null / invalid JSON"**
- Check `GROK_API_KEY` is set correctly
- Grok model name: verify `GROK_MODEL=grok-3-latest` is correct at x.ai docs
- Winston skips the candidate and logs `GROK_INVALID` — safe to ignore if rare

**"BUY transaction fails / times out"**
- Add `HELIUS_API_KEY` — public RPC is unreliable under load
- Increase `PRIORITY_FEE=200000` for faster confirmation
- Increase `SLIPPAGE_BPS=500` if frequently failing on thin tokens

**"No candidates found"**
- DexScreener API may be slow/down — retry happens on next scan
- Filters may be too strict — check Railway logs for rejection reasons
- Reduce `MIN_LIQUIDITY` or `MIN_VOLUME_1H` slightly

**"Sell failed — MANUAL ACTION REQUIRED"**
- Check Discord — Winston alerts on failed exits
- Log into your wallet and sell manually
- Check token is not frozen (freeze authority)

**"Bot keeps restarting on Railway"**
- Check logs for boot errors (usually missing env var)
- Check `winston.db` isn't corrupted — delete it to reset (loses position history)

**Viewing status:**
```
GET https://YOUR-APP.railway.app/health   ← basic alive check
GET https://YOUR-APP.railway.app/status   ← full bot state JSON
```

**Kill switch via API:**
```bash
curl -X POST https://YOUR-APP.railway.app/kill \
  -H "x-winston-secret: YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json"
```
