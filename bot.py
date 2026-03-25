"""
DEGEN SNIPER v5 — No getTransaction, no delays
Extracts token mints DIRECTLY from WebSocket log data.
Pump.fun mints end with 'pump' — dead simple to identify.
Buys via Jupiter Swap V2 (api.jup.ag).
Exit engine: 2s polling, take-profit tiers, trailing stop.
"""

import asyncio
import json
import re
import time
import logging
import os
import base64 as b64
from datetime import datetime, timezone
from dataclasses import dataclass
from typing import Optional

import aiohttp

# ─── CONFIG ──────────────────────────────────────────────────────────────────

TRADE_AMOUNT_SOL = float(os.getenv("TRADE_AMOUNT_SOL", "0.07"))
TRAILING_STOP_PCT = float(os.getenv("TRAILING_STOP_PCT", "20"))
MAX_HOLD_HOURS = float(os.getenv("MAX_HOLD_HOURS", "1"))
SLIPPAGE_BPS = int(os.getenv("SLIPPAGE_BPS", "500"))
DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "")
SOLANA_RPC_URL = os.getenv("SOLANA_RPC_URL", "")
WALLET_PRIVATE_KEY = os.getenv("WALLET_PRIVATE_KEY", "")
JUPITER_API_KEY = os.getenv("JUPITER_API_KEY", "")
BUY_DELAY_SECONDS = float(os.getenv("BUY_DELAY_SECONDS", "1"))
MAX_TOP_HOLDER_PCT = float(os.getenv("MAX_TOP_HOLDER_PCT", "50"))
MAX_OPEN_POSITIONS = int(os.getenv("MAX_OPEN_POSITIONS", "2"))

PUMPFUN = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
RAYDIUM_AMM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
WSOL = "So11111111111111111111111111111111111111112"

JUP_ORDER = "https://api.jup.ag/swap/v2/order"
JUP_EXECUTE = "https://api.jup.ag/swap/v2/execute"
JUP_PRICE = "https://api.jup.ag/price/v2"

# Regex to find Pump.fun mint addresses (end with "pump", 32-44 chars base58)
PUMP_MINT_RE = re.compile(r'[1-9A-HJ-NP-Za-km-z]{30,43}pump')

logging.basicConfig(level=logging.INFO, format="%(asctime)s │ %(levelname)-7s │ %(message)s", datefmt="%H:%M:%S")
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
    pnl_usd: float = 0.0
    exit_price: float = 0.0
    exit_reason: str = ""
    buy_gas: float = 0.0
    sell_gas: float = 0.0
    opened_ts: float = 0.0
    took_2x: bool = False
    took_3x: bool = False
    original_tokens: float = 0.0
    def __post_init__(self):
        if not self.opened_ts: self.opened_ts = time.time()
        if not self.original_tokens: self.original_tokens = self.tokens_held
    @property
    def hold_secs(self): return time.time() - self.opened_ts
    @property
    def expired(self): return self.hold_secs >= MAX_HOLD_HOURS * 3600

# ─── JUPITER ─────────────────────────────────────────────────────────────────

class Jupiter:
    async def _sess(self):
        headers = {"Content-Type": "application/json"}
        if JUPITER_API_KEY: headers["x-api-key"] = JUPITER_API_KEY
        try:
            from aiohttp.resolver import AsyncResolver
            conn = aiohttp.TCPConnector(resolver=AsyncResolver(nameservers=["8.8.8.8","1.1.1.1"]), ssl=False)
        except: conn = aiohttp.TCPConnector(ssl=False)
        return aiohttp.ClientSession(connector=conn, headers=headers)

    async def price(self, mint):
        s = await self._sess()
        try:
            async with s.get(f"{JUP_PRICE}?ids={mint}", timeout=aiohttp.ClientTimeout(total=8)) as r:
                if r.status == 200:
                    d = await r.json()
                    p = d.get("data",{}).get(mint,{}).get("price")
                    return float(p) if p else None
                else:
                    log.warning(f"Price API {r.status} for {mint[:16]}")
        except Exception as e:
            log.warning(f"Price err: {e}")
        finally: await s.close()
        return None

    async def order(self, inp, out, amount, taker):
        s = await self._sess()
        try:
            async with s.get(JUP_ORDER, params={"inputMint":inp,"outputMint":out,"amount":str(amount),"taker":taker}, timeout=aiohttp.ClientTimeout(total=12)) as r:
                if r.status == 200: return await r.json()
                log.error(f"Jup order {r.status}: {(await r.text())[:120]}")
        except Exception as e: log.error(f"Jup order: {e}")
        finally: await s.close()
        return None

    async def execute(self, req_id, signed_b64):
        s = await self._sess()
        try:
            async with s.post(JUP_EXECUTE, json={"signedTransaction":signed_b64,"requestId":req_id}, timeout=aiohttp.ClientTimeout(total=30)) as r:
                if r.status == 200: return await r.json()
                log.error(f"Jup exec {r.status}: {(await r.text())[:120]}")
        except Exception as e: log.error(f"Jup exec: {e}")
        finally: await s.close()
        return None

# ─── SOLANA ──────────────────────────────────────────────────────────────────

class Solana:
    def __init__(self, rpc, pk):
        self.rpc = rpc
        self.ws = rpc.replace("https://","wss://").replace("http://","ws://")
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
            async with sess.post(self.rpc, json={"jsonrpc":"2.0","id":1,"method":"getBalance","params":[self.pubkey]}, timeout=aiohttp.ClientTimeout(total=10)) as r:
                d = await r.json(); return d.get("result",{}).get("value",0)/1e9
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
    async def _send(self, embed):
        if not self.url: return
        try:
            async with aiohttp.ClientSession() as s: await s.post(self.url, json={"embeds":[embed]})
        except: pass

    async def bought(self, p):
        await self._send({"title":f"💰 BOUGHT — {p.token.symbol}","color":0x00FF88,"fields":[
            {"name":"Token","value":f"{p.token.name} (`{p.token.mint[:20]}`)","inline":False},
            {"name":"Price","value":f"${p.entry_price:.10f}","inline":True},
            {"name":"Spent","value":f"{p.cost_sol:.4f} SOL","inline":True},
            {"name":"Gas","value":f"{p.buy_gas:.5f} SOL","inline":True},
            {"name":"Link","value":f"[Solscan](https://solscan.io/token/{p.token.mint})","inline":False}]})

    async def sold(self, p, reason, pct):
        emoji = "🟢" if p.pnl_usd >= 0 else "🔴"
        await self._send({"title":f"{emoji} SOLD {pct}% — {p.token.symbol} ({reason})","color":0x00FF88 if p.pnl_usd>=0 else 0xFF4444,"fields":[
            {"name":"P&L","value":f"${p.pnl_usd:+.4f}","inline":True},
            {"name":"Buy","value":f"${p.entry_price:.10f}","inline":True},
            {"name":"Sell","value":f"${p.exit_price:.10f}","inline":True},
            {"name":"Gas","value":f"{p.buy_gas+p.sell_gas:.5f} SOL","inline":True},
            {"name":"Held","value":f"{p.hold_secs/60:.1f}m","inline":True}]})

# ─── POOL DETECTOR (no getTransaction!) ─────────────────────────────────────

class Detector:
    def __init__(self, sol, callback):
        self.sol = sol
        self.callback = callback
        self.seen = set()
        self.count = 0

    async def listen(self):
        while True:
            try:
                log.info(f"Connecting WS...")
                async with aiohttp.ClientSession() as sess:
                    async with sess.ws_connect(self.sol.ws, heartbeat=30) as ws:
                        log.info("✅ WebSocket connected")
                        await ws.send_json({"jsonrpc":"2.0","id":1,"method":"logsSubscribe",
                            "params":[{"mentions":[PUMPFUN]},{"commitment":"confirmed"}]})
                        await ws.send_json({"jsonrpc":"2.0","id":2,"method":"logsSubscribe",
                            "params":[{"mentions":[RAYDIUM_AMM]},{"commitment":"confirmed"}]})
                        log.info("📡 Listening...")
                        async for msg in ws:
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                await self._handle(msg.data)
                            elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSED):
                                break
            except Exception as e: log.error(f"WS: {e}")
            log.info("Reconnecting 5s..."); await asyncio.sleep(5)

    async def _handle(self, raw):
        try:
            data = json.loads(raw)
            if "params" not in data: return
            value = data["params"]["result"].get("value",{})
            logs = value.get("logs",[])
            sig = value.get("signature","")
            if not logs or not sig: return

            log_text = " ".join(logs)

            is_pumpfun = PUMPFUN in log_text and ("Withdraw" in log_text or "migrate" in log_text.lower())
            is_raydium = "initialize2" in log_text or "InitializeInstruction2" in log_text

            if not is_pumpfun and not is_raydium:
                return

            if sig in self.seen: return
            self.seen.add(sig)

            source = "pumpfun" if is_pumpfun else "raydium"
            log.info(f"🆕 {source.upper()} pool (tx: {sig[:20]}...)")

            # Extract mint — try getTransaction with 5 retries at 2s intervals
            mint = None
            async with aiohttp.ClientSession() as sess:
                for attempt in range(5):
                    mint = await self._extract_mint(sig, sess)
                    if mint:
                        break
                    await asyncio.sleep(2)

            if not mint or mint in self.seen:
                log.warning(f"No mint from {sig[:16]}")
                return

            self.seen.add(mint)
            self.count += 1

            token = Token(mint=mint, source=source)
            log.info(f"🎯 {source.upper()} → {mint[:24]}...")

            await self.callback(token)

        except Exception as e:
            log.warning(f"Handle: {e}")

    async def _extract_mint(self, sig: str, sess: aiohttp.ClientSession) -> Optional[str]:
        """Fetch parsed transaction and find the token mint from postTokenBalances."""
        try:
            payload = {"jsonrpc":"2.0","id":1,"method":"getTransaction",
                       "params":[sig,{"encoding":"jsonParsed","maxSupportedTransactionVersion":0}]}
            async with sess.post(self.sol.rpc, json=payload, timeout=aiohttp.ClientTimeout(total=10)) as r:
                data = await r.json()
            
            tx = data.get("result")
            if not tx:
                return None

            meta = tx.get("meta", {})
            if not meta or meta.get("err"):
                return None

            skip = {WSOL, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"}

            # postTokenBalances — most reliable
            for bal in meta.get("postTokenBalances", []):
                m = bal.get("mint", "")
                if m and m not in skip:
                    return m

            # preTokenBalances
            for bal in meta.get("preTokenBalances", []):
                m = bal.get("mint", "")
                if m and m not in skip:
                    return m

        except Exception:
            pass
        return None

# ─── EXIT ENGINE ─────────────────────────────────────────────────────────────

class ExitEngine:
    """
    2-second price polling. Take-profit tiers. Trailing stop.
    At 2x: sell 50%, tighten stop to 15%
    At 3x: sell 50% of remaining, tighten stop to 10%
    Rest rides with tight stop.
    """
    def __init__(self, jup, sol, discord):
        self.jup = jup
        self.sol = sol
        self.discord = discord
        self.positions: list[Position] = []

    def add(self, pos): self.positions.append(pos)

    @property
    def open_count(self): return len([p for p in self.positions if p.status == "open"])

    async def run(self):
        log.info(f"Exit engine: {TRAILING_STOP_PCT}% trail | {MAX_HOLD_HOURS}h max | 2s poll")
        while True:
            for pos in [p for p in self.positions if p.status == "open"]:
                await self._check(pos)
            await asyncio.sleep(2)

    async def _check(self, pos):
        price = await self.jup.price(pos.token.mint)

        if not price:
            # Track consecutive failures
            pos._price_fails = getattr(pos, '_price_fails', 0) + 1
            if pos._price_fails % 10 == 1:  # Log every 10th failure
                log.warning(f"⚠️ {pos.token.mint[:16]}: price check failed ({pos._price_fails}x)")
            # After 60 consecutive failures (2 min), force sell at entry price
            if pos._price_fails >= 60:
                log.error(f"💀 {pos.token.mint[:16]}: price dead for 2min — emergency sell")
                await self._sell(pos, pos.entry_price, "price_dead", 100)
            return

        pos._price_fails = 0  # Reset on success
        gain_x = price / pos.entry_price if pos.entry_price > 0 else 1

        # Log current state every check so we can see it's alive
        log.info(f"👁️ {pos.token.mint[:12]} ${price:.8f} ({gain_x:.2f}x) stop=${pos.stop_price:.8f}")

        # Timeout
        if pos.expired:
            log.warning(f"⏰ {pos.token.mint[:16]} timeout — selling all")
            await self._sell(pos, price, "timeout", 100)
            return

        # Take profit at 2x
        if gain_x >= 2.0 and not pos.took_2x:
            pos.took_2x = True
            log.info(f"🎯 HIT 2x! Selling 50% — house money secured")
            await self._sell(pos, price, "take_profit_2x", 50)
            pos.stop_price = pos.high_price * 0.85
            return

        # Take profit at 3x
        if gain_x >= 3.0 and not pos.took_3x:
            pos.took_3x = True
            log.info(f"🚀 HIT 3x! Selling 50% more")
            await self._sell(pos, price, "take_profit_3x", 50)
            pos.stop_price = pos.high_price * 0.90
            return

        # Update high water mark
        if price > pos.high_price:
            pos.high_price = price
            if pos.took_3x:
                pos.stop_price = price * 0.90
            elif pos.took_2x:
                pos.stop_price = price * 0.85
            else:
                pos.stop_price = price * (1 - TRAILING_STOP_PCT / 100)
            log.info(f"📈 {pos.token.symbol} ${price:.8f} (stop ${pos.stop_price:.8f})")

        # Trailing stop
        if price <= pos.stop_price:
            log.warning(f"🛑 {pos.token.symbol} stop @ ${price:.8f}")
            await self._sell(pos, price, "trailing_stop", 100)

    async def _sell(self, pos, price, reason, pct):
        tokens_to_sell = pos.tokens_held * (pct / 100)
        if pct >= 100: pos.status = "closed"
        pos.exit_price = price
        pos.exit_reason = reason
        pos.pnl_usd = (price - pos.entry_price) * pos.original_tokens

        log.info(f"Selling {pct}% of {pos.token.symbol} ({reason})")

        if pos.token.mint and self.sol.pubkey:
            try:
                amount = int(tokens_to_sell * 1e6)
                order = await self.jup.order(pos.token.mint, WSOL, amount, self.sol.pubkey)
                if order and order.get("transaction"):
                    signed = self.sol.sign(order["transaction"])
                    if signed:
                        result = await self.jup.execute(order["requestId"], signed)
                        if result:
                            st = result.get("status","")
                            if st == "Failed":
                                log.error(f"Sell failed: {result.get('error','?')}")
                            else:
                                log.info(f"Sell TX: {result.get('signature','?')[:25]}...")
                else:
                    log.error(f"No sell route for {pos.token.symbol}")
            except Exception as e:
                log.error(f"Sell err: {e}")

        pos.tokens_held -= tokens_to_sell
        await self.discord.sold(pos, reason, pct)

        if pos.status == "closed":
            log.info(f"✅ Closed {pos.token.symbol}: P&L ${pos.pnl_usd:+.4f}")

# ─── MAIN BOT ───────────────────────────────────────────────────────────────

class Bot:
    def __init__(self):
        self.sol = Solana(SOLANA_RPC_URL, WALLET_PRIVATE_KEY)
        self.jup = Jupiter()
        self.discord = Discord(DISCORD_WEBHOOK_URL)
        self.exits = ExitEngine(self.jup, self.sol, self.discord)
        self.detector = Detector(self.sol, self._on_token)
        self.start = time.time()

    async def run(self):
        log.info("=" * 50)
        log.info("  DEGEN SNIPER v5")
        log.info(f"  ${TRADE_AMOUNT_SOL} SOL/trade | {TRAILING_STOP_PCT}% stop")
        log.info(f"  {MAX_HOLD_HOURS}h max | {MAX_OPEN_POSITIONS} max positions")
        log.info(f"  Jupiter: {'✅' if JUPITER_API_KEY else '❌'}")
        log.info("=" * 50)
        async with aiohttp.ClientSession() as s:
            if self.sol.pubkey:
                b = await self.sol.balance(s)
                log.info(f"Balance: {b:.4f} SOL")
        await asyncio.gather(self.detector.listen(), self.exits.run(), self._hb())

    async def _on_token(self, token):
        if self.exits.open_count >= MAX_OPEN_POSITIONS:
            log.info(f"⏸️ {token.mint[:16]}: {MAX_OPEN_POSITIONS} positions open")
            return

        # Quick safety check via Jupiter — if we can't get a quote, skip
        async with aiohttp.ClientSession() as sess:
            # Check top holder
            try:
                res = await self.sol.balance(sess)  # Just verify RPC works
            except: pass

        log.info(f"✅ Buying {token.mint[:16]}... ({token.source})")
        if BUY_DELAY_SECONDS > 0:
            await asyncio.sleep(BUY_DELAY_SECONDS)
        await self._buy(token)

    async def _buy(self, token):
        if not self.sol.pubkey: return
        async with aiohttp.ClientSession() as sess:
            bal = await self.sol.balance(sess)
        if bal < TRADE_AMOUNT_SOL + 0.005:
            log.error(f"Low SOL: {bal:.4f}"); return

        lamports = int(TRADE_AMOUNT_SOL * 1e9)
        order = await self.jup.order(WSOL, token.mint, lamports, self.sol.pubkey)
        if not order:
            log.info(f"No route for {token.mint[:16]}"); return

        tx_b64 = order.get("transaction","")
        req_id = order.get("requestId","")
        out_amount = int(order.get("outAmount","0"))

        if not tx_b64 or not req_id:
            log.error("Bad order response"); return

        signed = self.sol.sign(tx_b64)
        if not signed: return

        result = await self.jup.execute(req_id, signed)
        if not result: log.error("Execute failed"); return

        if result.get("status") == "Failed":
            log.error(f"Swap failed: {result.get('error','?')}"); return

        sig = result.get("signature","?")
        log.info(f"✅ TX: {sig[:30]}...")

        # Calculate
        async with aiohttp.ClientSession() as sess:
            await asyncio.sleep(2)
            bal_after = await self.sol.balance(sess)

        tokens = out_amount / 1e6
        price = await self.jup.price(token.mint)
        if not price:
            price = TRADE_AMOUNT_SOL / tokens if tokens > 0 else 0

        gas = max(0, (bal - bal_after) - TRADE_AMOUNT_SOL) if 'bal' in dir() else 0

        pos = Position(token=token, entry_price=price, tokens_held=tokens,
                       cost_sol=TRADE_AMOUNT_SOL, high_price=price,
                       stop_price=price * (1 - TRAILING_STOP_PCT/100), buy_gas=gas)
        self.exits.add(pos)
        await self.discord.bought(pos)
        log.info(f"💰 BOUGHT {tokens:.0f} {token.symbol} @ ${price:.10f}")

    async def _hb(self):
        while True:
            await asyncio.sleep(300)
            log.info(f"💓 {self.detector.count} tokens | {self.exits.open_count} open | {(time.time()-self.start)/60:.0f}m")

if __name__ == "__main__":
    try: asyncio.run(Bot().run())
    except KeyboardInterrupt: log.info("Stopped")
