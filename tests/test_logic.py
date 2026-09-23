"""Unit tests for the pure logic: normalize() against a real /usage fixture,
and the storage round-trip. No network / Keychain / curl_cffi required."""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import datetime  # noqa: E402

from poller import normalize  # noqa: E402
from storage import Store, DEFAULT_INTERVAL, MIN_INTERVAL, MAX_INTERVAL  # noqa: E402
from menubar_fmt import pct, hours_until, title_for  # noqa: E402
from updater import parse_version, pick_latest, is_newer  # noqa: E402

FIXTURE = json.load(open(os.path.join(os.path.dirname(__file__), "fixture_usage.json")))


def test_normalize_scalars():
    row, live = normalize(FIXTURE, ts=1000)
    assert row == {"ts": 1000, "fh": 35.0, "sd": 23.0, "so": None, "sn": None, "credits": 0.0}


def test_normalize_live_extras():
    _, live = normalize(FIXTURE, ts=1000)
    assert live["resets"]["five_hour"].startswith("2026-08-14T09:00")
    assert live["resets"]["seven_day"].startswith("2026-08-17T18:00")
    assert live["extra_usage"]["used_credits"] == 0.0
    assert len(live["limits"]) == 3
    # weekly_scoped carries the per-model name
    assert any(l.get("scope", {}) and l["scope"]["model"]["display_name"] == "Fable"
               for l in live["limits"])


def test_normalize_handles_missing_and_null_buckets():
    row, live = normalize({}, ts=5)
    assert row == {"ts": 5, "fh": None, "sd": None, "so": None, "sn": None, "credits": None}
    assert live["limits"] == []


def test_store_roundtrip():
    with tempfile.TemporaryDirectory() as d:
        s = Store(os.path.join(d, "u.db"))
        assert s.get_interval() == DEFAULT_INTERVAL
        for ts, fh in ((100, 10.0), (200, 20.0), (300, 30.0)):
            s.insert({"ts": ts, "fh": fh, "sd": 5.0, "so": None, "sn": None, "credits": 0.0})
        hist = s.history()
        assert [h["ts"] for h in hist] == [100, 200, 300]
        assert hist[-1]["fh"] == 30.0
        assert [h["ts"] for h in s.history(since_ms=200)] == [200, 300]


def test_store_interval_clamped_and_persisted():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "u.db")
        s = Store(path)
        assert s.set_interval(5) == MIN_INTERVAL       # clamp low
        assert s.set_interval(999999) == MAX_INTERVAL  # clamp high
        assert s.set_interval(120) == 120
        assert Store(path).get_interval() == 120       # persisted across instances


# --- menu-bar title formatting ---
_BASE = datetime.datetime(2026, 1, 1, 10, 0, tzinfo=datetime.timezone.utc)


def test_pct():
    assert pct(None) == "–"
    assert pct(0) == "0%"
    assert pct(34.6) == "35%"


def test_hours_until():
    plus = lambda **k: (_BASE + datetime.timedelta(**k)).isoformat()
    assert hours_until(plus(hours=4, minutes=6), now=_BASE) == "4.1"
    assert hours_until(plus(hours=4), now=_BASE) == "4"          # trailing .0 dropped
    assert hours_until(plus(hours=-1), now=_BASE) == "0"         # past -> clamped
    assert hours_until(None) is None


def test_title_for():
    reset = (_BASE + datetime.timedelta(hours=4, minutes=6)).isoformat()
    assert title_for({"fh": 35.0, "resets": {"five_hour": reset}}, now=_BASE) == "35%4.1h"
    assert title_for({"fh": 35.0, "resets": {}}, now=_BASE) == "35%"   # no reset -> pct only
    assert title_for({"fh": None}) == "—"
    assert title_for(None) == "—"


def test_parse_version():
    assert parse_version("v1.2.3") == (1, 2, 3)
    assert parse_version("1.2.3") == (1, 2, 3)
    assert parse_version(" v0.10.0 ") == (0, 10, 0)
    assert parse_version("v1.2") is None          # not full semver
    assert parse_version("v1.2.3-rc1") is None    # pre-release ignored
    assert parse_version("nightly") is None
    assert parse_version(None) is None


def test_pick_latest():
    assert pick_latest(["v1.0.0", "v1.2.0", "v1.1.5"]) == "v1.2.0"
    assert pick_latest(["v0.9.0", "v0.10.0"]) == "v0.10.0"   # numeric, not lexical
    assert pick_latest(["v1.0.0", "garbage", "v2.0.0-rc1"]) == "v1.0.0"
    assert pick_latest(["nope", "still-nope"]) is None
    assert pick_latest([]) is None


def test_apply_status_reports_what_the_updater_wrote():
    # The page waiting for a restart reads this; a refusal must reach it.
    import updater
    with tempfile.TemporaryDirectory() as d:
        updater.STATUS_FILE = os.path.join(d, "update-status")
        assert updater.apply_status() == {"state": "idle", "message": ""}   # never ran
        with open(updater.STATUS_FILE, "w") as fh:
            fh.write("fail\tthis copy has local edits\n")
        assert updater.apply_status() == {"state": "fail",
                                          "message": "this copy has local edits"}
        with open(updater.STATUS_FILE, "w") as fh:
            fh.write("ok\tv1.2.3\n")
        assert updater.apply_status()["state"] == "ok"


def test_burn_rate():
    from server import burn_rate                    # imported here: pulls in FastAPI app
    base = 1_000_000
    rising = [{"ts": base + i * 60_000, "fh": 30.0 + i} for i in range(6)]   # +1%/min
    assert round(burn_rate(rising, "fh")) == 60      # %/hour
    flat = [{"ts": base + i * 60_000, "fh": 40.0} for i in range(6)]
    assert burn_rate(flat, "fh") == 0.0
    assert burn_rate(rising[:2], "fh") == 0.0        # too few points
    nones = [{"ts": base + i * 60_000, "fh": None} for i in range(6)]
    assert burn_rate(nones, "fh") == 0.0             # all missing → 0
    assert burn_rate([], "fh") == 0.0


def test_is_newer():
    assert is_newer("v1.2.0", "1.1.0") is True
    assert is_newer("v1.1.0", "1.1.0") is False   # equal -> no update
    assert is_newer("v1.0.0", "1.2.0") is False
    assert is_newer(None, "1.0.0") is False        # nothing remote
    assert is_newer("v1.0.0", None) is True        # unknown local -> update
    assert is_newer("v0.10.0", "0.9.0") is True    # numeric compare


# ---- poll-loop resilience -------------------------------------------------
# A single SQLite write error once escaped _poll_once, propagated out of
# Hub.loop's `while True`, and killed the poll task outright. The web server
# kept serving, so the dashboard showed a frozen dataset for 41 hours with no
# warning. Both layers must now survive a failing poll.


class _StopLoop(BaseException):
    """Escapes `except Exception`, so the infinite poll loop can be ended."""


def _bare_hub():
    """A Hub carrying only the attributes the poll path touches — no Keychain,
    no network, no SQLite."""
    import concurrent.futures
    from server import Hub
    hub = Hub.__new__(Hub)
    hub.claude_src = "desktop"
    hub.store = None
    hub.interval = 0
    hub.latest = hub.codex_latest = hub.claude2_latest = None
    hub._track_cli = lambda: False    # not this machine's real ~/.claude.json
    hub.codex_available = hub.cc_available = hub.xcost_available = False
    hub.status = {"state": "starting", "message": None, "ts": None}
    hub.clients = set()
    hub._fail_streak = 0
    hub._claude_next = 0.0
    hub._claude_streak = 0
    hub._update_next = float("inf")     # don't reach for the release feed
    hub._pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    return hub


def test_poll_once_survives_store_failure():
    import asyncio
    import sqlite3

    hub = _bare_hub()
    hub._fetch_claude = lambda ts: ({"ts": ts, "fh": 1.0}, {"resets": {}})

    class _Boom:
        def insert(self, row):
            raise sqlite3.OperationalError("unable to open database file")

    hub.store = _Boom()
    asyncio.run(hub._poll_once())                  # must not raise
    assert hub.status["state"] == "error"
    assert "database" in hub.status["message"]
    assert hub._fail_streak == 1
    assert hub.latest is None                      # nothing persisted, nothing claimed


def test_loop_keeps_polling_after_a_failure():
    import asyncio
    import pytest

    hub = _bare_hub()
    calls = []

    async def flaky():
        calls.append(len(calls))
        if len(calls) == 1:
            raise RuntimeError("unable to open database file")
        if len(calls) >= 3:
            raise _StopLoop

    hub._poll_once = flaky

    async def drive():
        hub._wake = asyncio.Event()
        with pytest.raises(_StopLoop):
            await hub.loop()

    asyncio.run(drive())
    assert len(calls) == 3                         # kept going past the failure
    assert hub.status["state"] == "error"
    assert "database" in hub.status["message"]


# ---- descriptor hygiene ---------------------------------------------------
# A sqlite3.Connection sits in a reference cycle (statement cache -> cursors ->
# connection), so refcounting never reclaims it; only a cyclic GC pass would, and
# a low-allocation server runs those rarely. Leaving one unclosed per poll walked
# the process into its open-file limit, after which every fetch failed with
# EMFILE and the dashboard silently served stale data for days.
#
# Note `with sqlite3.connect(...)` does NOT close — it commits a transaction.

def _make_cookie_db(path):
    import sqlite3
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE cookies (name TEXT, encrypted_value BLOB, host_key TEXT)")
    con.execute("INSERT INTO cookies VALUES ('sessionKey', X'0102', '.claude.ai')")
    con.commit()
    con.close()


def test_cookie_rows_holds_no_descriptors():
    from poller import _cookie_rows

    open_fds = lambda: len(os.listdir("/dev/fd"))
    with tempfile.TemporaryDirectory() as d:
        db = os.path.join(d, "Cookies")
        _make_cookie_db(db)

        assert _cookie_rows(db) == [("sessionKey", b"\x01\x02")]   # still reads correctly
        before = open_fds()                                        # warm-up done
        for _ in range(60):
            _cookie_rows(db)
        after = open_fds()

    assert after == before, f"leaked {after - before} descriptors over 60 reads"


# ---- changelog -------------------------------------------------------------
# After an update the dashboard shows every section between the version the
# install last showed and the one now running, once.
from changelog import (parse as cl_parse, pending as cl_pending,  # noqa: E402
                       add_release, previous_version)

CL = """# Changelog

## [Unreleased]
- a hand-written note

## [0.14.1] - 2026-09-11
- chart bars by last use

## [0.14.0] - 2026-09-11
- working days
- a stray fix

## [0.13.2] - 2026-09-10
- range back in the card
"""
NO_NOTES = CL.replace("## [Unreleased]\n- a hand-written note\n\n", "")


def test_changelog_parse():
    e = cl_parse(CL)
    assert [x["version"] for x in e] == ["Unreleased", "0.14.1", "0.14.0", "0.13.2"]
    assert e[2]["items"] == ["working days", "a stray fix"]
    assert e[1]["date"] == "2026-09-11"


def test_changelog_pending_is_after_seen_up_to_current():
    e = cl_parse(CL)
    versions = lambda xs: [x["version"] for x in xs]
    assert versions(cl_pending(e, "0.13.2", "0.14.1")) == ["0.14.1", "0.14.0"]   # newest first
    assert cl_pending(e, "0.14.1", "0.14.1") == []                               # nothing new
    assert versions(cl_pending(e, "0.13.2", "0.14.0")) == ["0.14.0"]             # never beyond installed
    # seen=None is the whole released history; Unreleased is never shown
    assert versions(cl_pending(e, None, "0.14.1")) == ["0.14.1", "0.14.0", "0.13.2"]


def test_add_release_promotes_unreleased_notes():
    e = cl_parse(add_release(CL, "0.15.0", "2026-09-12"))
    assert e[0] == {"version": "0.15.0", "date": "2026-09-12", "items": ["a hand-written note"]}
    assert all(x["version"] != "Unreleased" for x in e)      # the block is consumed
    assert [x["version"] for x in e[1:]] == ["0.14.1", "0.14.0", "0.13.2"]


def test_add_release_requires_notes_and_a_new_version():
    import pytest
    with pytest.raises(ValueError):
        add_release(NO_NOTES, "0.15.0", "2026-09-12")        # users see these: never skip
    with pytest.raises(ValueError):
        add_release(CL, "0.14.1", "2026-09-12")              # already released


def test_previous_version_reads_where_the_updater_moved_from():
    def fake(repo, *args):
        if args[0] == "reflog":
            return ("commit: something\n"
                    "checkout: moving from 1a2b3c to tags/v0.14.1\n"
                    "checkout: moving from 9f9f9f to tags/v0.13.0\n")
        assert args == ("show", "1a2b3c:VERSION")          # the MOST RECENT move
        return "0.13.2\n"
    assert previous_version("/x", git=fake) == "0.13.2"
    # a fresh clone never checked out a tag, so there is nothing to diff against
    assert previous_version("/x", git=lambda repo, *a: "commit: initial\n") is None


# ---- terminal account: the status-line snapshot ----
import claude_cli  # noqa: E402

H5, D7 = 1_000_000, 2_000_000   # resets_at, epoch seconds


def test_merge_keeps_the_newer_reading_per_window():
    old = {"five_hour": [40.0, H5], "seven_day": [20.0, D7]}
    # an idle session's older reading (same window, lower %) is refused
    out, took = claude_cli.merge_windows(old, {"five_hour": [30.0, H5]})
    assert out == old and not took
    # same window, higher %, reset wobbling by a second: taken
    out, took = claude_cli.merge_windows(old, {"five_hour": [45.0, H5 + 1]})
    assert out["five_hour"] == [45.0, H5 + 1] and took
    # a later window wins even though its % is lower
    out, took = claude_cli.merge_windows(old, {"five_hour": [2.0, H5 + 5 * 3600]})
    assert out["five_hour"] == [2.0, H5 + 5 * 3600] and out["seven_day"] == [20.0, D7]


def test_snapshot_write_only_advances_on_accepted_readings():
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "s.json")
        claude_cli.write_snapshot({"five_hour": [40.0, H5]}, 100, path=p)
        claude_cli.write_snapshot({"five_hour": [30.0, H5]}, 200, path=p)   # stale: ignored
        assert claude_cli.read_snapshot(p) == {"ts": 100, "windows": {"five_hour": [40.0, H5]}}
        claude_cli.write_snapshot({"five_hour": [10.0, H5]}, 300, force=True, path=p)
        assert claude_cli.read_snapshot(p)["windows"]["five_hour"] == [10.0, H5]


def test_snapshot_usage_zeroes_windows_that_reset_since():
    snap = {"ts": 1, "windows": {"five_hour": [40.0, H5], "seven_day": [20.0, D7]}}
    row, live = normalize(claude_cli.snapshot_usage(snap, now_s=H5 + 10), ts=7)
    assert row["fh"] == 0.0 and row["sd"] == 20.0
    assert live["resets"]["five_hour"] is None
    assert datetime.datetime.fromisoformat(live["resets"]["seven_day"]).timestamp() == D7


def test_endpoint_and_statusline_readings_agree():
    assert claude_cli.windows_from_usage(FIXTURE)["five_hour"][0] == 35.0
    sl = {"rate_limits": {"five_hour": {"used_percentage": 12, "resets_at": H5}}}
    assert claude_cli.windows_from_statusline(sl) == {"five_hour": [12.0, H5]}
    assert claude_cli.windows_from_statusline({}) == {}


def test_statusline_hook_install_run_uninstall():
    import subprocess
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with tempfile.TemporaryDirectory() as home:
        os.makedirs(os.path.join(home, ".claude"))
        settings = os.path.join(home, ".claude", "settings.json")
        mine = {"type": "command", "command": "cat >/dev/null; echo mine", "padding": 0}
        with open(settings, "w") as fh:
            json.dump({"model": "x", "statusLine": mine}, fh)
        env = {**os.environ, "HOME": home, "CLAUDE_CODE_ENTRYPOINT": "cli"}
        hook = [sys.executable, os.path.join(root, "statusline.py")]

        subprocess.run(hook + ["--install"], env=env, check=True)
        subprocess.run(hook + ["--install"], env=env, check=True)     # idempotent
        sl = json.load(open(settings))["statusLine"]
        assert "statusline.py" in sl["command"] and sl["padding"] == 0

        stdin = json.dumps({"rate_limits": {"five_hour": {"used_percentage": 12, "resets_at": H5}}})
        out = subprocess.run(hook, env=env, input=stdin.encode(), stdout=subprocess.PIPE, check=True)
        assert out.stdout == b"mine\n"                                # previous line still shows
        snap = json.load(open(os.path.join(home, ".claude-usage", "cli-limits.json")))
        assert snap["windows"] == {"five_hour": [12.0, H5]}

        subprocess.run(hook + ["--uninstall"], env=env, check=True)
        assert json.load(open(settings)) == {"model": "x", "statusLine": mine}


def test_store_keeps_the_second_accounts_columns():
    with tempfile.TemporaryDirectory() as d:
        s = Store(os.path.join(d, "u.db"))
        s.insert({"ts": 1, "fh": 10.0, "kh": 30.0, "kd": 4.0})
        h = s.history()[0]
        assert (h["fh"], h["kh"], h["kd"]) == (10.0, 30.0, 4.0)


def test_fetch_cli_asks_the_endpoint_only_when_the_snapshot_is_old(monkeypatch):
    import time as _t
    hub = _bare_hub()
    hub._cli_api_next = 0.0
    now = _t.time()
    snap = {"ts": now * 1000, "windows": {"five_hour": [40.0, now + 3600]}}
    calls = []

    def endpoint():
        calls.append(1)
        return FIXTURE
    monkeypatch.setattr(claude_cli, "read_snapshot", lambda: snap)
    monkeypatch.setattr(claude_cli, "statusline_hooked", lambda: True)
    monkeypatch.setattr(claude_cli, "fetch_usage", endpoint)
    monkeypatch.setattr(claude_cli, "write_snapshot", lambda *a, **k: None)

    row, _ = hub._fetch_cli(1)                      # fresh: no request
    assert row["fh"] == 40.0 and calls == []

    snap["ts"] = (now - 2 * 3600) * 1000            # two hours old
    row, _ = hub._fetch_cli(2)
    assert row["fh"] == 35.0 and calls == [1]       # the endpoint, once...
    hub._fetch_cli(3)
    assert calls == [1]                             # ...then not again for a while

    def limited():
        raise claude_cli.RateLimited(60)
    monkeypatch.setattr(claude_cli, "fetch_usage", limited)
    hub._cli_api_next = 0.0
    row, _ = hub._fetch_cli(4)                      # 429: the old snapshot, no error
    assert row["fh"] == 40.0 and hub._cli_api_next > now + 1000


def test_claude_account_switch_drives_the_menu_bar():
    with tempfile.TemporaryDirectory() as d:
        s = Store(os.path.join(d, "u.db"))
        assert s.get_claude_account() == "desktop"
        assert s.set_claude_account("bogus") == "desktop"
        s.set_claude_account("cli")
        assert Store(os.path.join(d, "u.db")).get_claude_account() == "cli"   # persisted

    hub = _bare_hub()
    hub.latest, hub.claude2_latest = {"fh": 10.0}, None
    hub.claude_account = "cli"
    assert not hub._shows_cli()          # nothing from the CLI yet: stay on desktop
    hub.claude2_latest = {"fh": 50.0}
    assert hub._shows_cli()
    hub.claude_account = "desktop"
    assert not hub._shows_cli()
