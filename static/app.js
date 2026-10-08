"use strict";

// ---- state ----
// Two independent chart panels: C = Claude, X = Codex. Each holds its full
// series buffer [ [ts(sec)], [a], [b] ] plus the latest live payload.
// C = the desktop app's Claude (or the CLI's when there is no app); K = the CLI's
// when it is signed in too. Same card, ids prefixed by `p`.
const C = { key: "c", p: "", chart: null, data: [[], [], []], resets: {}, last: null };
const K = { key: "k", p: "k_", chart: null, data: [[], [], []], resets: {}, last: null, shown: false };
const CLAUDES = [C, K];
const X = { chart: null, data: [[], [], []], last: null, shown: false };

let bounds = { min: 10, max: 3600 };
// Generous: history arrives thinned (see loadDetail), but zooming in merges
// full-detail stretches back in, and new samples keep arriving.
const MAX_POINTS = 100000;

const RANGES = { "24h": 24 * 3600, "7d": 7 * 24 * 3600, full: Infinity };
// Claude and Codex each keep their own range and forecast model: C and K are
// Claude, X is Codex.
const provOf = (st) => (st === X ? "codex" : "claude");
// Claude keeps the original "range" key so an existing choice carries over.
const RANGE_KEYS = { claude: "range", codex: "range_codex" };
const ranges = {};
for (const [p, k] of Object.entries(RANGE_KEYS)) {
  const v = localStorage.getItem(k);
  ranges[p] = RANGES[v] !== undefined ? v : "24h";
}

// Which forecast strategy drives the chart projection (see predict.js).
const FORECAST_MODELS = ["adaptive", "linear", "cycle", "cycle+tod", "analog"];
// Server-owned, not localStorage: the floating pill runs in a web view with no
// persistent storage, so this is the only place both surfaces can read one value.
// Arrives on the WebSocket "init" and on every "forecast_model" broadcast.
const forecastModels = { claude: "adaptive", codex: "analog" };
const modelOf = (st) => forecastModels[provOf(st)];

// Local weekday numbers you work on (0 = Sunday). Server-owned, like the model:
// all seven means the setting is off and nothing changes.
let workingDays = [0, 1, 2, 3, 4, 5, 6];

function setWorkingDays(csv) {
  const next = String(csv || "").split(",").filter((d) => d !== "").map(Number);
  if (JSON.stringify(next) === JSON.stringify(workingDays)) return;
  workingDays = next;
  paintWorkingDays();
  projCache.clear();
  applyRangeAll();
  accLast = 0; scoreForecasts();
}

function paintWorkingDays() {
  document.querySelectorAll("#workDays button").forEach(
    (b) => b.classList.toggle("on", workingDays.includes(Number(b.dataset.d))));
}

function wireSettings() {
  const gear = $("gear"), panel = $("settings");
  if (!gear || !panel) return;
  gear.addEventListener("click", () => { panel.hidden = !panel.hidden; });
  panel.querySelectorAll("#workDays button").forEach((b) =>
    b.addEventListener("click", () => {
      const d = Number(b.dataset.d);
      const next = workingDays.includes(d)
        ? workingDays.filter((x) => x !== d) : [...workingDays, d].sort();
      // Every day off would leave the forecast permanently flat, so keep one.
      if (!next.length) return;
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ set_working_days: next.join(",") }));
    }));
  paintWorkingDays();
}

// Takes the "forecast_model" (Claude) / "forecast_model_codex" fields of a message.
function setForecastModels(msg) {
  let changed = false;
  for (const [p, m] of [["claude", msg.forecast_model], ["codex", msg.forecast_model_codex]]) {
    if (!FORECAST_MODELS.includes(m) || m === forecastModels[p]) continue;
    forecastModels[p] = m;
    changed = true;
  }
  if (!changed) return;
  paintForecastModel();
  projCache.clear();
  applyRangeAll();
  accLast = 0; scoreForecasts();
}

// Claude's four windows (fixed lengths); Codex windows come from the payload.
// series = index into C.data for the recent-rate method (null → plain cycle
// average). Only the 5-hour window uses the reactive method; weekly windows
// average over the whole cycle.
// Forecast order: 7-day on top (aligns with Codex's 7-day), then 5-hour, then
// the per-model weekly windows. (The bars keep 5-hour on top — this is just the
// forecast list.)
const CLAUDE_WIN = [
  { key: "sd", label: "7-day",  reset: "seven_day",        winMs: 7 * 24 * 3600e3, series: null, col: 2 },
  { key: "fh", label: "5-hour", reset: "five_hour",        winMs: 5 * 3600e3,      series: 1,    col: 1 },
  { key: "so", label: "Opus",   reset: "seven_day_opus",   winMs: 7 * 24 * 3600e3, series: null, col: null },
  { key: "sn", label: "Sonnet", reset: "seven_day_sonnet", winMs: 7 * 24 * 3600e3, series: null, col: null },
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
    // Drag-to-zoom and double-click-to-reset go through the provider's view
    // (see zoomToView), so the overview window moves with them.
    cursor: { y: false, drag: { x: true, y: false, setScale: false },
      bind: { dblclick: (u) => () => resetView(provOf(stOf(u))) } },
    legend: { show: false },
    plugins: [cursorTime(), zoomToView(), ...(plugins || [])],
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

const stOf = (u) => [C, K, X].find((st) => st.chart === u);

// A drag across the main chart sets the view to the dragged span, the same as
// dragging the overview window's edges.
function zoomToView() {
  return { hooks: { setSelect: (u) => {
    const { left, width } = u.select;
    if (width > 2) setView(stOf(u), u.posToVal(left, "x"), u.posToVal(left + width, "x"));
    u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
  } } };
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

// What the chart shows is a window onto history + forecast, kept relative to
// the newest sample so it slides along as samples arrive. A range button sets
// it to a preset (with a third of the history span ahead, as before); dragging
// the overview strip under the chart sets it to anything else.
const AHEAD_MAX = 7 * 86400;    // forecast computed this far; beyond, it is guesswork
const VIEW_MIN = 3600;          // narrowest window the overview lets you drag to
const views = { claude: null, codex: null };   // null = the preset; else {back, ahead} in sec

// The panel's first real sample. The three panels share one timeline, so the
// CLI's rows before it was signed in are all null — not history to show.
function firstReal(st) {
  const [ts, a, b] = st.data;
  for (let i = 0; i < ts.length; i++) if (a[i] != null || b[i] != null) return ts[i];
  return ts.length ? ts[ts.length - 1] : null;
}

function viewOf(st) {
  const ts = st.data[0];
  if (!ts.length) return null;
  const now = ts[ts.length - 1], first = firstReal(st);
  const v = views[provOf(st)];
  if (v) return { min: Math.max(first, now - v.back), max: now + v.ahead };
  const back = Math.min(RANGES[ranges[provOf(st)]], now - first);
  return { min: now - back, max: now + Math.min(AHEAD_MAX, back / 3) };
}

// Recompute history + forecast and draw it, at the current view.
function applyRange(st) {
  if (!st.chart) return;
  const data = withProjection(st.data[0], st.data[1], st.data[2], panelResets(st), modelOf(st));
  st.chart.setData(data, false);
  if (st.ov) {
    st.ov.setData(data, false);
    const ts = data[0];
    if (ts.length) st.ov.setScale("x", { min: firstReal(st), max: ts[ts.length - 1] });
  }
  applyView(st);
}

// Move the view without recomputing anything: cheap enough to run per drag event.
function applyView(st) {
  const v = viewOf(st);
  if (!v || !st.chart) return;
  st.chart.setScale("x", { min: v.min, max: v.max });
  paintWindow(st);
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
  if (CLAUDES.includes(st)) return {
    a: resetOverride(st.resets.five_hour, 5 * 3600),
    b: resetOverride(st.resets.seven_day, 7 * 86400),
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
function withProjection(tsFull, aFull, bFull, rst, model) {
  const nFull = tsFull.length;
  const now = nFull ? tsFull[nFull - 1] : 0;
  // The whole history goes to the chart; the x scale picks what is shown.
  const ts = tsFull, a = aFull, b = bFull;
  const n = ts.length;
  const nul = () => ts.map(() => null);
  // rows: ts, realA, realB, projA, projB, loA, loB, hiA, hiB
  const noProj = [ts.slice(), a.slice(), b.slice(), nul(), nul(), nul(), nul(), nul(), nul()];
  if (nFull < 2 || n < 1) return noProj;
  const horizon = AHEAD_MAX;
  // Fixed hourly step (not tied to the range) so the forecast resolution — and
  // thus the overlapping trajectory — is identical whatever range is selected.
  const step = 3600;
  const P = Predictors[model] || Predictors.linear;

  const rA = P.predict(toSamples(tsFull, aFull), { now, horizon, step, reset: rst && rst.a, workDays: workingDays });
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
    const rB = P.predict(toSamples(tsFull, bFull), { now, horizon, step, reset: rst && rst.b, workDays: workingDays });
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
function applyRangeAll() { applyRange(C); applyRange(K); applyRange(X); renderConsumed(); }

// Percentage units consumed within the visible range = sum of positive
// step-to-step increments per series (resets/decreases don't count).
function consumedInRange(st) {
  const ts = st.data[0];
  const v = viewOf(st);
  let i = 0;
  if (v) while (i < ts.length && ts[i] < v.min) i++;
  const end = v ? v.max : Infinity;
  const out = [];
  for (let s = 1; s <= 2; s++) {
    const y = st.data[s];
    let sum = 0, prev = null, n = 0;
    for (let k = i; k < y.length && ts[k] <= end; k++) {
      const val = y[k];
      if (val == null) continue;
      n++;
      if (prev != null && val > prev) sum += val - prev;
      prev = val;
    }
    out.push({ sum, n });
  }
  return out;
}

function renderConsumed() {
  const targets = [
    // {i} indexes into consumedInRange's [series1, series2]. Codex omits 5-hour.
    { st: C, el: "consumed", series: [{ i: 0, lbl: "5h", col: "--fh" }, { i: 1, lbl: "7d", col: "--sd" }] },
    { st: K, el: "k_consumed", series: [{ i: 0, lbl: "5h", col: "--fh" }, { i: 1, lbl: "7d", col: "--sd" }] },
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

// Appends without drawing. Ignores anything not newer than the last point: after
// a resync, the samples the socket buffered while the page was paused arrive too.
function appendPoint(st, tsSec, a, b) {
  const t = st.data[0];
  if (t.length && tsSec <= t[t.length - 1]) return false;
  t.push(tsSec); st.data[1].push(a); st.data[2].push(b);
  if (t.length > MAX_POINTS) {
    const cut = t.length - MAX_POINTS;
    st.data = st.data.map((s) => s.slice(cut));
  }
  return true;
}

function pushPoint(st, tsSec, a, b) {
  if (!appendPoint(st, tsSec, a, b)) return;
  applyRange(st);
  renderConsumed();
}

function loadHistory(rows) {
  C.data = [[], [], []]; K.data = [[], [], []]; X.data = [[], [], []];
  for (const r of rows) {
    C.data[0].push(r.ts / 1000); C.data[1].push(r.fh); C.data[2].push(r.sd);
    K.data[0].push(r.ts / 1000); K.data[1].push(r.kh); K.data[2].push(r.kd);
    X.data[0].push(r.ts / 1000); X.data[1].push(r.cp); X.data[2].push(r.cs);
  }
  // Deliberately does NOT draw. The caller renders the live payloads first,
  // because those carry the authoritative reset instants — drawing before them
  // makes the predictor infer a reset period from noisy data, and the forecast
  // comes out as a sawtooth that silently corrects on the next redraw.
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
function renderClaude(st, s) {
  st.last = s;
  if (s.resets) st.resets = s.resets;
  if (st === K) showClaude2();
  const sl = scopedLimit(st);
  const wk = sl ? sl.percent : s.sd;
  $(st.p + "fhFill").style.width = (s.fh ?? 0) + "%";
  $(st.p + "sdFill").style.width = (wk ?? 0) + "%";
  $(st.p + "fhPct").textContent = fmtPct(s.fh);
  $(st.p + "sdPct").textContent = fmtPct(wk);
  $(st.p + "sdLabel").textContent = sl ? scope : "7-day";
  paintScope(st, sl);
  renderScoped(st, s.limits);
  renderClaudeResets(st);
  renderClaudeForecast(st);
}

// Desktop and CLI both signed in: one column at a time, picked by the Desktop | CLI switch
// beside the name (the copy in each column's head drives the same choice).
let acct = "desktop";   // the server's; arrives on "init" and "claude_account"
function showClaude2() {
  if (K.shown) return;
  K.shown = true;
  document.querySelectorAll('.seg[data-sync="acct"]').forEach((g) => { g.hidden = false; });
  paintAcct();
}

function paintAcct() {
  const cli = K.shown && acct === "cli";
  $("colClaude").hidden = cli;
  $("k_colClaude").hidden = !cli;
  document.querySelectorAll('.seg[data-sync="acct"] button').forEach((b) =>
    b.classList.toggle("on", b.dataset.a === acct));
}

function wireAcct() {
  document.querySelectorAll('.seg[data-sync="acct"] button').forEach((b) =>
    b.addEventListener("click", () => {
      // Kept server-side, so the menu bar and widget switch too.
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ set_claude_account: b.dataset.a }));
    }));
}

// All | Fable (one button per model-scoped weekly limit): picks which weekly limit
// the 7-day bar and its forecast row show. Per-browser, like the chart range; the
// chart itself stays the all-models history (scoped limits aren't stored).
let scope = localStorage.getItem("scope") || "";

function scopedLimit(st) {
  if (!scope || !st.last) return null;
  return (st.last.limits || []).find((l) => l.scope && l.scope.model
    && l.scope.model.display_name === scope) || null;
}

function paintScope(st, sl) {
  const seg = $(st.p + "scopeSeg");
  const names = (st.last.limits || []).filter((l) => l.scope && l.scope.model)
    .map((l) => l.scope.model.display_name).filter(Boolean);
  seg.hidden = !names.length;
  // Built with the DOM rather than innerHTML so a model name is never parsed as markup.
  seg.replaceChildren(...[["", "All"], ...names.map((n) => [n, n])].map(([v, text]) => {
    const b = document.createElement("button");
    b.dataset.s = v;
    b.textContent = text;
    b.classList.toggle("on", v === (sl ? scope : ""));
    return b;
  }));
}

function wireScope() {
  document.querySelectorAll('.seg[data-sync="scope"]').forEach((seg) =>
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      scope = b.dataset.s; localStorage.setItem("scope", scope);
      for (const st of CLAUDES) if (st.last) renderClaude(st, st.last);
    }));
}

function renderScoped(st, limits) {
  const box = $(st.p + "scoped");
  const scoped = (limits || []).filter((l) => l.scope && l.scope.model);
  box.innerHTML = scoped.map((l) => {
    const name = l.scope.model.display_name || "model";
    return `<div class="row"><span>Weekly · ${name}</span><b>${Math.round(l.percent)}%</b></div>`;
  }).join("");
}

function renderClaudeResets(st) {
  $(st.p + "fhReset").textContent = countdown(st.resets.five_hour);
  const sl = scopedLimit(st);
  $(st.p + "sdReset").textContent = countdown(sl ? sl.resets_at : st.resets.seven_day);
}

// The text rows read the SAME trajectory the chart draws, so a sentence and the
// curve above it can never disagree. Memoised because tick() runs every second
// while the trajectory only moves when the data, model or reset does — and
// cycle+tod is a simulation, not a formula.
const projCache = new Map();
function windowProjection(st, col, resetIso, reset) {
  const ts = st.data[0];
  if (col == null || !resetIso || !ts.length) return null;
  const now = ts[ts.length - 1];
  const horizon = new Date(resetIso).getTime() / 1000 - now;
  if (!(horizon > 0)) return null;
  const key = `${st.key || "x"}|${col}|${modelOf(st)}|${now}|${resetIso}`;
  if (projCache.has(key)) return projCache.get(key);
  const P = Predictors[modelOf(st)] || Predictors.linear;
  let pts = null;
  try {
    pts = P.predict(toSamples(ts, st.data[col]), { now, horizon, step: 3600, reset, workDays: workingDays }).points;
  } catch { pts = null; }
  if (projCache.size > 12) projCache.clear();      // keys rotate on every sample
  projCache.set(key, pts);
  return pts;
}

// The projection wants the same authoritative reset the chart uses: a = series 1,
// b = series 2.
function colReset(st, col) {
  const r = panelResets(st);
  return col === 1 ? r.a : col === 2 ? r.b : null;
}

function renderClaudeForecast(st) {
  if (!st.last) return;
  const rows = [];
  // A scoped view swaps the weekly rows for that model's limit (straight-line
  // pace: there's no stored history for it); the 5-hour limit still applies.
  const sl = scopedLimit(st);
  if (sl) rows.push(progRow(scope, forecast(sl.percent, 7 * 24 * 3600e3, sl.resets_at, null)));
  for (const w of sl ? CLAUDE_WIN.filter((w) => w.key === "fh") : CLAUDE_WIN) {
    const cur = st.last[w.key];
    if (cur == null) continue;
    const resetIso = st.resets[w.reset];
    const samples = (w.series && resetIso)
      ? cycleSamples(st.data, w.series, new Date(resetIso).getTime(), w.winMs) : null;
    // Windows the chart doesn't plot (Opus, Sonnet) keep the straight-line pace.
    const proj = windowProjection(st, w.col, resetIso, colReset(st, w.col));
    const p = (proj && forecastFromPoints(cur, w.winMs, resetIso, proj))
      || forecast(cur, w.winMs, resetIso, samples);
    rows.push(progRow(w.label, p));
  }
  $(st.p + "prog").innerHTML = rows.join("") || emptyRow();
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
  const colByLabel = { "5-hour": 1, "7-day": 2 };   // which charted series the window is
  const progFor = (w) => {
    const idx = idxByLabel[w.label] || null;
    const col = colByLabel[w.label] || null;
    const winMs = (w.window_seconds || 0) * 1000;
    const samples = (idx && w.reset_at)
      ? cycleSamples(X.data, idx, new Date(w.reset_at).getTime(), winMs) : null;
    const proj = windowProjection(X, col, w.reset_at, colReset(X, col));
    const p = (proj && forecastFromPoints(w.used_percent, winMs, w.reset_at, proj))
      || forecast(w.used_percent, winMs, w.reset_at, samples);
    return progRow(w.label, p);
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
  for (const id of ["dot", "k_dot", "cxDot"]) {
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

// One range per provider; both Claude columns (desktop + CLI) share Claude's.
// A dragged window lights no preset; clicking one snaps back to it.
function paintRange() {
  document.querySelectorAll('.seg[data-sync="range"]').forEach((g) =>
    g.querySelectorAll("button").forEach((b) =>
      b.classList.toggle("on", !views[g.dataset.p] && b.dataset.r === ranges[g.dataset.p])));
}

function wireRange() {
  paintRange();
  document.querySelectorAll('.seg[data-sync="range"]').forEach((g) =>
    g.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      const p = g.dataset.p;
      ranges[p] = b.dataset.r;
      try { localStorage.setItem(RANGE_KEYS[p], ranges[p]); } catch {}
      resetView(p);
    })));
}

// Back to the provider's preset range: a range button, or a double-click on the chart.
function resetView(p) {
  views[p] = null;
  paintRange();
  for (const st of [C, K, X]) if (provOf(st) === p) applyView(st);
  renderConsumed();
}

// ---- detail on demand ----
// The page opens with history older than a week thinned to one point per 10
// minutes — plenty zoomed out, coarse up close. Hold the chart on such a
// stretch for DWELL_MS and it fills in at full detail.
const DWELL_MS = 300;
const DETAIL_MAX_SPAN = 7 * 86400;   // wider than this, 10-minute points already outnumber pixels
let fullSince = -Infinity;           // sec; samples from here on arrived at full detail
const detailed = [];                 // [from, to] stretches already fetched at full detail
let dwellTimer = null;

function scheduleDetail(st) {
  clearTimeout(dwellTimer);
  dwellTimer = setTimeout(() => loadDetail(st), DWELL_MS);
}

async function loadDetail(st) {
  const v = viewOf(st);
  if (!v || v.max - v.min > DETAIL_MAX_SPAN) return;
  const pad = (v.max - v.min) / 4;             // a little either side, so a nudge needs no refetch
  const from = v.min - pad, to = Math.min(v.max + pad, fullSince);
  if (to <= from) return;                      // all inside the full-detail week
  if (detailed.some(([a, b]) => a <= from && b >= to)) return;
  try {
    const url = `/api/history?since=${Math.floor(from * 1000)}&until=${Math.ceil(to * 1000)}`;
    const r = await (await fetch(url)).json();
    detailed.push([from, to]);
    if (r.history && r.history.length) { mergeHistory(r.history); applyRangeAll(); }
  } catch { /* stay at the thinned detail; the next dwell retries */ }
}

// Fold fetched rows into every panel's series, in time order, replacing any
// sample already held at the same instant.
function mergeHistory(rows) {
  for (const [st, ka, kb] of [[C, "fh", "sd"], [K, "kh", "kd"], [X, "cp", "cs"]]) {
    const [t0, a0, b0] = st.data, t = [], ya = [], yb = [];
    let i = 0, j = 0;
    while (i < t0.length || j < rows.length) {
      const rt = j < rows.length ? rows[j].ts / 1000 : Infinity;
      if (i < t0.length && t0[i] < rt) { t.push(t0[i]); ya.push(a0[i]); yb.push(b0[i]); i++; continue; }
      if (i < t0.length && t0[i] === rt) i++;
      t.push(rt); ya.push(rows[j][ka]); yb.push(rows[j][kb]); j++;
    }
    st.data = [t, ya, yb];
  }
}

// ---- overview strip ----
// A small chart of all history plus the forecast under each main chart, with
// a highlighted window marking what the main chart shows. Drag the window to
// move through time, drag its edges to zoom, click outside it to jump there.
const OV_HEIGHT = 56;

function makeOverview(elId, series) {
  const el = $(elId);
  if (!el) return null;
  const line = (s, dim) => ({ stroke: css(dim ? s.color + "-dim" : s.color), width: 1,
    points: { show: false }, show: s.show !== false });
  const off = () => ({ show: false });
  const opts = {
    width: el.clientWidth || 640, height: OV_HEIGHT,
    padding: [4, 8, 0, 38],                         // line up with the main chart's y axis
    cursor: { show: false, drag: { x: false, y: false } },
    legend: { show: false },
    plugins: [nowDivider()],
    scales: { y: { range: [0, 100] } },
    axes: [
      { grid: { show: false }, ticks: { show: false }, size: 18, values: fmtAxis,
        stroke: css("--muted"), font: "10px -apple-system, system-ui, sans-serif" },
      { show: false },
    ],
    series: [{}, ...series.map((s) => line(s)), ...series.map((s) => line(s, true)),
      ...series.map(off), ...series.map(off)],
  };
  const empty = [[], ...opts.series.slice(1).map(() => [])];
  return new uPlot(opts, empty, el);
}

function paintWindow(st) {
  const u = st.ov, v = viewOf(st);
  if (!u || !st.ovWin) return;
  st.ovWin.hidden = !v;
  if (!v) return;
  const l = u.valToPos(v.min, "x"), r = u.valToPos(v.max, "x");
  st.ovWin.style.left = l + "px";
  st.ovWin.style.width = Math.max(2, r - l) + "px";
}

// Set the provider's window to [min, max], kept inside history + forecast.
function setView(st, min, max, kind) {
  const ts = st.data[0];
  if (!ts.length) return;
  const now = ts[ts.length - 1], lo = firstReal(st), hi = now + AHEAD_MAX;
  if (kind === "move") {                            // keep the width, stop at the ends
    const w = Math.min(max - min, hi - lo);
    if (min < lo) { min = lo; max = lo + w; }
    if (max > hi) { max = hi; min = hi - w; }
  } else {
    min = Math.max(lo, min); max = Math.min(hi, max);
    if (max - min < VIEW_MIN) {
      if (kind === "l") min = max - VIEW_MIN; else max = min + VIEW_MIN;
    }
  }
  const p = provOf(st);
  views[p] = { back: now - min, ahead: max - now };
  paintRange();
  for (const s of [C, K, X]) if (provOf(s) === p) applyView(s);
  renderConsumed();
  scheduleDetail(st);
}

function attachNavigator(st) {
  const u = st.ov;
  if (!u) return;
  const win = document.createElement("div");
  win.className = "ov-win";
  u.over.appendChild(win);
  st.ovWin = win;
  const EDGE = 6;                                   // px either side of an edge that grabs it
  const xAt = (e) => e.clientX - u.over.getBoundingClientRect().left;
  const hit = (x) => {
    const v = viewOf(st);
    if (!v) return null;
    const l = u.valToPos(v.min, "x"), r = u.valToPos(v.max, "x");
    if (Math.abs(x - l) <= EDGE) return "l";
    if (Math.abs(x - r) <= EDGE) return "r";
    return x > l && x < r ? "move" : "jump";
  };
  const CURSOR = { l: "ew-resize", r: "ew-resize", move: "grab", jump: "pointer" };
  let drag = null;
  u.over.addEventListener("pointerdown", (e) => {
    const x = xAt(e), kind = hit(x);
    if (!kind) return;
    let { min, max } = viewOf(st);
    if (kind === "jump") {                          // centre the window here, then drag it
      const c = u.posToVal(x, "x"), half = (max - min) / 2;
      min = c - half; max = c + half;
      setView(st, min, max, "move");
      ({ min, max } = viewOf(st));
    }
    drag = { kind: kind === "jump" ? "move" : kind, t0: u.posToVal(x, "x"), min, max };
    u.over.setPointerCapture(e.pointerId);
    u.over.style.cursor = drag.kind === "move" ? "grabbing" : "ew-resize";
    e.preventDefault();
  });
  u.over.addEventListener("pointermove", (e) => {
    if (!drag) { u.over.style.cursor = CURSOR[hit(xAt(e))] || ""; return; }
    const dt = u.posToVal(xAt(e), "x") - drag.t0;
    let { min, max } = drag;
    if (drag.kind === "l") min += dt;
    else if (drag.kind === "r") max += dt;
    else { min += dt; max += dt; }
    setView(st, min, max, drag.kind);
  });
  const end = () => { drag = null; u.over.style.cursor = ""; };
  u.over.addEventListener("pointerup", end);
  u.over.addEventListener("pointercancel", end);
}

// One model per provider, kept in step across that provider's panels.
function wireForecastModel() {
  document.querySelectorAll('.seg[data-sync="model"]').forEach((g) =>
    g.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      // Tell the server; the broadcast comes back and applies it everywhere,
      // including the floating pill.
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ set_forecast_model: b.dataset.m, provider: g.dataset.p }));
      }
    })));
  paintForecastModel();
}

function paintForecastModel() {
  document.querySelectorAll('.seg[data-sync="model"]').forEach((g) =>
    g.querySelectorAll("button").forEach((b) =>
      b.classList.toggle("on", b.dataset.m === forecastModels[g.dataset.p])));
}

function setIntervalUI(n) {
  $("ivalNum").value = n;
  $("ival").value = Math.min(Number($("ival").max), n);
}

// ---- websocket ----
let ws = null, backoff = 500;
let bootVersion = null;   // the version this page's own scripts came from
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
  // Placed by LAST use, not creation. A long thread accrues most of its cost
  // late, and plotting it on the day it was opened puts the bar days away from
  // the spending it represents — and out of step with the Today filter, which
  // has always asked when a session was last active.
  const at = (r) => new Date(r.end || r.when);
  // Today's chats all share one date, so an x axis of dates says nothing —
  // rank them by spend instead. Across all history the date is the point.
  rows.sort(ccMode === "today"
    ? (a, b) => b.pct - a.pct
    : (a, b) => at(a) - at(b));
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
        at(r).toLocaleDateString([], { month: "short", day: "numeric" }));
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
    if (r.end) {
      rows_.push(["last used", new Date(r.end).toLocaleString([], {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })]);
      rows_.push(["ran for", fmtDur((new Date(r.end) - when) / 1000)]);
    }
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

// ---- changelog ----
// After an update the server sends every section since the version this install
// last showed; "Got it" acknowledges them so they appear once. The footer's
// version opens the full history, read-only.
let wnMode = null;                     // "update" acknowledges on close, "view" does not

function renderChangelog(entries, mode, sub) {
  const body = $("wnBody");
  if (!body || !entries || !entries.length) return;
  body.textContent = "";               // built with textContent: commit text is never markup
  for (const e of entries) {
    const h = document.createElement("div");
    h.className = "wn-ver";
    h.textContent = "v" + e.version;
    if (e.date) {
      const d = document.createElement("span");
      d.className = "muted"; d.textContent = e.date; h.appendChild(d);
    }
    const ul = document.createElement("ul");
    for (const it of e.items) {
      const li = document.createElement("li"); li.textContent = it; ul.appendChild(li);
    }
    body.append(h, ul);
  }
  $("wnTitle").textContent = mode === "update" ? "What's new" : "Changelog";
  $("wnSub").textContent = sub || "";
  $("wnOk").textContent = mode === "update" ? "Got it" : "Close";
  wnMode = mode;
  $("whatsNew").hidden = false;
}

function closeChangelog() {
  const modal = $("whatsNew");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  if (wnMode === "update" && ws && ws.readyState === 1) ws.send(JSON.stringify({ ack_changelog: true }));
  wnMode = null;
}

function wireChangelog() {
  const ok = $("wnOk"), modal = $("whatsNew"), ver = $("version");
  if (!ok || !modal) return;
  ok.addEventListener("click", closeChangelog);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeChangelog(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeChangelog(); });
  if (ver) ver.addEventListener("click", async () => {
    try {
      const r = await (await fetch("/api/changelog")).json();
      renderChangelog(r.entries, "view", r.current ? "you are on v" + r.current : "");
    } catch { /* server unreachable: nothing to show */ }
  });
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
      applyUpdate();                                      // banner carries the outcome
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

// Applying runs detached, out of process, and the only sign of success is the
// server coming back — so a refusal (local edits in the checkout, no network,
// an agent that won't restart) used to leave this banner saying "Updating…"
// forever. update.sh records what it did; poll that and report it.
const UPDATE_WAIT_MS = 4 * 60e3;   // longest plausible run: fetch + pip + restart
async function applyUpdate() {
  const btn = $("updateBtn"), msg = $("updateMsg");
  const failed = (text) => {
    $("updateBar").hidden = false;
    msg.textContent = text;
    btn.disabled = false;
    const chk = $("checkUpdate");
    if (chk) { chk.dataset.busy = "0"; chk.disabled = false; setCheckBtnLabel(); }
  };
  btn.disabled = true;
  msg.textContent = "Updating… the app will restart in a moment.";
  try {
    const r = await fetch("/api/update", { method: "POST" });
    if (!r.ok) {                       // nothing to apply (e.g. 400)
      const body = await r.json().catch(() => ({}));
      failed("Update didn't start: " + (body.error || "HTTP " + r.status));
      setTimeout(() => renderUpdate(lastUpdate), 3000);    // restore true state
      return;
    }
  } catch (e) {
    // Connection dropped — expected while the server restarts to apply.
  }
  const until = Date.now() + UPDATE_WAIT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 3000));
    // The WS reconnected on the new version and cleared the banner: done.
    if (!updateReady()) return;
    let st = null;
    try { st = await (await fetch("/api/update-status")).json(); }
    catch (e) { continue; }            // server is down mid-restart: keep waiting
    if (st.state === "fail") return failed("Update failed: " + st.message);
  }
  failed("Update didn't finish — see ~/.claude-usage/update.log");
}

function wireUpdate() {
  $("updateBtn").addEventListener("click", applyUpdate);
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
      const running = m.update && m.update.current;
      if (bootVersion && running && running !== bootVersion) { location.reload(); return; }
      bootVersion = bootVersion || running;
      if (m.limits) bounds = m.limits;
      $("ival").min = bounds.min; $("ivalNum").min = bounds.min; $("ivalNum").max = bounds.max;
      // Settings before the first draw, so it is drawn once with the right model
      // and account rather than with the defaults and then redrawn.
      setForecastModels(m);
      if (m.claude_account) { acct = m.claude_account; paintAcct(); }
      if (m.working_days != null) setWorkingDays(m.working_days);
      loadHistory(m.history || []);
      fullSince = m.history_full_since != null ? m.history_full_since / 1000 : -Infinity;
      detailed.length = 0;
      if (m.claude) renderClaude(C, m.claude);
      if (m.claude2) renderClaude(K, m.claude2);
      if (m.codex) renderCodex(m.codex);
      applyRangeAll();                      // now that resets are known
      if (m.cc) renderCC(m.cc);
      if (m.xcost) renderXcost(m.xcost);
      if (m.update) renderUpdate(m.update);
      setIntervalUI(m.interval);
      if (m.changelog && m.changelog.length) {
        renderChangelog(m.changelog, "update",
          m.changelog_from ? "since v" + m.changelog_from : "");
      }
      setStatus(m.status);
      updateGauges();
      snapGauges();
      scoreForecasts();
      reveal();
      refreshIfBehind();                    // e.g. reconnected after the Mac slept
    } else if (m.type === "sample") {
      // A refresh landing, or the backlog a paused page drains on waking: put it
      // up as it stands rather than animate through each step.
      const quiet = refreshUntil || Date.now() - sampleTs(m) > CATCHUP_AGE_MS;
      if (quiet) quietly();
      refreshUntil = 0;
      if (m.claude) { pushPoint(C, m.claude.ts / 1000, m.claude.fh, m.claude.sd); renderClaude(C, m.claude); }
      if (m.claude2) { pushPoint(K, m.claude2.ts / 1000, m.claude2.fh, m.claude2.sd); renderClaude(K, m.claude2); }
      if (m.codex) { pushPoint(X, m.codex.ts / 1000, m.codex.cp, m.codex.cs); renderCodex(m.codex); }
      if (quiet) { updateGauges(); snapGauges(); }
      setStatus(m.status);
    } else if (m.type === "cc") {
      renderCC(m.cc);
    } else if (m.type === "xcost") {
      renderXcost(m.xcost);
    } else if (m.type === "update") {
      renderUpdate(m.update);
    } else if (m.type === "status") {
      if (m.status && m.status.state === "error") refreshUntil = 0;   // let the stale bar speak
      setStatus(m.status);
    } else if (m.type === "changelog") {
      // acknowledged in another tab (or the menu-bar popover): close here too
      if (!(m.changelog && m.changelog.length) && wnMode === "update") {
        $("whatsNew").hidden = true; wnMode = null;
      }
    } else if (m.type === "working_days") {
      setWorkingDays(m.working_days);
    } else if (m.type === "claude_account") {
      acct = m.claude_account; paintAcct();
    } else if (m.type === "forecast_model") {
      setForecastModels(m);
    } else if (m.type === "interval") {
      setIntervalUI(m.interval);
    }
  };
}

// ---- 1-second tick: keep countdowns + forecasts fresh ----
// ---- burn-rate gauges (speedometer of last-5-min %/h) ----
const GAUGE_MAX = 60;   // %/h full-scale
let claudeGauge = null, claude2Gauge = null, codexGauge = null;

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
  // One always-on animation loop drives the needle: it eases toward `target`
  // (the live rate) as samples arrive. Opening the page snaps it there instead.
  const SMOOTH = 0.12, VIB_AMP = 4, VIB_FREQ = 0.08, PUFF_MS = 120;
  let target = 0, cur = 0, over = false, lastPuff = 0;
  const loop = (now) => {
    if (over && now - lastPuff > PUFF_MS) { lastPuff = now; puff(); }
    cur += (target - cur) * SMOOTH;                                   // exponential ease
    if (Math.abs(target - cur) < 0.03) cur = target;
    // Over the dial's max → buzz the needle against the redline (clamped at max).
    const dv = over ? cur + Math.sin(now * VIB_FREQ) * VIB_AMP : cur;
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
    snap() { cur = target; },
  };
}

function snapGauges() { for (const g of [claudeGauge, claude2Gauge, codexGauge]) if (g) g.snap(); }

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
  for (const [g, st] of [[claudeGauge, C], [claude2Gauge, K]]) {
    if (!g) continue;
    const r = burnRate(st.data[0], st.data[1], now, 5 * 60);   // 5-hour rate
    g.update(r, CLAUDE_MAX, 5);
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
  for (const st of [C, K, X]) {
    const ts = st.data && st.data[0];
    if (ts && ts.length) newest = Math.max(newest, ts[ts.length - 1] * 1000);
  }
  return newest || null;
}

// Opening the dashboard shows the current state at once. The page starts hidden
// (body.booting) with transitions off (body.still); the first "init" renders
// everything, then reveal() shows it and turns transitions back on, so nothing
// grows, sweeps or reflows into place.
function reveal() {
  document.body.classList.remove("booting");
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove("still")));
}

// The menu bar calls this each time its panel opens. The page has been paused
// while the panel was closed, so fetch what it missed now — not on the next
// tick — and put it up without animating the catch-up.
window.showLatest = async () => {
  document.body.classList.add("still");
  await resync();
  for (const st of CLAUDES) renderClaudeForecast(st);
  renderCodexForecast();
  renderConsumed();
  updateGauges();
  snapGauges();
  lastTick = Date.now();                  // the pause is handled: don't resync again
  reveal();
};
// Older menu-bar builds call this name on open.
window.revGauges = window.showLatest;

// A paused page (closed menu-bar panel, background tab, sleep) holds data only as
// fresh as the pause — the socket's samples sit buffered until it runs again. Ask
// the server for what was missed rather than report our own pause as a dead poller.
let resyncing = false;
async function resync() {
  const newest = newestSampleMs();
  if (resyncing || !newest) return;      // no data yet: the socket's init brings it
  resyncing = true;
  try {
    const r = await (await fetch(`/api/history?since=${Math.round(newest) + 1}`)).json();
    for (const row of r.history || []) {
      appendPoint(C, row.ts / 1000, row.fh, row.sd);
      appendPoint(K, row.ts / 1000, row.kh, row.kd);
      appendPoint(X, row.ts / 1000, row.cp, row.cs);
    }
    applyRangeAll();
  } catch { /* server unreachable: then the stale bar is telling the truth */ }
  resyncing = false;
  refreshIfBehind();
  checkStale();
}

// After a sleep the poller was paused too, so even a resync can leave the newest
// sample hours old. Ask for a poll now and wait for it quietly, instead of
// warning about a dead poller and then catching up in steps.
const REFRESH_WAIT_MS = 60e3;   // the server caps a poll at 45s; past this the stale bar speaks
const CATCHUP_AGE_MS = 30e3;    // a sample older than this on arrival was buffered, not live
let refreshUntil = 0;           // a poll asked for is in flight until a sample lands or this passes
const sampleTs = (m) => Math.max(...[m.claude, m.claude2, m.codex].map((x) => (x && x.ts) || 0));

function refreshIfBehind() {
  const newest = newestSampleMs();
  const poll = Number($("ivalNum") && $("ivalNum").value) || 60;
  if (!newest || Date.now() - newest <= (poll + 15) * 1000) return;
  if (Date.now() < refreshUntil || !(ws && ws.readyState === 1)) return;   // reconnect's init retries
  ws.send(JSON.stringify({ poll_now: true }));
  refreshUntil = Date.now() + REFRESH_WAIT_MS;
  $("updated").textContent = "refreshing…";
}

// Transitions off until things settle: each buffered message renders in its own
// task, so one animation frame is not enough to cover them all.
let quietTimer = null;
function quietly() {
  document.body.classList.add("still");
  clearTimeout(quietTimer);
  quietTimer = setTimeout(() => document.body.classList.remove("still"), 400);
}

function checkStale() {
  const el = $("stale");
  if (!el) return;
  const newest = newestSampleMs();
  if (!newest || resyncing || Date.now() < refreshUntil) { el.hidden = true; return; }
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
    return `<tr${name === forecastModels.claude ? ' class="active"' : ""}><td>${name}</td>${cells}</tr>`;
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

const PAUSE_GAP_MS = 5000;   // a 1s ticker that skipped this long was paused
let lastTick = Date.now();

function tick() {
  const now = Date.now(), paused = now - lastTick > PAUSE_GAP_MS;
  lastTick = now;
  if (paused) resync(); else checkStale();
  for (const st of CLAUDES) { renderClaudeResets(st); renderClaudeForecast(st); }
  document.querySelectorAll("#cxBars [data-reset]").forEach((el) => {
    el.textContent = countdown(el.dataset.reset);
  });
  renderCodexForecast();
  updateGauges();
  scoreForecasts();                       // self-throttled to ACC_REFRESH_MS
}

// ---- boot ----
// Keep each uPlot sized to its container through reveals / layout changes / resizes.
function observeSize(elId, getChart, height = 240, after = null) {
  const el = $(elId);
  if (!el) return;
  const ro = new ResizeObserver(() => {
    const w = el.clientWidth;
    const chart = getChart();
    if (w > 0 && chart) { chart.setSize({ width: w, height }); if (after) after(); }
  });
  ro.observe(el);
}

// The second account's column is a copy of the first, made before anything is
// wired so the range and model buttons inside it get wired too.
function cloneClaudeColumn() {
  const col = $("colClaude").cloneNode(true);
  col.querySelectorAll("[id]").forEach((el) => { el.id = K.p + el.id; });
  col.id = K.p + "colClaude";
  col.hidden = true;
  $("colClaude").after(col);
}

window.addEventListener("load", () => {
  cloneClaudeColumn();
  K.chart = makeChart("k_chart", [{ label: "5h", color: "--fh" }, { label: "7d", color: "--sd" }],
    [nowDivider()]);
  observeSize("k_chart", () => K.chart);
  C.chart = makeChart("chart", [{ label: "5h", color: "--fh" }, { label: "7d", color: "--sd" }],
    [nowDivider()]);
  // Codex has no real 5-hour limit (its 5-hour "Spark" window is feature-specific
  // and usually 0), so hide that series.
  X.chart = makeChart("cxChart", [{ label: "5h", color: "--cx1", show: false }, { label: "7d", color: "--cx2" }],
    [nowDivider()]);
  observeSize("chart", () => C.chart);
  observeSize("cxChart", () => X.chart);
  for (const [st, id, series] of [
    [C, "chartOv", [{ color: "--fh" }, { color: "--sd" }]],
    [K, "k_chartOv", [{ color: "--fh" }, { color: "--sd" }]],
    [X, "cxChartOv", [{ color: "--cx1", show: false }, { color: "--cx2" }]],
  ]) {
    st.ov = makeOverview(id, series);
    attachNavigator(st);
    observeSize(id, () => st.ov, OV_HEIGHT, () => paintWindow(st));
  }
  wireControls();
  wireAcct();
  wireScope();
  wireRange();
  wireForecastModel();
  wireAccuracy();
  wireChatTip();
  wireSettings();
  wireChangelog();
  wireChatMode();
  wireUpdate();
  wireCheckUpdate();
  claudeGauge = makeGauge("claudeGauge", [0.3, 0.6]);   // 0–100 %/h dial, red from 60
  claude2Gauge = makeGauge("k_claudeGauge", [0.3, 0.6]);
  codexGauge = makeGauge("codexGauge");                  // window-relative, red from 2× sustainable
  connect();
  // Never stay hidden: if the server is down there is still a status to show.
  setTimeout(reveal, 1500);
  setInterval(tick, 1000);
});
