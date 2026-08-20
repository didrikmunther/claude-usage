"""Local dashboard server for Claude usage.

- Reads the Keychain key ONCE at startup (this is the prompt you approve).
- Polls claude.ai /usage on a configurable interval in a background task.
- Stores samples in SQLite and broadcasts each new sample over WebSocket.
- Serves a single-page dashboard. Binds 127.0.0.1 only.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import os

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import ccost
import claude_cli
import codex_poller
import poller
from storage import Store, MIN_INTERVAL, MAX_INTERVAL

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
DB_PATH = os.path.expanduser("~/.claude-usage/usage.db")
HOST = os.environ.get("CLAUDE_USAGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("CLAUDE_USAGE_PORT", "8787"))
FETCH_TIMEOUT = 45      # hard cap on a single poll; guards against wake-from-sleep hangs

app = FastAPI(title="Claude Usage")


class Hub:
    """Shared state + the poll loop."""

    def __init__(self):
        self.key: bytes | None = None
        self.org: str = poller.DEFAULT_ORG
        self.claude_src: str | None = None   # "cli" | "desktop" | None
        self.store: Store | None = None
        self.interval: int = 60
        self.latest: dict | None = None
        self.codex_latest: dict | None = None
        self.codex_available: bool = False
        self.cc_latest: dict | None = None
        self.cc_available: bool = False
        self.status: dict = {"state": "starting", "message": None, "ts": None}
        self.clients: set[WebSocket] = set()
        self._wake = asyncio.Event()
        self._fail_streak = 0
        # Dedicated pool: a poll thread stuck across a sleep/wake can't starve
        # the rest of the app, and a couple of stuck workers are tolerated.
        self._pool = concurrent.futures.ThreadPoolExecutor(
            max_workers=3, thread_name_prefix="poll")

    def start(self):
        self.claude_src = self._pick_claude_source()
        self.codex_available = codex_poller.available()
        self.cc_available = ccost.available()
        self.store = Store(DB_PATH)
        self.interval = self.store.get_interval()

    def _pick_claude_source(self) -> str | None:
        """Prefer the Claude Code CLI's OAuth token (no desktop app, no cookies,
        no org id); fall back to the desktop cookie path if the CLI isn't set up."""
        if claude_cli.available():
            print("[claude] source: CLI OAuth token")
            return "cli"
        try:
            self.key = poller.get_keychain_key()   # prompts for Keychain
            self.org = poller.detect_org()
            print("[claude] source: desktop app cookies")
            return "desktop"
        except SystemExit as e:
            print(f"[claude] no usable source, skipping Claude polling: {e}")
            return None

    async def broadcast(self, msg: dict):
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_json(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    def set_interval(self, seconds: int) -> int:
        self.interval = self.store.set_interval(seconds)
        self._wake.set()          # apply immediately
        return self.interval

    def poll_now(self):
        self._wake.set()

    async def loop(self):
        while True:
            await self._poll_once()
            wait = self.interval
            if self._fail_streak:
                wait = min(MAX_INTERVAL, self.interval * (2 ** min(self._fail_streak, 5)))
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=wait)
            except asyncio.TimeoutError:
                pass
            self._wake.clear()

    def _fetch_claude(self, ts):
        if self.claude_src == "cli":
            raw = claude_cli.fetch_usage()
        else:
            raw = poller.fetch_usage(self.key, self.org)
        return poller.normalize(raw, ts)          # (row, live)

    @staticmethod
    def _errmsg(who, e):
        return f"{who}: " + ("timed out" if isinstance(e, asyncio.TimeoutError) else str(e))

    async def _poll_once(self):
        loop = asyncio.get_running_loop()
        ts = poller.now_ms()
        row = {"ts": ts}
        claude_live = codex_live = None
        errs = []

        if self.claude_src:
            try:
                crow, claude_live = await asyncio.wait_for(
                    loop.run_in_executor(self._pool, self._fetch_claude, ts),
                    timeout=FETCH_TIMEOUT)
                row.update(crow)
            except Exception as e:
                errs.append(self._errmsg("Claude", e))

        if self.codex_available:
            try:
                xrow, codex_live = await asyncio.wait_for(
                    loop.run_in_executor(self._pool, codex_poller.fetch, ts),
                    timeout=FETCH_TIMEOUT)
                row.update(xrow)
            except Exception as e:
                errs.append(self._errmsg("Codex", e))

        row["ts"] = ts                            # single timestamp for the combined row
        if claude_live or codex_live:
            self.store.insert(row)
            if claude_live:
                self.latest = claude_live
            if codex_live:
                self.codex_latest = codex_live
            self._fail_streak = 0
            self.status = {"state": "ok", "message": "; ".join(errs) or None, "ts": ts}
            await self.broadcast({"type": "sample", "claude": claude_live,
                                  "codex": codex_live, "status": self.status})
        else:
            self._fail_streak += 1
            self.status = {"state": "error", "message": "; ".join(errs) or "poll failed",
                           "ts": poller.now_ms()}
            await self.broadcast({"type": "status", "status": self.status})

        if self.cc_available:
            try:
                cc = await asyncio.wait_for(
                    loop.run_in_executor(self._pool, ccost.refresh),
                    timeout=FETCH_TIMEOUT)
                self.cc_latest = cc
                await self.broadcast({"type": "cc", "cc": cc})
            except Exception:
                pass


hub = Hub()


@app.on_event("startup")
async def _startup():
    hub.start()
    asyncio.create_task(hub.loop())


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC, "index.html"))


@app.get("/api/latest")
async def api_latest():
    return JSONResponse({"latest": hub.latest, "claude": hub.latest,
                         "codex": hub.codex_latest,
                         "codex_available": hub.codex_available,
                         "cc": hub.cc_latest, "cc_available": hub.cc_available,
                         "status": hub.status, "interval": hub.interval})


@app.get("/api/history")
async def api_history(since: int | None = None):
    return JSONResponse({"history": hub.store.history(since_ms=since)})


@app.websocket("/ws")
async def ws(sock: WebSocket):
    await sock.accept()
    hub.clients.add(sock)
    await sock.send_json({
        "type": "init",
        "history": hub.store.history(),
        "claude": hub.latest,
        "codex": hub.codex_latest,
        "codex_available": hub.codex_available,
        "cc": hub.cc_latest,
        "cc_available": hub.cc_available,
        "status": hub.status,
        "interval": hub.interval,
        "limits": {"min": MIN_INTERVAL, "max": MAX_INTERVAL},
    })
    try:
        while True:
            msg = await sock.receive_json()
            if "set_interval" in msg:
                n = hub.set_interval(msg["set_interval"])
                await hub.broadcast({"type": "interval", "interval": n})
            elif msg.get("poll_now"):
                hub.poll_now()
    except WebSocketDisconnect:
        pass
    finally:
        hub.clients.discard(sock)


app.mount("/static", StaticFiles(directory=STATIC), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
