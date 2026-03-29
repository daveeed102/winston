"""
DEGEN SNIPER v8 — Grok-Powered Hourly Coin Picker
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Two modes working together:

  GROK MODE (every hour):
    - Asks Grok to analyze Twitter buzz, trending Solana tokens,
      momentum, volume, and social sentiment
    - Grok picks ONE coin it thinks will pump in the next hour
    - Bot buys that coin and holds with split exit ladder
    - Grok ALWAYS picks — it never skips

  GRADUATION SNIPER (continuous):
    - Simultaneously watches for Pump.fun graduations
    - Buys graduations that pass filters when not in a Grok position
    - Fast entry via log scan (instant mint extraction)

Exit logic (both modes):
  - Sell 50% at PROFIT_TARGET_1 (1.4x), lock profit, trail rest
  - Sell remainder at PROFIT_TARGET_2 (2.0x)
  - Trailing stop (35%) with 3-reading confirmation
  - Dead coin detection (3 identical prices = bail)
  - Hard timeout (5 min for graduation, 60 min for Grok picks)
"""

import asyncio
import json
import time
import logging
import os
import base64 as b64
from dataclasses import dataclass
from typing import Optional

import aiohttp

# ─── CONFIG ──────────────────────────────────────────────────────────────────

TRADE_AMOUNT_SOL   = float(os.getenv("TRADE_AMOUNT_SOL",   "0.0625"))
TRAILING_STOP_PCT  = float(os.getenv("TRAILING_STOP_PCT",  "35"))
MAX_HOLD_MINUTES   = float(os.getenv("MAX_HOLD_MINUTES",   "5"))       # graduation holds
GROK_HOLD_MINUTES  = float(os.getenv("GROK_HOLD_MINUTES",  "60"))     # grok picks get longer
SLIPPAGE_BPS       = int(os.getenv("SLIPPAGE_BPS",         "1000"))
PROFIT_TARGET_1    = float(os.getenv("PROFIT_TARGET_1",    "1.4"))
PROFIT_TARGET_2    = float(os.getenv("PROFIT_TARGET_2",    "2.0"))
MAX_TOP_HOLDER_PCT = float(os.getenv("MAX_TOP_HOLDER_PCT", "35"))
DEAD_COIN_STRIKES  = int(os.getenv("DEAD_COIN_STRIKES",    "3"))
STOP_CONFIRM_COUNT = int(os.getenv("STOP_CONFIRM_COUNT",   "3"))
GROK_INTERVAL_MINS = float(os.getenv("GROK_INTERVAL_MINS", "60"))     # how often Grok picks

DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "")
SOLANA_RPC_URL      = os.getenv("SOLANA_RPC_URL",      "")
WALLET_PRIVATE_KEY  = os.getenv("WALLET_PRIVATE_KEY",  "")
JUPITER_API_KEY     = os.getenv("JUPITER_API_KEY",     "")
GROK_API_KEY        = os.getenv("GROK_API_KEY",        "")

PUMPFUN     = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
RAYDIUM_AMM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
WSOL        = "So11111111111111111111111111111111111111112"

JUP_ORDER   = "https://api.jup.ag/swap/v2/order"
JUP_EXECUTE = "https://api.jup.ag/swap/v2/execute"
JUP_PRICE   = "https://api.jup.ag/price/v2"
GROK_URL    = "https://api.x.ai/v1/chat/completions"

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
    source: str = ""  # "pumpfun", "raydium", "grok"

@dataclass
class Position:
    token: Token
    entry_price: float   = 0.0
    tokens_held: float   = 0.0
    original_tokens: float = 0.0
    cost_sol: float      = 0.0
    high_price: float    = 0.0
    stop_price: float    = 0.0
    opened_ts: float     = 0.0
    took_first: bool     = False
    hold_limit_mins: float = 5.0
    _last_price: float   = 0.0
    _same_count: int     = 0
    _below_stop: int     = 0

    def __post_init__(self):
        if not self.opened_ts:        self.opened_ts = time.time()
        if not self.original_tokens:  self.original_tokens = self.tokens_held

    @property
    def hold_secs(self): return time.time() - self.opened_ts
    @property
    def hold_mins(self):  return self.hold_secs / 60
    @property
    def timed_out(self):  return self.hold_secs >= self.hold_limit_mins * 60

# ─── GROK ────────────────────────────────────────────────────────────────────

class Grok:
    """
    Asks Grok-3 to pick one Solana token it believes will pump
    in the next hour based on Twitter buzz, trending coins, volume,
    and momentum. Always returns a mint address — never skips.
    """

    async def pick_coin(self) -> Optional[dict]:
        if not GROK_API_KEY:
            log.warning("GROK_API_KEY not set — skipping Grok pick")
            return None

        prompt = """You are an aggressive Solana memecoin trader with access to real-time Twitter/X data and crypto market feeds.

Your job: Pick ONE Solana token you believe will pump in the next 60 minutes.

Consider:
- Trending tokens on Twitter/X right now (high tweet volume, influencer mentions, viral memes)
- Pump.fun tokens that recently graduated to Raydium (fresh liquidity, early momentum)
- Tokens with sudden volume spikes on DEX screener / Birdeye
- Solana ecosystem narratives that are hot right now (AI agents, memecoins, gaming)
- Recent listings on major trackers (Dexscreener trending, Birdeye trending)
- Avoid tokens that already pumped 5x+ today (chasing) 
- Prefer tokens under $5M market cap with fresh momentum

You MUST respond with ONLY a JSON object, no other text:
{
  "mint": "<solana_token_mint_address>",
  "symbol": "<token_symbol>",
  "name": "<token_name>",
  "reason": "<2 sentence explanation of why this will pump in the next hour>",
  "confidence": "<high/medium>",
  "market_cap_estimate": "<estimated mcap like $500K or $2M>"
}

Pick a real token with a real Solana mint address. Be aggressive. We want gains."""

        try:
            async with aiohttp.ClientSession() as sess:
                async with sess.post(
                    GROK_URL,
                    headers={"Authorization": f"Bearer {GROK_API_KEY}",
                             "Content-Type": "application/json"},
                    json={"model": "grok-3",
                          "messages": [{"role": "user", "content": prompt}],
                          "max_tokens": 300,
                          "temperature": 0.7},
                    timeout=aiohttp.ClientTimeout(total=30)
                ) as r:
                    if r.status != 200:
                        log.error(f"Grok API {r.status}: {(await r.text())[:200]}")
                        return None
                    data = await r.json()

            raw = data["choices"][0]["message"]["content"].strip()
            log.info(f"Grok raw response: {raw[:300]}")

            # Strip markdown fences if present
            if "```" in raw:
                raw = raw.split("```")[1]
                if raw.startswith("json"): raw = raw[4:]
            raw = raw.strip()

            pick = json.loads(raw)
            mint   = pick.get("mint","").strip()
            symbol = pick.get("symbol","???")
            name   = pick.get("name","Unknown")
            reason = pick.get("reason","")
            conf   = pick.get("confidence","medium")
            mcap   = pick.get("market_cap_estimate","?")

            if not mint or len(mint) < 32:
                log.error(f"Grok returned invalid mint: {mint}")
                return None

            log.info(f"Grok picked: {symbol} ({mint[:20]}...)")
            log.info(f"  Reason: {reason}")
            log.info(f"  Confidence: {conf} | Est. mcap: {mcap}")

            return {"mint": mint, "symbol": symbol, "name": name,
                    "reason": reason, "confidence": conf, "mcap": mcap}

        except json.JSONDecodeError as e:
            log.error(f"Grok JSON parse error: {e} | raw: {raw[:200]}")
        except Exception as e:
            log.error(f"Grok pick error: {e}")
        return None

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

    async def price(self, mint) -> Optional[float]:
        s = await self._sess()
        try:
            async with s.get(f"{JUP_PRICE}?ids={mint}",
                             timeout=aiohttp.ClientTimeout(total=4)) as r:
                if r.status == 200:
                    d = await r.json()
                    p = d.get("data",{}).get(mint,{}).get("price")
                    if p: return float(p)
        except: pass
        finally: await s.close()
        # Quote fallback
        s2 = await self._sess()
        try:
            async with s2.get(JUP_ORDER,
                params={"inputMint": mint, "outputMint": WSOL,
                        "amount": str(int(100_000 * 1e6))},
                timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    d = await r.json()
                    out = int(d.get("outAmount","0")) / 1e9
                    if out > 0: return out / 100_000
        except: pass
        finally: await s2.close()
        return None

    async def sol_usd(self) -> float:
        s = await self._sess()
        try:
            async with s.get(f"{JUP_PRICE}?ids={WSOL}",
                             timeout=aiohttp.ClientTimeout(total=5)) as r:
                if r.status == 200:
                    d = await r.json()
                    p = d.get("data",{}).get(WSOL,{}).get("price")
                    if p: return float(p)
        except: pass
        finally: await s.close()
        return 160.0

    async def order(self, inp, out, amount, taker):
        s = await self._sess()
        try:
            async with s.get(JUP_ORDER,
                params={"inputMint": inp, "outputMint": out,
                        "amount": str(amount), "taker": taker,
                        "slippageBps": str(SLIPPAGE_BPS)},
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

    async def balance(self, sess=None):
        if not self.pubkey: return 0.0
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(self.rpc,
                    json={"jsonrpc":"2.0","id":1,"method":"getBalance",
                          "params":[self.pubkey]},
                    timeout=aiohttp.ClientTimeout(total=10)) as r:
                    d = await r.json()
                    return d.get("result",{}).get("value",0)/1e9
        except: return 0.0

    async def token_balance(self, mint):
        if not self.pubkey: return 0, 6
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(self.rpc,
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
                    if raw > 0: return raw, dec
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
    def __init__(self, url): self.url = url

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

    async def grok_pick(self, pick: dict, sol_usd: float, trade_sol: float):
        spent_usd = trade_sol * sol_usd
        await self.send({"embeds": [{
            "title": f"🤖 GROK PICK — {pick['symbol']}",
            "color": 0xAA00FF,
            "description": (
                f"Buying **${spent_usd:.2f}** worth\n"
                f"📊 {pick['reason']}\n"
                f"💎 Confidence: **{pick['confidence']}** | "
                f"Est. MCap: {pick['mcap']}"
            ),
            "fields": [
                {"name":"Mint", "value":f"`{pick['mint'][:20]}...`","inline":False},
                {"name":"Chart","value":f"[Solscan](https://solscan.io/token/{pick['mint']})","inline":True},
                {"name":"Dex","value":f"[Dexscreener](https://dexscreener.com/solana/{pick['mint']})","inline":True},
            ]
        }]})

    async def bought(self, p: Position, sol_usd: float):
        spent_usd = p.cost_sol * sol_usd
        label     = self._label(p)
        source_emoji = "🤖" if p.token.source == "grok" else "🎓"
        t1_usd = spent_usd * PROFIT_TARGET_1
        t2_usd = spent_usd * PROFIT_TARGET_2
        await self.send({"embeds": [{
            "title": f"{source_emoji} BOUGHT — {label}",
            "color": 0x00AAFF,
            "description": (
                f"Spent **${spent_usd:.2f}** ({p.cost_sol:.4f} SOL)\n"
                f"Sell 50% at **${t1_usd:.2f}** | Rest at **${t2_usd:.2f}**"
            ),
            "fields": [
                {"name":"Stop","value":f"{TRAILING_STOP_PCT}% trail","inline":True},
                {"name":"Timeout","value":f"{p.hold_limit_mins:.0f}min","inline":True},
                {"name":"Chart","value":f"[Solscan](https://solscan.io/token/{p.token.mint})","inline":True},
            ]
        }]})

    async def sold(self, p: Position, reason: str, gain_x: float,
                   pnl_sol: float, pct: int, sol_usd: float):
        spent_usd = p.cost_sol * sol_usd * (pct/100)
        pnl_usd   = pnl_sol * sol_usd
        sell_usd  = spent_usd + pnl_usd
        label     = self._label(p)
        is_profit = pnl_usd >= 0
        color     = 0x00FF88 if is_profit else 0xFF4444
        emoji     = "✅ PROFIT" if is_profit else "❌ LOSS"
        pnl_str   = f"+${pnl_usd:.2f}" if is_profit else f"-${abs(pnl_usd):.2f}"
        rmap = {"take_profit_1":"Sold 50% at 1.4x 🎯",
                "take_profit_2":"Sold rest at 2x 🚀",
                "trailing_stop":"Stop loss 🛑",
                "timeout":f"Timeout ⏰",
                "dead_coin":"Dead coin 💀",
                "price_dead":"No price feed 📡"}
        await self.send({"embeds": [{
            "title": f"{emoji} — {label} ({pct}% sold)",
            "color": color,
            "description": (
                f"Bought **${spent_usd:.2f}** → Sold **${sell_usd:.2f}**\n"
                f"**{pnl_str}** ({gain_x:.3f}x) in {p.hold_mins:.1f}min"
            ),
            "fields": [
                {"name":"Reason","value":rmap.get(reason,reason),"inline":True},
                {"name":"SOL P&L","value":f"{pnl_sol:+.5f} SOL","inline":True},
                {"name":"Chart","value":f"[Solscan](https://solscan.io/token/{p.token.mint})","inline":True},
            ]
        }]})

    async def alert(self, msg):
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
                # Strategy 1: log scan — instant
                mint = self._mint_from_logs(logs, source)
                if mint:
                    log.info(f"Mint instant (log scan): {mint[:20]}...")

                # Strategy 2: getTransaction fallback
                if not mint:
                    async with aiohttp.ClientSession() as sess:
                        for attempt in range(5):
                            mint = await self._extract_mint(sig, sess)
                            if mint:
                                log.info(f"Mint via getTransaction ({attempt+1}): {mint[:20]}...")
                                break
                            await asyncio.sleep(2)

                if not mint:
                    log.warning(f"No mint: {sig[:16]}")
                    self.locked = False
                    return

                if mint in self.seen:
                    self.locked = False
                    return
                self.seen.add(mint)
                self.count += 1

                token = Token(mint=mint, source=source)
                log.info(f"DETECTED -> {mint[:24]}...")
                if self.queue.empty():
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
            async with sess.post(self.sol.rpc,
                json={"jsonrpc":"2.0","id":1,"method":"getTransaction",
                      "params":[sig,{"encoding":"jsonParsed",
                                     "maxSupportedTransactionVersion":0}]},
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
        "FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe",
        "JUP6LkbZbjS1jKKwapdHNy74LZJfCznEFkigq4CRBXM",
        "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
        "AgenTMiC2hvxGebTsgmsD4HHhqxHnLHK4CrZPmCHjBa",
        "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
        "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP",
        "SSwpkEEPFs5Y8dCTx4BEDsGFszmK4FbTiTGMFGCNjnm",
        "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
        "Sysvar1nstructions1111111111111111111111111",
        "SysvarRent111111111111111111111111111111111",
        "SysvarC1ock11111111111111111111111111111111",
        "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    }
    _B58 = set("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")

    def _is_valid_mint(self, addr):
        if addr in self._KNOWN_PROGRAMS: return False
        if not all(c in self._B58 for c in addr): return False
        if len(addr) < 32 or len(addr) > 44: return False
        for c in self._B58:
            if c * 8 in addr: return False
        return True

    def _mint_from_logs(self, logs, source):
        import re
        if source == "pumpfun":
            for line in logs:
                for m in re.finditer(r'([1-9A-HJ-NP-Za-km-z]{32,44}pump)', line):
                    addr = m.group(1)
                    if self._is_valid_mint(addr): return addr
        for line in logs:
            for m in re.finditer(r'([1-9A-HJ-NP-Za-km-z]{43,44})', line):
                addr = m.group(1)
                if self._is_valid_mint(addr): return addr
        return None

# ─── BOT ─────────────────────────────────────────────────────────────────────

class Bot:
    def __init__(self):
        self.sol      = Solana(SOLANA_RPC_URL, WALLET_PRIVATE_KEY)
        self.jup      = Jupiter()
        self.grok     = Grok()
        self.discord  = Discord(DISCORD_WEBHOOK_URL)
        self.detector = Detector(self.sol)
        self.start    = time.time()
        self.trades_won  = 0
        self.trades_lost = 0
        self.total_pnl   = 0.0
        self.sol_usd     = 160.0
        self._grok_queue = asyncio.Queue()  # Grok picks go here

    async def run(self):
        log.info("=" * 55)
        log.info("  DEGEN SNIPER v8 — Grok + Graduation")
        log.info(f"  {TRADE_AMOUNT_SOL} SOL/trade")
        log.info(f"  Sell 50% @ {PROFIT_TARGET_1}x, rest @ {PROFIT_TARGET_2}x")
        log.info(f"  Graduation timeout: {MAX_HOLD_MINUTES}min | "
                 f"Grok timeout: {GROK_HOLD_MINUTES}min")
        log.info(f"  Grok picks every: {GROK_INTERVAL_MINS:.0f}min")
        log.info(f"  Grok API: {'SET' if GROK_API_KEY else 'NOT SET'}")
        log.info(f"  Jupiter: {'SET' if JUPITER_API_KEY else 'MISSING'}")
        log.info("=" * 55)

        self.sol_usd = await self.jup.sol_usd()
        bal = await self.sol.balance()
        log.info(f"Balance: {bal:.4f} SOL (${bal*self.sol_usd:.2f})")

        await self.discord.alert(
            f"🚀 **Winston v8 started** — Grok + Graduation Sniper\n"
            f"Balance: {bal:.4f} SOL (${bal*self.sol_usd:.2f})\n"
            f"Grok picks every {GROK_INTERVAL_MINS:.0f}min | "
            f"{'Grok ENABLED 🤖' if GROK_API_KEY else 'Grok DISABLED ⚠️'}"
        )

        await asyncio.gather(
            self.detector.listen(),
            self._trade_loop(),
            self._grok_loop(),
            self._heartbeat(),
        )

    # ── GROK LOOP ────────────────────────────────────────────────────────────

    async def _grok_loop(self):
        """Every GROK_INTERVAL_MINS, ask Grok to pick a coin."""
        if not GROK_API_KEY:
            log.info("Grok disabled — running graduation sniper only")
            return

        # First pick after 60 seconds (let bot warm up)
        await asyncio.sleep(60)

        while True:
            try:
                log.info("🤖 Asking Grok for coin pick...")
                pick = await self.grok.pick_coin()
                if pick:
                    self.sol_usd = await self.jup.sol_usd()
                    await self.discord.grok_pick(pick, self.sol_usd, TRADE_AMOUNT_SOL)
                    await self._grok_queue.put(pick)
                    log.info(f"Grok pick queued: {pick['symbol']}")
                else:
                    log.warning("Grok returned no pick this round")
            except Exception as e:
                log.error(f"Grok loop error: {e}")

            await asyncio.sleep(GROK_INTERVAL_MINS * 60)

    # ── TRADE LOOP ───────────────────────────────────────────────────────────

    async def _trade_loop(self):
        log.info("Trade loop ready")
        while True:
            # Check Grok queue first (higher priority than graduation)
            token = None
            is_grok = False

            if not self._grok_queue.empty() and not self.detector.locked:
                pick = await self._grok_queue.get()
                token = Token(mint=pick["mint"], symbol=pick["symbol"],
                              name=pick["name"], source="grok")
                is_grok = True
                log.info(f"Processing Grok pick: {token.symbol}")
            else:
                # Wait for graduation
                try:
                    token = await asyncio.wait_for(
                        self.detector.queue.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue

            if not token: continue

            self.detector.locked = True
            hold_mins = GROK_HOLD_MINUTES if is_grok else MAX_HOLD_MINUTES
            log.info(f"LOCKED IN on {token.mint[:20]}... "
                     f"({'Grok' if is_grok else 'Graduation'}, "
                     f"{hold_mins:.0f}min hold)")

            try:
                # Grok picks skip the holder/freeze filter (Grok already vetted it)
                # Graduation picks still run the filter
                if not is_grok:
                    passed = await self._filter(token)
                    if not passed:
                        log.info(f"SKIP {token.mint[:16]} — failed filters")
                        self.detector.locked = False
                        continue
                else:
                    # For Grok picks, just check liquidity exists
                    liq = await self.jup.order(WSOL, token.mint,
                                               int(0.005*1e9), self.sol.pubkey)
                    if not liq or not liq.get("outAmount"):
                        log.warning(f"Grok pick {token.symbol} has no liquidity — skipping")
                        self.detector.locked = False
                        continue
                    log.info(f"Grok pick {token.symbol} — liquidity confirmed, buying")

                pos = await self._buy(token, hold_mins)
                if not pos:
                    log.info(f"BUY FAILED {token.symbol}")
                    self.detector.locked = False
                    continue

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
                h_t = asyncio.create_task(
                    self._rpc(sess,"getTokenLargestAccounts",[token.mint]))
                a_t = asyncio.create_task(
                    self._rpc(sess,"getAccountInfo",
                              [token.mint,{"encoding":"jsonParsed"}]))
                l_t = asyncio.create_task(
                    self.jup.order(WSOL,token.mint,int(0.005*1e9),self.sol.pubkey))

                holders_res, acct_res, liq = await asyncio.gather(
                    h_t, a_t, l_t, return_exceptions=True)

                if isinstance(holders_res,Exception) or not holders_res:
                    log.info(f"SKIP {token.mint[:16]}: holder RPC failed"); return False
                holders = holders_res.get("result",{}).get("value",[])
                if len(holders) < 5:
                    log.info(f"SKIP {token.mint[:16]}: {len(holders)} holders"); return False

                supply_res = await self._rpc(sess,"getTokenSupply",[token.mint])
                total = float(supply_res.get("result",{}).get("value",{})
                                        .get("amount","0"))
                if total > 0 and holders:
                    top_pct = (float(holders[0].get("amount","0")) / total) * 100
                    if top_pct > MAX_TOP_HOLDER_PCT:
                        log.info(f"SKIP {token.mint[:16]}: top holder {top_pct:.0f}%")
                        return False

                if not isinstance(acct_res,Exception) and acct_res:
                    acct = acct_res.get("result",{}).get("value",{})
                    if acct:
                        parsed = (acct.get("data",{}).get("parsed",{})
                                      .get("info",{}))
                        if parsed.get("freezeAuthority"):
                            log.info(f"SKIP {token.mint[:16]}: freeze"); return False
                        if parsed.get("symbol"): token.symbol = parsed["symbol"]
                        if parsed.get("name"):   token.name   = parsed["name"]

                if isinstance(liq,Exception) or not liq or not liq.get("outAmount"):
                    log.info(f"SKIP {token.mint[:16]}: no liquidity"); return False

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
                log.info(f"PASS {label} ({token.mint[:16]}) — {len(holders)} holders")
                return True
            except Exception as e:
                log.warning(f"Filter: {e}"); return False

    # ── BUY ──────────────────────────────────────────────────────────────────

    async def _buy(self, token: Token, hold_mins: float) -> Optional[Position]:
        if not self.sol.pubkey: return None
        bal = await self.sol.balance()
        if bal < TRADE_AMOUNT_SOL + 0.005:
            log.error(f"Low balance: {bal:.4f}"); return None

        lamports = int(TRADE_AMOUNT_SOL * 1e9)
        order    = await self.jup.order(WSOL, token.mint, lamports, self.sol.pubkey)
        if not order: log.error("No buy route"); return None

        tx_b64 = order.get("transaction","")
        req_id = order.get("requestId","")
        out_amt = int(order.get("outAmount","0"))
        if not tx_b64 or not req_id: return None

        signed = self.sol.sign(tx_b64)
        if not signed: return None

        result = await self.jup.execute(req_id, signed)
        if not result: log.error("Execute failed"); return None
        if result.get("status") == "Failed":
            log.error(f"Buy failed: {result.get('error','?')}"); return None

        log.info(f"BUY TX: {result.get('signature','?')[:35]}...")
        await asyncio.sleep(2)

        price = await self.jup.price(token.mint)
        if not price:
            price = TRADE_AMOUNT_SOL / (out_amt/1e6) if out_amt > 0 else 0.0

        tokens = out_amt / 1e6
        self.sol_usd = await self.jup.sol_usd()

        pos = Position(
            token           = token,
            entry_price     = price,
            tokens_held     = tokens,
            original_tokens = tokens,
            cost_sol        = TRADE_AMOUNT_SOL,
            high_price      = price,
            stop_price      = price * (1 - TRAILING_STOP_PCT/100),
            hold_limit_mins = hold_mins,
        )
        await self.discord.bought(pos, self.sol_usd)
        log.info(f"BOUGHT {tokens:.0f} {token.symbol} @ ${price:.10f} "
                 f"[{token.source}] hold={hold_mins:.0f}min")
        log.info(f"  T1: ${price*PROFIT_TARGET_1:.10f} | "
                 f"T2: ${price*PROFIT_TARGET_2:.10f} | "
                 f"Stop: ${pos.stop_price:.10f}")
        return pos

    # ── WATCH ────────────────────────────────────────────────────────────────

    async def _watch(self, pos: Position):
        log.info(f"WATCHING {pos.token.symbol} — T1={PROFIT_TARGET_1}x "
                 f"T2={PROFIT_TARGET_2}x stop={TRAILING_STOP_PCT}% "
                 f"timeout={pos.hold_limit_mins:.0f}min")
        price_fails = 0

        while True:
            await asyncio.sleep(1)
            price = await self.jup.price(pos.token.mint)

            if not price:
                price_fails += 1
                if price_fails % 15 == 1:
                    log.warning(f"No price ({price_fails}x)")
                if price_fails >= 60:
                    log.error("Price dead — emergency sell")
                    await self._sell(pos, pos.entry_price, "price_dead", 100)
                    return
                continue

            price_fails = 0
            gain_x = price / pos.entry_price if pos.entry_price > 0 else 1.0

            # Dead coin detection
            if price == pos._last_price:
                pos._same_count += 1
                if pos._same_count >= DEAD_COIN_STRIKES:
                    log.warning(f"DEAD COIN — price stuck at ${price:.8f}")
                    await self._sell(pos, price, "dead_coin", 100)
                    return
            else:
                pos._same_count = 0
            pos._last_price = price

            log.info(f"  {pos.token.symbol:8s} ${price:.8f} ({gain_x:.3f}x) "
                     f"stop=${pos.stop_price:.8f} held={pos.hold_mins:.1f}m"
                     f"{' [HALF OUT]' if pos.took_first else ''}")

            # Timeout
            if pos.timed_out:
                log.warning(f"TIMEOUT {pos.hold_mins:.1f}min ({gain_x:.2f}x)")
                await self._sell(pos, price, "timeout", 100)
                return

            # T1: sell 50% at 1.4x
            if gain_x >= PROFIT_TARGET_1 and not pos.took_first:
                pos.took_first = True
                log.info(f"T1 HIT {gain_x:.3f}x — selling 50%!")
                await self._sell(pos, price, "take_profit_1", 50)
                pos.stop_price = max(pos.stop_price, pos.entry_price * 0.99)
                log.info(f"Stop moved to entry: ${pos.stop_price:.10f}")
                continue

            # T2: sell rest at 2x
            if gain_x >= PROFIT_TARGET_2 and pos.took_first:
                log.info(f"T2 HIT {gain_x:.3f}x — selling rest!")
                await self._sell(pos, price, "take_profit_2", 100)
                return

            # Trailing stop update
            if price > pos.high_price:
                pos.high_price = price
                trail = TRAILING_STOP_PCT / 2 if pos.took_first else TRAILING_STOP_PCT
                pos.stop_price = price * (1 - trail/100)
                log.info(f"  NEW HIGH ${price:.8f} -> stop ${pos.stop_price:.8f}")
                pos._below_stop = 0

            # Stop with confirmation
            if pos.stop_price > 0 and price <= pos.stop_price:
                pos._below_stop += 1
                log.warning(f"Below stop {pos._below_stop}/{STOP_CONFIRM_COUNT}: "
                             f"${price:.8f} ({gain_x:.3f}x)")
                if pos._below_stop >= STOP_CONFIRM_COUNT:
                    log.warning("STOP CONFIRMED — selling")
                    await self._sell(pos, price, "trailing_stop", 100)
                    return
            else:
                pos._below_stop = 0

    # ── SELL ─────────────────────────────────────────────────────────────────

    async def _sell(self, pos: Position, price: float, reason: str, pct: int):
        gain_x   = price / pos.entry_price if pos.entry_price > 0 else 1.0
        est_sold = pos.tokens_held * (pct/100)
        pnl_sol  = (price * est_sold) - (pos.cost_sol * pct/100)

        log.info(f"SELL {pct}% {pos.token.symbol} — {reason} "
                 f"({gain_x:.3f}x, {pnl_sol:+.5f} SOL)")

        raw_amount, decimals = await self.sol.token_balance(pos.token.mint)
        if raw_amount <= 0:
            raw_amount = int(est_sold * (10**6))
            log.warning(f"Using estimated balance: {raw_amount}")

        if pct < 100:
            raw_amount = int(raw_amount * (pct/100))

        if raw_amount <= 0:
            log.error("Sell amount 0"); return

        sell_succeeded = False
        for attempt in range(1, 6):
            order = await self.jup.order(pos.token.mint, WSOL,
                                         raw_amount, self.sol.pubkey)
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
                            log.info(f"SELL TX: {result.get('signature','?')[:35]}...")
                            sell_succeeded = True
                            break
            else:
                log.warning(f"No sell route {attempt}/5")

            if not sell_succeeded and attempt < 5:
                await asyncio.sleep(min(attempt*2, 6))

        if not sell_succeeded:
            log.error(f"SELL FAILED after 5 attempts — {pos.token.symbol}"); return

        pos.tokens_held -= est_sold
        if pnl_sol >= 0: self.trades_won  += 1
        else:             self.trades_lost += 1
        self.total_pnl += pnl_sol

        self.sol_usd = await self.jup.sol_usd()
        await self.discord.sold(pos, reason, gain_x, pnl_sol, pct, self.sol_usd)
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
            pnl_usd = self.total_pnl * self.sol_usd
            pnl_str = f"+${pnl_usd:.2f}" if pnl_usd >= 0 else f"-${abs(pnl_usd):.2f}"
            status  = "LOCKED IN" if self.detector.locked else "SCANNING"
            log.info(f"HEARTBEAT [{status}] | up {uptime:.0f}m | "
                     f"{self.detector.count} seen | "
                     f"{self.trades_won}W {self.trades_lost}L | "
                     f"net {self.total_pnl:+.5f} SOL ({pnl_str})")
            if int(uptime) % 30 < 1 and uptime > 1:
                bal = await self.sol.balance()
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
