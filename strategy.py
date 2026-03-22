"""
strategy.py — Winston v8 — 10-Vote Statistical Engine

10 independent indicators each cast one vote: LONG or SHORT.
Minimum votes to trade set by MIN_VOTE_SCORE in config.py (currently 4).

The 10 Votes:
  ── Trend ──────────────────────────────────────────────────
  1.  EMA Trend         — EMA9 above/below EMA21
  2.  Higher Timeframe  — 15-min EMA9 above/below 15-min EMA21

  ── Momentum ───────────────────────────────────────────────
  3.  MACD Cross        — MACD line above/below signal line
  4.  MACD Histogram    — histogram growing or shrinking
  5.  RSI Direction     — RSI rising or falling this bar
  6.  RSI Level         — RSI below 55 (room up) or above (room down)

  ── Price Structure ────────────────────────────────────────
  7.  VWAP Position     — price above/below VWAP
  8.  Bollinger Position — price in lower or upper half of bands

  ── Volume & Candles ───────────────────────────────────────
  9.  Volume Trend      — volume heavier on up bars or down bars
  10. Candle Pattern    — bar closed near high (bullish) or near low (bearish)
"""

import pandas as pd
from config import (
    EMA_FAST, EMA_SLOW, RSI_PERIOD,
    RSI_OVERSOLD, RSI_OVERBOUGHT, ATR_PERIOD,
    MIN_VOTE_SCORE
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
    return cum_tp_vol / cum_vol


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
    prev3  = df.iloc[-4]

    close     = float(latest["close"])
    high      = float(latest["high"])
    low       = float(latest["low"])
    ema_fast  = float(latest["ema_fast"])
    ema_slow  = float(latest["ema_slow"])
    rsi       = float(latest["rsi"])
    prev_rsi  = float(prev["rsi"])
    vwap      = float(latest["vwap"])    if not pd.isna(latest["vwap"])    else close
    atr       = float(latest["atr"])     if not pd.isna(latest["atr"])     else 0.0
    macd      = float(latest["macd"])    if not pd.isna(latest["macd"])    else 0.0
    macd_sig  = float(latest["macd_sig"]) if not pd.isna(latest["macd_sig"]) else 0.0
    macd_hist = float(latest["macd_hist"]) if not pd.isna(latest["macd_hist"]) else 0.0
    prev_hist = float(prev["macd_hist"])   if not pd.isna(prev["macd_hist"])   else 0.0
    bb_upper  = float(latest["bb_upper"]) if not pd.isna(latest["bb_upper"]) else close + 1
    bb_lower  = float(latest["bb_lower"]) if not pd.isna(latest["bb_lower"]) else close - 1
    volume    = float(latest["volume"])
    vol_avg   = float(latest["vol_avg"]) if not pd.isna(latest["vol_avg"]) else volume

    closes  = [float(prev3["close"]), float(prev2["close"]),
                float(prev["close"]), close]
    volumes = [float(prev3["volume"]), float(prev2["volume"]),
                float(prev["volume"]), volume]

    votes = {}

    # Vote 1: EMA Trend
    votes["ema_trend"] = "LONG" if ema_fast > ema_slow else "SHORT"

    # Vote 2: Higher Timeframe (15-min)
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

    # Vote 4: MACD Histogram direction
    votes["macd_histogram"] = "LONG" if macd_hist > prev_hist else "SHORT"

    # Vote 5: RSI Direction
    votes["rsi_direction"] = "LONG" if rsi > prev_rsi else "SHORT"

    # Vote 6: RSI Level
    votes["rsi_level"] = "LONG" if rsi < 55 else "SHORT"

    # Vote 7: VWAP Position
    votes["vwap_position"] = "LONG" if close > vwap else "SHORT"

    # Vote 8: Bollinger Band position
    bb_midpoint = (bb_upper + bb_lower) / 2
    votes["bollinger"] = "LONG" if close < bb_midpoint else "SHORT"

    # Vote 9: Volume Trend
    up_vol   = sum(volumes[i] for i in range(1, len(closes))
                   if closes[i] > closes[i-1])
    down_vol = sum(volumes[i] for i in range(1, len(closes))
                   if closes[i] < closes[i-1])
    votes["volume_trend"] = "LONG" if up_vol >= down_vol else "SHORT"

    # Vote 10: Candle Pattern
    bar_range = high - low
    if bar_range > 0:
        close_position = (close - low) / bar_range
        if close_position >= 0.6:
            votes["candle"] = "LONG"
        elif close_position <= 0.4:
            votes["candle"] = "SHORT"
        else:
            votes["candle"] = "LONG"   # doji — slight long bias
    else:
        votes["candle"] = "LONG"

    # Tally
    long_votes  = sum(1 for v in votes.values() if v == "LONG")
    short_votes = sum(1 for v in votes.values() if v == "SHORT")

    if long_votes >= MIN_VOTE_SCORE:
        signal = "LONG"
    elif short_votes >= MIN_VOTE_SCORE:
        signal = "SHORT"
    else:
        signal = "HOLD"

    info = {
        "close":    round(close, 2),
        "ema_fast": round(ema_fast, 2),
        "ema_slow": round(ema_slow, 2),
        "rsi":      round(rsi, 1),
        "macd":     round(macd, 4),
        "vwap":     round(vwap, 2),
        "bb_upper": round(bb_upper, 2),
        "bb_lower": round(bb_lower, 2),
        "atr":      round(atr, 4),
    }

    label = f"[{ticker}]" if ticker else ""
    log(f"[STRATEGY]{label} {signal} | {long_votes}L/{short_votes}S | "
        f"close={close} rsi={rsi:.1f} "
        f"macd={'▲' if macd > macd_sig else '▼'} "
        f"vwap={'↑' if close > vwap else '↓'}")

    vote_str = " ".join(
        f"{k}={'🟢' if v == 'LONG' else '🔴'}"
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


def get_signal(df: pd.DataFrame, ticker: str = "") -> tuple:
    """Backwards-compatible wrapper."""
    result = get_vote_score(df, ticker)
    return result["signal"], result["atr"], result["info"]
