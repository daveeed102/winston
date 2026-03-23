import os

# ── Coinbase Advanced Trade API ──────────────────────────────────────────────
COINBASE_API_KEY    = os.environ["COINBASE_API_KEY"]
COINBASE_API_SECRET = os.environ["COINBASE_API_SECRET"]

# ── Grok (picks coins from Twitter hype) ─────────────────────────────────────
GROK_API_KEY = os.environ["GROK_API_KEY"]
GROK_MODEL   = "grok-3-mini-fast"

# ── Database ─────────────────────────────────────────────────────────────────
DATABASE_URL = os.environ["DATABASE_URL"]

# ── Trade sizing ─────────────────────────────────────────────────────────────
TOTAL_BANKROLL     = 40.00    # Total to spread across picks
NUM_PICKS          = 2        # 2 meme coin picks per cycle
DOLLARS_PER_PICK   = TOTAL_BANKROLL / NUM_PICKS   # $20 each

# ── Cycle timing ─────────────────────────────────────────────────────────────
HOLD_HOURS         = 6        # Hold each batch for 6 hours
HOLD_SECS          = HOLD_HOURS * 3600
CHECK_INTERVAL     = 300      # Check portfolio value every 5 min during hold

# ── Discord ──────────────────────────────────────────────────────────────────
DISCORD_WEBHOOK = os.environ.get("DISCORD_WEBHOOK", "")
