# Design: Usage prediction interface

**Date:** 2026-09-03
**Status:** Approved (design)
**Branch:** `usage-prediction` (off `main` — Python dashboard)
**Scope:** new `static/predict.js`; chart projection in `static/app.js` + `static/style.css`.

## Goal

A generic, extensible interface for predicting future usage, rendered as a
"prognosis" occupying the rightmost 25% of each dashboard chart. Start simple
(linear regression); keep the door open for smarter strategies (e.g. night-time
pause detection) and richer output (confidence bands) without changing callers.
The output is a variable-length forecast over a caller-chosen horizon — "like the
weather."

## The interface (`static/predict.js`)

Each strategy is an object exposing a pure `predict`:

```
Predictors.<strategy>.predict(samples, opts) -> { method, points }

  samples : [{t, y}]  ascending; t = epoch seconds, y = percent (0–100)
  opts    : { now, horizon, step, cap = 100 }
            now     = time to forecast from        (default: last sample's t)
            horizon = seconds into the future to predict
            step    = seconds between output points (default: horizon / 24)
            cap     = clamp ceiling                 (default 100)
  returns : { method: string, points: [{t, y}] }   // variable length, anchored at `now`
```

- Callers select a strategy **by reference**: `Predictors.linear.predict(...)`. No
  string dispatch, no global default.
- `points` is **variable-length** — the caller controls how far (`horizon`) and how
  densely (`step`) to forecast.
- **Points are objects**, so a future strategy may add fields (e.g. `lo`/`hi` for a
  confidence band) without breaking existing callers.
- Predictors are **pure** (no DOM, no globals) → unit-testable in isolation.

## The linear strategy (`Predictors.linear`)

- Least-squares slope over `samples` within a trailing lookback, **anchored at the
  last observed point**: `y(t) = yLast + slope·(t − tLast)`, clamped to `[0, cap]`.
- Degenerate input (fewer than 3 points, span < 180 s, or near-zero denominator)
  → slope 0 → flat prognosis at the last value.
- Emits an anchor point at `now` plus a point every `step` up to `now + horizon`.
- `method: "linear"`.
- Reuses the same least-squares math as the existing `recentSlope` helper (kept
  consistent, but the predictor is self-contained so it can be tested alone).

## Chart integration (`static/app.js`, `static/style.css`)

- Each chart gains **two projection series** (one per line) → uPlot data becomes
  five rows: `[ts, a, b, aProj, bProj]`.
- `applyRange`: after slicing history, set `horizon = visibleHistorySpan / 3` (so
  the future region is 25% of the chart width). For each series, build `samples`
  from the visible history and call `Predictors.linear.predict`. Append the future
  timestamps and the projection values: `null` across history except an **anchor at
  the last real point** (so the dashed line connects); the real series are `null`
  in the future region.
- Projection rendered **lighter + dashed**: new CSS vars `--fh-dim` / `--sd-dim`
  (same hue, ~50% alpha) + uPlot `dash`. A faint vertical **"now" divider** (small
  uPlot draw plugin) marks the history/future boundary.
- Spike markers and the "consumed" tally continue to use **history only**.

## Extensibility (future — out of scope now)

- New strategy = add `Predictors.foo = { method, predict }`. A night-pause-aware
  strategy would, e.g., flatten the slope across predicted idle hours.
- Confidence band = add `lo`/`hi` to points + a band fill; the interface already
  permits it.

## Testing

- `predict.js` is pure → `static/predict.test.mjs` run with `node`: linear
  extrapolation, 0/100 clamping, flat-on-idle/degenerate input, output length
  tracks `horizon`/`step`, and the first point is anchored at `now`. (Falls back to
  browser verification if `node` is unavailable here.)
- Chart: reload the dashboard, confirm no console errors and the projection renders
  in the right 25% (lighter/dashed) — a screenshot confirms the look.

## Out of scope

- Reset-aware projection (dropping to 0 at a window reset within the horizon).
- Confidence bands and the night-pause strategy (interface is ready for them).
- Porting the interface to the Swift app.
