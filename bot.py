"""
bot.py — Winston v11 — AI Degen Mode

Every 6 hours:
  1. Sell whatever we're currently holding
  2. Ask Grok to pick 5 coins based on crypto Twitter hype
  3. Buy $10 of each pick ($50 total)
  4. Hold for 6 hours
  5. Repeat

Discord gets: what was picked, P&L when sold, cycle summary.
"""

import time
from datetime import datetime, timezone

import config
import broker
import grok
import database
from logger import (log, notify_picks, notify_sell, notify_cycle_summary,
                    notify_startup, notify_error)


_holdings = {}   # {product_id: {entry_price, dollars, base_size, entry_time}}


def _sell_all_holdings() -> list:
    """Sell everything we're holding. Returns list of results."""
    global _holdings
    results = []

    for product_id, holding in list(_holdings.items()):
        try:
            sell_result = broker.sell_coin(product_id)
            if sell_result:
                exit_price = sell_result["price"]
                entry_price = holding["entry_price"]
                dollars = holding["dollars"]

                if entry_price > 0:
                    pnl_pct = (exit_price - entry_price) / entry_price * 100
                    pnl = pnl_pct / 100 * dollars
                else:
                    pnl_pct = 0
                    pnl = 0

                # Calculate hold time
                entry_time = holding.get("entry_time", datetime.now(timezone.utc))
                if entry_time:
                    if hasattr(entry_time, 'tzinfo') and entry_time.tzinfo is None:
                        hold_secs = (datetime.utcnow() - entry_time).total_seconds()
                    else:
                        hold_secs = (datetime.now(timezone.utc) - entry_time).total_seconds()
                    hold_hours = hold_secs / 3600
                else:
                    hold_hours = config.HOLD_HOURS

                database.record_trade(
                    product_id, entry_price, exit_price,
                    dollars, pnl, pnl_pct, hold_hours, entry_time
                )
                database.delete_holding(product_id)

                notify_sell(product_id.replace("-USD", ""), pnl, pnl_pct)
                results.append({"coin": product_id.replace("-USD", ""), "pnl": pnl, "pnl_pct": pnl_pct})

                log(f"[BOT] Sold {product_id}: entry=${entry_price:.6f} exit=${exit_price:.6f} "
                    f"P&L={'+' if pnl >= 0 else ''}${pnl:.2f} ({'+' if pnl_pct >= 0 else ''}{pnl_pct:.1f}%)")
            else:
                log(f"[BOT] Failed to sell {product_id}")
                database.delete_holding(product_id)
        except Exception as e:
            log(f"[BOT] Error selling {product_id}: {e}")
            database.delete_holding(product_id)

    _holdings = {}
    return results


def _buy_picks(picks: list, reasons: dict):
    """Buy each pick."""
    global _holdings

    dollars_per = config.TOTAL_BANKROLL / len(picks)

    for product_id in picks:
        try:
            result = broker.buy_coin(product_id, dollars_per)
            if result:
                _holdings[product_id] = {
                    "entry_price": result["price"],
                    "dollars": dollars_per,
                    "base_size": result["base_size"],
                    "entry_time": datetime.now(timezone.utc),
                }
                database.save_holding(
                    product_id, result["price"], dollars_per, result["base_size"]
                )
                log(f"[BOT] Bought ${dollars_per:.2f} of {product_id} @ ${result['price']:.6f}")
            else:
                log(f"[BOT] Failed to buy {product_id} — skipping")
        except Exception as e:
            log(f"[BOT] Error buying {product_id}: {e}")

    log(f"[BOT] Holding {len(_holdings)} coins for {config.HOLD_HOURS} hours")


def _run_cycle():
    """One full cycle: sell old → pick new → buy → hold → repeat."""
    global _holdings

    # ── Step 1: Sell everything we're holding ────────────────────────────
    if _holdings:
        log(f"[BOT] Selling {len(_holdings)} holdings from previous cycle...")
        results = _sell_all_holdings()
        if results:
            total_pnl = sum(r["pnl"] for r in results)
            notify_cycle_summary(total_pnl, results)
    else:
        log("[BOT] No holdings to sell — fresh start")

    # ── Step 2: Check balance ────────────────────────────────────────────
    usd = broker.get_balance("USD")
    log(f"[BOT] USD balance: ${usd:.2f}")

    if usd < config.TOTAL_BANKROLL * 0.5:
        notify_error(f"Low balance: ${usd:.2f} — need ~${config.TOTAL_BANKROLL:.0f}")
        # Still try with what we have
        if usd < 5:
            log("[BOT] Balance too low to trade — waiting for next cycle")
            return

    # ── Step 3: Get available coins ──────────────────────────────────────
    available = broker.get_available_coins()
    if len(available) < 10:
        log("[BOT] Not enough tradeable coins found — retrying next cycle")
        return

    # ── Step 4: Ask Grok for picks ───────────────────────────────────────
    pick_result = grok.pick_coins(available)
    if not pick_result or not pick_result.get("picks"):
        log("[BOT] Grok returned no picks — retrying next cycle")
        notify_error("Grok couldn't pick coins — will retry in 30 min")
        time.sleep(1800)
        return

    picks = pick_result["picks"]
    reasons = pick_result["reasons"]

    # ── Step 5: Notify Discord ───────────────────────────────────────────
    notify_picks(
        [p.replace("-USD", "") for p in picks],
        {p.replace("-USD", ""): r for p, r in reasons.items()}
    )

    # ── Step 6: Buy ──────────────────────────────────────────────────────
    _buy_picks(picks, reasons)

    # ── Step 7: Hold ─────────────────────────────────────────────────────
    log(f"[BOT] 💎🙌 Holding for {config.HOLD_HOURS} hours...")
    checks = config.HOLD_SECS // config.CHECK_INTERVAL

    for i in range(checks):
        time.sleep(config.CHECK_INTERVAL)

        # Log portfolio status every 30 min
        if (i + 1) % 6 == 0:  # Every 6 checks = 30 min
            total_value = 0
            total_cost = 0
            for pid, h in _holdings.items():
                try:
                    current = broker.get_price(pid)
                    if h["entry_price"] > 0:
                        coin_pnl_pct = (current - h["entry_price"]) / h["entry_price"] * 100
                    else:
                        coin_pnl_pct = 0
                    total_value += h["dollars"] * (1 + coin_pnl_pct / 100)
                    total_cost += h["dollars"]
                    log(f"[BOT] 👀 {pid}: ${current:.6f} ({'+' if coin_pnl_pct >= 0 else ''}{coin_pnl_pct:.1f}%)")
                except Exception:
                    total_value += h["dollars"]
                    total_cost += h["dollars"]

            if total_cost > 0:
                total_pnl = total_value - total_cost
                log(f"[BOT] 📊 Portfolio: ${total_value:.2f} ({'+' if total_pnl >= 0 else ''}${total_pnl:.2f})")


def run():
    global _holdings

    database.init_db()

    # Load any existing holdings from previous run
    _holdings = database.load_holdings()
    if _holdings:
        log(f"[BOT] Found {len(_holdings)} holdings from previous run")

    usd = broker.get_balance("USD")
    notify_startup(
        f"🎰 Winston v11 — DEGEN MODE\n"
        f"${config.TOTAL_BANKROLL:.0f} across {config.NUM_PICKS} AI picks every {config.HOLD_HOURS}h\n"
        f"💰 Balance: ${usd:.2f} USD"
    )
    log("[BOT] Winston v11 Degen Mode started — LFG")

    while True:
        try:
            _run_cycle()
            log(f"[BOT] Cycle complete — next picks in {config.HOLD_HOURS} hours")
        except Exception as e:
            notify_error(str(e))
            log(f"[BOT] Unhandled error: {e}")
            time.sleep(300)


if __name__ == "__main__":
    run()
