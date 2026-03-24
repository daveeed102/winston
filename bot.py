"""
bot.py — Winston v12 — Smart Memecoin Bot

No timers. No forced sells. Pure momentum.

Loop every 3 minutes:
  1. Check existing positions for exit signals
     - Trailing stop (12% from peak)
     - Early stop (5% from entry)
     - Score dropped below 35
  2. If room for new positions, scan for opportunities
     - Pull trending data from CoinGecko + X
     - Score each candidate (0-100)
     - Always buys the top 2 scored candidates — never sits in cash
  3. Keep winners, cut losers, replace weak positions with stronger ones
"""

import time
from datetime import datetime, timezone

import config
import broker
import scanner
import scorer
import database
from logger import log, notify_buy, notify_sell, notify_startup, notify_error


_positions = {}    # {product_id: {entry_price, dollars, high_water, score_at_entry, entry_reason, entry_time}}
_last_rescore = 0  # Timestamp of last rescore


def _get_position_size(score: int) -> float:
    """Flat $20 per trade."""
    return config.POSITION_SIZE


def _get_grok_prediction(symbol: str, current_price: float, reason: str) -> str:
    """Ask Grok for a 12-hour price prediction. Returns a string for Discord."""
    if not config.GROK_API_KEY:
        return "Grok unavailable"

    try:
        import requests
        import json

        headers = {
            "Authorization": f"Bearer {config.GROK_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": config.GROK_MODEL,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You predict crypto prices. Give a specific dollar price prediction "
                        "and a one-sentence explanation. Respond with ONLY JSON:\n"
                        '{"predicted_price": <number>, "direction": "UP" or "DOWN", '
                        '"confidence": <0-100>, "explanation": "<one sentence>"}'
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"${symbol} is currently at ${current_price:.6f}.\n"
                        f"Momentum signals: {reason}\n"
                        f"Where will ${symbol} be in 12 hours? Give a specific price."
                    ),
                },
            ],
            "temperature": 0.4,
        }

        resp = requests.post(
            "https://api.x.ai/v1/chat/completions",
            headers=headers,
            json=payload,
            timeout=15,
        )
        data = resp.json()
        text = data["choices"][0]["message"]["content"].strip()
        text = text.replace("```json", "").replace("```", "").strip()

        result = json.loads(text)
        pred_price = float(result.get("predicted_price", current_price))
        direction = result.get("direction", "?")
        confidence = result.get("confidence", 0)
        explanation = result.get("explanation", "")

        pct_change = ((pred_price - current_price) / current_price) * 100 if current_price > 0 else 0
        sign = "+" if pct_change >= 0 else ""

        prediction_str = (
            f"Grok predicts ${pred_price:.6f} in 12h ({sign}{pct_change:.1f}%) "
            f"[{confidence}% confident] — {explanation}"
        )
        log(f"[GROK] {symbol}: {prediction_str}")
        return prediction_str

    except Exception as e:
        log(f"[GROK] Prediction failed for {symbol}: {e}")
        return "Grok prediction unavailable"


def _format_hold_time(entry_time) -> str:
    """Format hold time as human readable string."""
    if not entry_time:
        return "unknown"
    now = datetime.now(timezone.utc)
    if hasattr(entry_time, 'tzinfo') and entry_time.tzinfo is None:
        delta = (datetime.now(timezone.utc).replace(tzinfo=None) - entry_time).total_seconds()
    else:
        delta = (now - entry_time).total_seconds()

    if delta < 60:
        return f"{int(delta)}s"
    elif delta < 3600:
        return f"{int(delta/60)}m"
    elif delta < 86400:
        hours = int(delta / 3600)
        mins = int((delta % 3600) / 60)
        return f"{hours}h {mins}m"
    else:
        return f"{int(delta/86400)}d"


def _check_exits():
    """Check all positions for exit conditions. No forced sells — only smart exits."""
    global _positions, _last_rescore

    now = time.time()
    should_rescore = (now - _last_rescore) >= config.RESCORE_INTERVAL

    for product_id in list(_positions.keys()):
        pos = _positions[product_id]
        symbol = product_id.replace("-USD", "")

        try:
            current_price = broker.get_price(product_id)
        except Exception as e:
            log(f"[BOT] Price fetch failed for {product_id}: {e}")
            continue

        if current_price <= 0:
            continue

        entry_price = pos["entry_price"]
        high_water = pos["high_water"]

        # Update high water mark
        if current_price > high_water:
            high_water = current_price
            _positions[product_id]["high_water"] = high_water
            database.update_high_water(product_id, high_water)

        pnl_pct = (current_price - entry_price) / entry_price
        drawdown = (high_water - current_price) / high_water if high_water > 0 else 0

        # ── EXIT 1: Early stop loss (5% from entry) ─────────────────────
        if pnl_pct <= -config.EARLY_STOP_PCT:
            pnl = pnl_pct * pos["dollars"]
            hold_time = _format_hold_time(pos.get("entry_time"))
            log(f"[BOT] 🛑 EARLY STOP {symbol} — down {abs(pnl_pct):.1%}")
            _sell_position(product_id, current_price, "EARLY_STOP", pnl, pnl_pct * 100, hold_time)
            continue

        # ── EXIT 2: Trailing stop (12% from peak) ───────────────────────
        if pnl_pct > 0 and drawdown >= config.TRAILING_STOP_PCT:
            pnl = pnl_pct * pos["dollars"]
            hold_time = _format_hold_time(pos.get("entry_time"))
            log(f"[BOT] 📉 TRAILING STOP {symbol} — {drawdown:.1%} from peak ${high_water:.6f}")
            _sell_position(product_id, current_price, "TRAILING_STOP", pnl, pnl_pct * 100, hold_time)
            continue

        # ── EXIT 3: Score dropped (rescore every 5 min) ─────────────────
        if should_rescore:
            # Build a minimal candidate dict for rescoring
            rescore_candidate = {
                "symbol": symbol,
                "pct_1h": pnl_pct * 100,  # Approximate using our P&L
                "pct_24h": 0,
                "volume_24h": pos.get("volume_24h", 0),
                "market_cap": pos.get("market_cap", 0),
                "sources": pos.get("sources", []),
                "_cached_x_score": pos.get("_cached_x_score", 30),
            }
            result = scorer.score_token(rescore_candidate, skip_x=True)
            current_score = result["score"]

            if current_score < config.SCORE_DROP_EXIT:
                pnl = pnl_pct * pos["dollars"]
                hold_time = _format_hold_time(pos.get("entry_time"))
                log(f"[BOT] 📊 SCORE DROP {symbol} — score {current_score} < {config.SCORE_DROP_EXIT}")
                _sell_position(product_id, current_price, f"SCORE_DROP ({current_score})",
                             pnl, pnl_pct * 100, hold_time)
                continue

        # ── EXIT 4: Max hold time (12 hours) ─────────────────────────────
        entry_time = pos.get("entry_time")
        if entry_time:
            if hasattr(entry_time, 'tzinfo') and entry_time.tzinfo is None:
                held_secs = (datetime.now(timezone.utc).replace(tzinfo=None) - entry_time).total_seconds()
            else:
                held_secs = (datetime.now(timezone.utc) - entry_time).total_seconds()

            if held_secs >= config.MAX_HOLD_SECS:
                pnl = pnl_pct * pos["dollars"]
                hold_time = _format_hold_time(entry_time)
                log(f"[BOT] ⏰ MAX HOLD {symbol} — held {hold_time}, time to find something fresh")
                _sell_position(product_id, current_price, "MAX_HOLD_12H", pnl, pnl_pct * 100, hold_time)
                continue

        # ── Still holding — log status ───────────────────────────────────
        sign = "+" if pnl_pct >= 0 else ""
        peak_str = f" | peak ${high_water:.6f}" if pnl_pct > 0 else ""
        log(f"[BOT] 👀 {symbol} — {sign}{pnl_pct:.2%} (${pnl_pct * pos['dollars']:.2f}){peak_str}")

    if should_rescore:
        _last_rescore = now


def _sell_position(product_id: str, current_price: float, reason: str,
                   pnl: float, pnl_pct: float, hold_time: str):
    """Execute sell and record trade."""
    global _positions
    pos = _positions.get(product_id, {})
    symbol = product_id.replace("-USD", "")

    result = broker.sell_coin(product_id)
    if not result:
        log(f"[BOT] Sell failed for {product_id}")
        # Still remove from positions to avoid being stuck
        database.delete_position(product_id)
        del _positions[product_id]
        return

    entry_time = pos.get("entry_time")
    hold_secs = 0
    if entry_time:
        if hasattr(entry_time, 'tzinfo') and entry_time.tzinfo is None:
            hold_secs = int((datetime.now(timezone.utc).replace(tzinfo=None) - entry_time).total_seconds())
        else:
            hold_secs = int((datetime.now(timezone.utc) - entry_time).total_seconds())

    database.record_trade(
        product_id, pos.get("entry_price", 0), current_price,
        pos.get("dollars", 0), pnl, pnl_pct,
        pos.get("score_at_entry", 0), reason,
        pos.get("entry_reason", ""), hold_secs, entry_time,
    )
    database.delete_position(product_id)

    notify_sell(symbol, pnl, pnl_pct, reason, hold_time)
    del _positions[product_id]


def _scan_for_entries():
    """Scan for new opportunities if we have room."""
    global _positions

    if len(_positions) >= config.MAX_POSITIONS:
        return

    # Get available coins from Coinbase
    available = broker.get_available_coins()
    if not available:
        return

    # Discover candidates from trending data
    candidates = scanner.discover_candidates(available)
    if not candidates:
        log("[BOT] No candidates found this scan")
        return

    # Score each candidate
    scored = []
    for c in candidates:
        # Skip if we already hold it
        product_id = f"{c['symbol']}-USD"
        if product_id in _positions:
            continue

        # Skip if no price data at all
        if c.get("price", 0) <= 0:
            continue

        result = scorer.score_token(c)
        c["_score"] = result["score"]
        c["_reason"] = result["reason"]
        c["_breakdown"] = result["breakdown"]
        c["_cached_x_score"] = result.get("_cached_x_score", 30)
        scored.append(c)

    # Sort by score descending — ALWAYS buy the top picks, no threshold
    scored.sort(key=lambda x: x["_score"], reverse=True)

    if not scored:
        log("[BOT] No scoreable candidates this cycle")
        return

    # Buy the top candidates to fill our slots
    for c in scored:
        if len(_positions) >= config.MAX_POSITIONS:
            break

        symbol = c["symbol"]
        product_id = f"{symbol}-USD"
        score = c["_score"]
        dollars = _get_position_size(score)
        reason = c["_reason"]

        # Check balance
        usd = broker.get_balance("USD")
        if usd < dollars:
            log(f"[BOT] Not enough USD (${usd:.2f}) for ${dollars:.0f} trade")
            break

        # Get Grok's 12-hour price prediction for Discord
        grok_prediction = _get_grok_prediction(symbol, c.get("price", 0), reason)

        log(f"[BOT] 🎯 Buying {symbol} — score {score}/100 — ${dollars:.0f}")

        result = broker.buy_coin(product_id, dollars)
        if result:
            _positions[product_id] = {
                "entry_price": result["price"],
                "dollars": dollars,
                "high_water": result["price"],
                "score_at_entry": score,
                "entry_reason": reason,
                "entry_time": datetime.now(timezone.utc),
                "sources": c.get("sources", []),
                "_cached_x_score": c.get("_cached_x_score", 30),
                "volume_24h": c.get("volume_24h", 0),
                "market_cap": c.get("market_cap", 0),
            }
            database.save_position(product_id, result["price"], dollars,
                                  result["price"], score, reason)
            notify_buy(symbol, dollars, score, reason, grok_prediction)
        else:
            log(f"[BOT] Buy failed for {symbol}")


def run():
    global _positions

    database.init_db()
    _positions = database.load_positions()

    usd = broker.get_balance("USD")
    holding_str = ", ".join(p.replace("-USD", "") for p in _positions) or "none"
    notify_startup(
        f"🎰 Winston v12 — Smart Degen Mode\n"
        f"Max 2 positions | Always picks top 2 | Smart exits\n"
        f"Trailing stop: {config.TRAILING_STOP_PCT*100:.0f}% | "
        f"Early stop: {config.EARLY_STOP_PCT*100:.0f}%\n"
        f"💰 ${usd:.2f} USD | Holding: {holding_str}"
    )
    log("[BOT] Winston v12 started — scanning every 3 min")

    while True:
        try:
            # Always check exits first
            if _positions:
                _check_exits()

            # Then look for new entries
            _scan_for_entries()

            log(f"[BOT] Cycle done — holding {len(_positions)}/{config.MAX_POSITIONS} positions")
            time.sleep(config.SCAN_INTERVAL)

        except Exception as e:
            notify_error(str(e))
            log(f"[BOT] Error: {e}")
            time.sleep(60)


if __name__ == "__main__":
    run()
