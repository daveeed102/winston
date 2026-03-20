"""
strategy.py
Pure pandas indicators — tuned specifically for SPY and QQQ intraday.

Signal logic (3 entry types):
  1. EMA 9/21 crossover — classic momentum shift
  2. Trend continuation — fast EMA above/below slow AND accelerating
  3. VWAP reclaim — price crosses back above/below VWAP with RSI confirmation

Additional filters:
  - Volume spike confirmation (current bar volume > 1.2x recent average)
    SPY/QQQ moves on real volume are far more reliable than low-volume drifts
  - RSI momentum filter: for longs, RSI must be rising; for shorts, falling
    This stops you entering a long right as momentum is stalling
"""

import pandas as pd
from config import (
    EMA_FAST, EMA_SLOW, RSI_PERIOD,
    RSI_OVERSOLD, RSI_OVERBOUGHT, ATR_PERIOD
)
from logger import log


def _ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False).mean()


def _rsi(series: pd.Series, period: int) -> pd.Series:
    delta    = series.diff()
    gain     = delta.clip(lower=0)
    loss     = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1/period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1/period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, float("inf"))
    return 100 - (100 / (1 + rs))


def _atr(df: pd.DataFrame, period: int) -> pd.Series:
    high, low, close = df["high"], df["low"], df["close"]
    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low  - prev_close).abs()
    ], axis=1).max(axis=1)
    return tr.ewm(alpha=1/period, adjust=False).mean()


def _vwap(df: pd.DataFrame) -> pd.Series:
    typical    = (df["high"] + df["low"] + df["close"]) / 3
    cum_tp_vol = (typical * df["volume"]).cumsum()
    cum_vol    = df["volume"].cumsum()
    return cum_tp_vol / cum_vol


def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["ema_fast"] = _ema(df["close"], EMA_FAST)
    df["ema_slow"] = _ema(df["close"], EMA_SLOW)
    df["rsi"]      = _rsi(df["close"], RSI_PERIOD)
    df["atr"]      = _atr(df, ATR_PERIOD)
    df["vwap"]     = _vwap(df)
    df["vol_avg"]  = df["volume"].rolling(20).mean()  # 20-bar volume average
    return df


def get_signal(df: pd.DataFrame, ticker: str = "") -> tuple[str, float, dict]:
    df = compute_indicators(df)

    if len(df) < EMA_SLOW + 5:
        return "HOLD", 0.0, {}

    latest = df.iloc[-1]
    prev   = df.iloc[-2]

    close     = float(latest["close"])
    ema_fast  = float(latest["ema_fast"])
    ema_slow  = float(latest["ema_slow"])
    rsi       = float(latest["rsi"])
    prev_rsi  = float(prev["rsi"])
    atr       = float(latest["atr"]) if not pd.isna(latest["atr"]) else 0.0
    vwap      = float(latest["vwap"]) if not pd.isna(latest["vwap"]) else close
    volume    = float(latest["volume"])
    vol_avg   = float(latest["vol_avg"]) if not pd.isna(latest["vol_avg"]) else volume

    prev_fast  = float(prev["ema_fast"])
    prev_slow  = float(prev["ema_slow"])
    prev_close = float(prev["close"])
    prev_vwap  = float(prev["vwap"])

    info = {
        "close":    round(close, 2),
        "ema_fast": round(ema_fast, 2),
        "ema_slow": round(ema_slow, 2),
        "rsi":      round(rsi, 1),
        "atr":      round(atr, 4),
        "vwap":     round(vwap, 2),
    }

    # ── Filters ──────────────────────────────────────────────────────────────

    # Volume confirmation: current bar should have above-average volume
    # Low-volume moves on SPY/QQQ tend to fade fast
    volume_ok = volume >= (vol_avg * 1.1)

    # RSI direction: rising RSI on longs, falling RSI on shorts
    rsi_rising  = rsi > prev_rsi
    rsi_falling = rsi < prev_rsi

    # RSI range — not overbought/oversold
    rsi_long_ok  = RSI_OVERSOLD < rsi < RSI_OVERBOUGHT
    rsi_short_ok = RSI_OVERSOLD < rsi < RSI_OVERBOUGHT

    # Price position vs VWAP
    above_vwap = close > vwap
    below_vwap = close < vwap

    # ── Entry conditions ──────────────────────────────────────────────────────

    # 1. EMA crossover
    cross_up   = (prev_fast <= prev_slow) and (ema_fast > ema_slow)
    cross_down = (prev_fast >= prev_slow) and (ema_fast < ema_slow)

    # 2. Trend continuation (fast above/below slow AND accelerating)
    trend_up   = (ema_fast > ema_slow) and (ema_fast > prev_fast) and (prev_fast > prev_slow)
    trend_down = (ema_fast < ema_slow) and (ema_fast < prev_fast) and (prev_fast < prev_slow)

    # 3. VWAP reclaim (crossed back above/below this bar)
    vwap_reclaim_up   = (prev_close < prev_vwap) and (close > vwap)
    vwap_reclaim_down = (prev_close > prev_vwap) and (close < vwap)

    label = f"[{ticker}]" if ticker else ""

    # LONG: any entry condition + volume ok + RSI rising + above VWAP
    long_signal = (
        (cross_up or trend_up or vwap_reclaim_up) and
        rsi_long_ok and
        rsi_rising and
        above_vwap and
        volume_ok
    )

    # SHORT: any entry condition + volume ok + RSI falling + below VWAP
    short_signal = (
        (cross_down or trend_down or vwap_reclaim_down) and
        rsi_short_ok and
        rsi_falling and
        below_vwap and
        volume_ok
    )

    if long_signal:
        signal = "LONG"
    elif short_signal:
        signal = "SHORT"
    else:
        signal = "HOLD"

    log(f"[STRATEGY]{label} {signal} | close={close} "
        f"ema9={ema_fast:.2f} ema21={ema_slow:.2f} "
        f"rsi={rsi:.1f} vwap={vwap:.2f}")

    return signal, atr, info
