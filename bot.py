"""
bot.py — Winston v8

Changes from v7:
  - $10 per trade (was $5)
  - 4 votes needed to enter (was 6)
  - HARD STOP added — if trade moves 0.5% against us mid-hold, bail immediately
    Don't wait for the 5 min to be up. Cut the loss and move on.
  - Emergency stop still fires at 1% (flash crash protection)
  - Trade ALWAYS closes after exactly 5 minutes if hard stop didn't fire
  - Both stops post to Discord so you see exactly what happened

How the 5-minute hold works:
  - Enter position
  - Every 30 seconds check: has price moved 0.5% against us? → bail
  - If still open after 5 minutes → close regardless (win or lose)
  - Post result to Discord

Times (MST):
  Start: 6:45 AM MST (9:45 ET)
  Stop:  12:50 PM MST (3:50 ET)
"""

import time
import random
from datetime import datetime, timezone
import pytz

import config
import broker
import strategy
import database
from logger import (log, notify, notify_close,
                    notify_scan, notify_summary, notify_error)

ET = pytz.timezone("America/New_York")

_watchlist        = list(config.FALLBACK_TICKERS)
_positions        = {}
_shorting_enabled = False


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
    return _time_str() >= config.MARKET_CLOSE_ET


def _votes_to_emoji(votes: dict) -> str:
    labels = {
        "ema_trend":      "EMA",
        "higher_tf":      "HTF",
        "macd_cross":     "MACD",
        "macd_histogram": "MACDhist",
        "rsi_direction":  "RSIdir",
        "rsi_extreme":    "RSIext",
        "vwap_position":  "VWAP",
        "bollinger":      "BB",
        "obv_slope":      "OBV",
        "candle":         "Candle",
    }
    parts = []
    for key, label in labels.items():
        if key in votes:
            if votes[key] == "LONG":
                emoji = "🟢"
            elif votes[key] == "SHORT":
                emoji = "🔴"
            else:
                emoji = "⚪"
            parts.append(f"{label}{emoji}")
    return " ".join(parts)


def _notify_entry(ticker: str, direction: str, price: float,
                  long_votes: int, short_votes: int, votes: dict):
    emoji  = "🟢" if direction == "LONG" else "🔴"
    action = "LONG" if direction == "LONG" else "SHORT"
    msg = (
        f"{emoji} **{action} {ticker}** — ${config.MAX_TRADE_DOLLARS:.2f} @ ~${price:.2f}\n"
        f"Votes: {long_votes}L/{short_votes}S | {_votes_to_emoji(votes)}\n"
        f"Hard stop: {config.HARD_STOP_PCT*100:.1f}% | "
        f"Max hold: 5 min"
    )
    notify(msg)


def _open_position(ticker: str, direction: str, current_price: float,
                   long_votes: int, short_votes: int, votes: dict) -> bool:
    try:
        if direction == "LONG":
            broker.place_long(ticker, config.MAX_TRADE_DOLLARS)
        else:
            if not _shorting_enabled:
                log(f"[BOT] Shorting disabled — can't SHORT {ticker}, skipping")
                return False
            broker.place_short(ticker, config.MAX_TRADE_DOLLARS)

        _positions[ticker] = {
            "side":        direction,
            "entry_price": current_price,
            "dollars":     config.MAX_TRADE_DOLLARS,
            "entry_time":  datetime.now(timezone.utc),
        }
        database.save_position(
            ticker, direction, current_price,
            round(current_price * (1 - config.HARD_STOP_PCT), 4),
            round(current_price * 1.005, 4),
            config.MAX_TRADE_DOLLARS
        )
        _notify_entry(ticker, direction, current_price,
                      long_votes, short_votes, votes)
        log(f"[BOT] ✅ Opened {direction} {ticker} @ {current_price:.4f} "
            f"| {long_votes}L/{short_votes}S | hard stop={config.HARD_STOP_PCT*100:.1f}%")
        return True

    except Exception as e:
        notify_error(f"Order failed {ticker}: {e}")
        return False


def _close_position(ticker: str, current_price: float, reason: str):
    if ticker not in _positions:
        return

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
    notify_close(ticker, side, reason, pnl)

    sign = "+" if pnl >= 0 else ""
    log(f"[BOT] {'✅' if pnl >= 0 else '❌'} Closed {side} {ticker} "
        f"@ {current_price:.4f} | {reason} | P&L: {sign}${pnl:.4f}")


def _check_stops(ticker: str) -> bool:
    """
    Check both the hard stop (0.5%) and emergency stop (1%).
    Returns True if position was closed.

    Hard stop  — normal bad trade going the wrong way, cut it fast
    Emergency  — flash crash / sudden news spike, bail immediately
    """
    if ticker not in _positions:
        return False

    try:
        current_price = broker.get_latest_price(ticker)
    except Exception:
        return False

    state = _positions[ticker]
    entry = state["entry_price"]
    side  = state["side"]

    # How far has price moved against us?
    if side == "LONG":
        move_against = (entry - current_price) / entry
    else:
        move_against = (current_price - entry) / entry

    # Hard stop — 0.5% against us → bail, don't wait for 5 min
    if move_against >= config.HARD_STOP_PCT:
        loss = move_against * state["dollars"]
        log(f"[BOT] 🛑 HARD STOP — {ticker} moved {move_against:.2%} against {side} "
            f"(${loss:.4f} loss) — cutting now")
        _close_position(ticker, current_price, "HARD_STOP")
        return True

    # Emergency stop — 1% (flash crash)
    if move_against >= config.EMERGENCY_STOP_PCT:
        log(f"[BOT] ⚠️ EMERGENCY STOP — {ticker} {move_against:.2%} against {side}")
        _close_position(ticker, current_price, "EMERGENCY_STOP")
        return True

    # Log current P&L mid-hold so you can see it moving
    pnl_pct = -move_against if move_against > 0 else abs(move_against)
    log(f"[BOT] 👀 {ticker} {side} — currently "
        f"{'up' if move_against <= 0 else 'down'} {abs(move_against):.3%}")

    return False


def _run_5min_cycle():
    if _is_near_close():
        log("[BOT] Near market close — no new entries")
        return

    # Score both tickers
    best_ticker    = None
    best_direction = None
    best_margin    = -1
    best_long_v    = 0
    best_short_v   = 0
    best_votes     = {}
    best_price     = 0

    for ticker in _watchlist:
        try:
            df = broker.get_bars(ticker, config.BAR_TIMEFRAME, config.BAR_LIMIT)
        except Exception as e:
            log(f"[BOT] Bar fetch failed {ticker}: {e}")
            continue

        bar_count = len(df)
        log(f"[BOT] {ticker} — got {bar_count} bars")

        if bar_count < 20:
            log(f"[BOT] {ticker} — not enough bars ({bar_count}/20 needed) — skipping")
            continue

        result = strategy.get_vote_score(df, ticker)
        signal = result["signal"]
        price  = result["info"].get("close", 0)

        if signal == "HOLD":
            log(f"[BOT] {ticker} — {result['long_votes']}L/{result['short_votes']}S "
                f"(need {config.MIN_VOTE_SCORE}) — skipping")
            continue

        margin = abs(result["long_votes"] - result["short_votes"])

        if margin > best_margin or (margin == best_margin and margin > 0 and random.random() < 0.5):
            best_margin    = margin
            best_ticker    = ticker
            best_direction = signal
            best_long_v    = result["long_votes"]
            best_short_v   = result["short_votes"]
            best_votes     = result["votes"]
            best_price     = price

    if best_ticker is None:
        log("[BOT] ⏸️  No clear signal — skipping cycle")
        notify(f"⏸️ Skipped — need {config.MIN_VOTE_SCORE}/10 votes, "
               f"neither ticker qualified (min 20 bars)")
        return

    log(f"[BOT] 🎯 {best_direction} {best_ticker} @ {best_price:.2f} "
        f"| {best_long_v}L/{best_short_v}S votes")

    opened = _open_position(best_ticker, best_direction, best_price,
                             best_long_v, best_short_v, best_votes)
    if not opened:
        return

    # ── Hold loop ─────────────────────────────────────────────────────────────
    # Check every 30 seconds.
    # Hard stop fires if price moves 0.5% against us.
    # If we reach 5 minutes without stop firing — close it regardless.
    intervals = config.RUN_INTERVAL_SECS // 30   # 10 checks × 30s = 5 min

    for i in range(intervals):
        time.sleep(30)

        if best_ticker not in _positions:
            # Already closed by hard/emergency stop
            log(f"[BOT] Position closed early at check {i+1}/10")
            return

        stopped = _check_stops(best_ticker)
        if stopped:
            return

    # ── 5 minutes up — close regardless ──────────────────────────────────────
    if best_ticker in _positions:
        try:
            exit_price = broker.get_latest_price(best_ticker)
        except Exception:
            exit_price = best_price
            log("[BOT] Could not fetch exit price — using entry price as fallback")

        _close_position(best_ticker, exit_price, "5MIN_CLOSE")


def run():
    global _shorting_enabled, _positions

    database.init_db()

    # Close any leftover positions from restart
    _positions = database.load_positions()
    if _positions:
        notify(f"Restarted — closing {len(_positions)} leftover position(s)")
        for ticker in list(_positions.keys()):
            try:
                price = broker.get_latest_price(ticker)
                _close_position(ticker, price, "RESTART_CLOSE")
            except Exception as e:
                log(f"[BOT] Could not close {ticker} on restart: {e}")

    _shorting_enabled = broker.is_account_shorting_enabled()
    log(f"[BOT] Shorting enabled: {_shorting_enabled}")

    notify(
        "Winston v8 🎯 Polymarket Mode\n"
        f"SPY & QQQ | ${config.MAX_TRADE_DOLLARS:.0f}/trade | Every 5 min\n"
        f"Needs {config.MIN_VOTE_SCORE}/10 votes | "
        f"Hard stop at {config.HARD_STOP_PCT*100:.1f}%\n"
        "6:45 AM MST → 12:50 PM MST"
    )
    log("[BOT] Winston v8 started")

    summary_sent = False

    while True:
        try:
            if not _is_market_hours():
                log("[BOT] Outside market hours - sleeping.")
                notify("Bot is alive - outside market hours, sleeping.")
                summary_sent = False
                time.sleep(300)
                continue

            if _is_near_close() and not summary_sent:
                for ticker in list(_positions.keys()):
                    try:
                        price = broker.get_latest_price(ticker)
                        _close_position(ticker, price, "EOD_CLOSE")
                    except Exception as e:
                        log(f"[BOT] EOD close failed {ticker}: {e}")

                summary = database.get_summary()
                notify_summary(
                    summary["total_trades"],
                    summary["winning_trades"],
                    summary["total_pnl"]
                )
                summary_sent = True
                time.sleep(300)
                continue

            notify_scan(_watchlist)
            _run_5min_cycle()

            # Always sleep 5 minutes after a cycle — whether we traded or skipped.
            # Without this the loop fires hundreds of times per second on skip.
            log("[BOT] Cycle complete — waiting 5 min for next bar...")
            time.sleep(config.RUN_INTERVAL_SECS)

        except Exception as e:
            notify_error(str(e))
            log(f"[BOT] Unhandled error: {e}")
            time.sleep(30)


if __name__ == "__main__":
    run()
