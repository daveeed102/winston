"""
logger.py — Logging + Discord notifications for Winston XRP
"""

import time
import requests
from datetime import datetime
import config

def log(msg: str):
    ts = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def _discord(content: str):
    if not config.DISCORD_WEBHOOK:
        return
    try:
        requests.post(config.DISCORD_WEBHOOK, json={"content": content}, timeout=5)
    except Exception:
        pass


def notify(msg: str):
    log(f"[DISCORD] {msg}")
    _discord(msg)


def notify_close(ticker: str, side: str, reason: str, pnl: float):
    emoji = "✅" if pnl >= 0 else "❌"
    sign  = "+" if pnl >= 0 else ""
    msg = f"{emoji} **Closed {side} {ticker}** | {reason} | P&L: {sign}${pnl:.4f}"
    notify(msg)


def notify_scan(products: list):
    notify(f"Watching: {', '.join(products)}")


def notify_summary(total: int, wins: int, pnl: float):
    sign = "+" if pnl >= 0 else ""
    wr   = (wins / total * 100) if total > 0 else 0
    msg = (
        f"📊 **Daily Summary**\n"
        f"Trades: {total} | Wins: {wins} ({wr:.0f}%)\n"
        f"Net P&L: {sign}${pnl:.4f}"
    )
    notify(msg)


def notify_error(msg: str):
    log(f"[ERROR] {msg}")
    _discord(f"⚠️ Error: {msg}")
