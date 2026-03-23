"""
strategy.py — Winston v10 — XRP Momentum Engine

Adapted from v9 for crypto volatility:
  - Lower ADX threshold (15 vs 20) — XRP trends differently than equities
  - Wider RSI bands (35/75 vs 38/74) — XRP swings harder
  - ABSTAIN votes still active — only trades when indicators are confident
  - Momentum confirmation required — EMA + MACD must agree
  - OBV slope for smart money detection

The 10 Votes:
  ── Trend ──────────────────────────────────────────────────
  1.  EMA Trend         — EMA9 above/below EMA21
  2.  Higher Timeframe  — 15-min EMA trend (resampled from 5-min)

  ── Momentum ───────────────────────────────────────────────
  3.  MACD Cross        — MACD line above/below signal line
  4.  MACD Histogram    — histogram accelerating or decelerating
  5.  RSI Direction     — RSI slope over last 3 bars
  6.  RSI Extreme       — only votes at oversold/overbought

  ── Price Structure ────────────────────────────────────────
  7.  VWAP Position     — price above/below VWAP
  8.  Bollinger Band    — near bands = vote, middle = abstain

  ── Volume & Candles ───────────────────────────────────────
  9.  OBV Slope         — on-balance volume direction
  10. Candle Pattern    — strong close = vote, doji = abstain
"""

import pandas as pd
import numpy as np
from config import (
    EMA_FAST, EMA_SLOW, RSI_PERIOD,
    RSI_OVERSOLD, RSI_OVERBOUGHT, ATR_PERIOD,
    MIN_VOTE_SCORE, ADX_THRESHOLD
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


def _macd(series: pd.Series, fast=12, slow=26, signal=9):
    ema_fast    = series.ewm(span=fast,   adjust=False).mean()
    ema_slow    = series.ewm(span=slow,   adjust=False).mean()
    macd_line   = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    histogram   = macd_line - signal_line
    return macd_line, signal_line, histogram


def _bollinger(series: pd.Series, period=20, num_std=2):
    middle = series.rolling(period).mean()
    std    = series.rolling(period).std()
    upper  = middle + (std * num_std)
    lower  = middle - (std * num_std)
    return upper, middle, lower


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
    return cum_tp_vol / cum_vol.replace(0, 1)


def _obv(df: pd.DataFrame) -> pd.Series:
    direction = np.sign(df["close"].diff())
    return (df["volume"] * direction).cumsum()


def _trend_strength(df: pd.DataFrame, period: int = 14) -> float:
    """ADX — trend strength from 0-100. Above threshold = trending."""
    high  = df["high"]
    low   = df["low"]
    close = df["close"]

    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low  - prev_close).abs()
    ], axis=1).max(axis=1)

    up_move   = high - high.shift(1)
    down_move = low.shift(1) - low

    plus_dm = pd.Series(
        np.where((up_move > down_move) & (up_move > 0), up_move, 0),
        index=df.index
    )
    minus_dm = pd.Series(
        np.where((down_move > up_move) & (down_move > 0), down_move, 0),
        index=df.index
    )

    atr_smooth = tr.ewm(alpha=1/period, adjust=False).mean()
    plus_di    = 100 * plus_dm.ewm(alpha=1/period, adjust=False).mean() / atr_smooth
    minus_di   = 100 * minus_dm.ewm(alpha=1/period, adjust=False).mean() / atr_smooth

    dx  = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, 1)
    adx = dx.ewm(alpha=1/period, adjust=False).mean()

    return float(adx.iloc[-1]) if not pd.isna(adx.iloc[-1]) else 0.0


def _resample_to_15min(df: pd.DataFrame) -> pd.DataFrame:
    df15 = df.copy().reset_index(drop=True)
    df15 = df15.groupby(df15.index // 3).agg({
        "open":   "first",
        "high":   "max",
        "low":    "min",
        "close":  "last",
        "volume": "sum",
    })
    return df15


def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["ema_fast"]  = _ema(df["close"], EMA_FAST)
    df["ema_slow"]  = _ema(df["close"], EMA_SLOW)
    df["rsi"]       = _rsi(df["close"], RSI_PERIOD)
    df["atr"]       = _atr(df, ATR_PERIOD)
    df["vwap"]      = _vwap(df)
    df["vol_avg"]   = df["volume"].rolling(20).mean()
    df["obv"]       = _obv(df)

    macd, sig, hist  = _macd(df["close"])
    df["macd"]       = macd
    df["macd_sig"]   = sig
    df["macd_hist"]  = hist

    bb_upper, bb_mid, bb_lower = _bollinger(df["close"])
    df["bb_upper"]  = bb_upper
    df["bb_mid"]    = bb_mid
    df["bb_lower"]  = bb_lower
    return df


def get_vote_score(df: pd.DataFrame, ticker: str = "") -> dict:
    df = compute_indicators(df)

    if len(df) < 30:
        return {"long_votes": 0, "short_votes": 0, "signal": "HOLD",
                "votes": {}, "info": {}, "atr": 0.0}

    latest = df.iloc[-1]
    prev   = df.iloc[-2]
    prev2  = df.iloc[-3]

    close     = float(latest["close"])
    high      = float(latest["high"])
    low       = float(latest["low"])
    ema_fast  = float(latest["ema_fast"])
    ema_slow  = float(latest["ema_slow"])
    rsi       = float(latest["rsi"])
    prev_rsi  = float(prev["rsi"])
    prev2_rsi = float(prev2["rsi"])
    vwap      = float(latest["vwap"])      if not pd.isna(latest["vwap"])      else close
    atr       = float(latest["atr"])       if not pd.isna(latest["atr"])       else 0.0
    macd      = float(latest["macd"])      if not pd.isna(latest["macd"])      else 0.0
    macd_sig  = float(latest["macd_sig"])  if not pd.isna(latest["macd_sig"])  else 0.0
    macd_hist = float(latest["macd_hist"]) if not pd.isna(latest["macd_hist"]) else 0.0
    prev_hist = float(prev["macd_hist"])   if not pd.isna(prev["macd_hist"])   else 0.0
    bb_upper  = float(latest["bb_upper"])  if not pd.isna(latest["bb_upper"])  else close + 1
    bb_lower  = float(latest["bb_lower"])  if not pd.isna(latest["bb_lower"])  else close - 1
    bb_mid    = float(latest["bb_mid"])    if not pd.isna(latest["bb_mid"])    else close
    volume    = float(latest["volume"])
    vol_avg   = float(latest["vol_avg"])   if not pd.isna(latest["vol_avg"])   else volume

    # ── Trend strength gate ──────────────────────────────────────────────
    adx = _trend_strength(df)
    if adx < ADX_THRESHOLD:
        label = f"[{ticker}]" if ticker else ""
        log(f"[STRATEGY]{label} HOLD — choppy market (ADX={adx:.1f}, need {ADX_THRESHOLD}+)")
        return {"long_votes": 0, "short_votes": 0, "signal": "HOLD",
                "votes": {}, "info": {"close": round(close, 4), "adx": round(adx, 1)},
                "atr": atr}

    votes = {}

    # Vote 1: EMA Trend
    votes["ema_trend"] = "LONG" if ema_fast > ema_slow else "SHORT"

    # Vote 2: Higher Timeframe
    try:
        df15 = _resample_to_15min(df)
        if len(df15) >= 5:
            ema_fast_15 = float(_ema(df15["close"], EMA_FAST).iloc[-1])
            ema_slow_15 = float(_ema(df15["close"], EMA_SLOW).iloc[-1])
            votes["higher_tf"] = "LONG" if ema_fast_15 > ema_slow_15 else "SHORT"
        else:
            votes["higher_tf"] = votes["ema_trend"]
    except Exception:
        votes["higher_tf"] = votes["ema_trend"]

    # Vote 3: MACD Cross
    votes["macd_cross"] = "LONG" if macd > macd_sig else "SHORT"

    # Vote 4: MACD Histogram momentum
    hist_delta = macd_hist - prev_hist
    if abs(hist_delta) > 0.00001:  # tighter threshold for crypto decimals
        votes["macd_histogram"] = "LONG" if hist_delta > 0 else "SHORT"
    else:
        votes["macd_histogram"] = "ABSTAIN"

    # Vote 5: RSI Direction (smoothed over 3 bars)
    rsi_slope = rsi - prev2_rsi
    if abs(rsi_slope) > 0.5:
        votes["rsi_direction"] = "LONG" if rsi_slope > 0 else "SHORT"
    else:
        votes["rsi_direction"] = "ABSTAIN"

    # Vote 6: RSI Extreme
    if rsi <= RSI_OVERSOLD:
        votes["rsi_extreme"] = "LONG"
    elif rsi >= RSI_OVERBOUGHT:
        votes["rsi_extreme"] = "SHORT"
    else:
        votes["rsi_extreme"] = "ABSTAIN"

    # Vote 7: VWAP Position
    votes["vwap_position"] = "LONG" if close > vwap else "SHORT"

    # Vote 8: Bollinger Band position
    bb_range = bb_upper - bb_lower
    if bb_range > 0:
        bb_pct = (close - bb_lower) / bb_range
        if bb_pct <= 0.25:
            votes["bollinger"] = "LONG"
        elif bb_pct >= 0.75:
            votes["bollinger"] = "SHORT"
        else:
            votes["bollinger"] = "ABSTAIN"
    else:
        votes["bollinger"] = "ABSTAIN"

    # Vote 9: OBV Slope
    obv_now  = float(df["obv"].iloc[-1]) if not pd.isna(df["obv"].iloc[-1]) else 0
    obv_prev = float(df["obv"].iloc[-5]) if not pd.isna(df["obv"].iloc[-5]) else 0
    obv_delta = obv_now - obv_prev
    if abs(obv_delta) > 0:
        votes["obv_slope"] = "LONG" if obv_delta > 0 else "SHORT"
    else:
        votes["obv_slope"] = "ABSTAIN"

    # Vote 10: Candle Pattern
    bar_range = high - low
    if bar_range > 0:
        close_pct = (close - low) / bar_range
        if close_pct >= 0.65:
            votes["candle"] = "LONG"
        elif close_pct <= 0.35:
            votes["candle"] = "SHORT"
        else:
            votes["candle"] = "ABSTAIN"
    else:
        votes["candle"] = "ABSTAIN"

    # ── Tally ────────────────────────────────────────────────────────────
    active_votes = {k: v for k, v in votes.items() if v != "ABSTAIN"}
    long_votes   = sum(1 for v in active_votes.values() if v == "LONG")
    short_votes  = sum(1 for v in active_votes.values() if v == "SHORT")
    abstentions  = 10 - len(active_votes)

    # ── Momentum confirmation ────────────────────────────────────────────
    ema_dir  = votes.get("ema_trend", "ABSTAIN")
    macd_dir = votes.get("macd_cross", "ABSTAIN")
    momentum_confirmed = (ema_dir == macd_dir) and ema_dir != "ABSTAIN"

    # XRP is long-only on Coinbase (no shorting), so only LONG signals
    if long_votes >= MIN_VOTE_SCORE and momentum_confirmed and ema_dir == "LONG":
        signal = "LONG"
    else:
        signal = "HOLD"

    info = {
        "close":    round(close, 4),
        "ema_fast": round(ema_fast, 4),
        "ema_slow": round(ema_slow, 4),
        "rsi":      round(rsi, 1),
        "macd":     round(macd, 6),
        "vwap":     round(vwap, 4),
        "bb_upper": round(bb_upper, 4),
        "bb_lower": round(bb_lower, 4),
        "atr":      round(atr, 6),
        "adx":      round(adx, 1),
    }

    label = f"[{ticker}]" if ticker else ""
    conf_str = "confirmed" if momentum_confirmed else "conflicted"
    log(f"[STRATEGY]{label} {signal} | {long_votes}L/{short_votes}S "
        f"({abstentions} abstain) | momentum={conf_str} | ADX={adx:.1f} | "
        f"close={close:.4f} rsi={rsi:.1f} "
        f"macd={'▲' if macd > macd_sig else '▼'} "
        f"vwap={'↑' if close > vwap else '↓'}")

    vote_str = " ".join(
        f"{k}={'🟢' if v == 'LONG' else '🔴' if v == 'SHORT' else '⚪'}"
        for k, v in votes.items()
    )
    log(f"[VOTES]{label} {vote_str}")

    return {
        "long_votes":  long_votes,
        "short_votes": short_votes,
        "signal":      signal,
        "votes":       votes,
        "info":        info,
        "atr":         atr,
    }
