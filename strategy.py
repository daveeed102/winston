import pandas as pd
import numpy as np
from config import (
    EMA_FAST, EMA_SLOW, RSI_PERIOD,
    RSI_OVERSOLD, RSI_OVERBOUGHT, ATR_PERIOD
)
from logger import log

def _ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False).mean()

def _rsi(series: pd.Series, period: int) -> pd.Series:
    delta = series.diff()
    gain  = delta.clip(lower=0)
    loss  = -delta.clip(upper=0)
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
    typical = (df["high"] + df["low"] + df["close"]) / 3
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

    close    = float(latest["close"])
    ema_fast = float(latest["ema_fast"])
    ema_slow = float(latest["ema_slow"])
    rsi      = float(latest["rsi"])
    atr      = float(latest["atr"]) if not pd.isna(latest["atr"]) else 0.0
    vwap     = float(latest["vwap"]) if not pd.isna(latest["vwap"]) else close
    prev_fast = float(prev["ema_fast"])
    prev_slow = float(prev["ema_slow"])

    info = {
        "close": round(close, 2), "ema_fast": round(ema_fast, 2),
        "ema_slow": round(ema_slow, 2), "rsi": round(rsi, 1),
        "atr": round(atr, 4), "vwap": round(vwap, 2),
    }

    crossover_up   = (prev_fast <= prev_slow) and (ema_fast > ema_slow)
    rsi_ok         = RSI_OVERSOLD < rsi < RSI_OVERBOUGHT
    above_vwap     = close > vwap
    crossover_down = (prev_fast >= prev_slow) and (ema_fast < ema_slow)
    rsi_hot        = rsi >= RSI_OVERBOUGHT
    below_vwap     = close < vwap

    if crossover_up and rsi_ok and above_vwap:
        signal = "BUY"
    elif crossover_down or (rsi_hot and below_vwap):
        signal = "SELL"
    else:
        signal = "HOLD"

    label = f"[{ticker}]" if ticker else ""
    log(f"[STRATEGY]{label} {signal} | close={close} ema9={ema_fast:.2f} "
        f"ema21={ema_slow:.2f} rsi={rsi:.1f} vwap={vwap:.2f}")

    return signal, atr, info
