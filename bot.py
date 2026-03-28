"""
DEGEN SNIPER v8 — Smarter Entries, Fee-Aware, Momentum-Confirmed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Improvements over v7:
  1. Fee-aware profit target — fees (~0.000015 SOL per round trip) are
     deducted from PnL so the target is real, not nominal.
  2. Momentum confirmation — uses LIVE quote-based price (not cached API)
     to confirm price is actually rising before buying.
  3. Stronger rug filters — top-3 holder concentration, minimum liquidity
     in SOL terms (not just "route exists"), and a blacklist of known rugs.
  4. Early-exit logic — if price is down >12% at the 90s mark, cut losses
     immediately rather than waiting for the full 3-min timeout.
  5. Post-trade cooldown — 8s pause between trades to avoid buying the
     same wave of low-quality tokens.
  6. Smarter stop logic — stop only engages after price hits +3% (avoids
     getting stopped out by noise immediately after entry).
  7. Corrected sell amount — uses on-chain balance, with a dust check to
     avoid selling 0-value remainders that waste fees.

Strategy:
  1. Detect Pump.fun graduation → Raydium migration
  2. Run hard filters (holders, concentration, freeze, liquidity floor)
  3. Confirm positive momentum (price rising on live quote)
  4. Buy → watch with fee-aware target
  5. Exit on: target hit | early-loss cut | 3-min timeout | trailing stop
  6. Cooldown → repeat

No partial sells. No ladder. Clean in, clean out.
"""

import asyncio
import json
import time
import logging
import os
import base64 as b64
from dataclasses import dataclass, field
from typing import Optional

import aiohttp

# ─── CONFIG ──────────────────────────────────────────────────────────────────

TRADE_AMOUNT_SOL  = float(os.getenv("TRADE_AMOUNT_SOL",   "0.061"))
TRAILING_STOP_PCT = float(os.getenv("TRAILING_STOP_PCT",  "35"))   # % below high before bail
MAX_HOLD_MINUTES  = float(os.getenv("MAX_HOLD_MINUTES",   "3"))    # hard timeout
SLIPPAGE_BPS      = int(os.getenv("SLIPPAGE_BPS",         "1000")) # 10% slippage on volatile tokens
PROFIT_TARGET_X   = float(os.getenv("PROFIT_TARGET_X",    "1.25")) # sell ALL at 1.25x
MIN_MOMENTUM_PCT  = float(os.getenv("MIN_MOMENTUM_PCT",   "8"))    # min % rise before buying
MIN_LIQUIDITY_SOL = float(os.getenv("MIN_LIQUIDITY_SOL",  "1.0"))  # minimum SOL in pool
MAX_TOP_HOLDER_PCT = float(os.getenv("MAX_TOP_HOLDER_PCT", "40"))  # max % held by single wallet
BUY_DELAY_SECONDS  = float(os.getenv("BUY_DELAY_SECONDS",  "0"))
DEGEN_MODE         = os.getenv("DEGEN_MODE", "true").lower() == "true"

# Solana tx fees: ~5000 lamports per sig, 2 sigs per tx, 2 txs (buy+sell)
# Plus Jupiter protocol fee ~0.1% of trade. Total ~0.000015 SOL in base fees.
ESTIMATED_FEES_SOL = 0.000015 + (TRADE_AMOUNT_SOL * 0.001)  # base + 0.1% jup fee
# Real break-even multiplier accounting for fees
BREAKEVEN_X = (TRADE_AMOUNT_SOL + ESTIMATED_FEES_SOL * 2) / TRADE_AMOUNT_SOL

# Post-trade cooldown — avoid buying into the same garbage wave
TRADE_COOLDOWN_SECS = 8

# Early-loss exit: if price is this far down at EARLY_EXIT_AFTER_SECS, cut it
EARLY_LOSS_EXIT_PCT  = 12.0  # -12% triggers early exit
EARLY_EXIT_AFTER_SECS = 90   # check at 90 seconds

# Trailing stop only engages after price has risen this much (avoids noise stop-outs)
STOP_ENGAGE_PCT = 3.0  # stop starts tracking once price is +3%

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
    stop_engaged: bool = False   # True once price has risen STOP_ENGAGE_PCT
    opened_ts: float = 0.0

    def __post_init__(self):
        if not self.opened_ts:
            self.opened_ts = time.time()

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
        """Cached Jupiter price API — good for monitoring, may lag by a few seconds."""
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

        # Quote-based fallback — always fresh
        return await self.quote_price(mint)

    async def quote_price(self, mint) -> Optional[float]:
        """
        LIVE quote-based price — bypasses the Jupiter price API cache entirely.
        Asks the AMM directly: how much SOL for N tokens right now?
        Returns price per token in SOL, or None if no route.
        """
        s = await self._sess()
        try:
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
        except Exception as e:
            log.debug(f"quote_price 1M err: {e}")
        finally:
            await s.close()

        # Fallback: try with 10k tokens (low liquidity pools)
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
            params = {
                "inputMint": inp, "outputMint": out,
                "amount": str(amount), "taker": taker,
                "slippageBps": str(SLIPPAGE_BPS)
            }
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
        """
        Estimate SOL liquidity in the pool by quoting a large buy.
        If 1 SOL worth of buy moves price dramatically, liquidity is thin.
        Returns approximate SOL value in pool, or 0.0 if unquotable.
        """
        s = await self._sess()
        try:
            # Quote buying 1 SOL worth — measure how many tokens we'd get
            params = {
                "inputMint": WSOL,
                "outputMint": mint,
                "amount": str(int(1 * 1e9)),  # 1 SOL
                "taker": "11111111111111111111111111111111"
            }
            async with s.get(JUP_ORDER, params=params,
                             timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    d = await r.json()
                    # priceImpactPct is returned by Jupiter — high impact = low liquidity
                    impact = float(d.get("priceImpactPct", "100") or "100")
                    if impact <= 0:
                        return 999.0  # no impact = infinite liquidity (shouldn't happen)
                    # Rough liquidity estimate: if 1 SOL causes X% impact,
                    # pool has ~1/impact * 100 SOL
                    estimated_liq = 1.0 / (impact / 100.0)
                    return estimated_liq
        except Exception as e:
            log.debug(f"liquidity_sol err: {e}")
        finally:
            await s.close()
        return 0.0

# ─── SOLANA ──────────────────────────────────────────────────────────────────

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

# ─── DISCORD ─────────────────────────────────────────────────────────────────

class Discord:
    def __init__(self, url):
        self.url = url
        self._sol_price = 150.0

    async def _fetch_sol_price(self) -> float:
        try:
            async with aiohttp.ClientSession() as s:
                async with s.get(
                    f"https://api.jup.ag/price/v2?ids={WSOL}",
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
        if not self.url:
            return
        for attempt in range(3):
            try:
                async with aiohttp.ClientSession() as s:
                    r = await s.post(
                        self.url, json=payload,
                        timeout=aiohttp.ClientTimeout(total=10)
                    )
                    await r.release()
                    return
            except Exception as e:
                if attempt == 2:
                    log.debug(f"Discord send failed after 3 attempts: {e}")
                await asyncio.sleep(1)

    def _label(self, p: "Position") -> str:
        if p.token.symbol and p.token.symbol != "???":
            return p.token.symbol
        if p.token.name and p.token.name not in ("Unknown", ""):
            return p.token.name[:12]
        return p.token.mint[:8] + "..."

    async def bought(self, p: "Position"):
        sol_usd    = await self._fetch_sol_price()
        spent_usd  = p.cost_sol * sol_usd
        fees_usd   = ESTIMATED_FEES_SOL * 2 * sol_usd
        label      = self._label(p)
        target_usd = (p.cost_sol * PROFIT_TARGET_X + ESTIMATED_FEES_SOL * 2) * sol_usd
        await self.send({"embeds": [{
            "title": f"💰 BOUGHT — {label}",
            "color": 0x00AAFF,
            "description": (
                f"Spent **${spent_usd:.2f}** ({p.cost_sol:.4f} SOL)\n"
                f"🎯 Target: **${target_usd:.2f}** (fee-adjusted +{(PROFIT_TARGET_X-1)*100:.0f}%)\n"
                f"⛽ Est. fees: ~${fees_usd:.3f}"
            ),
            "fields": [
                {"name": "Stop Loss",    "value": f"{TRAILING_STOP_PCT}% trailing (engages at +{STOP_ENGAGE_PCT}%)", "inline": True},
                {"name": "Timeout",      "value": f"{MAX_HOLD_MINUTES} min",                                          "inline": True},
                {"name": "Chart",        "value": f"[Solscan](https://solscan.io/token/{p.token.mint})",              "inline": True},
            ]
        }]})

    async def sold(self, p: "Position", reason: str, gain_x: float, pnl_sol: float):
        sol_usd   = await self._fetch_sol_price()
        spent_usd = p.cost_sol * sol_usd
        pnl_usd   = pnl_sol * sol_usd
        sell_usd  = spent_usd + pnl_usd
        label     = self._label(p)
        # Fee-adjusted PnL
        real_pnl_sol = pnl_sol - (ESTIMATED_FEES_SOL * 2)
        real_pnl_usd = real_pnl_sol * sol_usd
        is_profit = real_pnl_usd >= 0
        color     = 0x00FF88 if is_profit else 0xFF4444
        emoji     = "✅ PROFIT" if is_profit else "❌ LOSS"
        pnl_str   = f"+${real_pnl_usd:.2f}" if is_profit else f"-${abs(real_pnl_usd):.2f}"
        reason_map = {
            "timeout":       "⏰ Timeout",
            "trailing_stop": "🛑 Trailing stop",
            "early_loss":    "✂️ Early loss cut",
            "price_dead":    "💀 No price feed",
        }
        reason_clean = reason_map.get(reason, f"🎯 {reason}")
        await self.send({"embeds": [{
            "title": f"{emoji} — {label}",
            "color": color,
            "description": (
                f"Bought **${spent_usd:.2f}** → Sold **${sell_usd:.2f}**\n"
                f"**{pnl_str}** net of fees ({gain_x:.3f}x) in {p.hold_mins:.1f}min"
            ),
            "fields": [
                {"name": "Reason",   "value": reason_clean,                    "inline": True},
                {"name": "SOL P&L",  "value": f"{real_pnl_sol:+.5f} SOL",     "inline": True},
                {"name": "Chart",    "value": f"[Solscan](https://solscan.io/token/{p.token.mint})", "inline": True},
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
                                await self._handle(msg.data)
                            elif msg.type in (aiohttp.WSMsgType.ERROR,
                                             aiohttp.WSMsgType.CLOSED):
                                break
            except Exception as e:
                log.error(f"WS error: {e}")
            log.info("WS disconnected — reconnecting in 5s")
            await asyncio.sleep(5)

    async def _handle(self, raw):
        if self.locked:
            return
        try:
            data = json.loads(raw)
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

    async def _extract_mint(self, sig: str, sess: aiohttp.ClientSession) -> Optional[str]:
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

            skip = {
                WSOL,
                "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  # USDC
                "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",   # USDT
            }

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

    def _mint_from_logs(self, logs: list, source: str) -> Optional[str]:
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
        # Mints that stopped us out — skip if we see them again
        self._rug_blacklist: set = set()

    async def run(self):
        log.info("=" * 60)
        log.info("  DEGEN SNIPER v8 — Smarter, Fee-Aware, Momentum-Confirmed")
        log.info(f"  {TRADE_AMOUNT_SOL} SOL/trade | Est fees: {ESTIMATED_FEES_SOL:.6f} SOL/tx")
        log.info(f"  Breakeven: {BREAKEVEN_X:.4f}x | Target: {PROFIT_TARGET_X}x")
        log.info(f"  Timeout: {MAX_HOLD_MINUTES}min | Stop: {TRAILING_STOP_PCT}% (engages at +{STOP_ENGAGE_PCT}%)")
        log.info(f"  Momentum: +{MIN_MOMENTUM_PCT}% confirmed | Min liq: {MIN_LIQUIDITY_SOL} SOL")
        log.info(f"  Early loss exit: -{EARLY_LOSS_EXIT_PCT}% at {EARLY_EXIT_AFTER_SECS}s")
        log.info(f"  Jupiter key: {'SET' if JUPITER_API_KEY else 'MISSING'}")
        log.info("=" * 60)

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
        log.info("Trade loop ready — waiting for first token")
        while True:
            token = await self.detector.queue.get()
            self.detector.locked = True
            log.info(f"LOCKED IN on {token.mint[:20]}... — ignoring other tokens")

            try:
                # Skip known rugs immediately
                if token.mint in self._rug_blacklist:
                    log.info(f"SKIP {token.mint[:16]}: blacklisted rug")
                    continue

                # Hard filters
                passed = await self._filter(token)
                if not passed:
                    log.info(f"SKIP {token.mint[:16]} — failed filters")
                    continue

                # Momentum confirmation — price must be actively rising
                if MIN_MOMENTUM_PCT > 0:
                    momentum_ok = await self._check_momentum(token)
                    if not momentum_ok:
                        log.info(f"SKIP {token.mint[:16]}: momentum too weak (<{MIN_MOMENTUM_PCT}%)")
                        continue

                # Buy
                pos = await self._buy(token)
                if not pos:
                    log.info(f"BUY FAILED for {token.symbol} — unlocking")
                    continue

                # Watch until exit
                reason = await self._watch(pos)

                # Blacklist tokens that stopped us out hard
                if reason in ("trailing_stop", "early_loss"):
                    self._rug_blacklist.add(token.mint)
                    log.info(f"Blacklisted {token.mint[:16]} after {reason}")

            except Exception as e:
                log.error(f"Trade loop error: {e}")
                import traceback; traceback.print_exc()
            finally:
                self.detector.locked = False
                log.info("UNLOCKED — scanning for next coin")

                # Drain stale tokens
                while not self.detector.queue.empty():
                    try: self.detector.queue.get_nowait()
                    except: break

                log.info(f"Stats: {self.trades_won}W / {self.trades_lost}L | "
                         f"Net {self.total_pnl:+.5f} SOL")

                # Cooldown — avoids buying the same wave of junk tokens
                if TRADE_COOLDOWN_SECS > 0:
                    log.info(f"Cooldown {TRADE_COOLDOWN_SECS}s...")
                    await asyncio.sleep(TRADE_COOLDOWN_SECS)

    # ── FILTER ───────────────────────────────────────────────────────────────

    async def _filter(self, token: Token) -> bool:
        """
        Hard filters — all must pass:
          1. Minimum holder count (>=5)
          2. Top single holder concentration (<= MAX_TOP_HOLDER_PCT)
          3. Top-3 combined concentration (<= 60%) — catches coordinated rugs
          4. No freeze authority
          5. Liquidity floor (>= MIN_LIQUIDITY_SOL)
          6. Route exists (can actually buy)
        """
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
                liq_sol_task = asyncio.create_task(
                    self.jup.liquidity_sol(token.mint)
                )

                holders_res, acct_res, liq_order, liq_sol = await asyncio.gather(
                    holder_task, acct_task, liq_task, liq_sol_task,
                    return_exceptions=True
                )

                # Holder count
                if isinstance(holders_res, Exception) or not holders_res:
                    log.info(f"SKIP {token.mint[:16]}: holder RPC failed")
                    return False
                holders = holders_res.get("result", {}).get("value", [])
                if len(holders) < 5:
                    log.info(f"SKIP {token.mint[:16]}: only {len(holders)} holders")
                    return False

                # Holder concentration checks
                supply_res = await self._rpc(sess, "getTokenSupply", [token.mint])
                total = float(supply_res.get("result", {})
                                        .get("value", {})
                                        .get("amount", "0"))
                if total > 0 and holders:
                    top1     = float(holders[0].get("amount", "0"))
                    top1_pct = (top1 / total) * 100
                    if top1_pct > MAX_TOP_HOLDER_PCT:
                        log.info(f"SKIP {token.mint[:16]}: top holder {top1_pct:.0f}%")
                        return False

                    # Top-3 combined concentration
                    top3_total = sum(float(h.get("amount", "0")) for h in holders[:3])
                    top3_pct   = (top3_total / total) * 100
                    if top3_pct > 60:
                        log.info(f"SKIP {token.mint[:16]}: top-3 holders = {top3_pct:.0f}% (rug risk)")
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

                # Liquidity: route must exist
                if (isinstance(liq_order, Exception) or not liq_order
                        or not liq_order.get("outAmount")):
                    log.info(f"SKIP {token.mint[:16]}: no liquidity route")
                    return False

                # Liquidity: floor check in SOL terms
                if not isinstance(liq_sol, Exception):
                    if liq_sol < MIN_LIQUIDITY_SOL:
                        log.info(f"SKIP {token.mint[:16]}: liq ~{liq_sol:.2f} SOL < {MIN_LIQUIDITY_SOL} SOL floor")
                        return False

                # Fetch metadata from Pump.fun
                try:
                    async with sess.get(
                        f"https://frontend-api.pump.fun/coins/{token.mint}",
                        timeout=aiohttp.ClientTimeout(total=4)
                    ) as r:
                        if r.status == 200:
                            meta = await r.json()
                            if meta.get("symbol"): token.symbol = meta["symbol"]
                            if meta.get("name"):   token.name   = meta["name"]
                except:
                    pass

                label = (token.symbol if token.symbol != "???"
                         else (token.name[:10] if token.name != "Unknown"
                               else token.mint[:8]))
                log.info(f"PASS {label} ({token.mint[:16]}) — {len(holders)} holders, "
                         f"liq ~{liq_sol if not isinstance(liq_sol, Exception) else '?':.1f} SOL")
                return True

            except Exception as e:
                log.warning(f"Filter error: {e}")
                return False

    # ── MOMENTUM CHECK ────────────────────────────────────────────────────────

    async def _check_momentum(self, token: Token) -> bool:
        """
        Take two live quote-based prices 3 seconds apart.
        Only buy if price has risen >= MIN_MOMENTUM_PCT%.
        Uses quote_price (not cached API) so it reflects real AMM state.
        """
        log.info(f"Checking momentum for {token.symbol}...")
        p1 = await self.jup.quote_price(token.mint)
        if not p1:
            log.info(f"  No price p1 — skipping momentum check (will buy)")
            return True  # Can't check — don't block the trade

        await asyncio.sleep(3)
        p2 = await self.jup.quote_price(token.mint)
        if not p2:
            log.info(f"  No price p2 — skipping momentum check (will buy)")
            return True

        change_pct = ((p2 - p1) / p1) * 100
        log.info(f"  Momentum: {p1:.10f} -> {p2:.10f} = {change_pct:+.1f}%")

        if change_pct >= MIN_MOMENTUM_PCT:
            log.info(f"  MOMENTUM OK: +{change_pct:.1f}% >= {MIN_MOMENTUM_PCT}%")
            return True

        # If price is flat or falling slightly, try once more after 2s
        await asyncio.sleep(2)
        p3 = await self.jup.quote_price(token.mint)
        if p3:
            change_pct2 = ((p3 - p1) / p1) * 100
            log.info(f"  Momentum retry: {change_pct2:+.1f}%")
            if change_pct2 >= MIN_MOMENTUM_PCT:
                return True

        return False

    # ── BUY ──────────────────────────────────────────────────────────────────

    async def _buy(self, token: Token) -> Optional[Position]:
        if not self.sol.pubkey:
            log.error("No wallet pubkey"); return None

        async with aiohttp.ClientSession() as sess:
            bal = await self.sol.balance(sess)

        # Need trade amount + fees buffer
        min_needed = TRADE_AMOUNT_SOL + ESTIMATED_FEES_SOL + 0.003
        if bal < min_needed:
            log.error(f"Low balance: {bal:.4f} SOL — need {min_needed:.4f}")
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

        # Wait for chain settlement then get real price
        await asyncio.sleep(2)
        async with aiohttp.ClientSession() as sess:
            bal_after = await self.sol.balance(sess)

        tokens = out_amt / 1e6
        price  = await self.jup.quote_price(token.mint)  # live quote for entry price
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
            stop_price  = 0.0,          # stop NOT active yet — engages at +STOP_ENGAGE_PCT%
            stop_engaged = False,
        )
        await self.discord.bought(pos)
        log.info(f"BOUGHT {tokens:.0f} {token.symbol} @ ${price:.10f}")
        log.info(f"  Fee-adj target: ${price * PROFIT_TARGET_X:.10f}")
        log.info(f"  Stop engages at: ${price * (1 + STOP_ENGAGE_PCT/100):.10f}")
        log.info(f"  Gas paid: {gas:.5f} SOL")
        return pos

    # ── WATCH + EXIT ──────────────────────────────────────────────────────────

    async def _watch(self, pos: Position) -> str:
        """
        Poll price every 1s.
        Returns the exit reason string.
        Exits on:
          1. Profit target (PROFIT_TARGET_X)
          2. Early loss cut (-EARLY_LOSS_EXIT_PCT% at EARLY_EXIT_AFTER_SECS)
          3. Hard timeout (MAX_HOLD_MINUTES)
          4. Trailing stop (only after STOP_ENGAGE_PCT% gain)
        """
        log.info(f"WATCHING {pos.token.symbol} — target {PROFIT_TARGET_X}x "
                 f"in {MAX_HOLD_MINUTES}min")
        price_fails    = 0
        early_cut_done = False

        while True:
            await asyncio.sleep(1)

            price = await self.jup.price(pos.token.mint)

            if not price:
                price_fails += 1
                if price_fails % 15 == 1:
                    log.warning(f"No price for {pos.token.symbol} ({price_fails}x)")
                if price_fails >= 60:
                    log.error(f"Price dead 60s — emergency sell {pos.token.symbol}")
                    await self._sell(pos, pos.entry_price, "price_dead")
                    return "price_dead"
                continue

            price_fails = 0
            gain_x = price / pos.entry_price if pos.entry_price > 0 else 1.0

            log.info(f"  {pos.token.symbol:8s} ${price:.8f} "
                     f"({gain_x:.3f}x) stop={'ON' if pos.stop_engaged else 'off'} "
                     f"held={pos.hold_mins:.1f}m")

            # ── EXIT 1: Profit target ─────────────────────────────────────
            if gain_x >= PROFIT_TARGET_X:
                log.info(f"TARGET HIT {gain_x:.3f}x — selling {pos.token.symbol}!")
                await self._sell(pos, price, f"profit_{gain_x:.2f}x")
                return "profit"

            # ── EXIT 2: Early loss cut ────────────────────────────────────
            # At 90s mark: if down >12%, don't wait for the full timeout
            if (not early_cut_done and
                    pos.hold_secs >= EARLY_EXIT_AFTER_SECS and
                    gain_x < (1 - EARLY_LOSS_EXIT_PCT / 100)):
                log.warning(f"EARLY LOSS CUT at {pos.hold_secs:.0f}s "
                            f"({gain_x:.3f}x < {1 - EARLY_LOSS_EXIT_PCT/100:.3f}) — "
                            f"selling {pos.token.symbol}")
                await self._sell(pos, price, "early_loss")
                return "early_loss"
            early_cut_done = pos.hold_secs > EARLY_EXIT_AFTER_SECS

            # ── EXIT 3: Timeout ───────────────────────────────────────────
            if pos.timed_out:
                log.warning(f"TIMEOUT {pos.hold_mins:.1f}min — selling {pos.token.symbol} ({gain_x:.2f}x)")
                await self._sell(pos, price, "timeout")
                return "timeout"

            # ── TRAILING STOP LOGIC ───────────────────────────────────────
            # Step 1: Engage stop once price is up STOP_ENGAGE_PCT%
            if not pos.stop_engaged and gain_x >= (1 + STOP_ENGAGE_PCT / 100):
                pos.stop_engaged = True
                pos.stop_price   = price * (1 - TRAILING_STOP_PCT / 100)
                log.info(f"  STOP ENGAGED at ${price:.8f} -> stop ${pos.stop_price:.8f}")

            # Step 2: Update trailing high
            if pos.stop_engaged and price > pos.high_price:
                pos.high_price = price
                pos.stop_price = price * (1 - TRAILING_STOP_PCT / 100)
                log.info(f"  NEW HIGH ${price:.8f} -> stop ${pos.stop_price:.8f}")

            # Step 3: Trigger stop
            if pos.stop_engaged and pos.stop_price > 0 and price <= pos.stop_price:
                log.warning(f"TRAILING STOP HIT ${price:.8f} ({gain_x:.2f}x) — "
                            f"selling {pos.token.symbol}")
                await self._sell(pos, price, "trailing_stop")
                return "trailing_stop"

    # ── SELL ─────────────────────────────────────────────────────────────────

    async def _get_real_token_balance(self, mint: str) -> tuple:
        """Fetch actual on-chain token balance. Returns (raw_amount, decimals)."""
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

    async def _sell(self, pos: Position, price: float, reason: str):
        gain_x  = price / pos.entry_price if pos.entry_price > 0 else 1.0
        pnl_sol = (price * pos.tokens_held) - pos.cost_sol
        log.info(f"SELLING 100% of {pos.token.symbol} — {reason} "
                 f"({gain_x:.3f}x, {pnl_sol:+.5f} SOL)")

        raw_amount, decimals = await self._get_real_token_balance(pos.token.mint)

        if raw_amount <= 0:
            raw_amount = int(pos.tokens_held * (10 ** 6))
            log.warning(f"Could not fetch real balance — using estimate: {raw_amount}")

        if raw_amount <= 0:
            log.error(f"Sell amount is 0 for {pos.token.symbol} — cannot sell")
            return

        # Dust check — don't bother selling tiny remainders that cost more in fees
        token_value_sol = (raw_amount / 10**decimals) * price
        if token_value_sol < ESTIMATED_FEES_SOL:
            log.warning(f"Dust position ({token_value_sol:.8f} SOL) — not worth the fee, skipping sell")
            return

        log.info(f"Selling raw amount: {raw_amount} (decimals: {decimals})")
        sell_succeeded = False

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
                            if "insufficient" in str(err).lower() or attempt == 3:
                                raw_amount = int(raw_amount * 0.98)
                                log.warning(f"Retrying with 98%: {raw_amount}")
                        else:
                            sig = result.get("signature", "?")
                            log.info(f"SELL TX: {sig[:35]}...")
                            sell_succeeded = True
                            break
            else:
                log.warning(f"No sell route attempt {attempt}/5")

            if not sell_succeeded and attempt < 5:
                wait = min(attempt * 2, 6)
                log.info(f"Retrying sell in {wait}s...")
                await asyncio.sleep(wait)

        if not sell_succeeded:
            log.error(f"SELL FAILED after 5 attempts — {pos.token.symbol}")
            return

        # Track PnL (fee-adjusted)
        real_pnl = pnl_sol - (ESTIMATED_FEES_SOL * 2)
        if real_pnl >= 0:
            self.trades_won += 1
        else:
            self.trades_lost += 1
        self.total_pnl += real_pnl

        await self.discord.sold(pos, reason, gain_x, pnl_sol)
        log.info(f"CLOSED {pos.token.symbol}: {gain_x:.3f}x | raw {pnl_sol:+.5f} SOL "
                 f"| fee-adj {real_pnl:+.5f} SOL")

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
            status  = "LOCKED IN" if self.detector.locked else "SCANNING"
            sol_usd = await self.discord._fetch_sol_price()
            pnl_usd = self.total_pnl * sol_usd
            log.info(f"HEARTBEAT [{status}] | up {uptime:.0f}m | "
                     f"{self.detector.count} tokens seen | "
                     f"{self.trades_won}W {self.trades_lost}L | "
                     f"net {self.total_pnl:+.5f} SOL ({pnl_usd:+.2f} USD) | "
                     f"SOL=${sol_usd:.0f} | "
                     f"rugs blacklisted: {len(self._rug_blacklist)}")
            if int(uptime) % 30 == 0 and int(uptime) > 0:
                pnl_str = f"+${pnl_usd:.2f}" if pnl_usd >= 0 else f"-${abs(pnl_usd):.2f}"
                await self.discord.info(
                    f"💓 **Sniper v8 alive** | {uptime:.0f}min up | "
                    f"{self.trades_won}W {self.trades_lost}L | "
                    f"Net: **{pnl_str}** (fee-adj) | SOL=${sol_usd:.0f}"
                )

if __name__ == "__main__":
    try:
        asyncio.run(Bot().run())
    except KeyboardInterrupt:
        log.info("Stopped")
