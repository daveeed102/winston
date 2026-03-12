"""
bot.py
Main trading loop.
Runs every 5 minutes during market hours.
Combines technical signals + Grok AI sentiment before placing any order.
"""

import time
import math
from datetime import datetime
import pytz

import config
import broker
import strategy
import grok_sentiment
from logger import log, notify, notify_trade, notify_close, notify_error

ET = pytz.timezone("America/New_York")

# In-memory trade state (survives restarts if you add a DB later)
_trade_state = {
    "in_position": False,
    "entry_price": 0.0,
    "stop_loss":   0.0,
    "take_profit": 0.0,
    "qty":         0,
    "entry_time":  None,
}


# ── Market hours check ────────────────────────────────────────────────────────
def _is_market_hours() -> bool:
    now_et = datetime.now(ET)
    if now_et.weekday() >= 5:   # Saturday / Sunday
        return False
    t = now_et.strftime("%H:%M")
    return config.MARKET_OPEN_ET <= t <= config.MARKET_CLOSE_ET


# ── Position sizing ───────────────────────────────────────────────────────────
def _calc_qty(price: float) -> int:
    portfolio = broker.get_portfolio_value()
    cash      = broker.get_cash()
    max_spend = min(portfolio * config.MAX_POSITION_PCT, cash * 0.99)
    qty = math.floor(max_spend / price)
    return max(qty, 1)


# ── Stop / take-profit check ──────────────────────────────────────────────────
def _check_exit_conditions(current_price: float) -> str | None:
    if not _trade_state["in_position"]:
        return None
    if current_price <= _trade_state["stop_loss"]:
        return "STOP_LOSS"
    if current_price >= _trade_state["take_profit"]:
        return "TAKE_PROFIT"
    return None


# ── Main cycle ────────────────────────────────────────────────────────────────
def run_cycle():
    if not _is_market_hours():
        log("[BOT] Outside market hours — skipping.")
        return

    log("[BOT] ── Cycle start ──────────────────────")

    # 1. Fetch price bars
    try:
        df = broker.get_bars(config.BAR_TIMEFRAME, config.BAR_LIMIT)
    except Exception as e:
        notify_error(f"Bar fetch failed: {e}")
        return

    current_price = float(df["close"].iloc[-1])

    # 2. If we have an open position, check stop/TP first
    if _trade_state["in_position"]:
        exit_reason = _check_exit_conditions(current_price)
        if exit_reason:
            pnl = (_trade_state["entry_price"] - current_price) * _trade_state["qty"]
            if exit_reason == "TAKE_PROFIT":
                pnl = (current_price - _trade_state["entry_price"]) * _trade_state["qty"]
            broker.close_position(config.TICKER)
            notify_close(config.TICKER, exit_reason, pnl)
            _trade_state["in_position"] = False
            return

    # 3. Get technical signal
    tech_signal, atr, info = strategy.get_signal(df)

    # 4. Get Grok sentiment
    sentiment_score, sentiment_reason = grok_sentiment.get_sentiment()

    log(f"[BOT] tech={tech_signal} | sentiment={sentiment_score:+.2f} | price={current_price}")

    # 5. Combined decision: both must agree
    if not _trade_state["in_position"]:
        if tech_signal == "BUY" and sentiment_score >= config.SENTIMENT_BUY_MIN:
            qty = _calc_qty(current_price)
            if broker.count_open_positions() < config.MAX_OPEN_POSITIONS:
                stop  = round(current_price - (atr * config.STOP_LOSS_MULT), 2)
                tp    = round(current_price + (atr * config.TAKE_PROFIT_MULT), 2)
                try:
                    broker.place_market_buy(qty)
                    _trade_state.update({
                        "in_position": True,
                        "entry_price": current_price,
                        "stop_loss":   stop,
                        "take_profit": tp,
                        "qty":         qty,
                        "entry_time":  datetime.now(ET).isoformat(),
                    })
                    notify_trade("BUY", config.TICKER, qty, current_price,
                                 stop, tp, sentiment_score, sentiment_reason)
                except Exception as e:
                    notify_error(f"Buy order failed: {e}")
            else:
                log("[BOT] Max open positions reached — no new trade.")

    elif _trade_state["in_position"]:
        # Exit if tech says SELL OR sentiment flips strongly bearish
        if tech_signal == "SELL" or sentiment_score <= config.SENTIMENT_SELL_MAX:
            reason = "TECH_SELL" if tech_signal == "SELL" else "SENTIMENT_BEARISH"
            pnl = (current_price - _trade_state["entry_price"]) * _trade_state["qty"]
            try:
                broker.close_position(config.TICKER)
                notify_close(config.TICKER, reason, pnl)
                _trade_state["in_position"] = False
            except Exception as e:
                notify_error(f"Sell order failed: {e}")


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    notify("🤖 **SPY Trader bot started** — paper mode. Watching every 5 min.")
    log("[BOT] Starting main loop...")

    while True:
        try:
            run_cycle()
        except Exception as e:
            notify_error(str(e))
            log(f"[BOT] Unhandled error: {e}")

        log(f"[BOT] Sleeping {config.RUN_INTERVAL_MINS} min...")
        time.sleep(config.RUN_INTERVAL_MINS * 60)
