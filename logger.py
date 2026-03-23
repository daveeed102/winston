"""
logger.py — Logging + Discord notifications for Winston XRP

Discord only gets the essentials:
  - BOUGHT $20 of XRP at $X.XXXX
  - SOLD for $X.XX  +$0.XX / -$0.XX
  - Daily summary
  - Errors

Everything else goes to Railway logs only.
"""

import requests
from datetime import datetime
import config


def log(msg: str):
    """Print to Railway logs only — Discord never sees this."""
    ts = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def _discord(content: str):
    if not config.DISCORD_WEBHOOK:
        return
    try:
        requests.post(config.DISCORD_WEBHOOK, json={"content": content}, timeout=5)
    except Exception:
        pass


def notify_buy(price: float, dollars: float):
    msg = f"🟢 BOUGHT ${dollars:.0f} worth of XRP at ${price:.4f}"
    log(f"[DISCORD] {msg}")
    _discord(msg)


def notify_sell(sell_price: float, pnl: float):
    sign = "+" if pnl >= 0 else ""
    emoji = "✅" if pnl >= 0 else "❌"
    msg = f"{emoji} SOLD XRP at ${sell_price:.4f}  {sign}${pnl:.4f}"
    log(f"[DISCORD] {msg}")
    _discord(msg)


def notify_summary(total: int, wins: int, pnl: float):
    sign = "+" if pnl >= 0 else ""
    wr   = (wins / total * 100) if total > 0 else 0
    msg = (
        f"📊 **Daily Summary**\n"
        f"Trades: {total} | Wins: {wins} ({wr:.0f}%)\n"
        f"Net P&L: {sign}${pnl:.4f}"
    )
    log(f"[DISCORD] {msg}")
    _discord(msg)


def notify_startup(msg: str):
    """Startup message only — sent once when bot boots."""
    log(f"[DISCORD] {msg}")
    _discord(msg)


def notify_error(msg: str):
    log(f"[ERROR] {msg}")
    _discord(f"⚠️ {msg}")
