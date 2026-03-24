"""
Solana Listing Sniper Bot v3 — CHAIN MONITOR
Watches Solana blockchain in real-time for new token launches:
  - Raydium AMM new pool creation
  - Pump.fun token graduation (bonding → Raydium)
Buys via Jupiter DEX, manages trailing stop exits.
Built for David @ BumprAZ — degen mode.
"""

import asyncio
import json
import re
import time
import logging
import os
import struct
import base64 as b64
from datetime import datetime, timezone
from dataclasses import dataclass
from typing import Optional

import aiohttp
from aiohttp import WSMsgType

# ─── CONFIG ──────────────────────────────────────────────────────────────────

TRADE_AMOUNT_SOL = float(os.getenv("TRADE_AMOUNT_SOL", "0.015"))  # ~$2
TRAILING_STOP_PCT = float(os.getenv("TRAILING_STOP_PCT", "20"))
DEGEN_MODE = os.getenv("DEGEN_MODE", "false").lower() == "true"
MAX_HOLD_HOURS = float(os.getenv("MAX_HOLD_HOURS", "2"))
SLIPPAGE_BPS = int(os.getenv("SLIPPAGE_BPS", "500"))  # 5% for brand new tokens
DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "")
SOLANA_RPC_URL = os.getenv("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")
SOLANA_WS_URL = os.getenv("SOLANA_WS_URL", "")  # auto-derived from RPC if blank
WALLET_PRIVATE_KEY = os.getenv("WALLET_PRIVATE_KEY", "")

# Safety filters
MIN_LIQUIDITY_SOL = float(os.getenv("MIN_LIQUIDITY_SOL", "5"))     # min SOL in pool
MAX_TOP_HOLDER_PCT = float(os.getenv("MAX_TOP_HOLDER_PCT", "50"))  # skip if top wallet >50%
REQUIRE_MINT_REVOKED = os.getenv("REQUIRE_MINT_REVOKED", "false").lower() == "true"
BUY_DELAY_SECONDS = float(os.getenv("BUY_DELAY_SECONDS", "3"))    # wait before buying

# Program IDs
RAYDIUM_AMM_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
RAYDIUM_CPMM_PROGRAM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"
PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

# Well-known mints to ignore
WSOL_MINT = "So11111111111111111111111111111111111111112"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
KNOWN_MINTS = {WSOL_MINT, USDC_MINT, USDT_MINT}

# Jupiter API
JUPITER_QUOTE_URL = "https://quote-api.jup.ag/v6/quote"
JUPITER_SWAP_URL = "https://quote-api.jup.ag/v6/swap"
JUPITER_PRICE_URL = "https://api.jup.ag/price/v2"

# ─── LOGGING ─────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s │ %(levelname)-7s │ %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("sniper")


# ─── DATA MODELS ─────────────────────────────────────────────────────────────

@dataclass
class NewToken:
    mint: str
    symbol: str = "???"
    name: str = "Unknown"
    source: str = ""         # "raydium" or "pumpfun"
    pool_address: str = ""
    paired_with: str = ""    # usually WSOL
    initial_liq_sol: float = 0.0
    mint_authority_revoked: bool = False
    top_holder_pct: float = 0.0
    discovered_at: float = 0.0
    safe: bool = True
    reject_reason: str = ""

    def __post_init__(self):
        if not self.discovered_at:
            self.discovered_at = time.time()


@dataclass
class Position:
    token: NewToken
    entry_price: float = 0.0
    amount_tokens: float = 0.0
    cost_sol: float = 0.0
    highest_price: float = 0.0
    trailing_stop_price: float = 0.0
    status: str = "pending"
    pnl_usd: float = 0.0
    exit_price: float = 0.0
    exit_reason: str = ""
    opened_at: str = ""
    closed_at: str = ""
    opened_at_ts: float = 0.0

    def __post_init__(self):
        if not self.opened_at:
            self.opened_at = datetime.now(timezone.utc).isoformat()
        if not self.opened_at_ts:
            self.opened_at_ts = time.time()

    @property
    def hold_seconds(self) -> float:
        return time.time() - self.opened_at_ts

    @property
    def hold_expired(self) -> bool:
        return self.hold_seconds >= (MAX_HOLD_HOURS * 3600)


# ─── DISCORD ALERTS ─────────────────────────────────────────────────────────

class DiscordAlert:
    def __init__(self, webhook_url: str):
        self.url = webhook_url

    async def send(self, embed: dict):
        if not self.url:
            return
        try:
            async with aiohttp.ClientSession() as s:
                await s.post(self.url, json={"embeds": [embed]},
                             headers={"Content-Type": "application/json"})
        except Exception as e:
            log.error(f"Discord: {e}")

    async def new_token_detected(self, token: NewToken):
        safe_emoji = "✅" if token.safe else "⛔"
        await self.send({
            "title": f"🔎 NEW TOKEN DETECTED {safe_emoji}",
            "description": f"**{token.name}** ({token.symbol})",
            "color": 0x00FF88 if token.safe else 0xFF4444,
            "fields": [
                {"name": "Mint", "value": f"`{token.mint[:20]}...`", "inline": False},
                {"name": "Source", "value": token.source.upper(), "inline": True},
                {"name": "Liquidity", "value": f"{token.initial_liq_sol:.1f} SOL", "inline": True},
                {"name": "Mint Revoked", "value": "✅ Yes" if token.mint_authority_revoked else "⚠️ No", "inline": True},
                {"name": "Top Holder", "value": f"{token.top_holder_pct:.1f}%", "inline": True},
                {"name": "Status", "value": "BUYING" if token.safe else f"SKIP: {token.reject_reason}", "inline": False},
            ],
            "footer": {"text": "Sniper v3 • Chain Monitor"},
        })

    async def buy_executed(self, pos: Position):
        stop_pct = 30.0 if DEGEN_MODE else TRAILING_STOP_PCT
        await self.send({
            "title": "💰 BOUGHT",
            "description": f"**{pos.token.name}** ({pos.token.symbol})",
            "color": 0x00FF88,
            "fields": [
                {"name": "Entry", "value": f"${pos.entry_price:.8f}", "inline": True},
                {"name": "Tokens", "value": f"{pos.amount_tokens:.2f}", "inline": True},
                {"name": "Cost", "value": f"{pos.cost_sol:.4f} SOL", "inline": True},
                {"name": "Stop", "value": f"{stop_pct}%", "inline": True},
                {"name": "Hard Exit", "value": f"{MAX_HOLD_HOURS}h", "inline": True},
                {"name": "Solscan", "value": f"[View](https://solscan.io/token/{pos.token.mint})", "inline": True},
            ],
        })

    async def position_closed(self, pos: Position):
        color = 0x00FF88 if pos.pnl_usd >= 0 else 0xFF4444
        emoji = "🟢" if pos.pnl_usd >= 0 else "🔴"
        reason = "⏰ TIMEOUT" if pos.exit_reason == "max_hold_timeout" else "📉 STOP"
        mins = pos.hold_seconds / 60
        await self.send({
            "title": f"{emoji} CLOSED — {reason}",
            "description": f"**{pos.token.name}** ({pos.token.symbol})",
            "color": color,
            "fields": [
                {"name": "Entry", "value": f"${pos.entry_price:.8f}", "inline": True},
                {"name": "Exit", "value": f"${pos.exit_price:.8f}", "inline": True},
                {"name": "P&L", "value": f"${pos.pnl_usd:+.4f}", "inline": True},
                {"name": "High", "value": f"${pos.highest_price:.8f}", "inline": True},
                {"name": "Held", "value": f"{mins:.1f}m", "inline": True},
            ],
        })

    async def error(self, msg: str):
        await self.send({"title": "⚠️ ERROR", "description": msg, "color": 0xFF4444})

    async def heartbeat(self, tokens_seen: int, open_pos: int, uptime_mins: float):
        stop_pct = 30.0 if DEGEN_MODE else TRAILING_STOP_PCT
        await self.send({
            "title": "💓 Sniper v3 Heartbeat",
            "color": 0x888888,
            "fields": [
                {"name": "Tokens Seen", "value": str(tokens_seen), "inline": True},
                {"name": "Open Positions", "value": str(open_pos), "inline": True},
                {"name": "Uptime", "value": f"{uptime_mins:.0f}m", "inline": True},
                {"name": "Mode", "value": "🔥 DEGEN" if DEGEN_MODE else "📊 Normal", "inline": True},
                {"name": "Trade", "value": f"{TRADE_AMOUNT_SOL} SOL", "inline": True},
                {"name": "Stop", "value": f"{stop_pct}% / {MAX_HOLD_HOURS}h", "inline": True},
            ],
        })


# ─── SOLANA RPC HELPERS ──────────────────────────────────────────────────────

class SolanaRPC:
    """HTTP + WebSocket RPC interactions."""

    def __init__(self, rpc_url: str, ws_url: str):
        self.rpc_url = rpc_url
        self.ws_url = ws_url

    async def call(self, method: str, params: list, session: aiohttp.ClientSession):
        payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        async with session.post(self.rpc_url, json=payload,
                                timeout=aiohttp.ClientTimeout(total=15)) as resp:
            return await resp.json()

    async def get_account_info(self, pubkey: str, session: aiohttp.ClientSession) -> Optional[dict]:
        result = await self.call("getAccountInfo", [pubkey, {"encoding": "jsonParsed"}], session)
        return result.get("result", {}).get("value")

    async def get_token_supply(self, mint: str, session: aiohttp.ClientSession) -> Optional[dict]:
        result = await self.call("getTokenSupply", [mint], session)
        return result.get("result", {}).get("value")

    async def get_token_largest_accounts(self, mint: str, session: aiohttp.ClientSession) -> list:
        result = await self.call("getTokenLargestAccounts", [mint], session)
        return result.get("result", {}).get("value", [])

    async def get_balance(self, pubkey: str, session: aiohttp.ClientSession) -> float:
        result = await self.call("getBalance", [pubkey], session)
        return result.get("result", {}).get("value", 0) / 1e9


# ─── SAFETY CHECKER ─────────────────────────────────────────────────────────

class SafetyChecker:
    """
    Runs safety checks on newly detected tokens before buying.
    Checks: liquidity, mint authority, top holder concentration.
    """

    def __init__(self, rpc: SolanaRPC):
        self.rpc = rpc

    async def check(self, token: NewToken, session: aiohttp.ClientSession) -> NewToken:
        """Run all safety checks. Sets token.safe and token.reject_reason."""
        try:
            # Check 1: Minimum liquidity
            if token.initial_liq_sol < MIN_LIQUIDITY_SOL:
                token.safe = False
                token.reject_reason = f"Low liquidity ({token.initial_liq_sol:.1f} < {MIN_LIQUIDITY_SOL} SOL)"
                return token

            # Check 2: Mint authority (can they print more tokens?)
            account_info = await self.rpc.get_account_info(token.mint, session)
            if account_info:
                parsed = account_info.get("data", {}).get("parsed", {}).get("info", {})
                mint_auth = parsed.get("mintAuthority")
                freeze_auth = parsed.get("freezeAuthority")

                token.mint_authority_revoked = mint_auth is None
                if REQUIRE_MINT_REVOKED and not token.mint_authority_revoked:
                    token.safe = False
                    token.reject_reason = "Mint authority NOT revoked (can print tokens)"
                    return token

                # Freeze authority is a bigger red flag
                if freeze_auth is not None:
                    token.safe = False
                    token.reject_reason = "Freeze authority active (can freeze your tokens)"
                    return token

                # Get token metadata
                token.symbol = parsed.get("symbol", token.symbol)
                token.name = parsed.get("name", token.name) if parsed.get("name") else token.name

            # Check 3: Top holder concentration
            largest = await self.rpc.get_token_largest_accounts(token.mint, session)
            supply_info = await self.rpc.get_token_supply(token.mint, session)
            if largest and supply_info:
                total_supply = float(supply_info.get("amount", "0"))
                if total_supply > 0 and len(largest) > 0:
                    top_amount = float(largest[0].get("amount", "0"))
                    token.top_holder_pct = (top_amount / total_supply) * 100

                    if token.top_holder_pct > MAX_TOP_HOLDER_PCT:
                        token.safe = False
                        token.reject_reason = f"Top holder owns {token.top_holder_pct:.1f}% (>{MAX_TOP_HOLDER_PCT}%)"
                        return token

            token.safe = True
            return token

        except Exception as e:
            log.warning(f"Safety check error for {token.mint[:16]}: {e}")
            # On error, still allow but flag it
            token.safe = True
            token.reject_reason = f"Check error: {e}"
            return token


# ─── CHAIN LISTENER ──────────────────────────────────────────────────────────

class ChainListener:
    """
    Subscribes to Solana logs via WebSocket and detects new pool creation
    from Raydium AMM, Raydium CPMM, and Pump.fun graduation.
    """

    def __init__(self, rpc: SolanaRPC, on_new_token):
        self.rpc = rpc
        self.on_new_token = on_new_token  # callback
        self.seen_mints: set[str] = set()
        self.tokens_seen_count = 0

    async def listen(self):
        """Main WebSocket listener loop with auto-reconnect."""
        while True:
            try:
                log.info(f"Connecting to Solana WebSocket: {self.rpc.ws_url[:40]}...")
                async with aiohttp.ClientSession() as session:
                    async with session.ws_connect(
                        self.rpc.ws_url,
                        heartbeat=30,
                        timeout=aiohttp.ClientTimeout(total=None),
                    ) as ws:
                        log.info("✅ WebSocket connected — subscribing to programs...")

                        # Subscribe to Raydium AMM (new pool creation)
                        await ws.send_json({
                            "jsonrpc": "2.0", "id": 1, "method": "logsSubscribe",
                            "params": [
                                {"mentions": [RAYDIUM_AMM_PROGRAM]},
                                {"commitment": "confirmed"},
                            ],
                        })

                        # Subscribe to Raydium CPMM
                        await ws.send_json({
                            "jsonrpc": "2.0", "id": 2, "method": "logsSubscribe",
                            "params": [
                                {"mentions": [RAYDIUM_CPMM_PROGRAM]},
                                {"commitment": "confirmed"},
                            ],
                        })

                        # Subscribe to Pump.fun (graduation events)
                        await ws.send_json({
                            "jsonrpc": "2.0", "id": 3, "method": "logsSubscribe",
                            "params": [
                                {"mentions": [PUMPFUN_PROGRAM]},
                                {"commitment": "confirmed"},
                            ],
                        })

                        log.info("📡 Listening for new token launches...")

                        async for msg in ws:
                            if msg.type == WSMsgType.TEXT:
                                await self._handle_message(msg.data)
                            elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSED):
                                log.warning(f"WS closed/error: {msg.type}")
                                break

            except Exception as e:
                log.error(f"WebSocket error: {e}")

            log.info("Reconnecting in 5s...")
            await asyncio.sleep(5)

    async def _handle_message(self, raw: str):
        """Parse a WebSocket log message and detect pool creation."""
        try:
            data = json.loads(raw)
            if "params" not in data:
                return

            result = data["params"]["result"]
            value = result.get("value", {})
            logs = value.get("logs", [])
            signature = value.get("signature", "")

            if not logs:
                return

            log_text = " ".join(logs)

            # ── RAYDIUM AMM: New pool (look for "initialize2" or "Initialize" instruction)
            if any(kw in log_text for kw in ["initialize2", "Initialize", "init_pc_amount"]):
                if RAYDIUM_AMM_PROGRAM in log_text or RAYDIUM_CPMM_PROGRAM in log_text:
                    await self._process_raydium_pool(signature, logs, log_text)

            # ── PUMP.FUN: Graduation (token leaves bonding curve → Raydium)
            if PUMPFUN_PROGRAM in log_text:
                if any(kw in log_text for kw in [
                    "Program log: Instruction: Withdraw",
                    "migrate",
                    "MigrateToRaydium",
                ]):
                    await self._process_pumpfun_graduation(signature, logs, log_text)

        except json.JSONDecodeError:
            pass
        except Exception as e:
            log.debug(f"Message parse error: {e}")

    async def _process_raydium_pool(self, signature: str, logs: list, log_text: str):
        """Extract new token mint from a Raydium pool creation transaction."""
        # Extract account keys from logs — look for mint addresses
        mints = self._extract_mints_from_logs(logs)

        for mint in mints:
            if mint in KNOWN_MINTS or mint in self.seen_mints:
                continue

            self.seen_mints.add(mint)
            self.tokens_seen_count += 1

            token = NewToken(
                mint=mint,
                source="raydium",
                paired_with=WSOL_MINT,
            )
            log.info(f"🆕 RAYDIUM POOL: {mint[:20]}... (tx: {signature[:20]})")

            # Fire callback
            await self.on_new_token(token, signature)

    async def _process_pumpfun_graduation(self, signature: str, logs: list, log_text: str):
        """Extract token mint from a Pump.fun graduation event."""
        mints = self._extract_mints_from_logs(logs)

        for mint in mints:
            if mint in KNOWN_MINTS or mint in self.seen_mints:
                continue

            self.seen_mints.add(mint)
            self.tokens_seen_count += 1

            token = NewToken(
                mint=mint,
                source="pumpfun",
                paired_with=WSOL_MINT,
            )
            log.info(f"🎓 PUMP.FUN GRAD: {mint[:20]}... (tx: {signature[:20]})")

            await self.on_new_token(token, signature)

    def _extract_mints_from_logs(self, logs: list) -> list[str]:
        """
        Extract potential token mint addresses from transaction logs.
        Solana addresses are base58 strings of 32-44 chars.
        We filter out known programs and well-known mints.
        """
        mints = []
        known_programs = {
            RAYDIUM_AMM_PROGRAM, RAYDIUM_CPMM_PROGRAM, PUMPFUN_PROGRAM,
            TOKEN_PROGRAM, TOKEN_2022_PROGRAM,
            "11111111111111111111111111111111",
            "SysvarRent111111111111111111111111111111111",
            "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
            "ComputeBudget111111111111111111111111111111",
        }

        for line in logs:
            # Look for "Program log:" lines that might contain account references
            words = line.split()
            for word in words:
                # Clean up the word
                clean = word.strip(",.;:()[]{}\"'")
                # Check if it looks like a Solana address (base58, 32-44 chars)
                if (len(clean) >= 32 and len(clean) <= 44
                    and all(c in "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz" for c in clean)
                    and clean not in known_programs
                    and clean not in KNOWN_MINTS):
                    mints.append(clean)

        return mints


# ─── JUPITER DEX ─────────────────────────────────────────────────────────────

class JupiterDEX:
    async def get_price(self, mint: str, session: aiohttp.ClientSession) -> Optional[float]:
        try:
            url = f"{JUPITER_PRICE_URL}?ids={mint}"
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=5)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    price = data.get("data", {}).get(mint, {}).get("price")
                    return float(price) if price else None
        except Exception:
            pass
        return None

    async def get_quote(self, input_mint: str, output_mint: str,
                        amount: int, session: aiohttp.ClientSession) -> Optional[dict]:
        params = {
            "inputMint": input_mint, "outputMint": output_mint,
            "amount": str(amount), "slippageBps": str(SLIPPAGE_BPS),
        }
        try:
            async with session.get(JUPITER_QUOTE_URL, params=params,
                                   timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status == 200:
                    return await resp.json()
                log.error(f"Quote error {resp.status}: {await resp.text()}")
        except Exception as e:
            log.error(f"Quote failed: {e}")
        return None

    async def execute_swap(self, quote: dict, pubkey: str,
                           session: aiohttp.ClientSession) -> Optional[dict]:
        payload = {
            "quoteResponse": quote, "userPublicKey": pubkey,
            "wrapAndUnwrapSol": True, "dynamicComputeUnitLimit": True,
            "prioritizationFeeLamports": "auto",
        }
        try:
            async with session.post(JUPITER_SWAP_URL, json=payload,
                                    timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status == 200:
                    return await resp.json()
                log.error(f"Swap error {resp.status}: {await resp.text()}")
        except Exception as e:
            log.error(f"Swap failed: {e}")
        return None


# ─── SOLANA TX HANDLER ───────────────────────────────────────────────────────

class SolanaHandler:
    def __init__(self, private_key_b58: str, rpc_url: str):
        self.rpc_url = rpc_url
        self.keypair = None
        self.pubkey = None

        if private_key_b58:
            try:
                from solders.keypair import Keypair
                import base58
                secret = base58.b58decode(private_key_b58)
                self.keypair = Keypair.from_bytes(secret)
                self.pubkey = str(self.keypair.pubkey())
                log.info(f"Wallet: {self.pubkey[:8]}...{self.pubkey[-4:]}")
            except ImportError:
                log.error("Install: pip install solders base58")
            except Exception as e:
                log.error(f"Wallet error: {e}")

    async def sign_and_send(self, swap_resp: dict, session: aiohttp.ClientSession) -> Optional[str]:
        if not self.keypair:
            return None
        try:
            from solders.transaction import VersionedTransaction
            import base64

            raw = base64.b64decode(swap_resp.get("swapTransaction", ""))
            txn = VersionedTransaction.from_bytes(raw)
            signed = VersionedTransaction(txn.message, [self.keypair])

            payload = {
                "jsonrpc": "2.0", "id": 1,
                "method": "sendTransaction",
                "params": [
                    base64.b64encode(bytes(signed)).decode(),
                    {"encoding": "base64", "skipPreflight": True, "maxRetries": 3},
                ],
            }
            async with session.post(self.rpc_url, json=payload,
                                    timeout=aiohttp.ClientTimeout(total=30)) as resp:
                result = await resp.json()
                if "result" in result:
                    sig = result["result"]
                    log.info(f"✅ TX: {sig[:20]}...")
                    return sig
                log.error(f"RPC: {result.get('error')}")
        except Exception as e:
            log.error(f"Sign/send: {e}")
        return None

    async def get_balance(self, session: aiohttp.ClientSession) -> float:
        if not self.pubkey:
            return 0.0
        try:
            payload = {"jsonrpc": "2.0", "id": 1, "method": "getBalance", "params": [self.pubkey]}
            async with session.post(self.rpc_url, json=payload) as resp:
                data = await resp.json()
                return data.get("result", {}).get("value", 0) / 1e9
        except Exception:
            return 0.0


# ─── TRAILING STOP MANAGER ──────────────────────────────────────────────────

class TrailingStopManager:
    def __init__(self, jupiter: JupiterDEX, solana: SolanaHandler, discord: DiscordAlert):
        self.jupiter = jupiter
        self.solana = solana
        self.discord = discord
        self.positions: list[Position] = []
        self.stop_pct = 30.0 if DEGEN_MODE else TRAILING_STOP_PCT

    def add(self, pos: Position):
        self.positions.append(pos)

    async def monitor_loop(self):
        log.info(f"Stop monitor: {self.stop_pct}% trail / {MAX_HOLD_HOURS}h hard exit")
        async with aiohttp.ClientSession() as session:
            while True:
                for pos in [p for p in self.positions if p.status == "open"]:
                    await self._check(pos, session)
                await asyncio.sleep(5)

    async def _check(self, pos: Position, session: aiohttp.ClientSession):
        price = await self.jupiter.get_price(pos.token.mint, session)
        if not price:
            return

        if pos.hold_expired:
            log.warning(f"⏰ {pos.token.symbol} timeout — sell @ ${price:.8f}")
            await self._exit(pos, price, "max_hold_timeout", session)
            return

        if price > pos.highest_price:
            pos.highest_price = price
            pos.trailing_stop_price = price * (1 - self.stop_pct / 100)
            log.info(f"📈 {pos.token.symbol} ${price:.8f} — stop ${pos.trailing_stop_price:.8f}")

        if price <= pos.trailing_stop_price:
            log.warning(f"🛑 {pos.token.symbol} stop hit @ ${price:.8f}")
            await self._exit(pos, price, "trailing_stop", session)

    async def _exit(self, pos: Position, price: float, reason: str, session: aiohttp.ClientSession):
        pos.status = "closed"
        pos.exit_price = price
        pos.exit_reason = reason
        pos.closed_at = datetime.now(timezone.utc).isoformat()
        pos.pnl_usd = (price - pos.entry_price) * pos.amount_tokens

        log.info(f"Close {pos.token.symbol}: ${pos.entry_price:.8f}→${price:.8f} P&L:${pos.pnl_usd:+.4f}")

        if pos.token.mint and self.solana.pubkey:
            amount = int(pos.amount_tokens * 1e6)
            quote = await self.jupiter.get_quote(pos.token.mint, WSOL_MINT, amount, session)
            if quote:
                swap = await self.jupiter.execute_swap(quote, self.solana.pubkey, session)
                if swap:
                    await self.solana.sign_and_send(swap, session)

        await self.discord.position_closed(pos)


# ─── MAIN BOT ───────────────────────────────────────────────────────────────

class SniperBot:
    def __init__(self):
        # Derive WebSocket URL from RPC URL
        ws_url = SOLANA_WS_URL
        if not ws_url:
            ws_url = SOLANA_RPC_URL.replace("https://", "wss://").replace("http://", "ws://")
        
        self.rpc = SolanaRPC(SOLANA_RPC_URL, ws_url)
        self.jupiter = JupiterDEX()
        self.solana = SolanaHandler(WALLET_PRIVATE_KEY, SOLANA_RPC_URL)
        self.discord = DiscordAlert(DISCORD_WEBHOOK_URL)
        self.safety = SafetyChecker(self.rpc)
        self.stop_mgr = TrailingStopManager(self.jupiter, self.solana, self.discord)
        self.listener = ChainListener(self.rpc, self._on_new_token)
        self.start_time = time.time()

    async def run(self):
        stop_pct = 30.0 if DEGEN_MODE else TRAILING_STOP_PCT
        log.info("=" * 60)
        log.info("  SOLANA SNIPER BOT v3 — CHAIN MONITOR")
        log.info(f"  Source: Solana blockchain (Raydium + Pump.fun)")
        log.info(f"  Mode: {'🔥 DEGEN' if DEGEN_MODE else '📊 Normal'}")
        log.info(f"  Trade: {TRADE_AMOUNT_SOL} SOL (~$2)")
        log.info(f"  Stop: {stop_pct}% trail | {MAX_HOLD_HOURS}h max")
        log.info(f"  Safety: min liq {MIN_LIQUIDITY_SOL} SOL | max holder {MAX_TOP_HOLDER_PCT}%")
        log.info(f"  Slippage: {SLIPPAGE_BPS}bps | Buy delay: {BUY_DELAY_SECONDS}s")
        log.info("=" * 60)

        async with aiohttp.ClientSession() as session:
            if self.solana.pubkey:
                bal = await self.solana.get_balance(session)
                log.info(f"Wallet: {bal:.4f} SOL")
            else:
                log.warning("⚠️  No wallet — MONITOR ONLY")

        await asyncio.gather(
            self.listener.listen(),
            self.stop_mgr.monitor_loop(),
            self._heartbeat_loop(),
        )

    async def _on_new_token(self, token: NewToken, signature: str):
        """Called by ChainListener when a new token is detected."""
        async with aiohttp.ClientSession() as session:
            # Get pool liquidity estimate
            token.initial_liq_sol = await self._estimate_pool_liquidity(token, session)

            # Run safety checks
            token = await self.safety.check(token, session)

            # Alert Discord
            await self.discord.new_token_detected(token)

            if not token.safe:
                log.info(f"⛔ SKIP {token.mint[:16]}: {token.reject_reason}")
                return

            # Brief delay to let liquidity settle
            if BUY_DELAY_SECONDS > 0:
                log.info(f"⏳ Waiting {BUY_DELAY_SECONDS}s before buying...")
                await asyncio.sleep(BUY_DELAY_SECONDS)

            # Execute buy
            await self._buy(token, session)

    async def _estimate_pool_liquidity(self, token: NewToken, session: aiohttp.ClientSession) -> float:
        """Estimate SOL liquidity by checking Jupiter quote for a small amount."""
        try:
            # Try to get a quote for 0.001 SOL worth — if it works, the pool has liquidity
            test_amount = int(0.001 * 1e9)  # 0.001 SOL in lamports
            quote = await self.jupiter.get_quote(WSOL_MINT, token.mint, test_amount, session)
            if quote:
                # If we got a quote, estimate total liquidity from price impact
                price_impact = float(quote.get("priceImpactPct", "100"))
                if price_impact < 100 and price_impact > 0:
                    # Rough estimate: if 0.001 SOL has X% impact, pool ≈ 0.001/impact * 100
                    estimated_liq = (0.001 / price_impact) * 100
                    return min(estimated_liq, 10000)  # cap at 10k
                return 10.0  # Got a quote, assume decent liquidity
            return 0.0
        except Exception:
            return 0.0

    async def _buy(self, token: NewToken, session: aiohttp.ClientSession):
        if not self.solana.pubkey:
            log.warning("Monitor only — skip buy")
            return

        bal = await self.solana.get_balance(session)
        if bal < TRADE_AMOUNT_SOL + 0.005:
            log.error(f"Low SOL: {bal:.4f}")
            await self.discord.error(f"Low balance: {bal:.4f} SOL")
            return

        price = await self.jupiter.get_price(token.mint, session)
        if not price:
            log.warning(f"No price for {token.mint[:16]}")
            return

        sol_lamports = int(TRADE_AMOUNT_SOL * 1e9)
        quote = await self.jupiter.get_quote(WSOL_MINT, token.mint, sol_lamports, session)
        if not quote:
            log.error(f"No route for {token.symbol}")
            await self.discord.error(f"No Jupiter route for **{token.symbol}**")
            return

        swap = await self.jupiter.execute_swap(quote, self.solana.pubkey, session)
        if not swap:
            return

        sig = await self.solana.sign_and_send(swap, session)
        if not sig:
            return

        out_amount = int(quote.get("outAmount", 0))
        decimals = int(quote.get("outputMint", {}).get("decimals", 6))
        tokens = out_amount / (10 ** decimals) if decimals else out_amount

        stop_pct = 30.0 if DEGEN_MODE else TRAILING_STOP_PCT
        pos = Position(
            token=token, entry_price=price, amount_tokens=tokens,
            cost_sol=TRADE_AMOUNT_SOL, highest_price=price,
            trailing_stop_price=price * (1 - stop_pct / 100),
            status="open",
        )
        self.stop_mgr.add(pos)
        await self.discord.buy_executed(pos)
        log.info(f"✅ BOUGHT {tokens:.2f} {token.symbol} @ ${price:.8f} for {TRADE_AMOUNT_SOL} SOL")

    async def _heartbeat_loop(self):
        while True:
            await asyncio.sleep(300)
            uptime = (time.time() - self.start_time) / 60
            open_pos = len([p for p in self.stop_mgr.positions if p.status == "open"])
            await self.discord.heartbeat(self.listener.tokens_seen_count, open_pos, uptime)


# ─── RUN ─────────────────────────────────────────────────────────────────────

def main():
    bot = SniperBot()
    try:
        asyncio.run(bot.run())
    except KeyboardInterrupt:
        log.info("Bot stopped")

if __name__ == "__main__":
    main()
