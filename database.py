"""
database.py — PostgreSQL persistence for Winston v12
"""

import psycopg2
from logger import log
import config


def _conn():
    return psycopg2.connect(config.DATABASE_URL)


def init_db():
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS v12_positions (
                    product_id TEXT PRIMARY KEY,
                    entry_price DOUBLE PRECISION NOT NULL,
                    dollars DOUBLE PRECISION NOT NULL,
                    high_water DOUBLE PRECISION NOT NULL,
                    score_at_entry INT NOT NULL,
                    entry_reason TEXT DEFAULT '',
                    entry_time TIMESTAMP DEFAULT NOW()
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS v12_trades (
                    id SERIAL PRIMARY KEY,
                    product_id TEXT NOT NULL,
                    entry_price DOUBLE PRECISION NOT NULL,
                    exit_price DOUBLE PRECISION NOT NULL,
                    dollars DOUBLE PRECISION NOT NULL,
                    pnl DOUBLE PRECISION NOT NULL,
                    pnl_pct DOUBLE PRECISION NOT NULL,
                    entry_score INT,
                    exit_reason TEXT NOT NULL,
                    entry_reason TEXT DEFAULT '',
                    hold_seconds INT DEFAULT 0,
                    entry_time TIMESTAMP,
                    exit_time TIMESTAMP DEFAULT NOW()
                )
            """)
        conn.commit()
    log("[DB] Tables ready.")


def save_position(product_id, entry_price, dollars, high_water, score, reason):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO v12_positions (product_id, entry_price, dollars, high_water, score_at_entry, entry_reason)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (product_id) DO UPDATE SET
                    entry_price=EXCLUDED.entry_price, dollars=EXCLUDED.dollars,
                    high_water=EXCLUDED.high_water, score_at_entry=EXCLUDED.score_at_entry,
                    entry_reason=EXCLUDED.entry_reason, entry_time=NOW()
            """, (product_id, entry_price, dollars, high_water, score, reason))
        conn.commit()


def update_high_water(product_id, high_water):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE v12_positions SET high_water = %s WHERE product_id = %s",
                       (high_water, product_id))
        conn.commit()


def load_positions() -> dict:
    positions = {}
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT product_id, entry_price, dollars, high_water, score_at_entry, entry_reason, entry_time FROM v12_positions")
                for row in cur.fetchall():
                    positions[row[0]] = {
                        "entry_price": row[1],
                        "dollars": row[2],
                        "high_water": row[3],
                        "score_at_entry": row[4],
                        "entry_reason": row[5],
                        "entry_time": row[6],
                    }
    except Exception as e:
        log(f"[DB] Load error: {e}")
    log(f"[DB] Loaded {len(positions)} positions.")
    return positions


def delete_position(product_id):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM v12_positions WHERE product_id = %s", (product_id,))
        conn.commit()


def record_trade(product_id, entry_price, exit_price, dollars, pnl, pnl_pct,
                 entry_score, exit_reason, entry_reason, hold_seconds, entry_time):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO v12_trades
                (product_id, entry_price, exit_price, dollars, pnl, pnl_pct,
                 entry_score, exit_reason, entry_reason, hold_seconds, entry_time)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (product_id, entry_price, exit_price, dollars, pnl, pnl_pct,
                  entry_score, exit_reason, entry_reason, hold_seconds, entry_time))
        conn.commit()
