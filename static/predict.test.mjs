// Unit tests for the usage-prediction interface (Predictors.linear).
// Run: node --test static/predict.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import mod from "./predict.js";

const { Predictors, segmentCycles, cycleSlopes, robustMean, inferResetPeriod, sampleAt } = mod;

// A climbing cycle 0→10 over 300s starting at t0 (drop of 10 marks the reset).
const climbCycle = (t0) => [0, 1, 2, 3, 4, 5].map((i) => ({ t: t0 + i * 60, y: i * 2 }));

// +1% per 60s, last observed = 15 at t=300
const rising = [0, 60, 120, 180, 240, 300].map((t, i) => ({ t, y: 10 + i }));

test("method is reported", () => {
  const r = Predictors.linear.predict(rising, { now: 300, horizon: 60, step: 60 });
  assert.equal(r.method, "linear");
});

test("extrapolates at the fitted slope, anchored at the last observed value", () => {
  const r = Predictors.linear.predict(rising, { now: 300, horizon: 300, step: 60 });
  assert.equal(r.points[0].t, 300);
  assert.equal(Math.round(r.points[0].y), 15);          // anchor = last value
  const last = r.points[r.points.length - 1];
  assert.equal(last.t, 600);
  assert.equal(Math.round(last.y), 20);                 // +1%/min over 5 min → +5
});

test("output length tracks horizon/step (anchor + one per step)", () => {
  const r = Predictors.linear.predict(rising, { now: 300, horizon: 300, step: 60 });
  assert.equal(r.points.length, 6);                     // 300,360,420,480,540,600
});

test("clamps to cap (100)", () => {
  const near = [0, 60, 120, 180, 240, 300].map((t, i) => ({ t, y: 90 + i * 2 })); // →100, rising
  const r = Predictors.linear.predict(near, { now: 300, horizon: 300, step: 60 });
  assert.ok(r.points.every((p) => p.y <= 100));
});

test("clamps to 0 on a downward slope", () => {
  const falling = [0, 60, 120, 180, 240, 300].map((t, i) => ({ t, y: 5 - i })); // 5..0
  const r = Predictors.linear.predict(falling, { now: 300, horizon: 300, step: 60 });
  assert.ok(r.points.every((p) => p.y >= 0));
});

test("flat prognosis when too few points to fit", () => {
  const two = [{ t: 0, y: 7 }, { t: 60, y: 7 }];
  const r = Predictors.linear.predict(two, { now: 60, horizon: 120, step: 60 });
  assert.ok(r.points.every((p) => p.y === 7));
});

test("ignores null samples and defaults now to the last sample", () => {
  const withNull = [
    { t: 0, y: 10 }, { t: 60, y: null }, { t: 120, y: 12 },
    { t: 180, y: 13 }, { t: 240, y: 14 }, { t: 300, y: 15 },
  ];
  const r = Predictors.linear.predict(withNull, { horizon: 60, step: 60 });
  assert.equal(r.points[0].t, 300);
  assert.equal(Math.round(r.points[0].y), 15);
});

// ---- cycle strategy ----

test("segmentCycles splits at a reset drop", () => {
  const pts = [
    { t: 0, y: 0 }, { t: 60, y: 10 }, { t: 120, y: 20 },   // cycle 1
    { t: 180, y: 2 },                                       // drop 20 -> 2 = reset
    { t: 240, y: 5 }, { t: 300, y: 12 },                   // cycle 2
  ];
  const cycles = segmentCycles(pts);
  assert.equal(cycles.length, 2);
  assert.equal(cycles[0].length, 3);
  assert.equal(cycles[1].length, 3);
});

test("robustMean plain-averages small samples, drops extreme outliers when n>=4", () => {
  assert.equal(robustMean([2, 2, 2]), 2);                  // n<4 -> plain mean
  assert.ok(Math.abs(robustMean([2, 2, 2, 2, 2, 30]) - 2) < 1e-9);  // 30 is >2σ -> dropped
});

test("cycleSlopes returns one slope per fittable cycle", () => {
  const c1 = [0, 60, 120, 180, 240, 300].map((t, i) => ({ t, y: i * 2 }));      // slope 2/60
  const c2 = [360, 420, 480, 540, 600, 660].map((t, i) => ({ t, y: i * 2 }));   // slope 2/60, post-reset
  const slopes = cycleSlopes([...c1, ...c2]);
  assert.equal(slopes.length, 2);
  for (const s of slopes) assert.ok(Math.abs(s - 2 / 60) < 1e-6);
});

test("cycle predictor projects at the robust cross-cycle rate", () => {
  const c1 = [0, 60, 120, 180, 240, 300].map((t, i) => ({ t, y: i * 2 }));
  const c2 = [360, 420, 480, 540, 600, 660].map((t, i) => ({ t, y: i * 2 }));
  const r = Predictors.cycle.predict([...c1, ...c2], { now: 660, horizon: 300, step: 60 });
  assert.equal(r.method, "cycle");
  assert.equal(r.points[0].t, 660);
  assert.equal(Math.round(r.points[0].y), 10);            // anchor = last value
  assert.equal(Math.round(r.points[r.points.length - 1].y), 20);  // +2%/min × 5min
});

test("cycle falls back to a flat line when there are no fittable cycles", () => {
  const two = [{ t: 0, y: 7 }, { t: 60, y: 7 }];
  const r = Predictors.cycle.predict(two, { now: 60, horizon: 120, step: 60 });
  assert.ok(r.points.every((p) => p.y === 7));
});

// ---- reset-aware projection ----

test("inferResetPeriod finds the reset period and last reset from cycles", () => {
  const pts = [...climbCycle(0), ...climbCycle(360), ...climbCycle(720), ...climbCycle(1080)];
  const r = inferResetPeriod(pts);
  assert.equal(r.P, 360);
  assert.equal(r.R, 1080);
});

test("inferResetPeriod returns null with too few cycles", () => {
  assert.equal(inferResetPeriod([...climbCycle(0), ...climbCycle(360)]), null);
});

test("cycle projection drops to 0 at the inferred reset and resumes", () => {
  const pts = [...climbCycle(0), ...climbCycle(360), ...climbCycle(720), ...climbCycle(1080)];
  // P=360, R=1080, now=1380, yLast=10 → next reset at 1440, inside a 720s horizon.
  const r = Predictors.cycle.predict(pts, { now: 1380, horizon: 720, step: 60 });
  const atReset = r.points.find((p) => Math.abs(p.t - 1440) < 1e-6);
  assert.ok(atReset && atReset.y < 0.01, "drops to ~0 at the reset");
  const beforeReset = r.points.filter((p) => p.t < 1440).pop();
  assert.ok(beforeReset.y > 5, "climbs before the reset");
  const afterReset = r.points.find((p) => p.t > 1440);
  assert.ok(afterReset.y >= 0 && afterReset.y < beforeReset.y, "resumes from low after the reset");
});

test("cycle projection stays monotonic (no drop) when the period can't be inferred", () => {
  const pts = [...climbCycle(0), ...climbCycle(360)];   // only 2 cycles → no period
  const r = Predictors.cycle.predict(pts, { now: 660, horizon: 300, step: 60 });
  for (let i = 1; i < r.points.length; i++) {
    assert.ok(r.points[i].y >= r.points[i - 1].y - 1e-9, "no reset drop");
  }
});

test("sampleAt linearly interpolates between points and clamps to the ends", () => {
  const pts = [{ t: 0, y: 0 }, { t: 100, y: 10 }, { t: 200, y: 10 }];
  assert.equal(sampleAt(pts, 0), 0);       // exact endpoint
  assert.equal(sampleAt(pts, 50), 5);      // interpolate rising segment
  assert.equal(sampleAt(pts, 150), 10);    // interpolate flat segment
  assert.equal(sampleAt(pts, -10), 0);     // clamp below the first point
  assert.equal(sampleAt(pts, 999), 10);    // clamp above the last point
});
