"""
strategy.py
Computes technical indicators on 5-min SPY bars and returns a signal.
Signal: "BUY" | "SELL" | "HOLD"
"""

import pandas as pd
import pandas_ta as ta
from config import (
    EMA_FAST, EMA_SLOW, RSI_PERIOD,
    RSI_OVERSOLD, RSI_OVERBOUGHT, ATR_PERIOD
)
from logger import log


def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """Add EMA, RSI, VWAP, ATR columns to a bar DataFrame."""
    df = df.copy()
    df["ema_fast"] = ta.ema(df["close"], length=EMA_FAST)
    df["ema_slow"] = ta.ema(df["close"], length=EMA_SLOW)
    df["rsi"]      = ta.rsi(df["close"], length=RSI_PERIOD)
    df["atr"]      = ta.atr(df["high"], df["low"], df["close"], length=ATR_PERIOD)
    df["vwap"]     = ta.vwap(df["high"], df["low"], df["close"], df["volume"])
    return df


def get_signal(df: pd.DataFrame) -> tuple[str, float, dict]:
    """
    Analyse the latest bar and return:
      signal : "BUY" | "SELL" | "HOLD"
      atr    : current ATR value (used for stop/take-profit sizing)
      info   : dict of indicator values for logging
    """
    df = compute_indicators(df)

    # Need enough rows for indicators to warm up
    if df["ema_slow"].isna().all() or df["rsi"].isna().all():
        log("[STRATEGY] Not enough bars yet — HOLD")
        return "HOLD", 0.0, {}

    latest   = df.iloc[-1]
    prev     = df.iloc[-2]

    ema_fast = latest["ema_fast"]
    ema_slow = latest["ema_slow"]
    rsi      = latest["rsi"]
    atr      = latest["atr"]
    close    = latest["close"]
    vwap     = latest["vwap"]

    prev_ema_fast = prev["ema_fast"]
    prev_ema_slow = prev["ema_slow"]

    info = {
        "close":    round(close, 2),
        "ema_fast": round(ema_fast, 2),
        "ema_slow": round(ema_slow, 2),
        "rsi":      round(rsi, 1),
        "atr":      round(atr, 3),
        "vwap":     round(vwap, 2),
    }

    # ── BUY conditions ────────────────────────────────────────────────────────
    # 1. EMA crossover: fast crosses ABOVE slow (momentum turning up)
    ema_crossover_up = (prev_ema_fast <= prev_ema_slow) and (ema_fast > ema_slow)

    # 2. RSI in healthy buy zone (not oversold panic, not overbought)
    rsi_ok = RSI_OVERSOLD < rsi < RSI_OVERBOUGHT

    # 3. Price above VWAP (institutional bias is bullish intraday)
    above_vwap = close > vwap

    # ── SELL conditions ───────────────────────────────────────────────────────
    # 1. EMA crossover: fast crosses BELOW slow (momentum turning down)
    ema_crossover_down = (prev_ema_fast >= prev_ema_slow) and (ema_fast < ema_slow)

    # 2. RSI overbought
    rsi_overbought = rsi >= RSI_OVERBOUGHT

    # 3. Price below VWAP
    below_vwap = close < vwap

    # ── Decision ──────────────────────────────────────────────────────────────
    if ema_crossover_up and rsi_ok and above_vwap:
        signal = "BUY"
    elif ema_crossover_down or (rsi_overbought and below_vwap):
        signal = "SELL"
    else:
        signal = "HOLD"

    log(f"[STRATEGY] {signal} | close={close} ema9={ema_fast:.2f} ema21={ema_slow:.2f} "
        f"rsi={rsi:.1f} vwap={vwap:.2f}")

    return signal, float(atr), info
