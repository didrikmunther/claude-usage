"""SQLite storage for usage samples + persisted config (poll interval)."""
from __future__ import annotations

import os
import sqlite3
import threading

DEFAULT_INTERVAL = 60
# Default is "adaptive": it beat every other predictor on held-out history.
DEFAULT_FORECAST_MODEL = "adaptive"
# Every day, so the setting changes nothing until it is deliberately narrowed.
DEFAULT_WORKING_DAYS = "0,1,2,3,4,5,6"
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

    # Which predictor drives every forecast surface. Kept here, not in the
    # browser, because the floating pill runs in a web view with no persistent
    # storage — server-side is the only place both surfaces can read one value.
    FORECAST_MODELS = ("adaptive", "linear", "cycle", "cycle+tod")

    def get_forecast_model(self) -> str:
        with self._lock:
            cur = self._db.execute("SELECT value FROM config WHERE key='forecast_model'")
            r = cur.fetchone()
        return r[0] if r and r[0] in self.FORECAST_MODELS else DEFAULT_FORECAST_MODEL

    def set_forecast_model(self, model: str) -> str:
        if model not in self.FORECAST_MODELS:
            return self.get_forecast_model()
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO config (key, value) VALUES ('forecast_model', ?)",
                (model,))
            self._db.commit()
        return model

    # Local weekday numbers you work on (0 = Sunday). All seven = no effect.
    # Server-side for the same reason the forecast model is: the floating pill
    # has no persistent storage of its own.
    def get_working_days(self) -> str:
        with self._lock:
            cur = self._db.execute("SELECT value FROM config WHERE key='working_days'")
            r = cur.fetchone()
        return r[0] if r else DEFAULT_WORKING_DAYS

    def set_working_days(self, days: str) -> str:
        clean = ",".join(sorted({d for d in str(days).split(",") if d in "0123456" and d != ""}))
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO config (key, value) VALUES ('working_days', ?)",
                (clean,))
            self._db.commit()
        return clean

    # The newest release whose changelog this install has been shown. Absent until
    # the server first starts on a changelog-aware version, which seeds it.
    def get_changelog_seen(self) -> str | None:
        with self._lock:
            r = self._db.execute("SELECT value FROM config WHERE key='changelog_seen'").fetchone()
        return r[0] if r else None

    def set_changelog_seen(self, version: str) -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO config (key, value) VALUES ('changelog_seen', ?)",
                (version,))
            self._db.commit()

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
