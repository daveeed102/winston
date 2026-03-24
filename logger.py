"""
logger.py — Winston v12 logging
Discord only gets: buys, sells, and why.
"""

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


def notify_buy(symbol: str, dollars: float, score: int, reason: str, prediction: str = ""):
    msg = (
        f"🟢 **BOUGHT ${dollars:.0f} of {symbol}** (score: {score}/100)\n"
        f"📊 Why: {reason}\n"
        f"🔮 {prediction}"
    )
    log(f"[DISCORD] {msg}")
    _discord(msg)


def notify_sell(symbol: str, pnl: float, pnl_pct: float, reason: str, hold_time: str):
    sign = "+" if pnl >= 0 else ""
    emoji = "✅" if pnl >= 0 else "❌"
    msg = (
        f"{emoji} **SOLD {symbol}** {sign}${pnl:.2f} ({sign}{pnl_pct:.1f}%) "
        f"| {reason} | held {hold_time}"
    )
    log(f"[DISCORD] {msg}")
    _discord(msg)


def notify_startup(msg: str):
    log(f"[DISCORD] {msg}")
    _discord(msg)


def notify_error(msg: str):
    log(f"[ERROR] {msg}")
    _discord(f"⚠️ {msg}")
