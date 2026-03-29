"""
WINSTON v2.0 — Multi-Position Grok Sniper
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Core design:
  - Grok is the SOLE decision maker for every trade
  - $2 per buy, up to 5 concurrent positions
  - Grok scores each candidate 1-100 — only buys if score >= GROK_MIN_SCORE
  - Grok picks from live Dexscreener data every SCAN_INTERVAL_MINS
  - Per-position exit ladder: +15% sell 50%, +25% sell 25%, +40% sell rest
  - Stop loss: -7% immediate full exit
  - Dead coin detection, volume dry-up exit
  - All logging goes to Discord
"""

import asyncio
import json
import time
import logging
import os
import base64 as b64
from dataclasses import dataclass, field
from typing import Optional

import aiohttp

# ─── CONFIG ──────────────────────────────────────────────────────────────────

TRADE_AMOUNT_SOL     = float(os.getenv("TRADE_AMOUNT_SOL",    "0.012"))   # ~$2 at ~$165/SOL
MAX_POSITIONS        = int(os.getenv("MAX_POSITIONS",         "5"))
SCAN_INTERVAL_MINS   = float(os.getenv("SCAN_INTERVAL_MINS",  "5"))       # how often to look for new picks
GROK_MIN_SCORE       = int(os.getenv("GROK_MIN_SCORE",        "75"))      # min score to buy
SLIPPAGE_BPS         = int(os.getenv("SLIPPAGE_BPS",          "1000"))
MAX_HOLD_MINUTES     = float(os.getenv("MAX_HOLD_MINUTES",    "30"))      # bail after 30min if nothing happens

# Quick-flip exit — take small profit fast and dip
TP1_PCT              = float(os.getenv("TP1_PCT",             "8"))       # +8%  → sell 100% and dip
STOP_LOSS_PCT        = float(os.getenv("STOP_LOSS_PCT",       "7"))       # -7%  → sell 100% immediately

# Minimum hold before ANY exit (stop loss always active)
MIN_HOLD_SECS        = float(os.getenv("MIN_HOLD_SECS",       "90"))      # 1.5 min minimum

# Momentum exit — if rocket stalls after entry, don't wait around
STALL_MINUTES        = float(os.getenv("STALL_MINUTES",       "5"))       # 5min flat after entry = dip

# Dead coin
DEAD_PRICE_STRIKES   = int(os.getenv("DEAD_PRICE_STRIKES",   "5"))

# Anti-rug
MAX_TOP_HOLDER_PCT   = float(os.getenv("MAX_TOP_HOLDER_PCT",  "35"))

# Env — credentials
DISCORD_WEBHOOK_URL  = os.getenv("DISCORD_WEBHOOK_URL", "")
SOLANA_RPC_URL       = os.getenv("SOLANA_RPC_URL",      "")
WALLET_PRIVATE_KEY   = os.getenv("WALLET_PRIVATE_KEY",  "")
JUPITER_API_KEY      = os.getenv("JUPITER_API_KEY",     "")
GROK_API_KEY         = os.getenv("GROK_API_KEY",        "")
BIRDEYE_API_KEY      = os.getenv("BIRDEYE_API_KEY",     "")

WSOL        = "So11111111111111111111111111111111111111112"
PUMPFUN     = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
RAYDIUM_AMM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"

JUP_ORDER   = "https://api.jup.ag/swap/v2/order"
JUP_EXECUTE = "https://api.jup.ag/swap/v2/execute"
JUP_PRICE   = "https://api.jup.ag/price/v2"
GROK_URL    = "https://api.x.ai/v1/chat/completions"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(message)s",
    datefmt="%H:%M:%S"
)
log = logging.getLogger("winston")

# ─── MODELS ──────────────────────────────────────────────────────────────────

@dataclass
class Token:
    mint:   str
    symbol: str = "???"
    name:   str = "Unknown"
    source: str = ""

@dataclass
class Position:
    token:           Token
    entry_price:     float = 0.0
    tokens_held:     float = 0.0
    original_tokens: float = 0.0
    cost_sol:        float = 0.0
    high_price:      float = 0.0
    opened_ts:       float = 0.0
    grok_score:      int   = 0
    grok_reason:     str   = ""

    # Dead coin detection
    _last_price:      float = 0.0
    _same_count:      int   = 0

    # Stall detection
    _stall_start:     float = 0.0
    _last_move_price: float = 0.0

    def __post_init__(self):
        if not self.opened_ts:
            self.opened_ts = time.time()
        if not self.original_tokens:
            self.original_tokens = self.tokens_held

    @property
    def hold_secs(self):  return time.time() - self.opened_ts
    @property
    def hold_mins(self):  return self.hold_secs / 60
    @property
    def timed_out(self):  return self.hold_mins >= MAX_HOLD_MINUTES

    def pnl_estimate(self, price: float) -> float:
        return (price * self.tokens_held) - self.cost_sol

# ─── GROK ────────────────────────────────────────────────────────────────────

class Grok:
    """
    Fetches live Dexscreener data, passes up to 20 candidates to Grok,
    Grok scores each one 1-100 and returns BUY/SKIP with reasoning.
    Only tokens scoring >= GROK_MIN_SCORE get traded.
    """

    async def _fetch_candidates(self, exclude_mints: set) -> list:
        """Pull trending/new Solana tokens from multiple Dexscreener endpoints."""
        import time as _t
        mints = []

        async def _get_json(url):
            try:
                async with aiohttp.ClientSession() as sess:
                    async with sess.get(url, timeout=aiohttp.ClientTimeout(total=12)) as r:
                        if r.status == 200:
                            return await r.json()
            except Exception as e:
                log.debug(f"Fetch {url[:50]}: {e}")
            return None

        # 1. Boosted/trending tokens
        data = await _get_json("https://api.dexscreener.com/token-boosts/top/v1")
        if data:
            mints += [
                i.get("tokenAddress", "") for i in (data if isinstance(data, list) else [])
                if i.get("chainId") == "solana" and i.get("tokenAddress", "")
            ][:30]

        # 2. Latest boosts (different from top — catches newer ones)
        data = await _get_json("https://api.dexscreener.com/token-boosts/latest/v1")
        if data:
            for i in (data if isinstance(data, list) else []):
                if i.get("chainId") == "solana":
                    m = i.get("tokenAddress", "")
                    if m and m not in mints:
                        mints.append(m)

        # 3. Trending pairs by volume on Solana
        data = await _get_json("https://api.dexscreener.com/latest/dex/search/?q=SOL")
        if data:
            for pair in (data.get("pairs") or [])[:40]:
                if pair.get("chainId") == "solana":
                    m = pair.get("baseToken", {}).get("address", "")
                    if m and m not in mints:
                        mints.append(m)

        # 4. Top gainers — pump.fun style new tokens with momentum
        data = await _get_json(
            "https://api.dexscreener.com/latest/dex/search/?q=pump"
        )
        if data:
            for pair in (data.get("pairs") or [])[:30]:
                if pair.get("chainId") == "solana":
                    m = pair.get("baseToken", {}).get("address", "")
                    if m and m not in mints:
                        mints.append(m)

        # Remove already-held mints
        mints = [m for m in mints if m not in exclude_mints]

        # Deduplicate
        seen = set()
        unique = []
        for m in mints:
            if m and len(m) >= 32 and m not in seen:
                seen.add(m)
                unique.append(m)
        mints = unique[:60]  # bigger pool = more for Grok to pick from

        log.info(f"Fetched {len(mints)} unique mints — pulling Dexscreener data...")

        candidates = []

        async with aiohttp.ClientSession() as sess:
            for mint in mints:
                try:
                    async with sess.get(
                        f"https://api.dexscreener.com/latest/dex/tokens/{mint}",
                        timeout=aiohttp.ClientTimeout(total=6)
                    ) as r:
                        if r.status != 200:
                            continue
                        d = await r.json()
                    pairs = d.get("pairs") or []
                    if not pairs:
                        continue
                    p = pairs[0]

                    base       = p.get("baseToken", {})
                    symbol     = base.get("symbol", "?")
                    name       = base.get("name", "?")
                    liquidity  = (p.get("liquidity") or {}).get("usd", 0) or 0
                    mcap       = p.get("marketCap", 0) or 0
                    v5m        = (p.get("volume") or {}).get("m5", 0) or 0
                    v1h        = (p.get("volume") or {}).get("h1", 0) or 0
                    v6h        = (p.get("volume") or {}).get("h6", 0) or 0
                    chg5m      = (p.get("priceChange") or {}).get("m5", 0) or 0
                    chg1h      = (p.get("priceChange") or {}).get("h1", 0) or 0
                    chg6h      = (p.get("priceChange") or {}).get("h6", 0) or 0
                    chg24h     = (p.get("priceChange") or {}).get("h24", 0) or 0
                    buys5m     = (p.get("txns") or {}).get("m5", {}).get("buys", 0) or 0
                    sells5m    = (p.get("txns") or {}).get("m5", {}).get("sells", 0) or 0
                    buys1h     = (p.get("txns") or {}).get("h1", {}).get("buys", 0) or 0
                    sells1h    = (p.get("txns") or {}).get("h1", {}).get("sells", 0) or 0
                    created_at = p.get("pairCreatedAt", 0) or 0
                    price_usd  = p.get("priceUsd", "0") or "0"
                    age_h      = (_t.time() - created_at / 1000) / 3600 if created_at > 0 else 9999

                    # Only hard filters — let Grok decide the rest
                    if liquidity < 8_000:
                        continue   # truly no liquidity
                    if chg24h > 500:
                        continue   # already 5x'd, too late
                    if v5m == 0 and v1h == 0:
                        continue   # completely dead, no trading at all

                    candidates.append({
                        "mint": mint, "symbol": symbol, "name": name,
                        "price_usd": price_usd, "age_hours": round(age_h, 1),
                        "liquidity": liquidity, "mcap": mcap,
                        "volume_5m": v5m, "volume_1h": v1h, "volume_6h": v6h,
                        "chg_5m": chg5m, "chg_1h": chg1h,
                        "chg_6h": chg6h, "chg_24h": chg24h,
                        "buys_5m": buys5m, "sells_5m": sells5m,
                        "buys_1h": buys1h, "sells_1h": sells1h,
                    })

                except Exception as e:
                    log.debug(f"Candidate {mint[:16]}: {e}")
                    continue

        # Sort by 5m volume descending — best momentum first
        candidates.sort(key=lambda x: x["volume_5m"], reverse=True)
        candidates = candidates[:25]  # send top 25 to Grok

        log.info(f"Passing {len(candidates)} candidates to Grok")
        return candidates

    async def score_candidates(self, candidates: list, current_positions: int) -> list:
        """
        Ask Grok to score each candidate 1-100.
        Returns list of dicts with mint + score + decision + reasoning,
        sorted by score descending.
        Only returns tokens with score >= GROK_MIN_SCORE.
        """
        if not GROK_API_KEY or not candidates:
            return [], []

        from datetime import datetime, timezone
        now_str = datetime.now(timezone.utc).strftime("%A, %B %d, %Y at %H:%M UTC")

        lines = []
        for i, c in enumerate(candidates, 1):
            lines.append(
                f"{i}. {c['symbol']} ({c['name']}) | "
                f"Age: {c['age_hours']}h | "
                f"Price: ${c['price_usd']} | "
                f"Liq: ${c['liquidity']:,.0f} | "
                f"MCap: ${c['mcap']:,.0f} | "
                f"Vol5m: ${c['volume_5m']:,.0f} | Vol1h: ${c['volume_1h']:,.0f} | "
                f"5m: {c['chg_5m']:+.1f}% | 1h: {c['chg_1h']:+.1f}% | "
                f"6h: {c['chg_6h']:+.1f}% | 24h: {c['chg_24h']:+.1f}% | "
                f"5m: {c['buys_5m']}B/{c['sells_5m']}S | "
                f"1h: {c['buys_1h']}B/{c['sells_1h']}S"
            )
        coin_list = "\n".join(lines)

        slots_free = MAX_POSITIONS - current_positions

        prompt = f"""Today is {now_str}. You are a Solana scalper hunting tokens that are LAUNCHING RIGHT NOW.

Strategy: Buy the rocket on the way up, take +{TP1_PCT:.0f}% profit, dip. In and out fast.
Stop loss: -{STOP_LOSS_PCT:.0f}%. Stall exit: {STALL_MINUTES:.0f}min flat. Max hold: {MAX_HOLD_MINUTES:.0f}min.

I have {slots_free} open slots.

LIVE DATA ({len(candidates)} tokens):
{coin_list}

━━━ WHAT I'M HUNTING ━━━

🎯 PERFECT SETUP (score 85-100):
- Token is skyrocketing RIGHT NOW — 5m price up big (+5% to +30%)
- Volume in 5m is HIGH relative to market cap (token is actively being bought)
- Buys crushing sells in 5m (3:1 or better ratio)
- Less than 24h old preferred — fresh launches have the most explosive moves
- Not already up 300%+ in 24h (don't chase exhausted pumps)

✅ GOOD SETUP (score 75-84):
- 5m price positive (+2% to +5%)
- Buys > sells in 5m
- Some volume activity

❌ DO NOT BUY — score these below 70:
- 5m price is flat or negative (momentum is gone or reversing)
- Sells > buys in 5m (distribution, not accumulation)
- Zero 5m volume (nobody is trading it right now)
- Already pumped huge and now showing weakness

━━━ SCORING RULE ━━━
A token MUST show positive 5m price movement to score >= {GROK_MIN_SCORE}.
If 5m price is 0% or negative → max score is 65, no exceptions.
I'd rather miss a trade than buy something already turning.

RETURN ONLY valid JSON, no markdown:
{{
  "analysis": [
    {{
      "number": <1-{len(candidates)}>,
      "symbol": "<symbol>",
      "score": <1-100>,
      "decision": "BUY" or "SKIP",
      "confidence": "high" or "medium" or "low",
      "reason": "<5m%: X, buys/sells: X/X, vol5m: $X — is it launching or stalling?>"
    }}
  ]
}}

Score ALL {len(candidates)} tokens. Approve any that show active launch momentum."""

        try:
            async with aiohttp.ClientSession() as sess:
                async with sess.post(
                    GROK_URL,
                    headers={"Authorization": f"Bearer {GROK_API_KEY}",
                             "Content-Type": "application/json"},
                    json={"model": "grok-3",
                          "messages": [{"role": "user", "content": prompt}],
                          "max_tokens": 4000,
                          "temperature": 0.3},
                    timeout=aiohttp.ClientTimeout(total=45)
                ) as r:
                    if r.status != 200:
                        log.error(f"Grok API {r.status}: {(await r.text())[:200]}")
                        return [], []
                    data = await r.json()

            raw = data["choices"][0]["message"]["content"].strip()
            log.debug(f"Grok raw: {raw[:500]}")

            # Strip markdown if present
            if "```" in raw:
                raw = raw.split("```")[1]
                if raw.startswith("json"):
                    raw = raw[4:]
            raw = raw.strip()

            parsed = json.loads(raw)
            analysis = parsed.get("analysis", [])

            results = []
            skipped = []
            for item in analysis:
                n = int(item.get("number", 1)) - 1
                if n < 0 or n >= len(candidates):
                    continue
                score    = int(item.get("score", 0))
                decision = item.get("decision", "SKIP")
                conf     = item.get("confidence", "low")
                reason   = item.get("reason", "")
                symbol   = item.get("symbol", candidates[n]["symbol"])

                log.info(f"  [{score:3d}] {symbol:12s} → {decision:4s} ({conf}) | {reason[:80]}")

                entry = {
                    "mint":       candidates[n]["mint"],
                    "symbol":     candidates[n]["symbol"],
                    "name":       candidates[n]["name"],
                    "score":      score,
                    "confidence": conf,
                    "reason":     reason,
                    "data":       candidates[n],
                }
                if decision == "BUY" and score >= GROK_MIN_SCORE:
                    results.append(entry)
                else:
                    skipped.append(entry)

            results.sort(key=lambda x: x["score"], reverse=True)
            log.info(f"Grok approved {len(results)}/{len(candidates)} tokens for buying")
            return results, skipped

        except json.JSONDecodeError as e:
            log.error(f"Grok JSON parse error: {e}")
            # Try to salvage partial response — extract complete objects before truncation
            try:
                partial = []
                for line in raw.split("\n"):
                    line = line.strip()
                    if not line or line in ("{", "}", "[", "]", ","): continue
                    # Look for complete score lines we can extract manually
                import re
                for m in re.finditer(
                    r'\{[^{}]*"number"\s*:\s*(\d+)[^{}]*"score"\s*:\s*(\d+)[^{}]*"decision"\s*:\s*"(\w+)"[^{}]*"confidence"\s*:\s*"(\w+)"[^{}]*"reason"\s*:\s*"([^"]{0,300})"[^{}]*\}',
                    raw, re.DOTALL
                ):
                    n      = int(m.group(1)) - 1
                    score  = int(m.group(2))
                    dec    = m.group(3)
                    conf   = m.group(4)
                    reason = m.group(5)
                    if 0 <= n < len(candidates):
                        partial.append({
                            "mint":       candidates[n]["mint"],
                            "symbol":     candidates[n]["symbol"],
                            "name":       candidates[n]["name"],
                            "score":      score,
                            "confidence": conf,
                            "reason":     reason,
                            "data":       candidates[n],
                        })
                if partial:
                    approved = [x for x in partial if x["score"] >= GROK_MIN_SCORE and
                                # re-check decision from raw if possible
                                True]
                    skipped  = [x for x in partial if x["score"] < GROK_MIN_SCORE]
                    log.info(f"Partial parse rescued {len(partial)} scores ({len(approved)} buys)")
                    return approved, skipped
            except Exception as pe:
                log.debug(f"Partial parse also failed: {pe}")
        except Exception as e:
            log.error(f"Grok score error: {e}")
        return [], []

# ─── JUPITER ─────────────────────────────────────────────────────────────────

class Jupiter:
    def _headers(self):
        h = {"Content-Type": "application/json"}
        if JUPITER_API_KEY:
            h["x-api-key"] = JUPITER_API_KEY
        return h

    async def _sess(self):
        try:
            from aiohttp.resolver import AsyncResolver
            conn = aiohttp.TCPConnector(
                resolver=AsyncResolver(nameservers=["8.8.8.8", "1.1.1.1"]),
                ssl=False, limit=20)
        except:
            conn = aiohttp.TCPConnector(ssl=False, limit=20)
        return aiohttp.ClientSession(connector=conn, headers=self._headers())

    async def price(self, mint) -> Optional[float]:
        # Primary: Jupiter Price API
        s = await self._sess()
        try:
            async with s.get(f"{JUP_PRICE}?ids={mint}",
                             timeout=aiohttp.ClientTimeout(total=4)) as r:
                if r.status == 200:
                    d = await r.json()
                    p = d.get("data", {}).get(mint, {}).get("price")
                    if p:
                        return float(p)
        except:
            pass
        finally:
            await s.close()

        # Fallback: Dexscreener
        try:
            async with aiohttp.ClientSession() as sess:
                async with sess.get(
                    f"https://api.dexscreener.com/latest/dex/tokens/{mint}",
                    timeout=aiohttp.ClientTimeout(total=5)
                ) as r:
                    if r.status == 200:
                        d = await r.json()
                        pairs = d.get("pairs") or []
                        if pairs:
                            p = pairs[0].get("priceUsd")
                            if p:
                                return float(p)
        except:
            pass

        return None

    async def sol_usd(self) -> float:
        s = await self._sess()
        try:
            async with s.get(f"{JUP_PRICE}?ids={WSOL}",
                             timeout=aiohttp.ClientTimeout(total=5)) as r:
                if r.status == 200:
                    d = await r.json()
                    p = d.get("data", {}).get(WSOL, {}).get("price")
                    if p:
                        return float(p)
        except:
            pass
        finally:
            await s.close()
        return 165.0

    async def order(self, inp, out, amount, taker):
        s = await self._sess()
        try:
            async with s.get(JUP_ORDER,
                params={"inputMint": inp, "outputMint": out,
                        "amount": str(amount), "taker": taker,
                        "slippageBps": str(SLIPPAGE_BPS)},
                timeout=aiohttp.ClientTimeout(total=12)) as r:
                if r.status == 200:
                    return await r.json()
                log.error(f"Jup order {r.status}: {(await r.text())[:200]}")
        except Exception as e:
            log.error(f"Jup order: {e}")
        finally:
            await s.close()
        return None

    async def execute(self, req_id, signed_b64):
        s = await self._sess()
        try:
            async with s.post(JUP_EXECUTE,
                json={"signedTransaction": signed_b64, "requestId": req_id},
                timeout=aiohttp.ClientTimeout(total=30)) as r:
                if r.status == 200:
                    return await r.json()
                log.error(f"Jup exec {r.status}: {(await r.text())[:200]}")
        except Exception as e:
            log.error(f"Jup exec: {e}")
        finally:
            await s.close()
        return None

# ─── SOLANA ──────────────────────────────────────────────────────────────────

class Solana:
    def __init__(self, rpc, pk):
        self.rpc     = rpc
        self.keypair = self.pubkey = None
        if pk:
            try:
                from solders.keypair import Keypair
                import base58
                self.keypair = Keypair.from_bytes(base58.b58decode(pk))
                self.pubkey  = str(self.keypair.pubkey())
                log.info(f"Wallet: {self.pubkey[:8]}...{self.pubkey[-4:]}")
            except Exception as e:
                log.error(f"Wallet init: {e}")

    async def balance(self) -> float:
        if not self.pubkey:
            return 0.0
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(self.rpc,
                    json={"jsonrpc": "2.0", "id": 1, "method": "getBalance",
                          "params": [self.pubkey]},
                    timeout=aiohttp.ClientTimeout(total=10)) as r:
                    d = await r.json()
                    return d.get("result", {}).get("value", 0) / 1e9
        except:
            return 0.0

    async def token_balance(self, mint) -> tuple:
        if not self.pubkey:
            return 0, 6
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(self.rpc,
                    json={"jsonrpc": "2.0", "id": 1,
                          "method": "getTokenAccountsByOwner",
                          "params": [self.pubkey, {"mint": mint},
                                     {"encoding": "jsonParsed"}]},
                    timeout=aiohttp.ClientTimeout(total=10)) as r:
                    data = await r.json()
            for acct in data.get("result", {}).get("value", []):
                info = (acct.get("account", {}).get("data", {})
                            .get("parsed", {}).get("info", {}))
                ta  = info.get("tokenAmount", {})
                raw = int(ta.get("amount", 0))
                dec = int(ta.get("decimals", 6))
                if raw > 0:
                    return raw, dec
        except Exception as e:
            log.error(f"token_balance: {e}")
        return 0, 6

    async def top_holder_pct(self, mint) -> float:
        """Returns top holder % of supply. Returns 0 if unavailable."""
        try:
            async with aiohttp.ClientSession() as s:
                h_r = await self._rpc(s, "getTokenLargestAccounts", [mint])
                s_r = await self._rpc(s, "getTokenSupply", [mint])
            holders = h_r.get("result", {}).get("value", [])
            total   = float(s_r.get("result", {}).get("value", {}).get("amount", "0"))
            if total > 0 and holders:
                top = float(holders[0].get("amount", "0"))
                return (top / total) * 100
        except:
            pass
        return 0.0

    async def has_freeze_authority(self, mint) -> bool:
        try:
            async with aiohttp.ClientSession() as s:
                data = await self._rpc(s, "getAccountInfo",
                                       [mint, {"encoding": "jsonParsed"}])
            parsed = (data.get("result", {}).get("value", {})
                          .get("data", {}).get("parsed", {}).get("info", {}))
            return bool(parsed.get("freezeAuthority"))
        except:
            return False

    def sign(self, tx_b64):
        if not self.keypair:
            return None
        try:
            from solders.transaction import VersionedTransaction
            raw    = b64.b64decode(tx_b64)
            txn    = VersionedTransaction.from_bytes(raw)
            signed = VersionedTransaction(txn.message, [self.keypair])
            return b64.b64encode(bytes(signed)).decode()
        except Exception as e:
            log.error(f"Sign: {e}")
            return None

    async def _rpc(self, sess, method, params):
        try:
            async with sess.post(self.rpc,
                json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
                timeout=aiohttp.ClientTimeout(total=8)) as r:
                return await r.json()
        except:
            return {}

# ─── DISCORD ─────────────────────────────────────────────────────────────────

class Discord:
    def __init__(self, url):
        self.url = url

    async def send(self, payload):
        if not self.url:
            return
        for attempt in range(3):
            try:
                async with aiohttp.ClientSession() as s:
                    r = await s.post(self.url, json=payload,
                                     timeout=aiohttp.ClientTimeout(total=10))
                    await r.release()
                    return
            except Exception as e:
                if attempt == 2:
                    log.debug(f"Discord send: {e}")
                await asyncio.sleep(1)

    async def startup(self, bal: float, sol_usd: float):
        usd = bal * sol_usd
        await self.send({"embeds": [{
            "title": "🤖 WINSTON v2.0 — ONLINE",
            "color": 0x00FF88,
            "description": (
                f"Balance: **{bal:.4f} SOL** (${usd:.2f}) | "
                f"Trade size: **{TRADE_AMOUNT_SOL} SOL** (~${TRADE_AMOUNT_SOL*sol_usd:.2f}) | "
                f"Max: **{MAX_POSITIONS} positions** | "
                f"Scan every **{SCAN_INTERVAL_MINS:.0f} min**\n"
                f"Exit: +{TP1_PCT:.0f}% full exit | Stop: -{STOP_LOSS_PCT:.0f}% | Stall: {STALL_MINUTES:.0f}min | Max hold: {MAX_HOLD_MINUTES:.0f}min"
            )
        }]})

    async def grok_results(self, approved: list, skipped: list, total: int):
        """Post one clean summary of what Grok decided this scan."""
        buy_lines  = []
        skip_lines = []

        for item in approved:
            d = item.get("data", {})
            buy_lines.append(
                f"✅ **{item['symbol']}** [{item['score']}/100] {item['confidence'].upper()}\n"
                f"  ↳ {item['reason'][:160]}"
            )

        for item in skipped[:8]:  # cap skip list at 8
            skip_lines.append(
                f"⏭ {item['symbol']} [{item['score']}/100] — {item['reason'][:80]}"
            )

        desc = ""
        if buy_lines:
            desc += "\n".join(buy_lines)
        else:
            desc += "_No buys this round_"

        if skip_lines:
            desc += "\n\n**Skipped:**\n" + "\n".join(skip_lines)

        await self.send({"embeds": [{
            "title": f"🤖 Grok Scan — {len(approved)} BUY / {total - len(approved)} SKIP",
            "color": 0xAA00FF if approved else 0x555555,
            "description": desc[:3900]
        }]})

    async def bought(self, pos: "Position", sol_usd: float):
        label = pos.token.symbol if pos.token.symbol != "???" else pos.token.mint[:8]
        await self.send({"embeds": [{
            "title": f"🚀 IN — {label} [{pos.grok_score}/100]",
            "color": 0x00AAFF,
            "description": (
                f"_{pos.grok_reason[:200]}_\n\n"
                f"Entry: **${pos.entry_price:.8f}** | **{pos.cost_sol:.4f} SOL** (${pos.cost_sol*sol_usd:.2f})\n"
                f"Target: +{TP1_PCT:.0f}% → **${pos.entry_price*(1+TP1_PCT/100):.8f}** (full exit)\n"
                f"Stop: -{STOP_LOSS_PCT:.0f}% → **${pos.entry_price*(1-STOP_LOSS_PCT/100):.8f}**\n"
                f"Stall exit: {STALL_MINUTES:.0f}min flat | Timeout: {MAX_HOLD_MINUTES:.0f}min"
            ),
            "fields": [{
                "name": "Chart",
                "value": f"[Dex](https://dexscreener.com/solana/{pos.token.mint}) | [Solscan](https://solscan.io/token/{pos.token.mint})",
                "inline": False
            }]
        }]})

    async def sold(self, pos: "Position", reason: str, gain_pct: float,
                   pnl_sol: float, pct_sold: int, sol_usd: float, price: float):
        label     = pos.token.symbol if pos.token.symbol != "???" else pos.token.mint[:8]
        is_profit = pnl_sol >= 0
        color     = 0x00FF88 if is_profit else 0xFF4444
        emoji     = "✅" if is_profit else "❌"
        pnl_str   = f"+{pnl_sol:.5f} SOL (+${abs(pnl_sol)*sol_usd:.2f})" if is_profit \
                    else f"{pnl_sol:.5f} SOL (-${abs(pnl_sol)*sol_usd:.2f})"

        reason_map = {
            "tp1":        f"🎯 +{TP1_PCT:.0f}% target hit — profit taken",
            "stop_loss":  f"🛑 Stop loss -{STOP_LOSS_PCT:.0f}%",
            "timeout":    f"⏰ {MAX_HOLD_MINUTES:.0f}min timeout",
            "stall":      f"😴 Stalled {STALL_MINUTES:.0f}min — no move",
            "price_dead": "📡 No price feed",
        }

        await self.send({"embeds": [{
            "title": f"{emoji} OUT — {label} [{gain_pct:+.1f}%]",
            "color": color,
            "description": (
                f"**{pnl_str}**\n"
                f"{reason_map.get(reason, reason)} | "
                f"held {pos.hold_secs:.0f}s | score: {pos.grok_score}/100"
            )
        }]})

    async def heartbeat(self, positions: list, stats: dict, bal: float, sol_usd: float):
        """Hourly summary — open positions + running totals."""
        pos_lines = []
        for p in positions:
            label  = p.token.symbol if p.token.symbol != "???" else p.token.mint[:8]
            cached = stats.get(f"price_{p.token.mint}", p.entry_price)
            gain   = ((cached / p.entry_price) - 1) * 100 if p.entry_price > 0 else 0
            pos_lines.append(
                f"• **{label}** {gain:+.1f}% | {p.hold_mins:.0f}min | {p.grok_score}/100"
            )

        pnl_usd = stats["total_pnl"] * sol_usd
        pnl_str = f"+${pnl_usd:.2f}" if pnl_usd >= 0 else f"-${abs(pnl_usd):.2f}"

        desc = (
            f"**{stats['wins']}W / {stats['losses']}L** | Net: **{pnl_str}** | "
            f"Bal: {bal:.4f} SOL | Up: {stats['uptime_mins']:.0f}min\n"
            f"Positions: **{len(positions)}/{MAX_POSITIONS}**\n"
        )
        if pos_lines:
            desc += "\n".join(pos_lines)
        else:
            desc += "_No open positions_"

        await self.send({"embeds": [{
            "title": "💓 Winston v2.0",
            "color": 0x444444,
            "description": desc
        }]})

# ─── ANTI-RUG ────────────────────────────────────────────────────────────────

class AntiRug:
    def __init__(self, sol: Solana, jup: Jupiter):
        self.sol = sol
        self.jup = jup

    async def check(self, token: Token) -> tuple:
        """
        Returns (passed: bool, reason: str)
        Quick checks before buying.
        """
        # Check 1: freeze authority
        if await self.sol.has_freeze_authority(token.mint):
            return False, "freeze authority active"

        # Check 2: top holder concentration
        top_pct = await self.sol.top_holder_pct(token.mint)
        if top_pct > MAX_TOP_HOLDER_PCT:
            return False, f"top holder owns {top_pct:.0f}%"

        # Check 3: liquidity probe (can we actually buy?)
        probe = await self.jup.order(WSOL, token.mint,
                                     int(0.005 * 1e9), self.sol.pubkey)
        if not probe or not probe.get("outAmount"):
            return False, "no liquidity / no buy route"

        return True, "ok"

# ─── BOT ─────────────────────────────────────────────────────────────────────

class Bot:
    def __init__(self):
        self.sol      = Solana(SOLANA_RPC_URL, WALLET_PRIVATE_KEY)
        self.jup      = Jupiter()
        self.grok     = Grok()
        self.discord  = Discord(DISCORD_WEBHOOK_URL)
        self.antirug  = AntiRug(self.sol, self.jup)

        self.positions: list[Position] = []
        self.held_mints: set  = set()  # mints currently held
        self.scanned_mints: set = set() # mints skipped this session (avoid re-scanning)

        self.start_ts      = time.time()
        self.sol_usd       = 165.0
        self.wins          = 0
        self.losses        = 0
        self.total_pnl     = 0.0

        # For price polling each position
        self._price_cache: dict = {}  # mint -> (price, ts)

    # ─── MAIN ENTRY ──────────────────────────────────────────────────────────

    async def run(self):
        log.info("=" * 60)
        log.info("  WINSTON v2.0 — Multi-Position Grok Sniper")
        log.info(f"  Trade size: {TRADE_AMOUNT_SOL} SOL per position")
        log.info(f"  Max positions: {MAX_POSITIONS}")
        log.info(f"  Grok min score: {GROK_MIN_SCORE}/100")
        log.info(f"  Scan every: {SCAN_INTERVAL_MINS} min")
        log.info(f"  Target: +{TP1_PCT}% full exit | Stop: -{STOP_LOSS_PCT}% | Stall: {STALL_MINUTES}min | Max hold: {MAX_HOLD_MINUTES}min")
        log.info(f"  Grok: {'✅ ENABLED' if GROK_API_KEY else '❌ NOT SET'}")
        log.info("=" * 60)

        self.sol_usd = await self.jup.sol_usd()
        bal          = await self.sol.balance()
        log.info(f"Balance: {bal:.4f} SOL (${bal*self.sol_usd:.2f})")

        await self.discord.startup(bal, self.sol_usd)

        await asyncio.gather(
            self._scan_loop(),
            self._watch_loop(),
            self._heartbeat_loop(),
        )

    # ─── SCAN LOOP ───────────────────────────────────────────────────────────

    async def _scan_loop(self):
        """Periodically ask Grok to score candidates and open new positions."""
        # First scan after 30s warmup
        await asyncio.sleep(30)

        while True:
            try:
                await self._do_scan()
            except Exception as e:
                log.error(f"Scan loop error: {e}")
                import traceback; traceback.print_exc()

            await asyncio.sleep(SCAN_INTERVAL_MINS * 60)

    async def _do_scan(self):
        """One full scan: fetch candidates → Grok scores → buy approved."""
        open_slots = MAX_POSITIONS - len(self.positions)
        if open_slots <= 0:
            log.info(f"All {MAX_POSITIONS} slots full — skipping scan")
            return

        log.info(f"=== SCAN START | {len(self.positions)}/{MAX_POSITIONS} positions open ===")

        # Fetch candidates, excluding mints we already hold
        candidates = await self.grok._fetch_candidates(self.held_mints)
        if not candidates:
            log.warning("No candidates found this scan")
            return

        # Ask Grok to score them
        log.info(f"Sending {len(candidates)} candidates to Grok...")
        approved, skipped = await self.grok.score_candidates(candidates, len(self.positions))

        await self.discord.grok_results(approved, skipped, len(candidates))

        if not approved:
            log.info("Grok approved nothing — no trades this round")
            return

        # Buy approved tokens, up to open_slots
        bought = 0
        for item in approved:
            if bought >= open_slots:
                break
            if len(self.positions) >= MAX_POSITIONS:
                break
            if item["mint"] in self.held_mints:
                continue

            success = await self._open_position(item)
            if success:
                bought += 1
                await asyncio.sleep(2)

        log.info(f"=== SCAN END | bought {bought} | {len(self.positions)}/{MAX_POSITIONS} positions ===")

    # ─── OPEN POSITION ───────────────────────────────────────────────────────

    async def _open_position(self, grok_item: dict) -> bool:
        mint   = grok_item["mint"]
        symbol = grok_item.get("symbol", "???")
        score  = grok_item.get("score", 0)
        reason = grok_item.get("reason", "")

        # Balance check
        bal = await self.sol.balance()
        needed = TRADE_AMOUNT_SOL + 0.005
        if bal < needed:
            log.error(f"Insufficient balance: {bal:.4f} SOL (need {needed:.4f})")
            return False

        token = Token(mint=mint, symbol=symbol,
                      name=grok_item.get("name", ""), source="grok")

        log.info(f"Anti-rug check for {symbol}...")
        passed, rug_reason = await self.antirug.check(token)
        if not passed:
            log.warning(f"SKIP {symbol}: anti-rug — {rug_reason}")
            return False

        # Get entry price
        price = await self.jup.price(mint)
        if not price or price <= 0:
            log.warning(f"SKIP {symbol}: no price")
            return False

        # Execute buy
        lamports = int(TRADE_AMOUNT_SOL * 1e9)
        order    = await self.jup.order(WSOL, mint, lamports, self.sol.pubkey)
        if not order:
            log.error(f"No buy route for {symbol}")
            return False

        tx_b64 = order.get("transaction", "")
        req_id = order.get("requestId", "")
        out_amt = int(order.get("outAmount", "0"))
        if not tx_b64 or not req_id:
            return False

        signed = self.sol.sign(tx_b64)
        if not signed:
            return False

        result = await self.jup.execute(req_id, signed)
        if not result:
            log.error(f"Execute failed for {symbol}")
            return False
        if result.get("status") == "Failed":
            log.error(f"Buy failed for {symbol}: {result.get('error', '?')}")
            return False

        log.info(f"BUY TX: {result.get('signature', '?')[:40]}...")
        await asyncio.sleep(2)

        # Refresh price post-buy
        final_price = await self.jup.price(mint) or price
        tokens = out_amt / 1e6 if out_amt > 0 else TRADE_AMOUNT_SOL / final_price

        self.sol_usd = await self.jup.sol_usd()

        pos = Position(
            token           = token,
            entry_price     = final_price,
            tokens_held     = tokens,
            original_tokens = tokens,
            cost_sol        = TRADE_AMOUNT_SOL,
            high_price      = final_price,
            grok_score      = score,
            grok_reason     = reason,
        )
        pos._last_move_price = final_price
        pos._stall_start     = time.time()

        self.positions.append(pos)
        self.held_mints.add(mint)

        log.info(f"IN: {symbol} @ ${final_price:.10f} | Score: {score}/100 | "
                 f"target +{TP1_PCT:.0f}% → ${final_price*(1+TP1_PCT/100):.10f} | "
                 f"stop -{STOP_LOSS_PCT:.0f}% → ${final_price*(1-STOP_LOSS_PCT/100):.10f}")

        await self.discord.bought(pos, self.sol_usd)
        return True

    # ─── WATCH LOOP ──────────────────────────────────────────────────────────

    async def _watch_loop(self):
        """Continuously polls all open positions and manages exits."""
        while True:
            try:
                for pos in list(self.positions):
                    await self._check_position(pos)
            except Exception as e:
                log.error(f"Watch loop: {e}")
            await asyncio.sleep(2)

    async def _check_position(self, pos: Position):
        price = await self.jup.price(pos.token.mint)
        label = pos.token.symbol if pos.token.symbol != "???" else pos.token.mint[:8]

        # Cache for heartbeat
        if price:
            self._price_cache[pos.token.mint] = (price, time.time())

        # ── NO PRICE ─────────────────────────────────────────────────────────
        if not price:
            if not hasattr(pos, '_price_fail_count'):
                pos._price_fail_count = 0
            pos._price_fail_count += 1
            if pos._price_fail_count >= 30:  # 60s with no price
                log.error(f"{label}: no price 60s — emergency sell")
                await self._close_position(pos, pos.entry_price, "price_dead", 100)
            return
        pos._price_fail_count = 0

        gain_pct = ((price / pos.entry_price) - 1) * 100 if pos.entry_price > 0 else 0

        log.info(
            f"  {label:8s} ${price:.8f} ({gain_pct:+.1f}%) | "
            f"{pos.hold_secs:.0f}s | score:{pos.grok_score}"
        )

        # ── DEAD COIN ────────────────────────────────────────────────────────
        if price == pos._last_price:
            pos._same_count += 1
            if pos._same_count >= DEAD_PRICE_STRIKES:
                log.warning(f"{label}: price frozen — dead")
                await self._close_position(pos, price, "price_dead", 100)
                return
        else:
            pos._same_count = 0
        pos._last_price = price

        if price > pos.high_price:
            pos.high_price = price

        # ── STOP LOSS — always active, no minimum hold ────────────────────────
        stop_price = pos.entry_price * (1 - STOP_LOSS_PCT / 100)
        if price <= stop_price:
            log.warning(f"{label}: STOP -{STOP_LOSS_PCT:.0f}% hit ({gain_pct:.1f}%) — OUT")
            await self._close_position(pos, price, "stop_loss", 100)
            return

        # ── MINIMUM HOLD GUARD (1.5 min) — no profit exits before this ───────
        if pos.hold_secs < MIN_HOLD_SECS:
            return

        # ── TAKE PROFIT — hit +8%, sell everything and dip ───────────────────
        if gain_pct >= TP1_PCT:
            log.info(f"{label}: +{gain_pct:.1f}% — TAKING PROFIT, dipping")
            await self._close_position(pos, price, "tp1", 100)
            return

        # ── TIMEOUT — 30min and nothing happened, move on ────────────────────
        if pos.timed_out:
            log.info(f"{label}: {MAX_HOLD_MINUTES:.0f}min timeout — closing")
            await self._close_position(pos, price, "timeout", 100)
            return

        # ── STALL — rocket didn't launch, stop wasting the slot ──────────────
        if abs(price - pos._last_move_price) / max(pos._last_move_price, 1e-12) > 0.003:
            pos._last_move_price = price
            pos._stall_start = time.time()
        else:
            stall_mins = (time.time() - pos._stall_start) / 60
            if stall_mins >= STALL_MINUTES:
                log.warning(f"{label}: stalled {stall_mins:.1f}min with no move — dipping")
                await self._close_position(pos, price, "stall", 100)
                return

    # ─── SELL HELPERS ────────────────────────────────────────────────────────

    async def _close_position(self, pos: Position, price: float,
                               reason: str, pct: int):
        """Close position fully. Removes from self.positions."""
        label = pos.token.symbol if pos.token.symbol != "???" else pos.token.mint[:8]

        raw_amount, decimals = await self.sol.token_balance(pos.token.mint)
        if raw_amount <= 0:
            raw_amount = int(pos.tokens_held * (10 ** 6))

        if raw_amount <= 0:
            log.warning(f"No tokens to sell for {label} — removing position")
            self._remove_position(pos)
            return

        success = await self._execute_sell(pos.token.mint, raw_amount)
        if not success:
            log.error(f"Close failed for {label} after retries — position stuck")
            return

        gain_pct = ((price / pos.entry_price) - 1) * 100 if pos.entry_price else 0
        pnl_sol  = pos.pnl_estimate(price)

        if pnl_sol >= 0:
            self.wins   += 1
        else:
            self.losses += 1
        self.total_pnl += pnl_sol

        self.sol_usd = await self.jup.sol_usd()
        await self.discord.sold(pos, reason, gain_pct, pnl_sol, 100, self.sol_usd, price)
        log.info(f"CLOSED {label}: {gain_pct:+.1f}% | {pnl_sol:+.5f} SOL | reason: {reason}")

        self._remove_position(pos)

    def _remove_position(self, pos: Position):
        """Remove position from tracking."""
        if pos in self.positions:
            self.positions.remove(pos)
        self.held_mints.discard(pos.token.mint)
        log.info(f"Position removed: {pos.token.symbol} | "
                 f"Remaining: {len(self.positions)}/{MAX_POSITIONS}")

    async def _execute_sell(self, mint: str, raw_amount: int) -> bool:
        """Raw sell execution with retries."""
        for attempt in range(1, 6):
            order = await self.jup.order(mint, WSOL, raw_amount, self.sol.pubkey)
            if order and order.get("transaction"):
                signed = self.sol.sign(order["transaction"])
                if signed:
                    result = await self.jup.execute(order["requestId"], signed)
                    if result:
                        if result.get("status") == "Failed":
                            err = result.get("error", "?")
                            log.error(f"Sell attempt {attempt}/5 failed: {err}")
                            if "insufficient" in str(err).lower():
                                raw_amount = int(raw_amount * 0.97)
                        else:
                            log.info(f"SELL TX: {result.get('signature','?')[:40]}...")
                            return True
            else:
                log.warning(f"No sell route, attempt {attempt}/5")

            if attempt < 5:
                await asyncio.sleep(min(attempt * 2, 8))

        return False

    # ─── HEARTBEAT ───────────────────────────────────────────────────────────

    async def _heartbeat_loop(self):
        while True:
            await asyncio.sleep(3600)  # every hour
            try:
                bal = await self.sol.balance()
                self.sol_usd = await self.jup.sol_usd()

                price_stats = {}
                for p in self.positions:
                    cached = self._price_cache.get(p.token.mint)
                    if cached:
                        price_stats[f"price_{p.token.mint}"] = cached[0]

                stats = {
                    "wins":        self.wins,
                    "losses":      self.losses,
                    "total_pnl":   self.total_pnl,
                    "uptime_mins": (time.time() - self.start_ts) / 60,
                    **price_stats,
                }

                pnl_usd = self.total_pnl * self.sol_usd
                pnl_str = f"+${pnl_usd:.2f}" if pnl_usd >= 0 else f"-${abs(pnl_usd):.2f}"

                log.info(
                    f"HEARTBEAT | up {stats['uptime_mins']:.0f}m | "
                    f"{self.wins}W/{self.losses}L | net {self.total_pnl:+.5f} SOL ({pnl_str}) | "
                    f"bal {bal:.4f} SOL | {len(self.positions)}/{MAX_POSITIONS} pos"
                )

                await self.discord.heartbeat(self.positions, stats, bal, self.sol_usd)

            except Exception as e:
                log.error(f"Heartbeat: {e}")


if __name__ == "__main__":
    try:
        asyncio.run(Bot().run())
    except KeyboardInterrupt:
        log.info("Stopped")
