"""API-equivalent $ value of your Claude Code usage.

Claude Code logs every API response's exact token counts to
~/.claude/projects/**/*.jsonl (message.usage). We scan those incrementally
(tracking each file's byte offset), aggregate tokens by model + hour, and price
them at Claude API list rates to get an "if this were pay-as-you-go" dollar
figure. The token counts are exact; only the $ rates are assumptions.

Rates for the newest models are guesses (past training data) — override them by
dropping a JSON like {"opus": {"in": 15, "out": 75}} at
~/.claude-usage/pricing.json.

Nothing here is subscription billing; it's a comparison estimate.
"""
from __future__ import annotations

import datetime
import glob
import json
import os
import time
from collections import defaultdict

PROJECTS = os.path.expanduser("~/.claude/projects")
CACHE = os.path.expanduser("~/.claude-usage/ccost.json")
PRICING_OVERRIDE = os.path.expanduser("~/.claude-usage/pricing.json")

# per-MTok (input, output). Cache: read 0.10x, write-5m 1.25x, write-1h 2.0x of input.
DEFAULT_PRICING = {
    "opus":   {"in": 15.0, "out": 75.0},
    "sonnet": {"in": 3.0,  "out": 15.0},
    "haiku":  {"in": 1.0,  "out": 5.0},
    "fable":  {"in": 3.0,  "out": 15.0},   # unknown tier — assumed Sonnet-class
}
CACHE_READ, CACHE_W5, CACHE_W1H = 0.10, 1.25, 2.0


def available() -> bool:
    return os.path.isdir(PROJECTS)


def _tier(model: str | None) -> str | None:
    m = (model or "").lower()
    for t in ("opus", "sonnet", "haiku", "fable"):
        if t in m:
            return t
    return None


def _pricing() -> dict:
    p = {k: dict(v) for k, v in DEFAULT_PRICING.items()}
    try:
        for k, v in json.load(open(PRICING_OVERRIDE)).items():
            p[k] = v
    except Exception:
        pass
    return p


def _hour(ts: str | None):
    if not ts:
        return None
    try:
        if ts.endswith("Z"):
            ts = ts[:-1] + "+00:00"
        return int(datetime.datetime.fromisoformat(ts).timestamp() // 3600)
    except Exception:
        return None


def _add(dst: dict, u: dict):
    dst["in"] = dst.get("in", 0) + (u.get("input_tokens") or 0)
    dst["out"] = dst.get("out", 0) + (u.get("output_tokens") or 0)
    dst["cread"] = dst.get("cread", 0) + (u.get("cache_read_input_tokens") or 0)
    cc = u.get("cache_creation") or {}
    if cc:
        dst["c5m"] = dst.get("c5m", 0) + (cc.get("ephemeral_5m_input_tokens") or 0)
        dst["c1h"] = dst.get("c1h", 0) + (cc.get("ephemeral_1h_input_tokens") or 0)
    else:
        dst["c5m"] = dst.get("c5m", 0) + (u.get("cache_creation_input_tokens") or 0)


def _load() -> dict:
    try:
        return json.load(open(CACHE))
    except Exception:
        return {"files": {}, "alltime": {}, "buckets": {}}


def _save(state: dict):
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    tmp = CACHE + ".tmp"
    json.dump(state, open(tmp, "w"))
    os.replace(tmp, CACHE)


def refresh() -> dict:
    """Incrementally fold new log lines into the cache, then return a snapshot.
    First run is a full scan (can take a few seconds); after that it only reads
    bytes appended since last time."""
    st = _load()
    files, alltime, buckets = st["files"], st["alltime"], st["buckets"]
    changed = False

    for f in glob.glob(os.path.join(PROJECTS, "**", "*.jsonl"), recursive=True):
        try:
            size = os.path.getsize(f)
        except OSError:
            continue
        off = files.get(f, 0)
        if size <= off:                       # unchanged (logs are append-only)
            if size < off:
                files[f] = size               # truncation guard: don't re-read
            continue
        try:
            with open(f, "r", errors="ignore") as fh:
                fh.seek(off)
                for line in fh:
                    if '"usage"' not in line:
                        continue
                    try:
                        o = json.loads(line)
                    except ValueError:
                        continue
                    msg = o.get("message") or {}
                    u = msg.get("usage")
                    model = msg.get("model")
                    if not model or _tier(model) is None or not isinstance(u, dict):
                        continue
                    _add(alltime.setdefault(model, {}), u)
                    h = _hour(o.get("timestamp"))
                    if h is not None:
                        _add(buckets.setdefault(str(h), {}).setdefault(model, {}), u)
        except OSError:
            continue
        files[f] = size
        changed = True

    cutoff = int(time.time() // 3600) - 24 * 7      # windows only need 7 days of buckets
    for h in [h for h in buckets if int(h) < cutoff]:
        del buckets[h]
        changed = True
    if changed:
        _save(st)
    return snapshot(st)


def _cost(tokmap: dict, pricing: dict):
    total = 0.0
    by_model = {}
    comp = {"input": 0.0, "output": 0.0, "cache read": 0.0, "cache write": 0.0}
    for model, c in tokmap.items():
        r = pricing.get(_tier(model))
        if not r:
            continue
        inr, outr = r["in"], r["out"]
        ci = c.get("in", 0) * inr / 1e6
        co = c.get("out", 0) * outr / 1e6
        cr = c.get("cread", 0) * inr * CACHE_READ / 1e6
        cw = (c.get("c5m", 0) * inr * CACHE_W5 + c.get("c1h", 0) * inr * CACHE_W1H) / 1e6
        m = ci + co + cr + cw
        by_model[model] = m
        total += m
        comp["input"] += ci; comp["output"] += co
        comp["cache read"] += cr; comp["cache write"] += cw
    return total, by_model, comp


def _window(buckets: dict, since_hour: int) -> dict:
    agg = defaultdict(lambda: defaultdict(float))
    for h, models in buckets.items():
        if int(h) < since_hour:
            continue
        for model, c in models.items():
            for k, v in c.items():
                agg[model][k] += v
    return agg


def snapshot(st: dict) -> dict:
    pricing = _pricing()
    now_h = int(time.time() // 3600)
    total, by_model, comp = _cost(st["alltime"], pricing)
    d7, _, _ = _cost(_window(st["buckets"], now_h - 24 * 7), pricing)
    d1, _, _ = _cost(_window(st["buckets"], now_h - 24), pricing)
    top = sorted(by_model.items(), key=lambda x: -x[1])[:5]
    return {
        "total": total, "d7": d7, "d1": d1,
        "by_model": [{"model": m, "cost": c} for m, c in top],
        "by_component": comp,
    }


if __name__ == "__main__":
    print(json.dumps(refresh(), indent=2))
