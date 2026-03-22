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


def notify_buy(ticker: str, side: str, dollars: float, price: float,
               stop: float, tp: float, score: float, reason: str):
    emoji = "🟢" if side == "LONG" else "🔴"
    action = "LONG" if side == "LONG" else "SHORT"
    msg = (
        f"{emoji} **{action} {ticker}** — ${dollars:.2f} @ ~${price:.2f}\n"
        f"Stop: ${stop:.2f}  Target: ${tp:.2f}\n"
        f"Grok: {score:+.2f} — {reason}"
    )
    notify(msg)


def notify_close(ticker: str, side: str, reason: str, pnl: float):
    emoji = "✅" if pnl >= 0 else "❌"
    sign  = "+" if pnl >= 0 else ""
    notify(f"{emoji} **CLOSED {side} {ticker}** ({reason}) | P&L: {sign}${pnl:.4f}")


def notify_scan(tickers: list):
    notify(f"Watching: {', '.join(tickers)}")


def notify_summary(total_trades: int, winning_trades: int, total_pnl: float):
    win_rate = (winning_trades / total_trades * 100) if total_trades > 0 else 0
    sign = "+" if total_pnl >= 0 else ""
    notify(
        f"📊 **Daily Summary**\n"
        f"Trades: {total_trades} | Win rate: {win_rate:.0f}%\n"
        f"Total P&L: {sign}${total_pnl:.4f}"
    )


def notify_error(err: str):
    notify(f"Bot error: {err}")
