import os

# Alpaca (LIVE)
ALPACA_API_KEY    = os.environ["ALPACA_API_KEY"]
ALPACA_SECRET_KEY = os.environ["ALPACA_SECRET_KEY"]
ALPACA_BASE_URL   = "https://api.alpaca.markets"

# Grok
GROK_API_KEY  = os.environ["GROK_API_KEY"]
GROK_MODEL    = "grok-3-mini"

# Database
DATABASE_URL  = os.environ["DATABASE_URL"]

# ── Trade sizing ────────────────────────────────────────────────────────────
# $25 per trade on a $30 balance — aggressive but intentional.
# SPY/QQQ are the safest ETFs to do this with. Tight stops protect downside.
# Only 1 position open at a time so max exposure = $25, not $25 x 4.
MAX_TRADE_DOLLARS  = 25.00
MAX_OPEN_POSITIONS = 1

# ── Schedule (ET) ───────────────────────────────────────────────────────────
# Skip the first 30 min of trading — opening volatility kills retail traders.
# Skip last 10 min — spreads widen, fills get sloppy.
MARKET_OPEN_ET     = "10:00"
MARKET_CLOSE_ET    = "15:50"
RUN_INTERVAL_SECS  = 60

# ── Watchlist ────────────────────────────────────────────────────────────────
FALLBACK_TICKERS    = ["SPY", "QQQ"]
MAX_TICKERS         = 2
TICKER_REFRESH_MINS = 99999

# ── Technical indicators ─────────────────────────────────────────────────────
BAR_TIMEFRAME  = "5Min"
BAR_LIMIT      = 78       # full day of 5min bars for solid indicator context
EMA_FAST       = 9
EMA_SLOW       = 21
RSI_PERIOD     = 14
RSI_OVERSOLD   = 40
RSI_OVERBOUGHT = 72
ATR_PERIOD     = 14

# ── Risk controls ─────────────────────────────────────────────────────────────
# 1.2x ATR stop, 2.5x ATR target = minimum 1:2 risk/reward ratio.
# This means you only need to win 35%+ of trades to be profitable long-term.
STOP_LOSS_MULT   = 1.2
TAKE_PROFIT_MULT = 2.5
TRAIL_ACTIVATION = 0.5
TRAIL_DISTANCE   = 1.0    # looser trail so winners aren't shaken out too early

# ── Sentiment (exit filter only — not used for entry) ─────────────────────────
SENTIMENT_SELL_MAX  = -0.20
SENTIMENT_COVER_MIN =  0.20

# ── Discord ───────────────────────────────────────────────────────────────────
DISCORD_WEBHOOK = os.environ.get("DISCORD_WEBHOOK", "")
