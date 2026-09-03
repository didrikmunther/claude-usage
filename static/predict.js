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

// Infer the reset schedule from the cycle boundaries: period P = median gap between
// consecutive resets, R = the most recent reset time. null when there aren't enough
// cycles to estimate a period (need at least two observed resets).
function inferResetPeriod(pts) {
  const cycles = segmentCycles((pts || []).filter((s) => s && s.y != null));
  if (cycles.length < 3) return null;
  const markers = cycles.slice(1).map((c) => c[0].t);   // each cycle after the first begins just after a reset
  const gaps = [];
  for (let i = 1; i < markers.length; i++) gaps.push(markers[i] - markers[i - 1]);
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  const P = gaps[Math.floor(gaps.length / 2)];          // median period
  if (!(P > 0)) return null;
  return { P, R: markers[markers.length - 1] };
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

// Reset-aware projection: climb at `rate`, dropping to 0 at each inferred reset
// (period P, last reset R) that falls within the horizon, then resume climbing.
function projectWithResets(pts, rate, P, R, opts, method) {
  const cap = opts.cap ?? 100;
  const tLast = pts.length ? pts[pts.length - 1].t : (opts.now ?? 0);
  const yLast = pts.length ? pts[pts.length - 1].y : 0;
  const now = opts.now ?? tLast;
  const horizon = opts.horizon ?? 0;
  const step = (opts.step ?? horizon / 24) || 1;
  const clamp = (y) => Math.max(0, Math.min(cap, y));
  const csNow = R + Math.floor((now - R) / P) * P;        // reset time that started the current cycle
  const climbAt = (t) => {
    const cs = R + Math.floor((t - R) / P) * P;
    return cs <= csNow + 1e-9
      ? clamp(yLast + rate * (t - now))                    // still in the current cycle → anchored to yLast
      : clamp(rate * (t - cs));                            // a later cycle → climb from 0
  };
  // Sample the horizon, and add a point just-before + at each reset so the drop is crisp.
  const eps = Math.min(1, step * 1e-3) || 1e-3;
  const times = new Set();
  for (let t = now; t <= now + horizon + 1e-6; t += step) times.add(t);
  times.add(now + horizon);
  for (let r = csNow + P; r <= now + horizon + 1e-9; r += P) { times.add(r - eps); times.add(r); }
  const points = [...times].sort((a, b) => a - b).map((t) => ({ t, y: climbAt(t) }));
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
      const rate = (slopes.length ? robustMean(slopes) : leastSquaresSlope(pts)) ?? 0;
      const reset = inferResetPeriod(pts);
      return reset
        ? projectWithResets(pts, rate, reset.P, reset.R, opts, "cycle")   // drop to 0 at each reset
        : projectFrom(pts, rate, opts, "cycle");                          // not enough cycles → straight line
    },
  },
};

// Browser (classic <script>): these top-level consts are shared globals for app.js.
// Node (tests): expose via CommonJS. `module` is undefined in the browser.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { Predictors, segmentCycles, cycleSlopes, robustMean, leastSquaresSlope, inferResetPeriod };
}
