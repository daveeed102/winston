"""
scanner.py — Data watchers for Winston v12

Sources:
  1. DEXScreener — boosted tokens, search pairs for volume/price/buys data
  2. Grok X/Twitter — early buzz detection (leading indicator)

All free, no API keys needed except Grok.
300 req/min on DEXScreener, no rate limit issues.
"""

import requests
from datetime import datetime, timezone
from logger import log
import config


def get_boosted_tokens() -> list:
    """Get the most boosted tokens on DEXScreener. These are tokens people are paying
    to promote — it's a hype signal (someone thinks it's worth promoting)."""
    try:
        resp = requests.get(
            "https://api.dexscreener.com/token-boosts/top/v1",
            timeout=10,
        )
        if resp.status_code != 200:
            log(f"[SCANNER] DEXScreener boosts returned {resp.status_code}")
            return []

        data = resp.json()
        if not isinstance(data, list):
            return []

        results = []
        seen = set()
        for token in data:
            symbol = token.get("description", "").split(" ")[0].upper() if token.get("description") else ""
            # Try to extract symbol from the token profile
            chain = token.get("chainId", "")
            address = token.get("tokenAddress", "")
            amount = token.get("totalAmount", 0) or token.get("amount", 0)

            if not symbol or symbol in seen:
                continue
            seen.add(symbol)

            results.append({
                "symbol": symbol,
                "chain": chain,
                "address": address,
                "boost_amount": amount,
                "source": "dexscreener_boosted",
            })

        log(f"[SCANNER] DEXScreener boosted: {len(results)} tokens")
        return results[:20]

    except Exception as e:
        log(f"[SCANNER] DEXScreener boosts error: {e}")
        return []


def get_token_data_dexscreener(symbol: str) -> dict:
    """
    Search DEXScreener for a token's pair data.
    Returns volume, price change, buys/sells, liquidity — the real numbers.
    """
    try:
        resp = requests.get(
            f"https://api.dexscreener.com/latest/dex/search?q={symbol}%20USD",
            timeout=10,
        )
        if resp.status_code != 200:
            return {}

        data = resp.json()
        pairs = data.get("pairs", [])
        if not pairs:
            return {}

        # Find the highest-volume USD pair
        best = None
        best_vol = 0
        for pair in pairs:
            base_sym = pair.get("baseToken", {}).get("symbol", "").upper()
            quote_sym = pair.get("quoteToken", {}).get("symbol", "").upper()

            # Match our symbol and USD-quoted pairs
            if base_sym != symbol.upper():
                continue
            if quote_sym not in ("USD", "USDT", "USDC", "WETH", "ETH"):
                continue

            vol = pair.get("volume", {}).get("h24", 0) or 0
            if vol > best_vol:
                best_vol = vol
                best = pair

        if not best:
            return {}

        price_change = best.get("priceChange", {})
        volume = best.get("volume", {})
        txns = best.get("txns", {})
        liquidity = best.get("liquidity", {})

        # Extract buy/sell counts from various timeframes
        h1_txns = txns.get("h1", {})
        h24_txns = txns.get("h24", {})

        return {
            "price": float(best.get("priceUsd", 0) or 0),
            "pct_5m": float(price_change.get("m5", 0) or 0),
            "pct_1h": float(price_change.get("h1", 0) or 0),
            "pct_6h": float(price_change.get("h6", 0) or 0),
            "pct_24h": float(price_change.get("h24", 0) or 0),
            "volume_5m": float(volume.get("m5", 0) or 0),
            "volume_1h": float(volume.get("h1", 0) or 0),
            "volume_24h": float(volume.get("h24", 0) or 0),
            "buys_1h": int(h1_txns.get("buys", 0) or 0),
            "sells_1h": int(h1_txns.get("sells", 0) or 0),
            "buys_24h": int(h24_txns.get("buys", 0) or 0),
            "sells_24h": int(h24_txns.get("sells", 0) or 0),
            "liquidity": float(liquidity.get("usd", 0) or 0),
            "market_cap": float(best.get("marketCap", 0) or best.get("fdv", 0) or 0),
        }

    except Exception as e:
        log(f"[SCANNER] DEXScreener search error for {symbol}: {e}")
        return {}


def get_x_mention_velocity(symbol: str) -> dict:
    """Use Grok to check X/Twitter buzz for a symbol in the last 2 hours."""
    if not config.GROK_API_KEY:
        return {"mentions": 0, "sentiment": 0, "has_influencer": False}

    try:
        now = datetime.now(timezone.utc)
        time_str = now.strftime("%B %d, %Y %H:%M UTC")

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
                        "You analyze crypto Twitter mentions. Respond with ONLY JSON, "
                        "no markdown, no backticks:\n"
                        '{"mention_count": <estimated posts in last 2 hours>, '
                        '"sentiment": <-1.0 to 1.0>, '
                        '"has_influencer": <true/false>, '
                        '"buzz_summary": "<one sentence>"}'
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Right now it's {time_str}. "
                        f"How much buzz is ${symbol} getting on crypto Twitter in the LAST 2 HOURS? "
                        f"Estimate posts, sentiment, influencer activity. Last 2 hours ONLY."
                    ),
                },
            ],
            "temperature": 0.3,
        }

        resp = requests.post(
            "https://api.x.ai/v1/chat/completions",
            headers=headers,
            json=payload,
            timeout=15,
        )
        data = resp.json()
        text = data["choices"][0]["message"]["content"].strip()
        text = text.replace("```json", "").replace("```", "").strip()

        import json
        result = json.loads(text)
        return {
            "mentions": int(result.get("mention_count", 0)),
            "sentiment": float(result.get("sentiment", 0)),
            "has_influencer": bool(result.get("has_influencer", False)),
            "buzz": result.get("buzz_summary", ""),
        }

    except Exception as e:
        log(f"[SCANNER] X mention check failed for {symbol}: {e}")
        return {"mentions": 0, "sentiment": 0, "has_influencer": False}


def get_grok_early_picks(available_coins: list) -> list:
    """Ask Grok for memecoins starting to buzz on X/Twitter."""
    if not config.GROK_API_KEY:
        return []

    try:
        available_symbols = sorted(set(
            c.replace("-USD", "") for c in available_coins
            if c.replace("-USD", "") not in config.BLOCKED_COINS
        ))
        symbol_list = ", ".join(available_symbols)

        now = datetime.now(timezone.utc)
        time_str = now.strftime("%B %d, %Y %H:%M UTC")

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
                        "You find memecoins STARTING to buzz on crypto Twitter. "
                        "Early signals only — first mentions, unusual chatter beginning.\n"
                        "ONLY pick from the provided Coinbase list. LAST FEW HOURS ONLY.\n"
                        "NO blue chips. DO NOT make up tweets.\n"
                        "Respond with ONLY JSON:\n"
                        '{"picks": [{"symbol": "PEPE", "reason": "early signal found"}]}'
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"It's {time_str}. Find 3-5 memecoins starting to get attention "
                        f"on X in the last few hours.\n"
                        f"ONLY from this Coinbase list:\n{symbol_list}\n"
                        f"Focus on early momentum, not already-pumped coins."
                    ),
                },
            ],
            "temperature": 0.5,
        }

        log("[SCANNER] Asking Grok for early X/Twitter buzz picks...")
        resp = requests.post(
            "https://api.x.ai/v1/chat/completions",
            headers=headers,
            json=payload,
            timeout=20,
        )
        data = resp.json()
        text = data["choices"][0]["message"]["content"].strip()
        text = text.replace("```json", "").replace("```", "").strip()

        import json
        result = json.loads(text)
        picks = result.get("picks", [])

        valid = []
        available_set = set(c.replace("-USD", "").upper() for c in available_coins)
        for p in picks:
            sym = p.get("symbol", "").upper().strip()
            if sym in available_set and sym not in config.BLOCKED_COINS:
                valid.append({"symbol": sym, "reason": p.get("reason", "early X buzz")})

        log(f"[SCANNER] Grok found {len(valid)} early buzz picks")
        return valid

    except Exception as e:
        log(f"[SCANNER] Grok discovery failed: {e}")
        return []


def discover_candidates(available_coins: list) -> list:
    """
    Merge all sources, enrich with DEXScreener data, return scored candidates.

    Source 1: DEXScreener boosted tokens (hype signal)
    Source 2: Grok X/Twitter early buzz (leading indicator)

    Then for each candidate, pull real volume/price/buys data from DEXScreener.
    """
    candidates = {}
    available_set = set(c.replace("-USD", "").upper() for c in available_coins)

    # Source 1: DEXScreener boosted tokens
    for token in get_boosted_tokens():
        sym = token["symbol"]
        if sym in available_set and sym not in config.BLOCKED_COINS:
            candidates[sym] = candidates.get(sym, {"symbol": sym, "sources": []})
            candidates[sym]["sources"].append("dex_boosted")

    # Source 2: Grok X/Twitter early buzz
    for pick in get_grok_early_picks(available_coins):
        sym = pick["symbol"]
        candidates[sym] = candidates.get(sym, {"symbol": sym, "sources": []})
        candidates[sym]["sources"].append("x_early_buzz")
        candidates[sym]["grok_reason"] = pick.get("reason", "")

    # Log multi-source coins
    for sym, c in candidates.items():
        if len(c.get("sources", [])) >= 2:
            log(f"[SCANNER] 🔥 {sym} found in {len(c['sources'])} sources: {c['sources']}")

    # Enrich each candidate with DEXScreener pair data (volume, price, buys/sells)
    import time as _time
    enriched = []
    for sym, c in candidates.items():
        dex_data = get_token_data_dexscreener(sym)
        _time.sleep(0.3)  # Gentle rate limiting

        if dex_data:
            c.update(dex_data)
            log(f"[SCANNER] {sym}: price=${dex_data.get('price', 0):.6f} "
                f"1h={dex_data.get('pct_1h', 0):+.1f}% "
                f"vol_1h=${dex_data.get('volume_1h', 0):,.0f} "
                f"buys={dex_data.get('buys_1h', 0)} sells={dex_data.get('sells_1h', 0)}")
        else:
            log(f"[SCANNER] {sym}: no DEXScreener data found")

        enriched.append(c)

    log(f"[SCANNER] {len(enriched)} total candidates "
        f"({sum(1 for c in enriched if len(c.get('sources', [])) >= 2)} multi-source)")
    return enriched
