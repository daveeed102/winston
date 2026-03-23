"""
grok.py — Grok AI Price Prediction for Winston XRP

When the technical indicators give 4+ green votes, Grok gets the final say.
It receives multi-timeframe candle data and indicator readings, then predicts
whether XRP will be higher in ~4.5 minutes.

Grok says YES → buy. Grok says NO → skip.
"""

import json
import requests
import pandas as pd

import config
import broker
from logger import log


def _format_candles(df: pd.DataFrame, label: str, last_n: int = 10) -> str:
    """Format the last N candles into a compact string for the prompt."""
    recent = df.tail(last_n)
    lines = [f"=== {label} (last {last_n} candles) ==="]
    for i, row in recent.iterrows():
        lines.append(
            f"  O={row['open']:.4f} H={row['high']:.4f} "
            f"L={row['low']:.4f} C={row['close']:.4f} V={row['volume']:.0f}"
        )
    return "\n".join(lines)


def predict_price_direction(
    current_price: float,
    vote_summary: str,
    indicator_info: dict,
) -> bool:
    """
    Ask Grok to predict if XRP will be higher in ~4.5 minutes.

    Args:
        current_price: Current XRP-USD price
        vote_summary: String like "5L/3S (2 abstain)"
        indicator_info: Dict with close, rsi, macd, vwap, etc.

    Returns:
        True if Grok says YES (price will be higher), False otherwise.
        Returns True on any error (fail-open so the bot still trades).
    """
    if not config.GROK_API_KEY:
        log("[GROK] No API key — skipping prediction (fail-open: allowing trade)")
        return True

    try:
        # Fetch multi-timeframe candle data
        log("[GROK] Fetching multi-timeframe data...")

        df_5m  = broker.get_candles(config.PRODUCT_ID, "FIVE_MINUTE", 30)
        df_15m = broker.get_candles(config.PRODUCT_ID, "FIFTEEN_MINUTE", 20)
        df_1h  = broker.get_candles(config.PRODUCT_ID, "ONE_HOUR", 12)

        candle_data = "\n\n".join([
            _format_candles(df_5m, "5-MINUTE", 12),
            _format_candles(df_15m, "15-MINUTE", 8),
            _format_candles(df_1h, "1-HOUR", 6),
        ])

        # Build the prompt
        system_prompt = (
            "You are a quantitative crypto trading analyst. You analyze multi-timeframe "
            "price data and technical indicators to predict very short-term price direction. "
            "You are decisive and direct. You must respond with ONLY a JSON object, "
            "no markdown, no backticks, no explanation outside the JSON:\n"
            '{"prediction": "YES" or "NO", "confidence": <0.0 to 1.0>, "reason": "<one sentence>"}\n\n'
            "YES means you believe the price will be HIGHER than the current price.\n"
            "NO means you believe it will be LOWER or FLAT.\n"
            "Be honest — if the data is unclear, say NO with low confidence."
        )

        user_prompt = (
            f"Will XRP-USD be HIGHER than ${current_price:.4f} in exactly 4 minutes and 30 seconds?\n\n"
            f"CURRENT PRICE: ${current_price:.4f}\n"
            f"TECHNICAL VOTE: {vote_summary}\n"
            f"RSI: {indicator_info.get('rsi', 'N/A')}\n"
            f"MACD: {indicator_info.get('macd', 'N/A')}\n"
            f"VWAP: {indicator_info.get('vwap', 'N/A')}\n"
            f"ADX (trend strength): {indicator_info.get('adx', 'N/A')}\n"
            f"ATR (volatility): {indicator_info.get('atr', 'N/A')}\n"
            f"Bollinger Upper: {indicator_info.get('bb_upper', 'N/A')}\n"
            f"Bollinger Lower: {indicator_info.get('bb_lower', 'N/A')}\n\n"
            f"{candle_data}\n\n"
            f"Based on this multi-timeframe data, will XRP be above ${current_price:.4f} "
            f"in 4 minutes 30 seconds? Respond with JSON only."
        )

        headers = {
            "Authorization": f"Bearer {config.GROK_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": config.GROK_MODEL,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0.1,  # Low temp for more deterministic predictions
        }

        log("[GROK] Asking Grok for price prediction...")
        resp = requests.post(
            "https://api.x.ai/v1/chat/completions",
            headers=headers,
            json=payload,
            timeout=15,
        )
        data = resp.json()
        text = data["choices"][0]["message"]["content"].strip()

        # Clean up potential markdown formatting
        text = text.replace("```json", "").replace("```", "").strip()

        result     = json.loads(text)
        prediction = result.get("prediction", "NO").upper()
        confidence = float(result.get("confidence", 0.0))
        reason     = result.get("reason", "No reason given")

        emoji = "🟢" if prediction == "YES" else "🔴"
        log(f"[GROK] {emoji} Prediction: {prediction} | Confidence: {confidence:.0%} | {reason}")

        return prediction == "YES"

    except Exception as e:
        log(f"[GROK] Prediction failed: {e} — fail-open: allowing trade")
        return True  # Fail-open: if Grok is down, still trade on technicals
