"""API-equivalent $ value of your Claude Code usage.

Claude Code logs every API response's exact token counts to
~/.claude/projects/**/*.jsonl (message.usage). We scan those incrementally
(tracking each file's byte offset), aggregate tokens by model + hour, and price
them at Claude API list rates to get an "if this were pay-as-you-go" dollar
figure. The token counts are exact; only the $ rates are assumptions.

Rates track the published API list prices; override them by dropping a JSON like
{"opus": {"in": 5, "out": 25}} at ~/.claude-usage/pricing.json.

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
# Current published API list rates. NOTE these are per-TIER: Opus 5 / 4.8 / 4.7 /
# 4.6 are all $5/$25, but Opus 4.1 and older were $15/$75 — sessions on those are
# under-priced here. Override per model tier in ~/.claude-usage/pricing.json.
DEFAULT_PRICING = {
    "opus":   {"in": 5.0,  "out": 25.0},
    "sonnet": {"in": 2.0,  "out": 10.0},
    "haiku":  {"in": 1.0,  "out": 5.0},
    "fable":  {"in": 10.0, "out": 50.0},
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


CACHE_V = 5          # bump to force a full rescan when the shape changes


def _load() -> dict:
    try:
        st = json.load(open(CACHE))
        if st.get("v") == CACHE_V:
            return st
    except Exception:
        pass
    # Old cache: the per-file offsets would skip bytes we never aggregated
    # per-session, so start clean rather than show half a history.
    return {"v": CACHE_V, "files": {}, "alltime": {}, "buckets": {}, "sessions": {}}


def _save(state: dict):
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    tmp = CACHE + ".tmp"
    # Written through a context manager: os.replace below publishes this file,
    # and whether an unmanaged handle had flushed by then was down to refcount
    # timing — which could publish a truncated cache.
    with open(tmp, "w") as fh:
        json.dump(state, fh)
    os.replace(tmp, CACHE)


def refresh() -> dict:
    """Incrementally fold new log lines into the cache, then return a snapshot.
    First run is a full scan (can take a few seconds); after that it only reads
    bytes appended since last time."""
    st = _load()
    files, alltime, buckets = st["files"], st["alltime"], st["buckets"]
    sessions = st["sessions"]                 # one entry per log file == one chat
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
        sess = sessions.setdefault(f, {"t": None, "m": {}})
        # Claude Code writes one record per content block (thinking / text /
        # tool_use), and every one repeats the SAME message.usage for the whole
        # response — so counting each record double-billed a turn 2-3x. Seeded
        # from the tail of the previous scan, because a response's blocks can
        # straddle a poll boundary.
        seen = set(sess.get("seen") or [])
        try:
            with open(f, "r", errors="ignore") as fh:
                fh.seek(off)
                for line in fh:
                    # Claude Code writes its own generated title for the session;
                    # it is the only human summary anywhere in these logs.
                    if '"usage"' not in line and '"ai-title"' not in line:
                        continue
                    try:
                        o = json.loads(line)
                    except ValueError:
                        continue
                    if o.get("type") == "ai-title":
                        sess["title"] = o.get("aiTitle") or sess.get("title")
                        continue
                    msg = o.get("message") or {}
                    u = msg.get("usage")
                    model = msg.get("model")
                    if not model or _tier(model) is None or not isinstance(u, dict):
                        continue
                    mid = msg.get("id")
                    if mid:
                        if mid in seen:
                            continue
                        seen.add(mid)
                        sess["seen"] = (sess.get("seen") or [])[-15:] + [mid]
                    _add(alltime.setdefault(model, {}), u)
                    _add(sess["m"].setdefault(model, {}), u)
                    if sess["t"] is None:
                        sess["t"] = o.get("timestamp")
                    sess["end"] = o.get("timestamp") or sess.get("end")
                    sess["calls"] = sess.get("calls", 0) + 1
                    if o.get("gitBranch"):
                        sess["branch"] = o["gitBranch"]
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


def _label(f: str) -> str:
    """Claude Code names a project dir after its cwd: "-Users-me-projects-foo".
    Drop the home prefix; there is no chat title in the logs to use instead."""
    d = os.path.basename(os.path.dirname(f)).lstrip("-")
    parts = d.split("-")
    if len(parts) > 2 and parts[0] == "Users":
        d = "-".join(parts[2:])
    return d or os.path.basename(f)[:8]


def _today(ts: str | None) -> bool:
    """Was this session still running today, in local time?"""
    if not ts:
        return False
    try:
        d = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone()
    except ValueError:
        return False
    return d.date() == datetime.date.today()


def top_sessions(st: dict, pricing: dict, grand_total: float, n: int = 40,
                 today: bool = False) -> list:
    out = []
    for f, sess in (st.get("sessions") or {}).items():
        if today and not _today(sess.get("end") or sess.get("t")):
            continue
        total, by_model_s, _ = _cost(sess.get("m") or {}, pricing)
        if total <= 0:
            continue
        model = max(by_model_s, key=by_model_s.get)
        # Share of this provider's whole all-time spend. Numerator and denominator
        # both cover every model, so a chat that mixed models is still counted
        # exactly once — which a per-model denominator could not do.
        pct = 100.0 * total / grand_total if grand_total else 0.0
        out.append({"label": _label(f), "when": sess.get("t"), "cost": total,
                    "model": model, "pct": pct, "title": sess.get("title"),
                    "branch": sess.get("branch"), "calls": sess.get("calls", 0),
                    "end": sess.get("end")})
    out.sort(key=lambda x: -x["cost"])
    return out[:n]


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
        "top": top_sessions(st, pricing, total),
        "today": top_sessions(st, pricing, total, today=True),
    }


if __name__ == "__main__":
    print(json.dumps(refresh(), indent=2))
