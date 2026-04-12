# Winston Sniper v1.0

Pump.fun launch sniper for Solana. Buys new tokens the instant they're detected, exits at 20x or after 30 seconds — whichever comes first. If a sell fails, it keeps retrying forever.

---

## How It Works

1. **Listens** to Pump.fun program logs via Helius WebSocket
2. **Detects** `create` events (new token launches) in real time
3. **Filters** tokens older than `MAX_TOKEN_AGE_SECONDS` (default: 10s) — stale = skip
4. **Buys** immediately via Jupiter swap: `BUY_AMOUNT_SOL` per token
5. **Monitors** each position every 2 seconds for 20x price target
6. **Hard exits** after `TIME_STOP_SECONDS` (default: 30s) no matter what
7. **Retries** failed sells up to `SELL_RETRY_ATTEMPTS` times, then starts an emergency retry loop every 10 seconds until sold

---

## Setup

### 1. Install
```bash
npm install
```

### 2. Configure
```bash
cp .env.example .env
```

Fill in:
- `WALLET_PRIVATE_KEY` — your Solana wallet as a JSON byte array (see below)
- `HELIUS_API_KEY` + `HELIUS_RPC_URL` + `HELIUS_WS_URL` — from https://helius.dev
- `DISCORD_WEBHOOK_URL` — your Discord webhook

### 3. Convert your private key to byte array format

If you have a base58 private key from Phantom:
```bash
node -e "
const bs58 = require('bs58');
const key = 'YOUR_BASE58_KEY_HERE';
const bytes = bs58.decode(key);
console.log(JSON.stringify(Array.from(bytes)));
"
```
Paste the output as `WALLET_PRIVATE_KEY` in `.env`.

### 4. Run
```bash
node src/index.js
```

---

## Key Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `BUY_AMOUNT_SOL` | 0.012 | SOL per buy |
| `MAX_POSITIONS` | 5 | Max open at once |
| `MAX_TOKEN_AGE_SECONDS` | 10 | Skip if token older than this |
| `TAKE_PROFIT_MULTIPLIER` | 20 | Sell when value hits 20x |
| `TIME_STOP_SECONDS` | 30 | Hard sell after 30s |
| `SLIPPAGE_BPS` | 500 | 5% slippage tolerance |
| `SELL_RETRY_ATTEMPTS` | 10 | Retries before emergency loop |
| `SELL_RETRY_DELAY_MS` | 2000 | Delay between sell retries |

---

## Sell Retry Behavior

The bot **never gives up on a sell**:

1. Normal retries: up to `SELL_RETRY_ATTEMPTS` (default 10), `SELL_RETRY_DELAY_MS` apart
2. If all normal retries fail: **emergency retry loop** every 10 seconds, indefinitely
3. Discord alert fired immediately if normal retries are exhausted
4. Position stays tracked until confirmed sold

---

## Railway Deployment

1. Push to GitHub
2. New Railway project → deploy from repo
3. Add all `.env` values in Railway Variables
4. Bot starts automatically

**Note:** This bot does not need a persistent volume — all state is in-memory and resets on restart. That's fine for a sniper (open positions are short-lived by design).

---

## Warnings

- **This is high-risk.** Most new Pump.fun tokens are rugs or dumps within seconds. The 30s hard exit is your primary protection.
- **You will lose money on most trades.** The bet is that occasional big wins (20x) offset many small losses. Test with the minimum amount first.
- **Pump.fun is extremely competitive.** Many bots compete to buy the same launches. Your Helius RPC quality directly affects how fast you get in.
- **Never put in more than you're willing to lose entirely.**
