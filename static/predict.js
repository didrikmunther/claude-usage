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
// (e.g. night-pause-aware) implement the same signature; points are objects so a
// strategy may later add fields (e.g. lo/hi confidence bands) without breaking callers.

// Least-squares slope (%/sec) over the samples. 0 when there's too little to fit
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

const Predictors = {
  linear: {
    method: "linear",
    predict(samples, opts = {}) {
      const pts = (samples || []).filter((s) => s && s.y != null);
      const cap = opts.cap ?? 100;
      const tLast = pts.length ? pts[pts.length - 1].t : (opts.now ?? 0);
      const yLast = pts.length ? pts[pts.length - 1].y : 0;
      const now = opts.now ?? tLast;
      const horizon = opts.horizon ?? 0;
      const step = (opts.step ?? horizon / 24) || 1;   // guard against 0/NaN
      const slope = leastSquaresSlope(pts);

      const points = [];
      for (let t = now; t <= now + horizon + 1e-6; t += step) {
        const y = Math.max(0, Math.min(cap, yLast + slope * (t - tLast)));
        points.push({ t, y });
      }
      return { method: "linear", points };
    },
  },
};

// Browser (classic <script>): `Predictors` is a shared global for app.js.
// Node (tests): expose via CommonJS. `module` is undefined in the browser.
if (typeof module !== "undefined" && module.exports) module.exports = { Predictors };
