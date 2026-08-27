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
