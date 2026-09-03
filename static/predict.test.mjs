// Unit tests for the usage-prediction interface (Predictors.linear).
// Run: node --test static/predict.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import mod from "./predict.js";

const { Predictors } = mod;

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
