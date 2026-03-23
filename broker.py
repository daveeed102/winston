"""
broker.py — Coinbase Advanced Trade API wrapper for Winston XRP

Handles:
  - Fetching candles (OHLCV) as pandas DataFrames
  - Getting real-time price via get_product
  - Placing market buy/sell orders
  - Account balance queries
"""

import pandas as pd
import uuid
from datetime import datetime, timezone, timedelta
from coinbase.rest import RESTClient

import config
from logger import log

# Initialize the Coinbase client
_client = RESTClient(
    api_key=config.COINBASE_API_KEY,
    api_secret=config.COINBASE_API_SECRET,
)


def get_candles(product_id: str = config.PRODUCT_ID,
                granularity: str = config.CANDLE_GRANULARITY,
                limit: int = config.CANDLE_LIMIT) -> pd.DataFrame:
    """
    Fetch OHLCV candles from Coinbase.
    Returns a pandas DataFrame with columns: open, high, low, close, volume
    """
    # Coinbase wants UNIX timestamps as strings
    now   = datetime.now(timezone.utc)

    # Calculate how far back we need to go based on granularity
    granularity_seconds = {
        "ONE_MINUTE": 60,
        "FIVE_MINUTE": 300,
        "FIFTEEN_MINUTE": 900,
        "THIRTY_MINUTE": 1800,
        "ONE_HOUR": 3600,
        "TWO_HOUR": 7200,
        "SIX_HOUR": 21600,
        "ONE_DAY": 86400,
    }
    secs = granularity_seconds.get(granularity, 300)
    start = now - timedelta(seconds=secs * limit)

    start_str = str(int(start.timestamp()))
    end_str   = str(int(now.timestamp()))

    candles_resp = _client.get_candles(
        product_id=product_id,
        start=start_str,
        end=end_str,
        granularity=granularity,
    )

    # SDK returns BaseResponse objects — convert to dict for reliable access
    data = candles_resp.to_dict() if hasattr(candles_resp, 'to_dict') else candles_resp
    candles = data.get("candles", []) if isinstance(data, dict) else []

    rows = []
    for c in candles:
        if isinstance(c, dict):
            rows.append({
                "timestamp": int(c.get("start", 0)),
                "open":   float(c.get("open", 0)),
                "high":   float(c.get("high", 0)),
                "low":    float(c.get("low", 0)),
                "close":  float(c.get("close", 0)),
                "volume": float(c.get("volume", 0)),
            })
        else:
            d = c.to_dict() if hasattr(c, 'to_dict') else {}
            rows.append({
                "timestamp": int(d.get("start", 0)),
                "open":   float(d.get("open", 0)),
                "high":   float(d.get("high", 0)),
                "low":    float(d.get("low", 0)),
                "close":  float(d.get("close", 0)),
                "volume": float(d.get("volume", 0)),
            })

    if not rows:
        raise ValueError(f"No candle data returned for {product_id}")

    df = pd.DataFrame(rows)
    # Coinbase returns newest first — sort oldest first for indicator calc
    df = df.sort_values("timestamp").reset_index(drop=True)
    df = df[["open", "high", "low", "close", "volume"]].astype(float)

    return df


def get_latest_price(product_id: str = config.PRODUCT_ID) -> float:
    """Get the current price from Coinbase product ticker."""
    product = _client.get_product(product_id=product_id)
    data = product.to_dict() if hasattr(product, 'to_dict') else product
    if isinstance(data, dict):
        return float(data.get("price", 0))
    return float(getattr(product, "price", 0))


def get_balance(currency: str = "USD") -> float:
    """Get available balance for a currency. Also checks USDC if USD requested."""
    try:
        accounts_resp = _client.get_accounts(limit=250)
        data = accounts_resp.to_dict() if hasattr(accounts_resp, 'to_dict') else accounts_resp
        acct_list = data.get("accounts", []) if isinstance(data, dict) else []

        found_balance = 0.0
        for acct in acct_list:
            if isinstance(acct, dict):
                curr = acct.get("currency", "")
                avail = acct.get("available_balance", {})
                bal = float(avail.get("value", 0)) if isinstance(avail, dict) else 0
            else:
                ad = acct.to_dict() if hasattr(acct, 'to_dict') else {}
                curr = ad.get("currency", "")
                avail = ad.get("available_balance", {})
                bal = float(avail.get("value", 0)) if isinstance(avail, dict) else 0

            # Log only the currency we're looking for
            if curr == currency and bal > 0:
                log(f"[BROKER] {curr} balance: {bal}")

            if curr == currency:
                found_balance = bal
            # Coinbase unifies USD/USDC — check both if looking for USD
            elif currency == "USD" and curr == "USDC" and found_balance == 0:
                found_balance = bal

        return found_balance
    except Exception as e:
        log(f"[BROKER] Error getting balance: {e}")
    return 0.0


def place_buy(product_id: str, dollars: float) -> str:
    """Place a post-only limit buy order for maker fees only.
    post_only=True means the order is rejected if it would be a taker.
    Returns order_id, or empty string if rejected."""
    client_order_id = str(uuid.uuid4())

    # Get current price — set limit at current price so it sits on the book
    price = get_latest_price(product_id)
    limit_price = round(price, 4)
    base_size = round(dollars / limit_price, 6)

    order = _client.limit_order_gtc_buy(
        client_order_id=client_order_id,
        product_id=product_id,
        base_size=str(base_size),
        limit_price=str(limit_price),
        post_only=True,
    )
    data = order.to_dict() if hasattr(order, 'to_dict') else order

    # Check if order was rejected (post_only rejection)
    if isinstance(data, dict) and data.get("success") is False:
        error = data.get("error_response", {})
        log(f"[BROKER] Post-only BUY rejected (would be taker) — {error}")
        return ""

    if isinstance(data, dict) and "success_response" in data:
        order_id = data["success_response"].get("order_id", "")
    elif isinstance(data, dict) and "order_id" in data:
        order_id = data["order_id"]
    else:
        order_id = data.get("order_id", "") if isinstance(data, dict) else ""

    log(f"[BROKER] LIMIT BUY (post-only) {base_size} {product_id} @ ${limit_price} — {order_id}")
    return order_id


def place_sell(product_id: str, base_size: str) -> str:
    """Place a post-only limit sell order for maker fees only.
    Returns order_id, or empty string if rejected."""
    client_order_id = str(uuid.uuid4())

    price = get_latest_price(product_id)
    limit_price = round(price, 4)

    order = _client.limit_order_gtc_sell(
        client_order_id=client_order_id,
        product_id=product_id,
        base_size=base_size,
        limit_price=str(limit_price),
        post_only=True,
    )
    data = order.to_dict() if hasattr(order, 'to_dict') else order

    if isinstance(data, dict) and data.get("success") is False:
        error = data.get("error_response", {})
        log(f"[BROKER] Post-only SELL rejected (would be taker) — {error}")
        # Fall back to regular limit sell slightly below price so we don't get stuck holding
        fallback_id = str(uuid.uuid4())
        limit_price_fallback = round(price * 0.999, 4)
        order2 = _client.limit_order_gtc_sell(
            client_order_id=fallback_id,
            product_id=product_id,
            base_size=base_size,
            limit_price=str(limit_price_fallback),
        )
        data2 = order2.to_dict() if hasattr(order2, 'to_dict') else order2
        if isinstance(data2, dict) and "success_response" in data2:
            order_id = data2["success_response"].get("order_id", "")
        else:
            order_id = data2.get("order_id", "") if isinstance(data2, dict) else ""
        log(f"[BROKER] LIMIT SELL (fallback) {base_size} {product_id} @ ${limit_price_fallback} — {order_id}")
        return order_id

    if isinstance(data, dict) and "success_response" in data:
        order_id = data["success_response"].get("order_id", "")
    elif isinstance(data, dict) and "order_id" in data:
        order_id = data["order_id"]
    else:
        order_id = data.get("order_id", "") if isinstance(data, dict) else ""

    log(f"[BROKER] LIMIT SELL (post-only) {base_size} {product_id} @ ${limit_price} — {order_id}")
    return order_id


def sell_all(product_id: str = config.PRODUCT_ID):
    """Sell entire holding of the base currency (e.g., XRP)."""
    base_currency = product_id.split("-")[0]  # "XRP" from "XRP-USD"
    balance = get_balance(base_currency)
    if balance > 0:
        # Round down to avoid "insufficient funds" due to rounding
        # XRP has 6 decimal places on Coinbase
        base_size = f"{balance:.6f}"
        return place_sell(product_id, base_size)
    else:
        log(f"[BROKER] No {base_currency} balance to sell")
        return ""
