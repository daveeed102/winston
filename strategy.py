import pandas as pd
import pandas_ta as ta
from config import (
    EMA_FAST, EMA_SLOW, RSI_PERIOD,
    RSI_OVERSOLD, RSI_OVERBOUGHT, ATR_PERIOD
)
from logger import log

def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["ema_fast"] = ta.ema(df["close"], length=EMA_FAST)
    df["ema_slow"] = ta.ema(df["close"], length=EMA_SLOW)
    df["rsi"]      = ta.rsi(df["close"], length=RSI_PERIOD)
    df["atr"]      = ta.atr(df["high"], df["low"], df["close"], length=ATR_PERIOD)
    df["vwap"]     = ta.vwap(df["high"], df["low"], df["close"], df["volume"])
    return df

def get_signal(df: pd.DataFrame, ticker: str = "") -> tuple[str, float, dict]:
    df = compute_indicators(df)

    if len(df) < EMA_SLOW + 5:
        return "HOLD", 0.0, {}
    if df["ema_slow"].isna().all() or df["rsi"].isna().all():
        return "HOLD", 0.0, {}

    latest = df.iloc[-1]
    prev   = df.iloc[-2]

    close    = float(latest["close"])
    ema_fast = float(latest["ema_fast"])
    ema_slow = float(latest["ema_slow"])
    rsi      = float(latest["rsi"])
    atr      = float(latest["atr"]) if not pd.isna(latest["atr"]) else 0.0
    vwap     = float(latest["vwap"]) if not pd.isna(latest["vwap"]) else close
    prev_fast = float(prev["ema_fast"]) if not pd.isna(prev["ema_fast"]) else ema_fast
    prev_slow = float(prev["ema_slow"]) if not pd.isna(prev["ema_slow"]) else ema_slow

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
