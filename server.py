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
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import ccost
import codex_cost
import claude_cli
import codex_poller
import poller
import updater
from storage import Store, MIN_INTERVAL, MAX_INTERVAL

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
DB_PATH = os.path.expanduser("~/.claude-usage/usage.db")
HOST = os.environ.get("CLAUDE_USAGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("CLAUDE_USAGE_PORT", "8787"))
FETCH_TIMEOUT = 45      # hard cap on a single poll; guards against wake-from-sleep hangs
CLAUDE_MIN_INTERVAL = 300  # The CLI's oauth/usage endpoint is tightly (hourly)
                           # rate-limited and shared with Claude Code's own /usage
                           # calls, so poll it gently — the % meter barely moves.
UPDATE_CHECK_INTERVAL = 6 * 3600   # how often to look for a new release

app = FastAPI(title="Claude Usage")


def burn_rate(samples: list[dict], key: str, lookback_ms: int = 300_000) -> float:
    """%-points/hour over the trailing window (least-squares slope of `key`),
    clamped to 0. Mirrors the dashboard's recentSlope so the menu-bar gauge and
    the web gauge agree. `samples` are storage rows (ts in ms), ascending."""
    if not samples:
        return 0.0
    cut = samples[-1]["ts"] - lookback_ms
    pts = [(s["ts"] / 1000.0, s[key]) for s in samples
           if s.get(key) is not None and s["ts"] >= cut]
    if len(pts) < 3 or pts[-1][0] - pts[0][0] < 180:
        return 0.0
    n = len(pts)
    t0 = pts[0][0]
    sx = sy = sxx = sxy = 0.0
    for t, y in pts:
        x = t - t0
        sx += x; sy += y; sxx += x * x; sxy += x * y
    den = n * sxx - sx * sx
    if abs(den) < 1e-9:
        return 0.0
    return max(0.0, (n * sxy - sx * sy) / den * 3600.0)   # %/sec → %/hour




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
        self.xcost_latest: dict | None = None
        self.xcost_available: bool = False
        self.status: dict = {"state": "starting", "message": None, "ts": None}
        self.clients: set[WebSocket] = set()
        self._wake = asyncio.Event()
        self._fail_streak = 0
        # Claude's usage endpoint rate-limits independently of Codex, so it gets
        # its own cooldown: a 429 shouldn't be masked by a Codex success (which
        # would otherwise keep us hammering the limited endpoint every interval).
        self._claude_next = 0.0
        self._claude_streak = 0
        self.update_info: dict = {"current": updater.current_version(),
                                  "latest": None, "update_available": False}
        self._update_next = 0.0
        # Dedicated pool: a poll thread stuck across a sleep/wake can't starve
        # the rest of the app, and a couple of stuck workers are tolerated.
        self._pool = concurrent.futures.ThreadPoolExecutor(
            max_workers=3, thread_name_prefix="poll")

    def start(self):
        self.claude_src = self._pick_claude_source()
        self.codex_available = codex_poller.available()
        self.cc_available = ccost.available()
        self.xcost_available = codex_cost.available()
        self.store = Store(DB_PATH)
        self.interval = self.store.get_interval()

    def _pick_claude_source(self) -> str | None:
        """Prefer the desktop app's cookie endpoint — it tolerates fast (60s)
        polling. The CLI's api.anthropic.com/oauth/usage endpoint is burst-limited
        (429s under frequent polling), so it's the fallback for machines that
        don't have the desktop app."""
        if poller.desktop_available():
            try:
                self.key = poller.get_keychain_key()   # prompts for Keychain
                self.org = poller.detect_org()
                print("[claude] source: desktop app cookies")
                return "desktop"
            except SystemExit as e:
                print(f"[claude] desktop present but unusable ({e}); trying CLI")
        if claude_cli.available():
            print("[claude] source: CLI OAuth token (rate-limited; polled gently)")
            return "cli"
        print("[claude] no usable Claude source; skipping Claude polling")
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

    def rates(self) -> dict:
        """Per-platform burn rate (%/h) + dial fraction for the menu-bar gauge,
        each scaled to the window that platform is burning fastest relative to."""
        if not self.store:
            return {"claude_rate": 0.0, "codex_rate": 0.0, "claude_frac": 0.0, "codex_frac": 0.0}
        hist = self.store.history(since_ms=poller.now_ms() - 4 * 3600 * 1000)  # ≥ longest lookback
        cr = burn_rate(hist, "fh", lookback_ms=5 * 60 * 1000)     # Claude: 5-hour on a 0–100 dial
        cf = min(1.0, cr / 100.0)                                 # needle pegs at 100 %/h
        xr = burn_rate(hist, "cs", lookback_ms=168 * 60 * 1000)   # Codex: 7-day on a 0–8 dial
        xf = min(1.0, xr / 8.0)                                   # needle pegs at 8 %/h
        return {"claude_rate": round(cr, 1), "codex_rate": round(xr, 1),
                "claude_frac": round(cf, 3), "codex_frac": round(xf, 3)}

    async def check_update(self) -> dict:
        """Run the release check immediately (used by the 'Check for updates'
        button), store + broadcast the result, and reset the periodic timer."""
        loop = asyncio.get_running_loop()
        info = await asyncio.wait_for(
            loop.run_in_executor(self._pool, updater.check), timeout=FETCH_TIMEOUT)
        self.update_info = info
        self._update_next = time.time() + UPDATE_CHECK_INTERVAL
        await self.broadcast({"type": "update", "update": info})
        return info

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
            try:
                raw = poller.fetch_usage(self.key, self.org)
            except Exception as e:
                if "404" not in str(e):           # org not found → likely stale after
                    raise                         # an account/org switch; recover once
                self._recover_claude_404()
                raw = (claude_cli.fetch_usage() if self.claude_src == "cli"
                       else poller.fetch_usage(self.key, self.org))
        return poller.normalize(raw, ts)          # (row, live)

    def _recover_claude_404(self):
        """Desktop 404 = the org in the URL isn't accessible — almost always a
        stale org after the user switched accounts/orgs in the app. Re-detect the
        org; if it hasn't changed, fall back to the org-less CLI endpoint."""
        try:
            new_org = poller.detect_org()
        except SystemExit:
            new_org = None
        if new_org and new_org != self.org:
            print(f"[claude] org changed {self.org} → {new_org}; retrying desktop")
            self.org = new_org
            return
        if claude_cli.available():
            print("[claude] desktop 404 (org not found); switching to CLI OAuth")
            self.claude_src = "cli"

    @staticmethod
    def _errmsg(who, e):
        return f"{who}: " + ("timed out" if isinstance(e, asyncio.TimeoutError) else str(e))

    def _cooldown_claude(self, retry_after: int) -> str:
        """Back Claude off after a 429: honor retry-after when useful, else grow
        60s → 120 → 240 … capped at 15 min. Keeps the last known value showing."""
        self._claude_streak += 1
        wait = retry_after if retry_after and retry_after > 0 else min(
            900, 60 * (2 ** self._claude_streak))
        self._claude_next = time.time() + wait
        when = f"~{round(wait / 60)} min" if wait >= 120 else f"{int(wait)}s"
        return f"Claude usage paused {when} (rate limit)"

    async def _poll_once(self):
        loop = asyncio.get_running_loop()
        ts = poller.now_ms()
        row = {"ts": ts}
        claude_live = codex_live = None
        errs = []

        if self.claude_src and time.time() >= self._claude_next:
            try:
                crow, claude_live = await asyncio.wait_for(
                    loop.run_in_executor(self._pool, self._fetch_claude, ts),
                    timeout=FETCH_TIMEOUT)
                row.update(crow)
                self._claude_streak = 0
                # Desktop tolerates the UI interval; only throttle the CLI source.
                self._claude_next = time.time() + (
                    CLAUDE_MIN_INTERVAL if self.claude_src == "cli" else 0.0)
            except claude_cli.RateLimited as e:
                errs.append(self._cooldown_claude(e.retry_after))
            except Exception as e:
                if "429" in str(e):                       # desktop path 429s too
                    errs.append(self._cooldown_claude(0))
                else:
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

        if self.xcost_available:
            try:
                xc = await asyncio.wait_for(
                    loop.run_in_executor(self._pool, codex_cost.refresh),
                    timeout=FETCH_TIMEOUT)
                self.xcost_latest = xc
                await self.broadcast({"type": "xcost", "xcost": xc})
            except Exception:
                pass

        if time.time() >= self._update_next:
            self._update_next = time.time() + UPDATE_CHECK_INTERVAL
            try:
                info = await asyncio.wait_for(
                    loop.run_in_executor(self._pool, updater.check),
                    timeout=FETCH_TIMEOUT)
                self.update_info = info
                await self.broadcast({"type": "update", "update": info})
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
                         "xcost": hub.xcost_latest, "xcost_available": hub.xcost_available,
                         "update": hub.update_info, **hub.rates(),
                         "status": hub.status, "interval": hub.interval})


@app.post("/api/update")
async def api_update():
    info = hub.update_info
    tag = info.get("latest")
    if not info.get("update_available") or not tag:
        return JSONResponse({"ok": False, "error": "no update available"}, status_code=400)
    try:
        updater.spawn_apply(tag)                    # detached; restarts us shortly
        return JSONResponse({"ok": True, "applying": tag})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@app.post("/api/check-update")
async def api_check_update():
    try:
        return JSONResponse({"ok": True, "update": await hub.check_update()})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


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
        "xcost": hub.xcost_latest,
        "xcost_available": hub.xcost_available,
        "update": hub.update_info,
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
