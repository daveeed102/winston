"""
grok.py — Optional Grok sentiment analysis for Winston XRP

Not used in the core voting engine (yet) but available if you want to add it
as an 11th vote later. Call get_sentiment("XRP") to get a -1.0 to 1.0 score.
"""

import requests
import config
from logger import log


def get_sentiment(ticker: str = "XRP") -> float:
    """
    Ask Grok for a sentiment score on the given ticker.
    Returns a float from -1.0 (very bearish) to 1.0 (very bullish).
    Returns 0.0 on any error.
    """
    if not config.GROK_API_KEY:
        return 0.0

    try:
        headers = {
            "Authorization": f"Bearer {config.GROK_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": config.GROK_MODEL,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are a crypto market sentiment analyst. "
                        "Respond with ONLY a JSON object: "
                        '{"score": <float from -1.0 to 1.0>, "reason": "<one sentence>"}'
                    ),
                },
                {
                    "role": "user",
                    "content": f"What is the current market sentiment for {ticker} cryptocurrency right now?",
                },
            ],
        }

        resp = requests.post(
            "https://api.x.ai/v1/chat/completions",
            headers=headers,
            json=payload,
            timeout=10,
        )
        data = resp.json()
        text = data["choices"][0]["message"]["content"]

        import json
        result = json.loads(text)
        score  = float(result.get("score", 0.0))
        reason = result.get("reason", "")
        log(f"[GROK] {ticker} sentiment: {score:.2f} — {reason}")
        return max(-1.0, min(1.0, score))

    except Exception as e:
        log(f"[GROK] Sentiment fetch failed: {e}")
        return 0.0
