import sqlite3
import csv
import logging
from dataclasses import asdict
from .models import Business

log = logging.getLogger("scraper.db")

def init_db(db_path: str) -> sqlite3.Connection:
    """Create (or open) the SQLite database and ensure the schema exists."""
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS businesses (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            name     TEXT,
            address  TEXT,
            phone    TEXT,
            email    TEXT,
            website  TEXT,
            rating   TEXT,
            reviews  TEXT,
            category TEXT,
            maps_url TEXT UNIQUE,
            is_lead  INTEGER DEFAULT 0
        )
    """)
    conn.commit()
    return conn


def save_to_db(conn: sqlite3.Connection, biz: Business) -> None:
    """
    Upsert a Business record.
    """
    try:
        conn.execute(
            """
            INSERT INTO businesses
                (name, address, phone, email, website, rating, reviews, category, maps_url, is_lead)
            VALUES
                (:name, :address, :phone, :email, :website, :rating, :reviews, :category, :maps_url, :is_lead)
            ON CONFLICT(maps_url) DO UPDATE SET
                name     = excluded.name,
                address  = excluded.address,
                phone    = excluded.phone,
                email    = excluded.email,
                website  = excluded.website,
                rating   = excluded.rating,
                reviews  = excluded.reviews,
                category = excluded.category,
                is_lead  = excluded.is_lead
            """,
            {**asdict(biz), "is_lead": int(biz.is_lead)},
        )
        conn.commit()
    except sqlite3.Error as exc:
        log.error("DB write error: %s", exc)


def export_csv(conn: sqlite3.Connection, csv_path: str) -> int:
    """Write all leads (no website) to a CSV file.  Returns row count."""
    cursor = conn.execute(
        "SELECT name, address, phone, email, rating, reviews, category, maps_url "
        "FROM businesses WHERE is_lead = 1 ORDER BY name"
    )
    rows = cursor.fetchall()
    headers = ["name", "address", "phone", "email", "rating", "reviews", "category", "maps_url"]
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        for row in rows:
            writer.writerow(dict(zip(headers, row)))
    return len(rows)
