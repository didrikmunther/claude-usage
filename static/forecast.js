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

  const avgPerSec = cur / (elapsed / 1000);
  let recentPerSec = null;
  if (samples && samples.length >= 3) {
    const lookback = Math.min(12 * 3600, Math.max(1200, winMs / 1000 / 12));  // 5h→25m, 7d→12h
    const r = recentSlope(samples, lookback, now / 1000);
    if (r != null && isFinite(r)) recentPerSec = r;
  }
  // Conservative: forward pace is the higher of recent-trailing vs cycle-average,
  // so a burst pushes it up but it won't relax the instant you pause after one.
  const perSec = recentPerSec != null ? Math.max(recentPerSec, avgPerSec) : avgPerSec;

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
  module.exports = { MIN_ELAPSED_MS, fmtDur, fmtClock, recentSlope, cycleSamples, forecast };
}
