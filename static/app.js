"use strict";

// ---- state ----
// Two independent chart panels: C = Claude, X = Codex. Each holds its full
// series buffer [ [ts(sec)], [a], [b] ] plus the latest live payload.
const C = { chart: null, data: [[], [], []], resets: {}, last: null };
const X = { chart: null, data: [[], [], []], last: null, shown: false };

let bounds = { min: 10, max: 3600 };
const MAX_POINTS = 20000;

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
  // (For the cone model this row carries the median; the band is filled below.)
  const proj = series.map((s) => ({ label: s.label + " ·proj", stroke: css(s.color + "-dim"), width: 2, dash: [4, 4], points: { show: false }, show: s.show !== false }));
  // Invisible lo/hi twins that only exist so the cone's p10-p90 band can fill
  // between them; empty unless the cone model is active.
  const lo = series.map((s) => ({ label: s.label + " ·lo", stroke: "transparent", width: 0, points: { show: false }, show: s.show !== false }));
  const hi = series.map((s) => ({ label: s.label + " ·hi", stroke: "transparent", width: 0, points: { show: false }, show: s.show !== false }));
  const N = series.length;
  const bands = series
    .map((s, i) => ({ series: [1 + 3 * N + i, 1 + 2 * N + i], fill: css(s.color + "-band") }))
    .filter((_, i) => series[i].show !== false);
  const opts = {
    width: el.clientWidth || 640, height: 240,
    padding: [8, 8, 0, 0],
    cursor: { y: false },
    legend: { show: false },
    plugins: [cursorTime(), ...(plugins || [])],
    scales: { y: { range: [0, 100] } },
    axes: [
      { grid: { show: false }, ticks: { show: false }, size: 34, values: fmtAxis,
        stroke: css("--muted") },
      { grid: { stroke: css("--line"), width: 1 }, ticks: { show: false },
        size: 38, values: (u, vs) => vs.map((v) => v + "%"), stroke: css("--muted") },
    ],
    series: [{}, ...real, ...proj, ...lo, ...hi],
    bands,
  };
  const empty = [[], ...real.map(() => []), ...proj.map(() => []), ...lo.map(() => []), ...hi.map(() => [])];
  return new uPlot(opts, empty, el);
}

// Timestamp readout following the cursor. uPlot already tracks the hovered index;
// this just labels it. Lives in the over-layer, so both charts get it for free.
function cursorTime() {
  let el;
  return { hooks: {
    init: (u) => {
      el = document.createElement("div");
      el.className = "cursor-time";
      u.over.appendChild(el);
    },
    setCursor: (u) => {
      const i = u.cursor.idx;
      if (i == null) { el.style.display = "none"; return; }
      el.style.display = "";
      const parts = [new Date(u.data[0][i] * 1000).toLocaleString([], {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })];
      // Rows are [x, ...real(N), ...proj(N), ...lo(N), ...hi(N)]. Past the last
      // sample the real row is null, so fall through to its projection twin.
      const N = (u.series.length - 1) / 4;
      for (let j = 1; j <= N; j++) {
        if (!u.series[j].show) continue;
        const v = u.data[j][i] ?? u.data[j + N][i];
        if (v != null) parts.push(`${u.series[j].label} ${Math.round(v)}%`);
      }
      el.textContent = parts.join(" · ");
      el.style.left = Math.max(0, Math.min(u.over.clientWidth, u.cursor.left)) + "px";
    },
  } };
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
  st.chart.setData(withProjection(ts, a, b, panelResets(st), secs));
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
// `rst` carries authoritative {a, b} reset overrides (see panelResets). `rangeSecs`
// is the visible window (Infinity = full). The model always trains on the FULL
// history — the range only controls how much history is shown and how far ahead
// the forecast is drawn — so the prediction is stable across range switches.
function withProjection(tsFull, aFull, bFull, rst, rangeSecs) {
  const nFull = tsFull.length;
  const now = nFull ? tsFull[nFull - 1] : 0;
  // Slice for DISPLAY only.
  let start = 0;
  if (rangeSecs !== Infinity && nFull) {
    const cutoff = now - rangeSecs;
    while (start < nFull && tsFull[start] < cutoff) start++;
  }
  const ts = tsFull.slice(start), a = aFull.slice(start), b = bFull.slice(start);
  const n = ts.length;
  const nul = () => ts.map(() => null);
  // rows: ts, realA, realB, projA, projB, loA, loB, hiA, hiB
  const noProj = [ts.slice(), a.slice(), b.slice(), nul(), nul(), nul(), nul(), nul(), nul()];
  if (nFull < 2 || n < 1) return noProj;
  const horizon = (now - ts[0]) / 3;   // future region = 25% of the visible width
  if (!(horizon > 0)) return noProj;
  // Fixed hourly step (not tied to the range) so the forecast resolution — and
  // thus the overlapping trajectory — is identical whatever range is selected.
  const step = 3600;
  const P = Predictors[forecastModel] || Predictors.linear;

  const rA = P.predict(toSamples(tsFull, aFull), { now, horizon, step, reset: rst && rst.a });
  const projA = rA.points, loA = rA.lo || null, hiA = rA.hi || null;
  let projB, loB = null, hiB = null;
  const ratio = consumptionRatio(aFull, bFull);
  if (ratio != null && !rA.lo) {
    // Point-only models: derive the 7-day (b) from the 5-hour (a) projection when
    // linked by a stable consumption ratio.
    projB = deriveSeries(projA, lastNonNull(bFull), ratio, 100);
  } else {
    // Model returns a distribution (or no ratio): forecast b independently so it
    // gets its own point line + uncertainty band.
    const rB = P.predict(toSamples(tsFull, bFull), { now, horizon, step, reset: rst && rst.b });
    projB = rB.points; loB = rB.lo || null; hiB = rB.hi || null;
  }

  // Shared future axis from every present series, so nothing is cut short.
  const ftSet = new Set();
  for (const arr of [projA, projB, loA, hiA, loB, hiB]) {
    if (arr) for (const p of arr) if (p.t > now) ftSet.add(p.t);
  }
  const future = [...ftSet].sort((x, y) => x - y);
  const outTs = ts.concat(future);
  const outA = a.concat(future.map(() => null));
  const outB = b.concat(future.map(() => null));
  // Each projection/band row: null across history, anchored at the last real
  // point, then resampled onto the shared future axis. null arr → empty row.
  const mkRow = (arr) => {
    const row = ts.map(() => null);
    if (arr && arr.length) row[n - 1] = arr[0].y;
    for (const t of future) row.push(arr ? sampleAt(arr, t) : null);
    return row;
  };
  return [outTs, outA, outB,
    mkRow(projA), mkRow(projB),
    mkRow(loA), mkRow(loB),
    mkRow(hiA), mkRow(hiB)];
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
    { st: X, el: "cxConsumed", series: [{ i: 1, lbl: "7d", col: "--cx2" }] },
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



function countdown(iso) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "resetting…";
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 1) return `resets in ${d}d ${h % 24}h`;
  if (h >= 1) return `resets in ${h}h ${m % 60}m`;
  return `resets in ${m}m`;
}



// Trailing-window burn rate in %-points/hour for the gauge. Clamped to 0 so an
// idle stretch or a post-reset dip reads as "stopped", not negative.
function burnRate(tsArr, yArr, nowSec, lookbackSec = 300) {
  const pts = [];
  for (let i = 0; i < tsArr.length; i++) if (yArr[i] != null) pts.push([tsArr[i], yArr[i]]);
  const slope = recentSlope(pts, lookbackSec, nowSec);   // %/sec or null
  return slope == null ? 0 : Math.max(0, slope * 3600);  // %/hour
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
  { label: "7-day",  cls: "cx2" },
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
    accLast = 0; scoreForecasts();     // re-mark which row is "in use"
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
  renderTopChats();
}

// Priciest chats as bars: x is when the chat started, y is that chat's share of
// its provider's all-time spend. Percent rather than dollars because the rates
// are assumptions while the shares are not.
function renderTopChats() {
  const k = ccMode === "today" ? "today" : "top";
  const rows = [
    ...((ccClaude && ccClaude[k]) || []).map((r) => ({ ...r, src: "Claude" })),
    ...((ccCodex && ccCodex[k]) || []).map((r) => ({ ...r, src: "Codex" })),
  ].filter((r) => r.pct > 0);
  // Today's chats all share one date, so an x axis of dates says nothing —
  // rank them by spend instead. Across all history the date is the point.
  rows.sort(ccMode === "today"
    ? (a, b) => b.pct - a.pct
    : (a, b) => new Date(a.when) - new Date(b.when));
  if (!rows.length) {
    $("ccTop").innerHTML = `<div class="muted">no chats today yet</div>`;
    return;
  }
  const max = Math.max(...rows.map((r) => r.pct));
  ccBars = rows;
  const bars = rows.map((r, i) =>
    `<div class="cc-bar ${r.src === "Codex" ? "cx" : "cl"}" data-i="${i}"` +
    ` style="height:${(r.pct / max) * 100}%"></div>`).join("");
  const ends = ccMode === "today"
    ? ["most spent", "least"]
    : [rows[0], rows[rows.length - 1]].map((r) =>
        new Date(r.when).toLocaleDateString([], { month: "short", day: "numeric" }));
  const mid = ccMode === "today"
    ? `${rows.length} chats today · ${fmtMoney(rows.reduce((a, r) => a + r.cost, 0))}`
    : "";
  $("ccTop").innerHTML =
    `<div class="cc-bars">${bars}</div><div id="ccTip" hidden></div>` +
    `<div class="cc-axis muted"><span>${ends[0]}</span>` +
    `<span>${mid}</span><span>${ends[1]}</span></div>`;
}

let ccBars = [];
let ccMode = localStorage.getItem("ccMode") === "today" ? "today" : "all";

function wireChatMode() {
  const seg = $("ccMode");
  if (!seg) return;
  const paint = () => seg.querySelectorAll("button").forEach(
    (b) => b.classList.toggle("on", b.dataset.m === ccMode));
  paint();
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    ccMode = b.dataset.m;
    localStorage.setItem("ccMode", ccMode);
    paint();
    renderTopChats();
  });
}
function wireChatTip() {
  const host = $("ccTop");
  if (!host) return;
  const esc = (t) => { const d = document.createElement("div"); d.textContent = t; return d.innerHTML; };
  host.addEventListener("mousemove", (e) => {
    const bar = e.target.closest(".cc-bar");
    const tip = $("ccTip");
    if (!tip) return;
    // Bars have gaps between them. Hiding whenever the cursor lands in a gap made
    // the box strobe on the way across, so it only clears on mouseleave.
    if (!bar) return;
    const r = ccBars[+bar.dataset.i];
    if (!r) return;
    // Claude Code titles newer sessions itself (ai-title); older ones and every
    // Codex session have none, so fall back to the working directory.
    const when = new Date(r.when);
    const rows_ = [
      [r.src + " · " + r.model, ""],
      ["started", when.toLocaleString([], { month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit", hour12: false })],
    ];
    if (r.end) rows_.push(["ran for", fmtDur((new Date(r.end) - when) / 1000)]);
    if (r.branch) rows_.push(["branch", r.branch]);
    if (r.calls) rows_.push(["API calls", r.calls.toLocaleString()]);
    rows_.push(["share of " + r.src, r.pct.toFixed(1) + "%"]);
    rows_.push(["API-equivalent", fmtMoney(r.cost)]);
    tip.innerHTML =
      `<div class="tip-t">${esc(r.title || r.label)}</div>` +
      (r.title ? `<div class="tip-sub">${esc(r.label)}</div>` : "") +
      rows_.map(([k, v]) => `<div class="tip-r"><span>${esc(k)}</span>` +
        (v ? `<b>${esc(v)}</b>` : "") + `</div>`).join("");
    tip.hidden = false;
    // Parked on whichever side the cursor is not, rather than following it. A box
    // that tracks the mouse jitters on every pixel of movement and sits under the
    // pointer where it hides the very bar you are reading.
    const x = e.clientX - host.getBoundingClientRect().left;
    const left = x > host.clientWidth / 2;
    tip.style.left = left ? "0px" : "auto";
    tip.style.right = left ? "auto" : "0px";
  });
  host.addEventListener("mouseleave", () => { const t = $("ccTip"); if (t) t.hidden = true; });
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
      scoreForecasts();
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

// ---- staleness ----
// The chart anchors "now" to the newest sample (see withProjection), so when the
// poller stops the whole view just freezes at an old timestamp and still reads
// as live. Compare the newest sample against the wall clock and say so.
const STALE_MISSED_POLLS = 5;   // tolerate a few missed polls before crying wolf
const STALE_FLOOR_SEC = 300;    // ...but never warn about less than 5 minutes

function newestSampleMs() {
  let newest = 0;
  for (const st of [C, X]) {
    const ts = st.data && st.data[0];
    if (ts && ts.length) newest = Math.max(newest, ts[ts.length - 1] * 1000);
  }
  return newest || null;
}

function checkStale() {
  const el = $("stale");
  if (!el) return;
  const newest = newestSampleMs();
  if (!newest) { el.hidden = true; return; }
  const poll = Number($("ivalNum") && $("ivalNum").value) || 60;
  const limit = Math.max(STALE_FLOOR_SEC, poll * STALE_MISSED_POLLS) * 1000;
  const age = Date.now() - newest;
  el.hidden = age <= limit;
  if (el.hidden) return;
  // fmtClock is for upcoming resets and drops the day for anything "soon";
  // a stale edge is in the past, so spell out the day once it's not today.
  const d = new Date(newest);
  const when = age > 12 * 3600e3
    ? d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  el.textContent =
    `No new samples for ${fmtDur(age / 1000)} — the chart below ends at ` +
    `${when} and is not current.`;
  setDots("err");
}

// ---- forecast accuracy (backtest) ----
// Replays every predictor across the whole history: train only on samples up to
// an origin, predict forward, compare against what actually happened. The unit
// is percentage points of the limit, split by how far ahead the forecast looked,
// because a model that is fine an hour out and hopeless twelve hours out is
// worth telling apart. Runs in a worker — it is ~1s of arithmetic.
const ACC_ORIGIN_STEP = 4 * 3600;      // one evaluation origin per 4h of history
const ACC_REFRESH_MS = 10 * 60e3;      // history barely moves; recompute rarely
let accWorker = null, accLast = 0;
// Off by default, and it gates the computation as well as the panel — no point
// spending a second of worker time on a table nobody is looking at.
let showAccuracy = localStorage.getItem("showAccuracy") === "1";

function scoreForecasts() {
  if (!showAccuracy) return;
  const ts = C.data[0], ys = C.data[1];
  if (!ts || ts.length < 60) return;
  if (Date.now() - accLast < ACC_REFRESH_MS) return;
  accLast = Date.now();
  if (!accWorker) {
    try {
      accWorker = new Worker("/static/accuracy.worker.js");
    } catch {
      return;                          // no worker → quietly skip; the panel stays hidden
    }
    accWorker.onmessage = (e) => renderAccuracy(e.data);
  }
  const samples = [];
  for (let i = 0; i < ts.length; i++) if (ys[i] != null) samples.push({ t: ts[i], y: ys[i] });
  accWorker.postMessage({
    samples,
    opts: { originStep: ACC_ORIGIN_STEP, reset: panelResets(C).a },
  });
}

function renderAccuracy(msg) {
  const card = $("accuracy"), body = $("accBody");
  if (!card || !body) return;
  if (!showAccuracy) { card.hidden = true; return; }
  if (!msg || !msg.ok || !msg.result || !Object.keys(msg.result.models).length) {
    card.hidden = true;
    return;
  }
  const { models, horizons, origins } = msg.result;
  // Best (lowest) error per column, so the winner is readable at a glance.
  const best = {};
  for (const h of horizons) {
    for (const row of Object.values(models)) {
      if (row[h] == null) continue;
      if (best[h] == null || row[h] < best[h]) best[h] = row[h];
    }
  }
  const head = `<tr><th>model</th>${horizons.map((h) => `<th>+${h / 3600}h</th>`).join("")}</tr>`;
  const rows = Object.entries(models).map(([name, row]) => {
    const cells = horizons.map((h) => {
      if (row[h] == null) return `<td>–</td>`;
      const cls = Math.abs(row[h] - best[h]) < 1e-9 ? ' class="best"' : "";
      return `<td${cls}>${row[h].toFixed(1)}</td>`;
    }).join("");
    return `<tr${name === forecastModel ? ' class="active"' : ""}><td>${name}</td>${cells}</tr>`;
  }).join("");
  body.innerHTML =
    `<table class="acc-tbl"><thead>${head}</thead><tbody>${rows}</tbody></table>` +
    `<div class="acc-foot muted">mean absolute error in percentage points on the 5-hour ` +
    `series — lower is better. ${origins} origins replayed across all history.</div>`;
  card.hidden = false;
}

function wireAccuracy() {
  const cb = $("accToggle");
  if (!cb) return;
  cb.checked = showAccuracy;
  cb.addEventListener("change", () => {
    showAccuracy = cb.checked;
    localStorage.setItem("showAccuracy", showAccuracy ? "1" : "0");
    if (showAccuracy) {
      $("accBody").textContent = "scoring…";
      $("accuracy").hidden = false;
      accLast = 0;                       // recompute now rather than on the next tick
      scoreForecasts();
    } else {
      $("accuracy").hidden = true;
    }
  });
}

function tick() {
  checkStale();
  renderClaudeResets();
  renderClaudeForecast();
  document.querySelectorAll("#cxBars [data-reset]").forEach((el) => {
    el.textContent = countdown(el.dataset.reset);
  });
  renderCodexForecast();
  updateGauges();
  scoreForecasts();                       // self-throttled to ACC_REFRESH_MS
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
  X.chart = makeChart("cxChart", [{ label: "5h", color: "--cx1", show: false }, { label: "7d", color: "--cx2" }],
    [nowDivider()]);
  observeSize("chart", () => C.chart);
  observeSize("cxChart", () => X.chart);
  wireControls();
  wireRange();
  wireForecastModel();
  wireAccuracy();
  wireChatTip();
  wireChatMode();
  wireUpdate();
  wireCheckUpdate();
  claudeGauge = makeGauge("claudeGauge", [0.3, 0.6]);   // 0–100 %/h dial, red from 60
  codexGauge = makeGauge("codexGauge");                  // window-relative, red from 2× sustainable
  connect();   // rev fires from the first WS "init", once the live rate is known
  setInterval(tick, 1000);
});
