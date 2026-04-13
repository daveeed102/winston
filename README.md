# Winston v16 — Copy Trade Bot

Mirrors wallet CP7eVtQYsweR7vAjSvW2shgA1weszsVmxDFbpV22s5w1

## Setup

1. Install dependencies:
   npm install

2. Copy .env.example to .env and fill in your keys:
   cp .env.example .env

3. Edit .env:
   HELIUS_API_KEY      → get from helius.dev (free tier works)
   WALLET_PRIVATE_KEY  → your Solana wallet private key (base58)
   DISCORD_WEBHOOK_URL → optional, for trade alerts

4. Run:
   node index.js

## Exit Strategy
- Take Profit:    +175% ROI
- Stop Loss:      -45%
- Emergency exit: fires instantly if target wallet sells
- Max hold:       10 minutes fallback

## Requirements
- Node.js 18+
- At least 0.15 SOL in wallet (0.12 buy + fees)
