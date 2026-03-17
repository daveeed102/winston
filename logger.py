import requests
from datetime import datetime
from config import DISCORD_WEBHOOK

def log(msg: str):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)

def notify(msg: str):
    log(f"[DISCORD] {msg}")
    if not DISCORD_WEBHOOK:
        return
    try:
        requests.post(DISCORD_WEBHOOK, json={"content": msg}, timeout=5)
    except Exception as e:
        log(f"[DISCORD] Send failed: {e}")

def notify_buy(ticker: str, dollars: float, price: float,
               stop: float, tp: float, score: float, reason: str):
    msg = (
        f"🟢 **BUY {ticker}** — ${dollars:.2f} @ ~${price:.2f}\n"
        f"🛑 Stop: ${stop:.2f}  🎯 Target: ${tp:.2f}\n"
        f"{'📈' if score >= 0 else '📉'} Grok: {score:+.2f} — {reason}"
    )
    notify(msg)

def notify_close(ticker: str, reason: str, pnl: float):
    emoji = "✅" if pnl >= 0 else "❌"
    sign  = "+" if pnl >= 0 else ""
    notify(f"{emoji} **CLOSED {ticker}** ({reason}) | P&L: {sign}${pnl:.4f}")

def notify_scan(tickers: list):
    notify(f"🔍 **Watching:** {', '.join(tickers)}")

def notify_error(err: str):
    notify(f"⚠️ **BOT ERROR**: {err}")
