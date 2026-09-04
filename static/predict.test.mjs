// Unit tests for the usage-prediction interface (Predictors.linear).
// Run: node --test static/predict.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import mod from "./predict.js";

const { Predictors, segmentCycles, cycleSlopes, robustMean, inferResetPeriod, sampleAt, hourlyRates, consumptionRatio, deriveSeries, weightedRobustMean, recencyWeight, recentTrailingSlope, normalizeHourly, resolveReset } = mod;

// A climbing cycle 0→10 over 300s starting at t0 (drop of 10 marks the reset).
const climbCycle = (t0) => [0, 1, 2, 3, 4, 5].map((i) => ({ t: t0 + i * 60, y: i * 2 }));

// Deterministic hour-of-day for tests (avoids machine-timezone dependence).
const utcHour = (t) => Math.floor(t / 3600) % 24;

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

// ---- time-of-day (cycle+tod) ----

test("hourlyRates buckets in-cycle increments by hour, robust-averaged; sparse → undefined", () => {
  const pts = [];
  for (let i = 0; i <= 6; i++) pts.push({ t: i * 600, y: i * 1.2 });        // hour 0: rate 0.002 %/s
  for (let i = 1; i <= 6; i++) pts.push({ t: 3600 + i * 600, y: 7.2 });     // hour 1: flat
  const { hourly, overall } = hourlyRates(pts, { hourOf: utcHour, minCount: 3 });
  assert.ok(Math.abs(hourly[0] - 0.002) < 1e-6);
  assert.ok(Math.abs(hourly[1] - 0) < 1e-9);
  assert.equal(hourly[12], undefined);          // no data → undefined (caller falls back)
  assert.ok(overall > 0);
});

test("cycle+tod applies the hour-of-day shape when it's well-populated", () => {
  // 3 days of data; even hours climb, odd hours flat → 12 active hours → full confidence.
  const hourOf = (t) => Math.floor(t / 3600) % 24;
  const pts = [];
  let y = 0;
  for (let t = 0; t <= 3 * 86400; t += 600) { pts.push({ t, y }); y += (Math.floor(t / 3600) % 2 === 0 ? 0.0002 : 0) * 600; }  // stays well under 100
  const now = pts[pts.length - 1].t;
  const r = Predictors["cycle+tod"].predict(pts, { now, horizon: 8 * 3600, step: 1800, hourOf });
  const evenD = [], oddD = [];
  for (let i = 1; i < r.points.length; i++) {
    const p0 = r.points[i - 1], p1 = r.points[i];
    if (p1.t < now + 3 * 3600) continue;   // skip the momentum-dominated near term
    (Math.floor(p0.t / 3600) % 2 === 0 ? evenD : oddD).push(p1.y - p0.y);
  }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  assert.ok(avg(evenD) > avg(oddD), "fast (even) hours climb more than slow (odd) hours");
});

test("cycle+tod falls back to the overall rate for hours with no data", () => {
  const pts = [];
  let y = 0;
  for (let t = 0; t <= 3 * 3600; t += 600) { pts.push({ t, y }); y += 0.001 * 600; }   // hours 0–2 only
  const now = pts[pts.length - 1].t;                                                    // hour 3, no data
  const r = Predictors["cycle+tod"].predict(pts, { now, horizon: 3600, step: 1800, hourOf: utcHour });
  assert.ok(r.points[r.points.length - 1].y - r.points[0].y > 0, "climbs via overall-rate fallback");
});

test("cycle+tod keeps reset drops", () => {
  const pts = [...climbCycle(0), ...climbCycle(360), ...climbCycle(720), ...climbCycle(1080)];
  const r = Predictors["cycle+tod"].predict(pts, { now: 1380, horizon: 720, step: 60, hourOf: utcHour });
  const atReset = r.points.find((p) => Math.abs(p.t - 1440) < 1e-6);
  assert.ok(atReset && atReset.y < 0.01, "drops to ~0 at the inferred reset");
});

// ---- 7-day derived from 5-hour ----

test("consumptionRatio = Σ positive 7-day increments / Σ positive 5-hour increments", () => {
  const a = [0, 10, 20, 5, 15];   // positive increments: 10+10+10 = 30 (drop 20→5 ignored)
  const b = [0, 1, 2, 2, 3];      // positive increments: 1+1+1 = 3
  assert.ok(Math.abs(consumptionRatio(a, b) - 0.1) < 1e-9);
});

test("consumptionRatio is null when the source barely moves", () => {
  assert.equal(consumptionRatio([0, 0.2, 0.3], [0, 5, 10]), null);   // Σd(source) < 1 → not derivable
  assert.equal(consumptionRatio([0, 0, 0], [0, 1, 2]), null);
});

test("deriveSeries integrates source consumption, holding across source resets", () => {
  const src = [
    { t: 0, y: 50 }, { t: 1, y: 60 }, { t: 2, y: 70 },
    { t: 3, y: 0 },                                     // source (5-hour) reset
    { t: 4, y: 10 }, { t: 5, y: 20 },
  ];
  const d = deriveSeries(src, 20, 0.1, 100);
  assert.equal(d[0].y, 20);                     // anchored at the current 7-day value
  assert.ok(Math.abs(d[2].y - 22) < 1e-9);      // 20 + 0.1*20
  assert.equal(d[3].y, d[2].y);                 // 7-day holds across the 5-hour reset
  assert.ok(Math.abs(d[5].y - 24) < 1e-9);      // 20 + 0.1*40
  for (let i = 1; i < d.length; i++) assert.ok(d[i].y >= d[i - 1].y - 1e-9, "monotonic");
});

test("deriveSeries clamps to cap", () => {
  const d = deriveSeries([{ t: 0, y: 0 }, { t: 1, y: 100 }], 90, 1, 100);
  assert.equal(d[1].y, 100);
});

// ---- recency weighting ----

test("recencyWeight is 1.0 at age 0 and 0.5 at the half-life", () => {
  assert.equal(recencyWeight(100, 100, 3 * 86400), 1);
  assert.ok(Math.abs(recencyWeight(100 - 3 * 86400, 100, 3 * 86400) - 0.5) < 1e-9);
});

test("weightedRobustMean: equal weights == plain mean; weights bias toward heavier values", () => {
  assert.equal(weightedRobustMean([1, 2, 3], [1, 1, 1]), 2);
  assert.ok(Math.abs(weightedRobustMean([0, 10], [1, 3]) - 7.5) < 1e-9);   // n<4 → no trim
});

test("weightedRobustMean keeps a heavily-weighted recent value that robustMean would trim", () => {
  const vals = [0, 0, 0, 0, 0, 10];
  assert.ok(robustMean(vals) < 1, "unweighted trims the 10 to ~0");
  assert.ok(weightedRobustMean(vals, [1, 1, 1, 1, 1, 50]) > 5, "weighted keeps the recent burst");
});

test("recency weighting lifts a recently-active bursty series above the unweighted estimate", () => {
  const hourOf = () => 0;   // all increments land in one bucket
  const DAY = 86400;
  const pts = [];
  let y = 0;
  for (let d = 0; d < 5; d++) for (let k = 0; k < 6; k++) pts.push({ t: d * DAY + k * 600, y });   // 5 idle days
  const base = 5 * DAY;
  for (let k = 0; k <= 12; k++) { pts.push({ t: base + k * 600, y }); y += 0.01 * 600; }            // recent active day
  const now = pts[pts.length - 1].t;
  const rec = hourlyRates(pts, { hourOf, now, halfLife: 3 * DAY, minCount: 3 });
  const flat = hourlyRates(pts, { hourOf, now, halfLife: Infinity, minCount: 3 });   // no decay
  assert.ok(rec.hourly[0] > flat.hourly[0], "recency raises the current rate estimate");
});

// ---- recent-trend blend ----

test("recentTrailingSlope = slope over the last hour of the current cycle", () => {
  const now = 100000, pts = [];
  for (let t = now - 3600; t <= now; t += 300) pts.push({ t, y: (t - (now - 3600)) * 0.001 });
  assert.ok(Math.abs(recentTrailingSlope(pts, now, 3600) - 0.001) < 1e-4);
});

test("recentTrailingSlope is 0 when recent activity is flat", () => {
  const now = 100000, pts = [];
  for (let t = now - 3600; t <= now; t += 300) pts.push({ t, y: 50 });
  assert.equal(recentTrailingSlope(pts, now, 3600), 0);
});

test("recentTrailingSlope ignores samples before the latest reset", () => {
  const now = 100000, pts = [];
  for (let t = now - 8 * 3600; t <= now - 6 * 3600; t += 300) pts.push({ t, y: (t - (now - 8 * 3600)) * 0.002 }); // old climb
  for (let t = now - 3000; t <= now; t += 300) pts.push({ t, y: 5 });   // recent flat (post-reset)
  assert.equal(recentTrailingSlope(pts, now, 3600), 0);
});

test("cycle+tod blends in the recent burst near-term, fading to the historical shape", () => {
  const now = 10 * 86400, pts = [];
  for (let t = 0; t <= now - 3600; t += 600) pts.push({ t, y: 50 });                 // long flat/idle history
  let y = 50;
  for (let t = now - 3000; t <= now; t += 600) { y += 0.005 * 600; pts.push({ t, y }); }  // recent burst
  const r = Predictors["cycle+tod"].predict(pts, { now, horizon: 4 * 3600, step: 1800, hourOf: () => 0 });
  const d0 = r.points[1].y - r.points[0].y;
  const dEnd = r.points[r.points.length - 1].y - r.points[r.points.length - 2].y;
  assert.ok(d0 > 1, "near-term reflects the recent burst");
  assert.ok(dEnd < d0, "recent momentum fades over the horizon");
});

// ---- normalize hour-of-day to the overall consumption rate ----

test("normalizeHourly: day-mean equals overall; a rich shape is preserved", () => {
  const hourly = Array.from({ length: 24 }, (_, h) => (h < 12 ? 0.001 : 0.003));   // 24 active hours
  const rate = normalizeHourly(hourly, 0.5, {});
  assert.ok(Math.abs(rate.reduce((a, b) => a + b, 0) / 24 - 0.5) < 1e-9, "day mean = overall");
  assert.ok(rate[13] > rate[1], "busy hour stays above quiet hour");
});

test("normalizeHourly: a sparse shape shrinks toward uniform (idle hours non-zero)", () => {
  const hourly = Array.from({ length: 24 }, (_, h) => (h === 9 || h === 14 ? 0.02 : 0));  // 2 active hours
  const rate = normalizeHourly(hourly, 0.5, {});
  assert.ok(Math.abs(rate.reduce((a, b) => a + b, 0) / 24 - 0.5) < 1e-9, "day mean still = overall");
  assert.ok(rate[3] > 0.25, "idle hour gets a meaningful share, not ~0");   // ~0.75×overall
  assert.ok(rate[9] > rate[3], "active hour still higher");
});

test("normalizeHourly: all-zero or undefined hours → uniform overall", () => {
  assert.ok(normalizeHourly(new Array(24).fill(0), 0.5, {}).every((r) => Math.abs(r - 0.5) < 1e-9));
  assert.ok(normalizeHourly(new Array(24).fill(undefined), 0.5, {}).every((r) => Math.abs(r - 0.5) < 1e-9));
});

test("cycle+tod refills at the overall rate when hour-of-day is sparse (no flat tail)", () => {
  const DAY = 86400, pts = [];
  for (let t = 0; t <= 3 * DAY; t += 600) pts.push({ t, y: Math.floor((t / DAY) * 20) });  // coarse climb ~20/day
  const now = pts[pts.length - 1].t;
  const r = Predictors["cycle+tod"].predict(pts, { now, horizon: 6 * 3600, step: 1800, hourOf: (t) => Math.floor(t / 3600) % 24 });
  const late = r.points.filter((p) => p.t >= now + 3 * 3600);          // past the 2h momentum window
  assert.ok(late[late.length - 1].y - late[0].y > 0, "keeps climbing at the overall rate after momentum fades");
});

// --- Authoritative reset override (API reset_at/window_seconds) ---------------
// Codex reports the true window length + next reset; the forecast must project on
// that period, not one guessed from noisy data drops.

// Data that drops to 0 every 2 days → inferResetPeriod reads a ~2-day period.
function twoDayDrops() {
  const pts = [];
  let y = 0;
  for (let t = 0; t <= 8 * 86400; t += 3600) {
    pts.push({ t, y });
    y += 0.5;
    if ((t + 3600) % (2 * 86400) === 0) y = 0;   // reset every 2 days
  }
  return pts;
}
const resetTimes = (points, now) => {
  const out = [];
  for (let i = 1; i < points.length; i++)
    if (points[i].t > now && points[i].y < points[i - 1].y - 20) out.push(points[i].t);
  return out;
};
const gaps = (ts) => ts.slice(1).map((t, i) => t - ts[i]);

test("resolveReset prefers a valid opts.reset over the inferred period", () => {
  const pts = twoDayDrops();
  assert.deepEqual(resolveReset(pts, { reset: { P: 604800, R: 100 } }), { P: 604800, R: 100 });
});

test("resolveReset falls back to inferred when the override is absent/invalid", () => {
  const pts = twoDayDrops();
  const inf = resolveReset(pts, {});
  assert.ok(inf && inf.P < 4 * 86400, "inferred ~2-day period");
  assert.ok(resolveReset(pts, { reset: { P: 0, R: 5 } }).P < 4 * 86400, "P<=0 override ignored");
  assert.ok(resolveReset(pts, { reset: null }).P < 4 * 86400, "null override ignored");
});

test("cycle projects resets on the authoritative period, not the inferred one", () => {
  const pts = twoDayDrops();
  const now = pts[pts.length - 1].t;
  const inferred = Predictors.cycle.predict(pts, { now, horizon: 20 * 86400, step: 3600 });
  assert.ok(gaps(resetTimes(inferred.points, now)).every((g) => g < 4 * 86400), "inferred = ~2-day drops");
  const auth = Predictors.cycle.predict(pts, { now, horizon: 25 * 86400, step: 3600, reset: { P: 7 * 86400, R: now } });
  const g = gaps(resetTimes(auth.points, now));
  assert.ok(g.length >= 2 && g.every((x) => Math.abs(x - 7 * 86400) < 3600), "override = 7-day resets");
});

test("cycle+tod projects resets on the authoritative period", () => {
  const pts = twoDayDrops();
  const now = pts[pts.length - 1].t;
  const auth = Predictors["cycle+tod"].predict(pts, { now, horizon: 25 * 86400, step: 3600, reset: { P: 7 * 86400, R: now }, hourOf: (t) => Math.floor(t / 3600) % 24 });
  const g = gaps(resetTimes(auth.points, now));
  assert.ok(g.length >= 2 && g.every((x) => Math.abs(x - 7 * 86400) < 3600), "override = 7-day resets");
});
