"""
broker.py — Coinbase Advanced Trade wrapper for Winston v11 Degen Mode

Handles buying/selling multiple coins, getting prices, listing available products.
"""

import uuid
from coinbase.rest import RESTClient

import config
from logger import log

_client = RESTClient(
    api_key=config.COINBASE_API_KEY,
    api_secret=config.COINBASE_API_SECRET,
)


def get_available_coins() -> list:
    """Get all tradeable USD pairs on Coinbase. Returns list of product_ids like ['BTC-USD', 'ETH-USD', ...]"""
    try:
        resp = _client.get_products(product_type="SPOT")
        data = resp.to_dict() if hasattr(resp, 'to_dict') else resp
        products = data.get("products", []) if isinstance(data, dict) else []

        coins = []
        for p in products:
            if isinstance(p, dict):
                pid = p.get("product_id", "")
                status = p.get("status", "")
                is_disabled = p.get("is_disabled", False)
                trading_disabled = p.get("trading_disabled", False)
            else:
                pd_dict = p.to_dict() if hasattr(p, 'to_dict') else {}
                pid = pd_dict.get("product_id", "")
                status = pd_dict.get("status", "")
                is_disabled = pd_dict.get("is_disabled", False)
                trading_disabled = pd_dict.get("trading_disabled", False)

            if pid.endswith("-USD") and not is_disabled and not trading_disabled:
                coins.append(pid)

        log(f"[BROKER] Found {len(coins)} tradeable USD pairs")
        return coins
    except Exception as e:
        log(f"[BROKER] Error fetching products: {e}")
        return []


def get_price(product_id: str) -> float:
    """Get current price for a product."""
    product = _client.get_product(product_id=product_id)
    data = product.to_dict() if hasattr(product, 'to_dict') else product
    return float(data.get("price", 0)) if isinstance(data, dict) else 0.0


def get_balance(currency: str) -> float:
    """Get available balance for a currency."""
    try:
        accounts_resp = _client.get_accounts(limit=250)
        data = accounts_resp.to_dict() if hasattr(accounts_resp, 'to_dict') else accounts_resp
        acct_list = data.get("accounts", []) if isinstance(data, dict) else []

        for acct in acct_list:
            ad = acct.to_dict() if hasattr(acct, 'to_dict') else acct
            if isinstance(ad, dict):
                curr = ad.get("currency", "")
                avail = ad.get("available_balance", {})
                bal = float(avail.get("value", 0)) if isinstance(avail, dict) else 0
                if curr == currency:
                    return bal
    except Exception as e:
        log(f"[BROKER] Error getting {currency} balance: {e}")
    return 0.0


def buy_coin(product_id: str, dollars: float) -> dict:
    """Buy $X of a coin using market order. Returns {order_id, price, base_size} or empty dict on failure."""
    try:
        client_order_id = str(uuid.uuid4())
        order = _client.market_order_buy(
            client_order_id=client_order_id,
            product_id=product_id,
            quote_size=str(round(dollars, 2)),
        )
        data = order.to_dict() if hasattr(order, 'to_dict') else order

        if isinstance(data, dict) and data.get("success") is False:
            error = data.get("error_response", {})
            log(f"[BROKER] BUY {product_id} failed: {error}")
            return {}

        if isinstance(data, dict) and "success_response" in data:
            order_id = data["success_response"].get("order_id", "")
        else:
            order_id = data.get("order_id", "") if isinstance(data, dict) else ""

        price = get_price(product_id)
        base_size = dollars / price if price > 0 else 0

        log(f"[BROKER] BOUGHT ${dollars:.2f} of {product_id} @ ${price:.6f} — {order_id}")
        return {"order_id": order_id, "price": price, "base_size": base_size}

    except Exception as e:
        log(f"[BROKER] BUY {product_id} error: {e}")
        return {}


def sell_coin(product_id: str) -> dict:
    """Sell entire holding of a coin. Returns {price, pnl_pct} or empty dict."""
    try:
        base_currency = product_id.split("-")[0]
        balance = get_balance(base_currency)

        if balance <= 0:
            log(f"[BROKER] No {base_currency} to sell")
            return {}

        # Format base_size — different coins need different precision
        price = get_price(product_id)
        if price >= 1000:
            base_size = f"{balance:.8f}"
        elif price >= 1:
            base_size = f"{balance:.6f}"
        else:
            base_size = f"{balance:.2f}"

        client_order_id = str(uuid.uuid4())
        order = _client.market_order_sell(
            client_order_id=client_order_id,
            product_id=product_id,
            base_size=base_size,
        )
        data = order.to_dict() if hasattr(order, 'to_dict') else order

        if isinstance(data, dict) and data.get("success") is False:
            error = data.get("error_response", {})
            log(f"[BROKER] SELL {product_id} failed: {error}")
            return {}

        log(f"[BROKER] SOLD {base_size} of {product_id} @ ${price:.6f}")
        return {"price": price}

    except Exception as e:
        log(f"[BROKER] SELL {product_id} error: {e}")
        return {}
