"""SQLite storage for usage samples + persisted config (poll interval)."""
from __future__ import annotations

import os
import sqlite3
import threading

DEFAULT_INTERVAL = 60
MIN_INTERVAL = 10
MAX_INTERVAL = 3600


class Store:
    def __init__(self, path: str):
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS samples ("
            "ts INTEGER PRIMARY KEY, fh REAL, sd REAL, so REAL, sn REAL, credits REAL)"
        )
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)"
        )
        # Codex columns (added later): cp/cs = primary/secondary window %, cc = credits.
        have = {r[1] for r in self._db.execute("PRAGMA table_info(samples)")}
        for col in ("cp", "cs", "cc"):
            if col not in have:
                self._db.execute(f"ALTER TABLE samples ADD COLUMN {col} REAL")
        self._db.commit()

    COLS = ("ts", "fh", "sd", "so", "sn", "credits", "cp", "cs", "cc")

    def insert(self, row: dict) -> None:
        vals = {c: row.get(c) for c in self.COLS}
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO samples (ts, fh, sd, so, sn, credits, cp, cs, cc) "
                "VALUES (:ts, :fh, :sd, :so, :sn, :credits, :cp, :cs, :cc)", vals,
            )
            self._db.commit()

    def history(self, since_ms: int | None = None, limit: int = 20000) -> list[dict]:
        cols = ", ".join(self.COLS)
        with self._lock:
            if since_ms is not None:
                cur = self._db.execute(
                    f"SELECT {cols} FROM samples WHERE ts >= ? ORDER BY ts", (since_ms,))
            else:
                cur = self._db.execute(
                    f"SELECT {cols} FROM samples ORDER BY ts DESC LIMIT ?", (limit,))
            rows = [dict(zip(self.COLS, r)) for r in cur.fetchall()]
        rows.sort(key=lambda r: r["ts"])
        return rows

    def get_interval(self) -> int:
        with self._lock:
            cur = self._db.execute("SELECT value FROM config WHERE key='interval'")
            r = cur.fetchone()
        return int(r[0]) if r else DEFAULT_INTERVAL

    def set_interval(self, seconds: int) -> int:
        seconds = max(MIN_INTERVAL, min(MAX_INTERVAL, int(seconds)))
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO config (key, value) VALUES ('interval', ?)",
                (str(seconds),))
            self._db.commit()
        return seconds
