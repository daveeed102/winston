"""
JITO RATIO TRADER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Strategy: Trade the JitoSOL/SOL ratio on Jupiter

JitoSOL is a liquid staking token that slowly accrues staking
yield (~7-8% APY), meaning its fair value vs SOL rises ~0.02%
per day. The spot price oscillates around this fair value.

Entry:  Buy JitoSOL when spot ratio dips MORE than ENTRY_DISCOUNT_PCT
        below a rolling fair-value estimate (momentum dip = opportunity)

Exit:   Sell JitoSOL back to SOL when:
        a) Ratio recovers to fair value (TAKE_PROFIT_PCT gain)
        b) Hard timeout (MAX_HOLD_MINUTES)
        c) Ratio drops further past stop loss (STOP_LOSS_PCT)

Always in the market cycling: SOL -> JitoSOL -> SOL -> repeat
No memecoins. No graduation events. Predictable, liquid, 24/7.
"""

import asyncio
import json
import time
import logging
import os
import base64 as b64
from dataclasses import dataclass
from typing import Optional
from collections import deque

import aiohttp

# ─── CONFIG ──────────────────────────────────────────────────────────────────

TRADE_AMOUNT_SOL   = float(os.getenv("TRADE_AMOUNT_SOL",   "0.0625"))  # ~$10
ENTRY_DISCOUNT_PCT = float(os.getenv("ENTRY_DISCOUNT_PCT", "0.3"))     # buy when 0.3% below fair value
TAKE_PROFIT_PCT    = float(os.getenv("TAKE_PROFIT_PCT",    "0.4"))     # sell at +0.4% gain
STOP_LOSS_PCT      = float(os.getenv("STOP_LOSS_PCT",      "0.8"))     # stop if down 0.8%
MAX_HOLD_MINUTES   = float(os.getenv("MAX_HOLD_MINUTES",   "120"))     # 2hr max hold
POLL_SECONDS       = float(os.getenv("POLL_SECONDS",       "30"))      # check price every 30s
FAIR_VALUE_WINDOW  = int(os.getenv("FAIR_VALUE_WINDOW",    "20"))      # rolling window for fair value
SLIPPAGE_BPS       = int(os.getenv("SLIPPAGE_BPS",         "50"))      # tight slippage for liquid tokens
MIN_TRADE_GAP_MINS = float(os.getenv("MIN_TRADE_GAP_MINS", "5"))       # min minutes between trades

DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "")
SOLANA_RPC_URL      = os.getenv("SOLANA_RPC_URL",      "")
WALLET_PRIVATE_KEY  = os.getenv("WALLET_PRIVATE_KEY",  "")
JUPITER_API_KEY     = os.getenv("JUPITER_API_KEY",     "")

# Token addresses
WSOL    = "So11111111111111111111111111111111111111112"
JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"

JUP_ORDER   = "https://api.jup.ag/swap/v2/order"
JUP_EXECUTE = "https://api.jup.ag/swap/v2/execute"
JUP_PRICE   = "https://api.jup.ag/price/v2"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(message)s",
    datefmt="%H:%M:%S"
)
log = logging.getLogger("jito_trader")

# ─── MODELS ──────────────────────────────────────────────────────────────────

@dataclass
class Position:
    entry_ratio: float      # JitoSOL/SOL ratio at entry
    jitosol_held: float     # amount of JitoSOL held
    cost_sol: float         # SOL spent
    high_ratio: float       # highest ratio seen since entry
    stop_ratio: float       # stop loss ratio
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

    async def get_ratio(self) -> Optional[float]:
        """
        Get current JitoSOL/SOL ratio.
        How much SOL does 1 JitoSOL buy? (should be ~1.07+ and rising)
        We ask: how much SOL for 1 JitoSOL?
        """
        s = await self._sess()
        try:
            # Use price API first
            async with s.get(
                f"{JUP_PRICE}?ids={JITOSOL}&vsToken={WSOL}",
                timeout=aiohttp.ClientTimeout(total=5)
            ) as r:
                if r.status == 200:
                    d = await r.json()
                    p = d.get("data", {}).get(JITOSOL, {}).get("price")
                    if p:
                        return float(p)
        except: pass
        finally: await s.close()

        # Fallback: ask Jupiter for a quote of 1 JitoSOL -> SOL
        s2 = await self._sess()
        try:
            # 1 JitoSOL = 1e9 lamports (JitoSOL has 9 decimals)
            params = {
                "inputMint": JITOSOL,
                "outputMint": WSOL,
                "amount": str(int(1e9)),  # 1 JitoSOL
            }
            async with s2.get(JUP_ORDER, params=params,
                              timeout=aiohttp.ClientTimeout(total=8)) as r:
                if r.status == 200:
                    d = await r.json()
                    out_lamports = int(d.get("outAmount", "0"))
                    if out_lamports > 0:
                        return out_lamports / 1e9  # SOL per JitoSOL
        except: pass
        finally: await s2.close()
        return None

    async def get_sol_usd(self) -> float:
        """Get SOL/USD price."""
        s = await self._sess()
        try:
            async with s.get(
                f"{JUP_PRICE}?ids={WSOL}",
                timeout=aiohttp.ClientTimeout(total=5)
            ) as r:
                if r.status == 200:
                    d = await r.json()
                    p = d.get("data", {}).get(WSOL, {}).get("price")
                    if p: return float(p)
        except: pass
        finally: await s.close()
        return 160.0  # fallback

    async def order(self, inp, out, amount_lamports, taker):
        s = await self._sess()
        try:
            params = {
                "inputMint": inp, "outputMint": out,
                "amount": str(amount_lamports), "taker": taker,
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
        self.keypair = self.pubkey = None
        if pk:
            try:
                from solders.keypair import Keypair; import base58
                self.keypair = Keypair.from_bytes(base58.b58decode(pk))
                self.pubkey  = str(self.keypair.pubkey())
                log.info(f"Wallet: {self.pubkey[:8]}...{self.pubkey[-4:]}")
            except Exception as e: log.error(f"Wallet load: {e}")

    async def sol_balance(self) -> float:
        if not self.pubkey: return 0.0
        try:
            async with aiohttp.ClientSession() as sess:
                async with sess.post(self.rpc,
                    json={"jsonrpc": "2.0", "id": 1, "method": "getBalance",
                          "params": [self.pubkey]},
                    timeout=aiohttp.ClientTimeout(total=10)) as r:
                    d = await r.json()
                    return d.get("result", {}).get("value", 0) / 1e9
        except: return 0.0

    async def jitosol_balance(self) -> float:
        """Get actual JitoSOL balance from wallet."""
        if not self.pubkey: return 0.0
        try:
            async with aiohttp.ClientSession() as sess:
                async with sess.post(self.rpc,
                    json={"jsonrpc": "2.0", "id": 1,
                          "method": "getTokenAccountsByOwner",
                          "params": [self.pubkey,
                                     {"mint": JITOSOL},
                                     {"encoding": "jsonParsed"}]},
                    timeout=aiohttp.ClientTimeout(total=10)) as r:
                    data = await r.json()
                accounts = data.get("result", {}).get("value", [])
                for acct in accounts:
                    info = (acct.get("account", {}).get("data", {})
                                .get("parsed", {}).get("info", {}))
                    ta = info.get("tokenAmount", {})
                    raw = int(ta.get("amount", 0))
                    dec = int(ta.get("decimals", 9))
                    if raw > 0:
                        return raw / (10 ** dec)
        except Exception as e:
            log.error(f"JitoSOL balance error: {e}")
        return 0.0

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
                    log.debug(f"Discord failed: {e}")
                await asyncio.sleep(1)

    async def bought(self, pos: Position, sol_usd: float, fair_value: float, discount_pct: float):
        spent_usd    = pos.cost_sol * sol_usd
        target_ratio = pos.entry_ratio * (1 + TAKE_PROFIT_PCT / 100)
        await self.send({"embeds": [{
            "title": "💰 BOUGHT JitoSOL",
            "color": 0x00AAFF,
            "description": (
                f"Spent **${spent_usd:.2f}** ({pos.cost_sol:.4f} SOL)\n"
                f"Entry ratio: **{pos.entry_ratio:.6f}** SOL/JitoSOL\n"
                f"Fair value: {fair_value:.6f} | Discount: **{discount_pct:.3f}%**"
            ),
            "fields": [
                {"name": "Target ratio",  "value": f"{target_ratio:.6f}", "inline": True},
                {"name": "Stop ratio",    "value": f"{pos.stop_ratio:.6f}", "inline": True},
                {"name": "Max hold",      "value": f"{MAX_HOLD_MINUTES:.0f}min", "inline": True},
            ]
        }]})

    async def sold(self, pos: Position, exit_ratio: float, reason: str,
                   sol_usd: float, pnl_sol: float):
        spent_usd  = pos.cost_sol * sol_usd
        pnl_usd    = pnl_sol * sol_usd
        sell_usd   = spent_usd + pnl_usd
        is_profit  = pnl_usd >= 0
        color      = 0x00FF88 if is_profit else 0xFF4444
        emoji      = "✅ PROFIT" if is_profit else "❌ LOSS"
        pnl_str    = f"+${pnl_usd:.2f}" if is_profit else f"-${abs(pnl_usd):.2f}"
        gain_x     = exit_ratio / pos.entry_ratio if pos.entry_ratio > 0 else 1.0
        reason_map = {
            "take_profit":  "🎯 Take profit",
            "stop_loss":    "🛑 Stop loss",
            "timeout":      "⏰ Timeout",
        }
        await self.send({"embeds": [{
            "title": f"{emoji} — JitoSOL Trade",
            "color": color,
            "description": (
                f"Bought **${spent_usd:.2f}** → Sold **${sell_usd:.2f}**\n"
                f"**{pnl_str}** ({gain_x:.5f}x ratio) in {pos.hold_mins:.1f}min"
            ),
            "fields": [
                {"name": "Reason",      "value": reason_map.get(reason, reason), "inline": True},
                {"name": "SOL P&L",     "value": f"{pnl_sol:+.6f} SOL",         "inline": True},
                {"name": "Exit ratio",  "value": f"{exit_ratio:.6f}",            "inline": True},
            ]
        }]})

    async def alert(self, msg: str):
        await self.send({"content": msg})

# ─── FAIR VALUE TRACKER ──────────────────────────────────────────────────────

class FairValueTracker:
    """
    Tracks the rolling fair value of JitoSOL/SOL ratio.

    JitoSOL appreciates vs SOL at ~7-8% APY = ~0.019-0.022% per day.
    Fair value is the rolling high of the ratio over the window —
    when spot dips below this, it's a buying opportunity.
    """
    def __init__(self, window: int = 20):
        self.window   = window
        self.readings = deque(maxlen=window)
        self.timestamps = deque(maxlen=window)

    def add(self, ratio: float):
        self.readings.append(ratio)
        self.timestamps.append(time.time())

    @property
    def fair_value(self) -> Optional[float]:
        if len(self.readings) < 5:
            return None
        # Fair value = rolling average of top 25% of readings
        # This captures the "high water mark" the ratio tends toward
        sorted_r = sorted(self.readings)
        top_quartile = sorted_r[len(sorted_r) * 3 // 4:]
        return sum(top_quartile) / len(top_quartile)

    @property
    def current(self) -> Optional[float]:
        return self.readings[-1] if self.readings else None

    def discount_pct(self) -> Optional[float]:
        """How far below fair value is current price? Positive = discount."""
        fv = self.fair_value
        cur = self.current
        if not fv or not cur: return None
        return ((fv - cur) / fv) * 100

    def ready(self) -> bool:
        return len(self.readings) >= 5

# ─── BOT ─────────────────────────────────────────────────────────────────────

class Bot:
    def __init__(self):
        self.sol      = Solana(SOLANA_RPC_URL, WALLET_PRIVATE_KEY)
        self.jup      = Jupiter()
        self.discord  = Discord(DISCORD_WEBHOOK_URL)
        self.fv       = FairValueTracker(window=FAIR_VALUE_WINDOW)
        self.position: Optional[Position] = None
        self.start    = time.time()
        self.trades_won   = 0
        self.trades_lost  = 0
        self.total_pnl    = 0.0
        self.last_trade_ts = 0.0
        self.sol_usd      = 160.0

    async def run(self):
        log.info("=" * 55)
        log.info("  JITO RATIO TRADER")
        log.info(f"  {TRADE_AMOUNT_SOL} SOL/trade (~${TRADE_AMOUNT_SOL * 160:.0f})")
        log.info(f"  Entry: -{ENTRY_DISCOUNT_PCT}% discount | Target: +{TAKE_PROFIT_PCT}%")
        log.info(f"  Stop: -{STOP_LOSS_PCT}% | Max hold: {MAX_HOLD_MINUTES:.0f}min")
        log.info(f"  Poll: every {POLL_SECONDS:.0f}s | Fair value window: {FAIR_VALUE_WINDOW} readings")
        log.info(f"  Jupiter key: {'SET' if JUPITER_API_KEY else 'MISSING'}")
        log.info("=" * 55)

        sol_bal = await self.sol.sol_balance()
        jito_bal = await self.sol.jitosol_balance()
        self.sol_usd = await self.jup.get_sol_usd()
        log.info(f"Starting balance: {sol_bal:.4f} SOL (${sol_bal * self.sol_usd:.2f}) | "
                 f"JitoSOL: {jito_bal:.4f}")

        await self.discord.alert(
            f"🤖 **Jito Trader started**\n"
            f"Balance: {sol_bal:.4f} SOL (${sol_bal * self.sol_usd:.2f})\n"
            f"Strategy: Buy JitoSOL at -{ENTRY_DISCOUNT_PCT}% discount, "
            f"sell at +{TAKE_PROFIT_PCT}% recovery"
        )

        await asyncio.gather(
            self._trade_loop(),
            self._heartbeat(),
        )

    # ── MAIN LOOP ────────────────────────────────────────────────────────────

    async def _trade_loop(self):
        log.info(f"Warming up fair value tracker ({FAIR_VALUE_WINDOW} readings × {POLL_SECONDS:.0f}s)...")

        while True:
            try:
                await self._tick()
            except Exception as e:
                log.error(f"Tick error: {e}")
                import traceback; traceback.print_exc()
            await asyncio.sleep(POLL_SECONDS)

    async def _tick(self):
        # Fetch current ratio and SOL price
        ratio = await self.jup.get_ratio()
        if not ratio:
            log.warning("Could not fetch JitoSOL ratio — skipping tick")
            return

        self.fv.add(ratio)
        self.sol_usd = await self.jup.get_sol_usd()
        fv = self.fv.fair_value
        discount = self.fv.discount_pct()

        # Log current state
        fv_str = f"{fv:.6f}" if fv else "warming..."
        disc_str = f"{discount:+.3f}%" if discount is not None else "n/a"
        log.info(f"Ratio: {ratio:.6f} | Fair value: {fv_str} | "
                 f"Discount: {disc_str} | "
                 f"{'IN POSITION' if self.position else 'FLAT'} | "
                 f"SOL=${self.sol_usd:.0f}")

        # ── IF IN POSITION: check exits ──────────────────────────────────────
        if self.position:
            await self._check_exit(ratio)
            return

        # ── IF FLAT: check entry ─────────────────────────────────────────────
        if not self.fv.ready():
            log.info(f"  Warming up... {len(self.fv.readings)}/{FAIR_VALUE_WINDOW} readings")
            return

        # Enforce minimum gap between trades
        mins_since_last = (time.time() - self.last_trade_ts) / 60
        if mins_since_last < MIN_TRADE_GAP_MINS:
            log.info(f"  Cooldown: {MIN_TRADE_GAP_MINS - mins_since_last:.1f}min remaining")
            return

        # Entry signal: ratio is discounted enough below fair value
        if discount is not None and discount >= ENTRY_DISCOUNT_PCT:
            log.info(f"  ENTRY SIGNAL: {discount:.3f}% discount >= {ENTRY_DISCOUNT_PCT}% threshold!")
            await self._buy(ratio, fv, discount)

    # ── BUY ──────────────────────────────────────────────────────────────────

    async def _buy(self, ratio: float, fair_value: float, discount_pct: float):
        sol_bal = await self.sol.sol_balance()
        if sol_bal < TRADE_AMOUNT_SOL + 0.005:
            log.error(f"Insufficient SOL: {sol_bal:.4f} (need {TRADE_AMOUNT_SOL + 0.005:.4f})")
            return

        lamports = int(TRADE_AMOUNT_SOL * 1e9)
        log.info(f"Buying JitoSOL with {TRADE_AMOUNT_SOL} SOL...")

        order = await self.jup.order(WSOL, JITOSOL, lamports, self.sol.pubkey)
        if not order:
            log.error("No buy route"); return

        tx_b64  = order.get("transaction", "")
        req_id  = order.get("requestId", "")
        out_amt = int(order.get("outAmount", "0"))

        if not tx_b64 or not req_id:
            log.error("Bad order response"); return

        signed = self.sol.sign(tx_b64)
        if not signed: return

        result = await self.jup.execute(req_id, signed)
        if not result: log.error("Execute failed"); return
        if result.get("status") == "Failed":
            log.error(f"Buy failed: {result.get('error', '?')}"); return

        sig = result.get("signature", "?")
        log.info(f"BUY TX: {sig[:35]}...")

        # Wait for chain confirmation then get real balance
        await asyncio.sleep(3)
        jitosol_received = await self.sol.jitosol_balance()
        if jitosol_received == 0:
            # Fallback to estimate
            jitosol_received = out_amt / 1e9

        stop_ratio = ratio * (1 - STOP_LOSS_PCT / 100)

        self.position = Position(
            entry_ratio  = ratio,
            jitosol_held = jitosol_received,
            cost_sol     = TRADE_AMOUNT_SOL,
            high_ratio   = ratio,
            stop_ratio   = stop_ratio,
        )
        self.last_trade_ts = time.time()

        log.info(f"BOUGHT {jitosol_received:.4f} JitoSOL @ ratio {ratio:.6f}")
        log.info(f"  Fair value: {fair_value:.6f} | Discount was: {discount_pct:.3f}%")
        log.info(f"  Stop: {stop_ratio:.6f} | Target: {ratio * (1 + TAKE_PROFIT_PCT/100):.6f}")

        await self.discord.bought(self.position, self.sol_usd, fair_value, discount_pct)

    # ── EXIT CHECK ───────────────────────────────────────────────────────────

    async def _check_exit(self, ratio: float):
        pos = self.position
        gain_pct = ((ratio - pos.entry_ratio) / pos.entry_ratio) * 100

        log.info(f"  Position: entry={pos.entry_ratio:.6f} current={ratio:.6f} "
                 f"gain={gain_pct:+.3f}% held={pos.hold_mins:.1f}min")

        # Update trailing high
        if ratio > pos.high_ratio:
            pos.high_ratio = ratio
            # Tighten stop once profitable
            if gain_pct > TAKE_PROFIT_PCT / 2:
                new_stop = ratio * (1 - STOP_LOSS_PCT / 200)  # half stop once in profit
                pos.stop_ratio = max(pos.stop_ratio, new_stop)
                log.info(f"  Trailing: new high {ratio:.6f}, stop tightened to {pos.stop_ratio:.6f}")

        # Exit 1: Take profit
        if gain_pct >= TAKE_PROFIT_PCT:
            log.info(f"TAKE PROFIT: {gain_pct:+.3f}% >= {TAKE_PROFIT_PCT}%")
            await self._sell(ratio, "take_profit")
            return

        # Exit 2: Timeout
        if pos.timed_out:
            log.warning(f"TIMEOUT: held {pos.hold_mins:.1f}min (gain: {gain_pct:+.3f}%)")
            await self._sell(ratio, "timeout")
            return

        # Exit 3: Stop loss
        if ratio <= pos.stop_ratio:
            log.warning(f"STOP LOSS: ratio {ratio:.6f} <= stop {pos.stop_ratio:.6f} "
                        f"(gain: {gain_pct:+.3f}%)")
            await self._sell(ratio, "stop_loss")
            return

    # ── SELL ─────────────────────────────────────────────────────────────────

    async def _sell(self, ratio: float, reason: str):
        pos = self.position
        if not pos: return

        # Always fetch real on-chain balance before selling
        jitosol_bal = await self.sol.jitosol_balance()
        if jitosol_bal <= 0:
            jitosol_bal = pos.jitosol_held
            log.warning(f"Could not fetch JitoSOL balance, using estimate: {jitosol_bal:.4f}")

        # JitoSOL has 9 decimals
        raw_amount = int(jitosol_bal * 1e9)
        if raw_amount <= 0:
            log.error("Sell amount is 0 — cannot sell")
            self.position = None
            return

        log.info(f"Selling {jitosol_bal:.4f} JitoSOL ({raw_amount} raw)...")

        sell_succeeded = False
        for attempt in range(1, 6):
            order = await self.jup.order(JITOSOL, WSOL, raw_amount, self.sol.pubkey)
            if order and order.get("transaction"):
                signed = self.sol.sign(order["transaction"])
                if signed:
                    result = await self.jup.execute(order["requestId"], signed)
                    if result:
                        if result.get("status") == "Failed":
                            err = result.get("error", "?")
                            log.error(f"Sell attempt {attempt} failed: {err}")
                            # If slippage, try with more
                            if "slippage" in str(err).lower():
                                log.warning("Slippage exceeded — retrying with higher slippage")
                        else:
                            sig = result.get("signature", "?")
                            log.info(f"SELL TX: {sig[:35]}...")
                            sell_succeeded = True
                            break
            else:
                log.warning(f"No sell route attempt {attempt}/5")

            if not sell_succeeded and attempt < 5:
                await asyncio.sleep(attempt * 2)

        if not sell_succeeded:
            log.error(f"SELL FAILED after 5 attempts — position stays open")
            return

        # Calculate P&L
        sol_received_estimate = jitosol_bal * ratio
        pnl_sol = sol_received_estimate - pos.cost_sol

        if pnl_sol >= 0:
            self.trades_won += 1
        else:
            self.trades_lost += 1
        self.total_pnl += pnl_sol

        log.info(f"CLOSED: ratio {pos.entry_ratio:.6f} -> {ratio:.6f} | "
                 f"P&L: {pnl_sol:+.6f} SOL | Reason: {reason}")

        await self.discord.sold(pos, ratio, reason, self.sol_usd, pnl_sol)

        self.position = None
        self.last_trade_ts = time.time()

    # ── HEARTBEAT ────────────────────────────────────────────────────────────

    async def _heartbeat(self):
        while True:
            await asyncio.sleep(300)  # every 5 min
            uptime   = (time.time() - self.start) / 60
            pnl_usd  = self.total_pnl * self.sol_usd
            fv       = self.fv.fair_value
            discount = self.fv.discount_pct()
            status   = "IN POSITION" if self.position else "FLAT"

            pnl_str = f"+${pnl_usd:.2f}" if pnl_usd >= 0 else f"-${abs(pnl_usd):.2f}"
            log.info(
                f"HEARTBEAT [{status}] | up {uptime:.0f}m | "
                f"{self.trades_won}W {self.trades_lost}L | "
                f"net {self.total_pnl:+.6f} SOL ({pnl_str}) | "
                f"FV: {fv:.6f if fv else 'warming'} | "
                f"disc: {f'{discount:+.3f}%' if discount else 'n/a'}"
            )

            # Discord ping every 30 min
            if int(uptime) % 30 < 5:
                sol_bal = await self.sol.sol_balance()
                await self.discord.alert(
                    f"💓 **Jito Trader** | {uptime:.0f}min up | "
                    f"{self.trades_won}W {self.trades_lost}L | "
                    f"Net: **{pnl_str}** | SOL=${self.sol_usd:.0f} | "
                    f"Balance: {sol_bal:.4f} SOL"
                )

if __name__ == "__main__":
    try:
        asyncio.run(Bot().run())
    except KeyboardInterrupt:
        log.info("Stopped")
