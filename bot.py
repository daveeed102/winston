"""
bot.py — Winston v10 — XRP Momentum Bot

24/7 XRP trading on Coinbase with:
  - 2-minute scan interval
  - Momentum-confirmed entries (v9 strategy engine)
  - Trailing stop to let winners run
  - Hard stop at 1.2% to cut losers fast
  - 10-minute max hold time
  - Discord alerts for everything
"""

import time
from datetime import datetime, timezone

import config
import broker
import strategy
import database
from logger import log, notify, notify_close, notify_scan, notify_summary, notify_error


_position     = {}     # Current open position (max 1)
_high_water   = 0.0    # Highest price since entry (for trailing stop)
_daily_trades = 0


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


def _open_position(price: float, long_votes: int, short_votes: int, votes: dict) -> bool:
    global _position, _high_water

    try:
        # Check we have enough USD
        usd_balance = broker.get_balance("USD")
        if usd_balance < config.MAX_TRADE_DOLLARS:
            log(f"[BOT] Insufficient USD balance: ${usd_balance:.2f} < ${config.MAX_TRADE_DOLLARS:.2f}")
            notify(f"⚠️ Can't trade — only ${usd_balance:.2f} available (need ${config.MAX_TRADE_DOLLARS:.2f})")
            return False

        order_id = broker.place_buy(config.PRODUCT_ID, config.MAX_TRADE_DOLLARS)

        # Calculate how much XRP we got (approximate)
        base_size = f"{config.MAX_TRADE_DOLLARS / price:.6f}"

        _position = {
            "side":        "LONG",
            "entry_price": price,
            "dollars":     config.MAX_TRADE_DOLLARS,
            "base_size":   base_size,
            "entry_time":  datetime.now(timezone.utc),
            "order_id":    order_id,
        }
        _high_water = price

        database.save_position(
            config.PRODUCT_ID, "LONG", price,
            round(price * (1 - config.HARD_STOP_PCT), 6),
            round(price * (1 + config.TRAIL_ACTIVATE_PCT), 6),
            config.MAX_TRADE_DOLLARS,
            base_size,
        )

        emoji_str = _votes_to_emoji(votes)
        msg = (
            f"🟢 **LONG {config.PRODUCT_ID}** — ${config.MAX_TRADE_DOLLARS:.2f} @ ~${price:.4f}\n"
            f"Votes: {long_votes}L/{short_votes}S | {emoji_str}\n"
            f"Hard stop: {config.HARD_STOP_PCT*100:.1f}% | "
            f"Trail: {config.TRAIL_DISTANCE_PCT*100:.1f}% after {config.TRAIL_ACTIVATE_PCT*100:.1f}% profit | "
            f"Max hold: {config.MAX_HOLD_SECS//60} min"
        )
        notify(msg)

        log(f"[BOT] ✅ Opened LONG {config.PRODUCT_ID} @ {price:.4f} "
            f"| {long_votes}L/{short_votes}S | hard stop={config.HARD_STOP_PCT*100:.1f}%")
        return True

    except Exception as e:
        notify_error(f"Order failed: {e}")
        return False


def _close_position(current_price: float, reason: str):
    global _position

    if not _position:
        return

    entry = _position["entry_price"]
    pnl   = (current_price - entry) / entry * _position["dollars"]

    try:
        broker.sell_all(config.PRODUCT_ID)
    except Exception as e:
        log(f"[BOT] Sell failed: {e}")
        # Try to get the actual base_size from balance
        try:
            xrp_balance = broker.get_balance("XRP")
            if xrp_balance > 0:
                broker.place_sell(config.PRODUCT_ID, f"{xrp_balance:.6f}")
        except Exception as e2:
            notify_error(f"Emergency sell also failed: {e2}")

    database.record_trade(
        config.PRODUCT_ID, "LONG", entry, current_price,
        _position["dollars"], pnl, reason, _position["entry_time"]
    )
    database.delete_position(config.PRODUCT_ID)

    notify_close(config.PRODUCT_ID, "LONG", reason, pnl)
    sign = "+" if pnl >= 0 else ""
    log(f"[BOT] {'✅' if pnl >= 0 else '❌'} Closed LONG {config.PRODUCT_ID} "
        f"@ {current_price:.4f} | {reason} | P&L: {sign}${pnl:.4f}")

    _position = {}


def _hold_loop():
    """
    Monitor position every 15 seconds.
    - Hard stop: bail at 1.2% loss
    - Emergency stop: bail at 2.5% loss
    - Trailing stop: once up 0.5%, trail 0.4% behind peak
    - Max hold: close after 10 minutes regardless
    """
    global _high_water

    if not _position:
        return

    entry     = _position["entry_price"]
    intervals = config.MAX_HOLD_SECS // config.HOLD_CHECK_SECS
    trailing_active = False

    for i in range(intervals):
        time.sleep(config.HOLD_CHECK_SECS)

        if not _position:
            log(f"[BOT] Position already closed at check {i+1}/{intervals}")
            return

        try:
            current_price = broker.get_latest_price(config.PRODUCT_ID)
        except Exception as e:
            log(f"[BOT] Price fetch failed: {e}")
            continue

        # Update high water mark
        if current_price > _high_water:
            _high_water = current_price

        move_pct   = (current_price - entry) / entry
        from_peak  = (_high_water - current_price) / _high_water if _high_water > 0 else 0

        # ── Emergency stop (2.5%) ────────────────────────────────────────
        if move_pct <= -config.EMERGENCY_STOP_PCT:
            log(f"[BOT] ⚠️ EMERGENCY STOP — {config.PRODUCT_ID} down {abs(move_pct):.2%}")
            _close_position(current_price, "EMERGENCY_STOP")
            return

        # ── Hard stop (1.2%) ─────────────────────────────────────────────
        if move_pct <= -config.HARD_STOP_PCT:
            loss = abs(move_pct) * _position["dollars"]
            log(f"[BOT] 🛑 HARD STOP — {config.PRODUCT_ID} down {abs(move_pct):.2%} "
                f"(${loss:.4f} loss)")
            _close_position(current_price, "HARD_STOP")
            return

        # ── Trailing stop ────────────────────────────────────────────────
        if move_pct >= config.TRAIL_ACTIVATE_PCT:
            if not trailing_active:
                trailing_active = True
                log(f"[BOT] 📈 Trailing stop ACTIVATED — up {move_pct:.2%}, "
                    f"will trail {config.TRAIL_DISTANCE_PCT*100:.1f}% behind peak")

            if from_peak >= config.TRAIL_DISTANCE_PCT:
                profit = move_pct * _position["dollars"]
                log(f"[BOT] 📉 TRAILING STOP — peaked at ${_high_water:.4f}, "
                    f"now ${current_price:.4f} ({from_peak:.2%} from peak)")
                _close_position(current_price, "TRAILING_STOP")
                return

        # ── Log status ───────────────────────────────────────────────────
        status = "up" if move_pct >= 0 else "down"
        trail_str = f" | trailing={from_peak:.2%} from peak" if trailing_active else ""
        log(f"[BOT] 👀 {config.PRODUCT_ID} — {status} {abs(move_pct):.3%} "
            f"(${move_pct * _position['dollars']:.4f}){trail_str}")

    # ── Max hold time reached ────────────────────────────────────────────
    if _position:
        try:
            exit_price = broker.get_latest_price(config.PRODUCT_ID)
        except Exception:
            exit_price = entry
            log("[BOT] Could not fetch exit price — using entry as fallback")

        _close_position(exit_price, "MAX_HOLD")


def _run_cycle():
    """Run one scan + potential trade cycle."""
    global _position

    # Don't enter if we already have a position
    if _position:
        log("[BOT] Already in a position — skipping scan")
        return

    try:
        df = broker.get_candles(config.PRODUCT_ID)
    except Exception as e:
        log(f"[BOT] Candle fetch failed: {e}")
        return

    bar_count = len(df)
    log(f"[BOT] {config.PRODUCT_ID} — got {bar_count} candles")

    if bar_count < 30:
        log(f"[BOT] Not enough candles ({bar_count}/30) — skipping")
        return

    result = strategy.get_vote_score(df, config.PRODUCT_ID)
    signal = result["signal"]
    price  = result["info"].get("close", 0)

    if signal != "LONG":
        log(f"[BOT] ⏸️ No signal — {result['long_votes']}L/{result['short_votes']}S "
            f"(need {config.MIN_VOTE_SCORE})")
        notify(f"⏸️ Skipped — {result['long_votes']}L/{result['short_votes']}S "
               f"(need {config.MIN_VOTE_SCORE} + momentum confirmation)")
        return

    # Get real-time price for entry
    try:
        entry_price = broker.get_latest_price(config.PRODUCT_ID)
    except Exception:
        entry_price = price

    log(f"[BOT] 🎯 LONG {config.PRODUCT_ID} @ {entry_price:.4f} "
        f"| {result['long_votes']}L/{result['short_votes']}S")

    opened = _open_position(entry_price, result["long_votes"],
                            result["short_votes"], result["votes"])
    if opened:
        _hold_loop()


def run():
    global _position

    database.init_db()

    # Load any leftover position from restart
    positions = database.load_positions()
    if config.PRODUCT_ID in positions:
        _position = positions[config.PRODUCT_ID]
        notify(f"Restarted — found open {config.PRODUCT_ID} position, closing it")
        try:
            price = broker.get_latest_price(config.PRODUCT_ID)
            _close_position(price, "RESTART_CLOSE")
        except Exception as e:
            log(f"[BOT] Could not close on restart: {e}")
            # Try selling whatever XRP we have
            try:
                broker.sell_all(config.PRODUCT_ID)
                database.delete_position(config.PRODUCT_ID)
                _position = {}
            except Exception as e2:
                log(f"[BOT] Emergency sell on restart also failed: {e2}")

    # Get starting balance
    usd_balance = broker.get_balance("USD")
    xrp_balance = broker.get_balance("XRP")

    notify(
        "Winston v10 🚀 XRP Momentum Mode\n"
        f"XRP-USD | ${config.MAX_TRADE_DOLLARS:.0f}/trade | Every {config.SCAN_INTERVAL_SECS//60} min\n"
        f"Needs {config.MIN_VOTE_SCORE}/10 votes + momentum confirmation\n"
        f"Hard stop: {config.HARD_STOP_PCT*100:.1f}% | "
        f"Trail: {config.TRAIL_DISTANCE_PCT*100:.1f}% after {config.TRAIL_ACTIVATE_PCT*100:.1f}% profit\n"
        f"Max hold: {config.MAX_HOLD_SECS//60} min | ADX threshold: {config.ADX_THRESHOLD}\n"
        f"💰 Balance: ${usd_balance:.2f} USD | {xrp_balance:.4f} XRP"
    )
    log("[BOT] Winston v10 XRP started — 24/7 mode")

    last_summary_hour = -1

    while True:
        try:
            # Send daily summary at midnight UTC
            now = datetime.now(timezone.utc)
            if now.hour == 0 and last_summary_hour != 0:
                summary = database.get_summary()
                notify_summary(
                    summary["total_trades"],
                    summary["winning_trades"],
                    summary["total_pnl"],
                )
                last_summary_hour = 0
            elif now.hour != 0:
                last_summary_hour = now.hour

            # Run a scan cycle
            notify_scan([config.PRODUCT_ID])
            _run_cycle()

            # Wait for next scan
            log(f"[BOT] Cycle complete — waiting {config.SCAN_INTERVAL_SECS}s...")
            time.sleep(config.SCAN_INTERVAL_SECS)

        except Exception as e:
            notify_error(str(e))
            log(f"[BOT] Unhandled error: {e}")
            time.sleep(30)


if __name__ == "__main__":
    run()
