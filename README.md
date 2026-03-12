# SPY Trader Bot 🤖📈

Intraday SPY trading bot. Combines EMA/RSI/VWAP technical signals with
Grok AI sentiment analysis. Only fires a trade when both agree.

## How it works

Every 5 minutes during market hours the bot:
1. Fetches the last 60 x 5-min bars from Alpaca
2. Computes EMA 9/21, RSI, VWAP, ATR
3. Asks Grok AI for a sentiment score on current market conditions
4. Only buys if **tech signals AND Grok both say bullish**
5. Exits on stop-loss, take-profit, tech SELL signal, or bearish Grok flip
6. Posts every trade action to Discord

## Setup

### 1. Alpaca account
- Sign up at https://alpaca.markets (free)
- Create a **paper trading** API key first
- When comfortable, swap in the live API key + change `ALPACA_BASE_URL` in config.py

### 2. Grok API key
- Get one at https://console.x.ai

### 3. Discord webhook (optional but recommended)
- In your Discord server: Edit Channel → Integrations → Webhooks → New Webhook → Copy URL

### 4. Deploy to Railway

1. Push this folder to a GitHub repo
2. New project in Railway → Deploy from GitHub
3. Add these environment variables in Railway:

```
ALPACA_API_KEY     = your_alpaca_key
ALPACA_SECRET_KEY  = your_alpaca_secret
GROK_API_KEY       = your_grok_key
DISCORD_WEBHOOK    = your_discord_webhook_url   (optional)
```

4. Railway auto-detects the Procfile and runs `python bot.py`

## Going live (real money)

When you're happy with paper results, edit ONE line in `config.py`:

```python
# Change this:
ALPACA_BASE_URL = "https://paper-api.alpaca.markets"
# To this:
ALPACA_BASE_URL = "https://api.alpaca.markets"
```

And swap in your live Alpaca API keys.

## Risk settings (config.py)

| Setting | Default | What it does |
|---|---|---|
| MAX_POSITION_PCT | 10% | Max portfolio % per trade |
| STOP_LOSS_MULT | 1.5x ATR | Dynamic stop-loss distance |
| TAKE_PROFIT_MULT | 2.5x ATR | Dynamic take-profit target |
| SENTIMENT_BUY_MIN | +0.1 | Grok must be at least slightly bullish |
| SENTIMENT_SELL_MAX | -0.1 | Exit if Grok turns bearish |

## Files

```
bot.py              — main loop
strategy.py         — EMA/RSI/VWAP/ATR signal engine
grok_sentiment.py   — Grok AI sentiment scorer
broker.py           — Alpaca API wrapper
logger.py           — logging + Discord notifications
config.py           — all settings
requirements.txt    — Python deps
Procfile            — Railway entry point
```

## ⚠️ Disclaimer

This bot does not guarantee profits. Past signals do not predict future results.
Trade at your own risk. Start with paper trading.
