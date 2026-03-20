"""
bot.py - Main trading loop
Features:
  - Long AND short positions on SPY and QQQ
  - Trailing stop-loss that locks in gains
  - Persistent positions via PostgreSQL (survives restarts)
  - Daily P&L summary at market close

Changes from v1:
  - Grok sentiment REMOVED from entry decision (it has no real-time data
    and was blocking every trade). Now entry is purely technical.
  - Grok sentiment KEPT as a soft exit filter only (bearish flip exits long, etc.)
  - Added dedup guard so the same ticker can't open a new position within
    ENTRY_COOLDOWN_MINS of closing one (avoids whipsaw re-entries)
  - Cleaned up _is_near_close() alignment with MARKET_CLOSE_ET
"""

import time
from datetime import datetime, timedelta
import pytz

import config
import broker
import strategy
import grok
import database
from logger import (log, notify, notify_buy, notify_close,
                    notify_scan, notify_summary, notify_error)

ET = pytz.timezone("America/New_York")

_watchlist    = list(config.FALLBACK_TICKERS)
_last_scan    = None
_positions    = {}
_last_closed  = {}   # ticker -> datetime — cooldown after close to avoid whipsaws
_shorting_enabled = False

ENTRY_COOLDOWN_MINS = 5   # don't re-enter a ticker within 5 min of closing it


def _now_et():
    return datetime.now(ET)

def _time_str():
    return _now_et().strftime("%H:%M")

def _is_market_hours():
    now = _now_et()
    if now.weekday() >= 5:
        return False
    t = _time_str()
    return config.MARKET_OPEN_ET <= t <= config.MARKET_CLOSE_ET

def _is_near_close():
    # Aligned with MARKET_CLOSE_ET = "15:50"
    return _time_str() >= config.MARKET_CLOSE_ET

def _needs_ticker_refresh():
    global _last_scan
    if _last_scan is None:
        return True
    return (_now_et() - _last_scan) >= timedelta(minutes=config.TICKER_REFRESH_MINS)

def _in_cooldown(ticker: str) -> bool:
    if ticker not in _last_closed:
        return False
    elapsed = (_now_et() - _last_closed[ticker]).total_seconds() / 60
    return elapsed < ENTRY_COOLDOWN_MINS


def _refresh_tickers():
    global _watchlist, _last_scan
    _watchlist = list(config.FALLBACK_TICKERS)
    _last_scan = _now_et()
    notify_scan(_watchlist)


def _update_trailing_stop(ticker: str, state: dict, current_price: float, atr: float):
    """Ratchet stop-loss up (long) or down (short) as price moves in our favor."""
    side = state["side"]
    peak = state["peak_price"]

    if side == "LONG":
        if current_price > peak:
            new_peak = current_price
            new_stop = round(new_peak - (atr * config.TRAIL_DISTANCE), 4)
            if new_stop > state["stop_loss"]:
                state["peak_price"] = new_peak
                state["stop_loss"]  = new_stop
                _positions[ticker]  = state
                database.update_stop(ticker, new_peak, new_stop)
                log(f"[TRAIL] {ticker} LONG peak={new_peak} new_stop={new_stop}")

    elif side == "SHORT":
        if current_price < peak:
            new_peak = current_price
            new_stop = round(new_peak + (atr * config.TRAIL_DISTANCE), 4)
            if new_stop < state["stop_loss"]:
                state["peak_price"] = new_peak
                state["stop_loss"]  = new_stop
                _positions[ticker]  = state
                database.update_stop(ticker, new_peak, new_stop)
                log(f"[TRAIL] {ticker} SHORT peak={new_peak} new_stop={new_stop}")


def _close_trade(ticker: str, current_price: float, reason: str):
    state = _positions[ticker]
    side  = state["side"]

    if side == "LONG":
        pnl = (current_price - state["entry_price"]) / state["entry_price"] * state["dollars"]
    else:
        pnl = (state["entry_price"] - current_price) / state["entry_price"] * state["dollars"]

    broker.close_position(ticker)
    database.record_trade(
        ticker, side, state["entry_price"], current_price,
        state["dollars"], pnl, reason, state["entry_time"]
    )
    database.delete_position(ticker)
    del _positions[ticker]
    _last_closed[ticker] = _now_et()   # start cooldown
    notify_close(ticker, side, reason, pnl)


def _process_ticker(ticker: str):
    try:
        df = broker.get_bars(ticker, config.BAR_TIMEFRAME, config.BAR_LIMIT)
    except Exception as e:
        log(f"[BOT] Bar fetch failed for {ticker}: {e}")
        return

    current_price = float(df["close"].iloc[-1])
    signal, atr, info = strategy.get_signal(df, ticker)

    # ── Close all positions near end of day ──────────────────────────────
    if _is_near_close() and ticker in _positions:
        _close_trade(ticker, current_price, "EOD_CLOSE")
        return

    # ── Manage existing position ──────────────────────────────────────────
    if ticker in _positions:
        state = _positions[ticker]
        side  = state["side"]

        if atr:
            _update_trailing_stop(ticker, state, current_price, atr)
            state = _positions[ticker]

        if side == "LONG":
            if current_price <= state["stop_loss"]:
                _close_trade(ticker, current_price, "STOP_LOSS")
                return
            if current_price >= state["take_profit"]:
                _close_trade(ticker, current_price, "TAKE_PROFIT")
                return
            # Soft sentiment exit — only if Grok is strongly bearish
            score, _ = grok.get_sentiment(ticker)
            if score <= config.SENTIMENT_SELL_MAX:
                _close_trade(ticker, current_price, "SENTIMENT_EXIT")
                return

        elif side == "SHORT":
            if current_price >= state["stop_loss"]:
                _close_trade(ticker, current_price, "STOP_LOSS")
                return
            if current_price <= state["take_profit"]:
                _close_trade(ticker, current_price, "TAKE_PROFIT")
                return
            # Soft sentiment exit — only if Grok is strongly bullish
            score, _ = grok.get_sentiment(ticker)
            if score >= config.SENTIMENT_COVER_MIN:
                _close_trade(ticker, current_price, "SENTIMENT_EXIT")
                return
        return

    # ── No position — check for entry ─────────────────────────────────────
    if len(_positions) >= config.MAX_OPEN_POSITIONS:
        return

    if _in_cooldown(ticker):
        log(f"[BOT] {ticker} in cooldown — skipping entry.")
        return

    # Entry is PURELY TECHNICAL now — no Grok gate on the way in.
    # Grok only triggers early exits (above).

    if signal == "LONG":
        stop = round(current_price - (atr * config.STOP_LOSS_MULT), 4) if atr else round(current_price * 0.98, 4)
        tp   = round(current_price + (atr * config.TAKE_PROFIT_MULT), 4) if atr else round(current_price * 1.02, 4)
        try:
            broker.place_long(ticker, config.MAX_TRADE_DOLLARS)
            state = {
                "side":        "LONG",
                "entry_price": current_price,
                "stop_loss":   stop,
                "take_profit": tp,
                "peak_price":  current_price,
                "dollars":     config.MAX_TRADE_DOLLARS,
                "entry_time":  datetime.utcnow(),
            }
            _positions[ticker] = state
            database.save_position(ticker, "LONG", current_price, stop, tp, config.MAX_TRADE_DOLLARS)
            notify_buy(ticker, "LONG", config.MAX_TRADE_DOLLARS, current_price, stop, tp, 0.0, "Technical entry")
        except Exception as e:
            notify_error(f"Long order failed {ticker}: {e}")

    elif signal == "SHORT" and _shorting_enabled:
        stop = round(current_price + (atr * config.STOP_LOSS_MULT), 4) if atr else round(current_price * 1.02, 4)
        tp   = round(current_price - (atr * config.TAKE_PROFIT_MULT), 4) if atr else round(current_price * 0.98, 4)
        try:
            broker.place_short(ticker, config.MAX_TRADE_DOLLARS)
            state = {
                "side":        "SHORT",
                "entry_price": current_price,
                "stop_loss":   stop,
                "take_profit": tp,
                "peak_price":  current_price,
                "dollars":     config.MAX_TRADE_DOLLARS,
                "entry_time":  datetime.utcnow(),
            }
            _positions[ticker] = state
            database.save_position(ticker, "SHORT", current_price, stop, tp, config.MAX_TRADE_DOLLARS)
            notify_buy(ticker, "SHORT", config.MAX_TRADE_DOLLARS, current_price, stop, tp, 0.0, "Technical entry")
        except Exception as e:
            notify_error(f"Short order failed {ticker}: {e}")

    elif signal == "SHORT" and not _shorting_enabled:
        log(f"[BOT] {ticker} SHORT signal — shorting not enabled, skipping.")


def run():
    global _shorting_enabled, _positions

    database.init_db()

    _positions = database.load_positions()
    if _positions:
        notify(f"Restarted — resumed {len(_positions)} open position(s): {list(_positions.keys())}")

    _shorting_enabled = broker.is_account_shorting_enabled()
    log(f"[BOT] Shorting enabled: {_shorting_enabled}")

    notify("Winston v2 started — SPY & QQQ, $2/trade, technical entry only. Watching every 60s.")
    log("[BOT] Starting main loop...")

    summary_sent = False

    while True:
        try:
            if not _is_market_hours():
                log("[BOT] Outside market hours - sleeping.")
                notify("Bot is alive - outside market hours, sleeping.")
                summary_sent = False
                time.sleep(300)
                continue

            # Send daily summary once at/after close
            if _is_near_close() and not summary_sent:
                summary = database.get_summary()
                notify_summary(
                    summary["total_trades"],
                    summary["winning_trades"],
                    summary["total_pnl"]
                )
                summary_sent = True

            if _needs_ticker_refresh():
                _refresh_tickers()

            log(f"[BOT] Scanning {_watchlist} ...")

            for ticker in _watchlist:
                try:
                    _process_ticker(ticker)
                except Exception as e:
                    log(f"[BOT] Error on {ticker}: {e}")

        except Exception as e:
            notify_error(str(e))
            log(f"[BOT] Unhandled error: {e}")

        time.sleep(config.RUN_INTERVAL_SECS)


if __name__ == "__main__":
    run()
