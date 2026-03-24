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
                        "You count recent crypto Twitter mentions. Search X for the coin's "
                        "ticker symbol (with $) and count ONLY posts from the last 2 hours.\n"
                        "Respond with ONLY JSON, no markdown:\n"
                        '{"mention_count": <posts found in last 2 hours>, '
                        '"sentiment": <-1.0 to 1.0>, '
                        '"has_influencer": <true if any account with 50k+ followers posted>, '
                        '"buzz_summary": "<what people are specifically saying in recent posts>"}'
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Right now it's {time_str}. "
                        f"Search X for '${symbol}' and filter to RECENT posts only. "
                        f"How many posts mentioning ${symbol} can you find from the last 2 hours? "
                        f"What are people saying in those recent posts? "
                        f"Did any big accounts (50k+ followers) post about it? "
                        f"ONLY count posts from the last 2 hours — ignore anything older."
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
    """Ask Grok to search X/Twitter for the most-mentioned memecoins RIGHT NOW.
    Not 'what's trending' but literally what coins have the most posts in the last 2-3 hours."""
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
                        "You are a crypto Twitter analyst. Your job is to find which MEMECOINS "
                        "have the HIGHEST VOLUME of mentions on X/Twitter RIGHT NOW.\n\n"
                        "HOW TO DO THIS:\n"
                        "1. Search X for 'meme coin' and look at RECENT posts (last 2-3 hours)\n"
                        "2. Search X for 'memecoin pump' and look at RECENT posts\n"
                        "3. Search X for '$PEPE $BONK $DOGE $SHIB $WIF' etc and see which "
                        "have the most activity in the LAST 2-3 HOURS\n"
                        "4. Look for coins being mentioned repeatedly in DIFFERENT posts by "
                        "DIFFERENT accounts — that's real organic buzz, not one person shilling\n"
                        "5. Count which coin symbols appear most frequently\n\n"
                        "RULES:\n"
                        "- ONLY count posts from the LAST 2-3 HOURS. Not yesterday.\n"
                        "- ONLY pick from the provided Coinbase coin list.\n"
                        "- NO blue chips (BTC, ETH, SOL, XRP, etc).\n"
                        "- Rank by MENTION COUNT — the coin with the most recent posts wins.\n"
                        "- DO NOT make up tweet counts. If you can't verify, estimate conservatively.\n"
                        "- For each pick, say approximately how many posts you found.\n\n"
                        "Respond with ONLY JSON:\n"
                        '{"picks": [{"symbol": "PEPE", "mention_count": 150, '
                        '"reason": "what the posts are saying"}]}'
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Right now it's {time_str}.\n\n"
                        f"Search X/Twitter for the memecoins with the MOST posts in the "
                        f"last 2-3 hours. I want to know which memecoins people are actively "
                        f"talking about RIGHT NOW — the ones showing up when you search "
                        f"'meme coin' or 'memecoin' and filter to Recent.\n\n"
                        f"ONLY pick from this Coinbase list:\n{symbol_list}\n\n"
                        f"Give me the top 5 most-mentioned memecoins from the last 2-3 hours, "
                        f"ranked by how many posts/tweets you can find. Include approximate "
                        f"mention counts and what people are saying about each one.\n\n"
                        f"Be specific — I want to know what the actual tweets are about, "
                        f"not generic descriptions."
                    ),
                },
            ],
            "temperature": 0.4,
        }

        log("[SCANNER] Asking Grok: which memecoins have the most X posts in last 2-3 hours...")
        resp = requests.post(
            "https://api.x.ai/v1/chat/completions",
            headers=headers,
            json=payload,
            timeout=25,
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
                mentions = p.get("mention_count", 0)
                reason = p.get("reason", "active on CT")
                valid.append({
                    "symbol": sym,
                    "reason": f"~{mentions} posts in last 2-3h: {reason}",
                    "mention_count": mentions,
                })
                log(f"[SCANNER] Grok: {sym} — ~{mentions} mentions — {reason}")

        # Sort by mention count descending
        valid.sort(key=lambda x: x.get("mention_count", 0), reverse=True)

        log(f"[SCANNER] Grok found {len(valid)} actively-discussed memecoins")
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

    # Source 2: Grok X/Twitter — most-mentioned memecoins in last 2-3 hours
    for pick in get_grok_early_picks(available_coins):
        sym = pick["symbol"]
        candidates[sym] = candidates.get(sym, {"symbol": sym, "sources": []})
        candidates[sym]["sources"].append("x_early_buzz")
        candidates[sym]["grok_reason"] = pick.get("reason", "")
        candidates[sym]["grok_mention_count"] = pick.get("mention_count", 0)

    # Log multi-source coins
    for sym, c in candidates.items():
        if len(c.get("sources", [])) >= 2:
            log(f"[SCANNER] 🔥 {sym} found in {len(c['sources'])} sources: {c['sources']}")

    # Enrich each candidate with COINBASE multi-timeframe data
    import broker as _broker
    import time as _time
    enriched = []
    for sym, c in candidates.items():
        product_id = f"{sym}-USD"

        # Get price + volume from Coinbase
        cb_data = _broker.get_product_data(product_id)
        _time.sleep(0.2)

        if cb_data and cb_data.get("price", 0) > 0:
            c["price"] = cb_data["price"]
            c["volume_24h"] = cb_data.get("volume_24h", 0)
            c["pct_24h"] = cb_data.get("price_change_24h", 0)

            # ── 5-MINUTE candles (last 12 = 1 hour of granular data) ─────
            candles_5m = _broker.get_candles(product_id, "FIVE_MINUTE", 12)
            _time.sleep(0.2)

            if len(candles_5m) >= 3:
                # 15-min momentum (last 3 five-min candles)
                recent_close = candles_5m[-1]["close"]
                fifteen_min_ago = candles_5m[-3]["close"]
                if fifteen_min_ago > 0:
                    c["pct_15m"] = ((recent_close - fifteen_min_ago) / fifteen_min_ago) * 100

                # Volume in last 5 min vs average 5-min volume
                vol_last = candles_5m[-1].get("volume", 0)
                vol_avg = sum(c_.get("volume", 0) for c_ in candles_5m) / len(candles_5m)
                if vol_avg > 0:
                    c["volume_spike_5m"] = vol_last / vol_avg  # >2 = spiking

            # ── 1-HOUR candles (last 12 = 12 hours) ─────────────────────
            candles_1h = _broker.get_candles(product_id, "ONE_HOUR", 12)
            _time.sleep(0.2)

            if len(candles_1h) >= 2:
                current_close = candles_1h[-1]["close"]
                one_hour_ago = candles_1h[-2]["close"]
                if one_hour_ago > 0:
                    c["pct_1h"] = ((current_close - one_hour_ago) / one_hour_ago) * 100

                c["volume_1h"] = candles_1h[-1].get("volume", 0) * current_close

                # 2h change
                if len(candles_1h) >= 3:
                    two_h_ago = candles_1h[-3]["close"]
                    if two_h_ago > 0:
                        c["pct_2h"] = ((current_close - two_h_ago) / two_h_ago) * 100

                # Chart shape: are last 4 hourly candles trending up?
                if len(candles_1h) >= 4:
                    last_4 = [c_["close"] for c_ in candles_1h[-4:]]
                    ups = sum(1 for i in range(1, len(last_4)) if last_4[i] > last_4[i-1])
                    c["chart_trending_up"] = ups >= 2

                # 6h change
                if len(candles_1h) >= 7:
                    six_h_ago = candles_1h[-7]["close"]
                    if six_h_ago > 0:
                        c["pct_6h"] = ((current_close - six_h_ago) / six_h_ago) * 100

                # 12h change (full candle range)
                if len(candles_1h) >= 12:
                    twelve_h_ago = candles_1h[0]["close"]
                    if twelve_h_ago > 0:
                        c["pct_12h"] = ((current_close - twelve_h_ago) / twelve_h_ago) * 100

            # Estimate market cap from volume
            c["market_cap"] = c.get("volume_24h", 0) * 5

            log(f"[SCANNER] {sym}: ${c['price']:.6f} "
                f"15m={c.get('pct_15m', 0):+.1f}% "
                f"1h={c.get('pct_1h', 0):+.1f}% "
                f"6h={c.get('pct_6h', 0):+.1f}% "
                f"24h={c.get('pct_24h', 0):+.1f}% "
                f"vol_spike={c.get('volume_spike_5m', 0):.1f}x "
                f"chart_up={c.get('chart_trending_up', '?')}")
        else:
            log(f"[SCANNER] {sym}: couldn't get Coinbase data")

        enriched.append(c)

    log(f"[SCANNER] {len(enriched)} total candidates "
        f"({sum(1 for c in enriched if len(c.get('sources', [])) >= 2)} multi-source)")
    return enriched
