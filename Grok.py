"""
grok.py
Two jobs:
  1. scan_tickers()   — ask Grok which tickers are hot right now (runs hourly)
  2. get_sentiment()  — ask Grok for a sentiment score on a specific ticker
"""

import json
import requests
from config import GROK_API_KEY, GROK_MODEL, MAX_TICKERS, FALLBACK_TICKERS
from logger import log

GROK_URL = "https://api.x.ai/v1/chat/completions"


def _call_grok(system: str, user: str, max_tokens: int = 300) -> str:
    """Raw Grok API call. Returns the text content or raises."""
    headers = {
        "Authorization": f"Bearer {GROK_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": GROK_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user",   "content": user},
        ],
        "temperature": 0.2,
        "max_tokens": max_tokens,
    }
    resp = requests.post(GROK_URL, headers=headers, json=payload, timeout=20)
    resp.raise_for_status()
    content = resp.json()["choices"][0]["message"]["content"].strip()
    if content.startswith("```"):
        parts = content.split("```")
        content = parts[1] if len(parts) > 1 else content
        if content.startswith("json"):
            content = content[4:]
    return content.strip()


# ── 1. Ticker scanner ─────────────────────────────────────────────────────────
SCAN_SYSTEM = f"""You are a stock market analyst. Your job is to identify the best
US stocks or ETFs to trade intraday RIGHT NOW based on:
- Current momentum and recent price action
- Volume and volatility (we want liquid, active tickers)
- News catalysts, earnings, macro events
- Overall market sentiment

Respond ONLY with a valid JSON array of exactly {MAX_TICKERS} ticker symbols.
Example: ["NVDA", "SPY", "TSLA", "AAPL", "AMD"]
No explanation, no extra text — just the JSON array."""

SCAN_USER = f"""Which {MAX_TICKERS} US stock or ETF tickers have the best intraday
trading opportunity right now? Pick high-liquidity names with momentum.
Respond only with the JSON array."""


def scan_tickers() -> list[str]:
    try:
        raw = _call_grok(SCAN_SYSTEM, SCAN_USER, max_tokens=100)
        tickers = json.loads(raw)
        if isinstance(tickers, list) and len(tickers) > 0:
            tickers = [str(t).upper().strip() for t in tickers[:MAX_TICKERS]]
            log(f"[GROK] Ticker scan → {tickers}")
            return tickers
    except Exception as e:
        log(f"[GROK] Ticker scan failed — using fallback. {e}")
    return FALLBACK_TICKERS


# ── 2. Sentiment scorer ───────────────────────────────────────────────────────
SENTIMENT_SYSTEM = """You are a financial sentiment analyst.
Given a stock ticker, score its short-term (next 1-2 hours) outlook.
Respond ONLY with valid JSON in this exact format, nothing else:
{"score": <float -1.0 to 1.0>, "reason": "<one short sentence>"}

Score guide:
 1.0 = extremely bullish    0.5 = moderately bullish    0.1 = slightly bullish
 0.0 = neutral             -0.1 = slightly bearish     -0.5 = moderately bearish
-1.0 = extremely bearish"""


def get_sentiment(ticker: str) -> tuple[float, str]:
    try:
        user_msg = (
            f"What is your sentiment outlook for {ticker} "
            f"for the next 1-2 hours of US market trading? "
            f"Respond only with the JSON object."
        )
        raw = _call_grok(SENTIMENT_SYSTEM, user_msg, max_tokens=120)
        data   = json.loads(raw)
        score  = float(max(-1.0, min(1.0, data["score"])))
        reason = str(data.get("reason", ""))
        log(f"[GROK] {ticker} sentiment={score:+.2f} | {reason}")
        return score, reason
    except Exception as e:
        log(f"[GROK] Sentiment failed for {ticker} — defaulting neutral. {e}")
        return 0.0, "Sentiment unavailable"
