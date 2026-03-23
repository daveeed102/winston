import os

# ── Coinbase Advanced Trade API ──────────────────────────────────────────────
COINBASE_API_KEY    = os.environ["COINBASE_API_KEY"]
COINBASE_API_SECRET = os.environ["COINBASE_API_SECRET"]

# ── Grok (X/Twitter search for mention velocity) ────────────────────────────
GROK_API_KEY = os.environ.get("GROK_API_KEY", "")
GROK_MODEL   = "grok-3-mini-fast"

# ── Database ─────────────────────────────────────────────────────────────────
DATABASE_URL = os.environ["DATABASE_URL"]

# ── Position sizing ──────────────────────────────────────────────────────────
POSITION_SIZE = 20.00         # Flat $20 per trade, every time

# ── Positions ────────────────────────────────────────────────────────────────
MAX_POSITIONS = 2             # Hold max 2 tokens at a time

# ── Momentum scoring ────────────────────────────────────────────────────────
MIN_SCORE_TO_BUY  = 60        # Don't buy below this score
SCORE_DROP_EXIT   = 35        # Sell if score drops below this

# ── Smart exits ──────────────────────────────────────────────────────────────
TRAILING_STOP_PCT  = 0.12     # 12% trailing stop from peak
EARLY_STOP_PCT     = 0.05     # 5% hard stop loss from entry
MAX_HOLD_SECS      = 43200    # 12 hours max hold — sell and find something fresh
CHECK_INTERVAL     = 120      # Check positions every 2 minutes

# ── Scanner ──────────────────────────────────────────────────────────────────
SCAN_INTERVAL      = 180      # Scan for new opportunities every 3 minutes
RESCORE_INTERVAL   = 300      # Re-score existing positions every 5 minutes

# ── Blue chip blocklist (we want memecoins only) ─────────────────────────────
BLOCKED_COINS = {
    "BTC", "ETH", "SOL", "XRP", "ADA", "AVAX", "LINK", "DOT",
    "MATIC", "UNI", "AAVE", "LTC", "BCH", "ATOM", "FIL", "APT",
    "ARB", "OP", "NEAR", "ICP", "HBAR", "VET", "ALGO", "XLM",
    "TRX", "TON", "SUI", "SEI", "INJ", "TIA", "RENDER", "FET",
    "TAO", "USDC", "USDT", "DAI", "WBTC", "CBETH", "STETH",
}

# ── Discord ──────────────────────────────────────────────────────────────────
DISCORD_WEBHOOK = os.environ.get("DISCORD_WEBHOOK", "")
