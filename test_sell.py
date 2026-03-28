"""
SELL TEST — Buy 3 coins, wait 3 min each, sell. Max logs.
Purpose: Diagnose why Winston fails to sell.

Flow:
  For each of 3 test tokens:
    1. Buy $0.50 worth (~0.003 SOL)
    2. Wait 3 minutes
    3. Sell using REAL on-chain balance (not estimated)
    4. Log every single step in detail

Key fix vs current bot:
  - Uses getTokenAccountsByOwner to read ACTUAL wallet balance before selling
  - Logs the exact amount sent to Jupiter, response codes, full error bodies
  - Verifies token decimals from on-chain mint info (not assuming 6)
"""

import asyncio
import json
import time
import logging
import os
import base64 as b64
from datetime import datetime, timezone

import aiohttp

# ─── CONFIG ──────────────────────────────────────────────────────────────────

SOLANA_RPC_URL   = os.getenv("SOLANA_RPC_URL", "")
WALLET_PRIVATE_KEY = os.getenv("WALLET_PRIVATE_KEY", "")
JUPITER_API_KEY  = os.getenv("JUPITER_API_KEY", "")
DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "")

BUY_SOL = 0.003          # ~$0.50 at ~$160/SOL — adjust if SOL price differs
WAIT_SECS = 180          # 3 minutes
SLIPPAGE_BPS = 1000      # 10% slippage — generous for memecoins
WSOL = "So11111111111111111111111111111111111111112"

JUP_ORDER   = "https://api.jup.ag/swap/v2/order"
JUP_EXECUTE = "https://api.jup.ag/swap/v2/execute"
JUP_PRICE   = "https://api.jup.ag/price/v2"

# ─── 3 TEST TOKENS ───────────────────────────────────────────────────────────
# These are well-known Pump.fun tokens with established liquidity.
# Winston will pick whichever have active Jupiter routes at runtime.
# If a buy fails (no route), we skip and try the next.
TEST_TOKENS = [
    {"mint": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "symbol": "BONK"},
    {"mint": "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", "symbol": "POPCAT"},
    {"mint": "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5", "symbol": "MEW"},
]

# ─── LOGGING ─────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s │ %(levelname)-8s │ %(message)s",
    datefmt="%H:%M:%S"
)
log = logging.getLogger("sell_test")

def separator(label=""):
    log.info("=" * 60 + (f" {label}" if label else ""))

# ─── HELPERS ─────────────────────────────────────────────────────────────────

def get_jup_headers():
    h = {"Content-Type": "application/json"}
    if JUPITER_API_KEY:
        h["x-api-key"] = JUPITER_API_KEY
    return h

async def rpc(sess, method, params):
    """Generic RPC call with full error logging."""
    payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    log.debug(f"RPC → {method}({str(params)[:80]})")
    try:
        async with sess.post(
            SOLANA_RPC_URL, json=payload,
            timeout=aiohttp.ClientTimeout(total=15)
        ) as r:
            text = await r.text()
            log.debug(f"RPC ← {method} HTTP {r.status} | {text[:200]}")
            if r.status == 200:
                return json.loads(text)
            else:
                log.error(f"RPC {method} bad status {r.status}: {text[:300]}")
                return {}
    except Exception as e:
        log.error(f"RPC {method} exception: {e}")
        return {}

# ─── WALLET ──────────────────────────────────────────────────────────────────

def load_keypair():
    if not WALLET_PRIVATE_KEY:
        log.error("WALLET_PRIVATE_KEY not set!")
        return None, None
    try:
        from solders.keypair import Keypair
        import base58
        kp = Keypair.from_bytes(base58.b58decode(WALLET_PRIVATE_KEY))
        pub = str(kp.pubkey())
        log.info(f"Wallet loaded: {pub[:12]}...{pub[-6:]}")
        return kp, pub
    except Exception as e:
        log.error(f"Keypair load failed: {e}")
        return None, None

def sign_tx(keypair, tx_b64):
    """Sign a base64-encoded versioned transaction."""
    log.debug(f"Signing tx (b64 len={len(tx_b64)})")
    try:
        from solders.transaction import VersionedTransaction
        raw = b64.b64decode(tx_b64)
        log.debug(f"Raw tx bytes: {len(raw)}")
        txn = VersionedTransaction.from_bytes(raw)
        signed = VersionedTransaction(txn.message, [keypair])
        result = b64.b64encode(bytes(signed)).decode()
        log.debug(f"Signed tx b64 len={len(result)}")
        return result
    except Exception as e:
        log.error(f"Sign failed: {e}")
        import traceback; traceback.print_exc()
        return None

# ─── BALANCE CHECK ───────────────────────────────────────────────────────────

async def get_sol_balance(sess, pubkey):
    d = await rpc(sess, "getBalance", [pubkey])
    bal = d.get("result", {}).get("value", 0) / 1e9
    log.info(f"SOL balance: {bal:.6f} SOL")
    return bal

async def get_token_balance(sess, pubkey, mint):
    """
    Fetch actual on-chain token balance from the wallet.
    Returns (ui_amount, raw_amount, decimals) or (0, 0, 6) if not found.
    
    This is the KEY fix — the bot currently estimates from outAmount.
    We need the REAL balance to sell the right amount.
    """
    log.info(f"Fetching token balance for mint {mint[:20]}...")
    d = await rpc(sess, "getTokenAccountsByOwner", [
        pubkey,
        {"mint": mint},
        {"encoding": "jsonParsed"}
    ])
    
    accounts = d.get("result", {}).get("value", [])
    log.debug(f"Token accounts found: {len(accounts)}")
    
    if not accounts:
        log.warning(f"No token accounts found for mint {mint[:20]} in wallet {pubkey[:12]}")
        return 0, 0, 6
    
    for acct in accounts:
        info = acct.get("account", {}).get("data", {}).get("parsed", {}).get("info", {})
        token_amount = info.get("tokenAmount", {})
        ui_amount = float(token_amount.get("uiAmount", 0) or 0)
        raw_amount = int(token_amount.get("amount", 0))
        decimals = int(token_amount.get("decimals", 6))
        log.info(f"Token account: {acct.get('pubkey','?')[:20]}")
        log.info(f"  uiAmount={ui_amount}, raw={raw_amount}, decimals={decimals}")
        if raw_amount > 0:
            return ui_amount, raw_amount, decimals
    
    log.warning(f"All token accounts have 0 balance for {mint[:20]}")
    return 0, 0, 6

async def get_token_decimals(sess, mint):
    """Get token decimals from on-chain mint info."""
    d = await rpc(sess, "getAccountInfo", [mint, {"encoding": "jsonParsed"}])
    info = d.get("result", {}).get("value", {})
    if info:
        parsed = info.get("data", {}).get("parsed", {}).get("info", {})
        decimals = parsed.get("decimals", 6)
        log.info(f"Mint {mint[:20]} decimals: {decimals}")
        return decimals
    log.warning(f"Could not fetch decimals for {mint[:20]}, assuming 6")
    return 6

# ─── JUPITER ─────────────────────────────────────────────────────────────────

async def jup_order(sess, input_mint, output_mint, amount, taker):
    """
    Get a Jupiter swap order. Logs full request + response.
    amount: in smallest units (lamports for SOL, raw for tokens)
    """
    params = {
        "inputMint": input_mint,
        "outputMint": output_mint,
        "amount": str(amount),
        "taker": taker,
        "slippageBps": str(SLIPPAGE_BPS),
    }
    log.info(f"Jupiter order request:")
    log.info(f"  inputMint:  {input_mint}")
    log.info(f"  outputMint: {output_mint}")
    log.info(f"  amount:     {amount}")
    log.info(f"  taker:      {taker[:20]}...")
    log.info(f"  slippage:   {SLIPPAGE_BPS} bps")
    
    try:
        async with sess.get(
            JUP_ORDER, params=params,
            headers=get_jup_headers(),
            timeout=aiohttp.ClientTimeout(total=20)
        ) as r:
            body = await r.text()
            log.info(f"Jupiter order response: HTTP {r.status}")
            log.debug(f"Jupiter order body: {body[:500]}")
            
            if r.status != 200:
                log.error(f"Jupiter order FAILED HTTP {r.status}: {body[:400]}")
                return None
            
            data = json.loads(body)
            
            # Log key fields
            log.info(f"  requestId:   {data.get('requestId','MISSING')}")
            log.info(f"  outAmount:   {data.get('outAmount', 'MISSING')}")
            log.info(f"  inAmount:    {data.get('inAmount', 'MISSING')}")
            log.info(f"  priceImpact: {data.get('priceImpactPct', 'N/A')}")
            has_tx = bool(data.get("transaction"))
            log.info(f"  transaction: {'✅ present' if has_tx else '❌ MISSING'}")
            
            if not has_tx:
                log.error(f"Jupiter returned no transaction! Full body: {body[:600]}")
                return None
            
            return data
    except Exception as e:
        log.error(f"Jupiter order exception: {e}")
        import traceback; traceback.print_exc()
        return None

async def jup_execute(sess, request_id, signed_b64):
    """Execute a signed Jupiter transaction. Full response logging."""
    log.info(f"Executing Jupiter swap (requestId={request_id})")
    payload = {"signedTransaction": signed_b64, "requestId": request_id}
    
    try:
        async with sess.post(
            JUP_EXECUTE,
            json=payload,
            headers=get_jup_headers(),
            timeout=aiohttp.ClientTimeout(total=45)
        ) as r:
            body = await r.text()
            log.info(f"Jupiter execute response: HTTP {r.status}")
            log.info(f"Jupiter execute body: {body[:600]}")
            
            if r.status != 200:
                log.error(f"Jupiter execute FAILED HTTP {r.status}: {body[:500]}")
                return None
            
            data = json.loads(body)
            status = data.get("status", "UNKNOWN")
            sig = data.get("signature", "none")
            error = data.get("error", None)
            
            log.info(f"  status:    {status}")
            log.info(f"  signature: {sig[:40] if sig else 'NONE'}")
            if error:
                log.error(f"  error:     {error}")
            
            return data
    except Exception as e:
        log.error(f"Jupiter execute exception: {e}")
        import traceback; traceback.print_exc()
        return None

# ─── BUY ─────────────────────────────────────────────────────────────────────

async def buy_token(keypair, pubkey, mint, symbol):
    separator(f"BUY {symbol}")
    lamports = int(BUY_SOL * 1e9)
    log.info(f"Buying {BUY_SOL} SOL worth of {symbol} ({mint[:20]}...)")
    log.info(f"Amount in lamports: {lamports}")
    
    async with aiohttp.ClientSession() as sess:
        # Pre-buy SOL balance
        sol_before = await get_sol_balance(sess, pubkey)
        
        # Get Jupiter order
        order = await jup_order(sess, WSOL, mint, lamports, pubkey)
        if not order:
            log.error(f"BUY FAILED — no Jupiter order for {symbol}")
            return None
        
        tx_b64 = order.get("transaction", "")
        req_id = order.get("requestId", "")
        out_amount = int(order.get("outAmount", "0"))
        
        # Sign
        signed = sign_tx(keypair, tx_b64)
        if not signed:
            log.error(f"BUY FAILED — signing failed for {symbol}")
            return None
        
        # Execute
        result = await jup_execute(sess, req_id, signed)
        if not result:
            log.error(f"BUY FAILED — execute returned nothing for {symbol}")
            return None
        
        if result.get("status") == "Failed":
            log.error(f"BUY FAILED — swap status=Failed for {symbol}: {result.get('error')}")
            return None
        
        sig = result.get("signature", "?")
        log.info(f"✅ BUY SUCCESS: {symbol}")
        log.info(f"   TX: https://solscan.io/tx/{sig}")
        log.info(f"   Estimated tokens out: {out_amount}")
        
        # Wait 5s for chain confirmation then check real balance
        log.info("Waiting 5s for on-chain confirmation...")
        await asyncio.sleep(5)
        
        decimals = await get_token_decimals(sess, mint)
        ui_amt, raw_amt, dec = await get_token_balance(sess, pubkey, mint)
        sol_after = await get_sol_balance(sess, pubkey)
        
        gas = max(0, (sol_before - sol_after) - BUY_SOL)
        log.info(f"   Real token balance: {ui_amt} ({raw_amt} raw, {dec} decimals)")
        log.info(f"   Gas paid: {gas:.6f} SOL")
        
        if raw_amt == 0:
            log.warning(f"⚠️ No token balance found on-chain after buy! Will retry sell anyway.")
        
        return {
            "mint": mint,
            "symbol": symbol,
            "raw_balance": raw_amt,
            "ui_balance": ui_amt,
            "decimals": dec,
            "entry_sol": BUY_SOL,
            "buy_sig": sig,
        }

# ─── SELL ─────────────────────────────────────────────────────────────────────

async def sell_token(keypair, pubkey, position):
    mint = position["mint"]
    symbol = position["symbol"]
    separator(f"SELL {symbol}")
    
    async with aiohttp.ClientSession() as sess:
        # Always fetch REAL on-chain balance before selling
        log.info(f"Fetching real on-chain balance before sell...")
        ui_amt, raw_amt, decimals = await get_token_balance(sess, pubkey, mint)
        
        log.info(f"On-chain balance: {ui_amt} tokens ({raw_amt} raw, {decimals} decimals)")
        
        if raw_amt == 0:
            log.error(f"SELL ABORTED — zero balance for {symbol} in wallet")
            log.error(f"This means either the buy didn't land or the wrong mint is being used")
            log.error(f"Mint: {mint}")
            log.error(f"Wallet: {pubkey}")
            return False
        
        # Use actual on-chain amount, not estimated
        amount_to_sell = raw_amt
        log.info(f"Selling {amount_to_sell} raw units ({ui_amt} {symbol})")
        
        # Get sell order
        order = await jup_order(sess, mint, WSOL, amount_to_sell, pubkey)
        
        if not order:
            log.error(f"SELL FAILED — Jupiter returned no order for {symbol}")
            log.error(f"  This usually means no liquidity route for {mint[:20]}")
            
            # Try with a reduced amount (90% in case of rounding)
            reduced = int(amount_to_sell * 0.9)
            log.info(f"Retrying with 90% amount: {reduced} raw units")
            order = await jup_order(sess, mint, WSOL, reduced, pubkey)
            
            if not order:
                log.error(f"SELL FAILED — retry also failed. Token may be illiquid or rugged.")
                return False
        
        tx_b64 = order.get("transaction", "")
        req_id = order.get("requestId", "")
        
        # Sign
        signed = sign_tx(keypair, tx_b64)
        if not signed:
            log.error(f"SELL FAILED — signing failed for {symbol}")
            return False
        
        # Execute
        result = await jup_execute(sess, req_id, signed)
        if not result:
            log.error(f"SELL FAILED — execute returned nothing for {symbol}")
            return False
        
        if result.get("status") == "Failed":
            error = result.get("error", "unknown")
            log.error(f"SELL FAILED — swap status=Failed for {symbol}")
            log.error(f"  Error: {error}")
            log.error(f"  Full result: {json.dumps(result)}")
            return False
        
        sig = result.get("signature", "?")
        log.info(f"✅ SELL SUCCESS: {symbol}")
        log.info(f"   TX: https://solscan.io/tx/{sig}")
        
        # Final SOL balance
        await asyncio.sleep(3)
        final_bal = await get_sol_balance(sess, pubkey)
        log.info(f"SOL balance after sell: {final_bal:.6f}")
        
        # Discord notify
        await discord_notify(f"✅ **SELL SUCCESS** — {symbol}\n"
                             f"TX: https://solscan.io/tx/{sig}\n"
                             f"Wallet SOL: {final_bal:.4f}")
        return True

# ─── DISCORD ─────────────────────────────────────────────────────────────────

async def discord_notify(msg):
    if not DISCORD_WEBHOOK_URL:
        return
    try:
        async with aiohttp.ClientSession() as s:
            await s.post(DISCORD_WEBHOOK_URL, json={"content": msg})
    except:
        pass

# ─── MAIN ─────────────────────────────────────────────────────────────────────

async def main():
    separator("SELL TEST — WINSTON DIAGNOSTIC")
    log.info(f"Started at {datetime.now(timezone.utc).isoformat()}")
    log.info(f"RPC: {SOLANA_RPC_URL[:40]}...")
    log.info(f"Jupiter API key: {'SET ✅' if JUPITER_API_KEY else 'NOT SET ❌'}")
    log.info(f"Buy amount per coin: {BUY_SOL} SOL (~$0.50)")
    log.info(f"Hold time: {WAIT_SECS}s (3 min)")
    log.info(f"Slippage: {SLIPPAGE_BPS} bps")
    
    keypair, pubkey = load_keypair()
    if not keypair:
        log.error("Cannot proceed without valid keypair. Exiting.")
        return
    
    if not SOLANA_RPC_URL:
        log.error("SOLANA_RPC_URL not set. Exiting.")
        return
    
    # Check starting balance
    async with aiohttp.ClientSession() as sess:
        start_bal = await get_sol_balance(sess, pubkey)
    
    needed = BUY_SOL * len(TEST_TOKENS) + 0.02  # buys + gas
    if start_bal < needed:
        log.error(f"Insufficient SOL: {start_bal:.4f} (need ~{needed:.4f})")
        log.error("Please deposit $25 and try again.")
        return
    
    log.info(f"Starting balance: {start_bal:.4f} SOL ✅")
    separator()
    
    results = []
    
    for i, token_info in enumerate(TEST_TOKENS):
        mint = token_info["mint"]
        symbol = token_info["symbol"]
        separator(f"ROUND {i+1}/3 — {symbol}")
        
        # BUY
        position = await buy_token(keypair, pubkey, mint, symbol)
        
        if not position:
            log.error(f"Skipping {symbol} — buy failed")
            results.append({"symbol": symbol, "buy": False, "sell": None})
            await discord_notify(f"❌ **BUY FAILED** — {symbol} (skipping)")
            continue
        
        await discord_notify(f"💰 **BOUGHT** — {symbol}\n"
                             f"Amount: {BUY_SOL} SOL\n"
                             f"Tokens: {position['ui_balance']:.2f}\n"
                             f"TX: https://solscan.io/tx/{position['buy_sig']}")
        
        # WAIT 3 MINUTES
        log.info(f"⏳ Holding for {WAIT_SECS}s ({WAIT_SECS//60}min)...")
        for remaining in range(WAIT_SECS, 0, -30):
            log.info(f"   ...{remaining}s remaining")
            await asyncio.sleep(min(30, remaining))
        
        # SELL
        sell_ok = await sell_token(keypair, pubkey, position)
        results.append({"symbol": symbol, "buy": True, "sell": sell_ok})
        
        # Small pause before next round
        if i < len(TEST_TOKENS) - 1:
            log.info("Pausing 10s before next coin...")
            await asyncio.sleep(10)
    
    # ─── SUMMARY ───────────────────────────────────────────────────────────
    separator("FINAL SUMMARY")
    for r in results:
        buy_str  = "✅" if r["buy"] else "❌"
        sell_str = "✅" if r["sell"] else ("❌" if r["sell"] is False else "⏭️ skipped")
        log.info(f"  {r['symbol']:10s}  buy={buy_str}  sell={sell_str}")
    
    async with aiohttp.ClientSession() as sess:
        final_bal = await get_sol_balance(sess, pubkey)
    log.info(f"Final SOL balance: {final_bal:.6f}")
    log.info(f"Started with:      {start_bal:.6f}")
    log.info(f"Net change:        {final_bal - start_bal:+.6f} SOL")
    separator("DONE")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Stopped by user")
