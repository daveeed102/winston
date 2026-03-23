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
            "and DexScreener.\n\n"
            "Your job: pick the 2 memecoins MOST LIKELY to pump in the next 6 hours.\n\n"
            "CRITICAL — RECENCY RULES (READ CAREFULLY):\n"
            "- You MUST use your search tools to find information from the LAST 6 HOURS ONLY.\n"
            "- When searching X, filter to posts from TODAY ONLY. Not 2 days ago. Not last week.\n"
            "- DO NOT cite a tweet or event unless you can confirm it happened in the last 6 hours.\n"
            "- If you're not sure when something happened, DO NOT use it as a reason.\n"
            "- DO NOT HALLUCINATE OR MAKE UP TWEETS. If you can't find a real tweet from today, "
            "say 'volume spike on CoinGecko' or 'trending on CoinMarketCap today' — not a fake tweet.\n"
            "- A tweet from 3 days ago is NOT a valid reason. ONLY the last few hours matter.\n"
            "- If you cite an influencer tweet, include the ACTUAL date/time you found it.\n\n"
            "CRITICAL — MEMECOINS ONLY:\n"
            "- DO NOT pick BTC, ETH, SOL, XRP, ADA, AVAX, LINK, DOT, MATIC, UNI, "
            "or any other large-cap 'blue chip' crypto. These don't move enough.\n"
            "- We WANT: memecoins, animal coins, joke coins, hype coins, narrative coins, "
            "lowcaps with viral potential — anything that can pump 10%+ in 6 hours.\n"
            "- Think PEPE, DOGE, SHIB, BONK, WIF, FLOKI, TURBO, BRETT — that tier and below.\n"
            "- The more degen the better. We're gambling, not investing.\n\n"
            "CRITICAL — COINBASE ONLY:\n"
            "- You MUST only pick from the Coinbase coin list provided. NO exceptions.\n"
            "- Do NOT pick coins that are NOT in the list. Double-check each pick.\n\n"
            "Respond with ONLY a JSON object, no markdown, no backticks:\n"
            '{"picks": ["SYMBOL1", "SYMBOL2"], '
            '"reasons": {"SYMBOL1": "what SPECIFICALLY is happening RIGHT NOW today", ...}}\n\n'
            "Use the SYMBOL only (like PEPE, BONK, WIF), not the full pair name."
        )

        from datetime import datetime, timezone
        now = datetime.now(timezone.utc)
        today = now.strftime("%B %d, %Y")
        time_now = now.strftime("%H:%M UTC")

        user_prompt = (
            f"RIGHT NOW it is {today} at {time_now}.\n\n"
            f"Pick your top 2 MEMECOINS to buy and hold for the next 6 hours.\n\n"
            f"IMPORTANT: You can ONLY pick from this exact list of Coinbase-available coins:\n"
            f"{symbol_list}\n\n"
            f"DO NOT pick any blue chip coins (BTC, ETH, SOL, XRP, etc). MEMECOINS ONLY.\n\n"
            f"Do your research — but ONLY look at the LAST 6 HOURS:\n"
            f"1. Search X/Twitter for memecoin posts from the last 6 hours ONLY\n"
            f"2. Check CoinMarketCap and CoinGecko for what's trending RIGHT NOW\n"
            f"3. Look for volume spikes happening NOW, not yesterday\n"
            f"4. Cross-reference with the Coinbase list above\n"
            f"5. Pick the 2 best memecoin opportunities\n\n"
            f"WARNING: Do NOT cite tweets or events older than 6 hours. "
            f"Do NOT make up fake tweets. If you can't verify when something happened, "
            f"focus on price action and volume data instead.\n\n"
            f"For each pick, explain what is happening RIGHT NOW that makes it hot.\n\n"
            f"Full degen mode. We're gambling. Go."
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

        # Validate picks are in available coins and NOT blue chips
        BLOCKED = {"BTC", "ETH", "SOL", "XRP", "ADA", "AVAX", "LINK", "DOT",
                   "MATIC", "UNI", "AAVE", "LTC", "BCH", "ATOM", "FIL", "APT",
                   "ARB", "OP", "NEAR", "ICP", "HBAR", "VET", "ALGO"}

        valid_picks = []
        valid_reasons = {}
        available_symbols = set(c.replace("-USD", "") for c in available_coins)

        for symbol in picks:
            symbol = symbol.upper().strip()
            if symbol in BLOCKED:
                log(f"[GROK] 🚫 {symbol} is a blue chip — blocked")
                continue
            if symbol in available_symbols:
                product_id = f"{symbol}-USD"
                valid_picks.append(product_id)
                valid_reasons[product_id] = reasons.get(symbol, "Trending on CT")
            else:
                log(f"[GROK] ⚠️ {symbol} not available on Coinbase — skipping")

        if len(valid_picks) < 1:
            log(f"[GROK] No valid picks found on Coinbase")
            return {}

        # Trim to NUM_PICKS (2)
        valid_picks = valid_picks[:config.NUM_PICKS]
        valid_reasons = {k: v for k, v in valid_reasons.items() if k in valid_picks}

        log(f"[GROK] 🎯 Picks: {', '.join(valid_picks)}")
        for coin, reason in valid_reasons.items():
            log(f"[GROK]   {coin}: {reason}")

        return {"picks": valid_picks, "reasons": valid_reasons}

    except Exception as e:
        log(f"[GROK] Pick failed: {e}")
        return {}
