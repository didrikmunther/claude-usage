"""SQLite storage for usage samples + persisted config (poll interval)."""
from __future__ import annotations

import os
import sqlite3
import threading

DEFAULT_INTERVAL = 60
# Per provider, each the predictor that scored best on held-out history:
# "adaptive" on Claude's windows, "analog" on Codex's weekly one.
DEFAULT_FORECAST_MODEL = "adaptive"
DEFAULT_FORECAST_MODELS = {"claude": "adaptive", "codex": "analog"}
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
        # kh/kd = the CLI's 5-hour / 7-day %, tracked next to the desktop app's.
        for col in ("cp", "cs", "cc", "kh", "kd"):
            if col not in have:
                self._db.execute(f"ALTER TABLE samples ADD COLUMN {col} REAL")
        self._db.commit()

    COLS = ("ts", "fh", "sd", "so", "sn", "credits", "cp", "cs", "cc", "kh", "kd")

    def insert(self, row: dict) -> None:
        vals = {c: row.get(c) for c in self.COLS}
        with self._lock:
            self._db.execute(
                f"INSERT OR REPLACE INTO samples ({', '.join(self.COLS)}) "
                f"VALUES ({', '.join(':' + c for c in self.COLS)})", vals,
            )
            self._db.commit()

    def history(self, since_ms: int | None = None, limit: int = 20000,
                until_ms: int | None = None) -> list[dict]:
        cols = ", ".join(self.COLS)
        with self._lock:
            if since_ms is not None:
                cur = self._db.execute(
                    f"SELECT {cols} FROM samples WHERE ts >= ? AND ts <= ? "
                    f"ORDER BY ts LIMIT ?",
                    (since_ms, until_ms if until_ms is not None else 2**62, limit))
            else:
                cur = self._db.execute(
                    f"SELECT {cols} FROM samples ORDER BY ts DESC LIMIT ?", (limit,))
            rows = [dict(zip(self.COLS, r)) for r in cur.fetchall()]
        rows.sort(key=lambda r: r["ts"])
        return rows

    def history_overview(self, full_since_ms: int, bucket_ms: int) -> list[dict]:
        """All history in a size that loads fast: every sample from
        `full_since_ms` on, and before that the last sample of each `bucket_ms`
        slot. The dashboard fetches full detail for an older stretch when you
        zoom into it (history(since_ms, until_ms=...))."""
        cols = ", ".join(self.COLS)
        older = ", ".join(["MAX(ts) AS ts"] + [c for c in self.COLS if c != "ts"])
        with self._lock:
            # SQLite takes the bare columns from the row that holds MAX(ts),
            # i.e. each slot's last sample.
            cur = self._db.execute(
                f"SELECT {cols} FROM (SELECT {older} FROM samples WHERE ts < ? "
                f"GROUP BY ts / ?) UNION ALL SELECT {cols} FROM samples WHERE ts >= ? "
                f"ORDER BY ts", (full_since_ms, bucket_ms, full_since_ms))
            return [dict(zip(self.COLS, r)) for r in cur.fetchall()]

    # Which predictor drives the forecasts, one per provider: usage patterns
    # differ enough that the best model differs too. Kept here, not in the
    # browser, because the floating pill runs in a web view with no persistent
    # storage — server-side is the only place both surfaces can read one value.
    FORECAST_MODELS = ("adaptive", "linear", "cycle", "cycle+tod", "analog")
    # Claude keeps the original key, so an existing choice carries over.
    _MODEL_KEYS = {"claude": "forecast_model", "codex": "forecast_model_codex"}

    def get_forecast_model(self, provider: str = "claude") -> str:
        key = self._MODEL_KEYS.get(provider, "forecast_model")
        with self._lock:
            r = self._db.execute("SELECT value FROM config WHERE key=?", (key,)).fetchone()
        if r and r[0] in self.FORECAST_MODELS:
            return r[0]
        return DEFAULT_FORECAST_MODELS.get(provider, DEFAULT_FORECAST_MODEL)

    def set_forecast_model(self, model: str, provider: str = "claude") -> str:
        if model not in self.FORECAST_MODELS or provider not in self._MODEL_KEYS:
            return self.get_forecast_model(provider)
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
                (self._MODEL_KEYS[provider], model))
            self._db.commit()
        return model

    # Which Claude the dashboard, widget and menu bar show when the desktop app
    # and the CLI are both tracked. Server-side so the menu bar can follow it.
    CLAUDE_ACCOUNTS = ("desktop", "cli")

    def get_claude_account(self) -> str:
        with self._lock:
            r = self._db.execute(
                "SELECT value FROM config WHERE key='claude_account'").fetchone()
        return r[0] if r and r[0] in self.CLAUDE_ACCOUNTS else "desktop"

    def set_claude_account(self, acct: str) -> str:
        if acct not in self.CLAUDE_ACCOUNTS:
            return self.get_claude_account()
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO config (key, value) VALUES ('claude_account', ?)",
                (acct,))
            self._db.commit()
        return acct

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
