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

TRADE_AMOUNT_SOL = float(os.getenv("TRADE_AMOUNT_SOL", "0.07"))  # ~$10
TRAILING_STOP_PCT = float(os.getenv("TRAILING_STOP_PCT", "20"))  # 20% default, tightens after TP
MAX_HOLD_HOURS = float(os.getenv("MAX_HOLD_HOURS", "1"))  # 1 hour max
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
        Multiple strategies for Raydium and Pump.fun transaction formats.
        """
        try:
            tx = await self.sol.get_tx(sig, session)
            if not tx:
                log.warning(f"getTransaction returned null for {sig[:16]}")
                return None

            meta = tx.get("meta", {})
            if not meta:
                log.warning(f"No meta in tx {sig[:16]}")
                return None
            if meta.get("err"):
                return None  # Failed tx, skip silently

            # Strategy 1: postTokenBalances (works for most Raydium pools)
            for bal in meta.get("postTokenBalances", []):
                mint = bal.get("mint", "")
                if mint and mint not in SKIP_MINTS:
                    return mint

            # Strategy 2: preTokenBalances
            for bal in meta.get("preTokenBalances", []):
                mint = bal.get("mint", "")
                if mint and mint not in SKIP_MINTS:
                    return mint

            # Strategy 3: Inner instructions — parsed info.mint
            for ix_group in meta.get("innerInstructions", []):
                for ix in ix_group.get("instructions", []):
                    parsed = ix.get("parsed", {})
                    if isinstance(parsed, dict):
                        info = parsed.get("info", {})
                        for key in ["mint", "source", "destination"]:
                            val = info.get(key, "")
                            if val and val not in SKIP_MINTS and len(val) >= 32:
                                return val

            # Strategy 4: Account keys — for Pump.fun, the token mint is
            # typically in the transaction's account keys list
            transaction = tx.get("transaction", {})
            message = transaction.get("message", {})
            account_keys = message.get("accountKeys", [])

            # Pump.fun token mint is usually at a specific index
            # Skip first few accounts (fee payer, programs) and look for
            # base58 addresses that aren't known programs
            known_programs = {
                RAYDIUM_AMM, PUMPFUN, WSOL, USDC, USDT,
                "11111111111111111111111111111111",
                "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
                "SysvarRent111111111111111111111111111111111",
                "ComputeBudget111111111111111111111111111111",
                "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
                "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
                "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
            }
            for acct in account_keys:
                # accountKeys can be strings or objects with pubkey
                if isinstance(acct, str):
                    addr = acct
                elif isinstance(acct, dict):
                    addr = acct.get("pubkey", "")
                else:
                    continue

                if (addr and addr not in SKIP_MINTS
                    and addr not in known_programs
                    and len(addr) >= 32 and len(addr) <= 44):
                    # Verify this is actually a token mint by checking
                    # if it appears in any token balance
                    # For now, return the first candidate — Jupiter will
                    # reject it if it's not tradeable
                    return addr

            log.warning(f"No mint found in tx {sig[:16]} (balances:{len(meta.get('postTokenBalances',[]))} keys:{len(account_keys)})")

        except Exception as e:
            log.warning(f"Extract mint err: {e}")
        return None

# ─── EXIT STRATEGY ENGINE ────────────────────────────────────────────────────

class ExitEngine:
    """
    Smart exit strategy:
    - Polls price every 2 seconds (not 5)
    - At 2x: sells 50% (locks in house money), tightens stop to 15%
    - At 3x: sells another 25%, tightens stop to 10%
    - Remaining rides with tight stop until exit
    - 20% trailing stop from peak (default)
    - After any profit taken, stop tightens automatically
    - 1 hour max hold (not 2)
    """

    def __init__(self, jup: Jupiter, sol: Solana, discord: Discord):
        self.jup = jup
        self.sol = sol
        self.discord = discord
        self.positions: list[Position] = []

    def add(self, pos: Position):
        self.positions.append(pos)

    async def run(self):
        log.info(f"Exit engine: {TRAILING_STOP_PCT}% trail | {MAX_HOLD_HOURS}h max | 2s poll")
        while True:
            for pos in [p for p in self.positions if p.status == "open"]:
                await self._check(pos)
            await asyncio.sleep(2)  # Check every 2 seconds, not 5

    async def _check(self, pos: Position):
        price = await self.jup.price(pos.token.mint)
        if not price:
            return

        gain_x = price / pos.entry_price if pos.entry_price > 0 else 1

        # ── TIMEOUT EXIT ──
        if pos.expired:
            log.warning(f"⏰ {pos.token.symbol} timeout — selling all")
            await self._sell(pos, price, "timeout", sell_pct=100)
            return

        # ── TAKE PROFIT TIERS ──
        # At 2x: sell 50%, lock in house money
        if gain_x >= 2.0 and not getattr(pos, '_took_2x', False):
            pos._took_2x = True
            log.info(f"🎯 {pos.token.symbol} hit 2x! Selling 50% — house money secured")
            await self._sell(pos, price, "take_profit_2x", sell_pct=50)
            # Tighten stop to 15% after taking profit
            pos.stop_price = pos.high_price * 0.85
            return

        # At 3x: sell another 25% of original
        if gain_x >= 3.0 and not getattr(pos, '_took_3x', False):
            pos._took_3x = True
            log.info(f"🚀 {pos.token.symbol} hit 3x! Selling 25% more")
            await self._sell(pos, price, "take_profit_3x", sell_pct=50)  # 50% of remaining
            # Tighten stop to 10%
            pos.stop_price = pos.high_price * 0.90
            return

        # ── UPDATE HIGH WATER MARK ──
        if price > pos.high_price:
            pos.high_price = price
            # Dynamic stop: tighter after profit taken
            if getattr(pos, '_took_2x', False):
                pos.stop_price = price * 0.85  # 15% after first TP
            elif getattr(pos, '_took_3x', False):
                pos.stop_price = price * 0.90  # 10% after second TP
            else:
                pos.stop_price = price * (1 - TRAILING_STOP_PCT / 100)  # default 20%

        # ── TRAILING STOP HIT ──
        if price <= pos.stop_price:
            log.warning(f"🛑 {pos.token.symbol} stop @ ${price:.10f} (peak was ${pos.high_price:.10f})")
            await self._sell(pos, price, "trailing_stop", sell_pct=100)

    async def _sell(self, pos: Position, price: float, reason: str, sell_pct: int = 100):
        """Sell a percentage of the position."""
        tokens_to_sell = pos.tokens_held * (sell_pct / 100)

        if sell_pct >= 100:
            pos.status = "closed"

        pos.exit_price = price
        pos.exit_reason = reason
        pos.pnl_usd = (price - pos.entry_price) * pos.tokens_held

        log.info(f"Selling {sell_pct}% of {pos.token.symbol} ({reason}) @ ${price:.10f}")

        if pos.token.mint and self.sol.pubkey:
            try:
                async with aiohttp.ClientSession() as session:
                    bal_before = await self.sol.balance(session)

                token_amount = int(tokens_to_sell * 1e6)
                order = await self.jup.order(pos.token.mint, WSOL, token_amount, self.sol.pubkey)
                if order and order.get("transaction"):
                    signed = self.sol.sign_tx(order["transaction"])
                    if signed:
                        result = await self.jup.execute(order["requestId"], signed)
                        if result:
                            status = result.get("status", "")
                            sig = result.get("signature", "?")
                            if status == "Failed":
                                log.error(f"Sell failed: {result.get('error', '?')}")
                            else:
                                log.info(f"Sell TX: {sig[:25]}...")

                        await asyncio.sleep(3)
                        async with aiohttp.ClientSession() as session:
                            bal_after = await self.sol.balance(session)
                        expected = int(order.get("outAmount", 0)) / 1e9
                        pos.sell_gas += max(0, expected - (bal_after - bal_before)) if expected > 0 else 0.003
                else:
                    log.error(f"No sell route for {pos.token.symbol}")
            except Exception as e:
                log.error(f"Sell error: {e}")

        # Update remaining tokens
        pos.tokens_held -= tokens_to_sell

        # Discord alert only on full close
        if pos.status == "closed":
            await self.discord.sold(pos)
            log.info(f"Closed {pos.token.symbol}: P&L ${pos.pnl_usd:+.4f} [{reason}]")

# ─── MAIN BOT ───────────────────────────────────────────────────────────────

class SniperBot:
    def __init__(self):
        self.sol = Solana(SOLANA_RPC_URL, WALLET_PRIVATE_KEY)
        self.jup = Jupiter()
        self.discord = Discord(DISCORD_WEBHOOK_URL)
        self.exits = ExitEngine(self.jup, self.sol, self.discord)
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
            self.exits.run(),
            self._heartbeat(),
        )

    async def _on_token(self, token: Token, session: aiohttp.ClientSession):
        """Called when a real new token mint is detected. Runs quality filters."""

        # Limit: max 3 open positions at once (don't blow the whole wallet)
        open_count = len([p for p in self.exits.positions if p.status == "open"])
        if open_count >= 2:
            log.info(f"⏸️ {token.mint[:16]}: 2 positions open, skipping")
            return

        try:
            # Get token account info
            account_info = await self.sol._call(
                "getAccountInfo",
                [token.mint, {"encoding": "jsonParsed"}],
                session,
            )
            acct_data = account_info.get("result", {}).get("value", {})
            if acct_data:
                parsed = acct_data.get("data", {}).get("parsed", {}).get("info", {})

                # FILTER 1: Freeze authority — instant reject
                if parsed.get("freezeAuthority"):
                    log.info(f"⛔ {token.mint[:16]}: freeze authority active")
                    return

                # Get symbol/name if available
                if parsed.get("symbol"):
                    token.symbol = parsed["symbol"]
                if parsed.get("name"):
                    token.name = parsed["name"]

            # FILTER 2: Top holder concentration
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

        except Exception as e:
            log.warning(f"Filter check err: {e}")
            # If checks fail, still proceed — Jupiter will reject bad tokens

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
        self.exits.add(pos)
        await self.discord.bought(pos)
        log.info(f"💰 BOUGHT {tokens:.2f} {token.symbol} @ ${price:.10f} | gas: {gas:.5f} SOL")

    async def _heartbeat(self):
        while True:
            await asyncio.sleep(300)
            uptime = (time.time() - self.start) / 60
            open_pos = len([p for p in self.exits.positions if p.status == "open"])
            log.info(f"💓 {self.detector.count} tokens, {open_pos} open, {uptime:.0f}m up")

# ─── RUN ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    bot = SniperBot()
    try:
        asyncio.run(bot.run())
    except KeyboardInterrupt:
        log.info("Stopped")
