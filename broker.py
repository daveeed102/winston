"""
broker.py
Thin wrapper around the Alpaca REST API.
Handles: bar fetching, position checks, order placement, account info.
"""

import pandas as pd
from alpaca.trading.client        import TradingClient
from alpaca.trading.requests      import MarketOrderRequest, LimitOrderRequest
from alpaca.trading.enums         import OrderSide, TimeInForce
from alpaca.data.historical       import StockHistoricalDataClient
from alpaca.data.requests         import StockBarsRequest
from alpaca.data.timeframe        import TimeFrame, TimeFrameUnit
from config import (
    ALPACA_API_KEY, ALPACA_SECRET_KEY, ALPACA_BASE_URL,
    TICKER, BAR_LIMIT
)
from logger import log


# ── Clients ───────────────────────────────────────────────────────────────────
_trading = TradingClient(
    ALPACA_API_KEY, ALPACA_SECRET_KEY,
    paper=("paper-api" in ALPACA_BASE_URL)
)
_data = StockHistoricalDataClient(ALPACA_API_KEY, ALPACA_SECRET_KEY)


# ── Bar data ──────────────────────────────────────────────────────────────────
def get_bars(timeframe_str: str = "5Min", limit: int = BAR_LIMIT) -> pd.DataFrame:
    """Fetch recent OHLCV bars as a DataFrame."""
    unit_map = {"1Min": TimeFrame.Minute, "5Min": TimeFrame(5, TimeFrameUnit.Minute),
                "15Min": TimeFrame(15, TimeFrameUnit.Minute), "1Hour": TimeFrame.Hour}
    tf = unit_map.get(timeframe_str, TimeFrame(5, TimeFrameUnit.Minute))

    req = StockBarsRequest(symbol_or_symbols=TICKER, timeframe=tf, limit=limit)
    bars = _data.get_stock_bars(req)
    df = bars.df.reset_index()

    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.droplevel(0)

    df = df.rename(columns={"open": "open", "high": "high",
                             "low": "low", "close": "close", "volume": "volume"})
    df = df[["open", "high", "low", "close", "volume"]].copy()
    df = df.astype(float)
    return df


# ── Account ───────────────────────────────────────────────────────────────────
def get_portfolio_value() -> float:
    account = _trading.get_account()
    return float(account.portfolio_value)


def get_cash() -> float:
    account = _trading.get_account()
    return float(account.cash)


# ── Positions ─────────────────────────────────────────────────────────────────
def get_position(ticker: str = TICKER):
    """Returns position object or None if no position."""
    try:
        return _trading.get_open_position(ticker)
    except Exception:
        return None


def count_open_positions() -> int:
    return len(_trading.get_all_positions())


# ── Orders ────────────────────────────────────────────────────────────────────
def place_market_buy(qty: int) -> dict:
    req = MarketOrderRequest(
        symbol=TICKER,
        qty=qty,
        side=OrderSide.BUY,
        time_in_force=TimeInForce.DAY,
    )
    order = _trading.submit_order(req)
    log(f"[BROKER] Market BUY {qty}x {TICKER} — order id: {order.id}")
    return order


def place_market_sell(qty: int) -> dict:
    req = MarketOrderRequest(
        symbol=TICKER,
        qty=qty,
        side=OrderSide.SELL,
        time_in_force=TimeInForce.DAY,
    )
    order = _trading.submit_order(req)
    log(f"[BROKER] Market SELL {qty}x {TICKER} — order id: {order.id}")
    return order


def close_position(ticker: str = TICKER):
    """Close entire position in one call."""
    try:
        _trading.close_position(ticker)
        log(f"[BROKER] Closed position in {ticker}")
    except Exception as e:
        log(f"[BROKER] Failed to close {ticker}: {e}")


def cancel_all_orders():
    _trading.cancel_orders()
    log("[BROKER] Cancelled all open orders")
