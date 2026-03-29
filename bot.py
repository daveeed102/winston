"""
WINSTON v3 — Pure Momentum Sniper
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
No Grok. No AI. Just math.

Every 60 seconds:
  - Pull brand new Solana tokens from Dexscreener (< 2h old)
  - Filter for ones with strong upward momentum RIGHT NOW
  - Buy anything that passes — fast
  - Sell at +8% profit or -7% stop loss
  - 5min stall exit if it flatlines

Filters (no Grok needed):
  - Age: < 2 hours old
  - 5m price change: > +3% (moving UP right now)
  - 5m buys > sells (accumulation not distribution)
  - 5m volume: > $500 (actual activity)
  - Liquidity: $10K - $500K (tradeable range)
  - Not already up > 400% in 24h (not a dead cat)
  - Top holder < 40% (basic rug check)
  - Has a buy route on Jupiter (actually tradeable)
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

TRADE_AMOUNT_SOL   = float(os.getenv("TRADE_AMOUNT_SOL",  "0.012"))  # ~$2
MAX_POSITIONS      = int(os.getenv("MAX_POSITIONS",       "5"))
SCAN_INTERVAL_SECS = int(os.getenv("SCAN_INTERVAL_SECS",  "60"))     # scan every 60s

# Entry filters
MIN_PRICE_CHG_5M   = float(os.getenv("MIN_PRICE_CHG_5M",  "3.0"))   # must be up >3% in 5m
MIN_VOL_5M         = float(os.getenv("MIN_VOL_5M",        "500"))    # $500 min 5m volume
MIN_LIQUIDITY      = float(os.getenv("MIN_LIQUIDITY",     "10000"))  # $10K min liquidity
MAX_LIQUIDITY      = float(os.getenv("MAX_LIQUIDITY",     "500000")) # $500K max (find small caps)
MAX_AGE_HOURS      = float(os.getenv("MAX_AGE_HOURS",     "2.0"))    # under 2h old only
MAX_GAIN_24H       = float(os.getenv("MAX_GAIN_24H",      "400"))    # skip if already 4x
MAX_TOP_HOLDER_PCT = float(os.getenv("MAX_TOP_HOLDER_PCT","40"))

# Exit
TP_PCT             = float(os.getenv("TP_PCT",            "8"))      # +8% → sell all, dip
STOP_LOSS_PCT      = float(os.getenv("STOP_LOSS_PCT",     "7"))      # -7% → cut loss
STALL_MINUTES      = float(os.getenv("STALL_MINUTES",     "5"))      # 5min flat → dip
MAX_HOLD_MINUTES   = float(os.getenv("MAX_HOLD_MINUTES",  "20"))     # 20min hard timeout
MIN_HOLD_SECS      = float(os.getenv("MIN_HOLD_SECS",     "90"))     # 1.5min before profit exit
DEAD_STRIKES       = int(os.getenv("DEAD_STRIKES",        "20"))     # ~40s frozen = dead

SLIPPAGE_BPS       = int(os.getenv("SLIPPAGE_BPS",        "1000"))

# Credentials
DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "")
SOLANA_RPC_URL      = os.getenv("SOLANA_RPC_URL",      "")
WALLET_PRIVATE_KEY  = os.getenv("WALLET_PRIVATE_KEY",  "")
JUPITER_API_KEY     = os.getenv("JUPITER_API_KEY",     "")

WSOL        = "So11111111111111111111111111111111111111112"
JUP_ORDER   = "https://api.jup.ag/swap/v2/order"
JUP_EXECUTE = "https://api.jup.ag/swap/v2/execute"
JUP_PRICE   = "https://api.jup.ag/price/v2"

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
    name:   str = ""

@dataclass
class Position:
    token:        Token
    entry_price:  float = 0.0
    tokens_held:  float = 0.0
    cost_sol:     float = 0.0
    opened_ts:    float = 0.0
    score:        float = 0.0   # momentum score at entry
    entry_data:   str   = ""    # snapshot of entry conditions

    _last_price:      float = 0.0
    _same_count:      int   = 0
    _stall_start:     float = 0.0
    _last_move_price: float = 0.0

    def __post_init__(self):
        if not self.opened_ts:
            self.opened_ts = time.time()

    @property
    def hold_secs(self): return time.time() - self.opened_ts
    @property
    def hold_mins(self):  return self.hold_secs / 60
    @property
    def timed_out(self):  return self.hold_mins >= MAX_HOLD_MINUTES

# ─── SCANNER ─────────────────────────────────────────────────────────────────

class Scanner:
    """
    Pulls brand new Solana tokens from Dexscreener.
    No AI. Pure momentum math.
    """

    def __init__(self):
        self.seen_mints: set = set()  # don't re-buy same token this session

    async def _fetch_new_pairs(self) -> list:
        """Pull fresh Solana pairs from multiple Dexscreener endpoints."""
        pairs = []

        async def _get(url):
            try:
                async with aiohttp.ClientSession() as s:
                    async with s.get(url, timeout=aiohttp.ClientTimeout(total=12)) as r:
                        if r.status == 200:
                            return await r.json()
            except Exception as e:
                log.debug(f"Fetch {url[:60]}: {e}")
            return None

        # 1. Latest boosts — tokens getting promoted = have buyers
        data = await _get("https://api.dexscreener.com/token-boosts/latest/v1")
        if data:
            for item in (data if isinstance(data, list) else []):
                if item.get("chainId") == "solana":
                    pairs.append(item.get("tokenAddress", ""))

        # 2. Top boosts
        data = await _get("https://api.dexscreener.com/token-boosts/top/v1")
        if data:
            for item in (data if isinstance(data, list) else []):
                if item.get("chainId") == "solana":
                    pairs.append(item.get("tokenAddress", ""))

        # 3. Search for active pump.fun tokens
        data = await _get("https://api.dexscreener.com/latest/dex/search/?q=pump")
        if data:
            for p in (data.get("pairs") or [])[:40]:
                if p.get("chainId") == "solana":
                    pairs.append(p.get("baseToken", {}).get("address", ""))

        # 4. Raydium new listings
        data = await _get("https://api.dexscreener.com/latest/dex/search/?q=raydium")
        if data:
            for p in (data.get("pairs") or [])[:30]:
                if p.get("chainId") == "solana":
                    pairs.append(p.get("baseToken", {}).get("address", ""))

        # Deduplicate
        seen = set()
        unique = []
        for m in pairs:
            if m and len(m) >= 32 and m not in seen:
                seen.add(m)
                unique.append(m)
        return unique[:80]

    async def find_momentum_tokens(self, exclude_mints: set) -> list:
        """
        Returns list of tokens passing ALL momentum filters, sorted by score.
        Score = weighted combination of 5m price change, buy ratio, volume velocity.
        """
        import time as _t

        mints = await self._fetch_new_pairs()
        mints = [m for m in mints if m not in exclude_mints and m not in self.seen_mints]

        log.info(f"Scanning {len(mints)} mints for momentum...")
        qualified = []

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

                    # ── Extract data ──────────────────────────────────────────
                    base       = p.get("baseToken", {})
                    symbol     = base.get("symbol", "???")
                    name       = base.get("name", "")
                    liquidity  = (p.get("liquidity") or {}).get("usd", 0) or 0
                    v5m        = (p.get("volume") or {}).get("m5", 0) or 0
                    v1h        = (p.get("volume") or {}).get("h1", 0) or 0
                    chg5m      = (p.get("priceChange") or {}).get("m5", 0) or 0
                    chg1h      = (p.get("priceChange") or {}).get("h1", 0) or 0
                    chg24h     = (p.get("priceChange") or {}).get("h24", 0) or 0
                    buys5m     = (p.get("txns") or {}).get("m5", {}).get("buys", 0) or 0
                    sells5m    = (p.get("txns") or {}).get("m5", {}).get("sells", 0) or 0
                    buys1h     = (p.get("txns") or {}).get("h1", {}).get("buys", 0) or 0
                    sells1h    = (p.get("txns") or {}).get("h1", {}).get("sells", 0) or 0
                    created_at = p.get("pairCreatedAt", 0) or 0
                    price_usd  = float(p.get("priceUsd", "0") or "0")
                    age_h      = (_t.time() - created_at / 1000) / 3600 if created_at > 0 else 9999

                    # ── Hard filters — FAIL ANY = skip ────────────────────────
                    if age_h > MAX_AGE_HOURS:
                        continue          # too old
                    if chg5m < MIN_PRICE_CHG_5M:
                        continue          # not moving up right now
                    if v5m < MIN_VOL_5M:
                        continue          # nobody trading it
                    if liquidity < MIN_LIQUIDITY or liquidity > MAX_LIQUIDITY:
                        continue          # too small or too large
                    if chg24h > MAX_GAIN_24H:
                        continue          # already pumped out
                    if buys5m <= sells5m:
                        continue          # more sellers than buyers right now
                    if price_usd <= 0:
                        continue

                    # ── Momentum score ────────────────────────────────────────
                    # Higher = stronger signal
                    buy_ratio    = buys5m / max(sells5m, 1)
                    vol_velocity = v5m / max(v1h / 12, 1)  # 5m vol vs expected per 5m slice of 1h
                    score = (
                        min(chg5m, 50)     * 1.5 +   # 5m price change (capped at 50%)
                        min(buy_ratio, 5)  * 8   +   # buy/sell ratio
                        min(vol_velocity, 3) * 5      # volume acceleration
                    )

                    qualified.append({
                        "mint":      mint,
                        "symbol":    symbol,
                        "name":      name,
                        "price_usd": price_usd,
                        "score":     round(score, 1),
                        "age_h":     round(age_h, 2),
                        "chg5m":     chg5m,
                        "chg1h":     chg1h,
                        "v5m":       v5m,
                        "liquidity": liquidity,
                        "buys5m":    buys5m,
                        "sells5m":   sells5m,
                        "buys1h":    buys1h,
                        "sells1h":   sells1h,
                    })

                except Exception as e:
                    log.debug(f"{mint[:16]}: {e}")
                    continue

        # Sort by momentum score — highest first
        qualified.sort(key=lambda x: x["score"], reverse=True)
        log.info(f"Momentum filter: {len(qualified)} tokens passed out of {len(mints)} scanned")
        for q in qualified[:10]:
            log.info(
                f"  ✅ {q['symbol']:10s} score:{q['score']:5.1f} | "
                f"5m:{q['chg5m']:+.1f}% | {q['buys5m']}B/{q['sells5m']}S | "
                f"vol5m:${q['v5m']:,.0f} | liq:${q['liquidity']:,.0f} | age:{q['age_h']:.2f}h"
            )
        return qualified

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
        # Jupiter first
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
        # Dexscreener fallback
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
                log.error(f"Wallet: {e}")

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
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(self.rpc,
                    json={"jsonrpc": "2.0", "id": 1,
                          "method": "getTokenLargestAccounts",
                          "params": [mint]},
                    timeout=aiohttp.ClientTimeout(total=8)) as r:
                    h_data = await r.json()
                async with s.post(self.rpc,
                    json={"jsonrpc": "2.0", "id": 2,
                          "method": "getTokenSupply",
                          "params": [mint]},
                    timeout=aiohttp.ClientTimeout(total=8)) as r:
                    s_data = await r.json()
            holders = h_data.get("result", {}).get("value", [])
            total   = float(s_data.get("result", {}).get("value", {}).get("amount", "0"))
            if total > 0 and holders:
                top = float(holders[0].get("amount", "0"))
                return (top / total) * 100
        except:
            pass
        return 0.0

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
                    log.debug(f"Discord: {e}")
                await asyncio.sleep(1)

    async def startup(self, bal: float, sol_usd: float):
        await self.send({"embeds": [{
            "title": "⚡ WINSTON v3 — MOMENTUM SNIPER ONLINE",
            "color": 0x00FF88,
            "description": (
                f"Balance: **{bal:.4f} SOL** (${bal*sol_usd:.2f})\n"
                f"Mode: **Pure momentum — no AI, just math**\n"
                f"Entry: age <{MAX_AGE_HOURS:.0f}h | 5m >{MIN_PRICE_CHG_5M:.0f}% | buys>sells | vol5m >${MIN_VOL_5M:,.0f}\n"
                f"Exit: +{TP_PCT:.0f}% profit | -{STOP_LOSS_PCT:.0f}% stop | {STALL_MINUTES:.0f}min stall | {MAX_HOLD_MINUTES:.0f}min max\n"
                f"Size: **{TRADE_AMOUNT_SOL} SOL** (~${TRADE_AMOUNT_SOL*sol_usd:.2f}) | Max **{MAX_POSITIONS}** positions"
            )
        }]})

    async def scan_result(self, found: list, total_scanned: int):
        if not found:
            return  # silent — no spam when nothing found
        lines = []
        for t in found[:8]:
            lines.append(
                f"✅ **{t['symbol']}** score:{t['score']} | "
                f"5m:{t['chg5m']:+.1f}% | {t['buys5m']}B/{t['sells5m']}S | "
                f"vol:${t['v5m']:,.0f} | liq:${t['liquidity']:,.0f} | {t['age_h']:.2f}h old"
            )
        await self.send({"embeds": [{
            "title": f"📡 Scan — {len(found)} launching | {total_scanned} checked",
            "color": 0x8800FF,
            "description": "\n".join(lines)
        }]})

    async def bought(self, pos: Position, sol_usd: float):
        label = pos.token.symbol
        await self.send({"embeds": [{
            "title": f"🚀 IN — {label}",
            "color": 0x00AAFF,
            "description": (
                f"{pos.entry_data}\n\n"
                f"Entry: **${pos.entry_price:.8f}** | **{pos.cost_sol:.4f} SOL** (${pos.cost_sol*sol_usd:.2f})\n"
                f"Target: **+{TP_PCT:.0f}%** → ${pos.entry_price*(1+TP_PCT/100):.8f}\n"
                f"Stop:   **-{STOP_LOSS_PCT:.0f}%** → ${pos.entry_price*(1-STOP_LOSS_PCT/100):.8f}"
            ),
            "fields": [{"name": "Chart",
                        "value": f"[Dex](https://dexscreener.com/solana/{pos.token.mint}) | "
                                 f"[Solscan](https://solscan.io/token/{pos.token.mint})",
                        "inline": False}]
        }]})

    async def sold(self, pos: Position, reason: str, gain_pct: float,
                   pnl_sol: float, sol_usd: float):
        label     = pos.token.symbol
        is_profit = pnl_sol >= 0
        color     = 0x00FF88 if is_profit else 0xFF4444
        emoji     = "✅" if is_profit else "❌"
        pnl_str   = f"+{pnl_sol:.5f} SOL (+${abs(pnl_sol)*sol_usd:.2f})" if is_profit \
                    else f"{pnl_sol:.5f} SOL (-${abs(pnl_sol)*sol_usd:.2f})"
        reason_map = {
            "tp":         f"🎯 +{TP_PCT:.0f}% hit",
            "stop_loss":  f"🛑 Stop -{STOP_LOSS_PCT:.0f}%",
            "stall":      f"😴 Stalled {STALL_MINUTES:.0f}min",
            "timeout":    f"⏰ {MAX_HOLD_MINUTES:.0f}min timeout",
            "price_dead": "📡 Price dead",
        }
        await self.send({"embeds": [{
            "title": f"{emoji} OUT — {label} [{gain_pct:+.1f}%]",
            "color": color,
            "description": (
                f"**{pnl_str}**\n"
                f"{reason_map.get(reason, reason)} | held {pos.hold_secs:.0f}s"
            )
        }]})

    async def heartbeat(self, positions: list, wins: int, losses: int,
                        total_pnl: float, bal: float, sol_usd: float, uptime_mins: float):
        pnl_usd = total_pnl * sol_usd
        pnl_str = f"+${pnl_usd:.2f}" if pnl_usd >= 0 else f"-${abs(pnl_usd):.2f}"
        pos_lines = []
        for p in positions:
            cached_price = p.entry_price  # approximate
            gain = ((cached_price / p.entry_price) - 1) * 100 if p.entry_price else 0
            pos_lines.append(f"• **{p.token.symbol}** {p.hold_secs:.0f}s")
        desc = (
            f"**{wins}W / {losses}L** | Net: **{pnl_str}** | Bal: {bal:.4f} SOL\n"
            f"Positions: **{len(positions)}/{MAX_POSITIONS}** | Up: {uptime_mins:.0f}min\n"
        )
        if pos_lines:
            desc += "\n".join(pos_lines)
        await self.send({"embeds": [{"title": "💓 Winston v3", "color": 0x333333,
                                     "description": desc}]})

# ─── BOT ─────────────────────────────────────────────────────────────────────

class Bot:
    def __init__(self):
        self.sol      = Solana(SOLANA_RPC_URL, WALLET_PRIVATE_KEY)
        self.jup      = Jupiter()
        self.scanner  = Scanner()
        self.discord  = Discord(DISCORD_WEBHOOK_URL)

        self.positions: list[Position] = []
        self.held_mints: set = set()

        self.start_ts  = time.time()
        self.sol_usd   = 165.0
        self.wins      = 0
        self.losses    = 0
        self.total_pnl = 0.0
        self._price_cache: dict = {}

    async def run(self):
        log.info("=" * 55)
        log.info("  WINSTON v3 — Pure Momentum Sniper")
        log.info(f"  {TRADE_AMOUNT_SOL} SOL/trade | max {MAX_POSITIONS} positions")
        log.info(f"  Entry: age <{MAX_AGE_HOURS}h | 5m >{MIN_PRICE_CHG_5M}% | vol >${MIN_VOL_5M}")
        log.info(f"  Exit: +{TP_PCT}% profit | -{STOP_LOSS_PCT}% stop | {STALL_MINUTES}min stall")
        log.info(f"  Scan every {SCAN_INTERVAL_SECS}s")
        log.info("=" * 55)

        self.sol_usd = await self.jup.sol_usd()
        bal = await self.sol.balance()
        log.info(f"Balance: {bal:.4f} SOL (${bal*self.sol_usd:.2f})")

        await self.discord.startup(bal, self.sol_usd)

        await asyncio.gather(
            self._scan_loop(),
            self._watch_loop(),
            self._heartbeat_loop(),
        )

    # ─── SCAN LOOP ───────────────────────────────────────────────────────────

    async def _scan_loop(self):
        await asyncio.sleep(5)  # brief warmup
        while True:
            try:
                await self._do_scan()
            except Exception as e:
                log.error(f"Scan error: {e}")
                import traceback; traceback.print_exc()
            await asyncio.sleep(SCAN_INTERVAL_SECS)

    async def _do_scan(self):
        open_slots = MAX_POSITIONS - len(self.positions)
        if open_slots <= 0:
            log.info(f"All {MAX_POSITIONS} slots full")
            return

        candidates = await self.scanner.find_momentum_tokens(self.held_mints)

        await self.discord.scan_result(candidates, len(candidates))

        bought = 0
        for token_data in candidates:
            if bought >= open_slots:
                break
            if len(self.positions) >= MAX_POSITIONS:
                break
            if token_data["mint"] in self.held_mints:
                continue

            success = await self._open_position(token_data)
            if success:
                bought += 1
                # Mark as seen so we don't re-buy same token this session
                self.scanner.seen_mints.add(token_data["mint"])
                await asyncio.sleep(1)

        if bought:
            log.info(f"Scan complete — opened {bought} positions | {len(self.positions)}/{MAX_POSITIONS}")

    # ─── OPEN POSITION ───────────────────────────────────────────────────────

    async def _open_position(self, data: dict) -> bool:
        mint   = data["mint"]
        symbol = data["symbol"]

        # Balance check
        bal = await self.sol.balance()
        if bal < TRADE_AMOUNT_SOL + 0.005:
            log.error(f"Low balance: {bal:.4f} SOL")
            return False

        # Top holder check
        top_pct = await self.sol.top_holder_pct(mint)
        if top_pct > MAX_TOP_HOLDER_PCT:
            log.warning(f"SKIP {symbol}: top holder {top_pct:.0f}%")
            return False

        # Get current price
        price = data.get("price_usd", 0.0)
        if not price:
            price = await self.jup.price(mint)
        if not price or price <= 0:
            log.warning(f"SKIP {symbol}: no price")
            return False

        # Build buy order
        lamports = int(TRADE_AMOUNT_SOL * 1e9)
        order    = await self.jup.order(WSOL, mint, lamports, self.sol.pubkey)
        if not order:
            log.warning(f"SKIP {symbol}: no Jupiter route")
            return False

        tx_b64  = order.get("transaction", "")
        req_id  = order.get("requestId", "")
        out_amt = int(order.get("outAmount", "0"))
        if not tx_b64 or not req_id:
            return False

        signed = self.sol.sign(tx_b64)
        if not signed:
            return False

        result = await self.jup.execute(req_id, signed)
        if not result or result.get("status") == "Failed":
            log.error(f"Buy failed {symbol}: {result.get('error','?') if result else 'no result'}")
            return False

        log.info(f"BUY TX: {result.get('signature','?')[:40]}...")
        await asyncio.sleep(2)

        final_price = await self.jup.price(mint) or price
        tokens      = out_amt / 1e6 if out_amt > 0 else TRADE_AMOUNT_SOL / final_price

        self.sol_usd = await self.jup.sol_usd()

        entry_data = (
            f"score:{data['score']} | 5m:{data['chg5m']:+.1f}% | "
            f"{data['buys5m']}B/{data['sells5m']}S | "
            f"vol5m:${data['v5m']:,.0f} | liq:${data['liquidity']:,.0f} | "
            f"age:{data['age_h']:.2f}h"
        )

        pos = Position(
            token        = Token(mint=mint, symbol=symbol, name=data.get("name", "")),
            entry_price  = final_price,
            tokens_held  = tokens,
            cost_sol     = TRADE_AMOUNT_SOL,
            score        = data["score"],
            entry_data   = entry_data,
        )
        pos._last_move_price = final_price
        pos._stall_start     = time.time()

        self.positions.append(pos)
        self.held_mints.add(mint)

        log.info(
            f"IN: {symbol} @ ${final_price:.10f} | {entry_data}\n"
            f"    target +{TP_PCT:.0f}% → ${final_price*(1+TP_PCT/100):.10f} | "
            f"stop -{STOP_LOSS_PCT:.0f}% → ${final_price*(1-STOP_LOSS_PCT/100):.10f}"
        )
        await self.discord.bought(pos, self.sol_usd)
        return True

    # ─── WATCH LOOP ──────────────────────────────────────────────────────────

    async def _watch_loop(self):
        while True:
            for pos in list(self.positions):
                try:
                    await self._check_position(pos)
                except Exception as e:
                    log.error(f"Watch {pos.token.symbol}: {e}")
            await asyncio.sleep(2)

    async def _check_position(self, pos: Position):
        price = await self.jup.price(pos.token.mint)
        label = pos.token.symbol

        # ── NO PRICE ─────────────────────────────────────────────────────────
        if not price:
            if not hasattr(pos, '_price_fail_count'):
                pos._price_fail_count = 0
            pos._price_fail_count += 1
            if pos._price_fail_count >= 30:
                log.error(f"{label}: no price 60s — emergency sell")
                await self._close(pos, pos.entry_price, "price_dead")
            return
        pos._price_fail_count = 0

        gain_pct = ((price / pos.entry_price) - 1) * 100 if pos.entry_price > 0 else 0

        log.info(
            f"  {label:8s} ${price:.8f} ({gain_pct:+.1f}%) | "
            f"{pos.hold_secs:.0f}s | score:{pos.score}"
        )

        # ── DEAD COIN ────────────────────────────────────────────────────────
        if price == pos._last_price:
            pos._same_count += 1
            if pos._same_count >= DEAD_STRIKES:
                log.warning(f"{label}: price frozen {DEAD_STRIKES} polls — dead")
                await self._close(pos, price, "price_dead")
                return
        else:
            pos._same_count = 0
        pos._last_price = price

        # ── STOP LOSS — fires immediately, no min hold ────────────────────────
        if gain_pct <= -STOP_LOSS_PCT:
            log.warning(f"{label}: STOP {gain_pct:.1f}% — OUT")
            await self._close(pos, price, "stop_loss")
            return

        # ── MIN HOLD GUARD — no profit exits before 90s ───────────────────────
        if pos.hold_secs < MIN_HOLD_SECS:
            return

        # ── TAKE PROFIT ───────────────────────────────────────────────────────
        if gain_pct >= TP_PCT:
            log.info(f"{label}: +{gain_pct:.1f}% TARGET HIT — taking profit")
            await self._close(pos, price, "tp")
            return

        # ── TIMEOUT ───────────────────────────────────────────────────────────
        if pos.timed_out:
            log.info(f"{label}: {MAX_HOLD_MINUTES:.0f}min timeout")
            await self._close(pos, price, "timeout")
            return

        # ── STALL — no movement for STALL_MINUTES, free up the slot ──────────
        if abs(price - pos._last_move_price) / max(pos._last_move_price, 1e-12) > 0.003:
            pos._last_move_price = price
            pos._stall_start = time.time()
        else:
            stall_mins = (time.time() - pos._stall_start) / 60
            if stall_mins >= STALL_MINUTES:
                log.warning(f"{label}: stalled {stall_mins:.1f}min — freeing slot")
                await self._close(pos, price, "stall")
                return

    # ─── CLOSE ───────────────────────────────────────────────────────────────

    async def _close(self, pos: Position, price: float, reason: str):
        label = pos.token.symbol

        raw_amount, _ = await self.sol.token_balance(pos.token.mint)
        if raw_amount <= 0:
            raw_amount = int(pos.tokens_held * 1e6)

        if raw_amount <= 0:
            log.warning(f"No tokens to sell for {label}")
            self._remove(pos)
            return

        success = await self._execute_sell(pos.token.mint, raw_amount)
        if not success:
            log.error(f"Sell failed for {label}")
            return

        gain_pct = ((price / pos.entry_price) - 1) * 100 if pos.entry_price else 0
        pnl_sol  = pos.cost_sol * (gain_pct / 100)

        if pnl_sol >= 0:
            self.wins += 1
        else:
            self.losses += 1
        self.total_pnl += pnl_sol

        self.sol_usd = await self.jup.sol_usd()
        await self.discord.sold(pos, reason, gain_pct, pnl_sol, self.sol_usd)
        log.info(f"OUT {label}: {gain_pct:+.1f}% | {pnl_sol:+.5f} SOL | {reason} | held {pos.hold_secs:.0f}s")

        self._remove(pos)

    def _remove(self, pos: Position):
        if pos in self.positions:
            self.positions.remove(pos)
        self.held_mints.discard(pos.token.mint)

    async def _execute_sell(self, mint: str, raw_amount: int) -> bool:
        for attempt in range(1, 6):
            order = await self.jup.order(mint, WSOL, raw_amount, self.sol.pubkey)
            if order and order.get("transaction"):
                signed = self.sol.sign(order["transaction"])
                if signed:
                    result = await self.jup.execute(order["requestId"], signed)
                    if result:
                        if result.get("status") == "Failed":
                            err = result.get("error", "?")
                            log.error(f"Sell attempt {attempt}/5: {err}")
                            if "insufficient" in str(err).lower():
                                raw_amount = int(raw_amount * 0.97)
                        else:
                            log.info(f"SELL TX: {result.get('signature','?')[:40]}...")
                            return True
            else:
                log.warning(f"No sell route attempt {attempt}/5")
            if attempt < 5:
                await asyncio.sleep(min(attempt * 2, 6))
        return False

    # ─── HEARTBEAT ───────────────────────────────────────────────────────────

    async def _heartbeat_loop(self):
        while True:
            await asyncio.sleep(3600)
            try:
                bal = await self.sol.balance()
                self.sol_usd = await self.jup.sol_usd()
                uptime_mins = (time.time() - self.start_ts) / 60
                pnl_usd = self.total_pnl * self.sol_usd
                pnl_str = f"+${pnl_usd:.2f}" if pnl_usd >= 0 else f"-${abs(pnl_usd):.2f}"
                log.info(
                    f"HEARTBEAT | up {uptime_mins:.0f}m | "
                    f"{self.wins}W/{self.losses}L | net {self.total_pnl:+.5f} SOL ({pnl_str}) | "
                    f"bal {bal:.4f} SOL | {len(self.positions)}/{MAX_POSITIONS} pos"
                )
                await self.discord.heartbeat(
                    self.positions, self.wins, self.losses,
                    self.total_pnl, bal, self.sol_usd, uptime_mins
                )
            except Exception as e:
                log.error(f"Heartbeat: {e}")


if __name__ == "__main__":
    try:
        asyncio.run(Bot().run())
    except KeyboardInterrupt:
        log.info("Stopped")
