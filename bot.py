"""
Winston Pump Sniper
───────────────────
Watches Pump.fun + Raydium for NEW token launches.
Filters hard before buying. Exits fast with small profits.
Goal: dump before the whales do.

Strategy:
  - Detect via WebSocket regex (no getTransaction needed)
  - Filter: holders, top holder %, freeze authority, liquidity, green momentum
  - Buy: 0.012 SOL per trade, max 2 open positions
  - Exit tiers:
      1.5x → sell 40% (lock quick profit)
      2.5x → sell 40% more (house money)
      Remainder → tight 12% trailing stop
  - Hard stop: -18% from entry
  - Time stop: 8 minutes max hold
  - If price goes dead 90s → emergency sell
  - Retry sell up to 10x if it fails — never give up
"""

import asyncio, json, re, time, logging, os, base64 as b64
from dataclasses import dataclass, field
from typing import Optional
import aiohttp

# ─── CONFIG ──────────────────────────────────────────────────────────────────

TRADE_SOL         = float(os.getenv("TRADE_AMOUNT_SOL",   "0.037"))
MAX_POSITIONS     = int(os.getenv("MAX_OPEN_POSITIONS",   "2"))
SLIPPAGE_BPS      = int(os.getenv("SLIPPAGE_BPS",         "500"))    # 5% default, bot will retry with higher if needed
DISCORD_URL       = os.getenv("DISCORD_WEBHOOK_URL",      "")
RPC_URL           = os.getenv("SOLANA_RPC_URL",           "")
HELIUS_API_KEY    = os.getenv("HELIUS_API_KEY",           "")
WALLET_PK         = os.getenv("WALLET_PRIVATE_KEY",       "")
JUP_API_KEY       = os.getenv("JUPITER_API_KEY",          "")

# Exit config
STOP_LOSS_PCT     = float(os.getenv("STOP_LOSS_PCT",      "18"))   # hard stop -18%
TRAILING_PCT      = float(os.getenv("TRAILING_STOP_PCT",  "12"))   # trailing after 2.5x
TP1_X             = float(os.getenv("TP1_MULTIPLIER",     "1.5"))  # first take profit
TP1_SELL_PCT      = float(os.getenv("TP1_SELL_PCT",       "40"))   # sell 40% at 1.5x
TP2_X             = float(os.getenv("TP2_MULTIPLIER",     "2.5"))  # second take profit
TP2_SELL_PCT      = float(os.getenv("TP2_SELL_PCT",       "40"))   # sell 40% at 2.5x
MAX_HOLD_MINS     = float(os.getenv("MAX_HOLD_MINUTES",   "8"))    # 8 min hard timeout
PRICE_DEAD_SECS   = float(os.getenv("PRICE_DEAD_SECONDS", "90"))   # emergency sell if no price
SELL_RETRIES      = int(os.getenv("SELL_RETRY_ATTEMPTS",  "10"))

# Filter config
MIN_HOLDERS       = int(os.getenv("MIN_HOLDERS",          "5"))    # at least 5 holders
MAX_TOP_HOLDER    = float(os.getenv("MAX_TOP_HOLDER_PCT", "40"))   # top holder < 40%
GREEN_WAIT_SECS   = float(os.getenv("GREEN_WAIT_SECONDS", "2"))    # seconds to wait before green check

# Programs
PUMPFUN    = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
RAYDIUM    = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
WSOL       = "So11111111111111111111111111111111111111112"
USDC       = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDT       = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
SKIP_MINTS = {WSOL, USDC, USDT}

# Fee optimization
PRIORITY_FEE_BUY  = int(os.getenv("PRIORITY_FEE_BUY",   "50000"))   # 0.00005 SOL — low for buys
PRIORITY_FEE_SELL = int(os.getenv("PRIORITY_FEE_SELL",  "200000"))  # 0.0002 SOL — higher to guarantee fast exit
MAX_SLIPPAGE_BPS  = 2000  # absolute max slippage we'll ever use (20%)

# Jupiter endpoints
JUP_QUOTE  = "https://lite-api.jup.ag/swap/v1/quote"
JUP_SWAP   = "https://lite-api.jup.ag/swap/v1/swap"
JUP_PRICE  = "https://lite-api.jup.ag/price/v2"

# Pump.fun mint regex — ends with 'pump', 32-44 base58 chars
PUMP_RE = re.compile(r'[1-9A-HJ-NP-Za-km-z]{28,43}pump')

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s │ %(levelname)-7s │ %(message)s",
    datefmt="%H:%M:%S"
)
log = logging.getLogger("winston")

class RateLimitError(Exception):
    pass

# ─── MODELS ──────────────────────────────────────────────────────────────────

@dataclass
class Token:
    mint:   str
    symbol: str = "???"
    name:   str = "Unknown"
    source: str = "pumpfun"

@dataclass
class Position:
    token:          Token
    entry_price:    float = 0.0
    tokens_held:    float = 0.0
    original_tokens:float = 0.0
    cost_sol:       float = 0.0
    high_price:     float = 0.0
    stop_price:     float = 0.0
    status:         str   = "open"
    exit_price:     float = 0.0
    exit_reason:    str   = ""
    pnl_sol:        float = 0.0
    opened_ts:      float = field(default_factory=time.time)
    took_tp1:       bool  = False
    took_tp2:       bool  = False
    price_fail_ts:  float = 0.0   # when price first went dead
    sell_attempt:   int   = 0

    def __post_init__(self):
        if not self.original_tokens:
            self.original_tokens = self.tokens_held
        if not self.high_price:
            self.high_price = self.entry_price
        if not self.stop_price:
            self.stop_price = self.entry_price * (1 - STOP_LOSS_PCT / 100)

    @property
    def hold_secs(self): return time.time() - self.opened_ts
    @property
    def timed_out(self): return self.hold_secs >= MAX_HOLD_MINS * 60

# ─── JUPITER ─────────────────────────────────────────────────────────────────

class Jupiter:
    def _headers(self):
        h = {"Content-Type": "application/json", "Accept": "application/json"}
        if JUP_API_KEY: h["x-api-key"] = JUP_API_KEY
        return h

    def _conn(self):
        try:
            from aiohttp.resolver import AsyncResolver
            return aiohttp.TCPConnector(
                resolver=AsyncResolver(nameservers=["8.8.8.8","1.1.1.1"]),
                ssl=False
            )
        except:
            return aiohttp.TCPConnector(ssl=False)

    async def get_price(self, mint: str, token_amount: int) -> Optional[float]:
        """Price via quote: token_amount tokens → SOL. Returns SOL per token."""
        # Method 1: Price API (fast, fails on brand new tokens)
        try:
            async with aiohttp.ClientSession(connector=self._conn(), headers=self._headers()) as s:
                async with s.get(f"{JUP_PRICE}?ids={mint}", timeout=aiohttp.ClientTimeout(total=4)) as r:
                    if r.status == 429:
                        raise RateLimitError()
                    if r.status == 200:
                        d = await r.json()
                        p = d.get("data", {}).get(mint, {}).get("price")
                        if p: return float(p)
        except RateLimitError:
            raise
        except: pass

        # Method 2: Quote-based (works on brand new tokens)
        try:
            params = {
                "inputMint": mint,
                "outputMint": WSOL,
                "amount": str(token_amount),
                "slippageBps": str(SLIPPAGE_BPS),
            }
            async with aiohttp.ClientSession(connector=self._conn(), headers=self._headers()) as s:
                async with s.get(JUP_QUOTE, params=params, timeout=aiohttp.ClientTimeout(total=6)) as r:
                    if r.status == 429:
                        raise RateLimitError()
                    if r.status == 200:
                        d = await r.json()
                        out_lamports = int(d.get("outAmount", "0"))
                        if out_lamports > 0:
                            out_sol = out_lamports / 1e9
                            tokens = token_amount / 1e6
                            return out_sol / tokens
        except RateLimitError:
            raise
        except: pass

        return None

    async def quote(self, inp: str, out: str, amount: int, slippage_bps: int = None) -> Optional[dict]:
        params = {
            "inputMint": inp,
            "outputMint": out,
            "amount": str(amount),
            "slippageBps": str(slippage_bps if slippage_bps is not None else SLIPPAGE_BPS),
            "onlyDirectRoutes": "false",
        }
        try:
            async with aiohttp.ClientSession(connector=self._conn(), headers=self._headers()) as s:
                async with s.get(JUP_QUOTE, params=params, timeout=aiohttp.ClientTimeout(total=8)) as r:
                    if r.status == 429:
                        log.warning("Quote 429: rate limited")
                        raise RateLimitError()
                    if r.status == 200:
                        return await r.json()
                    log.error(f"Quote {r.status}: {(await r.text())[:120]}")
        except RateLimitError:
            raise
        except Exception as e:
            log.error(f"Quote error: {e}")
        return None

    async def build_swap(self, quote_resp: dict, wallet: str, priority_fee: int = None) -> Optional[str]:
        # Use explicit priority fee — 'auto' often overpays by 5-10x
        fee = priority_fee if priority_fee is not None else PRIORITY_FEE_BUY
        body = {
            "quoteResponse": quote_resp,
            "userPublicKey": wallet,
            "wrapAndUnwrapSol": True,
            "dynamicComputeUnitLimit": True,
            "prioritizationFeeLamports": fee,
        }
        try:
            async with aiohttp.ClientSession(connector=self._conn(), headers=self._headers()) as s:
                async with s.post(JUP_SWAP, json=body, timeout=aiohttp.ClientTimeout(total=12)) as r:
                    if r.status == 200:
                        d = await r.json()
                        return d.get("swapTransaction")
                    log.error(f"Swap build {r.status}: {(await r.text())[:120]}")
        except Exception as e:
            log.error(f"Swap build error: {e}")
        return None

# ─── SOLANA ──────────────────────────────────────────────────────────────────

class Solana:
    def __init__(self):
        self.rpc = RPC_URL
        self.ws  = RPC_URL.replace("https://", "wss://").replace("http://", "ws://")
        self.keypair = None
        self.pubkey  = None

        if WALLET_PK:
            try:
                from solders.keypair import Keypair
                import base58
                self.keypair = Keypair.from_bytes(base58.b58decode(WALLET_PK))
                self.pubkey  = str(self.keypair.pubkey())
                log.info(f"Wallet: {self.pubkey[:8]}...{self.pubkey[-4:]}")
            except Exception as e:
                log.error(f"Wallet load error: {e}")

    async def get_balance(self) -> float:
        if not self.pubkey: return 0.0
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(self.rpc, json={
                    "jsonrpc": "2.0", "id": 1,
                    "method": "getBalance", "params": [self.pubkey]
                }, timeout=aiohttp.ClientTimeout(total=10)) as r:
                    d = await r.json()
                    return d.get("result", {}).get("value", 0) / 1e9
        except: return 0.0

    async def rpc_call(self, method: str, params: list) -> dict:
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(self.rpc, json={
                    "jsonrpc": "2.0", "id": 1,
                    "method": method, "params": params
                }, timeout=aiohttp.ClientTimeout(total=8)) as r:
                    return await r.json()
        except: return {}

    def sign_and_serialize(self, tx_b64: str) -> Optional[str]:
        if not self.keypair: return None
        try:
            from solders.transaction import VersionedTransaction
            raw = b64.b64decode(tx_b64)
            txn = VersionedTransaction.from_bytes(raw)
            signed = VersionedTransaction(txn.message, [self.keypair])
            return b64.b64encode(bytes(signed)).decode()
        except Exception as e:
            log.error(f"Sign error: {e}")
            return None

    async def send_raw(self, signed_b64: str) -> Optional[str]:
        """Send raw signed transaction directly via RPC."""
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(self.rpc, json={
                    "jsonrpc": "2.0", "id": 1,
                    "method": "sendTransaction",
                    "params": [signed_b64, {
                        "encoding": "base64",
                        "skipPreflight": True,
                        "maxRetries": 3,
                        "preflightCommitment": "processed"
                    }]
                }, timeout=aiohttp.ClientTimeout(total=20)) as r:
                    d = await r.json()
                    sig = d.get("result")
                    if sig:
                        return sig
                    err = d.get("error", {})
                    log.error(f"sendTransaction error: {err}")
        except Exception as e:
            log.error(f"sendRaw error: {e}")
        return None

    async def confirm_tx(self, sig: str, timeout: int = 30) -> bool:
        """Poll for transaction confirmation."""
        start = time.time()
        while time.time() - start < timeout:
            try:
                async with aiohttp.ClientSession() as s:
                    async with s.post(self.rpc, json={
                        "jsonrpc": "2.0", "id": 1,
                        "method": "getSignatureStatuses",
                        "params": [[sig], {"searchTransactionHistory": False}]
                    }, timeout=aiohttp.ClientTimeout(total=8)) as r:
                        d = await r.json()
                        result = d.get("result", {}).get("value", [None])
                        status = result[0] if result else None
                        if status:
                            if status.get("err"):
                                log.error(f"TX {sig[:20]} failed on-chain")
                                return False
                            conf = status.get("confirmationStatus", "")
                            if conf in ("confirmed", "finalized"):
                                return True
            except: pass
            await asyncio.sleep(1)
        return False

# ─── DISCORD ─────────────────────────────────────────────────────────────────

class Discord:
    async def send(self, embed: dict):
        if not DISCORD_URL: return
        try:
            async with aiohttp.ClientSession() as s:
                await s.post(DISCORD_URL, json={"username": "Winston Sniper", "embeds": [embed]},
                             timeout=aiohttp.ClientTimeout(total=5))
        except: pass

    async def bought(self, pos: Position):
        await self.send({
            "title": f"🟢 BOUGHT — {pos.token.symbol}",
            "color": 0x00FF88,
            "fields": [
                {"name": "Mint",   "value": f"`{pos.token.mint}`",                        "inline": False},
                {"name": "Price",  "value": f"${pos.entry_price:.10f}",                   "inline": True},
                {"name": "Spent",  "value": f"{pos.cost_sol} SOL",                        "inline": True},
                {"name": "Source", "value": pos.token.source,                             "inline": True},
                {"name": "Link",   "value": f"[Solscan](https://solscan.io/token/{pos.token.mint})", "inline": False},
            ]
        })

    async def sold(self, pos: Position, reason: str, pct: int):
        win = pos.pnl_sol >= 0
        gain_x = pos.exit_price / pos.entry_price if pos.entry_price > 0 else 0
        await self.send({
            "title": f"{'💰' if win else '🛑'} SOLD {pct}% — {pos.token.symbol} ({reason})",
            "color": 0x00FF88 if win else 0xFF4444,
            "fields": [
                {"name": "PnL SOL",   "value": f"{pos.pnl_sol:+.5f} SOL",     "inline": True},
                {"name": "Multiplier","value": f"{gain_x:.2f}x",               "inline": True},
                {"name": "Held",      "value": f"{pos.hold_secs/60:.1f}m",     "inline": True},
                {"name": "Entry",     "value": f"${pos.entry_price:.10f}",     "inline": True},
                {"name": "Exit",      "value": f"${pos.exit_price:.10f}",      "inline": True},
                {"name": "Reason",    "value": reason,                         "inline": True},
            ]
        })

    async def startup(self, wallet: str, balance: float):
        await self.send({
            "title": "🚀 Winston Sniper Online",
            "color": 0x00AAFF,
            "fields": [
                {"name": "Wallet",       "value": f"`{wallet[:8]}...{wallet[-4:]}`", "inline": True},
                {"name": "Balance",      "value": f"{balance:.4f} SOL",              "inline": True},
                {"name": "Buy Size",     "value": f"{TRADE_SOL} SOL",                "inline": True},
                {"name": "Max Positions","value": str(MAX_POSITIONS),                "inline": True},
                {"name": "TP1",          "value": f"{TP1_X}x → sell {TP1_SELL_PCT}%","inline": True},
                {"name": "TP2",          "value": f"{TP2_X}x → sell {TP2_SELL_PCT}%","inline": True},
                {"name": "Hard Stop",    "value": f"-{STOP_LOSS_PCT}%",              "inline": True},
                {"name": "Time Stop",    "value": f"{MAX_HOLD_MINS}m",              "inline": True},
            ]
        })

    async def error(self, title: str, msg: str):
        await self.send({"title": f"⚠️ {title}", "color": 0xFF6600,
                         "fields": [{"name": "Details", "value": msg[:500], "inline": False}]})

# ─── SWAP ENGINE ─────────────────────────────────────────────────────────────

class SwapEngine:
    """Handles buy and sell via Jupiter quote → swap → sendRawTransaction."""

    def __init__(self, jup: Jupiter, sol: Solana):
        self.jup = jup
        self.sol = sol

    async def buy(self, mint: str, sol_amount: float) -> Optional[dict]:
        """
        Buy with fee optimization:
        - Low priority fee (0.00005 SOL) — enough for new token buys
        - If slippage fails, retry once with higher slippage
        - Never use 'auto' priority which can overpay 5-10x
        """
        lamports = int(sol_amount * 1e9)
        log.info(f"[BUY] Quoting {mint[:16]}... for {sol_amount} SOL")

        # Try with default slippage first, then higher if it fails
        slippage_attempts = [SLIPPAGE_BPS, min(SLIPPAGE_BPS * 2, MAX_SLIPPAGE_BPS)]

        for slippage in slippage_attempts:
            # Temporarily override slippage in quote
            import copy
            orig_slippage = SLIPPAGE_BPS

            q = await self.jup.quote(WSOL, mint, lamports)
            if not q:
                log.error(f"[BUY] No quote for {mint[:16]}")
                continue

            out_tokens = int(q.get("outAmount", "0"))
            if out_tokens <= 0:
                log.error(f"[BUY] Zero out amount")
                continue

            # Low priority fee for buys — saves ~0.001-0.003 SOL per trade
            tx_b64 = await self.jup.build_swap(q, self.sol.pubkey, priority_fee=PRIORITY_FEE_BUY)
            if not tx_b64:
                log.error(f"[BUY] Swap build failed")
                continue

            signed = self.sol.sign_and_serialize(tx_b64)
            if not signed:
                return None

            sig = await self.sol.send_raw(signed)
            if not sig:
                log.error(f"[BUY] sendRaw failed")
                continue

            log.info(f"[BUY] TX sent: {sig[:25]}... confirming")
            confirmed = await self.sol.confirm_tx(sig, timeout=30)
            if not confirmed:
                log.warning(f"[BUY] TX unconfirmed with {slippage}bps slippage — retrying with higher")
                continue

            tokens = out_tokens / 1e6
            price  = sol_amount / tokens if tokens > 0 else 0
            log.info(f"[BUY] ✅ {tokens:.0f} tokens @ ${price:.10f} | fee={PRIORITY_FEE_BUY} lamports | TX: {sig[:25]}")
            return {"tokens": tokens, "entry_price": price, "sig": sig, "out_raw": out_tokens}

        log.error(f"[BUY] All attempts failed for {mint[:16]}")
        return None

    async def sell(self, mint: str, token_amount_raw: int, attempt: int = 1) -> Optional[dict]:
        """
        Sell with escalating fee + slippage on retries.
        Handles 429 rate limits with automatic backoff.
        """
        log.info(f"[SELL] Attempt {attempt}: {mint[:16]}... amount={token_amount_raw}")

        # Escalate fee on retries
        fee = PRIORITY_FEE_SELL if attempt <= 2 else PRIORITY_FEE_SELL * 2

        # Escalate slippage gradually — more willing to take worse price to guarantee exit
        slippage_bps = min(SLIPPAGE_BPS + (attempt - 1) * 300, MAX_SLIPPAGE_BPS)

        try:
            q = await self.jup.quote(mint, WSOL, token_amount_raw, slippage_bps=slippage_bps)
        except RateLimitError:
            log.warning(f"[SELL] Rate limited on attempt {attempt} — waiting 8s")
            await asyncio.sleep(8)
            return None

        if not q:
            log.error(f"[SELL] No quote for {mint[:16]} — token may have no liquidity (rugged?)")
            return None

        out_lamports = int(q.get("outAmount", "0"))
        if out_lamports <= 0:
            log.error(f"[SELL] Zero out lamports")
            return None

        tx_b64 = await self.jup.build_swap(q, self.sol.pubkey, priority_fee=fee)
        if not tx_b64:
            return None

        signed = self.sol.sign_and_serialize(tx_b64)
        if not signed:
            return None

        sig = await self.sol.send_raw(signed)
        if not sig:
            return None

        log.info(f"[SELL] TX sent: {sig[:25]}... fee={fee} slippage={slippage_bps}bps")
        confirmed = await self.sol.confirm_tx(sig, timeout=25)
        if not confirmed:
            log.error(f"[SELL] TX not confirmed: {sig[:25]}")
            return None

        sol_received = out_lamports / 1e9
        log.info(f"[SELL] ✅ Got {sol_received:.5f} SOL | TX: {sig[:25]}")
        return {"sol_received": sol_received, "sig": sig}

# ─── EXIT ENGINE ─────────────────────────────────────────────────────────────

class ExitEngine:
    def __init__(self, jup: Jupiter, swap: SwapEngine, discord: Discord):
        self.jup = jup
        self.swap = swap
        self.discord = discord
        self.positions: list[Position] = []

    def add(self, pos: Position):
        self.positions.append(pos)
        log.info(f"[EXIT] Tracking {pos.token.symbol} | Stop: ${pos.stop_price:.10f}")

    @property
    def open_count(self):
        return len([p for p in self.positions if p.status == "open"])

    async def run(self):
        log.info(f"[EXIT] Engine running | TP1={TP1_X}x TP2={TP2_X}x Stop={STOP_LOSS_PCT}% Trail={TRAILING_PCT}%")
        self._rate_limited_until = 0
        while True:
            # Back off polling when rate limited
            if time.time() < self._rate_limited_until:
                await asyncio.sleep(2)
                continue
            for pos in [p for p in self.positions if p.status == "open"]:
                try:
                    await self._check(pos)
                except Exception as e:
                    log.error(f"[EXIT] Check error {pos.token.symbol}: {e}")
            await asyncio.sleep(3)

    async def _check(self, pos: Position):
        # Use actual tokens held for price check
        test_raw = max(int(pos.tokens_held * 1e6 * 0.01), 100_000)  # 1% of holdings
        try:
            price = await self.jup.get_price(pos.token.mint, test_raw)
        except RateLimitError:
            log.warning("[EXIT] Rate limited by Jupiter — backing off 10s")
            self._rate_limited_until = time.time() + 10
            return

        # ── PRICE DEAD CHECK ──
        if not price or price <= 0:
            if pos.price_fail_ts == 0:
                pos.price_fail_ts = time.time()
                log.warning(f"[EXIT] {pos.token.symbol}: price went dead")
            elif time.time() - pos.price_fail_ts >= PRICE_DEAD_SECS:
                log.error(f"[EXIT] {pos.token.symbol}: price dead {PRICE_DEAD_SECS}s — emergency sell")
                await self._do_sell(pos, pos.entry_price * 0.5, "price_dead", 100)
            return

        pos.price_fail_ts = 0  # reset on success
        gain_x = price / pos.entry_price if pos.entry_price > 0 else 1.0

        log.info(f"[EXIT] {pos.token.symbol} ${price:.8f} ({gain_x:.2f}x) stop=${pos.stop_price:.8f}")

        # ── TIME STOP ──
        if pos.timed_out:
            log.warning(f"[EXIT] {pos.token.symbol}: {MAX_HOLD_MINS}m timeout — selling all")
            await self._do_sell(pos, price, "timeout", 100)
            return

        # ── HARD STOP LOSS ──
        if price <= pos.stop_price and not pos.took_tp1:
            log.warning(f"[EXIT] {pos.token.symbol}: stop loss hit @ ${price:.8f}")
            await self._do_sell(pos, price, "stop_loss", 100)
            return

        # ── TP1 ──
        if gain_x >= TP1_X and not pos.took_tp1:
            pos.took_tp1 = True
            log.info(f"[EXIT] {pos.token.symbol}: TP1 {TP1_X}x! Selling {TP1_SELL_PCT}%")
            await self._do_sell(pos, price, f"tp1_{TP1_X}x", int(TP1_SELL_PCT))
            # Tighten stop to entry price (break even protection)
            pos.stop_price = pos.entry_price * 1.01
            return

        # ── TP2 ──
        if gain_x >= TP2_X and not pos.took_tp2:
            pos.took_tp2 = True
            log.info(f"[EXIT] {pos.token.symbol}: TP2 {TP2_X}x! Selling {TP2_SELL_PCT}% more")
            await self._do_sell(pos, price, f"tp2_{TP2_X}x", int(TP2_SELL_PCT))
            # Tight trailing stop on remainder
            pos.stop_price = price * (1 - TRAILING_PCT / 100)
            return

        # ── UPDATE TRAILING STOP (after TP2) ──
        if pos.took_tp2 and price > pos.high_price:
            pos.high_price = price
            new_stop = price * (1 - TRAILING_PCT / 100)
            if new_stop > pos.stop_price:
                pos.stop_price = new_stop
                log.info(f"[EXIT] {pos.token.symbol}: trail stop → ${pos.stop_price:.8f}")

        # ── TRAILING STOP HIT (after TP2) ──
        if pos.took_tp2 and price <= pos.stop_price:
            log.info(f"[EXIT] {pos.token.symbol}: trailing stop hit")
            await self._do_sell(pos, price, "trailing_stop", 100)
            return

        # ── TIGHTEN STOP AFTER TP1 (between TP1 and TP2) ──
        if pos.took_tp1 and not pos.took_tp2:
            if price > pos.high_price:
                pos.high_price = price
                # Keep stop at entry for now, update when we hit TP2

    async def _do_sell(self, pos: Position, price: float, reason: str, pct: int):
        """Execute sell with retry loop — never gives up."""
        tokens_to_sell = pos.tokens_held * (pct / 100)
        raw_amount = int(tokens_to_sell * 1e6)

        if raw_amount <= 0:
            log.warning(f"[SELL] Zero tokens to sell for {pos.token.symbol}")
            if pct >= 100:
                pos.status = "closed"
            return

        pos.exit_price = price
        pos.exit_reason = reason

        # Retry loop — progressive delays to avoid 429s
        for attempt in range(1, SELL_RETRIES + 1):
            result = await self.swap.sell(pos.token.mint, raw_amount, attempt)
            if result:
                sol_received = result["sol_received"]
                cost_portion = pos.cost_sol * (pct / 100)
                pos.pnl_sol = sol_received - cost_portion
                pos.tokens_held -= tokens_to_sell

                log.info(f"[SELL] ✅ {pos.token.symbol} {pct}% | Got {sol_received:.5f} SOL | PnL: {pos.pnl_sol:+.5f} SOL")

                if pct >= 100:
                    pos.status = "closed"

                await self.discord.sold(pos, reason, pct)
                return

            # Progressive backoff: 3s, 5s, 8s, 8s, 8s...
            delay = 3 if attempt == 1 else (5 if attempt == 2 else 8)
            log.warning(f"[SELL] Attempt {attempt}/{SELL_RETRIES} failed for {pos.token.symbol} — retrying in {delay}s")
            await asyncio.sleep(delay)

        # All retries failed — start emergency background retry
        log.error(f"[SELL] ❌ ALL {SELL_RETRIES} attempts failed for {pos.token.symbol} — starting emergency loop")
        await self.discord.error(f"SELL FAILED: {pos.token.symbol}", f"All {SELL_RETRIES} attempts failed. Emergency retry loop running.")
        asyncio.create_task(self._emergency_sell(pos, raw_amount, reason))

    async def _emergency_sell(self, pos: Position, raw_amount: int, reason: str):
        """Runs every 10s forever until sold."""
        attempt = 0
        while pos.status == "open":
            attempt += 1
            await asyncio.sleep(10)
            log.warning(f"[SELL] 🚨 Emergency attempt #{attempt} for {pos.token.symbol}")
            # Refresh token balance each time
            try:
                fresh_raw = await self._get_token_balance_raw(pos.token.mint)
                if fresh_raw is not None:
                    raw_amount = fresh_raw
                if raw_amount <= 0:
                    log.info(f"[SELL] {pos.token.symbol} balance is 0 — assuming sold")
                    pos.status = "closed"
                    return
            except: pass

            result = await self.swap.sell(pos.token.mint, raw_amount, attempt)
            if result:
                pos.pnl_sol = result["sol_received"] - pos.cost_sol
                pos.status = "closed"
                await self.discord.sold(pos, reason + "_emergency", 100)
                log.info(f"[SELL] ✅ Emergency sell succeeded on attempt #{attempt}")
                return

    async def _get_token_balance_raw(self, mint: str) -> Optional[int]:
        """Get raw token balance from wallet."""
        if not self.swap.sol.pubkey: return None
        try:
            sol = self.swap.sol
            res = await sol.rpc_call("getTokenAccountsByOwner", [
                sol.pubkey,
                {"mint": mint},
                {"encoding": "jsonParsed"}
            ])
            accounts = res.get("result", {}).get("value", [])
            if accounts:
                amt = accounts[0]["account"]["data"]["parsed"]["info"]["tokenAmount"]["amount"]
                return int(amt)
        except: pass
        return None

# ─── DETECTOR ────────────────────────────────────────────────────────────────

class Detector:
    """
    Listens to Pump.fun + Raydium WebSocket logs.
    Extracts mint via regex (no getTransaction needed).
    Only fires on graduation events (token leaving bonding curve = real activity).
    """

    def __init__(self, sol: Solana, callback):
        self.sol = sol
        self.callback = callback
        self.seen_sigs = set()
        self.seen_mints = set()
        self.total = 0

    async def listen(self):
        while True:
            try:
                log.info("[DETECT] Connecting WebSocket...")
                async with aiohttp.ClientSession() as sess:
                    async with sess.ws_connect(
                        self.sol.ws,
                        heartbeat=20,
                        timeout=aiohttp.ClientTimeout(total=None)
                    ) as ws:
                        log.info("[DETECT] ✅ Connected")

                        # Subscribe to Pump.fun (graduation = token leaving bonding curve)
                        await ws.send_json({
                            "jsonrpc": "2.0", "id": 1,
                            "method": "logsSubscribe",
                            "params": [{"mentions": [PUMPFUN]}, {"commitment": "processed"}]
                        })
                        # Subscribe to Raydium (new pool initialization = high momentum token)
                        await ws.send_json({
                            "jsonrpc": "2.0", "id": 2,
                            "method": "logsSubscribe",
                            "params": [{"mentions": [RAYDIUM]}, {"commitment": "processed"}]
                        })

                        log.info("[DETECT] 👀 Listening for launches...")

                        async for msg in ws:
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                asyncio.create_task(self._handle(msg.data))
                            elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSED):
                                break

            except Exception as e:
                log.error(f"[DETECT] WS error: {e}")

            log.info("[DETECT] Reconnecting in 3s...")
            await asyncio.sleep(3)

    async def _handle(self, raw: str):
        try:
            data = json.loads(raw)
            if "params" not in data: return

            value = data["params"]["result"].get("value", {})
            logs  = value.get("logs", [])
            sig   = value.get("signature", "")

            if not logs or not sig: return
            if sig in self.seen_sigs: return

            log_text = " ".join(logs)

            # ── SOURCE DETECTION ──
            # Pump.fun: "Withdraw" = token graduated (leaving bonding curve) = HUGE momentum signal
            # Raydium: "initialize2" = new AMM pool created = token already pumping
            is_pumpfun_grad = (PUMPFUN in log_text and
                               ("Withdraw" in log_text or "migrate" in log_text.lower() or
                                "Instruction: Create" in log_text))
            is_raydium_new  = ("initialize2" in log_text or "InitializeInstruction2" in log_text)

            if not is_pumpfun_grad and not is_raydium_new:
                return

            self.seen_sigs.add(sig)
            source = "pumpfun" if is_pumpfun_grad else "raydium"

            # ── MINT EXTRACTION VIA REGEX ──
            # Pump.fun mints always end in 'pump' — extract directly from log text
            mints = PUMP_RE.findall(log_text)
            mint  = None

            for m in mints:
                if m not in SKIP_MINTS and m not in self.seen_mints and len(m) >= 32:
                    mint = m
                    break

            if not mint:
                log.debug(f"[DETECT] No pump mint in {source} tx {sig[:16]}")
                return

            if mint in self.seen_mints:
                return

            self.seen_mints.add(mint)
            self.total += 1

            log.info(f"[DETECT] 🎯 {source.upper()} mint: {mint[:24]}... (total: {self.total})")
            await self.callback(Token(mint=mint, source=source))

        except Exception as e:
            log.debug(f"[DETECT] Handle error: {e}")

# ─── FILTER ENGINE ───────────────────────────────────────────────────────────

class FilterEngine:
    """
    Quality filters before buying.
    All must pass or token is skipped.
    """

    def __init__(self, sol: Solana, jup: Jupiter):
        self.sol = sol
        self.jup = jup

    async def passes(self, token: Token) -> bool:
        mint = token.mint

        try:
            # ── FILTER 1: Must be a Pump.fun token ──
            if not mint.endswith("pump"):
                log.info(f"[FILTER] ❌ {mint[:16]}: not a pump token")
                return False

            # ── FILTER 2: Holder count ──
            res = await self.sol.rpc_call("getTokenLargestAccounts", [mint])
            holders = res.get("result", {}).get("value", [])
            if len(holders) < MIN_HOLDERS:
                log.info(f"[FILTER] ❌ {mint[:16]}: only {len(holders)} holders (need {MIN_HOLDERS}+)")
                return False

            # ── FILTER 3: Top holder concentration ──
            supply_res = await self.sol.rpc_call("getTokenSupply", [mint])
            supply_info = supply_res.get("result", {}).get("value", {})
            total_supply = float(supply_info.get("amount", "0"))

            if total_supply > 0 and holders:
                top_amount = float(holders[0].get("amount", "0"))
                top_pct = (top_amount / total_supply) * 100
                if top_pct > MAX_TOP_HOLDER:
                    log.info(f"[FILTER] ❌ {mint[:16]}: top holder {top_pct:.0f}% (max {MAX_TOP_HOLDER}%)")
                    return False

            # ── FILTER 4: Freeze authority check ──
            acct_res = await self.sol.rpc_call("getAccountInfo", [mint, {"encoding": "jsonParsed"}])
            acct = acct_res.get("result", {}).get("value", {})
            if acct:
                parsed = acct.get("data", {}).get("parsed", {}).get("info", {})
                if parsed.get("freezeAuthority"):
                    log.info(f"[FILTER] ❌ {mint[:16]}: freeze authority active")
                    return False
                # Pull symbol/name while we're here
                if parsed.get("symbol"): token.symbol = parsed["symbol"]
                if parsed.get("name"):   token.name   = parsed["name"]

            # ── FILTER 5: Liquidity check ──
            test_lamports = int(0.005 * 1e9)  # tiny test quote
            q = await self.jup.quote(WSOL, mint, test_lamports)
            if not q or int(q.get("outAmount", "0")) <= 0:
                log.info(f"[FILTER] ❌ {mint[:16]}: no liquidity")
                return False

            # ── FILTER 6: GREEN momentum check ──
            # Wait a moment then take two price samples — must be going UP
            test_raw = int(q.get("outAmount", "0"))  # reuse from liquidity check
            if test_raw <= 0:
                return False

            price1 = await self.jup.get_price(mint, test_raw)
            if not price1 or price1 <= 0:
                log.info(f"[FILTER] ❌ {mint[:16]}: no price")
                return False

            await asyncio.sleep(GREEN_WAIT_SECS)

            price2 = await self.jup.get_price(mint, test_raw)
            if not price2 or price2 <= 0:
                log.info(f"[FILTER] ❌ {mint[:16]}: price disappeared")
                return False

            change_pct = ((price2 - price1) / price1) * 100
            is_green = price2 > price1

            log.info(f"[FILTER] {'🟢' if is_green else '🔴'} {mint[:16]}: momentum {change_pct:+.2f}%")

            if not is_green:
                log.info(f"[FILTER] ❌ {mint[:16]}: NOT green — skipping")
                return False

            log.info(f"[FILTER] ✅ {token.symbol} ({mint[:16]}) passed all filters!")
            return True

        except Exception as e:
            log.warning(f"[FILTER] Error filtering {mint[:16]}: {e}")
            return False

# ─── MAIN BOT ────────────────────────────────────────────────────────────────

class Bot:
    def __init__(self):
        self.sol     = Solana()
        self.jup     = Jupiter()
        self.discord = Discord()
        self.swap    = SwapEngine(self.jup, self.sol)
        self.filters = FilterEngine(self.sol, self.jup)
        self.exits   = ExitEngine(self.jup, self.swap, self.discord)
        self.detect  = Detector(self.sol, self._on_token)
        self.buying  = set()  # mints currently being processed

    async def run(self):
        log.info("=" * 55)
        log.info("  WINSTON PUMP SNIPER")
        log.info(f"  {TRADE_SOL} SOL/trade | max {MAX_POSITIONS} positions")
        log.info(f"  TP1: {TP1_X}x sell {TP1_SELL_PCT}% | TP2: {TP2_X}x sell {TP2_SELL_PCT}%")
        log.info(f"  Stop: -{STOP_LOSS_PCT}% | Trail: {TRAILING_PCT}% | Max: {MAX_HOLD_MINS}m")
        log.info("=" * 55)

        if not self.sol.pubkey:
            log.error("No wallet loaded — check WALLET_PRIVATE_KEY")
            return

        balance = await self.sol.get_balance()
        log.info(f"Balance: {balance:.4f} SOL")

        if balance < TRADE_SOL + 0.005:
            log.error(f"Insufficient balance: {balance:.4f} SOL (need {TRADE_SOL + 0.005:.3f})")
            return

        await self.discord.startup(self.sol.pubkey, balance)

        await asyncio.gather(
            self.detect.listen(),
            self.exits.run(),
            self._heartbeat(),
        )

    async def _on_token(self, token: Token):
        mint = token.mint

        # Gate checks
        if self.exits.open_count >= MAX_POSITIONS:
            log.info(f"[BOT] ⏸️ Max positions ({MAX_POSITIONS}) — skipping {mint[:16]}")
            return

        if mint in self.buying:
            return

        self.buying.add(mint)

        try:
            # Run all filters
            if not await self.filters.passes(token):
                return

            # Re-check position count after filter delay
            if self.exits.open_count >= MAX_POSITIONS:
                log.info(f"[BOT] ⏸️ Slots filled during filter — skipping {token.symbol}")
                return

            # Check balance
            balance = await self.sol.get_balance()
            if balance < TRADE_SOL + 0.005:
                log.error(f"[BOT] Low balance: {balance:.4f} SOL — skipping")
                return

            # Execute buy
            log.info(f"[BOT] 🚀 Buying {token.symbol} ({mint[:16]}...)")
            result = await self.swap.buy(mint, TRADE_SOL)

            if not result:
                log.error(f"[BOT] Buy failed for {token.symbol}")
                await self.discord.error(f"Buy Failed: {token.symbol}", f"`{mint}`")
                return

            pos = Position(
                token         = token,
                entry_price   = result["entry_price"],
                tokens_held   = result["tokens"],
                original_tokens = result["tokens"],
                cost_sol      = TRADE_SOL,
                high_price    = result["entry_price"],
                stop_price    = result["entry_price"] * (1 - STOP_LOSS_PCT / 100),
            )

            self.exits.add(pos)
            await self.discord.bought(pos)
            log.info(f"[BOT] 💰 Position open: {token.symbol} | {result['tokens']:.0f} tokens @ ${result['entry_price']:.10f}")

        except Exception as e:
            log.error(f"[BOT] Error processing {mint[:16]}: {e}")
        finally:
            self.buying.discard(mint)

    async def _heartbeat(self):
        while True:
            await asyncio.sleep(300)
            balance = await self.sol.get_balance()
            log.info(f"[HB] 💓 Seen: {self.detect.total} | Open: {self.exits.open_count} | Balance: {balance:.4f} SOL")


if __name__ == "__main__":
    try:
        asyncio.run(Bot().run())
    except KeyboardInterrupt:
        log.info("Stopped.")
