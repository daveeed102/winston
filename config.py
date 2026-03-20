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

# Trade sizing
MAX_TRADE_DOLLARS  = 2.00
MAX_OPEN_POSITIONS = 4

# Schedule (ET)
MARKET_OPEN_ET     = "09:31"
MARKET_CLOSE_ET    = "15:50"   # aligned with _is_near_close() so EOD close is consistent
RUN_INTERVAL_SECS  = 60

# Watchlist
FALLBACK_TICKERS    = ["SPY", "QQQ"]
MAX_TICKERS         = 2
TICKER_REFRESH_MINS = 99999

# Technical indicators
BAR_TIMEFRAME  = "5Min"
BAR_LIMIT      = 60
EMA_FAST       = 9
EMA_SLOW       = 21
RSI_PERIOD     = 14
RSI_OVERSOLD   = 40    # raised from 35 — catches bounces earlier
RSI_OVERBOUGHT = 72    # raised from 68 — lets winners run longer
ATR_PERIOD     = 14

# Risk controls
STOP_LOSS_MULT   = 1.2    # tighter stop — cuts losers faster (was 1.5)
TAKE_PROFIT_MULT = 2.0    # slightly tighter TP — books gains more reliably (was 2.5)
TRAIL_ACTIVATION = 0.5
TRAIL_DISTANCE   = 0.75

# Sentiment thresholds
# Grok has no real-time data so it almost always returns 0.0.
# Sentiment is used as a SOFT EXIT filter only, not an entry gate.
# Entry is now purely technical — see bot.py.
SENTIMENT_SELL_MAX  = -0.20   # exit long only if Grok is clearly bearish (was -0.10)
SENTIMENT_COVER_MIN =  0.20   # exit short only if Grok is clearly bullish (was 0.10)

# Discord
DISCORD_WEBHOOK = os.environ.get("DISCORD_WEBHOOK", "")
