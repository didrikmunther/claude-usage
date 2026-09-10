"use strict";

// Forecast text shared by the dashboard and the floating widget. Turns a window's
// current %, its length and its reset instant into the human sentence you read
// ("hits 100% in 2h 10m …"). Kept apart from app.js so the widget can reuse the
// exact wording rather than growing a second, drifting implementation.
//
// Browser (classic <script>): these top-level consts/functions are shared globals.
// Node (tests): expose via CommonJS. `module` is undefined in the browser.

const MIN_ELAPSED_MS = 10 * 60e3;   // ignore the noisy first minutes of a cycle

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 1) return `${d}d ${h % 24}h`;
  if (h >= 1) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

function fmtClock(ms) {
  const dt = new Date(ms);
  const t = dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const soon = ms - Date.now() < 24 * 3600 * 1000;
  return soon ? t : `${dt.toLocaleDateString([], { weekday: "short" })} ${t}`;
}

// Trailing-window least-squares slope (%/sec): the rate over just the last
// `lookbackSec`, so an old idle stretch is excluded entirely and a fresh burst
// shows its true pace (easing in as the window fills). null if degenerate.
function recentSlope(pts, lookbackSec, nowSec) {
  const cut = nowSec - lookbackSec;
  const seg = pts ? pts.filter((p) => p[0] >= cut) : [];
  if (seg.length < 3 || seg[seg.length - 1][0] - seg[0][0] < 180) return null;
  const n = seg.length, t0 = seg[0][0];
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [t, y] of seg) { const x = t - t0; sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < 1e-9) return null;
  return (n * sxy - sx * sy) / den;              // %/sec
}

// ---- forecast (shared) ----
// Samples for one window since its last reset: [[t_sec, used%], ...] from the
// chart buffer, trimmed to this cycle (drop pre-reset points and any reset dip).
function cycleSamples(data, idx, resetMs, winMs) {
  const cycleStart = (resetMs - winMs) / 1000;   // sec
  const ts = data[0], ys = data[idx];
  const pts = [];
  for (let i = 0; i < ts.length; i++) {
    if (ys[i] == null || ts[i] < cycleStart - 60) continue;
    pts.push([ts[i], ys[i]]);
  }
  let start = 0;                                  // trim at last reset dip inside the buffer
  for (let i = 1; i < pts.length; i++) if (pts[i][1] < pts[i - 1][1] - 5) start = i;
  return pts.slice(start);
}

// Forward pace for one window, in %/sec. Conservative: the higher of the recent
// trailing rate and the cycle average, so a burst pushes it up but it won't relax
// the instant you pause after one. Returns all three so callers can also explain
// which one is driving.
function pace(cur, elapsedMs, winMs, samples, nowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  const avgPerSec = cur / (elapsedMs / 1000);
  let recentPerSec = null;
  if (samples && samples.length >= 3) {
    const lookback = Math.min(12 * 3600, Math.max(1200, winMs / 1000 / 12));  // 5h→25m, 7d→12h
    const r = recentSlope(samples, lookback, now / 1000);
    if (r != null && isFinite(r)) recentPerSec = r;
  }
  const perSec = recentPerSec != null ? Math.max(recentPerSec, avgPerSec) : avgPerSec;
  return { avgPerSec, recentPerSec, perSec };
}

// The signed gap, in ms, between running out and the window resetting.
//   negative → you hit 100% this long BEFORE the reset (you run out early)
//   positive → the reset arrives first, by this much (you have slack)
//   Infinity → at the current pace you never get there
// null when there is nothing honest to say yet. This is what the pill shows.
function windowMargin(cur, winMs, resetIso, samples) {
  if (cur == null) return null;
  const resetMs = resetIso ? new Date(resetIso).getTime() : null;
  if (resetMs == null) return null;
  const now = Date.now();
  const elapsed = now - (resetMs - winMs);
  if (elapsed < MIN_ELAPSED_MS) return null;      // too soon after a reset to mean anything
  if (cur >= 99.5) return now - resetMs;          // already out; negative by the time still to serve
  const { perSec } = pace(cur, elapsed, winMs, samples, now);
  if (!(perSec > 1e-9)) return Infinity;          // idle → never runs out
  return now + ((100 - cur) / perSec) * 1000 - resetMs;
}

// A margin as the pill renders it, whole units only: "-2d", "+5h", "-40m", "+∞".
function fmtMargin(ms) {
  if (ms == null) return null;
  if (!isFinite(ms)) return "+∞";
  const sign = ms < 0 ? "-" : "+";
  // Floored, never rounded: on a pill you want the number you have definitely
  // still got. "2d" with 2.9 days left is pessimistic; "3d" with 2.1 would be a
  // small lie in the direction that matters.
  const sec = Math.abs(ms) / 1000;
  if (sec >= 86400) return sign + Math.floor(sec / 86400) + "d";
  if (sec >= 3600) return sign + Math.floor(sec / 3600) + "h";
  return sign + Math.floor(sec / 60) + "m";
}

// Where this window lands, as a percentage of the limit, at the moment it
// resets — at the current forward pace. This is what the pill shows whenever the
// reset arrives before you run out: "32%" reads better than "+5.6d of slack",
// because it answers the question you actually have (how much will I have used?)
// rather than restating the same fact as a duration. Clamped to [0, 100].
function projectedAtReset(cur, winMs, resetIso, samples) {
  if (cur == null) return null;
  const resetMs = resetIso ? new Date(resetIso).getTime() : null;
  if (resetMs == null) return null;
  const now = Date.now();
  const elapsed = now - (resetMs - winMs);
  if (elapsed < MIN_ELAPSED_MS) return null;      // too soon after a reset to mean anything
  const { perSec } = pace(cur, elapsed, winMs, samples, now);
  const proj = cur + Math.max(0, perSec) * ((resetMs - now) / 1000);
  return Math.max(0, Math.min(100, proj));
}

// The same verdicts forecast() produces, but read off a predictor's trajectory
// instead of a single straight-line pace — so the sentence in the text row and
// the dashed curve on the chart cannot disagree. Returns null when the points
// are unusable, so the caller can fall back to forecast().
function forecastFromPoints(cur, winMs, resetIso, points) {
  if (cur == null) return null;
  const resetMs = resetIso ? new Date(resetIso).getTime() : null;
  if (resetMs == null) return { cls: "muted", msg: "no reset info" };
  if (cur >= 99.5) return { cls: "warn", msg: "at the limit" };
  const now = Date.now();
  const elapsed = now - (resetMs - winMs);
  const resetIn = fmtDur((resetMs - now) / 1000);
  if (elapsed < MIN_ELAPSED_MS) return { cls: "muted", msg: `just reset — gathering data… · resets in ${resetIn}` };
  if (!points || points.length < 2) return null;

  const resetT = resetMs / 1000;
  let hit = null, atReset = cur, prev = points[0];
  for (const p of points) {
    if (p.t > resetT) break;
    // The cycle models draw the reset itself — a drop back to zero. That drop is
    // the boundary we are forecasting TO, so stop at it; reading past it reports
    // the next cycle's opening value and turns a 96% week into "idle at 34%".
    if (p.y < prev.y - 5) break;
    atReset = p.y;
    if (hit == null && p.y >= 100 && p.t > now / 1000) {
      // Interpolate the crossing rather than snapping to the hourly step.
      const span = p.t - prev.t, rise = p.y - prev.y;
      hit = rise > 0 ? prev.t + ((100 - prev.y) / rise) * span : p.t;
    }
    prev = p;
  }
  // The rate quoted is the trajectory's own average to the reset, not a
  // separately-computed slope — same reason as above.
  const hours = Math.max(1e-9, (resetT - now / 1000) / 3600);
  const perH = (atReset - cur) / hours;
  const rate = (perH >= 0 ? "+" : "") + perH.toFixed(Math.abs(perH) < 10 ? 1 : 0) + "%/h";

  // atReset / hitMs are the same verdict as numbers, for callers that draw
  // rather than write — the pill needs them to stay in step with the text row.
  const nums = { atReset, hitMs: hit == null ? null : hit * 1000 };
  if (hit != null) {
    const exhaustMs = hit * 1000;
    return {
      cls: "warn",
      msg: `hits 100% in ${fmtDur(hit - now / 1000)} (${fmtClock(exhaustMs)}) · ` +
           `${fmtDur((resetMs - exhaustMs) / 1000)} before reset`,
      rate, ...nums,
    };
  }
  if (atReset - cur < 0.5 && perH <= 0) {
    return { cls: "ok", msg: `idle — steady at ~${Math.round(cur)}% · resets in ${resetIn}`, rate, ...nums };
  }
  return { cls: "ok", msg: `on track — ~${Math.round(atReset)}% by reset (${resetIn})`, rate, ...nums };
}

// Forecast for one window. "already used" (cur%) stays anchored to the reset; the
// FORWARD pace uses the recent weighted rate when history is available, else the
// cycle average. Returns {cls, msg, rate} or null.
function forecast(cur, winMs, resetIso, samples) {
  if (cur == null) return null;
  const resetMs = resetIso ? new Date(resetIso).getTime() : null;
  if (resetMs == null) return { cls: "muted", msg: "no reset info" };
  if (cur >= 99.5) return { cls: "warn", msg: "at the limit" };
  const now = Date.now();
  const elapsed = now - (resetMs - winMs);
  const resetIn = fmtDur((resetMs - now) / 1000);
  if (elapsed < MIN_ELAPSED_MS) return { cls: "muted", msg: `just reset — gathering data… · resets in ${resetIn}` };

  const { avgPerSec, recentPerSec, perSec } = pace(cur, elapsed, winMs, samples, now);

  const fmtRate = (v) => (v >= 0 ? "+" : "") + v.toFixed(Math.abs(v) < 10 ? 1 : 0) + "%/h";
  const avgPerH = avgPerSec * 3600, recentPerH = recentPerSec != null ? recentPerSec * 3600 : null;
  let rate = fmtRate(perSec * 3600);
  if (recentPerH != null && Math.abs(recentPerH - avgPerH) > Math.max(1, 0.25 * Math.abs(avgPerH))) {
    rate = recentPerH >= avgPerH                  // show which pace drives + the other as context
      ? `${fmtRate(recentPerH)} · avg ${fmtRate(avgPerH)}`
      : `${fmtRate(avgPerH)} · recent ${fmtRate(recentPerH)}`;
  }

  if (cur < 0.5 && perSec <= 0) return { cls: "ok", msg: `no usage yet this cycle · resets in ${resetIn}`, rate };
  if (perSec <= 1e-6) return { cls: "ok", msg: `idle — steady at ~${Math.round(cur)}% · resets in ${resetIn}`, rate };

  const projAtReset = cur + perSec * ((resetMs - now) / 1000);
  if (projAtReset < 100) return { cls: "ok", msg: `on track — ~${Math.round(projAtReset)}% by reset (${resetIn})`, rate };
  const secsTo100 = (100 - cur) / perSec;
  const exhaustMs = now + secsTo100 * 1000;
  return {
    cls: "warn",
    msg: `hits 100% in ${fmtDur(secsTo100)} (${fmtClock(exhaustMs)}) · ${fmtDur((resetMs - exhaustMs) / 1000)} before reset`,
    rate,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { MIN_ELAPSED_MS, fmtDur, fmtClock, recentSlope, cycleSamples,
                     pace, windowMargin, fmtMargin, projectedAtReset, forecast,
                     forecastFromPoints };
}
