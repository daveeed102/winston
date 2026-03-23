"""
broker.py
Alpaca wrapper. Supports both long (buy) and short (sell) positions.
Uses notional dollar amounts for fractional share support.
"""
import pandas as pd
from datetime import datetime, timedelta
import pytz

from alpaca.trading.client   import TradingClient
from alpaca.trading.requests import MarketOrderRequest
from alpaca.trading.enums    import OrderSide, TimeInForce
from alpaca.data.historical  import StockHistoricalDataClient
from alpaca.data.requests    import StockBarsRequest, StockLatestTradeRequest
from alpaca.data.timeframe   import TimeFrame, TimeFrameUnit
from config import ALPACA_API_KEY, ALPACA_SECRET_KEY, ALPACA_BASE_URL, BAR_LIMIT
from logger import log

_paper   = "paper-api" in ALPACA_BASE_URL
_trading = TradingClient(ALPACA_API_KEY, ALPACA_SECRET_KEY, paper=_paper)
_data    = StockHistoricalDataClient(ALPACA_API_KEY, ALPACA_SECRET_KEY)


def get_bars(ticker: str, timeframe_str: str = "5Min", limit: int = BAR_LIMIT) -> pd.DataFrame:
    tf_map = {
        "1Min":  TimeFrame.Minute,
        "5Min":  TimeFrame(5,  TimeFrameUnit.Minute),
        "15Min": TimeFrame(15, TimeFrameUnit.Minute),
        "1Hour": TimeFrame.Hour,
    }
    tf = tf_map.get(timeframe_str, TimeFrame(5, TimeFrameUnit.Minute))

    # Pull 3x the needed window to guarantee enough bars for all indicators
    # Bar duration in minutes
    bar_minutes = {
        "1Min": 1, "5Min": 5, "15Min": 15, "1Hour": 60
    }.get(timeframe_str, 5)

    # Pull 3x window so MACD (26 bars) and Bollinger (20 bars) always have enough data
    now   = datetime.now(pytz.utc)
    start = now - timedelta(minutes=limit * bar_minutes * 3)

    req = StockBarsRequest(
        symbol_or_symbols=ticker,
        timeframe=tf,
        limit=limit,
        start=start,
        feed="sip",
        adjustment="raw",
    )

    bars = _data.get_stock_bars(req)
    df   = bars.df.reset_index()

    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.droplevel(0)

    df = df[["open", "high", "low", "close", "volume"]].astype(float)

    if df.empty:
        raise ValueError(f"No bar data returned for {ticker}")

    # Staleness guard — log a warning if newest bar is more than 2 minutes old
    latest_bar_time = bars.df.index.get_level_values("timestamp")[-1]
    age_seconds = (now - latest_bar_time.to_pydatetime()).total_seconds()
    stale_threshold = bar_minutes * 60 * 1.5
    if age_seconds > stale_threshold:
        log(f"[BROKER] WARNING: Stale data for {ticker} — last bar is {int(age_seconds)}s old (threshold {int(stale_threshold)}s)")

    return df


def get_latest_price(ticker: str) -> float:
    """Get the most recent trade price — real-time, not bar-based."""
    req = StockLatestTradeRequest(symbol_or_symbols=ticker, feed="iex")
    trade = _data.get_stock_latest_trade(req)
    # Response is a dict keyed by symbol
    if isinstance(trade, dict):
        return float(trade[ticker].price)
    return float(trade.price)


def get_account():
    return _trading.get_account()


def get_portfolio_value() -> float:
    return float(_trading.get_account().portfolio_value)


def get_cash() -> float:
    return float(_trading.get_account().cash)


def get_all_positions() -> list:
    return _trading.get_all_positions()


def count_open_positions() -> int:
    return len(_trading.get_all_positions())


def get_position(ticker: str):
    try:
        return _trading.get_open_position(ticker)
    except Exception:
        return None


def place_long(ticker: str, dollars: float) -> object:
    """Buy $X of ticker (go long)."""
    req = MarketOrderRequest(
        symbol=ticker,
        notional=round(dollars, 2),
        side=OrderSide.BUY,
        time_in_force=TimeInForce.DAY,
    )
    order = _trading.submit_order(req)
    log(f"[BROKER] LONG ${dollars:.2f} of {ticker} — {order.id}")
    return order


def place_short(ticker: str, dollars: float) -> object:
    """Sell short $X of ticker."""
    try:
        bars  = get_bars(ticker, "5Min", 1)
        price = float(bars["close"].iloc[-1])
        qty   = round(dollars / price, 4)
    except Exception:
        qty = 1

    req = MarketOrderRequest(
        symbol=ticker,
        qty=qty,
        side=OrderSide.SELL,
        time_in_force=TimeInForce.DAY,
    )
    order = _trading.submit_order(req)
    log(f"[BROKER] SHORT {qty} shares of {ticker} — {order.id}")
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


def is_account_shorting_enabled() -> bool:
    try:
        account = _trading.get_account()
        return account.shorting_enabled
    except Exception:
        return False
