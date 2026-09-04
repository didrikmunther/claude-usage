"use strict";

// ---- state ----
// Two independent chart panels: C = Claude, X = Codex. Each holds its full
// series buffer [ [ts(sec)], [a], [b] ] plus the latest live payload.
const C = { chart: null, data: [[], [], []], resets: {}, last: null };
const X = { chart: null, data: [[], [], []], last: null, shown: false };

let bounds = { min: 10, max: 3600 };
const MAX_POINTS = 20000;
const MIN_ELAPSED_MS = 10 * 60e3;   // ignore the noisy first minutes of a cycle

const RANGES = { "24h": 24 * 3600, "7d": 7 * 24 * 3600, full: Infinity };
let range = RANGES[localStorage.getItem("range")] !== undefined ? localStorage.getItem("range") : "24h";

// Which forecast strategy drives the chart projection (see predict.js).
const FORECAST_MODELS = ["linear", "cycle", "cycle+tod"];
let forecastModel = FORECAST_MODELS.includes(localStorage.getItem("forecastModel")) ? localStorage.getItem("forecastModel") : "cycle+tod";

// Claude's four windows (fixed lengths); Codex windows come from the payload.
// series = index into C.data for the recent-rate method (null → plain cycle
// average). Only the 5-hour window uses the reactive method; weekly windows
// average over the whole cycle.
// Forecast order: 7-day on top (aligns with Codex's 7-day), then 5-hour, then
// the per-model weekly windows. (The bars keep 5-hour on top — this is just the
// forecast list.)
const CLAUDE_WIN = [
  { key: "sd", label: "7-day",  reset: "seven_day",        winMs: 7 * 24 * 3600e3, series: null },
  { key: "fh", label: "5-hour", reset: "five_hour",        winMs: 5 * 3600e3,      series: 1 },
  { key: "so", label: "Opus",   reset: "seven_day_opus",   winMs: 7 * 24 * 3600e3, series: null },
  { key: "sn", label: "Sonnet", reset: "seven_day_sonnet", winMs: 7 * 24 * 3600e3, series: null },
];

const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// ---- charts ----
function makeChart(elId, series, plugins) {
  const el = $(elId);
  const real = series.map((s) => ({ label: s.label, stroke: css(s.color), width: 2, points: { show: false }, show: s.show !== false }));
  // One projection twin per line: lighter + dashed, drawn in the future region.
  const proj = series.map((s) => ({ label: s.label + " ·proj", stroke: css(s.color + "-dim"), width: 2, dash: [4, 4], points: { show: false }, show: s.show !== false }));
  const opts = {
    width: el.clientWidth || 640, height: 240,
    padding: [8, 8, 0, 0],
    cursor: { y: false },
    legend: { show: false },
    plugins: plugins || [],
    scales: { y: { range: [0, 100] } },
    axes: [
      { grid: { show: false }, ticks: { show: false }, size: 34, values: fmtAxis,
        stroke: css("--muted") },
      { grid: { stroke: css("--line"), width: 1 }, ticks: { show: false },
        size: 38, values: (u, vs) => vs.map((v) => v + "%"), stroke: css("--muted") },
    ],
    series: [{}, ...real, ...proj],
  };
  const empty = [[], ...real.map(() => []), ...proj.map(() => [])];
  return new uPlot(opts, empty, el);
}

// Faint dashed vertical line marking "now" — the boundary between history and the
// forecast region. Positioned at the last sample that still has real (non-projected) data.
function nowDivider() {
  return { hooks: { draw: (u) => {
    const xs = u.data[0];
    if (!xs || !xs.length) return;
    let idx = -1;
    for (let i = xs.length - 1; i >= 0; i--) {
      if ((u.data[1] && u.data[1][i] != null) || (u.data[2] && u.data[2][i] != null)) { idx = i; break; }
    }
    if (idx < 0) return;
    const x = Math.round(u.valToPos(xs[idx], "x", true)) + 0.5;
    const ctx = u.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = css("--muted");
    ctx.lineWidth = 1;
    ctx.moveTo(x, u.bbox.top);
    ctx.lineTo(x, u.bbox.top + u.bbox.height);
    ctx.stroke();
    ctx.restore();
  } } };
}

// 24-hour x-axis labels: HH:MM within a day-ish span, else "Mon D".
function fmtAxis(u, splits) {
  const span = splits.length ? splits[splits.length - 1] - splits[0] : 0;
  const dateOnly = span > 36 * 3600;
  return splits.map((s) => {
    const d = new Date(s * 1000);
    return dateOnly
      ? d.toLocaleDateString([], { month: "short", day: "numeric" })
      : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  });
}

// Show only the slice within the selected range (measured back from newest sample).
function applyRange(st) {
  if (!st.chart) return;
  const secs = RANGES[range];
  let ts = st.data[0], a = st.data[1], b = st.data[2];
  if (secs !== Infinity && ts.length) {
    const cutoff = ts[ts.length - 1] - secs;
    let i = 0;
    while (i < ts.length && ts[i] < cutoff) i++;
    ts = ts.slice(i); a = a.slice(i); b = b.slice(i);
  }
  st.chart.setData(withProjection(ts, a, b, panelResets(st)));
}

function toSamples(ts, ys) {
  const out = [];
  for (let i = 0; i < ts.length; i++) out.push({ t: ts[i], y: ys[i] });
  return out;
}
function lastNonNull(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return 0;
}

// Authoritative reset override for the predictor: { P, R } in seconds (window
// length + a known reset instant), taken from the API's window info so the forecast
// projects resets on the real cadence instead of guessing from noisy data drops.
function resetOverride(iso, winSec) {
  if (!iso || !(winSec > 0)) return null;
  const R = new Date(iso).getTime() / 1000;
  return Number.isFinite(R) ? { P: winSec, R } : null;
}
// Per-panel {a, b} reset overrides for the two charted series (a = 5-hour, b = 7-day).
function panelResets(st) {
  if (st === C) return {
    a: resetOverride(C.resets.five_hour, 5 * 3600),
    b: resetOverride(C.resets.seven_day, 7 * 86400),
  };
  if (st === X) {
    const wins = (X.last && X.last.windows) || [];
    const byLen = (target, tol) => wins.find((w) => w.window_seconds && Math.abs(w.window_seconds - target) <= tol);
    const w5 = byLen(18000, 900), w7 = byLen(604800, 7200);
    return {
      a: w5 && resetOverride(w5.reset_at, w5.window_seconds),
      b: w7 && resetOverride(w7.reset_at, w7.window_seconds),
    };
  }
  return { a: null, b: null };
}

// Expand [ts, a, b] into uPlot's 5-row data with a forecast filling the rightmost
// 25%: [ts, a, b, aProj, bProj]. Real lines go null in the future; projection lines
// are null across history except an anchor at the last real point so they connect.
// `rst` carries authoritative {a, b} reset overrides (see panelResets).
function withProjection(ts, a, b, rst) {
  const n = ts.length;
  const noProj = [ts.slice(), a.slice(), b.slice(), a.map(() => null), b.map(() => null)];
  if (n < 2) return noProj;
  const now = ts[n - 1];
  const horizon = (ts[n - 1] - ts[0]) / 3;   // future region = 25% of the total width
  if (!(horizon > 0)) return noProj;
  const step = Math.max(horizon / 24, 60);
  const P = Predictors[forecastModel] || Predictors.linear;
  const projA = P.predict(toSamples(ts, a), { now, horizon, step, reset: rst && rst.a }).points;
  // Derive the 7-day (b) from the 5-hour (a) projection when they're linked by a
  // stable consumption ratio; otherwise forecast it independently (e.g. Codex, whose
  // 5-hour "Spark" window sits at ~0 → no ratio → falls back here).
  const ratio = consumptionRatio(a, b);
  const projB = ratio != null
    ? deriveSeries(projA, lastNonNull(b), ratio, 100)
    : P.predict(toSamples(ts, b), { now, horizon, step, reset: rst && rst.b }).points;
  // The two series can project on different time grids (e.g. one line hits resets
  // and the other doesn't), so build a shared future axis from both and resample
  // each onto it — otherwise the sparser series' projection ends up short and cut off.
  const ftSet = new Set();
  for (const p of projA) if (p.t > now) ftSet.add(p.t);
  for (const p of projB) if (p.t > now) ftSet.add(p.t);
  const future = [...ftSet].sort((x, y) => x - y);
  const outTs = ts.concat(future);
  const outA = a.concat(future.map(() => null));
  const outB = b.concat(future.map(() => null));
  const outAp = ts.map(() => null), outBp = ts.map(() => null);
  if (projA.length) outAp[n - 1] = projA[0].y;      // anchor to the last real point
  if (projB.length) outBp[n - 1] = projB[0].y;
  for (const t of future) { outAp.push(sampleAt(projA, t)); outBp.push(sampleAt(projB, t)); }
  return [outTs, outA, outB, outAp, outBp];
}
function applyRangeAll() { applyRange(C); applyRange(X); renderConsumed(); }

// Percentage units consumed within the visible range = sum of positive
// step-to-step increments per series (resets/decreases don't count).
function consumedInRange(st) {
  const secs = RANGES[range];
  const ts = st.data[0];
  let i = 0;
  if (secs !== Infinity && ts.length) {
    const cutoff = ts[ts.length - 1] - secs;
    while (i < ts.length && ts[i] < cutoff) i++;
  }
  const out = [];
  for (let s = 1; s <= 2; s++) {
    const y = st.data[s];
    let sum = 0, prev = null, n = 0;
    for (let k = i; k < y.length; k++) {
      const v = y[k];
      if (v == null) continue;
      n++;
      if (prev != null && v > prev) sum += v - prev;
      prev = v;
    }
    out.push({ sum, n });
  }
  return out;
}

function renderConsumed() {
  const targets = [
    // {i} indexes into consumedInRange's [series1, series2]. Codex omits 5-hour.
    { st: C, el: "consumed", series: [{ i: 0, lbl: "5h", col: "--fh" }, { i: 1, lbl: "7d", col: "--sd" }] },
    { st: X, el: "cxConsumed", series: [{ i: 1, lbl: "7d", col: "--sd" }] },
  ];
  for (const t of targets) {
    const el = $(t.el);
    if (!el) continue;
    const res = consumedInRange(t.st);
    const parts = t.series.map((sp) => {
      const r = res[sp.i];
      return r && r.n > 1 ? `<b style="color:var(${sp.col})">${sp.lbl} +${Math.round(r.sum)}%</b>` : null;
    }).filter(Boolean);
    el.innerHTML = parts.length ? `<span class="muted">used</span> ${parts.join(" · ")}` : "";
  }
}

function pushPoint(st, tsSec, a, b) {
  st.data[0].push(tsSec); st.data[1].push(a); st.data[2].push(b);
  if (st.data[0].length > MAX_POINTS) {
    const cut = st.data[0].length - MAX_POINTS;
    st.data = st.data.map((s) => s.slice(cut));
  }
  applyRange(st);
  renderConsumed();
}

function loadHistory(rows) {
  C.data = [[], [], []]; X.data = [[], [], []];
  for (const r of rows) {
    C.data[0].push(r.ts / 1000); C.data[1].push(r.fh); C.data[2].push(r.sd);
    X.data[0].push(r.ts / 1000); X.data[1].push(r.cp); X.data[2].push(r.cs);
  }
  applyRangeAll();
}

// ---- formatting helpers ----
function fmtPct(v) { return v == null ? "–" : Math.round(v) + "%"; }

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

function countdown(iso) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "resetting…";
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 1) return `resets in ${d}d ${h % 24}h`;
  if (h >= 1) return `resets in ${h}h ${m % 60}m`;
  return `resets in ${m}m`;
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

// Trailing-window burn rate in %-points/hour for the gauge. Clamped to 0 so an
// idle stretch or a post-reset dip reads as "stopped", not negative.
function burnRate(tsArr, yArr, nowSec, lookbackSec = 300) {
  const pts = [];
  for (let i = 0; i < tsArr.length; i++) if (yArr[i] != null) pts.push([tsArr[i], yArr[i]]);
  const slope = recentSlope(pts, lookbackSec, nowSec);   // %/sec or null
  return slope == null ? 0 : Math.max(0, slope * 3600);  // %/hour
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

function progRow(label, p) {
  if (!p) return "";
  const rate = p.rate ? `<span class="prog-rate">${p.rate}</span>` : `<span class="prog-rate"></span>`;
  return `<div class="prog-row ${p.cls}"><span class="prog-label">${label}</span><span class="prog-msg">${p.msg}</span>${rate}</div>`;
}
const emptyRow = () => `<div class="prog-row muted"><span class="prog-msg">gathering data…</span></div>`;

// ---- Claude rendering ----
function renderClaude(s) {
  C.last = s;
  if (s.resets) C.resets = s.resets;
  $("fhFill").style.width = (s.fh ?? 0) + "%";
  $("sdFill").style.width = (s.sd ?? 0) + "%";
  $("fhPct").textContent = fmtPct(s.fh);
  $("sdPct").textContent = fmtPct(s.sd);
  renderScoped(s.limits);
  renderClaudeResets();
  renderClaudeForecast();
}

function renderScoped(limits) {
  const box = $("scoped");
  const scoped = (limits || []).filter((l) => l.scope && l.scope.model);
  box.innerHTML = scoped.map((l) => {
    const name = l.scope.model.display_name || "model";
    return `<div class="row"><span>Weekly · ${name}</span><b>${Math.round(l.percent)}%</b></div>`;
  }).join("");
}

function renderClaudeResets() {
  $("fhReset").textContent = countdown(C.resets.five_hour);
  $("sdReset").textContent = countdown(C.resets.seven_day);
}

function renderClaudeForecast() {
  if (!C.last) return;
  const rows = [];
  for (const w of CLAUDE_WIN) {
    const cur = C.last[w.key];
    if (cur == null) continue;
    const resetIso = C.resets[w.reset];
    const samples = (w.series && resetIso)
      ? cycleSamples(C.data, w.series, new Date(resetIso).getTime(), w.winMs) : null;
    rows.push(progRow(w.label, forecast(cur, w.winMs, resetIso, samples)));
  }
  $("prog").innerHTML = rows.join("") || emptyRow();
}

// ---- Codex rendering ----
// Fixed slots mirroring Claude's rows: 5-hour on top, 7-day below. A window with
// no data leaves an invisible ghost so both columns line up row-for-row.
const CX_SLOTS = [
  { label: "5-hour", cls: "cx1" },
  { label: "7-day",  cls: "sd" },   // same teal as Claude's 7-day
];
const GHOST_BAR = `<div class="bar-row placeholder" aria-hidden="true"><div class="bar-label">&nbsp;<span class="reset">&nbsp;</span></div><div class="track"></div><div class="pct"></div></div>`;
const GHOST_PROG = `<div class="prog-row placeholder" aria-hidden="true"><span class="prog-label">&nbsp;</span><span class="prog-msg">&nbsp;</span><span class="prog-rate"></span></div>`;

function showCodex() {
  if (X.shown) return;
  X.shown = true;
  document.body.classList.add("two");
  $("colCodex").hidden = false;
  // Sizing is handled by the ResizeObserver on each chart container, which fires
  // when the column reveals / the layout widens.
}

function renderCodex(s) {
  X.last = s;
  showCodex();
  $("cxSource").textContent = s.source === "rollout" ? "· cached (Codex idle)" : "";

  const wins = s.windows || [];
  const barFor = (w, cls) => `
    <div class="bar-row">
      <div class="bar-label">${w.label}<span class="reset muted" data-reset="${w.reset_at || ""}">${countdown(w.reset_at)}</span></div>
      <div class="track"><div class="fill ${cls}" style="width:${w.used_percent ?? 0}%"></div></div>
      <div class="pct">${fmtPct(w.used_percent)}</div>
    </div>`;
  const usedW = new Set();
  let barsHtml = CX_SLOTS.map((slot) => {
    const w = wins.find((x) => x.label === slot.label);
    if (w) { usedW.add(w); return barFor(w, slot.cls); }
    return GHOST_BAR;                                   // keep the slot's height
  }).join("");
  wins.filter((w) => !usedW.has(w)).forEach((w) => barsHtml += barFor(w, "cx1"));  // any odd window
  $("cxBars").innerHTML = barsHtml;

  $("cxLegend").innerHTML = CX_SLOTS
    .filter((slot) => wins.some((w) => w.label === slot.label))
    .map((slot) => `<span class="lg"><i class="swatch ${slot.cls}"></i>${slot.label}</span>`).join("");

  // Hide the model-specific "Spark" feature limit — it's usually 0% and not a real cap.
  const add = (s.additional || []).filter((a) => a.used_percent != null && !/spark/i.test(a.label || ""));
  $("cxScoped").innerHTML = add.map((a) =>
    `<div class="row"><span>${a.label}</span><b>${Math.round(a.used_percent)}%</b></div>`).join("");

  renderCodexForecast();
}

function renderCodexForecast() {
  if (!X.last) return;
  const wins = X.last.windows || [];
  const idxByLabel = { "5-hour": 1 };   // only the 5-hour uses recent-rate; 7-day averages
  const progFor = (w) => {
    const idx = idxByLabel[w.label] || null;
    const winMs = (w.window_seconds || 0) * 1000;
    const samples = (idx && w.reset_at)
      ? cycleSamples(X.data, idx, new Date(w.reset_at).getTime(), winMs) : null;
    return progRow(w.label, forecast(w.used_percent, winMs, w.reset_at, samples));
  };
  // Only real windows here (no ghost padding) — Codex's 7-day sits at the top,
  // aligning with Claude's now-top 7-day forecast row.
  const usedW = new Set();
  const rows = [];
  for (const slot of CX_SLOTS) {
    const w = wins.find((x) => x.label === slot.label);
    if (w) { usedW.add(w); rows.push(progFor(w)); }
  }
  wins.filter((w) => !usedW.has(w)).forEach((w) => rows.push(progFor(w)));
  $("cxProg").innerHTML = rows.join("") || emptyRow();
}

// ---- status ----
function setDots(cls) {                        // one status dot per column
  for (const id of ["dot", "cxDot"]) {
    const d = $(id);
    if (d) d.className = cls ? `dot ${cls}` : "dot";
  }
}

function setStatus(st) {
  const banner = $("banner");
  if (!st) return;
  if (st.state === "ok") {
    setDots("ok");
    banner.hidden = !st.message;
    if (st.message) banner.textContent = st.message;   // partial failure note
  } else if (st.state === "error") {
    setDots("err");
    banner.hidden = false; banner.textContent = st.message || "poll failed";
  } else {
    setDots("");
  }
  if (st.ts) $("updated").textContent = "updated " + new Date(st.ts).toLocaleTimeString([], { hour12: false });
}

// ---- controls ----
let sendInterval = () => {};
function wireControls() {
  const rangeInput = $("ival"), num = $("ivalNum");
  let t = null;
  const commit = (v) => {
    v = Math.max(bounds.min, Math.min(bounds.max, Math.round(v)));
    rangeInput.value = Math.min(Number(rangeInput.max), v); num.value = v;
    clearTimeout(t); t = setTimeout(() => sendInterval(v), 250);
  };
  rangeInput.addEventListener("input", () => commit(Number(rangeInput.value)));
  num.addEventListener("change", () => commit(Number(num.value)));
  $("pollNow").addEventListener("click", () => ws && ws.readyState === 1 && ws.send(JSON.stringify({ poll_now: true })));
}

function wireRange() {
  const groups = [...document.querySelectorAll('.seg[data-sync="range"]')];
  const setActive = () => groups.forEach((g) =>
    g.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.r === range)));
  setActive();
  groups.forEach((g) => g.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      range = b.dataset.r; localStorage.setItem("range", range);
      setActive(); applyRangeAll();
    })));
}

function wireForecastModel() {
  const sel = $("forecastModel");
  if (!sel) return;
  sel.value = forecastModel;
  sel.addEventListener("change", () => {
    forecastModel = sel.value;
    localStorage.setItem("forecastModel", forecastModel);
    applyRangeAll();                   // rebuild the projection with the chosen predictor
  });
}

function setIntervalUI(n) {
  $("ivalNum").value = n;
  $("ival").value = Math.min(Number($("ival").max), n);
}

// ---- websocket ----
let ws = null, backoff = 500;
// ---- API-equivalent spend (Claude Code token logs priced at list rates) ----
function fmtMoney(n) {
  if (n == null) return "–";
  if (n >= 1000) return "$" + Math.round(n).toLocaleString();
  if (n >= 100) return "$" + n.toFixed(0);
  return "$" + n.toFixed(2);
}
function modelShort(m) {
  return String(m || "")
    .replace(/^claude-/, "")
    .replace(/-\d{6,}$/, "");   // drop trailing date stamps, keep version like 4-8
}
let ccClaude = null, ccCodex = null;
function renderCC(cc) { if (cc) { ccClaude = cc; renderCost(); } }
function renderXcost(xc) { if (xc) { ccCodex = xc; renderCost(); } }

// Combined Claude + Codex totals, with a per-provider split underneath.
function renderCost() {
  if (!ccClaude && !ccCodex) return;
  $("ccost").hidden = false;
  const sum = (k) => (ccClaude ? ccClaude[k] : 0) + (ccCodex ? ccCodex[k] : 0);
  $("ccD1").textContent = fmtMoney(sum("d1"));
  $("ccD7").textContent = fmtMoney(sum("d7"));
  $("ccTotal").textContent = fmtMoney(sum("total"));
  const parts = [];
  if (ccClaude) parts.push(`Claude <b>${fmtMoney(ccClaude.total)}</b>`);
  if (ccCodex) parts.push(`Codex <b>${fmtMoney(ccCodex.total)}</b>`);
  $("ccBreak").innerHTML = parts.join("  ·  ") + (parts.length ? "  · all-time" : "");
}

// ---- self-update banner ----
let lastUpdate = null;
function updateReady() {
  return !!(lastUpdate && lastUpdate.update_available && lastUpdate.latest);
}
// The footer button doubles as the updater: "Check for updates" normally, but
// "Update to vX" once one is found (so you can apply it here, not just the top).
function setCheckBtnLabel() {
  const btn = $("checkUpdate");
  if (!btn || btn.dataset.busy === "1") return;
  btn.textContent = updateReady() ? `Update to ${lastUpdate.latest}` : "Check for updates";
  btn.classList.toggle("update-mode", updateReady());
}
function renderUpdate(info) {
  if (!info) return;
  lastUpdate = info;
  const v = $("version");
  if (v) v.textContent = info.current ? "v" + info.current : "";
  const bar = $("updateBar");
  if (info.update_available && info.latest) {
    $("updateMsg").textContent = `Update available: v${info.current} → ${info.latest}`;
    $("updateBtn").disabled = false;
    bar.hidden = false;
  } else {
    bar.hidden = true;
  }
  setCheckBtnLabel();
}

function wireCheckUpdate() {
  const btn = $("checkUpdate");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (updateReady()) {                                  // apply the update
      btn.dataset.busy = "1"; btn.disabled = true;
      btn.textContent = "Updating…";
      try { await fetch("/api/update", { method: "POST" }); } catch (e) { /* server restarts */ }
      return;                                             // WS reconnect + renderUpdate reset it
    }
    btn.dataset.busy = "1"; btn.disabled = true;          // check for one
    btn.textContent = "Checking…";
    try {
      const r = await fetch("/api/check-update", { method: "POST" });
      const body = await r.json().catch(() => ({}));
      if (body.update) renderUpdate(body.update);         // may flip us into update mode + show banner
      if (!updateReady()) {
        btn.textContent = "Up to date ✓";
        setTimeout(() => { btn.dataset.busy = "0"; btn.disabled = false; setCheckBtnLabel(); }, 2000);
        return;
      }
    } catch (e) {
      btn.textContent = "Check failed";
      setTimeout(() => { btn.dataset.busy = "0"; btn.disabled = false; setCheckBtnLabel(); }, 2000);
      return;
    }
    btn.dataset.busy = "0"; btn.disabled = false; setCheckBtnLabel();
  });
}

function wireUpdate() {
  $("updateBtn").addEventListener("click", async () => {
    const btn = $("updateBtn"), msg = $("updateMsg");
    btn.disabled = true;
    msg.textContent = "Updating… the app will restart in a moment.";
    try {
      const r = await fetch("/api/update", { method: "POST" });
      if (!r.ok) {
        // Nothing to apply (e.g. 400) — don't leave the label stuck.
        const body = await r.json().catch(() => ({}));
        msg.textContent = "Update didn't start: " + (body.error || ("HTTP " + r.status));
        btn.disabled = false;
        setTimeout(() => renderUpdate(lastUpdate), 3000);   // restore true state
      }
      // On success the server restarts; the WS reconnects and renderUpdate()
      // clears this banner once versions match.
    } catch (e) {
      // Connection dropped — expected while the server restarts to apply.
    }
  });
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  sendInterval = (v) => ws && ws.readyState === 1 && ws.send(JSON.stringify({ set_interval: v }));
  ws.onopen = () => { backoff = 500; };
  ws.onclose = () => {
    setDots("");
    setTimeout(connect, backoff); backoff = Math.min(8000, backoff * 2);
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "init") {
      if (m.limits) bounds = m.limits;
      $("ival").min = bounds.min; $("ivalNum").min = bounds.min; $("ivalNum").max = bounds.max;
      loadHistory(m.history || []);
      if (m.claude) renderClaude(m.claude);
      if (m.codex) renderCodex(m.codex);
      if (m.cc) renderCC(m.cc);
      if (m.xcost) renderXcost(m.xcost);
      if (m.update) renderUpdate(m.update);
      setIntervalUI(m.interval);
      setStatus(m.status);
      updateGauges();                       // set targets from history before revving
      if (!revvedOnce) { revvedOnce = true; window.revGauges(); }
    } else if (m.type === "sample") {
      if (m.claude) { pushPoint(C, m.claude.ts / 1000, m.claude.fh, m.claude.sd); renderClaude(m.claude); }
      if (m.codex) { pushPoint(X, m.codex.ts / 1000, m.codex.cp, m.codex.cs); renderCodex(m.codex); }
      setStatus(m.status);
    } else if (m.type === "cc") {
      renderCC(m.cc);
    } else if (m.type === "xcost") {
      renderXcost(m.xcost);
    } else if (m.type === "update") {
      renderUpdate(m.update);
    } else if (m.type === "status") {
      setStatus(m.status);
    } else if (m.type === "interval") {
      setIntervalUI(m.interval);
    }
  };
}

// ---- 1-second tick: keep countdowns + forecasts fresh ----
// ---- burn-rate gauges (speedometer of last-5-min %/h) ----
const GAUGE_MAX = 60;   // %/h full-scale
let claudeGauge = null, codexGauge = null, revvedOnce = false;

function makeGauge(elId, zoneStops) {
  const el = $(elId);
  if (!el) return { update() {} };
  const zs = zoneStops || [1 / 3, 2 / 3];        // green|amber and amber|red, as dial fractions
  const cx = 75, cy = 72, R = 56, rz = R - 4;
  const ang = (v) => 180 * (1 - Math.min(Math.max(v, 0), GAUGE_MAX) / GAUGE_MAX);  // deg
  const pol = (r, deg) => { const a = deg * Math.PI / 180; return [cx + r * Math.cos(a), cy - r * Math.sin(a)]; };
  const arc = (r, v1, v2) => {
    const [x1, y1] = pol(r, ang(v1)), [x2, y2] = pol(r, ang(v2));
    return `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  };
  const G = GAUGE_MAX;
  const zones = [[0, zs[0], "#22c55e"], [zs[0], zs[1], "#f59e0b"], [zs[1], 1, "#ef4444"]]
    .map(([a, b, c]) => `<path d="${arc(rz, a * G, b * G)}" fill="none" stroke="${c}" stroke-width="6" opacity=".9"/>`).join("");
  let ticks = "";
  for (let v = 0; v <= GAUGE_MAX; v += 10) {
    const [x1, y1] = pol(R, ang(v)), [x2, y2] = pol(R - 7, ang(v));
    ticks += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--muted)" stroke-width="1"/>`;
  }
  const [nx, ny] = pol(R - 12, ang(0));
  el.innerHTML = `<svg viewBox="0 0 150 96" class="gauge-svg">
    <defs>
      <filter id="${elId}-blur" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="1.7"/></filter>
      <radialGradient id="${elId}-sg"><stop offset="0%" stop-color="#9ca3af" stop-opacity=".9"/><stop offset="55%" stop-color="#9ca3af" stop-opacity=".4"/><stop offset="100%" stop-color="#9ca3af" stop-opacity="0"/></radialGradient>
    </defs>
    ${zones}${ticks}
    <line id="${elId}-n" x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="var(--ink)" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="3.5" fill="var(--ink)"/>
    <g id="${elId}-steam" filter="url(#${elId}-blur)"></g>
    <text id="${elId}-v" x="${cx}" y="93" text-anchor="middle" class="gauge-val">– %/h</text></svg>`;
  const needle = $(`${elId}-n`), val = $(`${elId}-v`);
  const steamG = $(`${elId}-steam`);
  // A rising, fading steam puff — vented while the gauge is over the max.
  const puff = () => {
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", (62 + Math.random() * 26).toFixed(1));   // a narrow column
    c.setAttribute("cy", (30 + Math.random() * 3).toFixed(1));
    c.setAttribute("r", (4 + Math.random() * 2.5).toFixed(1));    // big + soft
    c.setAttribute("fill", `url(#${elId}-sg)`);
    c.setAttribute("class", "steam-puff");
    c.style.setProperty("--dx", (Math.random() * 12 - 6).toFixed(1) + "px");
    c.addEventListener("animationend", () => c.remove());
    steamG.appendChild(c);
  };
  // `dv` is dial-space (0..GAUGE_MAX); needle pegs at the redline, but the readout
  // shows the TRUE %/h (uncapped — it can climb past the dial's full scale).
  let readoutRate = 0, readoutWin = "", readoutDec = 0;
  const setNeedle = (dv) => {
    const [x2, y2] = pol(R - 12, ang(dv));
    needle.setAttribute("x2", x2.toFixed(1));
    needle.setAttribute("y2", y2.toFixed(1));
    val.textContent = `${readoutRate.toFixed(readoutDec)} %/h · ${readoutWin}`;
    const f = dv / G;
    val.style.fill = f < zs[0] ? "#16a34a" : f < zs[1] ? "#d97706" : "#dc2626";
  };
  // One always-on animation loop drives the needle so it never jumps: normally
  // it eases toward `target` (the live rate); during a rev it follows the
  // ignition sweep, which itself settles onto `target`.
  const REV_DUR = 1100, SMOOTH = 0.12, VIB_AMP = 4, VIB_FREQ = 0.08, PUFF_MS = 120;
  let target = 0, cur = 0, revActive = false, revStart = 0, over = false, lastPuff = 0;
  const loop = (now) => {
    if (over && !revActive && now - lastPuff > PUFF_MS) { lastPuff = now; puff(); }
    if (revActive) {
      const t = Math.min(1, (now - revStart) / REV_DUR);
      cur = t < 0.5
        ? GAUGE_MAX * (1 - (1 - t / 0.5) ** 2)                        // rise to redline
        : GAUGE_MAX + (target - GAUGE_MAX) * (1 - (1 - (t - 0.5) / 0.5) ** 2); // fall → live
      if (t >= 1) revActive = false;
    } else {
      cur += (target - cur) * SMOOTH;                                 // exponential ease
      if (Math.abs(target - cur) < 0.03) cur = target;
    }
    // Over the dial's max → buzz the needle against the redline (clamped at max).
    const dv = (over && !revActive) ? cur + Math.sin(now * VIB_FREQ) * VIB_AMP : cur;
    setNeedle(dv);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return {
    // rate = true %/h (shown); maxRate = the %/h that fills the dial (= 3× the
    // tracked window's sustainable rate); hours = that window's length (labelled).
    update(rate, maxRate, hours) {
      readoutRate = rate || 0;
      readoutWin = hours >= 48 ? `${Math.round(hours / 24)}d` : `${Math.round(hours)}h`;
      readoutDec = hours >= 48 ? 2 : 0;      // slow day-scale windows need decimals
      const mx = maxRate || GAUGE_MAX;
      over = (rate || 0) > mx;               // past full-scale → vibrate
      target = Math.min(1, Math.max(0, (rate || 0) / mx)) * GAUGE_MAX;
    },
    rev() { revActive = true; revStart = performance.now(); },
  };
}

// Rev both gauges — called on page load and by the menu bar on each popover open.
window.revGauges = () => { if (claudeGauge) claudeGauge.rev(); if (codexGauge) codexGauge.rev(); };

// Which window the gauge shows: the SHORTEST window that's actively burning
// (so an active 5-hour beats a slow 7-day trend while you're coding); if none is
// active, the one with the highest pace. Needle fills at 3× that window's
// sustainable rate (100%/hours), so a fast 5-hour and a slow 7-day stay readable.
const PACE_ACTIVE = 0.1;                          // ≥10% of the sustainable rate
function bindingBurn(data, now, windows) {        // windows shortest-first
  let fb = null;
  for (const w of windows) {
    // Lookback = 1/60th of the window (5h→5min, 7d→2.8h) so a coarse, slow meter
    // like the 7-day one still yields a real slope.
    const rate = burnRate(data[0], data[w.idx], now, w.hours * 60);
    const pace = (rate * w.hours) / 100;          // 1 = on track to exhaust at reset
    const cand = { rate, maxRate: 300 / w.hours, hours: w.hours, pace };
    if (pace >= PACE_ACTIVE) return cand;         // shortest active window wins
    if (!fb || pace > fb.pace) fb = cand;
  }
  return fb;
}
// Each gauge tracks one window on a fixed dial: Claude's 5-hour at 0–100 %/h,
// Codex's 7-day at 0–8 %/h (its rate is inherently small). Needles peg + vibrate
// past the max; the readout keeps climbing.
const CLAUDE_MAX = 100;   // %/h full-scale for Claude's 5-hour dial
const CODEX_MAX = 8;      // %/h full-scale for Codex's 7-day dial
const WIN_CODEX = [{ idx: 2, hours: 168 }];   // Codex: 7-day only (no real 5-hour limit)

function updateGauges() {
  const now = Date.now() / 1000;
  if (claudeGauge) {
    const r = burnRate(C.data[0], C.data[1], now, 5 * 60);   // 5-hour rate
    claudeGauge.update(r, CLAUDE_MAX, 5);
  }
  if (codexGauge) {
    const b = bindingBurn(X.data, now, WIN_CODEX);           // 7-day rate + lookback
    codexGauge.update(b.rate, CODEX_MAX, b.hours);
  }
}

function tick() {
  renderClaudeResets();
  renderClaudeForecast();
  document.querySelectorAll("#cxBars [data-reset]").forEach((el) => {
    el.textContent = countdown(el.dataset.reset);
  });
  renderCodexForecast();
  updateGauges();
}

// ---- boot ----
// Keep each uPlot sized to its container through reveals / layout changes / resizes.
function observeSize(elId, getChart) {
  const el = $(elId);
  const ro = new ResizeObserver(() => {
    const w = el.clientWidth;
    const chart = getChart();
    if (w > 0 && chart) chart.setSize({ width: w, height: 240 });
  });
  ro.observe(el);
}

window.addEventListener("load", () => {
  C.chart = makeChart("chart", [{ label: "5h", color: "--fh" }, { label: "7d", color: "--sd" }],
    [nowDivider()]);
  // Codex has no real 5-hour limit (its 5-hour "Spark" window is feature-specific
  // and usually 0), so hide that series.
  X.chart = makeChart("cxChart", [{ label: "primary", color: "--cx1", show: false }, { label: "secondary", color: "--sd" }],
    [nowDivider()]);
  observeSize("chart", () => C.chart);
  observeSize("cxChart", () => X.chart);
  wireControls();
  wireRange();
  wireForecastModel();
  wireUpdate();
  wireCheckUpdate();
  claudeGauge = makeGauge("claudeGauge", [0.3, 0.6]);   // 0–100 %/h dial, red from 60
  codexGauge = makeGauge("codexGauge");                  // window-relative, red from 2× sustainable
  connect();   // rev fires from the first WS "init", once the live rate is known
  setInterval(tick, 1000);
});
