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

TRADE_AMOUNT_SOL  = float(os.getenv("TRADE_AMOUNT_SOL",   "0.061"))
TRAILING_STOP_PCT = float(os.getenv("TRAILING_STOP_PCT",  "25"))   # wider — memecoins are volatile   # % below entry/high before bail
MAX_HOLD_MINUTES  = float(os.getenv("MAX_HOLD_MINUTES",   "2"))    # hard timeout
SLIPPAGE_BPS      = int(os.getenv("SLIPPAGE_BPS",         "500"))
PROFIT_TARGET_X   = float(os.getenv("PROFIT_TARGET_X",    "1.25")) # sell ALL at 1.25x
MIN_MOMENTUM_PCT  = float(os.getenv("MIN_MOMENTUM_PCT",   "5"))   # min % rise in 3s before buying

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
    def __init__(self, url): self.url = url

    async def send(self, payload):
        if not self.url: return
        try:
            async with aiohttp.ClientSession() as s:
                await s.post(self.url, json=payload,
                             timeout=aiohttp.ClientTimeout(total=5))
        except: pass

    async def bought(self, p: Position):
        await self.send({"embeds": [{
            "title": f"BOUGHT {p.token.symbol}",
            "color": 0x00AAFF,
            "fields": [
                {"name": "Entry",    "value": f"${p.entry_price:.10f}", "inline": True},
                {"name": "Spent",    "value": f"{p.cost_sol:.4f} SOL",  "inline": True},
                {"name": "Target",   "value": f"+25% ({PROFIT_TARGET_X}x)", "inline": True},
                {"name": "Timeout",  "value": f"{MAX_HOLD_MINUTES}min",  "inline": True},
                {"name": "Stop",     "value": f"{TRAILING_STOP_PCT}% trail", "inline": True},
                {"name": "Token",    "value": f"[Solscan](https://solscan.io/token/{p.token.mint})", "inline": False},
            ]
        }]})

    async def sold(self, p: Position, reason: str, gain_x: float, pnl_sol: float):
        color  = 0x00FF88 if pnl_sol >= 0 else 0xFF4444
        emoji  = "PROFIT" if pnl_sol >= 0 else "LOSS"
        await self.send({"embeds": [{
            "title": f"{emoji} SOLD {p.token.symbol} — {reason}",
            "color": color,
            "fields": [
                {"name": "Result",  "value": f"{gain_x:.3f}x  ({pnl_sol:+.5f} SOL)", "inline": False},
                {"name": "Entry",   "value": f"${p.entry_price:.10f}",                "inline": True},
                {"name": "Held",    "value": f"{p.hold_mins:.1f}min",                 "inline": True},
                {"name": "Reason",  "value": reason,                                  "inline": True},
            ]
        }]})

    async def info(self, msg: str):
        await self.send({"content": msg})

# ─── DETECTOR ────────────────────────────────────────────────────────────────

class Detector:
    """
    Listens to Pump.fun + Raydium WebSocket logs.
    When locked=True the bot already has a position — all incoming tokens
    are silently dropped so we stay focused on the live trade.
    """
    def __init__(self, sol):
        self.sol   = sol
        self.seen  = set()
        self.count = 0
        self.queue = asyncio.Queue()  # tokens ready to evaluate
        self.locked = False            # True while a position is open

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
                                asyncio.create_task(self._handle(msg.data))
                            elif msg.type in (aiohttp.WSMsgType.ERROR,
                                             aiohttp.WSMsgType.CLOSED):
                                break
            except Exception as e:
                log.error(f"WS error: {e}")
            log.info("WS disconnected — reconnecting in 5s")
            await asyncio.sleep(5)

    async def _handle(self, raw):
        # Drop immediately if locked — we have a position, don't care
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

            # Only process Pump.fun events
            if PUMPFUN not in log_text: return

            # Detect Pump.fun GRADUATION events — this is when a coin
            # migrates from Pump.fun to Raydium and gets real liquidity added.
            # This is a consistent pump trigger: bots and traders pile in
            # at graduation, creating momentum we can ride.
            # "Withdraw" + PUMPFUN = graduation/migration to Raydium.
            # Also catch Raydium pool initializations directly.
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

            # Strategy 1: getTransaction (most reliable — RPC tells us exactly
            # which token moved). Retry up to 5x with short waits.
            mint = None
            async with aiohttp.ClientSession() as sess:
                for attempt in range(10):
                    mint = await self._extract_mint(sig, sess)
                    if mint:
                        log.info(f"Mint via getTransaction (attempt {attempt+1}): {mint[:20]}...")
                        break
                    await asyncio.sleep(2)

            # Strategy 2: Parse directly from the WebSocket log strings.
            # Pump.fun graduation logs always contain the token mint address
            # ending in "pump". We scan specifically for that pattern.
            if not mint:
                mint = self._mint_from_logs(logs, source)
                if mint:
                    log.info(f"Mint via log scan: {mint[:20]}...")

            if not mint:
                log.warning(f"No mint from {sig[:16]} — skipping")
                return

            if mint in self.seen:
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
        log.info("  DEGEN SNIPER v7 — One At A Time")
        log.info(f"  {TRADE_AMOUNT_SOL} SOL/trade")
        log.info(f"  Target: {PROFIT_TARGET_X}x (+25%) — sell ALL")
        log.info(f"  Timeout: {MAX_HOLD_MINUTES}min | Stop: {TRAILING_STOP_PCT}%")
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
        Single sequential loop:
          wait for token -> filter -> buy -> watch -> sell -> repeat
        While a position is open, detector.locked = True so no new
        tokens are queued.
        """
        log.info("Trade loop ready — waiting for first token")
        while True:
            # Block until a token arrives
            token = await self.detector.queue.get()

            # Lock — stop queueing new tokens
            self.detector.locked = True
            log.info(f"LOCKED IN on {token.mint[:20]}... — ignoring other tokens")

            try:
                # Filter
                passed = await self._filter(token)
                if not passed:
                    log.info(f"SKIP {token.mint[:16]} — failed filters, looking again")
                    self.detector.locked = False
                    continue

                # 3-second momentum check — uses LIVE AMM quotes, not cached price API
                # quote_price() hits the AMM directly so both readings are fresh
                log.info(f"Momentum check: {token.symbol} ({token.mint[:16]}) — sampling live AMM...")
                price_t0 = await self.jup.quote_price(token.mint)
                log.info(f"  t=0s price: {price_t0:.12f} SOL" if price_t0 else "  t=0s price: NO DATA")
                await asyncio.sleep(3)
                price_t3 = await self.jup.quote_price(token.mint)
                log.info(f"  t=3s price: {price_t3:.12f} SOL" if price_t3 else "  t=3s price: NO DATA")

                if price_t0 and price_t3:
                    move_pct = ((price_t3 - price_t0) / price_t0) * 100
                    log.info(f"  movement: {move_pct:+.2f}% (need {MIN_MOMENTUM_PCT}%+)")
                    if move_pct < MIN_MOMENTUM_PCT:
                        log.info(f"SKIP {token.symbol}: {move_pct:.2f}% < {MIN_MOMENTUM_PCT}% threshold — unlocking")
                        self.detector.locked = False
                        continue
                    log.info(f"MOMENTUM CONFIRMED {token.symbol}: +{move_pct:.2f}% in 3s — BUYING!")
                elif price_t0 and not price_t3:
                    log.info(f"SKIP {token.symbol}: lost price feed at t=3s — liquidity dried up, unlocking")
                    self.detector.locked = False
                    continue
                else:
                    log.info(f"SKIP {token.symbol}: no AMM price at t=0 — not yet liquid, unlocking")
                    self.detector.locked = False
                    continue

                # Buy
                pos = await self._buy(token)
                if not pos:
                    log.info(f"BUY FAILED for {token.symbol} — unlocking, looking again")
                    self.detector.locked = False
                    continue

                # Watch until exit
                await self._watch(pos)

            except Exception as e:
                log.error(f"Trade loop error: {e}")
                import traceback; traceback.print_exc()
            finally:
                # Always unlock — even if something crashes
                self.detector.locked = False
                log.info("UNLOCKED — scanning for next coin")
                # Drain stale tokens that queued during the trade
                while not self.detector.queue.empty():
                    try: self.detector.queue.get_nowait()
                    except: break
                log.info(f"Stats: {self.trades_won}W / {self.trades_lost}L | "
                         f"Net {self.total_pnl:+.5f} SOL")

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

                # Best-effort metadata from Pump.fun
                if token.symbol == "???":
                    try:
                        async with sess.get(
                            f"https://frontend-api.pump.fun/coins/{token.mint}",
                            timeout=aiohttp.ClientTimeout(total=3)
                        ) as r:
                            if r.status == 200:
                                meta = await r.json()
                                if meta.get("symbol"): token.symbol = meta["symbol"]
                                if meta.get("name"):   token.name   = meta["name"]
                    except: pass

                log.info(f"PASS {token.symbol} ({token.mint[:16]}) — {len(holders)} holders")
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
        Exit on: 1.25x target hit | 2-min timeout | trailing stop.
        """
        log.info(f"WATCHING {pos.token.symbol} — target {PROFIT_TARGET_X}x "
                 f"in {MAX_HOLD_MINUTES}min or stop out")
        price_fails = 0

        while True:
            await asyncio.sleep(1)

            price = await self.jup.price(pos.token.mint)

            if not price:
                price_fails += 1
                if price_fails % 15 == 1:
                    log.warning(f"No price for {pos.token.symbol} ({price_fails}x)")
                # If price totally dead for 1 min, emergency sell
                if price_fails >= 60:
                    log.error(f"Price dead 60s — emergency sell {pos.token.symbol}")
                    await self._sell(pos, pos.entry_price, "price_dead")
                    return
                continue

            price_fails = 0
            gain_x = price / pos.entry_price if pos.entry_price > 0 else 1.0

            log.info(f"  {pos.token.symbol:8s} ${price:.8f} "
                     f"({gain_x:.3f}x) stop=${pos.stop_price:.8f} "
                     f"held={pos.hold_mins:.1f}m")

            # ── EXIT 1: Profit target hit ─────────────────────────────────
            if gain_x >= PROFIT_TARGET_X:
                log.info(f"TARGET HIT {gain_x:.3f}x — selling all {pos.token.symbol}!")
                await self._sell(pos, price, f"profit_{gain_x:.2f}x")
                return

            # ── EXIT 2: 2-minute timeout ──────────────────────────────────
            if pos.timed_out:
                log.warning(f"TIMEOUT {pos.hold_mins:.1f}min — selling {pos.token.symbol} ({gain_x:.2f}x)")
                await self._sell(pos, price, "timeout_2min")
                return

            # ── UPDATE trailing stop ──────────────────────────────────────
            if price > pos.high_price:
                pos.high_price = price
                pos.stop_price = price * (1 - TRAILING_STOP_PCT / 100)
                log.info(f"  NEW HIGH ${price:.8f} -> stop ${pos.stop_price:.8f}")

            # ── EXIT 3: Trailing stop ─────────────────────────────────────
            if pos.stop_price > 0 and price <= pos.stop_price:
                log.warning(f"STOP HIT ${price:.8f} ({gain_x:.2f}x) — "
                            f"selling {pos.token.symbol}")
                await self._sell(pos, price, "trailing_stop")
                return

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

    async def _sell(self, pos: Position, price: float, reason: str):
        gain_x  = price / pos.entry_price if pos.entry_price > 0 else 1.0
        pnl_sol = (price * pos.tokens_held) - pos.cost_sol
        log.info(f"SELLING 100% of {pos.token.symbol} — {reason} "
                 f"({gain_x:.3f}x, {pnl_sol:+.5f} SOL)")

        # Always fetch REAL on-chain balance — never trust the estimate
        # This is the fix for partial sells
        raw_amount, decimals = await self._get_real_token_balance(pos.token.mint)

        if raw_amount <= 0:
            # Fallback to estimate if RPC fails
            raw_amount = int(pos.tokens_held * (10 ** 6))
            log.warning(f"Could not fetch real balance — using estimate: {raw_amount}")

        if raw_amount <= 0:
            log.error(f"Sell amount is 0 for {pos.token.symbol} — cannot sell"); return

        log.info(f"Selling raw amount: {raw_amount} (decimals: {decimals})")

        sell_succeeded = False

        # Up to 5 attempts — keep trying until it goes through
        for attempt in range(1, 6):
            order = await self.jup.order(
                pos.token.mint, WSOL, raw_amount, self.sol.pubkey
            )
            if order and order.get("transaction"):
                signed = self.sol.sign(order["transaction"])
                if signed:
                    result = await self.jup.execute(order["requestId"], signed)
                    if result:
                        if result.get("status") == "Failed":
                            err = result.get("error", "?")
                            log.error(f"Sell attempt {attempt} failed: {err}")
                            log.error(f"Full: {json.dumps(result)[:300]}")
                            # If "insufficient funds" try with 98% of balance
                            if "insufficient" in str(err).lower() or attempt == 3:
                                raw_amount = int(raw_amount * 0.98)
                                log.warning(f"Retrying with 98% amount: {raw_amount}")
                        else:
                            sig = result.get("signature", "?")
                            log.info(f"SELL TX: {sig[:35]}...")
                            sell_succeeded = True
                            break
            else:
                log.warning(f"No sell route attempt {attempt}/5 — "
                            f"mint={pos.token.mint[:20]} amount={raw_amount}")

            if not sell_succeeded and attempt < 5:
                wait = min(attempt * 2, 6)
                log.info(f"Retrying sell in {wait}s...")
                await asyncio.sleep(wait)

        if not sell_succeeded:
            log.error(f"SELL FAILED after 5 attempts — {pos.token.symbol}")
            log.error(f"  mint={pos.token.mint}")
            log.error(f"  raw_amount={raw_amount}")
            return

        # Update session stats
        if pnl_sol >= 0:
            self.trades_won += 1
        else:
            self.trades_lost += 1
        self.total_pnl += pnl_sol

        await self.discord.sold(pos, reason, gain_x, pnl_sol)
        log.info(f"CLOSED {pos.token.symbol}: {gain_x:.3f}x | {pnl_sol:+.5f} SOL")

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
            uptime = (time.time() - self.start) / 60
            status = "LOCKED IN" if self.detector.locked else "SCANNING"
            log.info(f"HEARTBEAT [{status}] | up {uptime:.0f}m | "
                     f"{self.detector.count} tokens seen | "
                     f"{self.trades_won}W {self.trades_lost}L | "
                     f"net {self.total_pnl:+.5f} SOL")

if __name__ == "__main__":
    try:
        asyncio.run(Bot().run())
    except KeyboardInterrupt:
        log.info("Stopped")
