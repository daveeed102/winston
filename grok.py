"""
grok.py — Momentum Filter for Winston XRP

Replaces the Grok AI prediction with a simple, fast momentum check.
No API calls, no latency, no cost. Just price action.

Checks 3 things:
  1. Are the last 3 candle closes rising? (micro-trend)
  2. Is the current close above the 3-candle average? (not buying into a dip)
  3. Is volume on the last candle above average? (real move, not noise)

All 3 must pass to confirm. If any fail, skip the trade.
"""

import pandas as pd
from logger import log


def check_momentum(df: pd.DataFrame) -> bool:
    """
    Fast momentum confirmation using recent price action.
    Returns True if momentum supports a buy, False to skip.

    Requires at least 5 candles to work.
    """
    if len(df) < 5:
        log("[MOMENTUM] Not enough candles for momentum check")
        return True  # Fail-open if not enough data

    # Last 4 candles (current + 3 previous)
    c0 = float(df["close"].iloc[-1])   # current
    c1 = float(df["close"].iloc[-2])   # 1 ago
    c2 = float(df["close"].iloc[-3])   # 2 ago
    c3 = float(df["close"].iloc[-4])   # 3 ago

    vol_now = float(df["volume"].iloc[-1])
    vol_avg = float(df["volume"].iloc[-20:].mean()) if len(df) >= 20 else float(df["volume"].mean())

    # ── Check 1: Are last 3 closes rising? ───────────────────────────────
    # At least 2 of the last 3 transitions must be up
    ups = 0
    if c0 > c1: ups += 1
    if c1 > c2: ups += 1
    if c2 > c3: ups += 1
    rising = ups >= 2

    # ── Check 2: Current close above 3-candle average? ───────────────────
    avg_3 = (c1 + c2 + c3) / 3
    above_avg = c0 > avg_3

    # ── Check 3: Volume above average? ───────────────────────────────────
    # At least 70% of average volume — not a dead market
    vol_ok = vol_now >= (vol_avg * 0.7)

    passed = rising and above_avg and vol_ok

    if passed:
        log(f"[MOMENTUM] ✅ Confirmed — {ups}/3 rising, close ${c0:.4f} > avg ${avg_3:.4f}, "
            f"vol {vol_now:.0f} vs avg {vol_avg:.0f}")
    else:
        reasons = []
        if not rising:
            reasons.append(f"only {ups}/3 candles rising")
        if not above_avg:
            reasons.append(f"close ${c0:.4f} < avg ${avg_3:.4f}")
        if not vol_ok:
            reasons.append(f"low volume {vol_now:.0f} vs avg {vol_avg:.0f}")
        log(f"[MOMENTUM] ❌ Failed — {', '.join(reasons)}")

    return passed
