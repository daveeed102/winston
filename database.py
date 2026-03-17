"""
database.py
Persistent trade storage using PostgreSQL.
Positions survive bot restarts. Full trade history stored.
"""

import psycopg2
import psycopg2.extras
from datetime import datetime
from config import DATABASE_URL
from logger import log


def _conn():
    return psycopg2.connect(DATABASE_URL, sslmode="require")


def init_db():
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS positions (
                    ticker       TEXT PRIMARY KEY,
                    side         TEXT NOT NULL,
                    entry_price  FLOAT NOT NULL,
                    stop_loss    FLOAT NOT NULL,
                    take_profit  FLOAT NOT NULL,
                    peak_price   FLOAT NOT NULL,
                    dollars      FLOAT NOT NULL,
                    entry_time   TIMESTAMP NOT NULL
                );
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS trade_history (
                    id           SERIAL PRIMARY KEY,
                    ticker       TEXT NOT NULL,
                    side         TEXT NOT NULL,
                    entry_price  FLOAT NOT NULL,
                    exit_price   FLOAT NOT NULL,
                    dollars      FLOAT NOT NULL,
                    pnl          FLOAT NOT NULL,
                    reason       TEXT NOT NULL,
                    entry_time   TIMESTAMP NOT NULL,
                    exit_time    TIMESTAMP NOT NULL
                );
            """)
        conn.commit()
    log("[DB] Tables ready.")


def save_position(ticker: str, side: str, entry_price: float,
                  stop_loss: float, take_profit: float, dollars: float):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO positions
                    (ticker, side, entry_price, stop_loss, take_profit,
                     peak_price, dollars, entry_time)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (ticker) DO UPDATE SET
                    side=EXCLUDED.side,
                    entry_price=EXCLUDED.entry_price,
                    stop_loss=EXCLUDED.stop_loss,
                    take_profit=EXCLUDED.take_profit,
                    peak_price=EXCLUDED.peak_price,
                    dollars=EXCLUDED.dollars,
                    entry_time=EXCLUDED.entry_time;
            """, (ticker, side, entry_price, stop_loss, take_profit,
                  entry_price, dollars, datetime.utcnow()))
        conn.commit()
    log(f"[DB] Saved {side} position for {ticker}")


def update_stop(ticker: str, peak_price: float, stop_loss: float):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE positions SET peak_price=%s, stop_loss=%s WHERE ticker=%s
            """, (peak_price, stop_loss, ticker))
        conn.commit()


def delete_position(ticker: str):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM positions WHERE ticker=%s", (ticker,))
        conn.commit()
    log(f"[DB] Removed position for {ticker}")


def load_positions() -> dict:
    positions = {}
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute("SELECT * FROM positions")
            rows = cur.fetchall()
    for row in rows:
        positions[row["ticker"]] = {
            "side":        row["side"],
            "entry_price": row["entry_price"],
            "stop_loss":   row["stop_loss"],
            "take_profit": row["take_profit"],
            "peak_price":  row["peak_price"],
            "dollars":     row["dollars"],
            "entry_time":  row["entry_time"],
        }
    log(f"[DB] Loaded {len(positions)} open positions.")
    return positions


def record_trade(ticker: str, side: str, entry_price: float, exit_price: float,
                 dollars: float, pnl: float, reason: str, entry_time):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO trade_history
                    (ticker, side, entry_price, exit_price, dollars,
                     pnl, reason, entry_time, exit_time)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (ticker, side, entry_price, exit_price, dollars,
                  pnl, reason, entry_time, datetime.utcnow()))
        conn.commit()


def get_summary() -> dict:
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT
                    COUNT(*),
                    COALESCE(SUM(pnl), 0),
                    COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0)
                FROM trade_history
                WHERE exit_time::date = CURRENT_DATE
            """)
            row = cur.fetchone()
    return {
        "total_trades":   row[0],
        "total_pnl":      row[1],
        "winning_trades": row[2],
    }
