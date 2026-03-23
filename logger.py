"""
logger.py — Winston v11 Degen Mode logging
Discord only gets: picks, sells, and summaries.
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


def notify_picks(picks: list, reasons: dict):
    lines = ["🎰 **DEGEN PICKS — Next 6 Hours**"]
    for coin in picks:
        reason = reasons.get(coin, "")
        lines.append(f"  💎 **{coin}** — ${config.DOLLARS_PER_PICK:.0f} — {reason}")
    msg = "\n".join(lines)
    log(f"[DISCORD] {msg}")
    _discord(msg)


def notify_sell(coin: str, pnl: float, pnl_pct: float):
    sign = "+" if pnl >= 0 else ""
    emoji = "✅" if pnl >= 0 else "❌"
    msg = f"{emoji} SOLD **{coin}** {sign}${pnl:.2f} ({sign}{pnl_pct:.1f}%)"
    log(f"[DISCORD] {msg}")
    _discord(msg)


def notify_cycle_summary(total_pnl: float, results: list):
    sign = "+" if total_pnl >= 0 else ""
    emoji = "🟢" if total_pnl >= 0 else "🔴"
    lines = [f"{emoji} **Cycle Done** — Net: {sign}${total_pnl:.2f}"]
    for r in results:
        s = "+" if r["pnl"] >= 0 else ""
        lines.append(f"  {r['coin']}: {s}${r['pnl']:.2f} ({s}{r['pnl_pct']:.1f}%)")
    msg = "\n".join(lines)
    log(f"[DISCORD] {msg}")
    _discord(msg)


def notify_startup(msg: str):
    log(f"[DISCORD] {msg}")
    _discord(msg)


def notify_error(msg: str):
    log(f"[ERROR] {msg}")
    _discord(f"⚠️ {msg}")
