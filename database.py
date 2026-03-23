"""
database.py — PostgreSQL persistence for Winston XRP

Tracks:
  - Open positions (survives restarts)
  - Trade history (for daily summaries)
"""

import psycopg2
from datetime import datetime, timezone
import config
from logger import log


def _conn():
    return psycopg2.connect(config.DATABASE_URL)


def init_db():
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS xrp_positions (
                    ticker TEXT PRIMARY KEY,
                    side TEXT NOT NULL,
                    entry_price DOUBLE PRECISION NOT NULL,
                    stop_price DOUBLE PRECISION,
                    target_price DOUBLE PRECISION,
                    dollars DOUBLE PRECISION NOT NULL,
                    base_size TEXT DEFAULT '',
                    entry_time TIMESTAMP DEFAULT NOW()
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS xrp_trades (
                    id SERIAL PRIMARY KEY,
                    ticker TEXT NOT NULL,
                    side TEXT NOT NULL,
                    entry_price DOUBLE PRECISION NOT NULL,
                    exit_price DOUBLE PRECISION NOT NULL,
                    dollars DOUBLE PRECISION NOT NULL,
                    pnl DOUBLE PRECISION NOT NULL,
                    reason TEXT NOT NULL,
                    entry_time TIMESTAMP,
                    exit_time TIMESTAMP DEFAULT NOW()
                )
            """)
        conn.commit()
    log("[DB] Tables ready.")


def save_position(ticker: str, side: str, entry_price: float,
                  stop_price: float, target_price: float,
                  dollars: float, base_size: str = ""):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO xrp_positions (ticker, side, entry_price, stop_price, target_price, dollars, base_size)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (ticker) DO UPDATE SET
                    side=EXCLUDED.side, entry_price=EXCLUDED.entry_price,
                    stop_price=EXCLUDED.stop_price, target_price=EXCLUDED.target_price,
                    dollars=EXCLUDED.dollars, base_size=EXCLUDED.base_size,
                    entry_time=NOW()
            """, (ticker, side, entry_price, stop_price, target_price, dollars, base_size))
        conn.commit()
    log(f"[DB] Saved {side} position for {ticker}")


def load_positions() -> dict:
    positions = {}
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT ticker, side, entry_price, dollars, base_size, entry_time FROM xrp_positions")
                for row in cur.fetchall():
                    positions[row[0]] = {
                        "side": row[1],
                        "entry_price": row[2],
                        "dollars": row[3],
                        "base_size": row[4] or "",
                        "entry_time": row[5],
                    }
    except Exception as e:
        log(f"[DB] Error loading positions: {e}")
    log(f"[DB] Loaded {len(positions)} open positions.")
    return positions


def delete_position(ticker: str):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM xrp_positions WHERE ticker = %s", (ticker,))
        conn.commit()


def record_trade(ticker: str, side: str, entry_price: float,
                 exit_price: float, dollars: float, pnl: float,
                 reason: str, entry_time=None):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO xrp_trades (ticker, side, entry_price, exit_price, dollars, pnl, reason, entry_time)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """, (ticker, side, entry_price, exit_price, dollars, pnl, reason, entry_time))
        conn.commit()


def get_summary() -> dict:
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT COUNT(*), COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0),
                       COALESCE(SUM(pnl), 0)
                FROM xrp_trades
                WHERE exit_time >= CURRENT_DATE
            """)
            row = cur.fetchone()
            return {
                "total_trades":   row[0],
                "winning_trades": row[1],
                "total_pnl":      row[2],
            }
