"""
DEGEN SNIPER v6 — FINAL BUILD
Detection: Pump.fun graduations + Raydium pools via WebSocket
Mint extraction: getTransaction with 5 retries
Quality filters: 10+ holders, no freeze auth, top holder <50%, liquidity test
Buy: $4 (0.049 SOL) via Jupiter Swap V2
Exit strategy: Quote-based pricing (no 404s), 3-min max hold, 
  sell 50% at 1.5x, trailing 15% stop after profit, 
  emergency sell if price drops 25% from entry
"""

import asyncio, json, re, time, logging, os, base64 as b64
from dataclasses import dataclass
from typing import Optional
import aiohttp

# ═══ CONFIG ═══════════════════════════════════════════════════════════════════

TRADE_AMOUNT_SOL    = float(os.getenv("TRADE_AMOUNT_SOL", "0.049"))   # $4
TRAILING_STOP_PCT   = float(os.getenv("TRAILING_STOP_PCT", "15"))     # 15% trail
MAX_HOLD_SECONDS    = int(os.getenv("MAX_HOLD_SECONDS", "180"))       # 3 minutes
SLIPPAGE_BPS        = int(os.getenv("SLIPPAGE_BPS", "500"))           # 5%
DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "")
SOLANA_RPC_URL      = os.getenv("SOLANA_RPC_URL", "")
WALLET_PRIVATE_KEY  = os.getenv("WALLET_PRIVATE_KEY", "")
JUPITER_API_KEY     = os.getenv("JUPITER_API_KEY", "")
MAX_OPEN_POSITIONS  = int(os.getenv("MAX_OPEN_POSITIONS", "2"))
MAX_TOP_HOLDER_PCT  = float(os.getenv("MAX_TOP_HOLDER_PCT", "50"))
MIN_HOLDERS         = int(os.getenv("MIN_HOLDERS", "10"))

PUMPFUN     = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
RAYDIUM_AMM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
WSOL        = "So11111111111111111111111111111111111111112"
SKIP_MINTS  = {WSOL, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
               "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"}

JUP_ORDER   = "https://api.jup.ag/swap/v2/order"
JUP_EXECUTE = "https://api.jup.ag/swap/v2/execute"
JUP_PRICE   = "https://api.jup.ag/price/v2"

logging.basicConfig(level=logging.INFO,
    format="%(asctime)s │ %(levelname)-7s │ %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("sniper")

# ═══ MODELS ═══════════════════════════════════════════════════════════════════

@dataclass
class Token:
    mint: str; symbol: str = "???"; name: str = "Unknown"; source: str = ""

@dataclass
class Position:
    token: Token
    entry_price: float = 0.0
    tokens_held: float = 0.0
    original_tokens: float = 0.0
    cost_sol: float = 0.0
    high_price: float = 0.0
    stop_price: float = 0.0
    status: str = "open"
    exit_price: float = 0.0
    exit_reason: str = ""
    buy_gas: float = 0.0
    sell_gas: float = 0.0
    opened_ts: float = 0.0
    took_profit: bool = False
    def __post_init__(self):
        if not self.opened_ts: self.opened_ts = time.time()
        if not self.original_tokens: self.original_tokens = self.tokens_held
    @property
    def age_secs(self): return time.time() - self.opened_ts
    @property
    def expired(self): return self.age_secs >= MAX_HOLD_SECONDS

# ═══ JUPITER SWAP V2 ═════════════════════════════════════════════════════════

class Jupiter:
    def __init__(self, wallet_pubkey: str):
        self.wallet = wallet_pubkey

    async def _sess(self):
        h = {"Content-Type": "application/json"}
        if JUPITER_API_KEY: h["x-api-key"] = JUPITER_API_KEY
        try:
            from aiohttp.resolver import AsyncResolver
            c = aiohttp.TCPConnector(resolver=AsyncResolver(nameservers=["8.8.8.8","1.1.1.1"]), ssl=False)
        except: c = aiohttp.TCPConnector(ssl=False)
        return aiohttp.ClientSession(connector=c, headers=h)

    async def get_price_via_quote(self, mint: str) -> Optional[float]:
        """
        Get price by asking Jupiter for a sell quote.
        This works on ALL tokens including brand-new ones (no 404).
        """
        s = await self._sess()
        try:
            # Ask: "how much SOL for 100,000 tokens?"
            test_tokens = int(100_000 * 1e6)
            params = {"inputMint": mint, "outputMint": WSOL,
                      "amount": str(test_tokens), "taker": self.wallet}
            async with s.get(JUP_ORDER, params=params,
                             timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    d = await r.json()
                    out_lamports = int(d.get("outAmount", "0"))
                    if out_lamports > 0:
                        sol_value = out_lamports / 1e9
                        return sol_value / 100_000  # price per token in SOL
        except: pass
        finally: await s.close()
        return None

    async def order(self, inp, out, amount, taker=None):
        s = await self._sess()
        try:
            params = {"inputMint": inp, "outputMint": out,
                      "amount": str(amount), "taker": taker or self.wallet}
            async with s.get(JUP_ORDER, params=params,
                             timeout=aiohttp.ClientTimeout(total=12)) as r:
                if r.status == 200: return await r.json()
                log.error(f"Jup order {r.status}: {(await r.text())[:100]}")
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
                log.error(f"Jup exec {r.status}: {(await r.text())[:100]}")
        except Exception as e: log.error(f"Jup exec: {e}")
        finally: await s.close()
        return None

    async def swap_sell(self, mint: str, token_amount: int) -> Optional[str]:
        """Full sell flow: order → sign → execute. Returns tx signature."""
        order = await self.order(mint, WSOL, token_amount)
        if not order or not order.get("transaction"):
            log.error(f"No sell route"); return None
        signed = _sol.sign(order["transaction"])
        if not signed: return None
        result = await self.execute(order["requestId"], signed)
        if not result: return None
        if result.get("status") == "Failed":
            log.error(f"Sell failed: {result.get('error','?')}"); return None
        sig = result.get("signature", "?")
        log.info(f"Sell TX: {sig[:30]}...")
        return sig

# ═══ SOLANA RPC ═══════════════════════════════════════════════════════════════

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
            async with sess.post(self.rpc,
                json={"jsonrpc":"2.0","id":1,"method":"getBalance","params":[self.pubkey]},
                timeout=aiohttp.ClientTimeout(total=10)) as r:
                d = await r.json(); return d.get("result",{}).get("value",0)/1e9
        except: return 0.0

    async def rpc_call(self, sess, method, params):
        try:
            async with sess.post(self.rpc,
                json={"jsonrpc":"2.0","id":1,"method":method,"params":params},
                timeout=aiohttp.ClientTimeout(total=10)) as r:
                return await r.json()
        except: return {}

    def sign(self, tx_b64):
        if not self.keypair: return None
        try:
            from solders.transaction import VersionedTransaction
            raw = b64.b64decode(tx_b64)
            txn = VersionedTransaction.from_bytes(raw)
            signed = VersionedTransaction(txn.message, [self.keypair])
            return b64.b64encode(bytes(signed)).decode()
        except Exception as e: log.error(f"Sign: {e}"); return None

# ═══ DISCORD (buy + sell only) ════════════════════════════════════════════════

class Discord:
    def __init__(self, url): self.url = url
    async def _send(self, embed):
        if not self.url: return
        try:
            async with aiohttp.ClientSession() as s:
                await s.post(self.url, json={"embeds":[embed]})
        except: pass

    async def bought(self, p):
        await self._send({"title":f"💰 BOUGHT — {p.token.symbol}","color":0x00FF88,
            "fields":[
                {"name":"Mint","value":f"`{p.token.mint[:24]}...`","inline":False},
                {"name":"Price","value":f"${p.entry_price:.10f}","inline":True},
                {"name":"Spent","value":f"{p.cost_sol:.4f} SOL (~$4)","inline":True},
                {"name":"Link","value":f"[Solscan](https://solscan.io/token/{p.token.mint})","inline":False}]})

    async def sold(self, p, reason, pct):
        pnl = (p.exit_price - p.entry_price) * p.original_tokens
        e = "🟢" if pnl >= 0 else "🔴"
        await self._send({"title":f"{e} SOLD {pct}% — {p.token.symbol} ({reason})",
            "color":0x00FF88 if pnl>=0 else 0xFF4444,
            "fields":[
                {"name":"Entry","value":f"${p.entry_price:.10f}","inline":True},
                {"name":"Exit","value":f"${p.exit_price:.10f}","inline":True},
                {"name":"Held","value":f"{p.age_secs:.0f}s","inline":True}]})

# ═══ POOL DETECTOR ════════════════════════════════════════════════════════════

class Detector:
    def __init__(self, sol, callback):
        self.sol = sol; self.callback = callback
        self.seen = set(); self.count = 0

    async def listen(self):
        while True:
            try:
                log.info("Connecting WS...")
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
            logs = value.get("logs",[]); sig = value.get("signature","")
            if not logs or not sig: return
            log_text = " ".join(logs)

            is_pump = PUMPFUN in log_text and ("Withdraw" in log_text or "migrate" in log_text.lower())
            is_ray = "initialize2" in log_text or "InitializeInstruction2" in log_text
            if not is_pump and not is_ray: return
            if sig in self.seen: return
            self.seen.add(sig)

            source = "pumpfun" if is_pump else "raydium"
            log.info(f"🆕 {source.upper()} pool (tx: {sig[:20]}...)")

            # Extract mint with 5 retries
            mint = None
            async with aiohttp.ClientSession() as sess:
                for _ in range(5):
                    mint = await self._get_mint(sig, sess)
                    if mint: break
                    await asyncio.sleep(2)

            if not mint or mint in self.seen:
                log.warning(f"No mint from {sig[:16]}")
                return
            self.seen.add(mint); self.count += 1
            log.info(f"🎯 {source.upper()} → {mint[:24]}...")
            await self.callback(Token(mint=mint, source=source))
        except Exception as e: log.warning(f"Handle: {e}")

    async def _get_mint(self, sig, sess):
        try:
            res = await self.sol.rpc_call(sess, "getTransaction",
                [sig, {"encoding":"jsonParsed","maxSupportedTransactionVersion":0}])
            tx = res.get("result")
            if not tx: return None
            meta = tx.get("meta",{})
            if not meta or meta.get("err"): return None
            for bal in meta.get("postTokenBalances",[]):
                m = bal.get("mint","")
                if m and m not in SKIP_MINTS: return m
            for bal in meta.get("preTokenBalances",[]):
                m = bal.get("mint","")
                if m and m not in SKIP_MINTS: return m
        except: pass
        return None

# ═══ EXIT ENGINE ══════════════════════════════════════════════════════════════

class ExitEngine:
    """
    Aggressive 3-minute exit strategy:
    - Checks price every 2s using QUOTE-BASED pricing (not price API)
    - At 1.5x: sell 50%, tighten stop to 10%
    - 15% trailing stop (tightens to 10% after take-profit)
    - 25% crash protection: instant sell if drops 25% below entry
    - 3-minute hard timeout: sell everything
    """
    def __init__(self, jup, sol, discord):
        self.jup = jup; self.sol = sol; self.discord = discord
        self.positions: list[Position] = []

    def add(self, pos): self.positions.append(pos)

    @property
    def open_count(self): return len([p for p in self.positions if p.status=="open"])

    async def run(self):
        log.info(f"Exit engine: {TRAILING_STOP_PCT}% trail | {MAX_HOLD_SECONDS}s max | 2s poll")
        while True:
            for pos in [p for p in self.positions if p.status == "open"]:
                await self._check(pos)
            await asyncio.sleep(2)

    async def _check(self, pos):
        # Use QUOTE-BASED pricing — works on brand new tokens
        price = await self.jup.get_price_via_quote(pos.token.mint)

        if not price:
            pos._fails = getattr(pos, '_fails', 0) + 1
            if pos._fails >= 45:  # 90 seconds no price
                log.error(f"💀 {pos.token.mint[:16]}: no price 90s — emergency sell")
                await self._sell_all(pos, pos.entry_price, "no_price")
            elif pos._fails % 15 == 1:
                log.warning(f"⚠️ {pos.token.mint[:16]}: no price ({pos._fails}x)")
            return

        pos._fails = 0
        gain = price / pos.entry_price if pos.entry_price > 0 else 1
        age = int(pos.age_secs)

        log.info(f"👁️ {pos.token.mint[:12]} ${price:.8f} ({gain:.2f}x) {age}s stop=${pos.stop_price:.8f}")

        # ── 3-MINUTE HARD EXIT ──
        if pos.expired:
            log.warning(f"⏰ TIMEOUT {pos.token.mint[:16]} — selling all")
            await self._sell_all(pos, price, "timeout")
            return

        # ── CRASH PROTECTION: -25% from entry = instant sell ──
        if gain <= 0.75:
            log.warning(f"📉 CRASH {pos.token.mint[:16]} down {(1-gain)*100:.0f}% — selling")
            await self._sell_all(pos, price, "crash_protect")
            return

        # ── TAKE PROFIT at 1.5x: sell 50%, lock in profit ──
        if gain >= 1.5 and not pos.took_profit:
            pos.took_profit = True
            log.info(f"🎯 1.5x! Selling 50% — securing profit")
            await self._sell_partial(pos, price, "take_profit", 50)
            pos.stop_price = pos.high_price * 0.90  # tighten to 10%
            return

        # ── UPDATE TRAILING STOP ──
        if price > pos.high_price:
            pos.high_price = price
            trail = 0.10 if pos.took_profit else (TRAILING_STOP_PCT / 100)
            pos.stop_price = price * (1 - trail)

        # ── TRAILING STOP HIT ──
        if price <= pos.stop_price and pos.age_secs > 10:  # skip first 10s
            log.warning(f"🛑 STOP {pos.token.mint[:16]} @ ${price:.8f}")
            await self._sell_all(pos, price, "trailing_stop")

    async def _sell_all(self, pos, price, reason):
        pos.status = "closed"; pos.exit_price = price; pos.exit_reason = reason
        amount = int(pos.tokens_held * 1e6)
        if amount > 0:
            await self.jup.swap_sell(pos.token.mint, amount)
        pos.tokens_held = 0
        await self.discord.sold(pos, reason, 100)
        pnl = (price - pos.entry_price) * pos.original_tokens
        log.info(f"✅ CLOSED {pos.token.mint[:16]} P&L≈${pnl:+.4f} [{reason}] {pos.age_secs:.0f}s")

    async def _sell_partial(self, pos, price, reason, pct):
        sell_tokens = pos.tokens_held * (pct / 100)
        amount = int(sell_tokens * 1e6)
        if amount > 0:
            await self.jup.swap_sell(pos.token.mint, amount)
        pos.tokens_held -= sell_tokens
        pos.exit_price = price
        await self.discord.sold(pos, reason, pct)
        log.info(f"💵 Sold {pct}% — kept {pos.tokens_held:.0f} tokens riding")

# ═══ MAIN BOT ═════════════════════════════════════════════════════════════════

_sol = None  # Global ref for Jupiter.swap_sell to access signing

class Bot:
    def __init__(self):
        global _sol
        self.sol = Solana(SOLANA_RPC_URL, WALLET_PRIVATE_KEY)
        _sol = self.sol
        self.jup = Jupiter(self.sol.pubkey or "")
        self.discord = Discord(DISCORD_WEBHOOK_URL)
        self.exits = ExitEngine(self.jup, self.sol, self.discord)
        self.detector = Detector(self.sol, self._on_token)
        self.start = time.time()

    async def run(self):
        log.info("=" * 55)
        log.info("  DEGEN SNIPER v6 — FINAL BUILD")
        log.info(f"  Buy: {TRADE_AMOUNT_SOL} SOL (~$4) | Stop: {TRAILING_STOP_PCT}%")
        log.info(f"  Max hold: {MAX_HOLD_SECONDS}s | Max pos: {MAX_OPEN_POSITIONS}")
        log.info(f"  Slippage: {SLIPPAGE_BPS}bps | Min holders: {MIN_HOLDERS}")
        log.info(f"  Jupiter: {'✅' if JUPITER_API_KEY else '❌'}")
        log.info("=" * 55)
        async with aiohttp.ClientSession() as s:
            if self.sol.pubkey:
                b = await self.sol.balance(s)
                log.info(f"Balance: {b:.4f} SOL (~${b*140:.0f})")
        await asyncio.gather(self.detector.listen(), self.exits.run(), self._hb())

    async def _on_token(self, token):
        if self.exits.open_count >= MAX_OPEN_POSITIONS:
            log.info(f"⏸️ {token.mint[:16]}: {MAX_OPEN_POSITIONS} open, skip")
            return

        # Quality filters
        async with aiohttp.ClientSession() as sess:
            try:
                # Holders check
                hr = await self.sol.rpc_call(sess, "getTokenLargestAccounts", [token.mint])
                holders = hr.get("result",{}).get("value",[])
                if len(holders) < MIN_HOLDERS:
                    log.info(f"⛔ {token.mint[:16]}: {len(holders)} holders (<{MIN_HOLDERS})")
                    return

                # Top holder check
                sr = await self.sol.rpc_call(sess, "getTokenSupply", [token.mint])
                total = float(sr.get("result",{}).get("value",{}).get("amount","0"))
                if total > 0 and holders:
                    top_pct = float(holders[0].get("amount","0")) / total * 100
                    if top_pct > MAX_TOP_HOLDER_PCT:
                        log.info(f"⛔ {token.mint[:16]}: top holder {top_pct:.0f}%")
                        return

                # Freeze authority check
                ar = await self.sol.rpc_call(sess, "getAccountInfo", [token.mint, {"encoding":"jsonParsed"}])
                acct = ar.get("result",{}).get("value",{})
                if acct:
                    info = acct.get("data",{}).get("parsed",{}).get("info",{})
                    if info.get("freezeAuthority"):
                        log.info(f"⛔ {token.mint[:16]}: freeze auth")
                        return
                    if info.get("symbol"): token.symbol = info["symbol"]
                    if info.get("name"): token.name = info["name"]

                # Liquidity test
                test = await self.jup.order(WSOL, token.mint, int(0.01*1e9))
                if not test or not test.get("outAmount"):
                    log.info(f"⛔ {token.mint[:16]}: no liquidity")
                    return

                log.info(f"✅ {token.symbol} ({len(holders)} holders) — BUYING!")
            except Exception as e:
                log.warning(f"Filter: {e}")

        await asyncio.sleep(1)
        await self._buy(token)

    async def _buy(self, token):
        if not self.sol.pubkey: return
        async with aiohttp.ClientSession() as sess:
            bal = await self.sol.balance(sess)
        if bal < TRADE_AMOUNT_SOL + 0.005:
            log.error(f"Low SOL: {bal:.4f}"); return

        lamports = int(TRADE_AMOUNT_SOL * 1e9)
        order = await self.jup.order(WSOL, token.mint, lamports)
        if not order: log.info(f"No route {token.mint[:16]}"); return

        tx_b64 = order.get("transaction","")
        req_id = order.get("requestId","")
        out_amount = int(order.get("outAmount","0"))
        if not tx_b64 or not req_id: return

        signed = self.sol.sign(tx_b64)
        if not signed: return

        result = await self.jup.execute(req_id, signed)
        if not result: log.error("Execute failed"); return
        if result.get("status") == "Failed":
            log.error(f"Swap failed: {result.get('error','?')}"); return

        log.info(f"✅ TX: {result.get('signature','?')[:30]}...")

        tokens = out_amount / 1e6
        price = TRADE_AMOUNT_SOL / tokens if tokens > 0 else 0

        pos = Position(token=token, entry_price=price, tokens_held=tokens,
                       cost_sol=TRADE_AMOUNT_SOL, high_price=price,
                       stop_price=price * (1 - TRAILING_STOP_PCT/100))
        self.exits.add(pos)
        await self.discord.bought(pos)
        log.info(f"💰 BOUGHT {tokens:.0f} {token.symbol} @ ${price:.10f} ({TRADE_AMOUNT_SOL} SOL)")

    async def _hb(self):
        while True:
            await asyncio.sleep(120)
            log.info(f"💓 {self.detector.count} tokens | {self.exits.open_count} open | {(time.time()-self.start)/60:.0f}m")

if __name__ == "__main__":
    try: asyncio.run(Bot().run())
    except KeyboardInterrupt: log.info("Stopped")
