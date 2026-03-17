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
MARKET_CLOSE_ET    = "15:55"
RUN_INTERVAL_SECS  = 60

# Watchlist
FALLBACK_TICKERS   = ["SPY", "QQQ"]
MAX_TICKERS        = 2
TICKER_REFRESH_MINS = 99999

# Technical indicators
BAR_TIMEFRAME  = "5Min"
BAR_LIMIT      = 60
EMA_FAST       = 9
EMA_SLOW       = 21
RSI_PERIOD     = 14
RSI_OVERSOLD   = 35
RSI_OVERBOUGHT = 68
ATR_PERIOD     = 14

# Risk controls
STOP_LOSS_MULT   = 1.5
TAKE_PROFIT_MULT = 2.5
TRAIL_ACTIVATION = 0.5    # start trailing after price moves 0.5x ATR in our favor
TRAIL_DISTANCE   = 0.75   # trail stop at 0.75x ATR from peak

# Sentiment thresholds
SENTIMENT_BUY_MIN   =  0.15   # enter long
SENTIMENT_SHORT_MAX = -0.15   # enter short
SENTIMENT_SELL_MAX  = -0.10   # exit long
SENTIMENT_COVER_MIN =  0.10   # exit short

# Discord
DISCORD_WEBHOOK = os.environ.get("DISCORD_WEBHOOK", "")
