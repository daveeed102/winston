"""
logger.py
Simple timestamped logger + Discord webhook notifier.
"""

import requests
from datetime import datetime
from config import DISCORD_WEBHOOK


def log(msg: str):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def notify(msg: str):
    """Send a message to Discord and also log it locally."""
    log(f"[DISCORD] {msg}")
    if not DISCORD_WEBHOOK:
        return
    try:
        requests.post(
            DISCORD_WEBHOOK,
            json={"content": msg},
            timeout=5,
        )
    except Exception as e:
        log(f"[DISCORD] Failed to send: {e}")


def notify_trade(action: str, ticker: str, qty: int, price: float,
                 stop: float, tp: float, sentiment_score: float, sentiment_reason: str):
    direction = "🟢 BUY" if action == "BUY" else "🔴 SELL"
    emoji_sentiment = "📈" if sentiment_score >= 0 else "📉"
    msg = (
        f"**{direction} {qty}x {ticker} @ ${price:.2f}**\n"
        f"Stop-loss: ${stop:.2f} | Take-profit: ${tp:.2f}\n"
        f"{emoji_sentiment} Grok sentiment: {sentiment_score:+.2f} — {sentiment_reason}"
    )
    notify(msg)


def notify_close(ticker: str, reason: str, pnl: float):
    emoji = "✅" if pnl >= 0 else "❌"
    msg = (
        f"{emoji} **CLOSED {ticker}** — {reason}\n"
        f"P&L: {'+'if pnl>=0 else ''}{pnl:.2f}"
    )
    notify(msg)


def notify_error(err: str):
    notify(f"⚠️ **BOT ERROR**: {err}")
