"""
scanner.py — Data watchers for Winston v12

Pulls trending/volume/momentum data from:
  1. CoinGecko trending API
  2. CoinGecko search trending
  3. Grok X/Twitter mention velocity (via xAI API)

All free APIs, no keys needed except Grok for X search.
Returns candidate tokens with raw data for the scorer.
"""

import requests
from datetime import datetime, timezone
from logger import log
import config


def get_trending_coingecko() -> list:
    """Get trending coins from CoinGecko. Returns list of symbols."""
    try:
        resp = requests.get(
            "https://api.coingecko.com/api/v3/search/trending",
            timeout=10,
        )
        data = resp.json()
        coins = data.get("coins", [])
        results = []
        for item in coins:
            coin = item.get("item", {})
            results.append({
                "symbol": coin.get("symbol", "").upper(),
                "name": coin.get("name", ""),
                "market_cap_rank": coin.get("market_cap_rank", 9999),
                "source": "coingecko_trending",
            })
        log(f"[SCANNER] CoinGecko trending: {len(results)} coins")
        return results
    except Exception as e:
        log(f"[SCANNER] CoinGecko trending error: {e}")
        return []


def get_coin_market_data(coin_id: str) -> dict:
    """Get detailed market data for a coin from CoinGecko."""
    try:
        resp = requests.get(
            f"https://api.coingecko.com/api/v3/coins/{coin_id}",
            params={
                "localization": "false",
                "tickers": "false",
                "community_data": "false",
                "developer_data": "false",
            },
            timeout=10,
        )
        data = resp.json()
        market = data.get("market_data", {})
        return {
            "price_change_1h": market.get("price_change_percentage_1h_in_currency", {}).get("usd", 0),
            "price_change_24h": market.get("price_change_percentage_24h", 0),
            "volume_24h": market.get("total_volume", {}).get("usd", 0),
            "market_cap": market.get("market_cap", {}).get("usd", 0),
        }
    except Exception:
        return {}


def get_coinbase_movers(available_coins: list) -> list:
    """
    Check which Coinbase coins have big price moves in last 24h.
    Uses CoinGecko's simple/price endpoint for batch price data.
    """
    try:
        # Get price changes for popular memecoins on Coinbase
        memecoin_symbols = [c.replace("-USD", "").lower() for c in available_coins
                          if c.replace("-USD", "") not in config.BLOCKED_COINS]

        # CoinGecko IDs don't always match symbols, so we'll use the markets endpoint
        resp = requests.get(
            "https://api.coingecko.com/api/v3/coins/markets",
            params={
                "vs_currency": "usd",
                "order": "volume_desc",
                "per_page": 250,
                "page": 1,
                "price_change_percentage": "1h,24h",
            },
            timeout=15,
        )
        data = resp.json()

        # Cross-reference with Coinbase available coins
        available_set = set(c.replace("-USD", "").upper() for c in available_coins)
        results = []

        for coin in data:
            symbol = coin.get("symbol", "").upper()
            if symbol in available_set and symbol not in config.BLOCKED_COINS:
                pct_1h = coin.get("price_change_percentage_1h_in_currency", 0) or 0
                pct_24h = coin.get("price_change_percentage_24h", 0) or 0
                volume = coin.get("total_volume", 0) or 0

                # Only include coins with notable movement or volume
                if abs(pct_1h) > 3 or abs(pct_24h) > 10 or volume > 1_000_000:
                    results.append({
                        "symbol": symbol,
                        "name": coin.get("name", ""),
                        "price": coin.get("current_price", 0),
                        "pct_1h": pct_1h,
                        "pct_24h": pct_24h,
                        "volume_24h": volume,
                        "market_cap": coin.get("market_cap", 0) or 0,
                        "source": "coingecko_movers",
                    })

        # Sort by 1h change descending (biggest movers first)
        results.sort(key=lambda x: x.get("pct_1h", 0), reverse=True)
        log(f"[SCANNER] CoinGecko movers: {len(results)} coins with notable movement")
        return results[:20]  # Top 20

    except Exception as e:
        log(f"[SCANNER] CoinGecko movers error: {e}")
        return []


def get_x_mention_velocity(symbol: str) -> dict:
    """
    Use Grok's API to search X/Twitter for recent mentions of a coin.
    Returns mention count and sentiment from the last 2 hours.
    """
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
                        '"has_influencer": <true/false if major CT influencer posted>, '
                        '"buzz_summary": "<one sentence about the vibe>"}'
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Right now it's {time_str}. "
                        f"How much buzz is ${symbol} getting on crypto Twitter in the LAST 2 HOURS? "
                        f"Estimate the number of posts, the sentiment, and whether any major "
                        f"influencers (100k+ followers) have posted about it. "
                        f"Only count posts from the last 2 hours, not older."
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


def discover_candidates(available_coins: list) -> list:
    """
    Merge all data sources, deduplicate, return top candidates.
    """
    candidates = {}

    # Source 1: CoinGecko trending
    for coin in get_trending_coingecko():
        sym = coin["symbol"]
        if sym not in config.BLOCKED_COINS:
            candidates[sym] = candidates.get(sym, {"symbol": sym, "sources": []})
            candidates[sym]["sources"].append("trending")
            candidates[sym]["name"] = coin.get("name", sym)

    # Source 2: CoinGecko movers (volume + price action)
    for coin in get_coinbase_movers(available_coins):
        sym = coin["symbol"]
        candidates[sym] = candidates.get(sym, {"symbol": sym, "sources": []})
        candidates[sym]["sources"].append("mover")
        candidates[sym].update({
            "name": coin.get("name", sym),
            "price": coin.get("price", 0),
            "pct_1h": coin.get("pct_1h", 0),
            "pct_24h": coin.get("pct_24h", 0),
            "volume_24h": coin.get("volume_24h", 0),
            "market_cap": coin.get("market_cap", 0),
        })

    # Filter to Coinbase-only
    available_set = set(c.replace("-USD", "").upper() for c in available_coins)
    filtered = {k: v for k, v in candidates.items() if k in available_set}

    result = list(filtered.values())
    log(f"[SCANNER] {len(result)} candidates after filtering to Coinbase")
    return result
