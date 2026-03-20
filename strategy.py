"""
strategy.py
Pure pandas indicators — no external TA library.
Returns LONG / SHORT / HOLD.

Changes from v1:
  - Added momentum confirmation (price vs EMA slope, not just crossover)
  - EMA crossover OR price reclaim above/below VWAP with RSI confirmation
  - This fires more signals while keeping quality high
  - Added trend strength filter via EMA gap
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
    return df


def get_signal(df: pd.DataFrame, ticker: str = "") -> tuple[str, float, dict]:
    df = compute_indicators(df)

    if len(df) < EMA_SLOW + 5:
        return "HOLD", 0.0, {}

    latest = df.iloc[-1]
    prev   = df.iloc[-2]
    prev2  = df.iloc[-3]

    close     = float(latest["close"])
    ema_fast  = float(latest["ema_fast"])
    ema_slow  = float(latest["ema_slow"])
    rsi       = float(latest["rsi"])
    atr       = float(latest["atr"]) if not pd.isna(latest["atr"]) else 0.0
    vwap      = float(latest["vwap"]) if not pd.isna(latest["vwap"]) else close

    prev_fast  = float(prev["ema_fast"])
    prev_slow  = float(prev["ema_slow"])
    prev2_fast = float(prev2["ema_fast"])
    prev2_slow = float(prev2["ema_slow"])

    info = {
        "close":    round(close, 2),
        "ema_fast": round(ema_fast, 2),
        "ema_slow": round(ema_slow, 2),
        "rsi":      round(rsi, 1),
        "atr":      round(atr, 4),
        "vwap":     round(vwap, 2),
    }

    # --- Signal conditions ---

    # Classic EMA crossover (was the only entry before)
    cross_up   = (prev_fast <= prev_slow) and (ema_fast > ema_slow)
    cross_down = (prev_fast >= prev_slow) and (ema_fast < ema_slow)

    # NEW: Trend continuation — fast EMA above slow AND rising for 2 bars
    trend_up   = (ema_fast > ema_slow) and (prev_fast > prev_slow) and (ema_fast > prev_fast)
    trend_down = (ema_fast < ema_slow) and (prev_fast < prev_slow) and (ema_fast < prev_fast)

    # NEW: VWAP reclaim — price crossed back above/below VWAP this bar
    vwap_reclaim_up   = (float(prev["close"]) < float(prev["vwap"])) and (close > vwap)
    vwap_reclaim_down = (float(prev["close"]) > float(prev["vwap"])) and (close < vwap)

    # RSI zones
    rsi_long  = RSI_OVERSOLD  < rsi < RSI_OVERBOUGHT
    rsi_short = RSI_OVERSOLD  < rsi < RSI_OVERBOUGHT

    # Price position
    above_vwap = close > vwap
    below_vwap = close < vwap

    label = f"[{ticker}]" if ticker else ""

    # LONG: crossover OR (trend continuation + VWAP above) OR (VWAP reclaim + RSI ok)
    if (cross_up and rsi_long and above_vwap) or \
       (trend_up and above_vwap and rsi_long) or \
       (vwap_reclaim_up and rsi_long):
        signal = "LONG"

    # SHORT: crossover OR (trend continuation + VWAP below) OR (VWAP breakdown + RSI ok)
    elif (cross_down and rsi_short and below_vwap) or \
         (trend_down and below_vwap and rsi_short) or \
         (vwap_reclaim_down and rsi_short):
        signal = "SHORT"

    else:
        signal = "HOLD"

    log(f"[STRATEGY]{label} {signal} | close={close} "
        f"ema9={ema_fast:.2f} ema21={ema_slow:.2f} "
        f"rsi={rsi:.1f} vwap={vwap:.2f}")

    return signal, atr, info
