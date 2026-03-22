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

# ── Trade sizing ──────────────────────────────────────────────────────────────
MAX_TRADE_DOLLARS  = 5.00
MAX_OPEN_POSITIONS = 1

# ── Schedule ──────────────────────────────────────────────────────────────────
# 6:30 AM MST = 9:30 AM ET (market open)
# First trade at 6:45 AM MST = 9:45 ET (skip chaotic open)
# Last trade at 12:50 PM MST = 3:50 PM ET
MARKET_OPEN_ET    = "09:45"
MARKET_CLOSE_ET   = "15:50"
RUN_INTERVAL_SECS = 300     # 5 minutes — hold time AND scan interval

# ── Watchlist ─────────────────────────────────────────────────────────────────
FALLBACK_TICKERS    = ["SPY", "QQQ"]
MAX_TICKERS         = 2
TICKER_REFRESH_MINS = 99999

# ── Technical indicators ──────────────────────────────────────────────────────
BAR_TIMEFRAME  = "5Min"
BAR_LIMIT      = 78
EMA_FAST       = 9
EMA_SLOW       = 21
RSI_PERIOD     = 14
RSI_OVERSOLD   = 38
RSI_OVERBOUGHT = 74
ATR_PERIOD     = 14

# ── Voting system ─────────────────────────────────────────────────────────────
# 10 total votes available.
# MIN_VOTE_SCORE = how many votes needed to enter a trade.
# 6 = majority + 1 (good balance of trades vs quality)
# 7 = strong conviction only (fewer trades, higher quality)
# 5 = bare majority (more trades, more risk)
MIN_VOTE_SCORE = 6

# ── Risk ──────────────────────────────────────────────────────────────────────
STOP_LOSS_MULT     = 1.8
TAKE_PROFIT_MULT   = 3.0
TRAIL_ACTIVATION   = 0.5
TRAIL_DISTANCE     = 1.2
EMERGENCY_STOP_PCT = 0.010   # 1% flash crash bail-out

# ── Sentiment ─────────────────────────────────────────────────────────────────
SENTIMENT_SELL_MAX  = -0.20
SENTIMENT_COVER_MIN =  0.20

# ── Discord ───────────────────────────────────────────────────────────────────
DISCORD_WEBHOOK = os.environ.get("DISCORD_WEBHOOK", "")
