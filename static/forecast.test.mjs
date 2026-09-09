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


// ---- margin: the number the floating pill shows -------------------------
// Signed gap between running out and the window resetting. Negative means you
// hit 100% before the reset; positive means the reset saves you.
const { windowMargin, fmtMargin } = mod;

test("fmtMargin picks a unit and always carries a sign", () => {
  // Whole units only — floored, so a partial unit is never rounded up.
  assert.equal(fmtMargin(-2.2 * 24 * H), "-2d");
  assert.equal(fmtMargin(-2.9 * 24 * H), "-2d");
  assert.equal(fmtMargin(5.4 * H), "+5h");
  assert.equal(fmtMargin(-40 * 60e3), "-40m");
  assert.equal(fmtMargin(-59.9 * 60e3), "-59m");
  assert.equal(fmtMargin(Infinity), "+∞");
  assert.equal(fmtMargin(null), null);
});

test("fmtMargin switches units at a day and an hour", () => {
  assert.match(fmtMargin(23.9 * H), /h$/);
  assert.match(fmtMargin(24.1 * H), /d$/);
  assert.match(fmtMargin(59 * 60e3), /m$/);
  assert.match(fmtMargin(61 * 60e3), /h$/);
});

test("margin is negative when the pace runs out before the reset", () => {
  // 4h into a 5h window at 85%: ~21%/h burns the last 15% in well under an hour.
  const m = windowMargin(85, 5 * H, resetIn(1), null);
  assert.ok(m < 0, `expected negative, got ${m}`);
  assert.match(fmtMargin(m), /^-\d+m$/);
});

test("margin is positive when the reset arrives first", () => {
  // 4h into a 5h window at 20%: 5%/h needs 16h more, but the reset is in 1h.
  const m = windowMargin(20, 5 * H, resetIn(1), null);
  assert.ok(m > 0, `expected positive, got ${m}`);
  assert.match(fmtMargin(m), /^\+\d+h$/);   // whole hours, no decimal
});

test("an idle cycle never runs out", () => {
  assert.equal(windowMargin(0, 5 * H, resetIn(1), null), Infinity);
  assert.equal(fmtMargin(windowMargin(0, 5 * H, resetIn(1), null)), "+∞");
});

test("margin stays silent when it cannot know", () => {
  assert.equal(windowMargin(null, 5 * H, resetIn(1), null), null);   // no reading
  assert.equal(windowMargin(30, 5 * H, null, null), null);           // no reset info
  assert.equal(windowMargin(3, 5 * H, resetIn(4 + 55 / 60), null), null);  // just reset
});

test("already at the limit reads as negative by the time still to serve", () => {
  const m = windowMargin(100, 5 * H, resetIn(2), null);
  assert.ok(m < 0);
  // ~2h of the window left to sit out.
  assert.ok(Math.abs(m + 2 * H) < 60e3, `expected ~-2h, got ${m / H}h`);
});


// ---- projectedAtReset: what the pill shows while you are still safe -------
const { projectedAtReset } = mod;

test("projectedAtReset extrapolates the current pace to the reset", () => {
  // 4h into a 5h window at 20% => 5%/h, 1h left => lands at ~25%.
  const p = projectedAtReset(20, 5 * H, resetIn(1), null);
  assert.ok(Math.abs(p - 25) < 0.5, `expected ~25%, got ${p}`);
});

test("projectedAtReset clamps to 100 rather than reporting nonsense", () => {
  // 4h into a 5h window at 85% => ~21%/h would notionally reach 106%.
  assert.equal(projectedAtReset(85, 5 * H, resetIn(1), null), 100);
});

test("with no recent samples it extends the cycle average", () => {
  // 12% over the 4h elapsed is 3%/h, and there is 1h left: 12 -> 15, not 12.
  // pace() is max(recent, average), and the average is never zero once anything
  // has been used — so "flat from here" is deliberately not on offer.
  assert.equal(projectedAtReset(12, 5 * H, resetIn(1), null), 15);
});

test("an untouched cycle lands at zero", () => {
  assert.equal(projectedAtReset(0, 5 * H, resetIn(1), null), 0);
});

test("projectedAtReset stays silent when it cannot know", () => {
  assert.equal(projectedAtReset(null, 5 * H, resetIn(1), null), null);
  assert.equal(projectedAtReset(30, 5 * H, null, null), null);
  assert.equal(projectedAtReset(3, 5 * H, resetIn(4 + 55 / 60), null), null);  // just reset
});

test("the two readings agree about which side of the limit you are on", () => {
  // Safe: margin positive, and the projection lands under 100.
  assert.ok(windowMargin(20, 5 * H, resetIn(1), null) > 0);
  assert.ok(projectedAtReset(20, 5 * H, resetIn(1), null) < 100);
  // Overrunning: margin negative, and the projection is pinned at the limit.
  assert.ok(windowMargin(85, 5 * H, resetIn(1), null) < 0);
  assert.equal(projectedAtReset(85, 5 * H, resetIn(1), null), 100);
});
