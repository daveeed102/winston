import os

# ── Alpaca (LIVE money) ───────────────────────────────────────────────────────
ALPACA_API_KEY    = os.environ["ALPACA_API_KEY"]
ALPACA_SECRET_KEY = os.environ["ALPACA_SECRET_KEY"]
ALPACA_BASE_URL   = "https://api.alpaca.markets"   # LIVE - real money

# ── Grok ─────────────────────────────────────────────────────────────────────
GROK_API_KEY  = os.environ["GROK_API_KEY"]
GROK_MODEL    = "grok-3-mini"

# ── Trade sizing ──────────────────────────────────────────────────────────────
MAX_TRADE_DOLLARS  = 2.00    # max $ spent per trade (fractional shares)
MAX_OPEN_POSITIONS = 5       # max simultaneous positions across all tickers

# ── Schedule (all times in ET) ────────────────────────────────────────────────
MARKET_OPEN_ET       = "09:31"   # start 1 min after open
MARKET_CLOSE_ET      = "15:55"   # stop 5 min before close
RUN_INTERVAL_SECS    = 60        # check every 60 seconds

# ── Ticker watchlist (locked to SPY and QQQ) ─────────────────────────────────
TICKER_REFRESH_MINS  = 99999     # never auto-refresh — list is locked
MAX_TICKERS          = 2
FALLBACK_TICKERS     = ["SPY", "QQQ"]

# ── Technical indicators ──────────────────────────────────────────────────────
BAR_TIMEFRAME    = "5Min"
BAR_LIMIT        = 60
EMA_FAST         = 9
EMA_SLOW         = 21
RSI_PERIOD       = 14
RSI_OVERSOLD     = 35
RSI_OVERBOUGHT   = 68
ATR_PERIOD       = 14

# ── Risk controls ─────────────────────────────────────────────────────────────
STOP_LOSS_MULT   = 1.5
TAKE_PROFIT_MULT = 2.5

# ── Sentiment thresholds ──────────────────────────────────────────────────────
SENTIMENT_BUY_MIN  =  0.15
SENTIMENT_SELL_MAX = -0.10

# ── Notifications ─────────────────────────────────────────────────────────────
DISCORD_WEBHOOK = os.environ.get("DISCORD_WEBHOOK", "")
