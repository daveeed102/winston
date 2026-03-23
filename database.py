"""
database.py — PostgreSQL persistence for Winston v11 Degen Mode
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
                CREATE TABLE IF NOT EXISTS degen_holdings (
                    product_id TEXT PRIMARY KEY,
                    entry_price DOUBLE PRECISION NOT NULL,
                    dollars DOUBLE PRECISION NOT NULL,
                    base_size DOUBLE PRECISION NOT NULL,
                    entry_time TIMESTAMP DEFAULT NOW()
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS degen_trades (
                    id SERIAL PRIMARY KEY,
                    product_id TEXT NOT NULL,
                    entry_price DOUBLE PRECISION NOT NULL,
                    exit_price DOUBLE PRECISION NOT NULL,
                    dollars DOUBLE PRECISION NOT NULL,
                    pnl DOUBLE PRECISION NOT NULL,
                    pnl_pct DOUBLE PRECISION NOT NULL,
                    hold_hours DOUBLE PRECISION NOT NULL,
                    entry_time TIMESTAMP,
                    exit_time TIMESTAMP DEFAULT NOW()
                )
            """)
        conn.commit()
    log("[DB] Tables ready.")


def save_holding(product_id: str, entry_price: float, dollars: float, base_size: float):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO degen_holdings (product_id, entry_price, dollars, base_size)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (product_id) DO UPDATE SET
                    entry_price=EXCLUDED.entry_price, dollars=EXCLUDED.dollars,
                    base_size=EXCLUDED.base_size, entry_time=NOW()
            """, (product_id, entry_price, dollars, base_size))
        conn.commit()


def load_holdings() -> dict:
    holdings = {}
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT product_id, entry_price, dollars, base_size, entry_time FROM degen_holdings")
                for row in cur.fetchall():
                    holdings[row[0]] = {
                        "entry_price": row[1],
                        "dollars": row[2],
                        "base_size": row[3],
                        "entry_time": row[4],
                    }
    except Exception as e:
        log(f"[DB] Error loading holdings: {e}")
    log(f"[DB] Loaded {len(holdings)} holdings.")
    return holdings


def delete_holding(product_id: str):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM degen_holdings WHERE product_id = %s", (product_id,))
        conn.commit()


def clear_all_holdings():
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM degen_holdings")
        conn.commit()


def record_trade(product_id: str, entry_price: float, exit_price: float,
                 dollars: float, pnl: float, pnl_pct: float,
                 hold_hours: float, entry_time=None):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO degen_trades (product_id, entry_price, exit_price, dollars, pnl, pnl_pct, hold_hours, entry_time)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """, (product_id, entry_price, exit_price, dollars, pnl, pnl_pct, hold_hours, entry_time))
        conn.commit()


def get_daily_summary() -> dict:
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT COUNT(*), COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0),
                       COALESCE(SUM(pnl), 0)
                FROM degen_trades
                WHERE exit_time >= CURRENT_DATE
            """)
            row = cur.fetchone()
            return {
                "total_trades": row[0],
                "winning_trades": row[1],
                "total_pnl": row[2],
            }
