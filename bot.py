"""
DEGEN SNIPER v7 — One At A Time, +25% Or Out
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Strategy:
  1. Scan for a fresh token
  2. Buy it — LOCK IN, ignore all other tokens until resolved
  3. Sell 100% when ANY of these trigger:
       a) Price hits 1.25x entry (+25% profit target) ← primary goal
       b) 2-minute timer expires (cut losses, move on)
       c) Trailing stop hit (protect capital on fast dumps)
  4. Repeat

No partial sells. No ladder. Clean in, clean out.
One coin at a time — full focus, full position.
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

TRADE_AMOUNT_SOL  = float(os.getenv("TRADE_AMOUNT_SOL",   "0.006"))   # ~$1 at ~$165/SOL
TRAILING_STOP_PCT = float(os.getenv("TRAILING_STOP_PCT",  "10"))      # tighter stop for fast flips
MAX_HOLD_MINUTES  = float(os.getenv("MAX_HOLD_MINUTES",   "1"))       # 1 min hard timeout — cash out fast
SLIPPAGE_BPS      = int(os.getenv("SLIPPAGE_BPS",         "500"))
PROFIT_TARGET_X   = float(os.getenv("PROFIT_TARGET_X",    "1.15"))    # sell ALL at +15%
MIN_MOMENTUM_PCT  = float(os.getenv("MIN_MOMENTUM_PCT",   "5"))
MAX_POSITIONS     = int(os.getenv("MAX_POSITIONS",        "3"))        # up to 3 active at once

DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "")
SOLANA_RPC_URL      = os.getenv("SOLANA_RPC_URL",      "")
WALLET_PRIVATE_KEY  = os.getenv("WALLET_PRIVATE_KEY",  "")
JUPITER_API_KEY     = os.getenv("JUPITER_API_KEY",     "")
MAX_TOP_HOLDER_PCT  = float(os.getenv("MAX_TOP_HOLDER_PCT", "50"))
BUY_DELAY_SECONDS   = float(os.getenv("BUY_DELAY_SECONDS",  "0"))

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

# ─── MODELS ──────────────────────────────────────────────────────────────────

@dataclass
class Token:
    mint: str
    symbol: str = "???"
    name: str = "Unknown"
    source: str = ""

@dataclass
class Position:
    token: Token
    entry_price: float = 0.0
    tokens_held: float = 0.0
    cost_sol: float = 0.0
    high_price: float = 0.0
    stop_price: float = 0.0
    opened_ts: float = 0.0

    def __post_init__(self):
        if not self.opened_ts: self.opened_ts = time.time()

    @property
    def hold_secs(self): return time.time() - self.opened_ts
    @property
    def hold_mins(self):  return self.hold_secs / 60
    @property
    def timed_out(self):  return self.hold_secs >= MAX_HOLD_MINUTES * 60

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
                resolver=AsyncResolver(nameservers=["8.8.8.8", "1.1.1.1"]),
                ssl=False, limit=10
            )
        except:
            conn = aiohttp.TCPConnector(ssl=False, limit=10)
        return aiohttp.ClientSession(connector=conn, headers=self._headers())

    async def price(self, mint):
        # Try price API first
        s = await self._sess()
        try:
            async with s.get(f"{JUP_PRICE}?ids={mint}",
                             timeout=aiohttp.ClientTimeout(total=4)) as r:
                if r.status == 200:
                    d = await r.json()
                    p = d.get("data", {}).get(mint, {}).get("price")
                    if p: return float(p)
        except: pass
        finally: await s.close()

        # Quote-based fallback (works on brand new tokens)
        s2 = await self._sess()
        try:
            params = {"inputMint": mint, "outputMint": WSOL, "amount": str(int(10000 * 1e6))}
            async with s2.get(JUP_ORDER, params=params,
                              timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    d = await r.json()
                    out_sol = int(d.get("outAmount", "0")) / 1e9
                    if out_sol > 0: return out_sol / 10000
        except: pass
        finally: await s2.close()
        return None

    async def quote_price(self, mint):
        """
        LIVE quote-based price — bypasses the Jupiter price API cache entirely.
        Used for momentum checks where stale cached prices return 0.0% movement.
        Asks the AMM directly: how much SOL for 10k tokens right now?
        Returns price per token in SOL, or None if no route.
        """
        s = await self._sess()
        try:
            # Use a meaningful amount — 1M tokens to get a stable quote
            params = {
                "inputMint": mint,
                "outputMint": WSOL,
                "amount": str(int(1_000_000 * 1e6))
            }
            async with s.get(JUP_ORDER, params=params,
                             timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    d = await r.json()
                    out_sol = int(d.get("outAmount", "0")) / 1e9
                    if out_sol > 0:
                        return out_sol / 1_000_000
                    # outAmount was 0 — try smaller amount (low liquidity)
                else:
                    log.debug(f"quote_price {r.status} for {mint[:16]}")
        except Exception as e:
            log.debug(f"quote_price err: {e}")
        finally:
            await s.close()

        # Fallback: try with 10k tokens
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
        except: pass
        finally:
            await s2.close()
        return None

    async def order(self, inp, out, amount, taker):
        s = await self._sess()
        try:
            params = {
                "inputMint": inp, "outputMint": out,
                "amount": str(amount), "taker": taker,
                "slippageBps": str(SLIPPAGE_BPS)
            }
            async with s.get(JUP_ORDER, params=params,
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
        self.ws  = rpc.replace("https://", "wss://").replace("http://", "ws://")
        self.keypair = self.pubkey = None
        if pk:
            try:
                from solders.keypair import Keypair; import base58
                self.keypair = Keypair.from_bytes(base58.b58decode(pk))
                self.pubkey  = str(self.keypair.pubkey())
                log.info(f"Wallet: {self.pubkey[:8]}...{self.pubkey[-4:]}")
            except Exception as e: log.error(f"Wallet load: {e}")

    async def balance(self, sess):
        if not self.pubkey: return 0.0
        try:
            async with sess.post(self.rpc,
                json={"jsonrpc": "2.0", "id": 1, "method": "getBalance",
                      "params": [self.pubkey]},
                timeout=aiohttp.ClientTimeout(total=10)) as r:
                d = await r.json()
                return d.get("result", {}).get("value", 0) / 1e9
        except: return 0.0

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
    def __init__(self, url):
        self.url = url
        self._sol_price = 165.0

    async def _fetch_sol_price(self):
        try:
            async with aiohttp.ClientSession() as s:
                async with s.get(
                    f"{JUP_PRICE}?ids={WSOL}",
                    timeout=aiohttp.ClientTimeout(total=5)
                ) as r:
                    if r.status == 200:
                        d = await r.json()
                        p = d.get("data", {}).get(WSOL, {}).get("price")
                        if p:
                            self._sol_price = float(p)
        except:
            pass
        return self._sol_price

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
                if attempt == 2:
                    log.debug(f"Discord send failed: {e}")
                await asyncio.sleep(1)

    def _label(self, p: "Position") -> str:
        if p.token.symbol and p.token.symbol != "???":
            return p.token.symbol
        if p.token.name and p.token.name not in ("Unknown", ""):
            return p.token.name[:12]
        return p.token.mint[:8] + "..."

    async def bought(self, p: "Position"):
        sol_usd = await self._fetch_sol_price()
        label   = self._label(p)
        spent   = p.cost_sol * sol_usd
        target  = spent * PROFIT_TARGET_X
        await self.send({"embeds": [{
            "title": f"🟢 BUY — {label}",
            "color": 0x00AAFF,
            "description": (
                f"In: **${spent:.2f}** ({p.cost_sol:.4f} SOL)\n"
                f"Target: **+{(PROFIT_TARGET_X-1)*100:.0f}%** → ${target:.2f}\n"
                f"Auto-sell: **{MAX_HOLD_MINUTES:.0f} min** | Stop: {TRAILING_STOP_PCT}%"
            ),
            "fields": [{"name": "Chart",
                        "value": f"[Dex](https://dexscreener.com/solana/{p.token.mint}) | "
                                 f"[Solscan](https://solscan.io/token/{p.token.mint})",
                        "inline": False}]
        }]})

    async def sold(self, p: "Position", reason: str, gain_x: float, pnl_sol: float):
        sol_usd   = await self._fetch_sol_price()
        label     = self._label(p)
        gain_pct  = (gain_x - 1) * 100
        pnl_usd   = pnl_sol * sol_usd
        is_profit = pnl_usd >= 0
        color     = 0x00FF88 if is_profit else 0xFF4444
        emoji     = "✅" if is_profit else "❌"
        pnl_str   = f"+${pnl_usd:.2f}" if is_profit else f"-${abs(pnl_usd):.2f}"
        reason_map = {
            "timeout_2min":  f"⏰ {MAX_HOLD_MINUTES:.0f}min timeout",
            "trailing_stop": "🛑 Stop loss",
            "price_dead":    "💀 No price",
        }
        reason_clean = reason_map.get(reason, f"🎯 {reason}")
        await self.send({"embeds": [{
            "title": f"{emoji} SELL — {label}  {gain_pct:+.1f}%",
            "color": color,
            "description": (
                f"**{pnl_str}** ({gain_x:.3f}x) in {p.hold_mins:.1f}min\n"
                f"{reason_clean}"
            )
        }]})

# ─── DETECTOR ────────────────────────────────────────────────────────────────

class Detector:
    """
    Listens to Pump.fun + Raydium WebSocket logs.
    Queues new tokens for buying. Bot can hold up to MAX_POSITIONS at once.
    """
    def __init__(self, sol):
        self.sol    = sol
        self.seen   = set()
        self.count  = 0
        self.queue  = asyncio.Queue()
        self._held_mints: set = set()  # mints currently in a position

    @property
    def locked(self):
        return len(self._held_mints) >= MAX_POSITIONS

    def add_position(self, mint: str):
        self._held_mints.add(mint)

    def remove_position(self, mint: str):
        self._held_mints.discard(mint)

    async def listen(self):
        while True:
            try:
                log.info("Connecting WS...")
                async with aiohttp.ClientSession() as sess:
                    async with sess.ws_connect(self.sol.ws, heartbeat=30) as ws:
                        log.info("WebSocket connected — scanning for pools")
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
                                # Do NOT use create_task here — that runs handlers
                                # in parallel so multiple events all see locked=False
                                # and queue multiple tokens. Handle sequentially.
                                await self._handle(msg.data)
                            elif msg.type in (aiohttp.WSMsgType.ERROR,
                                             aiohttp.WSMsgType.CLOSED):
                                break
            except Exception as e:
                log.error(f"WS error: {e}")
            log.info("WS disconnected — reconnecting in 5s")
            await asyncio.sleep(5)

    async def _handle(self, raw):
        # Drop immediately if all slots full
        if self.locked:
            return

        try:
            data = json.loads(raw)
            if "params" not in data: return
            value = data["params"]["result"].get("value", {})
            logs  = value.get("logs", [])
            sig   = value.get("signature", "")
            if not logs or not sig: return
            if sig in self.seen: return

            log_text = " ".join(logs)

            if PUMPFUN not in log_text: return

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
            log.info(f"GRADUATION detected ({source}) — tx {sig[:20]}...")

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
                log.warning(f"No mint from {sig[:16]} — skipping")
                return

            if mint in self.seen or mint in self._held_mints:
                return
            self.seen.add(mint)

            self.count += 1
            token = Token(mint=mint, source=source)
            log.info(f"DETECTED {source.upper()} -> {mint[:24]}...")

            if not self.locked:
                await self.queue.put(token)

        except Exception as e:
            log.warning(f"Handle err: {e}")

    async def _extract_mint(self, sig: str, sess: aiohttp.ClientSession) -> Optional[str]:
        """
        Fetch the transaction and pull the token mint from postTokenBalances.
        Returns None if the RPC hasn't indexed the tx yet (result is null).
        """
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
                return None  # Not indexed yet — caller will retry

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

    # Known Solana program/system addresses — never valid token mints
    _KNOWN_PROGRAMS = {
        WSOL,
        PUMPFUN,
        RAYDIUM_AMM,
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  # USDC
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",  # USDT
        "11111111111111111111111111111111",                # System
        "ComputeBudget111111111111111111111111111111",     # Compute budget
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", # Associated token
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",  # Token program
        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",  # Token-2022
        "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",  # Pump fee
        "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",  # Pump.fun (dup)
        "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",  # Metaplex
        "SysvarRent111111111111111111111111111111111",    # Sysvar
        "SysvarC1ock11111111111111111111111111111111",    # Sysvar clock
    }

    def _mint_from_logs(self, logs: list, source: str) -> Optional[str]:
        """
        Fallback: extract mint directly from WebSocket log strings.
        Only used when getTransaction hasn't indexed yet.

        Pump.fun token mints ALWAYS end with 'pump' — this is a protocol
        invariant, not a coincidence. No Solana program address ends in 'pump'.
        So for pumpfun source we can scan specifically for that pattern.
        """
        import re

        # For Pump.fun graduations: mint always ends in "pump"
        if source == "pumpfun":
            pump_re = re.compile(r'([1-9A-HJ-NP-Za-km-z]{32,44}pump)')
            for line in logs:
                for m in pump_re.finditer(line):
                    addr = m.group(1)
                    if addr not in self._KNOWN_PROGRAMS:
                        return addr

        # For Raydium: scan for 43-44 char base58 addresses not in known programs
        b58 = set("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")
        addr_re = re.compile(r'([1-9A-HJ-NP-Za-km-z]{43,44})')
        for line in logs:
            for m in addr_re.finditer(line):
                addr = m.group(1)
                if (addr not in self._KNOWN_PROGRAMS and
                        all(c in b58 for c in addr)):
                    return addr

        return None

# ─── BOT ─────────────────────────────────────────────────────────────────────

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

    async def run(self):
        log.info("=" * 55)
        log.info("  WINSTON v7-mod — Multi-Position Graduation Sniper")
        log.info(f"  {TRADE_AMOUNT_SOL} SOL/trade (~$1) | max {MAX_POSITIONS} positions")
        log.info(f"  Target: {PROFIT_TARGET_X}x (+{(PROFIT_TARGET_X-1)*100:.0f}%) | "
                 f"Timeout: {MAX_HOLD_MINUTES}min | Stop: {TRAILING_STOP_PCT}%")
        log.info(f"  Jupiter key: {'SET' if JUPITER_API_KEY else 'MISSING'}")
        log.info("=" * 55)

        async with aiohttp.ClientSession() as s:
            if self.sol.pubkey:
                bal = await self.sol.balance(s)
                log.info(f"Starting balance: {bal:.4f} SOL")

        await asyncio.gather(
            self.detector.listen(),
            self._trade_loop(),
            self._heartbeat(),
        )

    # ── MAIN TRADE LOOP ──────────────────────────────────────────────────────

    async def _trade_loop(self):
        """
        Picks tokens off the queue and opens positions concurrently.
        Up to MAX_POSITIONS trades running at the same time.
        Each position manages its own watch/exit in a separate task.
        """
        log.info("Trade loop ready — waiting for graduations")
        while True:
            token = await self.detector.queue.get()

            # Double-check slot available (queue could have backed up)
            if self.detector.locked:
                log.info(f"All {MAX_POSITIONS} slots full — dropping {token.mint[:16]}")
                continue

            # Fire and forget — each position runs independently
            asyncio.create_task(self._handle_token(token))

    async def _handle_token(self, token: Token):
        """Full lifecycle for one token: filter → buy → watch → sell."""
        try:
            passed = await self._filter(token)
            if not passed:
                log.info(f"SKIP {token.mint[:16]} — failed filters")
                return

            pos = await self._buy(token)
            if not pos:
                log.info(f"BUY FAILED for {token.symbol} — slot freed")
                return

            self.detector.add_position(token.mint)
            try:
                await self._watch(pos)
            finally:
                self.detector.remove_position(token.mint)
                log.info(f"Slot freed | active: {len(self.detector._held_mints)}/{MAX_POSITIONS} | "
                         f"Stats: {self.trades_won}W/{self.trades_lost}L | "
                         f"Net {self.total_pnl:+.5f} SOL")

        except Exception as e:
            log.error(f"Handle token error: {e}")
            import traceback; traceback.print_exc()
            self.detector.remove_position(token.mint)

    # ── FILTER ───────────────────────────────────────────────────────────────

    async def _filter(self, token: Token) -> bool:
        """Quick parallel filter — holder count, freeze, liquidity."""
        async with aiohttp.ClientSession() as sess:
            try:
                holder_task = asyncio.create_task(
                    self._rpc(sess, "getTokenLargestAccounts", [token.mint])
                )
                acct_task = asyncio.create_task(
                    self._rpc(sess, "getAccountInfo",
                              [token.mint, {"encoding": "jsonParsed"}])
                )
                liq_task = asyncio.create_task(
                    self.jup.order(WSOL, token.mint,
                                   int(0.005 * 1e9), self.sol.pubkey)
                )

                holders_res, acct_res, liq_order = await asyncio.gather(
                    holder_task, acct_task, liq_task, return_exceptions=True
                )

                # Holder count
                if isinstance(holders_res, Exception) or not holders_res:
                    log.info(f"SKIP {token.mint[:16]}: holder RPC failed")
                    return False
                holders = holders_res.get("result", {}).get("value", [])
                if len(holders) < 5:
                    log.info(f"SKIP {token.mint[:16]}: only {len(holders)} holders")
                    return False

                # Top holder concentration
                supply_res = await self._rpc(sess, "getTokenSupply", [token.mint])
                total = float(supply_res.get("result", {})
                                        .get("value", {})
                                        .get("amount", "0"))
                if total > 0 and holders:
                    top     = float(holders[0].get("amount", "0"))
                    top_pct = (top / total) * 100
                    if top_pct > MAX_TOP_HOLDER_PCT:
                        log.info(f"SKIP {token.mint[:16]}: top holder {top_pct:.0f}%")
                        return False

                # Freeze authority + grab name/symbol
                if not isinstance(acct_res, Exception) and acct_res:
                    acct = acct_res.get("result", {}).get("value", {})
                    if acct:
                        parsed = (acct.get("data", {})
                                      .get("parsed", {})
                                      .get("info", {}))
                        if parsed.get("freezeAuthority"):
                            log.info(f"SKIP {token.mint[:16]}: freeze authority")
                            return False
                        if parsed.get("symbol"): token.symbol = parsed["symbol"]
                        if parsed.get("name"):   token.name   = parsed["name"]

                # Liquidity check
                if (isinstance(liq_order, Exception) or not liq_order
                        or not liq_order.get("outAmount")):
                    log.info(f"SKIP {token.mint[:16]}: no liquidity")
                    return False

                # Fetch metadata from Pump.fun — always try, not just when ???
                try:
                    async with sess.get(
                        f"https://frontend-api.pump.fun/coins/{token.mint}",
                        timeout=aiohttp.ClientTimeout(total=4)
                    ) as r:
                        if r.status == 200:
                            meta = await r.json()
                            if meta.get("symbol"): token.symbol = meta["symbol"]
                            if meta.get("name"):   token.name   = meta["name"]
                except: pass

                label = token.symbol if token.symbol != "???" else (token.name[:10] if token.name != "Unknown" else token.mint[:8])
                log.info(f"PASS {label} ({token.mint[:16]}) — {len(holders)} holders")
                return True

            except Exception as e:
                log.warning(f"Filter error: {e}")
                return False

    # ── BUY ──────────────────────────────────────────────────────────────────

    async def _buy(self, token: Token) -> Optional[Position]:
        if not self.sol.pubkey:
            log.error("No wallet pubkey"); return None

        async with aiohttp.ClientSession() as sess:
            bal = await self.sol.balance(sess)

        if bal < TRADE_AMOUNT_SOL + 0.005:
            log.error(f"Low balance: {bal:.4f} SOL — need {TRADE_AMOUNT_SOL + 0.005:.4f}")
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

        # Wait for chain then get real price
        await asyncio.sleep(2)
        async with aiohttp.ClientSession() as sess:
            bal_after = await self.sol.balance(sess)

        tokens = out_amt / 1e6
        price  = await self.jup.price(token.mint)
        if not price:
            price = TRADE_AMOUNT_SOL / tokens if tokens > 0 else 0.0

        gas = max(0.0, (bal - bal_after) - TRADE_AMOUNT_SOL)

        pos = Position(
            token       = token,
            entry_price = price,
            tokens_held = tokens,
            cost_sol    = TRADE_AMOUNT_SOL,
            high_price  = price,
            stop_price  = price * (1 - TRAILING_STOP_PCT / 100),
        )
        await self.discord.bought(pos)
        log.info(f"BOUGHT {tokens:.0f} {token.symbol} @ ${price:.10f}")
        log.info(f"  Target: ${price * PROFIT_TARGET_X:.10f} | "
                 f"Stop: ${pos.stop_price:.10f} | Gas: {gas:.5f} SOL")
        return pos

    # ── WATCH + EXIT ──────────────────────────────────────────────────────────

    async def _watch(self, pos: Position):
        """
        Poll price every 1s.
        Exit on: profit target | timeout | trailing stop | price dead.
        If sell fails, keeps retrying until it goes through — position WILL close.
        """
        label = pos.token.symbol if pos.token.symbol != "???" else pos.token.mint[:8]
        log.info(f"WATCHING {label} — target {PROFIT_TARGET_X}x "
                 f"in {MAX_HOLD_MINUTES}min or stop out")
        price_fails = 0
        sell_reason = None
        sell_price  = pos.entry_price

        while True:
            await asyncio.sleep(1)

            # ── HARD TIMEOUT — enforce even if sell keeps failing ─────────────
            if pos.timed_out and not sell_reason:
                sell_reason = "timeout_2min"
                sell_price  = sell_price  # use last known price

            # ── If we have a sell reason, keep hammering until it works ───────
            if sell_reason:
                price = await self.jup.price(pos.token.mint) or sell_price
                success = await self._sell(pos, price, sell_reason)
                if success:
                    return
                # Sell failed — wait 3s and retry regardless of anything else
                log.warning(f"{label}: sell failed, retrying in 3s...")
                await asyncio.sleep(3)
                continue

            price = await self.jup.price(pos.token.mint)

            if not price:
                price_fails += 1
                if price_fails % 15 == 1:
                    log.warning(f"No price for {label} ({price_fails}x)")
                if price_fails >= 60:
                    log.error(f"Price dead 60s — force selling {label}")
                    sell_reason = "price_dead"
                    sell_price  = pos.entry_price
                continue

            price_fails = 0
            sell_price  = price  # keep updated for timeout/dead fallback
            gain_x = price / pos.entry_price if pos.entry_price > 0 else 1.0

            log.info(f"  {label:8s} ${price:.8f} "
                     f"({gain_x:.3f}x) stop=${pos.stop_price:.8f} "
                     f"held={pos.hold_mins:.1f}m")

            # ── Profit target ─────────────────────────────────────────────────
            if gain_x >= PROFIT_TARGET_X:
                log.info(f"TARGET HIT {gain_x:.3f}x — selling {label}!")
                sell_reason = f"profit_{gain_x:.2f}x"
                sell_price  = price
                continue

            # ── Timeout ───────────────────────────────────────────────────────
            if pos.timed_out:
                log.warning(f"TIMEOUT {pos.hold_mins:.1f}min — selling {label}")
                sell_reason = "timeout_2min"
                sell_price  = price
                continue

            # ── Update trailing stop ──────────────────────────────────────────
            if price > pos.high_price:
                pos.high_price = price
                pos.stop_price = price * (1 - TRAILING_STOP_PCT / 100)
                log.info(f"  NEW HIGH ${price:.8f} -> stop ${pos.stop_price:.8f}")

            # ── Trailing stop ─────────────────────────────────────────────────
            if pos.stop_price > 0 and price <= pos.stop_price:
                log.warning(f"STOP HIT ${price:.8f} ({gain_x:.2f}x) — selling {label}")
                sell_reason = "trailing_stop"
                sell_price  = price
                continue

    # ── SELL ─────────────────────────────────────────────────────────────────

    async def _get_real_token_balance(self, mint: str) -> tuple:
        """
        Fetch actual on-chain token balance from wallet.
        Returns (raw_amount, decimals) — the ground truth, not an estimate.
        """
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
                    ta = info.get("tokenAmount", {})
                    raw = int(ta.get("amount", 0))
                    dec = int(ta.get("decimals", 6))
                    if raw > 0:
                        log.info(f"Real balance: {raw} raw ({raw / 10**dec:.4f} tokens, {dec} decimals)")
                        return raw, dec
            except Exception as e:
                log.error(f"Balance fetch error: {e}")
        return 0, 6

    async def _sell(self, pos: Position, price: float, reason: str) -> bool:
        gain_x   = price / pos.entry_price if pos.entry_price > 0 else 1.0
        gain_pct = (gain_x - 1) * 100
        pnl_sol  = pos.cost_sol * gain_pct / 100  # correct: % applied to SOL spent
        log.info(f"SELLING 100% of {pos.token.symbol} — {reason} "
                 f"({gain_x:.3f}x, {pnl_sol:+.5f} SOL)")

        # Always fetch real on-chain balance first
        raw_amount, decimals = await self._get_real_token_balance(pos.token.mint)

        if raw_amount <= 0:
            # Fallback: estimate using actual decimals from token
            raw_amount = int(pos.tokens_held * (10 ** 6))
            log.warning(f"Using estimated balance: {raw_amount}")

        if raw_amount <= 0:
            log.error(f"Sell amount 0 for {pos.token.symbol} — cannot sell")
            return False

        log.info(f"Selling raw: {raw_amount} (decimals: {decimals})")

        # Try progressively smaller amounts — Jupiter may reject exact balance
        # due to rounding or fees held in the account
        amounts_to_try = [
            raw_amount,
            int(raw_amount * 0.99),
            int(raw_amount * 0.98),
            int(raw_amount * 0.95),
            int(raw_amount * 0.90),
        ]

        for attempt, amount in enumerate(amounts_to_try, 1):
            if amount <= 0:
                continue
            order = await self.jup.order(pos.token.mint, WSOL, amount, self.sol.pubkey)
            if order and order.get("transaction"):
                signed = self.sol.sign(order["transaction"])
                if signed:
                    result = await self.jup.execute(order["requestId"], signed)
                    if result:
                        if result.get("status") == "Failed":
                            err = result.get("error", "?")
                            log.error(f"Sell attempt {attempt} failed: {err}")
                        else:
                            sig = result.get("signature", "?")
                            log.info(f"SELL TX: {sig[:35]}...")
                            # Update stats
                            if pnl_sol >= 0:
                                self.trades_won += 1
                            else:
                                self.trades_lost += 1
                            self.total_pnl += pnl_sol
                            await self.discord.sold(pos, reason, gain_x, pnl_sol)
                            log.info(f"CLOSED {pos.token.symbol}: {gain_x:.3f}x | {pnl_sol:+.5f} SOL")
                            return True
            else:
                log.warning(f"No sell route attempt {attempt} — amount={amount}")

            if attempt < len(amounts_to_try):
                await asyncio.sleep(2)

        log.error(f"SELL FAILED all attempts — {pos.token.symbol} | mint={pos.token.mint}")
        return False

    # ── HELPERS ──────────────────────────────────────────────────────────────

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
            active  = len(self.detector._held_mints)
            sol_usd = await self.discord._fetch_sol_price()
            pnl_usd = self.total_pnl * sol_usd
            log.info(
                f"HEARTBEAT | up {uptime:.0f}m | "
                f"{active}/{MAX_POSITIONS} active | "
                f"{self.detector.count} seen | "
                f"{self.trades_won}W {self.trades_lost}L | "
                f"net {self.total_pnl:+.5f} SOL (${pnl_usd:+.2f})"
            )

if __name__ == "__main__":
    try:
        asyncio.run(Bot().run())
    except KeyboardInterrupt:
        log.info("Stopped")
