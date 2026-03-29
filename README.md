# 🤖 Winston v9 — Wallet Tracker & Momentum Copy Bot

Monitors profitable Solana wallets on-chain and mirrors their trades with tight fee parameters via Jupiter.

## Architecture

1. **Wallet Discovery** — Scans recent Jupiter swaps, finds active traders, scores them by win rate & profit
2. **Polling Monitor** — Watches tracked wallets for new transactions every 5s
3. **Trade Evaluation** — Checks liquidity, price impact, signal strength before entering
4. **Smart Execution** — Jupiter swap with dynamic slippage (50-150bps), low priority fees
5. **Exit Strategy** — Stop loss (-10%), TP1 (+20%, sell 50%), TP2 (+40%, sell rest), tracked wallet sell = instant exit

## Setup

```bash
npm install
cp .env.example .env
# Fill in your HELIUS_API_KEY and PRIVATE_KEY
npm start
```

## Railway Deploy

1. Push to GitHub
2. Connect repo to Railway
3. Set env vars in Railway dashboard: `HELIUS_API_KEY`, `PRIVATE_KEY`, `DISCORD_WEBHOOK` (optional), `SEED_WALLETS` (optional)
4. Deploy

## Env Vars

| Variable | Required | Description |
|----------|----------|-------------|
| `HELIUS_API_KEY` | Yes | Helius API key |
| `PRIVATE_KEY` | Yes | Base58 wallet private key |
| `DISCORD_WEBHOOK` | No | Discord webhook URL for alerts |
| `SEED_WALLETS` | No | Comma-separated wallet addresses to track |

## Strategy

Instead of sniping new tokens, Winston v9 finds wallets with proven track records and copies their trades on liquid tokens — dramatically reducing slippage and fee impact.
