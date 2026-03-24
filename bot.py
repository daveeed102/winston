"""
DEGEN SNIPER BOT v4 — Ground-up rebuild
Monitors Solana for new Raydium pools + Pump.fun graduations.
Extracts REAL token mints from parsed transactions (not log scraping).
Buys via Jupiter Swap V2 (api.jup.ag). Sells on trailing stop or timeout.
Discord alerts: buy + sell only. Everything else is console-only.
"""

import asyncio
import json
import time
import logging
import os
import base64 as b64
from datetime import datetime, timezone
from dataclasses import dataclass
from typing import Optional

import aiohttp

# ─── CONFIG ──────────────────────────────────────────────────────────────────

TRADE_AMOUNT_SOL = float(os.getenv("TRADE_AMOUNT_SOL", "0.021"))  # ~$3
TRAILING_STOP_PCT = float(os.getenv("TRAILING_STOP_PCT", "30"))  # degen default
MAX_HOLD_HOURS = float(os.getenv("MAX_HOLD_HOURS", "2"))
SLIPPAGE_BPS = int(os.getenv("SLIPPAGE_BPS", "500"))
DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "")
SOLANA_RPC_URL = os.getenv("SOLANA_RPC_URL", "")
WALLET_PRIVATE_KEY = os.getenv("WALLET_PRIVATE_KEY", "")
JUPITER_API_KEY = os.getenv("JUPITER_API_KEY", "")
BUY_DELAY_SECONDS = float(os.getenv("BUY_DELAY_SECONDS", "2"))
MAX_TOP_HOLDER_PCT = float(os.getenv("MAX_TOP_HOLDER_PCT", "50"))

# Solana programs
RAYDIUM_AMM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
PUMPFUN = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
WSOL = "So11111111111111111111111111111111111111112"
USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
SKIP_MINTS = {WSOL, USDC, USDT}

# Jupiter V2
JUP_ORDER = "https://api.jup.ag/swap/v2/order"
JUP_EXECUTE = "https://api.jup.ag/swap/v2/execute"
JUP_PRICE = "https://api.jup.ag/price/v2"

# ─── LOGGING ─────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s │ %(levelname)-7s │ %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("sniper")

# ─── MODELS ──────────────────────────────────────────────────────────────────

@dataclass
class Token:
    mint: str
    symbol: str = "???"
    name: str = "Unknown"
    source: str = ""
    discovered_at: float = 0.0
    def __post_init__(self):
        if not self.discovered_at:
            self.discovered_at = time.time()

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
    def __post_init__(self):
        if not self.opened_ts:
            self.opened_ts = time.time()
    @property
    def hold_secs(self) -> float:
        return time.time() - self.opened_ts
    @property
    def expired(self) -> bool:
        return self.hold_secs >= MAX_HOLD_HOURS * 3600

# ─── JUPITER (api.jup.ag — works on Railway) ────────────────────────────────

class Jupiter:
    """Jupiter Swap V2 API with Railway-safe DNS resolver."""

    async def _session(self) -> aiohttp.ClientSession:
        headers = {"Content-Type": "application/json"}
        if JUPITER_API_KEY:
            headers["x-api-key"] = JUPITER_API_KEY
        try:
            from aiohttp.resolver import AsyncResolver
            resolver = AsyncResolver(nameservers=["8.8.8.8", "1.1.1.1"])
            conn = aiohttp.TCPConnector(resolver=resolver, ssl=False)
        except Exception:
            conn = aiohttp.TCPConnector(ssl=False)
        return aiohttp.ClientSession(connector=conn, headers=headers)

    async def price(self, mint: str) -> Optional[float]:
        s = await self._session()
        try:
            async with s.get(f"{JUP_PRICE}?ids={mint}", timeout=aiohttp.ClientTimeout(total=8)) as r:
                if r.status == 200:
                    d = await r.json()
                    p = d.get("data", {}).get(mint, {}).get("price")
                    return float(p) if p else None
        except Exception as e:
            log.warning(f"Price err: {e}")
        finally:
            await s.close()
        return None

    async def order(self, input_mint: str, output_mint: str, amount: int, taker: str) -> Optional[dict]:
        """GET /swap/v2/order — returns quote + unsigned tx."""
        s = await self._session()
        try:
            params = {"inputMint": input_mint, "outputMint": output_mint,
                      "amount": str(amount), "taker": taker}
            async with s.get(JUP_ORDER, params=params, timeout=aiohttp.ClientTimeout(total=12)) as r:
                if r.status == 200:
                    return await r.json()
                body = await r.text()
                log.error(f"Jup order {r.status}: {body[:150]}")
        except Exception as e:
            log.error(f"Jup order err: {e}")
        finally:
            await s.close()
        return None

    async def execute(self, request_id: str, signed_tx_b64: str) -> Optional[dict]:
        """POST /swap/v2/execute — Jupiter lands the tx."""
        s = await self._session()
        try:
            payload = {"signedTransaction": signed_tx_b64, "requestId": request_id}
            async with s.post(JUP_EXECUTE, json=payload, timeout=aiohttp.ClientTimeout(total=30)) as r:
                if r.status == 200:
                    return await r.json()
                body = await r.text()
                log.error(f"Jup exec {r.status}: {body[:150]}")
        except Exception as e:
            log.error(f"Jup exec err: {e}")
        finally:
            await s.close()
        return None

# ─── SOLANA RPC ──────────────────────────────────────────────────────────────

class Solana:
    def __init__(self, rpc_url: str, privkey_b58: str):
        self.rpc = rpc_url
        self.ws = rpc_url.replace("https://", "wss://").replace("http://", "ws://")
        self.keypair = None
        self.pubkey = None
        if privkey_b58:
            try:
                from solders.keypair import Keypair
                import base58
                self.keypair = Keypair.from_bytes(base58.b58decode(privkey_b58))
                self.pubkey = str(self.keypair.pubkey())
                log.info(f"Wallet: {self.pubkey[:8]}...{self.pubkey[-4:]}")
            except Exception as e:
                log.error(f"Wallet load failed: {e}")

    async def _call(self, method: str, params: list, session: aiohttp.ClientSession):
        payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        async with session.post(self.rpc, json=payload, timeout=aiohttp.ClientTimeout(total=15)) as r:
            return await r.json()

    async def balance(self, session: aiohttp.ClientSession) -> float:
        if not self.pubkey:
            return 0.0
        res = await self._call("getBalance", [self.pubkey], session)
        return res.get("result", {}).get("value", 0) / 1e9

    async def get_tx(self, sig: str, session: aiohttp.ClientSession) -> Optional[dict]:
        """Fetch full parsed transaction to extract token mints."""
        res = await self._call("getTransaction", [sig, {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}], session)
        return res.get("result")

    async def get_token_supply(self, mint: str, session: aiohttp.ClientSession) -> Optional[dict]:
        res = await self._call("getTokenSupply", [mint], session)
        return res.get("result", {}).get("value")

    async def get_largest_holders(self, mint: str, session: aiohttp.ClientSession) -> list:
        res = await self._call("getTokenLargestAccounts", [mint], session)
        return res.get("result", {}).get("value", [])

    def sign_tx(self, tx_b64: str) -> Optional[str]:
        """Sign a base64 transaction, return base64 signed tx."""
        if not self.keypair:
            return None
        try:
            from solders.transaction import VersionedTransaction
            raw = b64.b64decode(tx_b64)
            txn = VersionedTransaction.from_bytes(raw)
            signed = VersionedTransaction(txn.message, [self.keypair])
            return b64.b64encode(bytes(signed)).decode()
        except Exception as e:
            log.error(f"Sign err: {e}")
            return None

# ─── DISCORD (buy + sell only) ───────────────────────────────────────────────

class Discord:
    def __init__(self, url: str):
        self.url = url

    async def _send(self, embed: dict):
        if not self.url:
            return
        try:
            async with aiohttp.ClientSession() as s:
                await s.post(self.url, json={"embeds": [embed]})
        except Exception:
            pass

    async def bought(self, p: Position):
        await self._send({
            "title": f"💰 BOUGHT — {p.token.symbol}",
            "color": 0x00FF88,
            "fields": [
                {"name": "Token", "value": f"{p.token.name} (`{p.token.mint[:16]}...`)", "inline": False},
                {"name": "Price", "value": f"${p.entry_price:.10f}", "inline": True},
                {"name": "Spent", "value": f"{p.cost_sol:.4f} SOL", "inline": True},
                {"name": "Gas", "value": f"{p.buy_gas:.5f} SOL", "inline": True},
                {"name": "Link", "value": f"[Solscan](https://solscan.io/token/{p.token.mint})", "inline": False},
            ],
        })

    async def sold(self, p: Position):
        emoji = "🟢" if p.pnl_usd >= 0 else "🔴"
        total_gas = p.buy_gas + p.sell_gas
        await self._send({
            "title": f"{emoji} SOLD — {p.token.symbol}",
            "color": 0x00FF88 if p.pnl_usd >= 0 else 0xFF4444,
            "fields": [
                {"name": "Token", "value": p.token.name, "inline": True},
                {"name": "P&L", "value": f"${p.pnl_usd:+.4f}", "inline": True},
                {"name": "Buy", "value": f"${p.entry_price:.10f}", "inline": True},
                {"name": "Sell", "value": f"${p.exit_price:.10f}", "inline": True},
                {"name": "Gas (total)", "value": f"{total_gas:.5f} SOL", "inline": True},
                {"name": "Held", "value": f"{p.hold_secs/60:.1f}m", "inline": True},
            ],
        })

# ─── POOL DETECTOR ───────────────────────────────────────────────────────────

class PoolDetector:
    """
    Listens to Raydium AMM + Pump.fun via WebSocket.
    When a new pool is created (initialize2 log), fetches the FULL transaction
    and extracts the actual token mint from accountKeys + token balances.
    """

    def __init__(self, sol: Solana, on_new_token):
        self.sol = sol
        self.on_new_token = on_new_token
        self.seen: set[str] = set()
        self.count = 0

    async def listen(self):
        while True:
            try:
                log.info(f"Connecting WS: {self.sol.ws[:50]}...")
                async with aiohttp.ClientSession() as session:
                    async with session.ws_connect(self.sol.ws, heartbeat=30) as ws:
                        log.info("✅ WebSocket connected")

                        # Subscribe to Raydium AMM
                        await ws.send_json({
                            "jsonrpc": "2.0", "id": 1, "method": "logsSubscribe",
                            "params": [{"mentions": [RAYDIUM_AMM]}, {"commitment": "confirmed"}],
                        })
                        # Subscribe to Pump.fun
                        await ws.send_json({
                            "jsonrpc": "2.0", "id": 2, "method": "logsSubscribe",
                            "params": [{"mentions": [PUMPFUN]}, {"commitment": "confirmed"}],
                        })

                        log.info("📡 Listening for new pools...")

                        async for msg in ws:
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                await self._handle(msg.data, session)
                            elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSED):
                                break

            except Exception as e:
                log.error(f"WS error: {e}")
            log.info("Reconnecting in 5s...")
            await asyncio.sleep(5)

    async def _handle(self, raw: str, session: aiohttp.ClientSession):
        try:
            data = json.loads(raw)
            if "params" not in data:
                return
            value = data["params"]["result"].get("value", {})
            logs = value.get("logs", [])
            sig = value.get("signature", "")
            if not logs or not sig:
                return

            log_text = " ".join(logs)

            # Detect new Raydium pool: "initialize2" in logs
            is_new_pool = "initialize2" in log_text or "InitializeInstruction2" in log_text
            # Detect Pump.fun graduation
            is_pumpfun = PUMPFUN in log_text and ("Withdraw" in log_text or "migrate" in log_text.lower())

            if not is_new_pool and not is_pumpfun:
                return

            if sig in self.seen:
                return
            self.seen.add(sig)

            source = "pumpfun" if is_pumpfun else "raydium"
            log.info(f"🆕 New {source} pool detected (tx: {sig[:20]}...)")

            # Fetch full transaction to extract the REAL token mint
            # Retry up to 3 times since brand-new txs may not be indexed yet
            mint = None
            for attempt in range(3):
                mint = await self._extract_mint(sig, session)
                if mint:
                    break
                await asyncio.sleep(1)

            if not mint:
                log.warning(f"Could not extract mint from {sig[:20]}")
                return

            if mint in self.seen:
                return
            self.seen.add(mint)
            self.count += 1

            token = Token(mint=mint, source=source)
            log.info(f"🎯 Token mint: {mint[:20]}... ({source})")

            await self.on_new_token(token, session)

        except Exception as e:
            log.warning(f"Handle err: {e}")

    async def _extract_mint(self, sig: str, session: aiohttp.ClientSession) -> Optional[str]:
        """
        Fetch parsed transaction and find the NEW token mint.
        Look at postTokenBalances for mints that aren't SOL/USDC/USDT.
        """
        try:
            tx = await self.sol.get_tx(sig, session)
            if not tx:
                return None

            meta = tx.get("meta", {})
            if not meta or meta.get("err"):
                return None

            # Strategy 1: Look at postTokenBalances for non-SOL mints
            post_balances = meta.get("postTokenBalances", [])
            for bal in post_balances:
                mint = bal.get("mint", "")
                if mint and mint not in SKIP_MINTS:
                    return mint

            # Strategy 2: Look at preTokenBalances too
            pre_balances = meta.get("preTokenBalances", [])
            for bal in pre_balances:
                mint = bal.get("mint", "")
                if mint and mint not in SKIP_MINTS:
                    return mint

            # Strategy 3: Check inner instructions for token program calls
            inner = meta.get("innerInstructions", [])
            for ix_group in inner:
                for ix in ix_group.get("instructions", []):
                    parsed = ix.get("parsed", {})
                    if isinstance(parsed, dict):
                        info = parsed.get("info", {})
                        mint = info.get("mint", "")
                        if mint and mint not in SKIP_MINTS:
                            return mint

        except Exception as e:
            log.warning(f"Extract mint err: {e}")
        return None

# ─── TRAILING STOP MANAGER ──────────────────────────────────────────────────

class StopManager:
    def __init__(self, jup: Jupiter, sol: Solana, discord: Discord):
        self.jup = jup
        self.sol = sol
        self.discord = discord
        self.positions: list[Position] = []

    def add(self, pos: Position):
        self.positions.append(pos)

    async def run(self):
        log.info(f"Stop manager: {TRAILING_STOP_PCT}% trail / {MAX_HOLD_HOURS}h max")
        while True:
            for pos in [p for p in self.positions if p.status == "open"]:
                await self._check(pos)
            await asyncio.sleep(5)

    async def _check(self, pos: Position):
        price = await self.jup.price(pos.token.mint)
        if not price:
            return

        # Timeout exit
        if pos.expired:
            log.warning(f"⏰ {pos.token.symbol} timeout — selling")
            await self._sell(pos, price, "timeout")
            return

        # Update high water mark
        if price > pos.high_price:
            pos.high_price = price
            pos.stop_price = price * (1 - TRAILING_STOP_PCT / 100)

        # Stop hit
        if price <= pos.stop_price:
            log.warning(f"🛑 {pos.token.symbol} stop @ ${price:.10f}")
            await self._sell(pos, price, "trailing_stop")

    async def _sell(self, pos: Position, price: float, reason: str):
        pos.status = "closed"
        pos.exit_price = price
        pos.exit_reason = reason
        pos.pnl_usd = (price - pos.entry_price) * pos.tokens_held

        if pos.token.mint and self.sol.pubkey:
            async with aiohttp.ClientSession() as session:
                bal_before = await self.sol.balance(session)

            token_amount = int(pos.tokens_held * 1e6)
            order = await self.jup.order(pos.token.mint, WSOL, token_amount, self.sol.pubkey)
            if order and order.get("transaction"):
                signed = self.sol.sign_tx(order["transaction"])
                if signed:
                    result = await self.jup.execute(order["requestId"], signed)
                    if result:
                        log.info(f"Sell OK: {result.get('signature', '?')[:20]}")

                    await asyncio.sleep(3)
                    async with aiohttp.ClientSession() as session:
                        bal_after = await self.sol.balance(session)
                    expected = int(order.get("outAmount", 0)) / 1e9
                    pos.sell_gas = max(0, expected - (bal_after - bal_before)) if expected > 0 else 0.005

        await self.discord.sold(pos)
        log.info(f"Closed {pos.token.symbol}: P&L ${pos.pnl_usd:+.4f} [{reason}]")

# ─── MAIN BOT ───────────────────────────────────────────────────────────────

class SniperBot:
    def __init__(self):
        self.sol = Solana(SOLANA_RPC_URL, WALLET_PRIVATE_KEY)
        self.jup = Jupiter()
        self.discord = Discord(DISCORD_WEBHOOK_URL)
        self.stops = StopManager(self.jup, self.sol, self.discord)
        self.detector = PoolDetector(self.sol, self._on_token)
        self.start = time.time()

    async def run(self):
        log.info("=" * 55)
        log.info("  DEGEN SNIPER BOT v4")
        log.info(f"  Trade: {TRADE_AMOUNT_SOL} SOL | Stop: {TRAILING_STOP_PCT}%")
        log.info(f"  Max hold: {MAX_HOLD_HOURS}h | Slippage: {SLIPPAGE_BPS}bps")
        log.info(f"  Jupiter key: {'✅' if JUPITER_API_KEY else '❌ MISSING'}")
        log.info("=" * 55)

        async with aiohttp.ClientSession() as s:
            if self.sol.pubkey:
                bal = await self.sol.balance(s)
                log.info(f"Balance: {bal:.4f} SOL")
            else:
                log.warning("⚠️  No wallet — monitor only")

        await asyncio.gather(
            self.detector.listen(),
            self.stops.run(),
            self._heartbeat(),
        )

    async def _on_token(self, token: Token, session: aiohttp.ClientSession):
        """Called when a real new token mint is detected."""

        # Safety: check top holder concentration
        try:
            supply_info = await self.sol.get_token_supply(token.mint, session)
            largest = await self.sol.get_largest_holders(token.mint, session)
            if supply_info and largest:
                total = float(supply_info.get("amount", "0"))
                if total > 0 and len(largest) > 0:
                    top = float(largest[0].get("amount", "0"))
                    pct = (top / total) * 100
                    if pct > MAX_TOP_HOLDER_PCT:
                        log.info(f"⛔ {token.mint[:16]}: top holder {pct:.0f}%")
                        return
        except Exception:
            pass  # If check fails, proceed anyway

        log.info(f"✅ Buying {token.symbol} ({token.source})...")

        if BUY_DELAY_SECONDS > 0:
            await asyncio.sleep(BUY_DELAY_SECONDS)

        await self._buy(token, session)

    async def _buy(self, token: Token, session: aiohttp.ClientSession):
        if not self.sol.pubkey:
            return

        bal_before = await self.sol.balance(session)
        if bal_before < TRADE_AMOUNT_SOL + 0.005:
            log.error(f"Low SOL: {bal_before:.4f}")
            return

        # Step 1: Get order from Jupiter
        lamports = int(TRADE_AMOUNT_SOL * 1e9)
        order = await self.jup.order(WSOL, token.mint, lamports, self.sol.pubkey)
        if not order:
            log.info(f"No route for {token.mint[:16]} — skipping")
            return

        tx_b64 = order.get("transaction")
        req_id = order.get("requestId", "")
        out_amount = int(order.get("outAmount", "0"))

        if not tx_b64 or not req_id:
            log.error(f"Bad order response for {token.mint[:16]}")
            return

        # Step 2: Sign
        signed = self.sol.sign_tx(tx_b64)
        if not signed:
            return

        # Step 3: Execute (Jupiter lands the tx)
        result = await self.jup.execute(req_id, signed)
        if not result:
            log.error(f"Execute failed for {token.mint[:16]}")
            return

        status = result.get("status", "")
        sig = result.get("signature", "unknown")

        if status == "Failed":
            log.error(f"Swap failed: {result.get('error', 'unknown')}")
            return

        log.info(f"✅ TX landed: {sig[:30]}...")

        # Calculate tokens received + gas
        await asyncio.sleep(3)
        bal_after = await self.sol.balance(session)
        gas = max(0, bal_before - bal_after - TRADE_AMOUNT_SOL)

        tokens = out_amount / 1e6  # default 6 decimals
        price = TRADE_AMOUNT_SOL / tokens if tokens > 0 else 0

        # Try to get real price from Jupiter
        jup_price = await self.jup.price(token.mint)
        if jup_price:
            price = jup_price

        pos = Position(
            token=token, entry_price=price, tokens_held=tokens,
            cost_sol=TRADE_AMOUNT_SOL, high_price=price,
            stop_price=price * (1 - TRAILING_STOP_PCT / 100),
            buy_gas=gas,
        )
        self.stops.add(pos)
        await self.discord.bought(pos)
        log.info(f"💰 BOUGHT {tokens:.2f} {token.symbol} @ ${price:.10f} | gas: {gas:.5f} SOL")

    async def _heartbeat(self):
        while True:
            await asyncio.sleep(300)
            uptime = (time.time() - self.start) / 60
            open_pos = len([p for p in self.stops.positions if p.status == "open"])
            log.info(f"💓 {self.detector.count} tokens, {open_pos} open, {uptime:.0f}m up")

# ─── RUN ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    bot = SniperBot()
    try:
        asyncio.run(bot.run())
    except KeyboardInterrupt:
        log.info("Stopped")
