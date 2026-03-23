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
MAX_TRADE_DOLLARS  = 10.00    # $10 per trade
MAX_OPEN_POSITIONS = 1        # One position at a time

# ── Product ──────────────────────────────────────────────────────────────────
PRODUCT_ID = "XRP-USD"

# ── Schedule ─────────────────────────────────────────────────────────────────
# Crypto is 24/7 — no market hours restriction
# But we scan every 2 minutes for faster reaction to momentum
SCAN_INTERVAL_SECS = 120      # 2 minutes between scans

# ── Candle settings ──────────────────────────────────────────────────────────
CANDLE_GRANULARITY = "FIVE_MINUTE"    # 5-min candles
CANDLE_LIMIT       = 100              # How many candles to fetch (max 300)

# ── Technical indicators ─────────────────────────────────────────────────────
EMA_FAST       = 9
EMA_SLOW       = 21
RSI_PERIOD     = 14
RSI_OVERSOLD   = 35       # XRP is more volatile — wider bands
RSI_OVERBOUGHT = 75
ATR_PERIOD     = 14

# ── Voting system ────────────────────────────────────────────────────────────
# 10 total votes. Need 5+ to enter (higher than SPY because XRP is noisier).
# But ADX threshold is lower (15) so we still get trades.
MIN_VOTE_SCORE = 5

# ── Stops ────────────────────────────────────────────────────────────────────
# XRP is more volatile than SPY — wider stops to avoid getting shaken out
HARD_STOP_PCT      = 0.012    # 1.2% hard stop
EMERGENCY_STOP_PCT = 0.025    # 2.5% emergency stop (flash crash)

# ── Trailing stop ────────────────────────────────────────────────────────────
# Once we're up 0.5%, activate trailing stop at 0.4% behind peak
# This lets winners run instead of cutting at exactly 5 min
TRAIL_ACTIVATE_PCT = 0.005    # Activate trailing after 0.5% profit
TRAIL_DISTANCE_PCT = 0.004    # Trail 0.4% behind the high water mark

# ── Max hold time ────────────────────────────────────────────────────────────
MAX_HOLD_SECS     = 600       # 10 minutes max hold (crypto moves faster)
HOLD_CHECK_SECS   = 15        # Check price every 15 seconds during hold

# ── ADX threshold ────────────────────────────────────────────────────────────
ADX_THRESHOLD = 15            # Lower than SPY (20) — XRP trends differently

# ── Discord ──────────────────────────────────────────────────────────────────
DISCORD_WEBHOOK = os.environ.get("DISCORD_WEBHOOK", "")
