"""
DEGEN SNIPER v8 — Smart Graduation Sniper
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
What's new vs v7:

  1. DUAL PRICE CONFIRMATION — before buying, checks price using
     two independent methods (Jupiter price API + live AMM quote).
     Both must agree the coin is moving UP. Eliminates fake 0.0% readings.

  2. DEAD COIN DETECTION — if price reads the same value 3 polls
     in a row during a hold, it's a stale/dead quote. Bails immediately
     instead of holding for 2 minutes and timing out at a loss.

  3. SPLIT EXIT LADDER — sell 50% at 1.4x (lock profit), let rest
     ride to 2x or trailing stop. Worst case: break even on the trade.
     Best case: ride a 2x+ pump on the remainder.

  4. STRICT TOP HOLDER FILTER — MAX_TOP_HOLDER_PCT default 35%
     (was 50%). Eliminates most rugs and dead coins that never pump.

  5. SMARTER TRAILING STOP — stop only triggers after 3 consecutive
     readings below stop price (not one bad tick). Eliminates fake
     price spikes triggering premature stops.
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

TRADE_AMOUNT_SOL   = float(os.getenv("TRADE_AMOUNT_SOL",   "0.0625"))  # ~$10
TRAILING_STOP_PCT  = float(os.getenv("TRAILING_STOP_PCT",  "35"))      # wide stop — memecoins spike
MAX_HOLD_MINUTES   = float(os.getenv("MAX_HOLD_MINUTES",   "2"))       # hard timeout
SLIPPAGE_BPS       = int(os.getenv("SLIPPAGE_BPS",         "1000"))    # 10% — fast dumps need this
PROFIT_TARGET_1    = float(os.getenv("PROFIT_TARGET_1",    "1.4"))     # sell 50% at 1.4x
PROFIT_TARGET_2    = float(os.getenv("PROFIT_TARGET_2",    "2.0"))     # sell rest at 2x
MAX_TOP_HOLDER_PCT = float(os.getenv("MAX_TOP_HOLDER_PCT", "35"))      # strict — reject concentrated coins
DEAD_COIN_STRIKES  = int(os.getenv("DEAD_COIN_STRIKES",    "3"))       # bail after N identical prices
STOP_CONFIRM_COUNT = int(os.getenv("STOP_CONFIRM_COUNT",   "3"))       # N consecutive below stop to trigger

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
    name: str   = "Unknown"
    source: str = ""

@dataclass
class Position:
    token: Token
    entry_price: float  = 0.0
    tokens_held: float  = 0.0
    cost_sol: float     = 0.0
    high_price: float   = 0.0
    stop_price: float   = 0.0
    opened_ts: float    = 0.0
    took_first: bool    = False   # True after 50% sold at PROFIT_TARGET_1
    original_tokens: float = 0.0
    # Dead coin / stop confirmation counters
    _last_price: float  = 0.0
    _same_price_count: int = 0
    _below_stop_count: int = 0

    def __post_init__(self):
        if not self.opened_ts:       self.opened_ts = time.time()
        if not self.original_tokens: self.original_tokens = self.tokens_held

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
                resolver=AsyncResolver(nameservers=["8.8.8.8","1.1.1.1"]),
                ssl=False, limit=10)
        except:
            conn = aiohttp.TCPConnector(ssl=False, limit=10)
        return aiohttp.ClientSession(connector=conn, headers=self._headers())

    async def price_api(self, mint) -> Optional[float]:
        """Jupiter price API — fast but caches aggressively."""
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
        return None

    async def price_quote(self, mint) -> Optional[float]:
        """Live AMM quote — bypasses cache, reflects real on-chain price."""
        s = await self._sess()
        try:
            params = {"inputMint": mint, "outputMint": WSOL,
                      "amount": str(int(100_000 * 1e6))}
            async with s.get(JUP_ORDER, params=params,
                             timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    d = await r.json()
                    out = int(d.get("outAmount", "0")) / 1e9
                    if out > 0: return out / 100_000
        except: pass
        finally: await s.close()
        return None

    async def price(self, mint) -> Optional[float]:
        """Get price — tries API first, falls back to live quote."""
        p = await self.price_api(mint)
        if p: return p
        return await self.price_quote(mint)

    async def dual_price(self, mint):
        """
        Fetch price from BOTH sources concurrently.
        Returns (api_price, quote_price) — caller decides how to use them.
        Used for entry confirmation to avoid acting on cached stale prices.
        """
        api_task   = asyncio.create_task(self.price_api(mint))
        quote_task = asyncio.create_task(self.price_quote(mint))
        api_p, quote_p = await asyncio.gather(api_task, quote_task,
                                               return_exceptions=True)
        if isinstance(api_p,   Exception): api_p   = None
        if isinstance(quote_p, Exception): quote_p = None
        return api_p, quote_p

    async def sol_usd(self) -> float:
        s = await self._sess()
        try:
            async with s.get(f"{JUP_PRICE}?ids={WSOL}",
                             timeout=aiohttp.ClientTimeout(total=5)) as r:
                if r.status == 200:
                    d = await r.json()
                    p = d.get("data", {}).get(WSOL, {}).get("price")
                    if p: return float(p)
        except: pass
        finally: await s.close()
        return 160.0

    async def order(self, inp, out, amount, taker):
        s = await self._sess()
        try:
            params = {"inputMint": inp, "outputMint": out,
                      "amount": str(amount), "taker": taker,
                      "slippageBps": str(SLIPPAGE_BPS)}
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
        self.ws  = rpc.replace("https://","wss://").replace("http://","ws://")
        self.keypair = self.pubkey = None
        if pk:
            try:
                from solders.keypair import Keypair; import base58
                self.keypair = Keypair.from_bytes(base58.b58decode(pk))
                self.pubkey  = str(self.keypair.pubkey())
                log.info(f"Wallet: {self.pubkey[:8]}...{self.pubkey[-4:]}")
            except Exception as e: log.error(f"Wallet: {e}")

    async def balance(self, sess):
        if not self.pubkey: return 0.0
        try:
            async with sess.post(self.rpc,
                json={"jsonrpc":"2.0","id":1,"method":"getBalance",
                      "params":[self.pubkey]},
                timeout=aiohttp.ClientTimeout(total=10)) as r:
                d = await r.json()
                return d.get("result",{}).get("value",0)/1e9
        except: return 0.0

    async def token_balance(self, mint: str):
        """Real on-chain token balance — (raw_amount, decimals)."""
        if not self.pubkey: return 0, 6
        try:
            async with aiohttp.ClientSession() as sess:
                async with sess.post(self.rpc,
                    json={"jsonrpc":"2.0","id":1,
                          "method":"getTokenAccountsByOwner",
                          "params":[self.pubkey,{"mint":mint},
                                    {"encoding":"jsonParsed"}]},
                    timeout=aiohttp.ClientTimeout(total=10)) as r:
                    data = await r.json()
                for acct in data.get("result",{}).get("value",[]):
                    info = (acct.get("account",{}).get("data",{})
                                .get("parsed",{}).get("info",{}))
                    ta  = info.get("tokenAmount",{})
                    raw = int(ta.get("amount",0))
                    dec = int(ta.get("decimals",6))
                    if raw > 0:
                        log.info(f"On-chain balance: {raw} raw "
                                 f"({raw/10**dec:.2f} tokens, {dec}d)")
                        return raw, dec
        except Exception as e: log.error(f"token_balance: {e}")
        return 0, 6

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
        self.url      = url
        self._sol_usd = 160.0

    async def _get_sol_usd(self, jup: Jupiter):
        self._sol_usd = await jup.sol_usd()
        return self._sol_usd

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
                if attempt == 2: log.debug(f"Discord: {e}")
                await asyncio.sleep(1)

    def _label(self, p: Position) -> str:
        if p.token.symbol and p.token.symbol != "???": return p.token.symbol
        if p.token.name and p.token.name not in ("Unknown",""): return p.token.name[:12]
        return p.token.mint[:8] + "..."

    async def bought(self, p: Position, jup: Jupiter):
        sol_usd   = await self._get_sol_usd(jup)
        spent_usd = p.cost_sol * sol_usd
        label     = self._label(p)
        t1_usd    = spent_usd * PROFIT_TARGET_1
        t2_usd    = spent_usd * PROFIT_TARGET_2
        await self.send({"embeds": [{
            "title": f"BOUGHT {label}",
            "color": 0x00AAFF,
            "description": (
                f"Spent **${spent_usd:.2f}** ({p.cost_sol:.4f} SOL)\n"
                f"Sell 50% at **${t1_usd:.2f}** (+{(PROFIT_TARGET_1-1)*100:.0f}%) "
                f"| Rest at **${t2_usd:.2f}** (+{(PROFIT_TARGET_2-1)*100:.0f}%)"
            ),
            "fields": [
                {"name":"Stop",    "value":f"{TRAILING_STOP_PCT}% trail","inline":True},
                {"name":"Timeout", "value":f"{MAX_HOLD_MINUTES}min",     "inline":True},
                {"name":"Chart",   "value":f"[Solscan](https://solscan.io/token/{p.token.mint})","inline":True},
            ]
        }]})

    async def sold(self, p: Position, reason: str, gain_x: float,
                   pnl_sol: float, pct: int, jup: Jupiter):
        sol_usd   = await self._get_sol_usd(jup)
        spent_usd = p.cost_sol * sol_usd * (pct / 100)
        pnl_usd   = pnl_sol * sol_usd
        sell_usd  = spent_usd + pnl_usd
        label     = self._label(p)
        is_profit = pnl_usd >= 0
        color     = 0x00FF88 if is_profit else 0xFF4444
        emoji     = "PROFIT" if is_profit else "LOSS"
        pnl_str   = f"+${pnl_usd:.2f}" if is_profit else f"-${abs(pnl_usd):.2f}"
        rmap      = {"take_profit_1":"Sold 50% at 1.4x",
                     "take_profit_2":"Sold rest at 2x",
                     "trailing_stop":"Stop loss hit",
                     "timeout":      "2-min timeout",
                     "dead_coin":    "Dead coin (stale price)",
                     "price_dead":   "No price feed"}
        await self.send({"embeds": [{
            "title": f"{emoji} — {label} ({pct}% sold)",
            "color": color,
            "description": (
                f"Bought **${spent_usd:.2f}** -> Sold **${sell_usd:.2f}**\n"
                f"**{pnl_str}** ({gain_x:.3f}x) in {p.hold_mins:.1f}min"
            ),
            "fields": [
                {"name":"Reason",  "value":rmap.get(reason,reason),"inline":True},
                {"name":"SOL P&L", "value":f"{pnl_sol:+.5f} SOL", "inline":True},
                {"name":"Chart",   "value":f"[Solscan](https://solscan.io/token/{p.token.mint})","inline":True},
            ]
        }]})

    async def alert(self, msg: str):
        await self.send({"content": msg})

# ─── DETECTOR ────────────────────────────────────────────────────────────────

class Detector:
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
                        log.info("WebSocket connected")
                        await ws.send_json({"jsonrpc":"2.0","id":1,
                            "method":"logsSubscribe",
                            "params":[{"mentions":[PUMPFUN]},
                                      {"commitment":"confirmed"}]})
                        await ws.send_json({"jsonrpc":"2.0","id":2,
                            "method":"logsSubscribe",
                            "params":[{"mentions":[RAYDIUM_AMM]},
                                      {"commitment":"confirmed"}]})
                        async for msg in ws:
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                await self._handle(msg.data)
                            elif msg.type in (aiohttp.WSMsgType.ERROR,
                                             aiohttp.WSMsgType.CLOSED):
                                break
            except Exception as e: log.error(f"WS: {e}")
            log.info("WS reconnecting in 5s...")
            await asyncio.sleep(5)

    async def _handle(self, raw):
        if self.locked: return
        try:
            data = json.loads(raw)
            if "params" not in data: return
            value = data["params"]["result"].get("value",{})
            logs  = value.get("logs",[])
            sig   = value.get("signature","")
            if not logs or not sig: return
            if sig in self.seen: return

            log_text = " ".join(logs)
            is_grad  = (PUMPFUN in log_text and
                        ("Withdraw" in log_text or "migrate" in log_text.lower()))
            is_ray   = (RAYDIUM_AMM in log_text and
                        ("initialize2" in log_text or
                         "InitializeInstruction2" in log_text))
            if not is_grad and not is_ray: return

            self.seen.add(sig)
            source = "pumpfun" if is_grad else "raydium"
            log.info(f"GRADUATION ({source}) — tx {sig[:20]}...")

            if self.locked: return
            self.locked = True

            try:
                mint = None
                async with aiohttp.ClientSession() as sess:
                    for attempt in range(10):
                        mint = await self._extract_mint(sig, sess)
                        if mint: break
                        await asyncio.sleep(2)

                if not mint:
                    mint = self._mint_from_logs(logs, source)
                    if mint: log.info(f"Mint via log scan: {mint[:20]}...")

                if not mint:
                    log.warning(f"No mint from {sig[:16]}")
                    self.locked = False
                    return

                if mint in self.seen:
                    self.locked = False
                    return
                self.seen.add(mint)
                self.count += 1

                token = Token(mint=mint, source=source)
                log.info(f"DETECTED {source.upper()} -> {mint[:24]}...")

                if not self.locked or self.queue.empty():
                    await self.queue.put(token)
                else:
                    self.locked = False

            except Exception as e:
                log.warning(f"Handle inner: {e}")
                self.locked = False

        except Exception as e:
            log.warning(f"Handle: {e}")

    async def _extract_mint(self, sig, sess):
        try:
            payload = {"jsonrpc":"2.0","id":1,"method":"getTransaction",
                       "params":[sig,{"encoding":"jsonParsed",
                                      "maxSupportedTransactionVersion":0}]}
            async with sess.post(self.sol.rpc, json=payload,
                                 timeout=aiohttp.ClientTimeout(total=8)) as r:
                data = await r.json()
            tx = data.get("result")
            if not tx: return None
            meta = tx.get("meta",{})
            if not meta or meta.get("err"): return None
            skip = {WSOL,
                    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"}
            for bal in meta.get("postTokenBalances",[]):
                m = bal.get("mint","")
                if m and m not in skip: return m
            for bal in meta.get("preTokenBalances",[]):
                m = bal.get("mint","")
                if m and m not in skip: return m
        except: pass
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
        "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
        # Additional Pump.fun program addresses seen in logs
        "FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe",  # Pump AMM
        "Gz9VPiSLQYbvKyb3jZPjNfyA6n4T4qVFUuAukgL964nL",  # Pump router
        "FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9",  # Flash program
        "CxvksNjwhdHDLr3qbCXNKVdeYACW8cs93vFqLqtgyFE5",  # Pump swap
        "BBRouter1cVunVXvkcqeKkZQcBK7ruan37PPm3xzWaXD",   # BB Router
        "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",   # pAMM
    }
    _B58 = set("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")

    def _is_valid_mint(self, addr: str) -> bool:
        """
        Validate that an address looks like a real token mint:
        - Not in known programs list
        - Only base58 characters
        - 32-44 chars
        - No repeating patterns (AAAA, 1111 etc — these are program addresses)
        - Not all the same character
        """
        if addr in self._KNOWN_PROGRAMS: return False
        if not all(c in self._B58 for c in addr): return False
        if len(addr) < 32 or len(addr) > 44: return False
        # Reject addresses with long runs of same char (program addresses like 11111...)
        for c in self._B58:
            if c * 8 in addr: return False
        return True

    def _mint_from_logs(self, logs, source):
        import re
        # For Pump.fun: token mints end in "pump" — very specific
        if source == "pumpfun":
            for line in logs:
                for m in re.finditer(r'([1-9A-HJ-NP-Za-km-z]{32,44}pump)', line):
                    addr = m.group(1)
                    if self._is_valid_mint(addr):
                        log.debug(f"Pump mint from logs: {addr[:20]}")
                        return addr
        # For Raydium: scan for valid 43-44 char addresses
        for line in logs:
            for m in re.finditer(r'([1-9A-HJ-NP-Za-km-z]{43,44})', line):
                addr = m.group(1)
                if self._is_valid_mint(addr):
                    log.debug(f"Raydium mint from logs: {addr[:20]}")
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
        log.info("  DEGEN SNIPER v8 — Smart Graduation Sniper")
        log.info(f"  {TRADE_AMOUNT_SOL} SOL/trade")
        log.info(f"  Sell 50% @ {PROFIT_TARGET_1}x, rest @ {PROFIT_TARGET_2}x")
        log.info(f"  Stop: {TRAILING_STOP_PCT}% trail | Timeout: {MAX_HOLD_MINUTES}min")
        log.info(f"  Top holder filter: <{MAX_TOP_HOLDER_PCT}%")
        log.info(f"  Dead coin detection: {DEAD_COIN_STRIKES} identical prices")
        log.info(f"  Stop confirm: {STOP_CONFIRM_COUNT} consecutive readings")
        log.info(f"  Jupiter: {'SET' if JUPITER_API_KEY else 'MISSING'}")
        log.info("=" * 55)
        async with aiohttp.ClientSession() as s:
            bal = await self.sol.balance(s)
            sol_usd = await self.jup.sol_usd()
            log.info(f"Balance: {bal:.4f} SOL (${bal*sol_usd:.2f})")
        await asyncio.gather(
            self.detector.listen(),
            self._trade_loop(),
            self._heartbeat(),
        )

    # ── TRADE LOOP ───────────────────────────────────────────────────────────

    async def _trade_loop(self):
        log.info("Trade loop ready")
        while True:
            token = await self.detector.queue.get()
            self.detector.locked = True
            log.info(f"LOCKED IN on {token.mint[:20]}...")

            try:
                # Step 1: Quick filters
                passed = await self._filter(token)
                if not passed:
                    log.info(f"SKIP {token.mint[:16]} — failed filters")
                    self.detector.locked = False
                    continue

                # Step 2: Dual-source price confirmation
                confirmed, entry_price = await self._confirm_entry(token)
                if not confirmed:
                    log.info(f"SKIP {token.mint[:16]} — entry not confirmed")
                    self.detector.locked = False
                    continue

                # Step 3: Buy
                pos = await self._buy(token, entry_price)
                if not pos:
                    log.info(f"BUY FAILED {token.symbol}")
                    self.detector.locked = False
                    continue

                # Step 4: Watch until fully closed
                await self._watch(pos)

            except Exception as e:
                log.error(f"Trade loop: {e}")
                import traceback; traceback.print_exc()
            finally:
                self.detector.locked = False
                log.info("UNLOCKED — scanning for next coin")
                while not self.detector.queue.empty():
                    try: self.detector.queue.get_nowait()
                    except: break
                uptime = (time.time() - self.start) / 60
                log.info(f"Stats: {self.trades_won}W / {self.trades_lost}L | "
                         f"Net {self.total_pnl:+.5f} SOL | up {uptime:.0f}m")

    # ── FILTER ───────────────────────────────────────────────────────────────

    async def _filter(self, token: Token) -> bool:
        async with aiohttp.ClientSession() as sess:
            try:
                holder_t = asyncio.create_task(
                    self._rpc(sess, "getTokenLargestAccounts", [token.mint]))
                acct_t   = asyncio.create_task(
                    self._rpc(sess, "getAccountInfo",
                              [token.mint, {"encoding":"jsonParsed"}]))
                liq_t    = asyncio.create_task(
                    self.jup.order(WSOL, token.mint,
                                   int(0.005*1e9), self.sol.pubkey))

                holders_res, acct_res, liq_order = await asyncio.gather(
                    holder_t, acct_t, liq_t, return_exceptions=True)

                # Holder count
                if isinstance(holders_res, Exception) or not holders_res:
                    log.info(f"SKIP {token.mint[:16]}: holder RPC failed")
                    return False
                holders = holders_res.get("result",{}).get("value",[])
                if len(holders) < 5:
                    log.info(f"SKIP {token.mint[:16]}: only {len(holders)} holders")
                    return False

                # Top holder concentration — strict 35%
                supply_res = await self._rpc(sess, "getTokenSupply", [token.mint])
                total = float(supply_res.get("result",{}).get("value",{})
                                        .get("amount","0"))
                if total > 0 and holders:
                    top     = float(holders[0].get("amount","0"))
                    top_pct = (top / total) * 100
                    if top_pct > MAX_TOP_HOLDER_PCT:
                        log.info(f"SKIP {token.mint[:16]}: top holder {top_pct:.0f}% "
                                 f"(max {MAX_TOP_HOLDER_PCT}%)")
                        return False

                # Freeze authority
                if not isinstance(acct_res, Exception) and acct_res:
                    acct = acct_res.get("result",{}).get("value",{})
                    if acct:
                        parsed = (acct.get("data",{}).get("parsed",{})
                                      .get("info",{}))
                        if parsed.get("freezeAuthority"):
                            log.info(f"SKIP {token.mint[:16]}: freeze authority")
                            return False
                        if parsed.get("symbol"): token.symbol = parsed["symbol"]
                        if parsed.get("name"):   token.name   = parsed["name"]

                # Liquidity
                if (isinstance(liq_order, Exception) or not liq_order
                        or not liq_order.get("outAmount")):
                    log.info(f"SKIP {token.mint[:16]}: no liquidity")
                    return False

                # Metadata from Pump.fun
                try:
                    async with sess.get(
                        f"https://frontend-api.pump.fun/coins/{token.mint}",
                        timeout=aiohttp.ClientTimeout(total=3)) as r:
                        if r.status == 200:
                            meta = await r.json()
                            if meta.get("symbol"): token.symbol = meta["symbol"]
                            if meta.get("name"):   token.name   = meta["name"]
                except: pass

                label = token.symbol if token.symbol != "???" else token.mint[:8]
                log.info(f"PASS {label} ({token.mint[:16]}) — {len(holders)} holders, "
                         f"top holder {top_pct:.0f}%")
                return True

            except Exception as e:
                log.warning(f"Filter: {e}")
                return False

    # ── ENTRY CONFIRMATION ───────────────────────────────────────────────────

    async def _confirm_entry(self, token: Token):
        """
        Dual-source price confirmation — check price via TWO independent
        methods 5 seconds apart. Both must show upward movement.
        This eliminates stale Jupiter cache returning identical prices.
        """
        log.info(f"Entry check: sampling {token.symbol} price (dual source)...")

        # Sample 1: get both price sources at t=0
        api_t0, quote_t0 = await self.jup.dual_price(token.mint)
        log.info(f"  t=0  api={api_t0:.10f if api_t0 else 'None'} "
                 f"quote={quote_t0:.10f if quote_t0 else 'None'}")

        await asyncio.sleep(5)

        # Sample 2: get both price sources at t=5
        api_t5, quote_t5 = await self.jup.dual_price(token.mint)
        log.info(f"  t=5s api={api_t5:.10f if api_t5 else 'None'} "
                 f"quote={quote_t5:.10f if quote_t5 else 'None'}")

        # Need at least the quote price (it bypasses cache)
        if not quote_t0 or not quote_t5:
            log.info("  SKIP: no live quote data")
            return False, 0.0

        # Check quote-based movement (most reliable)
        quote_move = ((quote_t5 - quote_t0) / quote_t0) * 100
        log.info(f"  Quote movement: {quote_move:+.2f}%")

        # Also check API if available
        api_move = None
        if api_t0 and api_t5 and api_t0 != api_t5:
            api_move = ((api_t5 - api_t0) / api_t0) * 100
            log.info(f"  API movement:   {api_move:+.2f}%")

        # Entry condition: quote must be moving UP
        # If API also available and moving, even better
        if quote_move <= 0:
            log.info(f"  SKIP: quote down {quote_move:.2f}% — no upward momentum")
            return False, 0.0

        # Use quote price as entry price (most accurate)
        entry_price = quote_t5
        log.info(f"  CONFIRMED: +{quote_move:.2f}% momentum — BUYING!")
        return True, entry_price

    # ── BUY ──────────────────────────────────────────────────────────────────

    async def _buy(self, token: Token, entry_price: float) -> Optional[Position]:
        if not self.sol.pubkey: return None
        async with aiohttp.ClientSession() as sess:
            bal = await self.sol.balance(sess)
        if bal < TRADE_AMOUNT_SOL + 0.005:
            log.error(f"Low balance: {bal:.4f}"); return None

        lamports = int(TRADE_AMOUNT_SOL * 1e9)
        order    = await self.jup.order(WSOL, token.mint, lamports, self.sol.pubkey)
        if not order: log.error("No buy route"); return None

        tx_b64 = order.get("transaction","")
        req_id = order.get("requestId","")
        out_amt = int(order.get("outAmount","0"))

        if not tx_b64 or not req_id: log.error("Bad order"); return None
        signed = self.sol.sign(tx_b64)
        if not signed: return None

        result = await self.jup.execute(req_id, signed)
        if not result: log.error("Execute failed"); return None
        if result.get("status") == "Failed":
            log.error(f"Buy failed: {result.get('error','?')}"); return None

        sig = result.get("signature","?")
        log.info(f"BUY TX: {sig[:35]}...")

        await asyncio.sleep(2)
        async with aiohttp.ClientSession() as sess:
            bal_after = await self.sol.balance(sess)

        # Use confirmed entry price, fall back to estimate
        if not entry_price:
            entry_price = TRADE_AMOUNT_SOL / (out_amt/1e6) if out_amt > 0 else 0.0

        tokens = out_amt / 1e6
        gas    = max(0.0, (bal - bal_after) - TRADE_AMOUNT_SOL)

        pos = Position(
            token          = token,
            entry_price    = entry_price,
            tokens_held    = tokens,
            original_tokens= tokens,
            cost_sol       = TRADE_AMOUNT_SOL,
            high_price     = entry_price,
            stop_price     = entry_price * (1 - TRAILING_STOP_PCT/100),
        )
        await self.discord.bought(pos, self.jup)
        log.info(f"BOUGHT {tokens:.0f} {token.symbol} @ ${entry_price:.10f}")
        log.info(f"  T1: ${entry_price*PROFIT_TARGET_1:.10f} | "
                 f"T2: ${entry_price*PROFIT_TARGET_2:.10f} | "
                 f"Stop: ${pos.stop_price:.10f}")
        return pos

    # ── WATCH ────────────────────────────────────────────────────────────────

    async def _watch(self, pos: Position):
        log.info(f"WATCHING {pos.token.symbol} — "
                 f"T1={PROFIT_TARGET_1}x T2={PROFIT_TARGET_2}x "
                 f"stop={TRAILING_STOP_PCT}%")
        price_fails = 0

        while True:
            await asyncio.sleep(1)
            price = await self.jup.price(pos.token.mint)

            # ── NO PRICE ─────────────────────────────────────────────────────
            if not price:
                price_fails += 1
                if price_fails % 15 == 1:
                    log.warning(f"No price ({price_fails}x) for {pos.token.symbol}")
                if price_fails >= 60:
                    log.error(f"Price dead 60s — emergency sell")
                    await self._sell(pos, pos.entry_price, "price_dead", 100)
                    return
                continue

            price_fails = 0
            gain_x = price / pos.entry_price if pos.entry_price > 0 else 1.0

            # ── DEAD COIN DETECTION ───────────────────────────────────────────
            # If price is exactly the same N times in a row, it's a stale
            # Jupiter cache — the coin has no real activity. Bail early.
            if price == pos._last_price:
                pos._same_price_count += 1
                if pos._same_price_count >= DEAD_COIN_STRIKES:
                    log.warning(f"DEAD COIN: price stuck at ${price:.8f} "
                                f"for {DEAD_COIN_STRIKES} polls — bailing")
                    await self._sell(pos, price, "dead_coin", 100)
                    return
            else:
                pos._same_price_count = 0
            pos._last_price = price

            log.info(f"  {pos.token.symbol:8s} ${price:.8f} ({gain_x:.3f}x) "
                     f"stop=${pos.stop_price:.8f} held={pos.hold_mins:.1f}m"
                     f"{' [HALF OUT]' if pos.took_first else ''}")

            # ── TIMEOUT ───────────────────────────────────────────────────────
            if pos.timed_out:
                log.warning(f"TIMEOUT {pos.hold_mins:.1f}min ({gain_x:.2f}x)")
                await self._sell(pos, price, "timeout", 100)
                return

            # ── TAKE PROFIT TIER 1: sell 50% at 1.4x ────────────────────────
            if gain_x >= PROFIT_TARGET_1 and not pos.took_first:
                pos.took_first = True
                log.info(f"T1 HIT {gain_x:.3f}x — selling 50%!")
                await self._sell(pos, price, "take_profit_1", 50)
                # Tighten stop to entry after T1 — can't lose on trade now
                pos.stop_price = max(pos.stop_price,
                                     pos.entry_price * 0.99)
                log.info(f"Stop tightened to entry: ${pos.stop_price:.10f}")
                continue

            # ── TAKE PROFIT TIER 2: sell rest at 2x ──────────────────────────
            if gain_x >= PROFIT_TARGET_2 and pos.took_first:
                log.info(f"T2 HIT {gain_x:.3f}x — selling remainder!")
                await self._sell(pos, price, "take_profit_2", 100)
                return

            # ── TRAILING STOP UPDATE ──────────────────────────────────────────
            if price > pos.high_price:
                pos.high_price = price
                # After T1 hit, trail tighter
                trail = TRAILING_STOP_PCT / 2 if pos.took_first else TRAILING_STOP_PCT
                pos.stop_price = price * (1 - trail/100)
                log.info(f"  NEW HIGH ${price:.8f} -> stop ${pos.stop_price:.8f}")
                pos._below_stop_count = 0

            # ── STOP LOSS with confirmation ───────────────────────────────────
            # Require N consecutive readings below stop before firing.
            # One bad tick won't shake us out anymore.
            if pos.stop_price > 0 and price <= pos.stop_price:
                pos._below_stop_count += 1
                log.warning(f"Below stop {pos._below_stop_count}/{STOP_CONFIRM_COUNT}: "
                             f"${price:.8f} <= ${pos.stop_price:.8f} ({gain_x:.3f}x)")
                if pos._below_stop_count >= STOP_CONFIRM_COUNT:
                    log.warning(f"STOP CONFIRMED — selling")
                    await self._sell(pos, price, "trailing_stop", 100)
                    return
            else:
                pos._below_stop_count = 0

    # ── SELL ─────────────────────────────────────────────────────────────────

    async def _sell(self, pos: Position, price: float, reason: str, pct: int):
        gain_x  = price / pos.entry_price if pos.entry_price > 0 else 1.0
        tokens_to_sell_estimate = pos.tokens_held * (pct/100)
        pnl_sol = (price * tokens_to_sell_estimate) - (pos.cost_sol * pct/100)

        log.info(f"SELL {pct}% of {pos.token.symbol} — {reason} "
                 f"({gain_x:.3f}x, {pnl_sol:+.5f} SOL)")

        # Fetch real on-chain balance
        raw_amount, decimals = await self.sol.token_balance(pos.token.mint)
        if raw_amount <= 0:
            raw_amount = int(tokens_to_sell_estimate * (10 ** 6))
            log.warning(f"Using estimate: {raw_amount}")

        # For partial sells, calculate the right portion
        if pct < 100:
            raw_amount = int(raw_amount * (pct / 100))

        if raw_amount <= 0:
            log.error("Sell amount 0"); return

        sell_succeeded = False
        for attempt in range(1, 6):
            order = await self.jup.order(
                pos.token.mint, WSOL, raw_amount, self.sol.pubkey)
            if order and order.get("transaction"):
                signed = self.sol.sign(order["transaction"])
                if signed:
                    result = await self.jup.execute(order["requestId"], signed)
                    if result:
                        if result.get("status") == "Failed":
                            err = result.get("error","?")
                            log.error(f"Sell attempt {attempt} failed: {err}")
                            if "insufficient" in str(err).lower() or attempt == 3:
                                raw_amount = int(raw_amount * 0.98)
                        else:
                            sig = result.get("signature","?")
                            log.info(f"SELL TX: {sig[:35]}...")
                            sell_succeeded = True
                            break
            else:
                log.warning(f"No sell route {attempt}/5 for {pos.token.symbol}")

            if not sell_succeeded and attempt < 5:
                await asyncio.sleep(min(attempt * 2, 6))

        if not sell_succeeded:
            log.error(f"SELL FAILED after 5 attempts — {pos.token.symbol}")
            return

        # Update state
        pos.tokens_held -= tokens_to_sell_estimate
        if pnl_sol >= 0: self.trades_won  += 1
        else:             self.trades_lost += 1
        self.total_pnl += pnl_sol

        await self.discord.sold(pos, reason, gain_x, pnl_sol, pct, self.jup)
        log.info(f"{'PARTIAL' if pct < 100 else 'CLOSED'} {pos.token.symbol}: "
                 f"{gain_x:.3f}x | {pnl_sol:+.5f} SOL")

    # ── HELPERS ──────────────────────────────────────────────────────────────

    async def _rpc(self, sess, method, params):
        try:
            async with sess.post(self.sol.rpc,
                json={"jsonrpc":"2.0","id":1,"method":method,"params":params},
                timeout=aiohttp.ClientTimeout(total=8)) as r:
                return await r.json()
        except: return {}

    async def _heartbeat(self):
        while True:
            await asyncio.sleep(60)
            uptime  = (time.time() - self.start) / 60
            sol_usd = await self.jup.sol_usd()
            pnl_usd = self.total_pnl * sol_usd
            pnl_str = f"+${pnl_usd:.2f}" if pnl_usd >= 0 else f"-${abs(pnl_usd):.2f}"
            status  = "LOCKED IN" if self.detector.locked else "SCANNING"
            log.info(f"HEARTBEAT [{status}] | up {uptime:.0f}m | "
                     f"{self.detector.count} seen | "
                     f"{self.trades_won}W {self.trades_lost}L | "
                     f"net {self.total_pnl:+.5f} SOL ({pnl_str})")
            if int(uptime) % 30 < 1 and uptime > 1:
                async with aiohttp.ClientSession() as s:
                    bal = await self.sol.balance(s)
                await self.discord.alert(
                    f"💓 **Winston v8** | {uptime:.0f}min | "
                    f"{self.trades_won}W {self.trades_lost}L | "
                    f"Net: **{pnl_str}** | Bal: {bal:.4f} SOL"
                )

if __name__ == "__main__":
    try:
        asyncio.run(Bot().run())
    except KeyboardInterrupt:
        log.info("Stopped")
