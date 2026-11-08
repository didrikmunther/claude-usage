"""Forecast verdicts for the menu bar, from the dashboard's own JavaScript.

The forecast models live in static/predict.js and the verdict (where a window
lands at its reset, or when it runs out first) in static/forecast.js. The menu
bar's dials draw that verdict too, and a Python port would drift from what the
dashboard says, so the server runs the same files in JavaScriptCore (it ships
with pyobjc-framework-WebKit, already a requirement).
"""
from __future__ import annotations

import json
import os
import threading

STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

# Mirrors the dashboard's windowProjection + forecastFromPoints for one window.
# `bare` skips the uncertainty band (a replay of history, seconds of work) that
# the verdict never reads; its floor is restored here: inside the current cycle
# the forecast never drops below what is already used.
_GLUE = r"""
function __outlook(argsJson) {
  const a = JSON.parse(argsJson);
  const P = Predictors[a.model] || Predictors.linear;
  const now = a.samples[a.samples.length - 1].t;
  const resetT = Date.parse(a.reset) / 1000;
  if (!(resetT - now > 0)) return null;
  const r = P.predict(a.samples, { now, horizon: resetT - now, step: 3600,
    reset: { P: a.win, R: resetT }, workDays: a.workDays, bare: true });
  const pts = (r && r.points || []).map((p) => (p.t <= resetT ? { t: p.t, y: Math.max(a.cur, p.y) } : p));
  const v = forecastFromPoints(a.cur, a.win * 1000, a.reset, pts);
  if (!v || v.atReset == null) return null;
  return JSON.stringify({ at_reset: v.atReset, hit_ms: v.hitMs });
}
"""

_lock = threading.Lock()
_ctx = None


def _context():
    global _ctx
    if _ctx is None:
        from JavaScriptCore import JSContext  # lazy: macOS-only, keeps tests importable
        ctx = JSContext.alloc().init()
        for name in ("predict.js", "forecast.js"):
            with open(os.path.join(STATIC, name)) as fh:
                ctx.evaluateScript_(fh.read())
        ctx.evaluateScript_(_GLUE)
        if ctx.exception() is not None:
            raise RuntimeError(f"forecast scripts failed to load: {ctx.exception()}")
        _ctx = ctx
    return _ctx


def window_outlook(samples: list[dict], cur: float, reset_iso: str, win_s: int,
                   model: str, work_days: list[int]) -> dict | None:
    """{at_reset, hit_ms} for one window: % used when it resets, and the epoch ms
    it hits 100% first (None if it doesn't). `samples` are [{t: sec, y}].
    None when there is nothing honest to say (just reset, no reset time, …)."""
    if not samples or cur is None or not reset_iso:
        return None
    args = json.dumps({"samples": samples, "cur": cur, "reset": reset_iso, "win": win_s,
                       "model": model, "workDays": work_days})
    with _lock:                                  # one context, used from executor threads
        ctx = _context()
        ctx.setException_(None)
        out = ctx.objectForKeyedSubscript_("__outlook").callWithArguments_([args])
        if ctx.exception() is not None or out is None or out.isNull() or out.isUndefined():
            return None
        return json.loads(out.toString())
