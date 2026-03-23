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

    # Parse the response into a DataFrame
    candles = candles_resp.get("candles", candles_resp)
    if hasattr(candles, "candles"):
        candles = candles.candles

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
            # Object with attributes
            rows.append({
                "timestamp": int(getattr(c, "start", 0)),
                "open":   float(getattr(c, "open", 0)),
                "high":   float(getattr(c, "high", 0)),
                "low":    float(getattr(c, "low", 0)),
                "close":  float(getattr(c, "close", 0)),
                "volume": float(getattr(c, "volume", 0)),
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
    if isinstance(product, dict):
        return float(product.get("price", 0))
    return float(getattr(product, "price", 0))


def get_balance(currency: str = "USD") -> float:
    """Get available balance for a currency."""
    try:
        accounts = _client.get_accounts()
        acct_list = accounts.get("accounts", []) if isinstance(accounts, dict) else getattr(accounts, "accounts", [])
        for acct in acct_list:
            if isinstance(acct, dict):
                curr = acct.get("currency", "")
                avail = acct.get("available_balance", {})
                bal = float(avail.get("value", 0)) if isinstance(avail, dict) else 0
            else:
                curr = getattr(acct, "currency", "")
                avail = getattr(acct, "available_balance", None)
                if avail:
                    bal = float(getattr(avail, "value", 0) if not isinstance(avail, dict) else avail.get("value", 0))
                else:
                    bal = 0
            if curr == currency:
                return bal
    except Exception as e:
        log(f"[BROKER] Error getting balance: {e}")
    return 0.0


def place_buy(product_id: str, dollars: float) -> str:
    """Place a market buy order for $X of product. Returns order_id."""
    client_order_id = str(uuid.uuid4())
    order = _client.market_order_buy(
        client_order_id=client_order_id,
        product_id=product_id,
        quote_size=str(round(dollars, 2)),
    )
    order_id = order.get("order_id", "") if isinstance(order, dict) else getattr(order, "order_id", "")
    log(f"[BROKER] BUY ${dollars:.2f} of {product_id} — {order_id}")
    return order_id


def place_sell(product_id: str, base_size: str) -> str:
    """Place a market sell order for X units of product. Returns order_id."""
    client_order_id = str(uuid.uuid4())
    order = _client.market_order_sell(
        client_order_id=client_order_id,
        product_id=product_id,
        base_size=base_size,
    )
    order_id = order.get("order_id", "") if isinstance(order, dict) else getattr(order, "order_id", "")
    log(f"[BROKER] SELL {base_size} of {product_id} — {order_id}")
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
