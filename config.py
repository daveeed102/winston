import os

# ── Coinbase Advanced Trade API ──────────────────────────────────────────────
COINBASE_API_KEY    = os.environ["COINBASE_API_KEY"]
COINBASE_API_SECRET = os.environ["COINBASE_API_SECRET"]

# ── Grok (sentiment analysis) ────────────────────────────────────────────────
GROK_API_KEY = os.environ.get("GROK_API_KEY", "")
GROK_MODEL   = "grok-3-mini"

# ── Database ─────────────────────────────────────────────────────────────────
DATABASE_URL = os.environ["DATABASE_URL"]

# ── Trade sizing ─────────────────────────────────────────────────────────────
MAX_TRADE_DOLLARS  = 50.00    # $50 per trade
MAX_OPEN_POSITIONS = 1        # One position at a time

# ── Product ──────────────────────────────────────────────────────────────────
PRODUCT_ID = "XRP-USD"

# ── Schedule ─────────────────────────────────────────────────────────────────
# Scan every 5 min — less churn, bigger moves between checks
SCAN_INTERVAL_SECS = 300      # 5 minutes between scans

# ── Candle settings ──────────────────────────────────────────────────────────
CANDLE_GRANULARITY = "FIFTEEN_MINUTE"   # 15-min candles — less noise, bigger signals
CANDLE_LIMIT       = 100                # How many candles to fetch (max 300)

# ── Technical indicators ─────────────────────────────────────────────────────
EMA_FAST       = 9
EMA_SLOW       = 21
RSI_PERIOD     = 14
RSI_OVERSOLD   = 35
RSI_OVERBOUGHT = 75
ATR_PERIOD     = 14

# ── Voting system ────────────────────────────────────────────────────────────
MIN_VOTE_SCORE = 4

# ── Stops ────────────────────────────────────────────────────────────────────
HARD_STOP_PCT      = 0.012    # 1.2% hard stop — still cut losers fast
EMERGENCY_STOP_PCT = 0.025    # 2.5% emergency stop (flash crash)

# ── Trailing stop ────────────────────────────────────────────────────────────
# Activate after 1.0% profit — don't lock in until the move is real
# Trail 0.6% behind peak — wider so you don't get shaken out on noise
TRAIL_ACTIVATE_PCT = 0.010    # Activate trailing after 1.0% profit
TRAIL_DISTANCE_PCT = 0.006    # Trail 0.6% behind the high water mark

# ── Max hold time ────────────────────────────────────────────────────────────
MAX_HOLD_SECS     = 3600      # 1 hour max hold — give the trade room to work
HOLD_CHECK_SECS   = 30        # Check price every 30 seconds during hold

# ── ADX threshold ────────────────────────────────────────────────────────────
ADX_THRESHOLD = 15

# ── Discord ──────────────────────────────────────────────────────────────────
DISCORD_WEBHOOK = os.environ.get("DISCORD_WEBHOOK", "")
