"""
bot.py — Main trading loop
Every 60 seconds during market hours:
  - Watches SPY and QQQ only
  - Runs technical signals + Grok sentiment on each
  - Buys $2 notional if both agree bullish
  - Monitors open positions for stop-loss / take-profit / sentiment exit
"""

import time
from datetime import datetime, timedelta
import pytz

import config
import broker
import strategy
import grok
from logger import (log, notify, notify_buy, notify_close,
                    notify_scan, notify_error)

ET = pytz.timezone("America/New_York")

# ── State ─────────────────────────────────────────────────────────────────────
_watchlist: list[str]       = list(config.FALLBACK_TICKERS)
_last_scan: datetime | None = None
_positions: dict[str, dict] = {}


# ── Time helpers ──────────────────────────────────────────────────────────────
def _now_et() -> datetime:
    return datetime.now(ET)

def _time_str() -> str:
    return _now_et().strftime("%H:%M")

def _is_market_hours() -> bool:
    now = _now_et()
    if now.weekday() >= 5:
        return False
    t = _time_str()
    return config.MARKET_OPEN_ET <= t <= config.MARKET_CLOSE_ET

def _needs_ticker_refresh() -> bool:
    global _last_scan
    if _last_scan is None:
        return True
    return (_now_et() - _last_scan) >= timedelta(minutes=config.TICKER_REFRESH_MINS)


# ── Ticker refresh (locked to SPY + QQQ) ─────────────────────────────────────
def _refresh_tickers():
    global _watchlist, _last_scan
    _watchlist = list(config.FALLBACK_TICKERS)
    _last_scan = _now_et()
    notify_scan(_watchlist)


# ── Position sync ─────────────────────────────────────────────────────────────
def _sync_positions():
    live = {p.symbol for p in broker.get_all_positions()}
    for sym in list(_positions.keys()):
        if sym not in live:
            log(f"[BOT] {sym} no longer in Alpaca — removing from state.")
            del _positions[sym]


# ── Single ticker cycle ───────────────────────────────────────────────────────
def _process_ticker(ticker: str):
    try:
        df = broker.get_bars(ticker, config.BAR_TIMEFRAME, config.BAR_LIMIT)
    except Exception as e:
        log(f"[BOT] Bar fetch failed for {ticker}: {e}")
        return

    current_price = float(df["close"].iloc[-1])

    # Check exits if holding
    if ticker in _positions:
        state = _positions[ticker]
        if current_price <= state["stop_loss"]:
            pnl = (current_price - state["entry_price"]) / state["entry_price"] * state["dollars"]
            broker.close_position(ticker)
            notify_close(ticker, "STOP_LOSS", pnl)
            del _positions[ticker]
            return
        if current_price >= state["take_profit"]:
            pnl = (current_price - state["entry_price"]) / state["entry_price"] * state["dollars"]
            broker.close_position(ticker)
            notify_close(ticker, "TAKE_PROFIT", pnl)
            del _positions[ticker]
            return
        # Sentiment exit check
        score, reason = grok.get_sentiment(ticker)
        if score <= config.SENTIMENT_SELL_MAX:
            pnl = (current_price - state["entry_price"]) / state["entry_price"] * state["dollars"]
            broker.close_position(ticker)
            notify_close(ticker, "SENTIMENT_BEARISH", pnl)
            del _positions[ticker]
        return

    # Max positions check
    if len(_positions) >= config.MAX_OPEN_POSITIONS:
        return

    # Technical signal
    tech_signal, atr, info = strategy.get_signal(df, ticker)
    if tech_signal != "BUY":
        return

    # Grok sentiment check
    score, reason = grok.get_sentiment(ticker)
    if score < config.SENTIMENT_BUY_MIN:
        log(f"[BOT] {ticker} tech=BUY but Grok={score:+.2f} — skipping.")
        return

    # Fire the trade
    stop = round(current_price - (atr * config.STOP_LOSS_MULT), 4) if atr else round(current_price * 0.98, 4)
    tp   = round(current_price + (atr * config.TAKE_PROFIT_MULT), 4) if atr else round(current_price * 1.02, 4)

    try:
        broker.place_notional_buy(ticker, config.MAX_TRADE_DOLLARS)
        _positions[ticker] = {
            "entry_price": current_price,
            "stop_loss":   stop,
            "take_profit": tp,
            "dollars":     config.MAX_TRADE_DOLLARS,
        }
        notify_buy(ticker, config.MAX_TRADE_DOLLARS, current_price, stop, tp, score, reason)
    except Exception as e:
        notify_error(f"Buy order failed for {ticker}: {e}")


# ── Main loop ─────────────────────────────────────────────────────────────────
def run():
    notify("🤖 **Trader bot started** — SPY & QQQ, $2/trade. Watching every 60s.")
    log("[BOT] Starting main loop...")

    while True:
        try:
            if not _is_market_hours():
                log("[BOT] Outside market hours — sleeping.")
                notify("💤 Bot is alive — outside market hours, sleeping.")
                time.sleep(300)
                continue

            if _needs_ticker_refresh():
                _refresh_tickers()

            _sync_positions()
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
```

Commit that → Railway redeploys → you should see in Discord within 60 seconds:
```
🤖 Trader bot started — SPY & QQQ, $2/trade. Watching every 60s.
💤 Bot is alive — outside market hours, sleeping.
