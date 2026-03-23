"""
grok.py — Winston v11 — AI Coin Picker

Asks Grok (which has native X/Twitter access) to pick the 5 hottest coins
that are trending on crypto Twitter and available on Coinbase.

Grok receives the full list of tradeable Coinbase coins and picks from that list only.
"""

import json
import requests

import config
from logger import log


def pick_coins(available_coins: list) -> dict:
    """
    Ask Grok to pick 5 coins based on crypto Twitter hype.

    Args:
        available_coins: List of product_ids available on Coinbase (e.g. ['BTC-USD', 'PEPE-USD', ...])

    Returns:
        Dict with {"picks": ["PEPE-USD", ...], "reasons": {"PEPE-USD": "reason", ...}}
        Returns empty dict on failure.
    """
    if not config.GROK_API_KEY:
        log("[GROK] No API key configured")
        return {}

    # Extract just the ticker symbols for cleaner prompt
    symbols = [c.replace("-USD", "") for c in available_coins]
    symbol_list = ", ".join(sorted(symbols))

    try:
        system_prompt = (
            "You are an elite degen crypto trader who lives on Crypto Twitter (CT). "
            "You have real-time access to X/Twitter, CoinMarketCap trending, CoinGecko, "
            "and DexScreener. You track what coins are being hyped RIGHT NOW TODAY.\n\n"
            "Your job: pick the 5 coins MOST LIKELY to pump in the next 6 hours.\n\n"
            "CRITICAL RULES:\n"
            "- You MUST only pick from the Coinbase coin list provided. NO exceptions.\n"
            "- Do NOT pick coins that are NOT in the list. Double-check each pick.\n"
            "- Focus on what is trending TODAY — not yesterday, not last week.\n"
            "- Search X/Twitter for today's posts about coins pumping, being shilled, "
            "going viral, or getting whale attention.\n"
            "- Check CoinMarketCap and CoinGecko trending pages for today's movers.\n"
            "- Look for: viral tweets today, breaking news today, new narratives forming "
            "today, coins with unusual volume spikes today, influencer shills today.\n"
            "- DO NOT pick a coin just because it's a big name. Only pick BTC/ETH/SOL if "
            "something specific is happening with them TODAY.\n"
            "- Memecoins, lowcaps, hype coins — all welcome. Full degen.\n"
            "- Each pick MUST have a detailed reason explaining WHY it's hot TODAY "
            "and what specific signal you found (tweet, news, volume spike, etc).\n\n"
            "Respond with ONLY a JSON object, no markdown, no backticks:\n"
            '{"picks": ["SYMBOL1", "SYMBOL2", "SYMBOL3", "SYMBOL4", "SYMBOL5"], '
            '"reasons": {"SYMBOL1": "detailed reason with what you found today", ...}}\n\n'
            "Use the SYMBOL only (like BTC, ETH, PEPE), not the full pair name."
        )

        from datetime import datetime, timezone
        today = datetime.now(timezone.utc).strftime("%B %d, %Y")

        user_prompt = (
            f"Today is {today}. Pick your top 5 coins to buy and hold for the next 6 hours.\n\n"
            f"IMPORTANT: You can ONLY pick from this exact list of Coinbase-available coins:\n"
            f"{symbol_list}\n\n"
            f"Do your research:\n"
            f"1. Search X/Twitter for crypto coins being hyped TODAY ({today})\n"
            f"2. Check what's trending on CoinMarketCap and CoinGecko TODAY\n"
            f"3. Look for volume spikes, viral posts, breaking news from TODAY\n"
            f"4. Cross-reference with the Coinbase list above\n"
            f"5. Pick the 5 best opportunities\n\n"
            f"For each pick, explain SPECIFICALLY what you found today that makes it hot. "
            f"Not generic reasons — tell me the tweet, the news, the catalyst.\n\n"
            f"Full degen mode. We're here to make money. Go."
        )

        headers = {
            "Authorization": f"Bearer {config.GROK_API_KEY}",
            "Content-Type": "application/json",
        }

        # Use the Responses API with search tools so Grok can actually
        # search X/Twitter and the web for TODAY's trending coins
        payload = {
            "model": config.GROK_MODEL,
            "temperature": 0.7,
            "instructions": system_prompt,
            "input": user_prompt,
            "tools": [
                {"type": "web_search"},
                {"type": "x_search"},
            ],
        }

        log("[GROK] Asking Grok for top 5 degen picks (with live X + web search)...")
        resp = requests.post(
            "https://api.x.ai/v1/responses",
            headers=headers,
            json=payload,
            timeout=60,  # Longer timeout since it's doing live searches
        )
        data = resp.json()

        # Responses API returns output array — find the text content
        output = data.get("output", [])
        text = ""
        for item in output:
            if isinstance(item, dict) and item.get("type") == "text":
                text = item.get("text", "")
                break

        # Fallback: try chat completions format in case Responses API isn't available
        if not text:
            if "choices" in data:
                text = data["choices"][0]["message"]["content"].strip()
            elif "error" in data:
                log(f"[GROK] API error: {data['error']}")
                # Fall back to chat completions without search
                log("[GROK] Falling back to chat completions (no live search)...")
                payload_fallback = {
                    "model": config.GROK_MODEL,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    "temperature": 0.7,
                }
                resp2 = requests.post(
                    "https://api.x.ai/v1/chat/completions",
                    headers=headers,
                    json=payload_fallback,
                    timeout=30,
                )
                data2 = resp2.json()
                text = data2["choices"][0]["message"]["content"].strip()

        if not text:
            log("[GROK] No text response from Grok")
            return {}

        text = text.replace("```json", "").replace("```", "").strip()

        result = json.loads(text)
        picks = result.get("picks", [])
        reasons = result.get("reasons", {})

        # Validate picks are in available coins
        valid_picks = []
        valid_reasons = {}
        available_symbols = set(c.replace("-USD", "") for c in available_coins)

        for symbol in picks:
            symbol = symbol.upper().strip()
            if symbol in available_symbols:
                product_id = f"{symbol}-USD"
                valid_picks.append(product_id)
                valid_reasons[product_id] = reasons.get(symbol, "Trending on CT")
            else:
                log(f"[GROK] ⚠️ {symbol} not available on Coinbase — skipping")

        if len(valid_picks) < 3:
            log(f"[GROK] Only {len(valid_picks)} valid picks — need at least 3")
            return {}

        # Trim to 5 max
        valid_picks = valid_picks[:config.NUM_PICKS]
        valid_reasons = {k: v for k, v in valid_reasons.items() if k in valid_picks}

        log(f"[GROK] 🎯 Picks: {', '.join(valid_picks)}")
        for coin, reason in valid_reasons.items():
            log(f"[GROK]   {coin}: {reason}")

        return {"picks": valid_picks, "reasons": valid_reasons}

    except Exception as e:
        log(f"[GROK] Pick failed: {e}")
        return {}
