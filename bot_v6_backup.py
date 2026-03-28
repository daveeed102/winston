"""
DEGEN SNIPER v6 — Parallel Scanner, Fast Entry, Smart Exit
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
What's new vs v5:
  • Parallel token evaluation — up to 5 tokens screened simultaneously
    so a slow RPC call on one token doesn't block the others
  • Momentum check removed — was adding 4-10s of latency, buying tops
  • Liquidity check now runs concurrently with holder/freeze checks
  • 1.25x take-profit tier — sells 50% at +25%, locks profit early
  • 2-minute auto-sell — if no profit target hit, exits at 2 min
    (configurable via MAX_HOLD_MINUTES, separate from MAX_HOLD_HOURS)
  • Trailing stop tightens aggressively after 1.25x hit
  • Price polling drops to 1s (was 2s) for faster stop reaction
  • Heartbeat now every 60s with per-position P&L summary
"""

import asyncio
import json
import re
import time
import logging
import os
import base64 as b64
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Optional

import aiohttp

# ─── CONFIG ──────────────────────────────────────────────────────────────────

TRADE_AMOUNT_SOL  = float(os.getenv("TRADE_AMOUNT_SOL",  "0.007"))
TRAILING_STOP_PCT = float(os.getenv("TRAILING_STOP_PCT", "12"))
MAX_HOLD_HOURS    = float(os.getenv("MAX_HOLD_HOURS",    "0.75"))
MAX_HOLD_MINUTES  = float(os.getenv("MAX_HOLD_MINUTES",  "2"))
SLIPPAGE_BPS      = int(os.getenv("SLIPPAGE_BPS",        "500"))
DISCORD_WEBHOOK_URL  = os.getenv("DISCORD_WEBHOOK_URL",  "")
SOLANA_RPC_URL       = os.getenv("SOLANA_RPC_URL",       "")
WALLET_PRIVATE_KEY   = os.getenv("WALLET_PRIVATE_KEY",   "")
JUPITER_API_KEY      = os.getenv("JUPITER_API_KEY",      "")
BUY_DELAY_SECONDS    = float(os.getenv("BUY_DELAY_SECONDS", "0"))
MAX_TOP_HOLDER_PCT   = float(os.getenv("MAX_TOP_HOLDER_PCT", "50"))
MAX_OPEN_POSITIONS   = int(os.getenv("MAX_OPEN_POSITIONS",   "2"))
SCAN_CONCURRENCY     = int(os.getenv("SCAN_CONCURRENCY",     "5"))
TAKE_PROFIT_1_25X_PCT = float(os.getenv("TAKE_PROFIT_1_25X_PCT", "50"))

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
    status: str = "open"
    pnl_sol: float = 0.0
    exit_price: float = 0.0
    exit_reason: str = ""
    buy_gas: float = 0.0
    sell_gas: float = 0.0
    opened_ts: float = 0.0
    took_1_25x: bool = False
    took_1_5x: bool = False
    took_2x: bool = False
    took_3x: bool = False
    took_5x: bool = False
    took_10x: bool = False
    original_tokens: float = 0.0

    def __post_init__(self):
        if not self.opened_ts:       self.opened_ts = time.time()
        if not self.original_tokens: self.original_tokens = self.tokens_held

    @property
    def hold_secs(self): return time.time() - self.opened_ts

    @property
    def expired_minutes(self):
        return self.hold_secs >= MAX_HOLD_MINUTES * 60

    @property
    def expired_hours(self):
        return self.hold_secs >= MAX_HOLD_HOURS * 3600

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
                ssl=False, limit=20
            )
        except:
            conn = aiohttp.TCPConnector(ssl=False, limit=20)
        return aiohttp.ClientSession(connector=conn, headers=self._headers())

    async def price(self, mint):
        s = await self._sess()
        try:
            async with s.get(f"{JUP_PRICE}?ids={mint}", timeout=aiohttp.ClientTimeout(total=4)) as r:
                if r.status == 200:
                    d = await r.json()
                    p = d.get("data", {}).get(mint, {}).get("price")
                    if p: return float(p)
        except: pass
        finally: await s.close()

        s2 = await self._sess()
        try:
            params = {"inputMint": mint, "outputMint": WSOL, "amount": str(int(10000 * 1e6))}
            async with s2.get(JUP_ORDER, params=params, timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    d = await r.json()
                    out_sol = int(d.get("outAmount", "0")) / 1e9
                    if out_sol > 0: return out_sol / 10000
        except: pass
        finally: await s2.close()
        return None

    async def order(self, inp, out, amount, taker):
        s = await self._sess()
        try:
            params = {
                "inputMint": inp, "outputMint": out,
                "amount": str(amount), "taker": taker,
                "slippageBps": str(SLIPPAGE_BPS)
            }
            async with s.get(JUP_ORDER, params=params, timeout=aiohttp.ClientTimeout(total=12)) as r:
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
        self.ws = rpc.replace("https://", "wss://").replace("http://", "ws://")
        self.keypair = self.pubkey = None
        if pk:
            try:
                from solders.keypair import Keypair; import base58
                self.keypair = Keypair.from_bytes(base58.b58decode(pk))
                self.pubkey = str(self.keypair.pubkey())
                log.info(f"Wallet: {self.pubkey[:8]}...{self.pubkey[-4:]}")
            except Exception as e: log.error(f"Wallet: {e}")

    async def balance(self, sess):
        if not self.pubkey: return 0.0
        try:
            async with sess.post(self.rpc,
                json={"jsonrpc": "2.0", "id": 1, "method": "getBalance", "params": [self.pubkey]},
                timeout=aiohttp.ClientTimeout(total=10)) as r:
                d = await r.json(); return d.get("result", {}).get("value", 0) / 1e9
        except: return 0.0

    def sign(self, tx_b64):
        if not self.keypair: return None
        try:
            from solders.transaction import VersionedTransaction
            raw = b64.b64decode(tx_b64)
            txn = VersionedTransaction.from_bytes(raw)
            signed = VersionedTransaction(txn.message, [self.keypair])
            return b64.b64encode(bytes(signed)).decode()
        except Exception as e: log.error(f"Sign: {e}"); return None

# ─── DISCORD ─────────────────────────────────────────────────────────────────

class Discord:
    def __init__(self, url): self.url = url

    async def _send(self, payload):
        if not self.url: return
        try:
            async with aiohttp.ClientSession() as s:
                await s.post(self.url, json=payload, timeout=aiohttp.ClientTimeout(total=5))
        except: pass

    async def bought(self, p):
        await self._send({"embeds": [{
            "title": f"BOUGHT -- {p.token.symbol}",
            "color": 0x00FF88,
            "fields": [
                {"name": "Token",     "value": f"{p.token.name} ({p.token.mint[:20]})", "inline": False},
                {"name": "Price",     "value": f"${p.entry_price:.10f}",                "inline": True},
                {"name": "Spent",     "value": f"{p.cost_sol:.4f} SOL",                 "inline": True},
                {"name": "Auto-sell", "value": f"{MAX_HOLD_MINUTES}min timeout",         "inline": True},
                {"name": "Target",    "value": f"1.25x = +25%",                          "inline": True},
                {"name": "Link",      "value": f"https://solscan.io/token/{p.token.mint}", "inline": False},
            ]
        }]})

    async def sold(self, p, reason, pct):
        emoji = "GREEN" if p.pnl_sol >= 0 else "RED"
        await self._send({"embeds": [{
            "title": f"{emoji} SOLD {pct}% -- {p.token.symbol} ({reason})",
            "color": 0x00FF88 if p.pnl_sol >= 0 else 0xFF4444,
            "fields": [
                {"name": "P&L SOL", "value": f"{p.pnl_sol:+.6f} SOL",  "inline": True},
                {"name": "Buy",     "value": f"${p.entry_price:.10f}",   "inline": True},
                {"name": "Sell",    "value": f"${p.exit_price:.10f}",    "inline": True},
                {"name": "Held",    "value": f"{p.hold_secs/60:.1f}m",   "inline": True},
                {"name": "Reason",  "value": reason,                     "inline": True},
            ]
        }]})

    async def alert(self, msg):
        await self._send({"content": msg})

# ─── DETECTOR ────────────────────────────────────────────────────────────────

class Detector:
    def __init__(self, sol, callback):
        self.sol = sol
        self.callback = callback
        self.seen = set()
        self.count = 0

    async def listen(self):
        while True:
            try:
                log.info("Connecting WS...")
                async with aiohttp.ClientSession() as sess:
                    async with sess.ws_connect(self.sol.ws, heartbeat=30) as ws:
                        log.info("WebSocket connected")
                        await ws.send_json({"jsonrpc": "2.0", "id": 1, "method": "logsSubscribe",
                            "params": [{"mentions": [PUMPFUN]}, {"commitment": "confirmed"}]})
                        await ws.send_json({"jsonrpc": "2.0", "id": 2, "method": "logsSubscribe",
                            "params": [{"mentions": [RAYDIUM_AMM]}, {"commitment": "confirmed"}]})
                        log.info("Listening for new pools...")
                        async for msg in ws:
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                # Fire as task — never blocks the WS reader
                                asyncio.create_task(self._handle(msg.data))
                            elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSED):
                                break
            except Exception as e: log.error(f"WS: {e}")
            log.info("Reconnecting in 5s..."); await asyncio.sleep(5)

    async def _handle(self, raw):
        try:
            data = json.loads(raw)
            if "params" not in data: return
            value = data["params"]["result"].get("value", {})
            logs  = value.get("logs", [])
            sig   = value.get("signature", "")
            if not logs or not sig: return

            log_text = " ".join(logs)
            is_pumpfun = PUMPFUN in log_text and ("Withdraw" in log_text or "migrate" in log_text.lower())
            is_raydium = "initialize2" in log_text or "InitializeInstruction2" in log_text

            if not is_pumpfun and not is_raydium: return
            if sig in self.seen: return
            self.seen.add(sig)

            source = "pumpfun" if is_pumpfun else "raydium"
            log.info(f"NEW {source.upper()} pool (tx: {sig[:20]}...)")

            mint = None
            async with aiohttp.ClientSession() as sess:
                for attempt in range(5):
                    mint = await self._extract_mint(sig, sess)
                    if mint: break
                    await asyncio.sleep(2)

            if not mint or mint in self.seen:
                log.warning(f"No mint from {sig[:16]}")
                return

            self.seen.add(mint)
            self.count += 1
            token = Token(mint=mint, source=source)
            log.info(f"DETECTED {source.upper()} -> {mint[:24]}...")

            # Non-blocking — allows parallel evaluation of multiple tokens
            asyncio.create_task(self.callback(token))

        except Exception as e:
            log.warning(f"Handle: {e}")

    async def _extract_mint(self, sig, sess):
        try:
            payload = {"jsonrpc": "2.0", "id": 1, "method": "getTransaction",
                       "params": [sig, {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}]}
            async with sess.post(self.sol.rpc, json=payload, timeout=aiohttp.ClientTimeout(total=10)) as r:
                data = await r.json()
            tx = data.get("result")
            if not tx: return None
            meta = tx.get("meta", {})
            if not meta or meta.get("err"): return None
            skip = {WSOL, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"}
            for bal in meta.get("postTokenBalances", []):
                m = bal.get("mint", "")
                if m and m not in skip: return m
            for bal in meta.get("preTokenBalances", []):
                m = bal.get("mint", "")
                if m and m not in skip: return m
        except: pass
        return None

# ─── EXIT ENGINE ─────────────────────────────────────────────────────────────

class ExitEngine:
    """
    1s price polling. Exit ladder:
      1.25x -> sell 50%, trail tightens to 8%   <- PRIMARY TARGET (+25%)
      1.5x  -> sell 20%, trail tightens to 12%
      2x    -> sell 20%, trail tightens to 10%
      3x    -> sell 20%, trail tightens to 8%
      5x+   -> sell 100%
      2 min -> auto-sell 100%                   <- PRIMARY TIMEOUT
      trailing stop -> sell 100%
    """
    def __init__(self, jup, sol, discord):
        self.jup = jup
        self.sol = sol
        self.discord = discord
        self.positions = []

    def add(self, pos): self.positions.append(pos)

    @property
    def open_count(self): return len([p for p in self.positions if p.status == "open"])

    async def run(self):
        log.info(f"Exit engine: {TRAILING_STOP_PCT}pct trail | {MAX_HOLD_MINUTES}min auto-sell | 1s poll | 1.25x target")
        while True:
            for pos in [p for p in self.positions if p.status == "open"]:
                await self._check(pos)
            await asyncio.sleep(1)

    async def _check(self, pos):
        price = await self.jup.price(pos.token.mint)

        if not price:
            pos._price_fails = getattr(pos, "_price_fails", 0) + 1
            if pos._price_fails % 30 == 1:
                log.warning(f"No price for {pos.token.mint[:16]} ({pos._price_fails}x)")
            if pos._price_fails >= 60:
                log.error(f"Price dead 1min -- emergency sell {pos.token.symbol}")
                await self._sell(pos, pos.entry_price, "price_dead", 100)
            return

        pos._price_fails = 0
        pos._last_price = price
        gain_x = price / pos.entry_price if pos.entry_price > 0 else 1.0
        hold_m = pos.hold_secs / 60

        log.info(f"WATCH {pos.token.symbol[:8]:8s} ${price:.8f} ({gain_x:.3f}x) "
                 f"stop=${pos.stop_price:.8f} held={hold_m:.1f}m")

        # PRIMARY TIMEOUT: 2-minute auto-sell
        if pos.expired_minutes:
            log.warning(f"TIMEOUT {pos.token.symbol} {MAX_HOLD_MINUTES}min -- selling all ({gain_x:.2f}x)")
            await self._sell(pos, price, "timeout_2min", 100)
            return

        # Legacy hours fallback
        if pos.expired_hours:
            log.warning(f"TIMEOUT {pos.token.symbol} hours -- selling all")
            await self._sell(pos, price, "timeout_hours", 100)
            return

        # PROFIT LADDER
        if gain_x >= 10.0 and not pos.took_10x:
            pos.took_10x = True
            log.info(f"10x!! Selling 100% of {pos.token.symbol}")
            await self._sell(pos, price, "take_profit_10x", 100)
            return

        if gain_x >= 5.0 and not pos.took_5x:
            pos.took_5x = True
            log.info(f"5x! Selling 20% of {pos.token.symbol}")
            await self._sell(pos, price, "take_profit_5x", 20)
            pos.stop_price = pos.high_price * 0.92
            return

        if gain_x >= 3.0 and not pos.took_3x:
            pos.took_3x = True
            log.info(f"3x! Selling 20% of {pos.token.symbol}")
            await self._sell(pos, price, "take_profit_3x", 20)
            pos.stop_price = pos.high_price * 0.90
            return

        if gain_x >= 2.0 and not pos.took_2x:
            pos.took_2x = True
            log.info(f"2x! Selling 20% of {pos.token.symbol}")
            await self._sell(pos, price, "take_profit_2x", 20)
            pos.stop_price = pos.high_price * 0.88
            return

        if gain_x >= 1.5 and not pos.took_1_5x:
            pos.took_1_5x = True
            log.info(f"1.5x! Selling 20% of {pos.token.symbol}")
            await self._sell(pos, price, "take_profit_1_5x", 20)
            pos.stop_price = pos.high_price * 0.85
            return

        # PRIMARY TARGET: 1.25x = +25% gain, sell 50% immediately
        if gain_x >= 1.25 and not pos.took_1_25x:
            pos.took_1_25x = True
            pct = int(TAKE_PROFIT_1_25X_PCT)
            log.info(f"TARGET HIT 1.25x (+25%)! Selling {pct}% of {pos.token.symbol}")
            await self._sell(pos, price, "take_profit_1_25x", pct)
            pos.stop_price = pos.high_price * 0.92  # tighten to 8% trail
            return

        # Update high water mark + trailing stop
        if price > pos.high_price:
            pos.high_price = price
            if pos.took_5x:      trail = 0.93
            elif pos.took_3x:    trail = 0.90
            elif pos.took_2x:    trail = 0.88
            elif pos.took_1_5x:  trail = 0.85
            elif pos.took_1_25x: trail = 0.92
            else:                trail = 1 - TRAILING_STOP_PCT / 100
            pos.stop_price = price * trail
            log.info(f"NEW HIGH {pos.token.symbol} ${price:.8f} -> stop ${pos.stop_price:.8f}")

        # Trailing stop hit
        if pos.stop_price > 0 and price <= pos.stop_price:
            log.warning(f"STOP {pos.token.symbol} ${price:.8f} ({gain_x:.2f}x)")
            await self._sell(pos, price, "trailing_stop", 100)

    async def _sell(self, pos, price, reason, pct):
        if not pos.token.mint:
            log.error("No mint -- force closing position")
            pos.status = "closed"; pos.tokens_held = 0
            await self.discord.sold(pos, reason + "_no_mint", pct)
            return

        tokens_to_sell = pos.tokens_held * (pct / 100)
        pos.exit_price = price
        pos.exit_reason = reason
        sol_out_estimate = tokens_to_sell * price
        pos.pnl_sol = sol_out_estimate - (pos.cost_sol * pct / 100)

        log.info(f"SELL {pct}% of {pos.token.symbol} ({tokens_to_sell:.0f} tokens) reason={reason}")

        sell_succeeded = False
        amount = int(tokens_to_sell * 1e6)

        if amount <= 0:
            log.error(f"Sell amount is 0 for {pos.token.symbol} -- skipping")
            return

        if self.sol.pubkey:
            for attempt in range(1, 4):
                order = await self.jup.order(pos.token.mint, WSOL, amount, self.sol.pubkey)
                if order and order.get("transaction"):
                    signed = self.sol.sign(order["transaction"])
                    if signed:
                        result = await self.jup.execute(order["requestId"], signed)
                        if result:
                            if result.get("status") == "Failed":
                                err = result.get("error", "?")
                                log.error(f"Sell FAILED (attempt {attempt}): {err}")
                                log.error(f"Full result: {json.dumps(result)[:400]}")
                            else:
                                sig = result.get("signature", "?")
                                log.info(f"SELL TX: {sig[:30]}...")
                                sell_succeeded = True
                                break
                else:
                    log.warning(f"No sell route for {pos.token.symbol} attempt {attempt}/3 "
                                f"mint={pos.token.mint[:20]} amount={amount}")

                if not sell_succeeded and attempt < 3:
                    await asyncio.sleep(attempt * 2)

        if not sell_succeeded:
            log.error(f"SELL FAILED after 3 attempts -- {pos.token.symbol}")
            log.error(f"  mint={pos.token.mint}")
            log.error(f"  tokens_to_sell={tokens_to_sell:.0f} amount_raw={amount}")
            return

        pos.tokens_held -= tokens_to_sell
        if pct >= 100 or pos.tokens_held <= 1:
            pos.status = "closed"

        await self.discord.sold(pos, reason, pct)
        if pos.status == "closed":
            log.info(f"CLOSED {pos.token.symbol}: {pos.pnl_sol:+.6f} SOL")

# ─── BOT ─────────────────────────────────────────────────────────────────────

class Bot:
    def __init__(self):
        self.sol      = Solana(SOLANA_RPC_URL, WALLET_PRIVATE_KEY)
        self.jup      = Jupiter()
        self.discord  = Discord(DISCORD_WEBHOOK_URL)
        self.exits    = ExitEngine(self.jup, self.sol, self.discord)
        self.detector = Detector(self.sol, self._on_token)
        self.start    = time.time()
        self._scan_sem     = asyncio.Semaphore(SCAN_CONCURRENCY)
        self._buying_mints = set()

    async def run(self):
        log.info("=" * 55)
        log.info("  DEGEN SNIPER v6 -- Parallel Scanner")
        log.info(f"  {TRADE_AMOUNT_SOL} SOL/trade | {TRAILING_STOP_PCT}pct trail")
        log.info(f"  {MAX_HOLD_MINUTES}min auto-sell | {MAX_OPEN_POSITIONS} max positions")
        log.info(f"  {SCAN_CONCURRENCY} parallel scan slots | 1.25x = +25% target")
        log.info(f"  Jupiter: {'YES' if JUPITER_API_KEY else 'NO KEY'}")
        log.info("=" * 55)
        async with aiohttp.ClientSession() as s:
            if self.sol.pubkey:
                b = await self.sol.balance(s)
                log.info(f"Balance: {b:.4f} SOL")
        await asyncio.gather(
            self.detector.listen(),
            self.exits.run(),
            self._heartbeat()
        )

    async def _on_token(self, token):
        async with self._scan_sem:
            if self.exits.open_count >= MAX_OPEN_POSITIONS:
                log.info(f"SKIP {token.mint[:16]}: max positions open")
                return
            if token.mint in self._buying_mints:
                log.info(f"SKIP {token.mint[:16]}: already evaluating")
                return
            self._buying_mints.add(token.mint)
            try:
                await self._filter_and_buy(token)
            finally:
                self._buying_mints.discard(token.mint)

    async def _filter_and_buy(self, token):
        async with aiohttp.ClientSession() as sess:
            try:
                # Run all checks in parallel -- saves ~2-3s vs sequential
                holder_task = asyncio.create_task(
                    self._rpc(sess, "getTokenLargestAccounts", [token.mint])
                )
                acct_task = asyncio.create_task(
                    self._rpc(sess, "getAccountInfo", [token.mint, {"encoding": "jsonParsed"}])
                )
                liq_task = asyncio.create_task(
                    self.jup.order(WSOL, token.mint, int(0.005 * 1e9), self.sol.pubkey)
                )

                holders_res, acct_res, liq_order = await asyncio.gather(
                    holder_task, acct_task, liq_task, return_exceptions=True
                )

                # Holder count check
                if isinstance(holders_res, Exception) or not holders_res:
                    log.info(f"SKIP {token.mint[:16]}: holder check failed")
                    return
                holders = holders_res.get("result", {}).get("value", [])
                holder_count = len(holders)
                if holder_count < 5:
                    log.info(f"SKIP {token.mint[:16]}: only {holder_count} holders")
                    return

                # Top holder check
                supply_res = await self._rpc(sess, "getTokenSupply", [token.mint])
                total = float(supply_res.get("result", {}).get("value", {}).get("amount", "0"))
                if total > 0 and holders:
                    top = float(holders[0].get("amount", "0"))
                    top_pct = (top / total) * 100
                    if top_pct > MAX_TOP_HOLDER_PCT:
                        log.info(f"SKIP {token.mint[:16]}: top holder {top_pct:.0f}pct")
                        return

                # Freeze authority check + grab metadata
                if not isinstance(acct_res, Exception) and acct_res:
                    acct = acct_res.get("result", {}).get("value", {})
                    if acct:
                        parsed = acct.get("data", {}).get("parsed", {}).get("info", {})
                        if parsed.get("freezeAuthority"):
                            log.info(f"SKIP {token.mint[:16]}: freeze authority active")
                            return
                        if parsed.get("symbol"): token.symbol = parsed["symbol"]
                        if parsed.get("name"):   token.name   = parsed["name"]

                # Liquidity check
                if isinstance(liq_order, Exception) or not liq_order or not liq_order.get("outAmount"):
                    log.info(f"SKIP {token.mint[:16]}: no liquidity route")
                    return

                # Metadata fallback (non-blocking best-effort)
                if token.symbol == "???" or token.name == "Unknown":
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

                log.info(f"PASS {token.symbol} ({token.mint[:16]}) {holder_count} holders -- buying!")

            except Exception as e:
                log.warning(f"Filter err: {e}")

        if BUY_DELAY_SECONDS > 0:
            await asyncio.sleep(BUY_DELAY_SECONDS)

        if self.exits.open_count >= MAX_OPEN_POSITIONS:
            log.info(f"SKIP {token.symbol}: positions filled while filtering")
            return

        await self._buy(token)

    async def _rpc(self, sess, method, params):
        try:
            async with sess.post(
                self.sol.rpc,
                json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
                timeout=aiohttp.ClientTimeout(total=8)
            ) as r:
                return await r.json()
        except:
            return {}

    async def _buy(self, token):
        if not token.mint: log.error("Buy aborted -- no mint"); return
        if not self.sol.pubkey: return

        async with aiohttp.ClientSession() as sess:
            bal = await self.sol.balance(sess)

        if bal < TRADE_AMOUNT_SOL + 0.005:
            log.error(f"Low SOL: {bal:.4f}"); return

        lamports = int(TRADE_AMOUNT_SOL * 1e9)
        order = await self.jup.order(WSOL, token.mint, lamports, self.sol.pubkey)
        if not order: log.info(f"No buy route for {token.mint[:16]}"); return

        tx_b64  = order.get("transaction", "")
        req_id  = order.get("requestId", "")
        out_amt = int(order.get("outAmount", "0"))

        if not tx_b64 or not req_id: log.error("Bad order response"); return

        signed = self.sol.sign(tx_b64)
        if not signed: return

        result = await self.jup.execute(req_id, signed)
        if not result: log.error("Execute failed"); return

        if result.get("status") == "Failed":
            log.error(f"Swap failed: {result.get('error', '?')}"); return

        sig = result.get("signature", "?")
        log.info(f"BUY TX: {sig[:30]}...")

        await asyncio.sleep(2)
        async with aiohttp.ClientSession() as sess:
            bal_after = await self.sol.balance(sess)

        tokens = out_amt / 1e6
        price  = await self.jup.price(token.mint)
        if not price:
            price = TRADE_AMOUNT_SOL / tokens if tokens > 0 else 0

        gas = max(0, (bal - bal_after) - TRADE_AMOUNT_SOL)

        pos = Position(
            token=token,
            entry_price=price,
            tokens_held=tokens,
            original_tokens=tokens,
            cost_sol=TRADE_AMOUNT_SOL,
            high_price=price,
            stop_price=price * (1 - TRAILING_STOP_PCT / 100),
            buy_gas=gas,
        )
        self.exits.add(pos)
        await self.discord.bought(pos)
        log.info(f"BOUGHT {tokens:.0f} {token.symbol} @ ${price:.10f} | stop ${pos.stop_price:.10f}")

    async def _heartbeat(self):
        while True:
            await asyncio.sleep(60)
            open_pos = [p for p in self.exits.positions if p.status == "open"]
            log.info(f"HEARTBEAT: {self.detector.count} tokens seen | {len(open_pos)} open | "
                     f"{(time.time()-self.start)/60:.0f}m running")
            for p in open_pos:
                gx_str = ""
                if hasattr(p, "_last_price") and p._last_price and p.entry_price:
                    gx_str = f" {p._last_price / p.entry_price:.2f}x"
                log.info(f"  -> {p.token.symbol:8s} held {p.hold_secs/60:.1f}m{gx_str}")

if __name__ == "__main__":
    try:
        asyncio.run(Bot().run())
    except KeyboardInterrupt:
        log.info("Stopped")
