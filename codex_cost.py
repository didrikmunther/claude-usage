"""API-equivalent $ of your OpenAI Codex usage.

The Codex CLI logs each turn's exact token counts to
~/.codex/sessions/**/rollout-*.jsonl (an event_msg record whose
payload.info.last_token_usage holds that turn's input / cached-input / output
tokens). We scan those incrementally (tracking each file's byte offset and the
model in effect from its turn_context records), aggregate tokens by model + hour,
and price them at OpenAI API list rates.

The token counts are exact; the $ rates are ASSUMPTIONS — your model may be newer
than the defaults. Override with a JSON like
{"gpt-5.6-sol": {"in": 1.25, "cached": 0.125, "out": 10}} at
~/.claude-usage/codex_pricing.json. This is a comparison estimate, not billing.
"""
from __future__ import annotations

import datetime
import glob
import json
import os
import time
from collections import defaultdict

SESSIONS = os.path.expanduser("~/.codex/sessions")
CACHE = os.path.expanduser("~/.claude-usage/codex_cost.json")
PRICING_OVERRIDE = os.path.expanduser("~/.claude-usage/codex_pricing.json")

# per-MTok. `cached` = cached-input read rate. Defaults are GPT-5-class guesses.
DEFAULT_PRICING = {"default": {"in": 1.25, "cached": 0.125, "out": 10.0}}


def available() -> bool:
    return os.path.isdir(SESSIONS)


def _pricing() -> dict:
    p = {k: dict(v) for k, v in DEFAULT_PRICING.items()}
    try:
        for k, v in json.load(open(PRICING_OVERRIDE)).items():
            p[k] = v
    except Exception:
        pass
    return p


def _rate(model: str, pricing: dict) -> dict:
    return pricing.get(model) or pricing.get("default") or DEFAULT_PRICING["default"]


def _hour(ts: str | None):
    if not ts:
        return None
    try:
        if ts.endswith("Z"):
            ts = ts[:-1] + "+00:00"
        return int(datetime.datetime.fromisoformat(ts).timestamp() // 3600)
    except Exception:
        return None


def _add(dst: dict, lt: dict):
    dst["in"] = dst.get("in", 0) + (lt.get("input_tokens") or 0)
    dst["cached"] = dst.get("cached", 0) + (lt.get("cached_input_tokens") or 0)
    dst["out"] = dst.get("out", 0) + (lt.get("output_tokens") or 0)


def _load() -> dict:
    try:
        return json.load(open(CACHE))
    except Exception:
        return {"files": {}, "models": {}, "alltime": {}, "buckets": {}}


def _save(state: dict):
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    tmp = CACHE + ".tmp"
    json.dump(state, open(tmp, "w"))
    os.replace(tmp, CACHE)


def refresh() -> dict:
    """Fold new log lines into the cache, then return a snapshot. First run is a
    full scan; after that only appended bytes are read."""
    st = _load()
    files = st["files"]
    models = st.setdefault("models", {})       # per-file model last in effect (append-safe)
    alltime, buckets = st["alltime"], st["buckets"]
    changed = False

    for f in glob.glob(os.path.join(SESSIONS, "**", "rollout-*.jsonl"), recursive=True):
        try:
            size = os.path.getsize(f)
        except OSError:
            continue
        off = files.get(f, 0)
        if size <= off:                        # unchanged (logs are append-only)
            if size < off:
                files[f] = size                # truncation guard
            continue
        cur_model = models.get(f) or "default"
        try:
            with open(f, "r", errors="ignore") as fh:
                fh.seek(off)
                for line in fh:
                    is_tok = '"last_token_usage"' in line
                    is_ctx = '"turn_context"' in line and '"model"' in line
                    if not (is_tok or is_ctx):
                        continue
                    try:
                        o = json.loads(line)
                    except ValueError:
                        continue
                    pl = o.get("payload") or {}
                    if is_ctx:                  # remember which model this turn used
                        m = pl.get("model")
                        if isinstance(m, str):
                            cur_model = m
                        continue
                    lt = (pl.get("info") or {}).get("last_token_usage")
                    if isinstance(lt, dict):
                        _add(alltime.setdefault(cur_model, {}), lt)
                        h = _hour(o.get("timestamp"))
                        if h is not None:
                            _add(buckets.setdefault(str(h), {}).setdefault(cur_model, {}), lt)
        except OSError:
            continue
        files[f] = size
        models[f] = cur_model
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
    comp = {"input": 0.0, "output": 0.0, "cache read": 0.0}
    for model, c in tokmap.items():
        r = _rate(model, pricing)
        inr, outr = r["in"], r["out"]
        cachedr = r.get("cached", inr * 0.1)
        uncached = max(0, c.get("in", 0) - c.get("cached", 0))
        ci = uncached * inr / 1e6
        cr = c.get("cached", 0) * cachedr / 1e6
        co = c.get("out", 0) * outr / 1e6
        m = ci + cr + co
        by_model[model] = m
        total += m
        comp["input"] += ci; comp["cache read"] += cr; comp["output"] += co
    return total, by_model, comp


def _window(buckets: dict, since_hour: int) -> dict:
    agg = defaultdict(lambda: defaultdict(float))
    for h, mdls in buckets.items():
        if int(h) < since_hour:
            continue
        for model, c in mdls.items():
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
    t = time.time()
    snap = refresh()
    print(json.dumps(snap, indent=2))
    print(f"scan took {time.time() - t:.2f}s", flush=True)
