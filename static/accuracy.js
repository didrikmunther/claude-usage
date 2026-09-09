"use strict";

// How wrong each forecast model actually was, measured against real history.
//
// Method: pick an origin T inside the recorded data, hand a model ONLY the
// samples up to T, ask it to predict forward, then compare its curve against
// what the series actually did. Repeat across many origins and average.
//
// The unit is PERCENTAGE POINTS of the limit — the series is "% of limit used",
// so an error of 4.0 means the forecast was typically four points away from the
// truth. Reported per look-ahead horizon, because a forecast that is excellent
// an hour out and useless twelve hours out is worth telling apart.
//
// Two things are deliberately NOT excluded:
//   - horizons that span a reset. A model that ignores resets should score
//     badly there; that is the difference the cycle models exist to capture.
//   - nothing is scored across a data gap: if no real sample sits near the
//     target time, that pair is skipped rather than interpolated across the
//     hole, so an outage cannot masquerade as forecast error.

const HORIZONS = [3600, 3 * 3600, 6 * 3600, 12 * 3600];   // seconds ahead
const ORIGIN_STEP = 2 * 3600;      // evaluate an origin every 2h of history
const MIN_TRAIN = 30;              // samples required before a forecast is scoreable
const MATCH_TOL = 15 * 60;         // a "real value at t" must sit within 15 min of t

// Closest sample to `t`, or null when the nearest one is further than `tol`
// (i.e. we are inside a gap and have no honest answer).
function actualAt(samples, t, tol = MATCH_TOL) {
  let lo = 0, hi = samples.length - 1;
  if (!samples.length) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t < t) lo = mid + 1; else hi = mid;
  }
  let best = null, bestD = Infinity;
  for (let i = Math.max(0, lo - 1); i <= Math.min(samples.length - 1, lo + 1); i++) {
    const d = Math.abs(samples[i].t - t);
    if (d < bestD) { bestD = d; best = samples[i]; }
  }
  return bestD <= tol && best && best.y != null ? best.y : null;
}

// Absolute errors for one model at one origin, keyed by horizon.
function errorsAtOrigin(P, train, samples, now, opts) {
  const maxH = HORIZONS[HORIZONS.length - 1];
  let r;
  try {
    r = P.predict(train, { now, horizon: maxH, step: 3600, reset: opts && opts.reset });
  } catch {
    return {};                                   // a model that can't fit here just abstains
  }
  const pts = r && r.points;
  if (!pts || !pts.length) return {};
  const out = {};
  for (const h of HORIZONS) {
    const truth = actualAt(samples, now + h);
    if (truth == null) continue;                 // gap — skip rather than invent
    const pred = sampleAt(pts, now + h);
    if (pred == null || !isFinite(pred)) continue;
    out[h] = Math.abs(pred - truth);
  }
  return out;
}

// Replay every model across the history. Returns
//   { models: { name: { [horizon]: mae, n: originsScored } }, origins, horizons }
function scoreModels(samples, opts = {}) {
  const pts = samples.filter((s) => s && s.y != null).sort((a, b) => a.t - b.t);
  const names = opts.models || Object.keys(Predictors);
  const acc = {};
  for (const n of names) {
    acc[n] = { n: 0 };
    for (const h of HORIZONS) acc[n][h] = { sum: 0, n: 0 };
  }
  if (pts.length < MIN_TRAIN + 2) {
    return { models: {}, origins: 0, horizons: HORIZONS, reason: "not enough history" };
  }

  const first = pts[MIN_TRAIN].t, last = pts[pts.length - 1].t;
  const step = opts.originStep || ORIGIN_STEP;
  let origins = 0;
  let ti = 0;
  for (let now = first; now <= last; now += step) {
    while (ti < pts.length && pts[ti].t <= now) ti++;    // train = everything up to `now`
    if (ti < MIN_TRAIN) continue;
    const train = pts.slice(0, ti);
    let scoredHere = false;
    for (const name of names) {
      const P = Predictors[name];
      if (!P) continue;
      const errs = errorsAtOrigin(P, train, pts, now, opts);
      for (const h of HORIZONS) {
        if (errs[h] == null) continue;
        acc[name][h].sum += errs[h];
        acc[name][h].n += 1;
        scoredHere = true;
      }
      if (Object.keys(errs).length) acc[name].n += 1;
    }
    if (scoredHere) origins++;
  }

  const models = {};
  for (const name of names) {
    const row = { n: acc[name].n };
    let any = false;
    for (const h of HORIZONS) {
      const c = acc[name][h];
      row[h] = c.n ? c.sum / c.n : null;
      if (c.n) any = true;
    }
    if (any) models[name] = row;
  }
  return { models, origins, horizons: HORIZONS };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { HORIZONS, actualAt, scoreModels };
}
