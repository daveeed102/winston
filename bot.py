"""
DEGEN SNIPER v9 -- Ladder Exits, % Discord, House Money Runner
===============================================================
New in v9:
  1. LADDER SELL STRATEGY -- instead of one hard exit, scale out:
       Tier 1 (+25%): sell 50% of position -> locked profit, de-risked
       Tier 2 (+50%): sell 50% of remaining (25% original) -> 75% secured
       Runner (25% original): rides with TIGHT 20% trailing stop
         catches moonshots with zero downside risk to original capital
       Timeout: sell whatever remains at MAX_HOLD_MINUTES
  2. DISCORD % ONLY -- all messages show % gain/loss, no dollar amounts.
  3. Position tracks partial sells: tokens_held shrinks each ladder step.

Strategy:
  1. Detect Pump.fun graduation -> Raydium migration
  2. Hard filters: holders, top-3 concentration, freeze, liquidity floor
  3. Momentum confirmation: live quote price must be rising (not cached)
  4. Buy full -> Tier 1 sell at +25% -> Tier 2 at +50% -> runner rides
  5. Early loss cut at 90s if down >12%
  6. Cooldown -> repeat
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

# ── CONFIG ────────────────────────────────────────────────────────────────────

TRADE_AMOUNT_SOL   = float(os.getenv("TRADE_AMOUNT_SOL",   "0.061"))
TRAILING_STOP_PCT  = float(os.getenv("TRAILING_STOP_PCT",  "35"))
MAX_HOLD_MINUTES   = float(os.getenv("MAX_HOLD_MINUTES",   "3"))
SLIPPAGE_BPS       = int(os.getenv("SLIPPAGE_BPS",         "1000"))
PROFIT_TARGET_X    = float(os.getenv("PROFIT_TARGET_X",    "1.25"))  # Tier 1 trigger
MIN_MOMENTUM_PCT   = float(os.getenv("MIN_MOMENTUM_PCT",   "8"))
MIN_LIQUIDITY_SOL  = float(os.getenv("MIN_LIQUIDITY_SOL",  "1.0"))
MAX_TOP_HOLDER_PCT = float(os.getenv("MAX_TOP_HOLDER_PCT", "40"))
BUY_DELAY_SECONDS  = float(os.getenv("BUY_DELAY_SECONDS",  "0"))
DEGEN_MODE         = os.getenv("DEGEN_MODE", "true").lower() == "true"

# ── LADDER SELL CONFIG ────────────────────────────────────────────────────────
# Tier 1: at PROFIT_TARGET_X (+25%), sell this fraction
LADDER_T1_FRACTION = 0.50   # sell 50% at +25%  -> profit locked, still riding
# Tier 2: at LADDER_T2_X (+50%), sell this fraction of REMAINING tokens
LADDER_T2_X        = 1.50   # trigger at 1.5x entry (+50%)
LADDER_T2_FRACTION = 0.50   # sell 50% of remaining = 25% of original
# Runner: last ~25% of original position -- rides with tighter stop + more time
RUNNER_STOP_PCT    = 20.0   # tight trailing stop on runner (20% below its high)
RUNNER_MAX_MINUTES = 8.0    # runner gets up to 8 min total from entry

# ── FEE CONFIG ────────────────────────────────────────────────────────────────
# ~5000 lamports/sig, 2 sigs/tx, up to 4 sell txs + 1 buy
ESTIMATED_FEES_SOL  = 0.000015 + (TRADE_AMOUNT_SOL * 0.001)
BREAKEVEN_X         = (TRADE_AMOUNT_SOL + ESTIMATED_FEES_SOL * 2) / TRADE_AMOUNT_SOL

# ── OTHER CONFIG ──────────────────────────────────────────────────────────────
TRADE_COOLDOWN_SECS   = 8
EARLY_LOSS_EXIT_PCT   = 12.0   # cut full position if down this % at checkpoint
EARLY_EXIT_AFTER_SECS = 90
STOP_ENGAGE_PCT       = 3.0    # main stop only engages after +3%

DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "")
SOLANA_RPC_URL      = os.getenv("SOLANA_RPC_URL",      "")
WALLET_PRIVATE_KEY  = os.getenv("WALLET_PRIVATE_KEY",  "")
JUPITER_API_KEY     = os.getenv("JUPITER_API_KEY",     "")

PUMPFUN     = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
RAYDIUM_AMM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
WSOL        = "So11111111111111111111111111111111111111112"

JUP_ORDER   = "https://api.jup.ag/swap/v2/order"
JUP_EXECUTE = "https://api.jup.ag/swap/v2/execute"
JUP_PRICE   = "https://api.jup.ag/price/v2"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(message)s",
    datefmt="%H:%M:%S"
)
log = logging.getLogger("sniper")

# ── MODELS ────────────────────────────────────────────────────────────────────

@dataclass
class Token:
    mint:   str
    symbol: str = "???"
    name:   str = "Unknown"
    source: str = ""

@dataclass
class Position:
    token:          Token
    entry_price:    float = 0.0
    tokens_held:    float = 0.0   # decreases as we ladder out
    cost_sol:       float = 0.0   # original SOL spent
    high_price:     float = 0.0
    stop_price:     float = 0.0
    stop_engaged:   bool  = False
    t1_done:        bool  = False  # Tier 1 sell executed
    t2_done:        bool  = False  # Tier 2 sell executed
    is_runner:      bool  = False  # True once both tiers are done
    opened_ts:      float = 0.0
    sol_recouped:   float = 0.0    # total SOL received from partial sells

    def __post_init__(self):
        if not self.opened_ts:
            self.opened_ts = time.time()

    @property
    def hold_secs(self): return time.time() - self.opened_ts
    @property
    def hold_mins(self):  return self.hold_secs / 60
    @property
    def timed_out(self):
        limit = RUNNER_MAX_MINUTES if self.is_runner else MAX_HOLD_MINUTES
        return self.hold_secs >= limit * 60

# ── JUPITER ───────────────────────────────────────────────────────────────────

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
                ssl=False, limit=10
            )
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
                    p = d.get("data", {}).get(mint, {}).get("price")
                    if p:
                        return float(p)
        except:
            pass
        finally:
            await s.close()
        return await self.quote_price(mint)

    async def quote_price(self, mint) -> Optional[float]:
        """Live AMM quote -- bypasses cached price API entirely."""
        s = await self._sess()
        try:
            params = {"inputMint": mint, "outputMint": WSOL,
                      "amount": str(int(1_000_000 * 1e6))}
            async with s.get(JUP_ORDER, params=params,
                             timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    d = await r.json()
                    out_sol = int(d.get("outAmount", "0")) / 1e9
                    if out_sol > 0:
                        return out_sol / 1_000_000
        except Exception as e:
            log.debug(f"quote_price 1M err: {e}")
        finally:
            await s.close()
        # Fallback with smaller amount for thin pools
        s2 = await self._sess()
        try:
            params = {"inputMint": mint, "outputMint": WSOL,
                      "amount": str(int(10_000 * 1e6))}
            async with s2.get(JUP_ORDER, params=params,
                              timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    d = await r.json()
                    out_sol = int(d.get("outAmount", "0")) / 1e9
                    if out_sol > 0:
                        return out_sol / 10_000
        except:
            pass
        finally:
            await s2.close()
        return None

    async def order(self, inp, out, amount, taker) -> Optional[dict]:
        s = await self._sess()
        try:
            params = {"inputMint": inp, "outputMint": out,
                      "amount": str(amount), "taker": taker,
                      "slippageBps": str(SLIPPAGE_BPS)}
            async with s.get(JUP_ORDER, params=params,
                             timeout=aiohttp.ClientTimeout(total=12)) as r:
                if r.status == 200:
                    return await r.json()
                log.error(f"Jup order {r.status}: {(await r.text())[:200]}")
        except Exception as e:
            log.error(f"Jup order: {e}")
        finally:
            await s.close()
        return None

    async def execute(self, req_id, signed_b64) -> Optional[dict]:
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

    async def liquidity_sol(self, mint) -> float:
        """Estimate SOL pool depth via price impact of a 1 SOL buy."""
        s = await self._sess()
        try:
            params = {"inputMint": WSOL, "outputMint": mint,
                      "amount": str(int(1 * 1e9)),
                      "taker": "11111111111111111111111111111111"}
            async with s.get(JUP_ORDER, params=params,
                             timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    d = await r.json()
                    impact = float(d.get("priceImpactPct", "100") or "100")
                    if impact <= 0:
                        return 999.0
                    return 1.0 / (impact / 100.0)
        except Exception as e:
            log.debug(f"liquidity_sol err: {e}")
        finally:
            await s.close()
        return 0.0

# ── SOLANA ────────────────────────────────────────────────────────────────────

class Solana:
    def __init__(self, rpc, pk):
        self.rpc = rpc
        self.ws  = rpc.replace("https://", "wss://").replace("http://", "ws://")
        self.keypair = self.pubkey = None
        if pk:
            try:
                from solders.keypair import Keypair
                import base58
                self.keypair = Keypair.from_bytes(base58.b58decode(pk))
                self.pubkey  = str(self.keypair.pubkey())
                log.info(f"Wallet: {self.pubkey[:8]}...{self.pubkey[-4:]}")
            except Exception as e:
                log.error(f"Wallet load: {e}")

    async def balance(self, sess) -> float:
        if not self.pubkey:
            return 0.0
        try:
            async with sess.post(self.rpc,
                json={"jsonrpc": "2.0", "id": 1, "method": "getBalance",
                      "params": [self.pubkey]},
                timeout=aiohttp.ClientTimeout(total=10)) as r:
                d = await r.json()
                return d.get("result", {}).get("value", 0) / 1e9
        except:
            return 0.0

    def sign(self, tx_b64) -> Optional[str]:
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

# ── DISCORD ───────────────────────────────────────────────────────────────────

class Discord:
    def __init__(self, url):
        self.url = url
        self._sol_price = 150.0

    async def _fetch_sol_price(self) -> float:
        try:
            async with aiohttp.ClientSession() as s:
                async with s.get(f"https://api.jup.ag/price/v2?ids={WSOL}",
                                 timeout=aiohttp.ClientTimeout(total=5)) as r:
                    if r.status == 200:
                        d = await r.json()
                        p = d.get("data", {}).get(WSOL, {}).get("price")
                        if p:
                            self._sol_price = float(p)
        except:
            pass
        return self._sol_price

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
                    log.debug(f"Discord send failed: {e}")
                await asyncio.sleep(1)

    def _label(self, p: "Position") -> str:
        if p.token.symbol and p.token.symbol != "???":
            return p.token.symbol
        if p.token.name and p.token.name not in ("Unknown", ""):
            return p.token.name[:12]
        return p.token.mint[:8] + "..."

    def _pct_str(self, gain_x: float) -> str:
        """Convert a gain multiplier to a clean % string: +25%, -8%, etc."""
        pct = (gain_x - 1.0) * 100
        return f"+{pct:.1f}%" if pct >= 0 else f"{pct:.1f}%"

    async def bought(self, p: "Position"):
        label = self._label(p)
        t1_pct = (PROFIT_TARGET_X - 1) * 100
        t2_pct = (LADDER_T2_X - 1) * 100
        await self.send({"embeds": [{
            "title": f"💰 BOUGHT — {label}",
            "color": 0x00AAFF,
            "description": (
                f"Entry locked in. Ladder exits armed:\n"
                f"**Tier 1** +{t1_pct:.0f}% → sell {LADDER_T1_FRACTION*100:.0f}%\n"
                f"**Tier 2** +{t2_pct:.0f}% → sell half of remaining\n"
                f"**Runner** rides with {RUNNER_STOP_PCT:.0f}% trailing stop"
            ),
            "fields": [
                {"name": "Stop Engages", "value": f"After +{STOP_ENGAGE_PCT:.0f}%",          "inline": True},
                {"name": "Timeout",      "value": f"Tiers {MAX_HOLD_MINUTES}m / Runner {RUNNER_MAX_MINUTES:.0f}m", "inline": True},
                {"name": "Chart",        "value": f"[Solscan](https://solscan.io/token/{p.token.mint})", "inline": True},
            ]
        }]})

    async def partial_sold(self, p: "Position", tier: str, gain_x: float, frac_sold: float):
        """Notify of a ladder sell (Tier 1 or Tier 2)."""
        label    = self._label(p)
        pct_str  = self._pct_str(gain_x)
        is_win   = gain_x >= 1.0
        color    = 0x00FF88 if is_win else 0xFF4444
        sold_pct = frac_sold * 100
        await self.send({"embeds": [{
            "title": f"📤 {tier} SOLD — {label}",
            "color": color,
            "description": (
                f"Sold **{sold_pct:.0f}%** of position at **{pct_str}**\n"
                f"Profit locked. Remainder still riding."
            ),
            "fields": [
                {"name": "Gain",   "value": pct_str,                                                     "inline": True},
                {"name": "Held",   "value": f"{p.hold_mins:.1f} min",                                    "inline": True},
                {"name": "Chart",  "value": f"[Solscan](https://solscan.io/token/{p.token.mint})",       "inline": True},
            ]
        }]})

    async def sold(self, p: "Position", reason: str, gain_x: float, is_runner: bool = False):
        """Final close-out notification (runner exit or full sell)."""
        label   = self._label(p)
        pct_str = self._pct_str(gain_x)
        is_win  = gain_x >= BREAKEVEN_X
        color   = 0x00FF88 if is_win else 0xFF4444

        if is_runner:
            emoji = "🚀 RUNNER CLOSED" if is_win else "🏳️ RUNNER STOPPED"
        else:
            emoji = "✅ PROFIT" if is_win else "❌ LOSS"

        reason_map = {
            "timeout":       "⏰ Timeout",
            "trailing_stop": "🛑 Trailing stop",
            "early_loss":    "✂️ Early loss cut",
            "price_dead":    "💀 No price feed",
            "runner_stop":   "🛑 Runner stop",
            "runner_timeout":"⏰ Runner timeout",
        }
        reason_clean = reason_map.get(reason, f"🎯 {reason}")

        # Build a summary line based on what tiers fired
        summary_parts = []
        if p.t1_done:
            summary_parts.append(f"T1 sold at +{(PROFIT_TARGET_X-1)*100:.0f}%")
        if p.t2_done:
            summary_parts.append(f"T2 sold at +{(LADDER_T2_X-1)*100:.0f}%")
        summary_parts.append(f"Final at {pct_str}")
        summary = " | ".join(summary_parts)

        await self.send({"embeds": [{
            "title": f"{emoji} — {label}",
            "color": color,
            "description": (
                f"**{pct_str}** final exit after {p.hold_mins:.1f}min\n"
                f"{summary}"
            ),
            "fields": [
                {"name": "Reason", "value": reason_clean,                                              "inline": True},
                {"name": "Tiers",  "value": f"T1={'done' if p.t1_done else 'skip'} T2={'done' if p.t2_done else 'skip'}", "inline": True},
                {"name": "Chart",  "value": f"[Solscan](https://solscan.io/token/{p.token.mint})",    "inline": True},
            ]
        }]})

    async def info(self, msg: str):
        await self.send({"content": msg})

# ── DETECTOR ──────────────────────────────────────────────────────────────────

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
                        log.info("WebSocket connected -- scanning for pools")
                        await ws.send_json({
                            "jsonrpc": "2.0", "id": 1, "method": "logsSubscribe",
                            "params": [{"mentions": [PUMPFUN]}, {"commitment": "confirmed"}]
                        })
                        await ws.send_json({
                            "jsonrpc": "2.0", "id": 2, "method": "logsSubscribe",
                            "params": [{"mentions": [RAYDIUM_AMM]}, {"commitment": "confirmed"}]
                        })
                        async for msg in ws:
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                await self._handle(msg.data)
                            elif msg.type in (aiohttp.WSMsgType.ERROR,
                                             aiohttp.WSMsgType.CLOSED):
                                break
            except Exception as e:
                log.error(f"WS error: {e}")
            log.info("WS disconnected -- reconnecting in 5s")
            await asyncio.sleep(5)

    async def _handle(self, raw):
        if self.locked:
            return
        try:
            data  = json.loads(raw)
            if "params" not in data:
                return
            value = data["params"]["result"].get("value", {})
            logs  = value.get("logs", [])
            sig   = value.get("signature", "")
            if not logs or not sig:
                return
            if sig in self.seen:
                return

            log_text = " ".join(logs)

            is_graduation = (
                PUMPFUN in log_text and
                ("Withdraw" in log_text or "migrate" in log_text.lower())
            )
            is_raydium_pool = (
                RAYDIUM_AMM in log_text and
                ("initialize2" in log_text or "InitializeInstruction2" in log_text)
            )

            if not is_graduation and not is_raydium_pool:
                return

            self.seen.add(sig)
            source = "pumpfun" if is_graduation else "raydium"
            log.info(f"GRADUATION detected ({source}) -- tx {sig[:20]}...")

            mint = None
            async with aiohttp.ClientSession() as sess:
                for attempt in range(10):
                    mint = await self._extract_mint(sig, sess)
                    if mint:
                        log.info(f"Mint via getTransaction (attempt {attempt+1}): {mint[:20]}...")
                        break
                    await asyncio.sleep(2)

            if not mint:
                mint = self._mint_from_logs(logs, source)
                if mint:
                    log.info(f"Mint via log scan: {mint[:20]}...")

            if not mint:
                log.warning(f"No mint from {sig[:16]} -- skipping")
                return

            if mint in self.seen:
                return
            self.seen.add(mint)

            self.count += 1
            token = Token(mint=mint, source=source)
            log.info(f"DETECTED {source.upper()} -> {mint[:24]}...")

            if not self.locked and self.queue.empty():
                await self.queue.put(token)
                self.locked = True

        except Exception as e:
            log.warning(f"Handle err: {e}")

    async def _extract_mint(self, sig, sess) -> Optional[str]:
        try:
            payload = {
                "jsonrpc": "2.0", "id": 1, "method": "getTransaction",
                "params": [sig, {"encoding": "jsonParsed",
                                 "maxSupportedTransactionVersion": 0}]
            }
            async with sess.post(self.sol.rpc, json=payload,
                                 timeout=aiohttp.ClientTimeout(total=8)) as r:
                data = await r.json()
            tx = data.get("result")
            if not tx:
                return None
            meta = tx.get("meta", {})
            if not meta or meta.get("err"):
                return None
            skip = {WSOL,
                    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"}
            for bal in meta.get("postTokenBalances", []):
                m = bal.get("mint", "")
                if m and m not in skip:
                    return m
            for bal in meta.get("preTokenBalances", []):
                m = bal.get("mint", "")
                if m and m not in skip:
                    return m
        except Exception as e:
            log.debug(f"extract_mint err: {e}")
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
        "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
        "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
        "SysvarRent111111111111111111111111111111111",
        "SysvarC1ock11111111111111111111111111111111",
    }

    def _mint_from_logs(self, logs, source) -> Optional[str]:
        import re
        if source == "pumpfun":
            pump_re = re.compile(r'([1-9A-HJ-NP-Za-km-z]{32,44}pump)')
            for line in logs:
                for m in pump_re.finditer(line):
                    addr = m.group(1)
                    if addr not in self._KNOWN_PROGRAMS:
                        return addr
        b58 = set("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")
        addr_re = re.compile(r'([1-9A-HJ-NP-Za-km-z]{43,44})')
        for line in logs:
            for m in addr_re.finditer(line):
                addr = m.group(1)
                if addr not in self._KNOWN_PROGRAMS and all(c in b58 for c in addr):
                    return addr
        return None

# ── BOT ───────────────────────────────────────────────────────────────────────

class Bot:
    def __init__(self):
        self.sol      = Solana(SOLANA_RPC_URL, WALLET_PRIVATE_KEY)
        self.jup      = Jupiter()
        self.discord  = Discord(DISCORD_WEBHOOK_URL)
        self.detector = Detector(self.sol)
        self.start    = time.time()
        self.trades_won  = 0
        self.trades_lost = 0
        self.total_pnl   = 0.0
        self._rug_blacklist: set = set()

    async def run(self):
        log.info("=" * 62)
        log.info("  DEGEN SNIPER v9 -- Ladder Exits + % Discord")
        log.info(f"  {TRADE_AMOUNT_SOL} SOL/trade")
        log.info(f"  Tier 1: sell {LADDER_T1_FRACTION*100:.0f}% at +{(PROFIT_TARGET_X-1)*100:.0f}%")
        log.info(f"  Tier 2: sell half remaining at +{(LADDER_T2_X-1)*100:.0f}%")
        log.info(f"  Runner: {RUNNER_STOP_PCT:.0f}% trailing stop, {RUNNER_MAX_MINUTES:.0f}min max")
        log.info(f"  Momentum: +{MIN_MOMENTUM_PCT:.0f}% | Min liq: {MIN_LIQUIDITY_SOL} SOL")
        log.info(f"  Early loss: -{EARLY_LOSS_EXIT_PCT:.0f}% at {EARLY_EXIT_AFTER_SECS}s")
        log.info("=" * 62)

        async with aiohttp.ClientSession() as s:
            if self.sol.pubkey:
                bal = await self.sol.balance(s)
                log.info(f"Starting balance: {bal:.4f} SOL")

        await asyncio.gather(
            self.detector.listen(),
            self._trade_loop(),
            self._heartbeat(),
        )

    # ── MAIN TRADE LOOP ───────────────────────────────────────────────────────

    async def _trade_loop(self):
        log.info("Trade loop ready -- waiting for first token")
        while True:
            token = await self.detector.queue.get()
            self.detector.locked = True
            log.info(f"LOCKED IN on {token.mint[:20]}...")

            try:
                if token.mint in self._rug_blacklist:
                    log.info(f"SKIP {token.mint[:16]}: blacklisted rug")
                    continue

              # 🔥 WAIT for token to become tradable
                await asyncio.sleep(5)

                passed = await self._filter(token)
                if not passed:
                    log.info(f"SKIP {token.mint[:16]} -- failed filters")
                    continue

                if MIN_MOMENTUM_PCT > 0:
                    momentum_ok = await self._check_momentum(token)
                    if not momentum_ok:
                        log.info(f"SKIP {token.mint[:16]}: momentum too weak (<{MIN_MOMENTUM_PCT}%)")
                        continue

                pos = await self._buy(token)
                if not pos:
                    log.info(f"BUY FAILED for {token.symbol} -- unlocking")
                    continue

                reason = await self._watch(pos)

                if reason in ("trailing_stop", "early_loss", "runner_stop"):
                    self._rug_blacklist.add(token.mint)
                    log.info(f"Blacklisted {token.mint[:16]} after {reason}")

            except Exception as e:
                log.error(f"Trade loop error: {e}")
                import traceback; traceback.print_exc()
            finally:
                self.detector.locked = False
                log.info("UNLOCKED -- scanning for next coin")
                while not self.detector.queue.empty():
                    try: self.detector.queue.get_nowait()
                    except: break
                log.info(f"Stats: {self.trades_won}W / {self.trades_lost}L | "
                         f"Net {self.total_pnl:+.5f} SOL")
                if TRADE_COOLDOWN_SECS > 0:
                    log.info(f"Cooldown {TRADE_COOLDOWN_SECS}s...")
                    await asyncio.sleep(TRADE_COOLDOWN_SECS)

    # ── FILTER ────────────────────────────────────────────────────────────────

    async def _filter(self, token: Token) -> bool:
        async with aiohttp.ClientSession() as sess:
            try:
                holder_task  = asyncio.create_task(
                    self._rpc(sess, "getTokenLargestAccounts", [token.mint]))
                acct_task    = asyncio.create_task(
                    self._rpc(sess, "getAccountInfo",
                              [token.mint, {"encoding": "jsonParsed"}]))
                liq_task     = asyncio.create_task(
                    self.jup.order(WSOL, token.mint, int(0.005 * 1e9), self.sol.pubkey))
                liq_sol_task = asyncio.create_task(
                    self.jup.liquidity_sol(token.mint))

                holders_res, acct_res, liq_order, liq_sol = await asyncio.gather(
                    holder_task, acct_task, liq_task, liq_sol_task,
                    return_exceptions=True)

                if isinstance(holders_res, Exception) or not holders_res:
                    log.info(f"SKIP {token.mint[:16]}: holder RPC failed"); return False
                holders = holders_res.get("result", {}).get("value", [])
                # 🔥 NEW: retry holder fetch if too early
if len(holders) < 2:
    log.info(f"Holders low ({len(holders)}) — retrying...")
    await asyncio.sleep(3)

    holders_res_retry = await self._rpc(sess, "getTokenLargestAccounts", [token.mint])
    holders_retry = holders_res_retry.get("result", {}).get("value", [])

    if len(holders_retry) < 2:
        log.info(f"SKIP {token.mint[:16]}: only {len(holders_retry)} holders after retry")
        return False
    else:
        holders = holders_retry

                supply_res = await self._rpc(sess, "getTokenSupply", [token.mint])
                total = float(supply_res.get("result", {}).get("value", {}).get("amount", "0"))
                if total > 0 and holders:
                    top1     = float(holders[0].get("amount", "0"))
                    top1_pct = (top1 / total) * 100
                    if top1_pct > MAX_TOP_HOLDER_PCT:
                        log.info(f"SKIP {token.mint[:16]}: top holder {top1_pct:.0f}%"); return False
                    top3_pct = (sum(float(h.get("amount","0")) for h in holders[:3]) / total) * 100
                    if top3_pct > 60:
                        log.info(f"SKIP {token.mint[:16]}: top-3 = {top3_pct:.0f}% (rug risk)"); return False

                if not isinstance(acct_res, Exception) and acct_res:
                    acct = acct_res.get("result", {}).get("value", {})
                    if acct:
                        parsed = acct.get("data", {}).get("parsed", {}).get("info", {})
                        if parsed.get("freezeAuthority"):
                            log.info(f"SKIP {token.mint[:16]}: freeze authority"); return False
                        if parsed.get("symbol"): token.symbol = parsed["symbol"]
                        if parsed.get("name"):   token.name   = parsed["name"]

                if (isinstance(liq_order, Exception) or not liq_order
                        or not liq_order.get("outAmount")):
                    log.info(f"SKIP {token.mint[:16]}: no liquidity route"); return False

                if not isinstance(liq_sol, Exception) and liq_sol < MIN_LIQUIDITY_SOL:
                    log.info(f"SKIP {token.mint[:16]}: liq ~{liq_sol:.2f} SOL < floor"); return False

                try:
                    async with sess.get(f"https://frontend-api.pump.fun/coins/{token.mint}",
                                        timeout=aiohttp.ClientTimeout(total=4)) as r:
                        if r.status == 200:
                            meta = await r.json()
                            if meta.get("symbol"): token.symbol = meta["symbol"]
                            if meta.get("name"):   token.name   = meta["name"]
                except: pass

                label = (token.symbol if token.symbol != "???"
                         else (token.name[:10] if token.name != "Unknown" else token.mint[:8]))
                liq_display = liq_sol if not isinstance(liq_sol, Exception) else 0
                log.info(f"PASS {label} ({token.mint[:16]}) -- "
                         f"{len(holders)} holders, liq ~{liq_display:.1f} SOL")
                return True

            except Exception as e:
                log.warning(f"Filter error: {e}")
                return False

    # ── MOMENTUM CHECK ────────────────────────────────────────────────────────

    async def _check_momentum(self, token: Token) -> bool:
        log.info(f"Checking momentum for {token.symbol}...")
        p1 = await self.jup.quote_price(token.mint)
        if not p1:
            log.info("  No price p1 -- skipping (will buy)")
            return True
        await asyncio.sleep(3)
        p2 = await self.jup.quote_price(token.mint)
        if not p2:
            log.info("  No price p2 -- skipping (will buy)")
            return True
        change_pct = ((p2 - p1) / p1) * 100
        log.info(f"  Momentum: {change_pct:+.1f}%")
        if change_pct >= MIN_MOMENTUM_PCT:
            return True
        await asyncio.sleep(2)
        p3 = await self.jup.quote_price(token.mint)
        if p3:
            change_pct2 = ((p3 - p1) / p1) * 100
            log.info(f"  Momentum retry: {change_pct2:+.1f}%")
            if change_pct2 >= MIN_MOMENTUM_PCT:
                return True
        return False

    # ── BUY ───────────────────────────────────────────────────────────────────

    async def _buy(self, token: Token) -> Optional[Position]:
        if not self.sol.pubkey:
            log.error("No wallet pubkey"); return None

        async with aiohttp.ClientSession() as sess:
            bal = await self.sol.balance(sess)

        min_needed = TRADE_AMOUNT_SOL + ESTIMATED_FEES_SOL + 0.003
        if bal < min_needed:
            log.error(f"Low balance: {bal:.4f} SOL -- need {min_needed:.4f}")
            return None

        if BUY_DELAY_SECONDS > 0:
            await asyncio.sleep(BUY_DELAY_SECONDS)

        lamports = int(TRADE_AMOUNT_SOL * 1e9)
        order    = await self.jup.order(WSOL, token.mint, lamports, self.sol.pubkey)
        if not order:
            log.error(f"No buy route for {token.mint[:16]}"); return None

        tx_b64  = order.get("transaction", "")
        req_id  = order.get("requestId", "")
        out_amt = int(order.get("outAmount", "0"))
        if not tx_b64 or not req_id:
            log.error("Bad Jupiter order response"); return None

        signed = self.sol.sign(tx_b64)
        if not signed: return None

        result = await self.jup.execute(req_id, signed)
        if not result:
            log.error("Execute returned nothing"); return None
        if result.get("status") == "Failed":
            log.error(f"Buy swap failed: {result.get('error', '?')}"); return None

        sig = result.get("signature", "?")
        log.info(f"BUY TX: {sig[:35]}...")

        await asyncio.sleep(2)
        async with aiohttp.ClientSession() as sess:
            bal_after = await self.sol.balance(sess)

        tokens = out_amt / 1e6
        price  = await self.jup.quote_price(token.mint)
        if not price:
            price = await self.jup.price(token.mint)
        if not price:
            price = TRADE_AMOUNT_SOL / tokens if tokens > 0 else 0.0

        gas = max(0.0, (bal - bal_after) - TRADE_AMOUNT_SOL)

        pos = Position(
            token       = token,
            entry_price = price,
            tokens_held = tokens,
            cost_sol    = TRADE_AMOUNT_SOL,
            high_price  = price,
            stop_price  = 0.0,
            stop_engaged = False,
        )
        await self.discord.bought(pos)
        log.info(f"BOUGHT {tokens:.0f} {token.symbol} @ ${price:.10f}")
        log.info(f"  T1 at +{(PROFIT_TARGET_X-1)*100:.0f}%  T2 at +{(LADDER_T2_X-1)*100:.0f}%  Runner rides")
        log.info(f"  Gas: {gas:.5f} SOL")
        return pos

    # ── WATCH + LADDER EXIT ───────────────────────────────────────────────────

    async def _watch(self, pos: Position) -> str:
        """
        Main watch loop. Executes the ladder sell strategy:
          - Tier 1 at PROFIT_TARGET_X: sell LADDER_T1_FRACTION of position
          - Tier 2 at LADDER_T2_X: sell LADDER_T2_FRACTION of remaining
          - Runner: remaining tokens ride with RUNNER_STOP_PCT trailing stop
          - Early loss cut at EARLY_EXIT_AFTER_SECS if down EARLY_LOSS_EXIT_PCT
          - Timeout at MAX_HOLD_MINUTES (or RUNNER_MAX_MINUTES once runner mode)
        Returns the final exit reason string.
        """
        log.info(f"WATCHING {pos.token.symbol} | "
                 f"T1=+{(PROFIT_TARGET_X-1)*100:.0f}% T2=+{(LADDER_T2_X-1)*100:.0f}% Runner rides")
        price_fails    = 0
        early_cut_done = False

        while True:
            await asyncio.sleep(1)

            price = await self.jup.price(pos.token.mint)

            if not price:
                price_fails += 1
                if price_fails % 15 == 1:
                    log.warning(f"No price {pos.token.symbol} ({price_fails}x)")
                if price_fails >= 60:
                    log.error(f"Price dead 60s -- emergency sell {pos.token.symbol}")
                    await self._sell_all(pos, pos.entry_price, "price_dead")
                    return "price_dead"
                continue

            price_fails = 0
            gain_x = price / pos.entry_price if pos.entry_price > 0 else 1.0
            pct_str = self.discord._pct_str(gain_x)

            log.info(f"  {pos.token.symbol:8s} {pct_str:>8s} "
                     f"stop={'RUN' if pos.is_runner else ('ON' if pos.stop_engaged else 'off')} "
                     f"held={pos.hold_mins:.1f}m "
                     f"{'[RUNNER]' if pos.is_runner else ''}")

            # ── TIER 1: first take-profit ─────────────────────────────────
            if not pos.t1_done and gain_x >= PROFIT_TARGET_X:
                log.info(f"TIER 1 HIT {pct_str} -- selling {LADDER_T1_FRACTION*100:.0f}% of {pos.token.symbol}")
                await self._sell_partial(pos, LADDER_T1_FRACTION, price, "Tier 1")
                await self.discord.partial_sold(pos, "TIER 1", gain_x, LADDER_T1_FRACTION)
                pos.t1_done = True

            # ── TIER 2: second take-profit ────────────────────────────────
            if pos.t1_done and not pos.t2_done and gain_x >= LADDER_T2_X:
                log.info(f"TIER 2 HIT {pct_str} -- selling {LADDER_T2_FRACTION*100:.0f}% remaining of {pos.token.symbol}")
                await self._sell_partial(pos, LADDER_T2_FRACTION, price, "Tier 2")
                await self.discord.partial_sold(pos, "TIER 2", gain_x, LADDER_T2_FRACTION)
                pos.t2_done    = True
                pos.is_runner  = True
                pos.high_price = price
                pos.stop_price = price * (1 - RUNNER_STOP_PCT / 100)
                pos.stop_engaged = True
                log.info(f"  RUNNER MODE -- {pos.tokens_held:.0f} tokens left, "
                         f"stop at ${pos.stop_price:.10f} ({RUNNER_STOP_PCT:.0f}% below high)")

            # ── RUNNER LOGIC (after both tiers done) ──────────────────────
            if pos.is_runner:
                # Update runner trailing high
                if price > pos.high_price:
                    pos.high_price = price
                    pos.stop_price = price * (1 - RUNNER_STOP_PCT / 100)
                    log.info(f"  RUNNER NEW HIGH {pct_str} -> stop ${pos.stop_price:.10f}")

                # Runner stop hit
                if price <= pos.stop_price:
                    log.warning(f"RUNNER STOP HIT {pct_str} -- closing {pos.token.symbol}")
                    await self._sell_all(pos, price, "runner_stop")
                    await self.discord.sold(pos, "runner_stop", gain_x, is_runner=True)
                    self._record_pnl(gain_x)
                    return "runner_stop"

                # Runner timeout
                if pos.timed_out:
                    log.warning(f"RUNNER TIMEOUT {pos.hold_mins:.1f}min -- closing {pos.token.symbol} {pct_str}")
                    await self._sell_all(pos, price, "runner_timeout")
                    await self.discord.sold(pos, "runner_timeout", gain_x, is_runner=True)
                    self._record_pnl(gain_x)
                    return "runner_timeout"

                continue  # runner is alive, keep watching

            # ── NON-RUNNER LOGIC ──────────────────────────────────────────

            # Early loss cut (only before Tier 1 fires)
            if (not pos.t1_done and not early_cut_done and
                    pos.hold_secs >= EARLY_EXIT_AFTER_SECS and
                    gain_x < (1 - EARLY_LOSS_EXIT_PCT / 100)):
                log.warning(f"EARLY LOSS CUT {pct_str} at {pos.hold_secs:.0f}s -- "
                            f"selling ALL {pos.token.symbol}")
                await self._sell_all(pos, price, "early_loss")
                await self.discord.sold(pos, "early_loss", gain_x)
                self._record_pnl(gain_x)
                return "early_loss"
            early_cut_done = pos.hold_secs > EARLY_EXIT_AFTER_SECS

            # Timeout on full/tier-1-partial position
            if pos.timed_out:
                log.warning(f"TIMEOUT {pos.hold_mins:.1f}min {pct_str} -- "
                            f"closing {pos.token.symbol}")
                await self._sell_all(pos, price, "timeout")
                await self.discord.sold(pos, "timeout", gain_x)
                self._record_pnl(gain_x)
                return "timeout"

            # Main trailing stop (engages after STOP_ENGAGE_PCT, before T1)
            if not pos.t1_done:
                if not pos.stop_engaged and gain_x >= (1 + STOP_ENGAGE_PCT / 100):
                    pos.stop_engaged = True
                    pos.stop_price   = price * (1 - TRAILING_STOP_PCT / 100)
                    log.info(f"  STOP ENGAGED at {pct_str} -> stop ${pos.stop_price:.10f}")

                if pos.stop_engaged and price > pos.high_price:
                    pos.high_price = price
                    pos.stop_price = price * (1 - TRAILING_STOP_PCT / 100)

                if pos.stop_engaged and pos.stop_price > 0 and price <= pos.stop_price:
                    log.warning(f"TRAILING STOP HIT {pct_str} -- "
                                f"selling ALL {pos.token.symbol}")
                    await self._sell_all(pos, price, "trailing_stop")
                    await self.discord.sold(pos, "trailing_stop", gain_x)
                    self._record_pnl(gain_x)
                    return "trailing_stop"

            # After T1 but before T2: use same main stop (protect locked profit)
            elif pos.t1_done and not pos.t2_done:
                # Re-engage stop relative to T1 price to protect that locked gain
                if not pos.stop_engaged:
                    pos.stop_engaged = True
                    pos.stop_price   = price * (1 - TRAILING_STOP_PCT / 100)
                if price > pos.high_price:
                    pos.high_price = price
                    pos.stop_price = price * (1 - TRAILING_STOP_PCT / 100)
                if pos.stop_price > 0 and price <= pos.stop_price:
                    log.warning(f"POST-T1 STOP HIT {pct_str} -- "
                                f"selling remainder of {pos.token.symbol}")
                    await self._sell_all(pos, price, "trailing_stop")
                    await self.discord.sold(pos, "trailing_stop", gain_x)
                    self._record_pnl(gain_x)
                    return "trailing_stop"

    # ── SELL HELPERS ──────────────────────────────────────────────────────────

    async def _get_real_token_balance(self, mint: str) -> tuple:
        async with aiohttp.ClientSession() as sess:
            try:
                async with sess.post(
                    self.sol.rpc,
                    json={"jsonrpc": "2.0", "id": 1,
                          "method": "getTokenAccountsByOwner",
                          "params": [self.sol.pubkey,
                                     {"mint": mint},
                                     {"encoding": "jsonParsed"}]},
                    timeout=aiohttp.ClientTimeout(total=10)
                ) as r:
                    data = await r.json()
                accounts = data.get("result", {}).get("value", [])
                for acct in accounts:
                    info = (acct.get("account", {})
                                .get("data", {})
                                .get("parsed", {})
                                .get("info", {}))
                    ta  = info.get("tokenAmount", {})
                    raw = int(ta.get("amount", 0))
                    dec = int(ta.get("decimals", 6))
                    if raw > 0:
                        log.info(f"Real balance: {raw} raw ({raw / 10**dec:.4f} tokens)")
                        return raw, dec
            except Exception as e:
                log.error(f"Balance fetch error: {e}")
        return 0, 6

    async def _execute_sell(self, mint: str, raw_amount: int, label: str) -> bool:
        """Execute a sell order. Returns True if successful."""
        if raw_amount <= 0:
            log.error(f"Sell amount is 0 for {label} -- cannot sell")
            return False

        sell_succeeded = False
        for attempt in range(1, 6):
            order = await self.jup.order(mint, WSOL, raw_amount, self.sol.pubkey)
            if order and order.get("transaction"):
                signed = self.sol.sign(order["transaction"])
                if signed:
                    result = await self.jup.execute(order["requestId"], signed)
                    if result:
                        if result.get("status") == "Failed":
                            err = result.get("error", "?")
                            log.error(f"Sell attempt {attempt} failed: {err}")
                            if "insufficient" in str(err).lower() or attempt == 3:
                                raw_amount = int(raw_amount * 0.98)
                                log.warning(f"Retrying with 98%: {raw_amount}")
                        else:
                            sig = result.get("signature", "?")
                            log.info(f"SELL TX [{label}]: {sig[:35]}...")
                            sell_succeeded = True
                            break
            else:
                log.warning(f"No sell route attempt {attempt}/5 [{label}]")

            if not sell_succeeded and attempt < 5:
                wait = min(attempt * 2, 6)
                log.info(f"Retrying in {wait}s...")
                await asyncio.sleep(wait)

        if not sell_succeeded:
            log.error(f"SELL FAILED after 5 attempts [{label}]")
        return sell_succeeded

    async def _sell_partial(self, pos: Position, fraction: float, price: float, label: str):
        """Sell `fraction` of currently held tokens. Updates pos.tokens_held."""
        raw_total, decimals = await self._get_real_token_balance(pos.token.mint)

        if raw_total <= 0:
            raw_total = int(pos.tokens_held * (10 ** 6))
            log.warning(f"Using estimated balance: {raw_total}")

        raw_to_sell = int(raw_total * fraction)
        if raw_to_sell <= 0:
            log.warning(f"Partial sell amount is 0 [{label}]")
            return

        # Dust check
        token_val_sol = (raw_to_sell / 10**decimals) * price
        if token_val_sol < ESTIMATED_FEES_SOL:
            log.warning(f"Dust partial ({token_val_sol:.8f} SOL) -- skipping")
            return

        log.info(f"PARTIAL SELL [{label}]: {raw_to_sell} raw ({fraction*100:.0f}% of {raw_total})")
        ok = await self._execute_sell(pos.token.mint, raw_to_sell, label)
        if ok:
            tokens_sold = raw_to_sell / (10 ** decimals)
            sol_received = tokens_sold * price
            pos.tokens_held  -= tokens_sold
            pos.sol_recouped += sol_received
            log.info(f"  Sold {tokens_sold:.0f} tokens for ~{sol_received:.5f} SOL | "
                     f"{pos.tokens_held:.0f} tokens remain")

    async def _sell_all(self, pos: Position, price: float, reason: str):
        """Sell all remaining tokens."""
        gain_x  = price / pos.entry_price if pos.entry_price > 0 else 1.0
        pct_str = self.discord._pct_str(gain_x)
        log.info(f"SELL ALL {pos.token.symbol} -- {reason} ({pct_str})")

        raw_amount, decimals = await self._get_real_token_balance(pos.token.mint)
        if raw_amount <= 0:
            raw_amount = int(pos.tokens_held * (10 ** 6))
            log.warning(f"Using estimate: {raw_amount}")
        if raw_amount <= 0:
            log.error(f"Nothing to sell for {pos.token.symbol}")
            return

        token_val_sol = (raw_amount / 10**decimals) * price
        if token_val_sol < ESTIMATED_FEES_SOL:
            log.warning(f"Dust position ({token_val_sol:.8f} SOL) -- not worth fee, skipping")
            return

        await self._execute_sell(pos.token.mint, raw_amount, reason)

    def _record_pnl(self, gain_x: float):
        """Record win/loss in session stats."""
        if gain_x >= BREAKEVEN_X:
            self.trades_won += 1
        else:
            self.trades_lost += 1
        # Rough PnL estimate (partial sells complicate exact accounting)
        pnl_est = TRADE_AMOUNT_SOL * (gain_x - 1) - ESTIMATED_FEES_SOL * 2
        self.total_pnl += pnl_est

    # ── HELPERS ───────────────────────────────────────────────────────────────

    async def _rpc(self, sess, method, params):
        try:
            async with sess.post(
                self.sol.rpc,
                json={"jsonrpc": "2.0", "id": 1,
                      "method": method, "params": params},
                timeout=aiohttp.ClientTimeout(total=8)
            ) as r:
                return await r.json()
        except:
            return {}

    async def _heartbeat(self):
        while True:
            await asyncio.sleep(60)
            uptime  = (time.time() - self.start) / 60
            status  = "LOCKED" if self.detector.locked else "SCANNING"
            sol_usd = await self.discord._fetch_sol_price()
            pnl_usd = self.total_pnl * sol_usd
            log.info(f"HEARTBEAT [{status}] | up {uptime:.0f}m | "
                     f"{self.detector.count} tokens seen | "
                     f"{self.trades_won}W {self.trades_lost}L | "
                     f"net {self.total_pnl:+.5f} SOL | "
                     f"rugs blacklisted: {len(self._rug_blacklist)}")
            if int(uptime) % 30 == 0 and int(uptime) > 0:
                pnl_str = f"+{(self.total_pnl/TRADE_AMOUNT_SOL)*100:.1f}%" if self.total_pnl >= 0 else f"{(self.total_pnl/TRADE_AMOUNT_SOL)*100:.1f}%"
                await self.discord.info(
                    f"💓 **Sniper v9 alive** | {uptime:.0f}min up | "
                    f"{self.trades_won}W {self.trades_lost}L | "
                    f"Net: **{pnl_str}** | rugs skipped: {len(self._rug_blacklist)}"
                )

if __name__ == "__main__":
    try:
        asyncio.run(Bot().run())
    except KeyboardInterrupt:
        log.info("Stopped")
