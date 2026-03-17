import pandas as pd
from alpaca.trading.client import TradingClient
from alpaca.trading.requests import MarketOrderRequest
from alpaca.trading.enums import OrderSide, TimeInForce
from alpaca.data.historical import StockHistoricalDataClient
from alpaca.data.requests import StockBarsRequest
from alpaca.data.timeframe import TimeFrame, TimeFrameUnit
from config import ALPACA_API_KEY, ALPACA_SECRET_KEY, ALPACA_BASE_URL, BAR_LIMIT
from logger import log

_paper   = "paper-api" in ALPACA_BASE_URL
_trading = TradingClient(ALPACA_API_KEY, ALPACA_SECRET_KEY, paper=_paper)
_data    = StockHistoricalDataClient(ALPACA_API_KEY, ALPACA_SECRET_KEY)

def get_bars(ticker: str, timeframe_str: str = "5Min", limit: int = BAR_LIMIT) -> pd.DataFrame:
    tf_map = {
        "1Min":  TimeFrame.Minute,
        "5Min":  TimeFrame(5, TimeFrameUnit.Minute),
        "15Min": TimeFrame(15, TimeFrameUnit.Minute),
        "1Hour": TimeFrame.Hour,
    }
    tf  = tf_map.get(timeframe_str, TimeFrame(5, TimeFrameUnit.Minute))
    req = StockBarsRequest(symbol_or_symbols=ticker, timeframe=tf, limit=limit)
    bars = _data.get_stock_bars(req)
    df   = bars.df.reset_index()
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.droplevel(0)
    df = df[["open", "high", "low", "close", "volume"]].astype(float)
    return df

def get_portfolio_value() -> float:
    return float(_trading.get_account().portfolio_value)

def get_cash() -> float:
    return float(_trading.get_account().cash)

def get_position(ticker: str):
    try:
        return _trading.get_open_position(ticker)
    except Exception:
        return None

def get_all_positions() -> list:
    return _trading.get_all_positions()

def count_open_positions() -> int:
    return len(_trading.get_all_positions())

def place_notional_buy(ticker: str, dollars: float) -> object:
    req = MarketOrderRequest(
        symbol=ticker,
        notional=round(dollars, 2),
        side=OrderSide.BUY,
        time_in_force=TimeInForce.DAY,
    )
    order = _trading.submit_order(req)
    log(f"[BROKER] BUY ${dollars:.2f} of {ticker} — order {order.id}")
    return order

def close_position(ticker: str):
    try:
        _trading.close_position(ticker)
        log(f"[BROKER] Closed {ticker}")
    except Exception as e:
        log(f"[BROKER] Failed to close {ticker}: {e}")

def close_all_positions():
    for pos in get_all_positions():
        close_position(pos.symbol)

def cancel_all_orders():
    _trading.cancel_orders()
    log("[BROKER] Cancelled all open orders")
