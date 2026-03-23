"""
broker.py — Coinbase Advanced Trade wrapper for Winston v12
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
    """Get all tradeable USD pairs on Coinbase."""
    try:
        resp = _client.get_products(product_type="SPOT")
        data = resp.to_dict() if hasattr(resp, 'to_dict') else resp
        products = data.get("products", []) if isinstance(data, dict) else []

        coins = []
        for p in products:
            pd_dict = p.to_dict() if hasattr(p, 'to_dict') else p
            if isinstance(pd_dict, dict):
                pid = pd_dict.get("product_id", "")
                is_disabled = pd_dict.get("is_disabled", False)
                trading_disabled = pd_dict.get("trading_disabled", False)
                if pid.endswith("-USD") and not is_disabled and not trading_disabled:
                    coins.append(pid)

        log(f"[BROKER] {len(coins)} tradeable USD pairs")
        return coins
    except Exception as e:
        log(f"[BROKER] Error fetching products: {e}")
        return []


def get_price(product_id: str) -> float:
    """Get current price."""
    product = _client.get_product(product_id=product_id)
    data = product.to_dict() if hasattr(product, 'to_dict') else product
    return float(data.get("price", 0)) if isinstance(data, dict) else 0.0


def get_balance(currency: str) -> float:
    """Get available balance."""
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
        log(f"[BROKER] Balance error: {e}")
    return 0.0


def buy_coin(product_id: str, dollars: float) -> dict:
    """Buy $X of a coin. Returns {order_id, price} or empty dict."""
    try:
        client_order_id = str(uuid.uuid4())
        order = _client.market_order_buy(
            client_order_id=client_order_id,
            product_id=product_id,
            quote_size=str(round(dollars, 2)),
        )
        data = order.to_dict() if hasattr(order, 'to_dict') else order

        if isinstance(data, dict) and data.get("success") is False:
            log(f"[BROKER] BUY {product_id} failed: {data.get('error_response', {})}")
            return {}

        if isinstance(data, dict) and "success_response" in data:
            order_id = data["success_response"].get("order_id", "")
        else:
            order_id = data.get("order_id", "") if isinstance(data, dict) else ""

        price = get_price(product_id)
        log(f"[BROKER] BOUGHT ${dollars:.2f} of {product_id} @ ${price:.6f}")
        return {"order_id": order_id, "price": price}

    except Exception as e:
        log(f"[BROKER] BUY error {product_id}: {e}")
        return {}


def sell_coin(product_id: str) -> dict:
    """Sell entire holding. Returns {price} or empty dict."""
    try:
        base_currency = product_id.split("-")[0]
        balance = get_balance(base_currency)
        if balance <= 0:
            return {}

        price = get_price(product_id)
        if price >= 100:
            base_size = f"{balance:.8f}"
        elif price >= 1:
            base_size = f"{balance:.6f}"
        elif price >= 0.001:
            base_size = f"{balance:.2f}"
        else:
            base_size = f"{balance:.0f}"

        client_order_id = str(uuid.uuid4())
        order = _client.market_order_sell(
            client_order_id=client_order_id,
            product_id=product_id,
            base_size=base_size,
        )
        data = order.to_dict() if hasattr(order, 'to_dict') else order

        if isinstance(data, dict) and data.get("success") is False:
            log(f"[BROKER] SELL {product_id} failed: {data.get('error_response', {})}")
            return {}

        log(f"[BROKER] SOLD {base_size} of {product_id} @ ${price:.6f}")
        return {"price": price}

    except Exception as e:
        log(f"[BROKER] SELL error {product_id}: {e}")
        return {}
