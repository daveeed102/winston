import os

# ── Alpaca ────────────────────────────────────────────────────────────────────
ALPACA_API_KEY    = os.environ["ALPACA_API_KEY"]
ALPACA_SECRET_KEY = os.environ["ALPACA_SECRET_KEY"]

# Paper trading — flip to live URL when ready:
# ALPACA_BASE_URL = "https://api.alpaca.markets"
ALPACA_BASE_URL = "https://paper-api.alpaca.markets"

# ── Grok ─────────────────────────────────────────────────────────────────────
GROK_API_KEY  = os.environ["GROK_API_KEY"]
GROK_MODEL    = "grok-3-mini"

# ── Strategy ─────────────────────────────────────────────────────────────────
TICKER        = "SPY"
BAR_TIMEFRAME = "5Min"   # 5-minute bars for intraday signals
BAR_LIMIT     = 60       # look back 60 bars (~5 hours of data)

EMA_FAST      = 9
EMA_SLOW      = 21
RSI_PERIOD    = 14
RSI_OVERSOLD  = 40       # buy zone floor  (not in freefall)
RSI_OVERBOUGHT= 65       # buy zone ceiling (not already pumped)
ATR_PERIOD    = 14       # for dynamic stop-loss/take-profit sizing

# ── Risk controls ─────────────────────────────────────────────────────────────
MAX_POSITION_PCT   = 0.10   # max 10% of portfolio per trade
STOP_LOSS_MULT     = 1.5    # stop-loss  = entry - (ATR * multiplier)
TAKE_PROFIT_MULT   = 2.5    # take-profit = entry + (ATR * multiplier)
MAX_OPEN_POSITIONS = 1      # one trade at a time — keeps it simple & safe

# ── Grok sentiment thresholds ────────────────────────────────────────────────
# Grok returns a score -1.0 (very bearish) → +1.0 (very bullish)
SENTIMENT_BUY_MIN  =  0.1   # must be at least slightly bullish to enter
SENTIMENT_SELL_MAX = -0.1   # exit if sentiment flips bearish

# ── Notifications ─────────────────────────────────────────────────────────────
DISCORD_WEBHOOK = os.environ.get("DISCORD_WEBHOOK", "")

# ── Schedule ──────────────────────────────────────────────────────────────────
RUN_INTERVAL_MINS = 5
MARKET_OPEN_ET    = "09:35"  # skip first 5 min of open (most volatile)
MARKET_CLOSE_ET   = "15:50"  # stop 10 min before close (avoid MOC chaos)
