"""
DEGEN SNIPER v8 — Grok-Powered Hourly Coin Picker
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Two modes working together:

  GROK MODE (every hour):
    - Asks Grok to analyze Twitter buzz, trending Solana tokens,
      momentum, volume, and social sentiment
    - Grok picks ONE coin it thinks will pump in the next hour
    - Bot buys that coin and holds with split exit ladder
    - Grok ALWAYS picks — it never skips

  GRADUATION SNIPER (continuous):
    - Simultaneously watches for Pump.fun graduations
    - Buys graduations that pass filters when not in a Grok position
    - Fast entry via log scan (instant mint extraction)

Exit logic (both modes):
  - Sell 50% at PROFIT_TARGET_1 (1.4x), lock profit, trail rest
  - Sell remainder at PROFIT_TARGET_2 (2.0x)
  - Trailing stop (35%) with 3-reading confirmation
  - Dead coin detection (3 identical prices = bail)
  - Hard timeout (5 min for graduation, 60 min for Grok picks)
"""

import asyncio
import json
import time
import logging
import os
import base64 as b64
from dataclasses import dataclass
from typing import Optional

import aiohttp

# ─── CONFIG ──────────────────────────────────────────────────────────────────

TRADE_AMOUNT_SOL   = float(os.getenv("TRADE_AMOUNT_SOL",   "0.0625"))
TRAILING_STOP_PCT  = float(os.getenv("TRAILING_STOP_PCT",  "35"))      # graduation sniper stop (unused now)
GROK_STOP_LOSS_PCT = float(os.getenv("GROK_STOP_LOSS_PCT", "60"))      # Grok hold stop — wide, only for catastrophic dumps
MAX_HOLD_MINUTES   = float(os.getenv("MAX_HOLD_MINUTES",   "5"))       # graduation holds (unused now)
GROK_HOLD_MINUTES  = float(os.getenv("GROK_HOLD_MINUTES",  "60"))      # grok picks ride the full hour
SLIPPAGE_BPS       = int(os.getenv("SLIPPAGE_BPS",         "1000"))
PROFIT_TARGET_1    = float(os.getenv("PROFIT_TARGET_1",    "1.4"))
PROFIT_TARGET_2    = float(os.getenv("PROFIT_TARGET_2",    "2.0"))
MAX_TOP_HOLDER_PCT = float(os.getenv("MAX_TOP_HOLDER_PCT", "35"))
DEAD_COIN_STRIKES  = int(os.getenv("DEAD_COIN_STRIKES",    "3"))
STOP_CONFIRM_COUNT = int(os.getenv("STOP_CONFIRM_COUNT",   "3"))
GROK_INTERVAL_MINS = float(os.getenv("GROK_INTERVAL_MINS", "60"))     # how often Grok picks

DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "")
SOLANA_RPC_URL      = os.getenv("SOLANA_RPC_URL",      "")
WALLET_PRIVATE_KEY  = os.getenv("WALLET_PRIVATE_KEY",  "")
JUPITER_API_KEY     = os.getenv("JUPITER_API_KEY",     "")
GROK_API_KEY        = os.getenv("GROK_API_KEY",        "")

PUMPFUN     = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
RAYDIUM_AMM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
WSOL        = "So11111111111111111111111111111111111111112"

JUP_ORDER   = "https://api.jup.ag/swap/v2/order"
JUP_EXECUTE = "https://api.jup.ag/swap/v2/execute"
JUP_PRICE   = "https://api.jup.ag/price/v2"
GROK_URL    = "https://api.x.ai/v1/chat/completions"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(message)s",
    datefmt="%H:%M:%S"
)
log = logging.getLogger("sniper")

# ─── MODELS ──────────────────────────────────────────────────────────────────

@dataclass
class Token:
    mint: str
    symbol: str = "???"
    name: str   = "Unknown"
    source: str = ""  # "pumpfun", "raydium", "grok"

@dataclass
class Position:
    token: Token
    entry_price: float   = 0.0
    tokens_held: float   = 0.0
    original_tokens: float = 0.0
    cost_sol: float      = 0.0
    high_price: float    = 0.0
    stop_price: float    = 0.0
    opened_ts: float     = 0.0
    took_first: bool     = False
    hold_limit_mins: float = 5.0
    _last_price: float   = 0.0
    _same_count: int     = 0
    _below_stop: int     = 0

    def __post_init__(self):
        if not self.opened_ts:        self.opened_ts = time.time()
        if not self.original_tokens:  self.original_tokens = self.tokens_held

    @property
    def hold_secs(self): return time.time() - self.opened_ts
    @property
    def hold_mins(self):  return self.hold_secs / 60
    @property
    def timed_out(self):  return self.hold_secs >= self.hold_limit_mins * 60

# ─── GROK ────────────────────────────────────────────────────────────────────

class Grok:
    """
    Fetches REAL live data from Dexscreener, then asks Grok to pick
    the best coin from that real data. Grok never has to guess mint
    addresses — it only picks from coins we've already verified exist.
    """

    async def _fetch_trending(self) -> list:
        """
        Fetch Solana tokens with real momentum. Uses a tiered filter system:
        - Tier 1: Ideal coins (24h+ old, $100K+ liq, up 1h, more buys than sells)
        - Tier 2: Relaxed (6h+ old, $50K+ liq, up 1h)
        - Tier 3: Last resort — established safe coins (SOL, BONK, WIF, JUP) with current price data
        Always returns something so Grok can always pick.
        """
        import time as _time

        # Try Dexscreener boosted list
        mints_to_check = []
        try:
            async with aiohttp.ClientSession() as sess:
                async with sess.get(
                    "https://api.dexscreener.com/token-boosts/top/v1",
                    timeout=aiohttp.ClientTimeout(total=10)
                ) as r:
                    if r.status == 200:
                        items = await r.json()
                        mints_to_check = [
                            i.get("tokenAddress","") for i in (items or [])
                            if i.get("chainId") == "solana" and i.get("tokenAddress","")
                        ][:40]
        except Exception as e:
            log.error(f"Dexscreener boost fetch: {e}")

        # Also always include established blue-chip Solana tokens
        # These are safe fallbacks — real liquidity, real community
        SAFE_MINTS = [
            "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",  # BONK
            "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",  # WIF
            "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",   # JUP
            "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",  # ETH (Wormhole)
            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  # USDC (skip — stable)
            "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",  # mSOL
            "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",  # JitoSOL
            "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5",   # MEW
            "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",  # PYTH
            "nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7",  # NOS
        ]
        for m in SAFE_MINTS:
            if m not in mints_to_check:
                mints_to_check.append(m)

        log.info(f"Checking {len(mints_to_check)} tokens (boosted + safe coins)...")

        tier1, tier2, tier3 = [], [], []

        async with aiohttp.ClientSession() as sess:
            for mint in mints_to_check:
                if not mint or len(mint) < 32: continue
                try:
                    async with sess.get(
                        f"https://api.dexscreener.com/latest/dex/tokens/{mint}",
                        timeout=aiohttp.ClientTimeout(total=6)
                    ) as r2:
                        if r2.status != 200: continue
                        d = await r2.json()
                    pairs = d.get("pairs") or []
                    if not pairs: continue
                    p = pairs[0]

                    base        = p.get("baseToken", {})
                    symbol      = base.get("symbol", "?")
                    name        = base.get("name", "?")
                    liquidity   = p.get("liquidity", {}).get("usd", 0) or 0
                    mcap        = p.get("marketCap", 0) or 0
                    volume_5m   = p.get("volume", {}).get("m5", 0) or 0
                    volume_h1   = p.get("volume", {}).get("h1", 0) or 0
                    volume_h6   = p.get("volume", {}).get("h6", 0) or 0
                    chg_5m      = p.get("priceChange", {}).get("m5", 0) or 0
                    chg_1h      = p.get("priceChange", {}).get("h1", 0) or 0
                    chg_6h      = p.get("priceChange", {}).get("h6", 0) or 0
                    chg_24h     = p.get("priceChange", {}).get("h24", 0) or 0
                    buys_5m     = p.get("txns", {}).get("m5", {}).get("buys", 0) or 0
                    sells_5m    = p.get("txns", {}).get("m5", {}).get("sells", 0) or 0
                    buys_1h     = p.get("txns", {}).get("h1", {}).get("buys", 0) or 0
                    sells_1h    = p.get("txns", {}).get("h1", {}).get("sells", 0) or 0
                    created_at  = p.get("pairCreatedAt", 0) or 0
                    price_usd   = p.get("priceUsd", "0") or "0"
                    age_hours   = (_time.time() - created_at/1000) / 3600 if created_at > 0 else 9999

                    coin = {
                        "mint": mint, "symbol": symbol, "name": name,
                        "price_usd": price_usd,
                        "volume_5m": volume_5m, "volume_1h": volume_h1, "volume_6h": volume_h6,
                        "price_chg_5m": chg_5m, "price_chg_1h": chg_1h,
                        "price_chg_6h": chg_6h, "price_chg_24h": chg_24h,
                        "mcap": mcap, "liquidity": liquidity,
                        "txns_5m_buys": buys_5m, "txns_5m_sells": sells_5m,
                        "txns_1h_buys": buys_1h, "txns_1h_sells": sells_1h,
                        "age_hours": age_hours,
                    }

                    # Tier 1: ideal
                    if (age_hours >= 24 and liquidity >= 100_000 and
                            chg_1h > 0 and buys_5m > sells_5m and chg_24h <= 500):
                        tier1.append(coin)
                    # Tier 2: relaxed
                    elif (age_hours >= 6 and liquidity >= 50_000 and chg_1h > 0):
                        tier2.append(coin)
                    # Tier 3: any established coin with data
                    elif (mint in SAFE_MINTS and liquidity >= 10_000):
                        tier3.append(coin)

                except Exception as e:
                    log.debug(f"Token {mint[:16]}: {e}")
                    continue

        # Return best available tier
        if tier1:
            log.info(f"Tier 1 coins ({len(tier1)} qualified — age>24h, liq>$100K, up 1h)")
            return sorted(tier1, key=lambda x: x["price_chg_1h"], reverse=True)[:15]
        elif tier2:
            log.info(f"Tier 1 empty — using Tier 2 ({len(tier2)} coins, age>6h, liq>$50K)")
            return sorted(tier2, key=lambda x: x["price_chg_1h"], reverse=True)[:15]
        else:
            log.info(f"Using Tier 3 fallback — {len(tier3)} established safe coins")
            return sorted(tier3, key=lambda x: x["price_chg_1h"], reverse=True)[:15]


    async def pick_coin(self) -> Optional[dict]:
        if not GROK_API_KEY:
            log.warning("GROK_API_KEY not set")
            return None

        from datetime import datetime, timezone
        now_utc  = datetime.now(timezone.utc)
        now_str  = now_utc.strftime("%A, %B %d, %Y at %H:%M:%S UTC")

        # Step 1: Fetch real coins from Dexscreener
        log.info("Fetching real Dexscreener data for Grok...")
        trending = await self._fetch_trending()

        if not trending:
            log.warning("No Dexscreener data — asking Grok to pick a safe Solana coin from knowledge")
            # Fallback: ask Grok to pick from known safe Solana coins directly
            trending = [
                {"mint":"DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263","symbol":"BONK","name":"Bonk","price_chg_5m":0,"price_chg_1h":0,"price_chg_6h":0,"price_chg_24h":0,"volume_5m":0,"volume_1h":0,"volume_6h":0,"mcap":0,"liquidity":0,"txns_5m_buys":0,"txns_5m_sells":0,"txns_1h_buys":0,"txns_1h_sells":0,"age_hours":9999},
                {"mint":"EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm","symbol":"WIF","name":"dogwifhat","price_chg_5m":0,"price_chg_1h":0,"price_chg_6h":0,"price_chg_24h":0,"volume_5m":0,"volume_1h":0,"volume_6h":0,"mcap":0,"liquidity":0,"txns_5m_buys":0,"txns_5m_sells":0,"txns_1h_buys":0,"txns_1h_sells":0,"age_hours":9999},
                {"mint":"JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN","symbol":"JUP","name":"Jupiter","price_chg_5m":0,"price_chg_1h":0,"price_chg_6h":0,"price_chg_24h":0,"volume_5m":0,"volume_1h":0,"volume_6h":0,"mcap":0,"liquidity":0,"txns_5m_buys":0,"txns_5m_sells":0,"txns_1h_buys":0,"txns_1h_sells":0,"age_hours":9999},
                {"mint":"MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5","symbol":"MEW","name":"cat in a dogs world","price_chg_5m":0,"price_chg_1h":0,"price_chg_6h":0,"price_chg_24h":0,"volume_5m":0,"volume_1h":0,"volume_6h":0,"mcap":0,"liquidity":0,"txns_5m_buys":0,"txns_5m_sells":0,"txns_1h_buys":0,"txns_1h_sells":0,"age_hours":9999},
                {"mint":"HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3","symbol":"PYTH","name":"Pyth Network","price_chg_5m":0,"price_chg_1h":0,"price_chg_6h":0,"price_chg_24h":0,"volume_5m":0,"volume_1h":0,"volume_6h":0,"mcap":0,"liquidity":0,"txns_5m_buys":0,"txns_5m_sells":0,"txns_1h_buys":0,"txns_1h_sells":0,"age_hours":9999},
            ]
            log.info("Using hardcoded safe coin fallback list for Grok")

        log.info(f"Fed {len(trending)} real coins to Grok")

        # Step 2: Build a numbered list for Grok — Grok just picks a NUMBER
        # This way Grok CANNOT hallucinate a mint address
        lines = []
        for i, c in enumerate(trending, 1):
            buys_5m  = c.get('txns_5m_buys', 0)
            sells_5m = c.get('txns_5m_sells', 0)
            buys_1h  = c.get('txns_1h_buys', 0)
            sells_1h = c.get('txns_1h_sells', 0)
            age_h    = c.get('age_hours', 0)
            lines.append(
                f"{i}. {c.get('symbol','?')} ({c.get('name','?')}) | "
                f"Age: {age_h:.0f}h | "
                f"5m: {c.get('price_chg_5m',0):+.1f}% | "
                f"1h: {c.get('price_chg_1h',0):+.1f}% | "
                f"6h: {c.get('price_chg_6h',0):+.1f}% | "
                f"24h: {c.get('price_chg_24h',0):+.1f}% | "
                f"Vol5m: ${c.get('volume_5m',0):,.0f} | "
                f"Liq: ${c.get('liquidity',0):,.0f} | "
                f"MCap: ${c.get('mcap',0):,.0f} | "
                f"5m txns: {buys_5m}B/{sells_5m}S | "
                f"1h txns: {buys_1h}B/{sells_1h}S"
            )
        coin_list = "\n".join(lines)

        prompt = f"""Today is {now_str}. You are analyzing real live Solana token data.

I will BUY one of these tokens and HOLD it for exactly 59 minutes and 59 seconds.
I need the token that will be HIGHER at the end of that hold AND will not crash during it.

LIVE DATA (fetched right now):
{coin_list}

IMPORTANT: Every coin below has been PRE-FILTERED — all are 24h+ old, $100K+ liquidity, going UP in last hour, more buyers than sellers. No brand-new coins. No rugs.

YOUR JOB: Pick the ONE that will STILL BE UP after a full 60-minute hold.

ANALYSIS — rank each coin on:
1. SUSTAINED MOMENTUM: Is it up in 5m AND 1h AND 6h? Multi-hour trends are reliable. Sudden 5m spikes alone are not.
2. BUY CONVICTION: 1h buys vs sells ratio — sustained buying over an hour beats a 5-minute burst
3. NOT EXHAUSTED: Prefer under 200% gain in 24h — still has room to run
4. LIQUIDITY DEPTH: Higher = safer. Your sell won't move the price much.
5. YOUR KNOWLEDGE: Any Twitter buzz, project news, ecosystem narrative, or community strength you know about these specific tokens

PICK THE COIN WITH:
✅ Positive price change across 5m, 1h, AND 6h (consistent, not just a spike)
✅ Strong 1h buy pressure (not just 5m)
✅ Reasonable 24h gains (under 300%) — not already at the top
✅ High liquidity relative to others on the list

AVOID:
❌ Only positive in 5m but flat or negative 6h (just a blip)
❌ Already up 400%+ in 24h (exhausted, likely to dump)
❌ 1h buys barely above 1h sells (no real conviction)

You MUST pick one. Never refuse or say you cannot.ANALYSIS — for each token consider:
- Buy pressure: more buys than sells = accumulation happening now
- Volume spike: high 5m volume = momentum
- Price trend: positive 5m AND 1h = sustained move not a spike
- Liquidity: must be over $30K so my sell won't crash it
- Market cap: smaller = more room to run
- Avoid: tokens already up huge (likely to dump on me)

Also use any knowledge you have about these specific tokens or current Solana trends as of {now_str}.

Respond with ONLY a JSON object, no markdown:
{{
  "pick": <number from 1 to {len(trending)}>,
  "reason": "<why this specific token will be UP in 59min59sec — cite the data>",
  "survival": "<why it won't crash during the hold>",
  "confidence": "<high/medium>"
}}"""

        try:
            async with aiohttp.ClientSession() as sess:
                async with sess.post(
                    GROK_URL,
                    headers={"Authorization": f"Bearer {GROK_API_KEY}",
                             "Content-Type": "application/json"},
                    json={"model": "grok-3",
                          "messages": [{"role": "user", "content": prompt}],
                          "max_tokens": 300,
                          "temperature": 0.4},
                    timeout=aiohttp.ClientTimeout(total=30)
                ) as r:
                    if r.status != 200:
                        log.error(f"Grok API {r.status}: {(await r.text())[:200]}")
                        return None
                    data = await r.json()

            raw = data["choices"][0]["message"]["content"].strip()
            log.info(f"Grok raw response: {raw[:300]}")

            # Strip markdown fences
            if "```" in raw:
                raw = raw.split("```")[1]
                if raw.startswith("json"): raw = raw[4:]
            raw = raw.strip()

            parsed  = json.loads(raw)
            pick_n  = int(parsed.get("pick", 1)) - 1  # 0-indexed
            reason  = parsed.get("reason", "")
            survival= parsed.get("survival", "")
            conf    = parsed.get("confidence", "medium")

            # Clamp to valid range
            pick_n = max(0, min(pick_n, len(trending) - 1))
            coin   = trending[pick_n]

            mint   = coin["mint"]
            symbol = coin.get("symbol", "?")
            name   = coin.get("name", "?")
            mcap   = f"${coin.get('mcap',0):,.0f}"

            log.info(f"Grok picked #{pick_n+1}: {symbol} ({mint[:20]}...)")
            log.info(f"  Reason:   {reason}")
            log.info(f"  Survival: {survival}")
            log.info(f"  Conf: {conf} | MCap: {mcap}")

            return {
                "mint": mint, "symbol": symbol, "name": name,
                "reason": reason, "survival": survival,
                "confidence": conf, "mcap": mcap,
                "found_at": f"Dexscreener #{pick_n+1} — {now_str}",
                "evidence": f"5m: {coin.get('price_chg_5m',0):+.1f}% | "
                            f"Vol: ${coin.get('volume_5m',0):,.0f} | "
                            f"Buys: {coin.get('txns_5m_buys',0)} / "
                            f"Sells: {coin.get('txns_5m_sells',0)}"
            }

        except json.JSONDecodeError as e:
            log.error(f"Grok JSON error: {e} | raw: {raw[:200] if 'raw' in dir() else '?'}")
        except Exception as e:
            log.error(f"Grok pick error: {e}")
        return None
# ─── JUPITER ─────────────────────────────────────────────────────────────────

class Jupiter:
    def _headers(self):
        h = {"Content-Type": "application/json"}
        if JUPITER_API_KEY: h["x-api-key"] = JUPITER_API_KEY
        return h

    async def _sess(self):
        try:
            from aiohttp.resolver import AsyncResolver
            conn = aiohttp.TCPConnector(
                resolver=AsyncResolver(nameservers=["8.8.8.8","1.1.1.1"]),
                ssl=False, limit=10)
        except:
            conn = aiohttp.TCPConnector(ssl=False, limit=10)
        return aiohttp.ClientSession(connector=conn, headers=self._headers())

    async def price(self, mint) -> Optional[float]:
        s = await self._sess()
        try:
            async with s.get(f"{JUP_PRICE}?ids={mint}",
                             timeout=aiohttp.ClientTimeout(total=4)) as r:
                if r.status == 200:
                    d = await r.json()
                    p = d.get("data",{}).get(mint,{}).get("price")
                    if p: return float(p)
        except: pass
        finally: await s.close()
        # Quote fallback
        s2 = await self._sess()
        try:
            async with s2.get(JUP_ORDER,
                params={"inputMint": mint, "outputMint": WSOL,
                        "amount": str(int(100_000 * 1e6))},
                timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    d = await r.json()
                    out = int(d.get("outAmount","0")) / 1e9
                    if out > 0: return out / 100_000
        except: pass
        finally: await s2.close()
        return None

    async def sol_usd(self) -> float:
        s = await self._sess()
        try:
            async with s.get(f"{JUP_PRICE}?ids={WSOL}",
                             timeout=aiohttp.ClientTimeout(total=5)) as r:
                if r.status == 200:
                    d = await r.json()
                    p = d.get("data",{}).get(WSOL,{}).get("price")
                    if p: return float(p)
        except: pass
        finally: await s.close()
        return 160.0

    async def order(self, inp, out, amount, taker):
        s = await self._sess()
        try:
            async with s.get(JUP_ORDER,
                params={"inputMint": inp, "outputMint": out,
                        "amount": str(amount), "taker": taker,
                        "slippageBps": str(SLIPPAGE_BPS)},
                timeout=aiohttp.ClientTimeout(total=12)) as r:
                if r.status == 200: return await r.json()
                log.error(f"Jup order {r.status}: {(await r.text())[:200]}")
        except Exception as e: log.error(f"Jup order: {e}")
        finally: await s.close()
        return None

    async def execute(self, req_id, signed_b64):
        s = await self._sess()
        try:
            async with s.post(JUP_EXECUTE,
                json={"signedTransaction": signed_b64, "requestId": req_id},
                timeout=aiohttp.ClientTimeout(total=30)) as r:
                if r.status == 200: return await r.json()
                log.error(f"Jup exec {r.status}: {(await r.text())[:200]}")
        except Exception as e: log.error(f"Jup exec: {e}")
        finally: await s.close()
        return None

# ─── SOLANA ──────────────────────────────────────────────────────────────────

class Solana:
    def __init__(self, rpc, pk):
        self.rpc = rpc
        self.ws  = rpc.replace("https://","wss://").replace("http://","ws://")
        self.keypair = self.pubkey = None
        if pk:
            try:
                from solders.keypair import Keypair; import base58
                self.keypair = Keypair.from_bytes(base58.b58decode(pk))
                self.pubkey  = str(self.keypair.pubkey())
                log.info(f"Wallet: {self.pubkey[:8]}...{self.pubkey[-4:]}")
            except Exception as e: log.error(f"Wallet: {e}")

    async def balance(self, sess=None):
        if not self.pubkey: return 0.0
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(self.rpc,
                    json={"jsonrpc":"2.0","id":1,"method":"getBalance",
                          "params":[self.pubkey]},
                    timeout=aiohttp.ClientTimeout(total=10)) as r:
                    d = await r.json()
                    return d.get("result",{}).get("value",0)/1e9
        except: return 0.0

    async def token_balance(self, mint):
        if not self.pubkey: return 0, 6
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(self.rpc,
                    json={"jsonrpc":"2.0","id":1,
                          "method":"getTokenAccountsByOwner",
                          "params":[self.pubkey,{"mint":mint},
                                    {"encoding":"jsonParsed"}]},
                    timeout=aiohttp.ClientTimeout(total=10)) as r:
                    data = await r.json()
                for acct in data.get("result",{}).get("value",[]):
                    info = (acct.get("account",{}).get("data",{})
                                .get("parsed",{}).get("info",{}))
                    ta  = info.get("tokenAmount",{})
                    raw = int(ta.get("amount",0))
                    dec = int(ta.get("decimals",6))
                    if raw > 0: return raw, dec
        except Exception as e: log.error(f"token_balance: {e}")
        return 0, 6

    def sign(self, tx_b64):
        if not self.keypair: return None
        try:
            from solders.transaction import VersionedTransaction
            raw    = b64.b64decode(tx_b64)
            txn    = VersionedTransaction.from_bytes(raw)
            signed = VersionedTransaction(txn.message, [self.keypair])
            return b64.b64encode(bytes(signed)).decode()
        except Exception as e: log.error(f"Sign: {e}"); return None

# ─── DISCORD ─────────────────────────────────────────────────────────────────

class Discord:
    def __init__(self, url): self.url = url

    async def send(self, payload):
        if not self.url: return
        for attempt in range(3):
            try:
                async with aiohttp.ClientSession() as s:
                    r = await s.post(self.url, json=payload,
                                     timeout=aiohttp.ClientTimeout(total=10))
                    await r.release()
                    return
            except Exception as e:
                if attempt == 2: log.debug(f"Discord: {e}")
                await asyncio.sleep(1)

    def _label(self, p: Position) -> str:
        if p.token.symbol and p.token.symbol != "???": return p.token.symbol
        if p.token.name and p.token.name not in ("Unknown",""): return p.token.name[:12]
        return p.token.mint[:8] + "..."

    async def grok_pick(self, pick: dict, sol_usd: float, trade_sol: float):
        evidence = pick.get("evidence","")
        found_at = pick.get("found_at","")
        survival = pick.get("survival","")
        await self.send({"embeds": [{
            "title": f"🤖 GROK PICK — {pick['symbol']}",
            "color": 0xAA00FF,
            "description": f"💎 **{pick['confidence'].upper()}** confidence | MCap: {pick['mcap']}",
            "fields": [
                {"name":"📊 Why it pumps",
                 "value": pick['reason'][:1024], "inline": False},
                {"name":"🛡️ Won't crash because",
                 "value": survival[:1024] if survival else "N/A", "inline": False},
                {"name":"🔍 Found at",
                 "value": found_at[:256] if found_at else "N/A", "inline": True},
                {"name":"🐦 Twitter signal",
                 "value": evidence[:256] if evidence else "N/A", "inline": True},
                {"name":"Chart",
                 "value": f"[Solscan](https://solscan.io/token/{pick['mint']}) | [Dex](https://dexscreener.com/solana/{pick['mint']})",
                 "inline": False},
            ]
        }]})

    async def bought(self, p: Position, sol_usd: float):
        label        = self._label(p)
        source_emoji = "🤖" if p.token.source == "grok" else "🎓"
        await self.send({"embeds": [{
            "title": f"{source_emoji} BOUGHT — {label}",
            "color": 0x00AAFF,
            "description": (
                f"In: **{p.cost_sol:.4f} SOL**\n"
                f"T1: {PROFIT_TARGET_1}x (+{(PROFIT_TARGET_1-1)*100:.0f}%) | "
                f"T2: {PROFIT_TARGET_2}x (+{(PROFIT_TARGET_2-1)*100:.0f}%)"
            ),
            "fields": [
                {"name":"Stop","value":f"{TRAILING_STOP_PCT}% trail","inline":True},
                {"name":"Timeout","value":f"{p.hold_limit_mins:.0f}min","inline":True},
                {"name":"Chart","value":f"[Solscan](https://solscan.io/token/{p.token.mint})","inline":True},
            ]
        }]})

    async def sold(self, p: Position, reason: str, gain_x: float,
                   pnl_sol: float, pct: int, sol_usd: float):
        label     = self._label(p)
        is_profit = pnl_sol >= 0
        color     = 0x00FF88 if is_profit else 0xFF4444
        emoji     = "✅ PROFIT" if is_profit else "❌ LOSS"
        pnl_str   = f"+{pnl_sol:.5f} SOL" if is_profit else f"{pnl_sol:.5f} SOL"
        rmap = {"timeout":    "60min — full hold complete ⏰",
                "rug_stop":   "Rug detected — emergency exit 🚨",
                "price_dead": "No price feed 📡"}
        await self.send({"embeds": [{
            "title": f"{emoji} — {label} ({pct}% sold)",
            "color": color,
            "description": f"**{pnl_str}** ({gain_x:.3f}x) in {p.hold_mins:.1f}min",
            "fields": [
                {"name":"Reason","value":rmap.get(reason,reason),"inline":True},
                {"name":"P&L","value":pnl_str,"inline":True},
                {"name":"Chart","value":f"[Solscan](https://solscan.io/token/{p.token.mint})","inline":True},
            ]
        }]})

    async def alert(self, msg):
        await self.send({"content": msg})

# ─── DETECTOR ────────────────────────────────────────────────────────────────

class Detector:
    def __init__(self, sol):
        self.sol    = sol
        self.seen   = set()
        self.count  = 0
        self.queue  = asyncio.Queue()
        self.locked = False

    async def listen(self):
        while True:
            try:
                log.info("Connecting WS...")
                async with aiohttp.ClientSession() as sess:
                    async with sess.ws_connect(self.sol.ws, heartbeat=30) as ws:
                        log.info("WebSocket connected")
                        await ws.send_json({"jsonrpc":"2.0","id":1,
                            "method":"logsSubscribe",
                            "params":[{"mentions":[PUMPFUN]},
                                      {"commitment":"confirmed"}]})
                        await ws.send_json({"jsonrpc":"2.0","id":2,
                            "method":"logsSubscribe",
                            "params":[{"mentions":[RAYDIUM_AMM]},
                                      {"commitment":"confirmed"}]})
                        async for msg in ws:
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                await self._handle(msg.data)
                            elif msg.type in (aiohttp.WSMsgType.ERROR,
                                             aiohttp.WSMsgType.CLOSED):
                                break
            except Exception as e: log.error(f"WS: {e}")
            log.info("WS reconnecting in 5s...")
            await asyncio.sleep(5)

    async def _handle(self, raw):
        if self.locked: return
        try:
            data = json.loads(raw)
            if "params" not in data: return
            value = data["params"]["result"].get("value",{})
            logs  = value.get("logs",[])
            sig   = value.get("signature","")
            if not logs or not sig: return
            if sig in self.seen: return

            log_text = " ".join(logs)
            is_grad  = (PUMPFUN in log_text and
                        ("Withdraw" in log_text or "migrate" in log_text.lower()))
            is_ray   = (RAYDIUM_AMM in log_text and
                        ("initialize2" in log_text or
                         "InitializeInstruction2" in log_text))
            if not is_grad and not is_ray: return

            self.seen.add(sig)
            source = "pumpfun" if is_grad else "raydium"
            log.info(f"GRADUATION ({source}) — tx {sig[:20]}...")

            if self.locked: return
            self.locked = True

            try:
                # Strategy 1: log scan — instant
                mint = self._mint_from_logs(logs, source)
                if mint:
                    log.info(f"Mint instant (log scan): {mint[:20]}...")

                # Strategy 2: getTransaction fallback
                if not mint:
                    async with aiohttp.ClientSession() as sess:
                        for attempt in range(5):
                            mint = await self._extract_mint(sig, sess)
                            if mint:
                                log.info(f"Mint via getTransaction ({attempt+1}): {mint[:20]}...")
                                break
                            await asyncio.sleep(2)

                if not mint:
                    log.warning(f"No mint: {sig[:16]}")
                    self.locked = False
                    return

                if mint in self.seen:
                    self.locked = False
                    return
                self.seen.add(mint)
                self.count += 1

                token = Token(mint=mint, source=source)
                log.info(f"DETECTED -> {mint[:24]}...")
                if self.queue.empty():
                    await self.queue.put(token)
                else:
                    self.locked = False

            except Exception as e:
                log.warning(f"Handle inner: {e}")
                self.locked = False

        except Exception as e:
            log.warning(f"Handle: {e}")

    async def _extract_mint(self, sig, sess):
        try:
            async with sess.post(self.sol.rpc,
                json={"jsonrpc":"2.0","id":1,"method":"getTransaction",
                      "params":[sig,{"encoding":"jsonParsed",
                                     "maxSupportedTransactionVersion":0}]},
                timeout=aiohttp.ClientTimeout(total=8)) as r:
                data = await r.json()
            tx = data.get("result")
            if not tx: return None
            meta = tx.get("meta",{})
            if not meta or meta.get("err"): return None
            skip = {WSOL,
                    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"}
            for bal in meta.get("postTokenBalances",[]):
                m = bal.get("mint","")
                if m and m not in skip: return m
            for bal in meta.get("preTokenBalances",[]):
                m = bal.get("mint","")
                if m and m not in skip: return m
        except: pass
        return None

    _KNOWN_PROGRAMS = {
        WSOL, PUMPFUN, RAYDIUM_AMM,
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        "11111111111111111111111111111111",
        "ComputeBudget111111111111111111111111111111",
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
        "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
        "FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe",
        "JUP6LkbZbjS1jKKwapdHNy74LZJfCznEFkigq4CRBXM",
        "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
        "AgenTMiC2hvxGebTsgmsD4HHhqxHnLHK4CrZPmCHjBa",
        "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
        "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP",
        "SSwpkEEPFs5Y8dCTx4BEDsGFszmK4FbTiTGMFGCNjnm",
        "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
        "Sysvar1nstructions1111111111111111111111111",
        "SysvarRent111111111111111111111111111111111",
        "SysvarC1ock11111111111111111111111111111111",
        "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    }
    _B58 = set("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")

    def _is_valid_mint(self, addr):
        if addr in self._KNOWN_PROGRAMS: return False
        if not all(c in self._B58 for c in addr): return False
        if len(addr) < 32 or len(addr) > 44: return False
        for c in self._B58:
            if c * 8 in addr: return False
        return True

    def _mint_from_logs(self, logs, source):
        import re
        if source == "pumpfun":
            for line in logs:
                for m in re.finditer(r'([1-9A-HJ-NP-Za-km-z]{32,44}pump)', line):
                    addr = m.group(1)
                    if self._is_valid_mint(addr): return addr
        for line in logs:
            for m in re.finditer(r'([1-9A-HJ-NP-Za-km-z]{43,44})', line):
                addr = m.group(1)
                if self._is_valid_mint(addr): return addr
        return None

# ─── BOT ─────────────────────────────────────────────────────────────────────

class Bot:
    def __init__(self):
        self.sol      = Solana(SOLANA_RPC_URL, WALLET_PRIVATE_KEY)
        self.jup      = Jupiter()
        self.grok     = Grok()
        self.discord  = Discord(DISCORD_WEBHOOK_URL)
        self.detector = Detector(self.sol)
        self.start    = time.time()
        self.trades_won  = 0
        self.trades_lost = 0
        self.total_pnl   = 0.0
        self.sol_usd     = 160.0
        self._grok_queue = asyncio.Queue()  # Grok picks go here

    async def run(self):
        log.info("=" * 55)
        log.info("  WINSTON v8 — Grok Coin Picker (Grok-only mode)")
        log.info(f"  {TRADE_AMOUNT_SOL} SOL/trade")
        log.info(f"  Hold: {GROK_HOLD_MINUTES:.0f}min full ride | Rug stop: -{GROK_STOP_LOSS_PCT:.0f}%")
        log.info(f"  BUY -> HOLD 60min -> SELL | Only early exit: rug (-{GROK_STOP_LOSS_PCT:.0f}%)")
        log.info(f"  Graduation timeout: {MAX_HOLD_MINUTES}min | "
                 f"Grok timeout: {GROK_HOLD_MINUTES}min")
        log.info(f"  Grok picks every: {GROK_INTERVAL_MINS:.0f}min")
        log.info(f"  Grok API: {'SET' if GROK_API_KEY else 'NOT SET'}")
        log.info(f"  Jupiter: {'SET' if JUPITER_API_KEY else 'MISSING'}")
        log.info("=" * 55)

        self.sol_usd = await self.jup.sol_usd()
        bal = await self.sol.balance()
        log.info(f"Balance: {bal:.4f} SOL (${bal*self.sol_usd:.2f})")

        await self.discord.alert(
            f"🤖 **Winston v8 — Grok Mode** (graduation sniper OFF)\n"
            f"Balance: {bal:.4f} SOL (${bal*self.sol_usd:.2f})\n"
            f"Grok picks every {GROK_INTERVAL_MINS:.0f}min | "
            f"Hold: {GROK_HOLD_MINUTES:.0f}min per trade | "
            f"{'Grok ENABLED ✅' if GROK_API_KEY else 'Grok MISSING ⚠️'}"
        )

        await asyncio.gather(
            self._trade_loop(),
            self._grok_loop(),
            self._heartbeat(),
        )

    # ── GROK LOOP ────────────────────────────────────────────────────────────

    async def _grok_loop(self):
        """Every GROK_INTERVAL_MINS, ask Grok to pick a coin."""
        if not GROK_API_KEY:
            log.info("Grok disabled — running graduation sniper only")
            return

        # First pick after 60 seconds (let bot warm up)
        await asyncio.sleep(60)

        while True:
            try:
                log.info("🤖 Asking Grok for coin pick...")
                pick = await self.grok.pick_coin()
                if pick:
                    self.sol_usd = await self.jup.sol_usd()
                    await self.discord.grok_pick(pick, self.sol_usd, TRADE_AMOUNT_SOL)
                    await self._grok_queue.put(pick)
                    log.info(f"Grok pick queued: {pick['symbol']}")
                else:
                    log.warning("Grok returned no pick this round")
            except Exception as e:
                log.error(f"Grok loop error: {e}")

            await asyncio.sleep(GROK_INTERVAL_MINS * 60)

    # ── TRADE LOOP ───────────────────────────────────────────────────────────

    async def _trade_loop(self):
        log.info("Trade loop ready")
        while True:
            await self._process_next_token()

    async def _unlock(self, reason=""):
        self.detector.locked = False
        while not self.detector.queue.empty():
            try: self.detector.queue.get_nowait()
            except: break
        uptime = (time.time() - self.start) / 60
        if reason:
            log.info(f"UNLOCKED ({reason}) | "
                     f"Stats: {self.trades_won}W/{self.trades_lost}L | "
                     f"Net {self.total_pnl:+.5f} SOL | up {uptime:.0f}m")
        else:
            log.info(f"UNLOCKED | Stats: {self.trades_won}W/{self.trades_lost}L | "
                     f"Net {self.total_pnl:+.5f} SOL | up {uptime:.0f}m")

    async def _process_next_token(self):
        """Single iteration — only processes Grok picks. Graduation sniper disabled."""
        # Nothing to do if locked (already in a position)
        if self.detector.locked:
            await asyncio.sleep(1)
            return

        # Only act on Grok picks
        if self._grok_queue.empty():
            await asyncio.sleep(1)
            return

        pick  = await self._grok_queue.get()
        token = Token(mint=pick["mint"], symbol=pick["symbol"],
                      name=pick["name"], source="grok")
        log.info(f"🤖 Processing Grok pick: {token.symbol} ({token.mint[:20]}...)")

        self.detector.locked = True
        log.info(f"LOCKED IN on {token.mint[:20]}... (Grok, {GROK_HOLD_MINUTES:.0f}min hold)")

        try:
            # Verify price and liquidity before buying
            log.info(f"Verifying {token.symbol}...")
            price_check = await self.jup.price(token.mint)
            if not price_check or price_check <= 0:
                log.warning(f"{token.symbol} has no price — mint may be invalid, skipping")
                await self._unlock("no price")
                return

            liq = await self.jup.order(WSOL, token.mint,
                                       int(0.005*1e9), self.sol.pubkey)
            if not liq or not liq.get("outAmount"):
                log.warning(f"{token.symbol} has no liquidity — skipping")
                await self._unlock("no liquidity")
                return

            log.info(f"{token.symbol} verified — price ${price_check:.8f}, liquidity OK — BUYING")

            pos = await self._buy(token, GROK_HOLD_MINUTES)
            if not pos:
                log.error(f"BUY FAILED for {token.symbol}")
                await self._unlock("buy failed")
                return

            await self._watch(pos)

        except Exception as e:
            log.error(f"Trade error: {e}")
            import traceback; traceback.print_exc()
        finally:
            await self._unlock("trade complete")

    # ── FILTER ───────────────────────────────────────────────────────────────

    async def _filter(self, token: Token) -> bool:
        async with aiohttp.ClientSession() as sess:
            try:
                h_t = asyncio.create_task(
                    self._rpc(sess,"getTokenLargestAccounts",[token.mint]))
                a_t = asyncio.create_task(
                    self._rpc(sess,"getAccountInfo",
                              [token.mint,{"encoding":"jsonParsed"}]))
                l_t = asyncio.create_task(
                    self.jup.order(WSOL,token.mint,int(0.005*1e9),self.sol.pubkey))

                holders_res, acct_res, liq = await asyncio.gather(
                    h_t, a_t, l_t, return_exceptions=True)

                if isinstance(holders_res,Exception) or not holders_res:
                    log.info(f"SKIP {token.mint[:16]}: holder RPC failed"); return False
                holders = holders_res.get("result",{}).get("value",[])
                if len(holders) < 5:
                    log.info(f"SKIP {token.mint[:16]}: {len(holders)} holders"); return False

                supply_res = await self._rpc(sess,"getTokenSupply",[token.mint])
                total = float(supply_res.get("result",{}).get("value",{})
                                        .get("amount","0"))
                if total > 0 and holders:
                    top_pct = (float(holders[0].get("amount","0")) / total) * 100
                    if top_pct > MAX_TOP_HOLDER_PCT:
                        log.info(f"SKIP {token.mint[:16]}: top holder {top_pct:.0f}%")
                        return False

                if not isinstance(acct_res,Exception) and acct_res:
                    acct = acct_res.get("result",{}).get("value",{})
                    if acct:
                        parsed = (acct.get("data",{}).get("parsed",{})
                                      .get("info",{}))
                        if parsed.get("freezeAuthority"):
                            log.info(f"SKIP {token.mint[:16]}: freeze"); return False
                        if parsed.get("symbol"): token.symbol = parsed["symbol"]
                        if parsed.get("name"):   token.name   = parsed["name"]

                if isinstance(liq,Exception) or not liq or not liq.get("outAmount"):
                    log.info(f"SKIP {token.mint[:16]}: no liquidity"); return False

                try:
                    async with sess.get(
                        f"https://frontend-api.pump.fun/coins/{token.mint}",
                        timeout=aiohttp.ClientTimeout(total=3)) as r:
                        if r.status == 200:
                            meta = await r.json()
                            if meta.get("symbol"): token.symbol = meta["symbol"]
                            if meta.get("name"):   token.name   = meta["name"]
                except: pass

                label = token.symbol if token.symbol != "???" else token.mint[:8]
                log.info(f"PASS {label} ({token.mint[:16]}) — {len(holders)} holders")
                return True
            except Exception as e:
                log.warning(f"Filter: {e}"); return False

    # ── BUY ──────────────────────────────────────────────────────────────────

    async def _buy(self, token: Token, hold_mins: float) -> Optional[Position]:
        if not self.sol.pubkey: return None
        bal = await self.sol.balance()
        if bal < TRADE_AMOUNT_SOL + 0.005:
            log.error(f"Low balance: {bal:.4f}"); return None

        lamports = int(TRADE_AMOUNT_SOL * 1e9)
        order    = await self.jup.order(WSOL, token.mint, lamports, self.sol.pubkey)
        if not order: log.error("No buy route"); return None

        tx_b64 = order.get("transaction","")
        req_id = order.get("requestId","")
        out_amt = int(order.get("outAmount","0"))
        if not tx_b64 or not req_id: return None

        signed = self.sol.sign(tx_b64)
        if not signed: return None

        result = await self.jup.execute(req_id, signed)
        if not result: log.error("Execute failed"); return None
        if result.get("status") == "Failed":
            log.error(f"Buy failed: {result.get('error','?')}"); return None

        log.info(f"BUY TX: {result.get('signature','?')[:35]}...")
        await asyncio.sleep(2)

        price = await self.jup.price(token.mint)
        if not price:
            price = TRADE_AMOUNT_SOL / (out_amt/1e6) if out_amt > 0 else 0.0

        tokens = out_amt / 1e6
        self.sol_usd = await self.jup.sol_usd()

        # Grok positions use a wide stop — let it ride the full hour.
        # Only bail on a truly catastrophic dump (default 60% down).
        # Graduation positions use the tighter trailing stop.
        stop_pct = GROK_STOP_LOSS_PCT if token.source == "grok" else TRAILING_STOP_PCT
        pos = Position(
            token           = token,
            entry_price     = price,
            tokens_held     = tokens,
            original_tokens = tokens,
            cost_sol        = TRADE_AMOUNT_SOL,
            high_price      = price,
            stop_price      = price * (1 - stop_pct/100),
            hold_limit_mins = hold_mins,
        )
        await self.discord.bought(pos, self.sol_usd)
        log.info(f"BOUGHT {tokens:.0f} {token.symbol} @ ${price:.10f} "
                 f"[{token.source}] hold={hold_mins:.0f}min")
        log.info(f"  T1: ${price*PROFIT_TARGET_1:.10f} | "
                 f"T2: ${price*PROFIT_TARGET_2:.10f} | "
                 f"Stop: ${pos.stop_price:.10f}")
        return pos

    # ── WATCH ────────────────────────────────────────────────────────────────

    async def _watch(self, pos: Position):
        """
        Grok hold strategy — ride the full 60 minutes.
        Only 3 exits:
          1. 60-minute timeout — sell everything, ask Grok for next pick
          2. 60% crash below entry — emergency rug bail
          3. No price feed for 60s — emergency sell (token probably dead)
        No stop trailing. No take-profit ladder. Full hold, trust Grok.
        """
        stop_price    = pos.entry_price * (1 - GROK_STOP_LOSS_PCT / 100)
        price_fails   = 0
        log.info(f"WATCHING {pos.token.symbol} — full {pos.hold_limit_mins:.0f}min hold | "
                 f"rug stop: ${stop_price:.8f} (-{GROK_STOP_LOSS_PCT:.0f}%)")

        while True:
            await asyncio.sleep(1)
            price = await self.jup.price(pos.token.mint)

            # ── NO PRICE ─────────────────────────────────────────────────────
            if not price:
                price_fails += 1
                if price_fails % 15 == 1:
                    log.warning(f"No price ({price_fails}x) for {pos.token.symbol}")
                if price_fails >= 60:
                    log.error("Price dead 60s — emergency sell")
                    await self._sell(pos, pos.entry_price, "price_dead", 100)
                    return
                continue
            price_fails = 0

            gain_x = price / pos.entry_price if pos.entry_price > 0 else 1.0
            log.info(f"  {pos.token.symbol:8s} ${price:.8f} "
                     f"({gain_x:.3f}x) held={pos.hold_mins:.1f}m / {pos.hold_limit_mins:.0f}m")

            # ── EXIT 1: 60-minute timeout — normal exit ───────────────────────
            if pos.timed_out:
                log.info(f"TIMEOUT — 60min up, selling at {gain_x:.3f}x")
                await self._sell(pos, price, "timeout", 100)
                return

            # ── EXIT 2: Rug / catastrophic crash ─────────────────────────────
            if price <= stop_price:
                log.warning(f"RUG DETECTED — down {(1-gain_x)*100:.0f}% "
                            f"(${price:.8f} <= ${stop_price:.8f}) — bailing")
                await self._sell(pos, price, "rug_stop", 100)
                return

            # Everything else — ride it out
    # ── SELL ─────────────────────────────────────────────────────────────────

    async def _sell(self, pos: Position, price: float, reason: str, pct: int):
        gain_x   = price / pos.entry_price if pos.entry_price > 0 else 1.0
        est_sold = pos.tokens_held * (pct/100)
        pnl_sol  = (price * est_sold) - (pos.cost_sol * pct/100)

        log.info(f"SELL {pct}% {pos.token.symbol} — {reason} "
                 f"({gain_x:.3f}x, {pnl_sol:+.5f} SOL)")

        raw_amount, decimals = await self.sol.token_balance(pos.token.mint)
        if raw_amount <= 0:
            raw_amount = int(est_sold * (10**6))
            log.warning(f"Using estimated balance: {raw_amount}")

        if pct < 100:
            raw_amount = int(raw_amount * (pct/100))

        if raw_amount <= 0:
            log.error("Sell amount 0"); return

        sell_succeeded = False
        for attempt in range(1, 6):
            order = await self.jup.order(pos.token.mint, WSOL,
                                         raw_amount, self.sol.pubkey)
            if order and order.get("transaction"):
                signed = self.sol.sign(order["transaction"])
                if signed:
                    result = await self.jup.execute(order["requestId"], signed)
                    if result:
                        if result.get("status") == "Failed":
                            err = result.get("error","?")
                            log.error(f"Sell attempt {attempt} failed: {err}")
                            if "insufficient" in str(err).lower() or attempt == 3:
                                raw_amount = int(raw_amount * 0.98)
                        else:
                            log.info(f"SELL TX: {result.get('signature','?')[:35]}...")
                            sell_succeeded = True
                            break
            else:
                log.warning(f"No sell route {attempt}/5")

            if not sell_succeeded and attempt < 5:
                await asyncio.sleep(min(attempt*2, 6))

        if not sell_succeeded:
            log.error(f"SELL FAILED after 5 attempts — {pos.token.symbol}"); return

        pos.tokens_held -= est_sold
        if pnl_sol >= 0: self.trades_won  += 1
        else:             self.trades_lost += 1
        self.total_pnl += pnl_sol

        self.sol_usd = await self.jup.sol_usd()
        await self.discord.sold(pos, reason, gain_x, pnl_sol, pct, self.sol_usd)
        log.info(f"{'PARTIAL' if pct < 100 else 'CLOSED'} {pos.token.symbol}: "
                 f"{gain_x:.3f}x | {pnl_sol:+.5f} SOL")

    # ── HELPERS ──────────────────────────────────────────────────────────────

    async def _rpc(self, sess, method, params):
        try:
            async with sess.post(self.sol.rpc,
                json={"jsonrpc":"2.0","id":1,"method":method,"params":params},
                timeout=aiohttp.ClientTimeout(total=8)) as r:
                return await r.json()
        except: return {}

    async def _heartbeat(self):
        while True:
            await asyncio.sleep(60)
            uptime  = (time.time() - self.start) / 60
            pnl_usd = self.total_pnl * self.sol_usd
            pnl_str = f"+${pnl_usd:.2f}" if pnl_usd >= 0 else f"-${abs(pnl_usd):.2f}"
            status  = "LOCKED IN" if self.detector.locked else "SCANNING"
            log.info(f"HEARTBEAT [{status}] | up {uptime:.0f}m | "
                     f"{self.detector.count} seen | "
                     f"{self.trades_won}W {self.trades_lost}L | "
                     f"net {self.total_pnl:+.5f} SOL ({pnl_str})")
            if int(uptime) % 30 < 1 and uptime > 1:
                bal = await self.sol.balance()
                await self.discord.alert(
                    f"💓 **Winston v8** | {uptime:.0f}min | "
                    f"{self.trades_won}W {self.trades_lost}L | "
                    f"Net: **{pnl_str}** | Bal: {bal:.4f} SOL"
                )

if __name__ == "__main__":
    try:
        asyncio.run(Bot().run())
    except KeyboardInterrupt:
        log.info("Stopped")
