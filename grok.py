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
            "You are an aggressive short-term crypto scalping analyst. Your job is to act as "
            "a TIEBREAKER for a trading bot. The bot's technical indicators have ALREADY signaled "
            "a buy — your role is to confirm or reject based on the price action data.\n\n"
            "IMPORTANT RULES:\n"
            "- You should DEFAULT to YES. The technicals already passed. You are the final check.\n"
            "- Only say NO if you see something clearly dangerous: a sharp selloff in progress, "
            "a breakdown through support, a volume spike on red candles, or a clear reversal pattern.\n"
            "- A negative MACD or RSI below 50 alone is NOT a reason to say NO. These are lagging "
            "indicators and the bot already accounts for them in its vote system.\n"
            "- Flat/consolidating price action is fine — say YES. Small dips are fine — say YES.\n"
            "- You are looking for SHORT-TERM bounces and micro-momentum, not long-term trends.\n\n"
            "Respond with ONLY a JSON object, no markdown, no backticks:\n"
            '{"prediction": "YES" or "NO", "confidence": <0.0 to 1.0>, "reason": "<one sentence>"}'
        )

        user_prompt = (
            f"The trading bot's technical indicators voted {vote_summary} in favor of buying XRP-USD.\n"
            f"Should we proceed with the buy? Will price hold or go up in the next 4.5 minutes?\n\n"
            f"CURRENT PRICE: ${current_price:.4f}\n"
            f"RSI: {indicator_info.get('rsi', 'N/A')} | "
            f"MACD: {indicator_info.get('macd', 'N/A')} | "
            f"VWAP: {indicator_info.get('vwap', 'N/A')} | "
            f"ADX: {indicator_info.get('adx', 'N/A')}\n\n"
            f"{candle_data}\n\n"
            f"Remember: DEFAULT to YES unless you see active danger. Respond with JSON only."
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
            "temperature": 0.3,  # Slightly higher for less conservative predictions
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
