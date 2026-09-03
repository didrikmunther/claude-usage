"use strict";

// Generic usage-prediction interface.
//
//   Predictors.<strategy>.predict(samples, opts) -> { method, points }
//     samples : [{t, y}]  ascending; t = epoch seconds, y = percent (0–100). Nulls ignored.
//     opts    : { now, horizon, step, cap = 100 }
//               now     = time to forecast from        (default: last sample's t)
//               horizon = seconds into the future to predict
//               step    = seconds between output points (default: horizon / 24)
//               cap     = clamp ceiling                 (default 100)
//     returns : { method, points: [{t, y}] }  — variable length, anchored at `now`.
//
// Strategies are selected by reference (Predictors.linear.predict). New strategies
// implement the same signature; points are objects so a strategy may later add
// fields (e.g. lo/hi confidence bands) without breaking callers.

// Least-squares slope (%/sec) over the points. 0 when there's too little to fit
// (< 3 points, span < 180s, or degenerate) so an idle stretch reads as flat.
function leastSquaresSlope(pts) {
  if (pts.length < 3) return 0;
  const span = pts[pts.length - 1].t - pts[0].t;
  if (span < 180) return 0;
  const n = pts.length, t0 = pts[0].t;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const { t, y } of pts) { const x = t - t0; sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < 1e-9) return 0;
  return (n * sxy - sx * sy) / den;
}

// Split samples into cycles at reset drops. Utilization only climbs within a
// cycle, so any fall of more than RESET_DROP points marks a new cycle.
const RESET_DROP = 5;
function segmentCycles(pts) {
  const cycles = [];
  let cur = [], prev = null;
  for (const p of pts) {
    if (prev != null && p.y < prev - RESET_DROP) { if (cur.length) cycles.push(cur); cur = []; }
    cur.push(p);
    prev = p.y;
  }
  if (cur.length) cycles.push(cur);
  return cycles;
}

// Least-squares slope for each cycle long enough to fit (>= 3 points, >= 180s span).
function cycleSlopes(pts) {
  const out = [];
  for (const cyc of segmentCycles(pts)) {
    if (cyc.length < 3 || cyc[cyc.length - 1].t - cyc[0].t < 180) continue;
    out.push(leastSquaresSlope(cyc));
  }
  return out;
}

// Outlier-trimmed mean: treat the values as a normal distribution and, once there
// are enough of them, drop anything beyond 2σ before averaging. Small samples are
// averaged as-is. null for an empty input.
function robustMean(vals) {
  if (!vals.length) return null;
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  if (vals.length < 4) return mean(vals);
  const m = mean(vals);
  const std = Math.sqrt(mean(vals.map((v) => (v - m) ** 2)));
  if (std < 1e-12) return m;                       // all equal — nothing to trim
  const kept = vals.filter((v) => Math.abs((v - m) / std) <= 2);
  return mean(kept.length ? kept : vals);
}

// Shared projection: straight line from the last observed point at `slope` (%/sec),
// clamped to [0, cap], sampled from `now` to `now + horizon` every `step`.
function projectFrom(pts, slope, opts, method) {
  const cap = opts.cap ?? 100;
  const tLast = pts.length ? pts[pts.length - 1].t : (opts.now ?? 0);
  const yLast = pts.length ? pts[pts.length - 1].y : 0;
  const now = opts.now ?? tLast;
  const horizon = opts.horizon ?? 0;
  const step = (opts.step ?? horizon / 24) || 1;
  const points = [];
  for (let t = now; t <= now + horizon + 1e-6; t += step) {
    points.push({ t, y: Math.max(0, Math.min(cap, yLast + slope * (t - tLast))) });
  }
  return { method, points };
}

const Predictors = {
  // Simple linear regression over all samples.
  linear: {
    method: "linear",
    predict(samples, opts = {}) {
      const pts = (samples || []).filter((s) => s && s.y != null);
      return projectFrom(pts, leastSquaresSlope(pts), opts, "linear");
    },
  },

  // Reset-aware: regress each between-reset cycle, drop outlier slopes, average the
  // rest into a robust burn rate, and project a straight line at that rate. Falls
  // back to a plain fit when there aren't enough cycles to estimate from.
  cycle: {
    method: "cycle",
    predict(samples, opts = {}) {
      const pts = (samples || []).filter((s) => s && s.y != null);
      const slopes = cycleSlopes(pts);
      const rate = slopes.length ? robustMean(slopes) : leastSquaresSlope(pts);
      return projectFrom(pts, rate ?? 0, opts, "cycle");
    },
  },
};

// Browser (classic <script>): these top-level consts are shared globals for app.js.
// Node (tests): expose via CommonJS. `module` is undefined in the browser.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { Predictors, segmentCycles, cycleSlopes, robustMean, leastSquaresSlope };
}
