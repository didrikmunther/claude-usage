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

// Per-cycle slopes tagged with the cycle's most-recent timestamp (for recency weighting).
function cycleSlopesWithTime(pts) {
  const out = [];
  for (const cyc of segmentCycles(pts)) {
    if (cyc.length < 3 || cyc[cyc.length - 1].t - cyc[0].t < 180) continue;
    out.push({ slope: leastSquaresSlope(cyc), t: cyc[cyc.length - 1].t });
  }
  return out;
}

// Overall burn rate = recency-weighted robust mean of the per-cycle slopes
// (recent cycles count more). Falls back to a plain fit when there are no cycles.
function overallRate(pts, opts = {}) {
  const now = opts.now ?? (pts.length ? pts[pts.length - 1].t : 0);
  const halfLife = opts.halfLife ?? HALF_LIFE;
  const cs = cycleSlopesWithTime(pts);
  if (!cs.length) return leastSquaresSlope(pts);
  return weightedRobustMean(cs.map((c) => c.slope), cs.map((c) => recencyWeight(c.t, now, halfLife)));
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

// Recency weight: 1.0 at age 0, halving every `halfLife` seconds. Habits change, so
// older observations count for less. Default half-life is 3 days.
const HALF_LIFE = 3 * 86400;
function recencyWeight(t, now, halfLife) {
  return Math.pow(0.5, Math.max(0, now - t) / (halfLife || 1));
}

// Recency-weighted robust mean: weighted mean/std, trim beyond 2σ of the weighted
// distribution, then the weighted mean of the survivors. A recent, heavily-weighted
// value shifts the mean toward itself and survives (stale values become the outliers).
function weightedRobustMean(values, weights) {
  const n = values.length;
  if (!n) return null;
  const wmean = (vs, ws) => {
    let sw = 0, sv = 0;
    for (let i = 0; i < vs.length; i++) { sw += ws[i]; sv += ws[i] * vs[i]; }
    return sw > 0 ? sv / sw : 0;
  };
  if (n < 4) return wmean(values, weights);
  const m = wmean(values, weights);
  let sw = 0, svar = 0;
  for (let i = 0; i < n; i++) { sw += weights[i]; svar += weights[i] * (values[i] - m) ** 2; }
  const std = Math.sqrt(sw > 0 ? svar / sw : 0);
  if (std < 1e-12) return m;
  const kv = [], kw = [];
  for (let i = 0; i < n; i++) if (Math.abs((values[i] - m) / std) <= 2) { kv.push(values[i]); kw.push(weights[i]); }
  return kv.length ? wmean(kv, kw) : m;
}

// The 5-hour and 7-day windows meter the same usage against fixed limits, so
// Δ7day/Δ5hour is a constant ratio (limit_5h / limit_7d). Estimate it from history:
// Σ(positive 7-day increments) / Σ(positive 5-hour increments). null when the source
// barely moves (< 1 point consumed) — then the 7-day can't be meaningfully derived.
function consumptionRatio(sourceVals, targetVals) {
  let sSrc = 0, sTgt = 0, pSrc = null, pTgt = null;
  for (let i = 0; i < sourceVals.length; i++) {
    const s = sourceVals[i], t = targetVals[i];
    if (s != null) { if (pSrc != null && s > pSrc) sSrc += s - pSrc; pSrc = s; }
    if (t != null) { if (pTgt != null && t > pTgt) sTgt += t - pTgt; pTgt = t; }
  }
  if (!(sSrc > 1)) return null;
  const r = sTgt / sSrc;
  return Number.isFinite(r) ? r : null;
}

// Derive the 7-day projection from the 5-hour projection: it rises by `r` per unit
// of source consumption (sum of the source's positive increments — a source reset
// drop is not consumption, so the 7-day holds across it). Anchored at `targetLast`.
function deriveSeries(sourcePoints, targetLast, r, cap = 100) {
  const out = [];
  let cum = 0, prev = null;
  for (const p of sourcePoints) {
    if (prev != null && p.y > prev) cum += p.y - prev;
    prev = p.y;
    out.push({ t: p.t, y: Math.max(0, Math.min(cap, targetLast + r * cum)) });
  }
  return out;
}

// Linearly interpolate a series of {t, y} points at time `t`, clamping to the ends.
// Used to resample two projections (which may have different point grids — e.g. a
// reset-aware line vs a straight one) onto a single shared time axis.
function sampleAt(points, t) {
  if (!points.length) return null;
  if (t <= points[0].t) return points[0].y;
  const last = points[points.length - 1];
  if (t >= last.t) return last.y;
  for (let i = 1; i < points.length; i++) {
    if (points[i].t >= t) {
      const p0 = points[i - 1], p1 = points[i];
      const f = (t - p0.t) / ((p1.t - p0.t) || 1);
      return p0.y + f * (p1.y - p0.y);
    }
  }
  return last.y;
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

const hourOfLocal = (tSec) => new Date(tSec * 1000).getHours();

// Estimate the burn rate as a function of hour-of-day. For each adjacent in-cycle
// sample pair, the increment Δy/Δt (clamped ≥0) is bucketed by the hour it started
// in and robust-averaged. Hours with fewer than `minCount` intervals are left
// undefined; callers fall back to `overall` (the cross-cycle robust rate).
function hourlyRates(samples, opts = {}) {
  const pts = (samples || []).filter((s) => s && s.y != null);
  const hourOf = opts.hourOf ?? hourOfLocal;
  const minCount = opts.minCount ?? 3;
  const now = opts.now ?? (pts.length ? pts[pts.length - 1].t : 0);
  const halfLife = opts.halfLife ?? HALF_LIFE;
  const buckets = Array.from({ length: 24 }, () => ({ r: [], w: [] }));
  for (const cyc of segmentCycles(pts)) {
    for (let i = 1; i < cyc.length; i++) {
      const dt = cyc[i].t - cyc[i - 1].t;
      if (dt <= 0) continue;
      const rate = Math.max(0, cyc[i].y - cyc[i - 1].y) / dt;
      const b = buckets[((hourOf(cyc[i - 1].t) % 24) + 24) % 24];
      b.r.push(rate);
      b.w.push(recencyWeight(cyc[i - 1].t, now, halfLife));   // older increments count for less
    }
  }
  const hourly = buckets.map((b) => (b.r.length >= minCount ? weightedRobustMean(b.r, b.w) : undefined));
  return { hourly, overall: overallRate(pts, opts) };
}

// Accumulate the projection forward using a time-varying (per-hour) rate, on a
// ≤1h grid so hours resolve, dropping to 0 at each inferred reset within the horizon.
function projectTOD(pts, model, reset, opts, method) {
  const cap = opts.cap ?? 100;
  const tLast = pts.length ? pts[pts.length - 1].t : (opts.now ?? 0);
  const yLast = pts.length ? pts[pts.length - 1].y : 0;
  const now = opts.now ?? tLast;
  const horizon = opts.horizon ?? 0;
  const step = (opts.step ?? horizon / 24) || 1;
  const effStep = Math.max(60, Math.min(step, 3600));   // ≤1h so per-hour rates resolve
  const hourOf = opts.hourOf ?? hourOfLocal;
  const clamp = (v) => Math.max(0, Math.min(cap, v));
  const rateAt = (t) => {
    const r = model.hourly[((hourOf(t) % 24) + 24) % 24];
    return Math.max(0, r == null ? model.overall : r);
  };
  const hasReset = !!(reset && reset.P > 0);
  const P = hasReset ? reset.P : 0, R = hasReset ? reset.R : 0;
  const csNow = hasReset ? R + Math.floor((now - R) / P) * P : 0;
  const resets = [];
  if (hasReset) for (let r = csNow + P; r <= now + horizon + 1e-9; r += P) resets.push(r);
  const eps = Math.min(1, effStep * 1e-3) || 1e-3;
  const points = [{ t: now, y: clamp(yLast) }];
  let y = yLast, t = now, ri = 0, guard = 0;
  while (t < now + horizon - 1e-9 && guard++ < 100000) {
    const nt = Math.min(t + effStep, now + horizon);
    if (ri < resets.length && resets[ri] <= nt + 1e-9) {
      const r = resets[ri];
      y = clamp(y + rateAt(t) * (r - t));
      points.push({ t: r - eps, y });
      points.push({ t: r, y: 0 });
      y = 0; t = r; ri++;
      continue;
    }
    y = clamp(y + rateAt(t) * (nt - t));
    points.push({ t: nt, y });
    t = nt;
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
      const rate = overallRate(pts, opts) ?? 0;   // recency-weighted cross-cycle rate
      const reset = inferResetPeriod(pts);
      return reset
        ? projectWithResets(pts, rate, reset.P, reset.R, opts, "cycle")   // drop to 0 at each reset
        : projectFrom(pts, rate, opts, "cycle");                          // not enough cycles → straight line
    },
  },

  // Cycle + time of day: reset-aware, but the forward rate varies by hour-of-day
  // (per-hour robust average, falling back to the overall cycle rate for sparse hours).
  "cycle+tod": {
    method: "cycle+tod",
    predict(samples, opts = {}) {
      const pts = (samples || []).filter((s) => s && s.y != null);
      const model = hourlyRates(pts, opts);
      const reset = inferResetPeriod(pts);
      return projectTOD(pts, model, reset, opts, "cycle+tod");
    },
  },
};

// Browser (classic <script>): these top-level consts are shared globals for app.js.
// Node (tests): expose via CommonJS. `module` is undefined in the browser.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { Predictors, segmentCycles, cycleSlopes, robustMean, leastSquaresSlope, inferResetPeriod, sampleAt, hourlyRates, consumptionRatio, deriveSeries, weightedRobustMean, recencyWeight };
}
