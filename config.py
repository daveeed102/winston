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
MAX_TRADE_DOLLARS  = 10.00   # $10 per trade
MAX_OPEN_POSITIONS = 1

# ── Schedule ──────────────────────────────────────────────────────────────────
# 6:45 AM MST = 9:45 ET (skip chaotic first 15 min)
# 12:50 PM MST = 3:50 ET (stop before close)
MARKET_OPEN_ET    = "09:45"
MARKET_CLOSE_ET   = "15:50"
RUN_INTERVAL_SECS = 300      # 5 minutes — hold time AND scan interval

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
# 10 total votes. Need 4+ to enter a trade.
# Lower threshold = more trades, slightly lower quality signals.
MIN_VOTE_SCORE = 4

# ── Hard stop loss ────────────────────────────────────────────────────────────
# If trade moves this % against us mid-hold, bail out immediately.
# Don't wait for the 5 minutes to be up — cut the loss now.
# 0.5% on $10 = ~$0.05 max loss per trade before bailing
HARD_STOP_PCT = 0.005        # 0.5% — exits fast if going wrong way

# Emergency stop for flash crashes (bigger move)
EMERGENCY_STOP_PCT = 0.010   # 1.0% — catches sudden spikes

# ── Risk ──────────────────────────────────────────────────────────────────────
STOP_LOSS_MULT     = 1.8
TAKE_PROFIT_MULT   = 3.0
TRAIL_ACTIVATION   = 0.5
TRAIL_DISTANCE     = 1.2

# ── Sentiment ─────────────────────────────────────────────────────────────────
SENTIMENT_SELL_MAX  = -0.20
SENTIMENT_COVER_MIN =  0.20

# ── Discord ───────────────────────────────────────────────────────────────────
DISCORD_WEBHOOK = os.environ.get("DISCORD_WEBHOOK", "")
