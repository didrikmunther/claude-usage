// Unit tests for the forecast sentences shared by the dashboard and the floating
// widget. Run: node --test static/forecast.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import mod from "./forecast.js";

const { fmtDur, recentSlope, cycleSamples, forecast } = mod;

const H = 3600e3;
// A window whose reset is `inH` hours away, so `winH - inH` hours have elapsed.
const resetIn = (inH) => new Date(Date.now() + inH * H).toISOString();

test("fmtDur drops to the coarsest useful unit", () => {
  assert.equal(fmtDur(90), "1m");            // truncates to whole minutes
  assert.equal(fmtDur(45), "0m");            // ...so under a minute reads as 0m
  assert.equal(fmtDur(90 * 60), "1h 30m");
  assert.equal(fmtDur(28 * 3600), "1d 4h");
  assert.equal(fmtDur(-5), "0m");            // clamped, never negative
});

test("recentSlope measures %/sec over the trailing window only", () => {
  const now = 10_000;
  // +1% per 100s for 10 points, but an idle hour before it that must be ignored.
  const pts = [[now - 4000, 0], [now - 3900, 0]];
  for (let i = 0; i <= 9; i++) pts.push([now - 900 + i * 100, i]);
  const slope = recentSlope(pts, 1000, now);
  assert.ok(Math.abs(slope - 0.01) < 1e-6, `expected ~0.01 %/s, got ${slope}`);
});

test("recentSlope refuses degenerate input", () => {
  assert.equal(recentSlope([], 600, 0), null);
  assert.equal(recentSlope([[0, 1], [10, 2]], 600, 10), null);       // too few points
  assert.equal(recentSlope([[0, 1], [1, 2], [2, 3]], 600, 2), null); // spans < 180s
});

test("cycleSamples trims everything before the last reset dip", () => {
  //           t: 0  60 120 180 240
  const data = [[0, 60, 120, 180, 240], [5, 9, 1, 4, 7], null];
  // A 5-point buffer where usage drops 9 -> 1 at t=120: that dip is the reset.
  const out = cycleSamples(data, 1, 300_000, 300_000);
  assert.deepEqual(out, [[120, 1], [180, 4], [240, 7]]);
});

test("forecast reports the trivial states plainly", () => {
  assert.equal(forecast(null, 5 * H, resetIn(1), null), null);
  assert.equal(forecast(10, 5 * H, null, null).msg, "no reset info");
  assert.equal(forecast(99.6, 5 * H, resetIn(1), null).msg, "at the limit");
});

test("forecast waits out the noisy minutes after a reset", () => {
  // 5-hour window resetting in 4h55m => only 5 minutes elapsed.
  const p = forecast(3, 5 * H, resetIn(4 + 55 / 60), null);
  assert.equal(p.cls, "muted");
  assert.match(p.msg, /just reset/);
});

test("forecast says on track when the pace lands under 100%", () => {
  // 4h into a 5h window at 20% => 5%/h => ~25% by reset.
  const p = forecast(20, 5 * H, resetIn(1), null);
  assert.equal(p.cls, "ok");
  assert.match(p.msg, /on track/);
  assert.match(p.msg, /~2[45]% by reset/);
});

test("forecast warns, with a time, when the pace overruns the window", () => {
  // 4h into a 5h window at 85% => ~21%/h => blows past 100 before the reset.
  const p = forecast(85, 5 * H, resetIn(1), null);
  assert.equal(p.cls, "warn");
  assert.match(p.msg, /hits 100% in/);
  assert.match(p.msg, /before reset/);
});

test("forecast calls out an untouched cycle", () => {
  const p = forecast(0, 5 * H, resetIn(1), null);
  assert.equal(p.cls, "ok");
  assert.match(p.msg, /no usage yet this cycle/);
});
