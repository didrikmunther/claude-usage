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

const RANGES = { "24h": 24 * 3600, "7d": 7 * 24 * 3600, "14d": 14 * 24 * 3600, "30d": 30 * 24 * 3600, full: Infinity };
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
const MODEL_NAMES = { adaptive: "Adaptive", linear: "Linear", cycle: "Cycle", "cycle+tod": "Cycle+day", analog: "Analog" };
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
    plugins: [cursorTime(), zoomToView(), offlineBands(true), ...(plugins || [])],
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
      if (offlineAt(u.posToVal(u.cursor.left, "x"))) parts.push("offline");
      el.textContent = parts.join(" · ");
      el.style.left = Math.max(0, Math.min(u.over.clientWidth, u.cursor.left)) + "px";
    },
  } };
}

// Stretches with no internet, as the server recorded them: [start, end] in sec.
// Shaded under the lines so a gap reads as "offline" rather than as missing data.
let offline = [];
const OFFLINE_LABEL_PX = 48;            // narrower than this, the band goes unlabelled

function setOffline(spans) {
  offline = (spans || []).map(([a, b]) => [a / 1000, b / 1000]);
  for (const st of [C, K, X]) {
    if (st.chart) st.chart.redraw(false);
    if (st.ov) st.ov.redraw(false);
  }
}

const offlineAt = (t) => offline.some(([a, b]) => t >= a && t <= b);

function offlineBands(label) {
  return { hooks: { drawAxes: (u) => {
    if (!offline.length) return;
    const { left, top, width, height } = u.bbox;
    const ctx = u.ctx;
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
    ctx.fillStyle = css("--offline");
    for (const [a, b] of offline) {
      const x0 = u.valToPos(a, "x", true), x1 = u.valToPos(b, "x", true);
      if (x1 < left || x0 > left + width) continue;
      const w = Math.max(2 * devicePixelRatio, x1 - x0);
      ctx.fillRect(x0, top, w, height);
      if (label && w >= OFFLINE_LABEL_PX * devicePixelRatio) {
        ctx.fillStyle = css("--muted");
        ctx.font = `${11 * devicePixelRatio}px -apple-system, system-ui, sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText("offline", x0 + w / 2, top + 4 * devicePixelRatio);
        ctx.fillStyle = css("--offline");
      }
    }
    ctx.restore();
  } } };
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

// The Claude columns on screen: one of Desktop | CLI shows at a time, and the
// hidden one is skipped (its chart, forecast cone and meters) until it shows.
function shownClaudes() {
  return CLAUDES.filter((st) => { const col = $(st.p + "colClaude"); return !col || !col.hidden; });
}

// Recompute history + forecast and draw it, at the current view.
function applyRange(st) {
  if (!st.chart) return;
  if (CLAUDES.includes(st) && !shownClaudes().includes(st)) return;
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
const ENDED_SEC = 3600;   // no sample for this long: the window is gone, not just a missed poll
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

  // A window that stopped reporting (Claude's 5-hour on plans that dropped it)
  // has nothing to forecast: its old history would keep drawing a projection.
  const ended = (ys) => {
    for (let i = nFull - 1; i >= 0; i--) if (ys[i] != null) return now - tsFull[i] > ENDED_SEC;
    return true;
  };
  const rA = ended(aFull) ? { points: null }
    : P.predict(toSamples(tsFull, aFull), { now, horizon, step, reset: rst && rst.a, workDays: workingDays });
  const projA = rA.points, loA = rA.lo || null, hiA = rA.hi || null;
  let projB, loB = null, hiB = null;
  const ratio = projA ? consumptionRatio(aFull, bFull) : null;
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
function applyRangeAll() { applyRange(C); applyRange(K); applyRange(X); }

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



function countdown(iso) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "resetting…";
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 1) return `${d}d ${h % 24}h`;
  if (h >= 1) return `${h}h ${m % 60}m`;
  return `${m}m`;
}



// Trailing-window burn rate in %-points/hour for the gauge. Clamped to 0 so an
// idle stretch or a post-reset dip reads as "stopped", not negative.
// The meters move in whole points, so at a slow burn most short windows hold no
// change at all (2 %/h is one tick per 30 min) and a plain slope reads 0 between
// ticks. When the short window can't see two points of rise, measure the spacing
// of the recent ticks instead, looking back up to 12× as far.
function burnRate(tsArr, yArr, nowSec, lookbackSec = 300) {
  const maxBack = 12 * lookbackSec;
  let pts = [];
  for (let i = 0; i < tsArr.length; i++)
    if (yArr[i] != null && tsArr[i] >= nowSec - maxBack) pts.push([tsArr[i], yArr[i]]);
  let start = 0;                                          // this cycle only: cut at a reset dip
  for (let i = 1; i < pts.length; i++) if (pts[i][1] < pts[i - 1][1] - 5) start = i;
  pts = pts.slice(start);
  const short = pts.filter((p) => p[0] >= nowSec - lookbackSec);
  if (short.length && short[short.length - 1][1] - short[0][1] >= 2) {
    const slope = recentSlope(pts, lookbackSec, nowSec);   // %/sec or null
    return slope == null ? 0 : Math.max(0, slope * 3600);  // %/hour
  }
  return tickRate(pts, nowSec, maxBack) * 3600;
}

// %/sec from the spacing of whole-point steps: the rise after the first step over
// the time between first and last. Never more than the last step spread over the
// time since it, so the needle winds down once you stop instead of holding.
function tickRate(pts, nowSec, maxBack) {
  const steps = [];
  for (let i = 1; i < pts.length; i++)
    if (pts[i][1] > pts[i - 1][1]) steps.push([pts[i][0], pts[i][1] - pts[i - 1][1]]);
  if (!steps.length) return 0;
  const last = steps[steps.length - 1];
  const rate = steps.length >= 2
    ? steps.slice(1).reduce((a, s) => a + s[1], 0) / Math.max(1, last[0] - steps[0][0])
    : last[1] / maxBack;                                  // one step: no spacing to read yet
  return Math.min(rate, last[1] / Math.max(1, nowSec - last[0]));
}


// ---- Claude rendering ----
function renderClaude(st, s) {
  st.last = s;
  if (s.resets) st.resets = s.resets;
  if (st === K) showClaude2();
  const sl = scopedLimit(st);
  const wk = sl ? sl.percent : s.sd;
  // Plans without a 5-hour limit (Ultra, since Nov 2026) get five_hour: null.
  $(st.p + "fhCell").hidden = !hasFiveHour(st);
  if (X.last && X.ghostFor !== claudeHasFiveHour()) renderCodex(X.last);   // re-align its rows
  meter(st.p + "fh").used(s.fh, st.resets.five_hour);
  meter(st.p + "sd").used(wk, sl ? sl.resets_at : st.resets.seven_day);
  paintScope(st, sl);
  renderClaudeResets(st);
  renderClaudeForecast(st);
}

// Whether this account still has a 5-hour limit. Without one the API reports
// five_hour as null, and the 7-day window is the only one that can stop you.
function hasFiveHour(st) {
  return !!(st.last && (st.last.fh != null || (st.resets && st.resets.five_hour)));
}

function claudeHasFiveHour() {
  return [C, K].some((st) => st.last && hasFiveHour(st));
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
  const was = shownClaudes();
  $("colClaude").hidden = cli;
  $("k_colClaude").hidden = !cli;
  // The column coming into view was skipped while hidden: bring it up to date.
  for (const st of shownClaudes()) if (!was.includes(st)) { applyRange(st); renderClaudeForecast(st); }
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

function renderClaudeResets(st) {
  meter(st.p + "fh").reset(st.resets.five_hour);
  const sl = scopedLimit(st);
  meter(st.p + "sd").reset(sl ? sl.resets_at : st.resets.seven_day);
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

// The forecast reads the SAME trajectory the chart draws, so the meter and the
// curve above it can never disagree.
function renderClaudeForecast(st) {
  if (!st.last) return;
  // A model-scoped weekly limit has no stored history: straight-line pace.
  const sl = scopedLimit(st);
  if (sl) {
    const p = forecast(sl.percent, 7 * 24 * 3600e3, sl.resets_at, null);
    showOutlook(st.p + "sd", sl.percent, p, () => projectedAtReset(sl.percent, 7 * 24 * 3600e3, sl.resets_at, null));
  }
  for (const w of CLAUDE_WIN.filter((w) => w.key === "fh" || (w.key === "sd" && !sl))) {
    const cur = st.last[w.key];
    if (cur == null) continue;
    const resetIso = st.resets[w.reset];
    const samples = (w.series && resetIso)
      ? cycleSamples(st.data, w.series, new Date(resetIso).getTime(), w.winMs) : null;
    const proj = windowProjection(st, w.col, resetIso, colReset(st, w.col));
    const p = (proj && forecastFromPoints(cur, w.winMs, resetIso, proj))
      || forecast(cur, w.winMs, resetIso, samples);
    showOutlook(st.p + w.key, cur, p, () => projectedAtReset(cur, w.winMs, resetIso, samples));
  }
}

// ---- Codex rendering ----
// Fixed slots mirroring Claude's dials: 5-hour first, 7-day second. A window with
// no data leaves an invisible ghost so both columns line up dial-for-dial.
const CX_SLOTS = [
  { label: "5-hour", id: "cx5" },
  { label: "7-day",  id: "cx7" },
];

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
  X.ghostFor = claudeHasFiveHour();
  for (const slot of CX_SLOTS) {
    const w = wins.find((x) => x.label === slot.label);
    // Keep the slot's place so the dials line up with Claude's, but only while
    // Claude has a dial there: without a 5-hour limit its 7-day comes first.
    $(slot.id + "Cell").hidden = !w && slot.label === "5-hour" && !claudeHasFiveHour();
    $(slot.id + "Cell").classList.toggle("placeholder", !w);
    if (!w) continue;
    meter(slot.id).used(w.used_percent, w.reset_at);
  }
  // Any window without a slot gets a plain row under the chart.
  const odd = wins.filter((w) => !CX_SLOTS.some((slot) => slot.label === w.label) && w.used_percent != null);

  // Hide the model-specific "Spark" feature limit — it's usually 0% and not a real cap.
  const add = (s.additional || []).filter((a) => a.used_percent != null && !/spark/i.test(a.label || ""));
  $("cxScoped").innerHTML = [...odd, ...add].map((a) =>
    `<div class="row"><span>${a.label}</span><b>${Math.round(a.used_percent)}%</b></div>`).join("");

  renderCodexForecast();
}

function renderCodexForecast() {
  if (!X.last) return;
  const idxByLabel = { "5-hour": 1 };   // only the 5-hour uses recent-rate; 7-day averages
  const colByLabel = { "5-hour": 1, "7-day": 2 };   // which charted series the window is
  for (const slot of CX_SLOTS) {
    const w = (X.last.windows || []).find((x) => x.label === slot.label);
    if (!w) continue;
    const idx = idxByLabel[w.label] || null;
    const col = colByLabel[w.label] || null;
    const winMs = (w.window_seconds || 0) * 1000;
    const samples = (idx && w.reset_at)
      ? cycleSamples(X.data, idx, new Date(w.reset_at).getTime(), winMs) : null;
    const proj = windowProjection(X, col, w.reset_at, colReset(X, col));
    const p = (proj && forecastFromPoints(w.used_percent, winMs, w.reset_at, proj))
      || forecast(w.used_percent, winMs, w.reset_at, samples);
    showOutlook(slot.id, w.used_percent, p, () => projectedAtReset(w.used_percent, winMs, w.reset_at, samples));
  }
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
  document.querySelectorAll('[data-sync="range"]').forEach((g) =>
    g.querySelectorAll("button").forEach((b) =>
      b.classList.toggle("on", !views[g.dataset.p] && b.dataset.r === ranges[g.dataset.p])));
}

function wireRange() {
  paintRange();
  document.querySelectorAll('[data-sync="range"]').forEach((g) =>
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
    plugins: [offlineBands(false), nowDivider()],
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

// The window as drawn, in px. A 24h view over months of history is only a few
// pixels across: too small to see or grab, so it's drawn at least OV_MIN_PX
// wide, centred on the real range.
const OV_MIN_PX = 16;
function windowBox(st) {
  const u = st.ov, v = viewOf(st);
  if (!u || !v) return null;
  const l = u.valToPos(v.min, "x"), r = u.valToPos(v.max, "x");
  const c = (l + r) / 2, half = Math.max((r - l) / 2, OV_MIN_PX / 2);
  return { l: c - half, r: c + half };
}

function paintWindow(st) {
  paintSpan(st);
  if (!st.ovWin) return;
  const b = windowBox(st);
  st.ovWin.hidden = !b;
  if (!b) return;
  st.ovWin.style.left = b.l + "px";
  st.ovWin.style.width = b.r - b.l + "px";
}

// What the chart is showing, under the strip: the preset's name, or after a drag
// the dates it spans.
const SPAN_NAMES = { "24h": "Last 24 hours", "7d": "Last 7 days", "14d": "Last 2 weeks", "30d": "Last 30 days" };
function paintSpan(st) {
  const el = $(st === X ? "cxChartSpan" : st.p + "chartSpan"), v = viewOf(st);
  if (!el || !v) return;
  const p = provOf(st);
  if (!views[p]) {
    const first = firstReal(st);
    el.textContent = SPAN_NAMES[ranges[p]] || (first ? `Since ${fmtSpanEnd(first, true)}` : "");
    return;
  }
  const sec = v.max - v.min, days = sec >= 2 * 86400;
  el.textContent = `${fmtSpanEnd(v.min, days)} – ${fmtSpanEnd(v.max, days)} · ` +
    (days ? `${Math.round(sec / 86400)} days` : `${Math.max(1, Math.round(sec / 3600))} h`);
}
function fmtSpanEnd(t, dateOnly) {
  const d = new Date(t * 1000);
  const day = d.toLocaleDateString([], { month: "short", day: "numeric" });
  return dateOnly ? day : `${day} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
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
    const b = windowBox(st);
    if (!b) return null;
    // The middle always moves it: on a narrow box the edge zones would
    // otherwise cover all of it, and grabbing it would resize instead. The
    // edges then reach outward, so a narrow window can still be resized.
    const inner = Math.min(EDGE, (b.r - b.l) / 4);
    if (x >= b.l + inner && x <= b.r - inner) return "move";
    if (Math.abs(x - b.l) <= EDGE) return "l";
    if (Math.abs(x - b.r) <= EDGE) return "r";
    return "jump";
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
// Kept server-side: the broadcast comes back and applies it everywhere,
// including the floating pill.
function setForecastModel(provider, m) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ set_forecast_model: m, provider }));
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

// Samples are stored as they arrive but drawn once per frame, from the newest.
// The menu-bar panel's page is paused while closed and its socket delivers the
// whole backlog the moment it opens: drawing each sample — a forecast recompute
// apiece, a frame in between — played back the hours it missed like a fast-forward.
const pending = {};
let drawQueued = false;
function drawSamplesSoon() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    const p = { ...pending };
    for (const k in pending) delete pending[k];
    if (p.quiet) quietly();
    if (p.claude) renderClaude(C, p.claude);
    if (p.claude2) renderClaude(K, p.claude2);
    if (p.codex) renderCodex(p.codex);
    applyRangeAll();
    if (p.quiet) updateGauges();
    setStatus(p.status);
  });
}

// ---- websocket ----
let ws = null, backoff = 500;
let bootVersion = null;   // the version this page's own scripts came from
// ---- API-equivalent spend (Claude Code + Codex token logs priced at list rates) ----
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

// One range drives the whole card: the total, the Claude/Codex split and the
// chat list. Its key is both the snapshot's total field and its chats key.
const CC_RANGES = {
  d1: { total: "d1", label: "last 24 hours", short: "Last 24h" },
  d7: { total: "d7", label: "last 7 days", short: "Last 7 days" },
  d30: { total: "d30", label: "last 30 days", short: "Last 30 days" },
  all: { total: "total", label: "all time", short: "All time" },
};
const CC_SHOWN = 6;                    // chats listed before "Show more"
let ccRange = CC_RANGES[localStorage.getItem("ccRange")] ? localStorage.getItem("ccRange") : "d7";
let ccExpanded = false;
const ccOpen = new Set();              // chats whose detail line is unfolded, by key

const ccEsc = (t) => { const d = document.createElement("div"); d.textContent = t == null ? "" : String(t); return d.innerHTML; };
const ccKey = (r) => r.src + "|" + r.when + "|" + r.label;

function renderCost() {
  if (!ccClaude && !ccCodex) return;
  $("ccost").hidden = false;
  const provs = [["Claude", "cl", ccClaude], ["Codex", "cx", ccCodex]].filter((p) => p[2]);
  const tot = (r) => provs.reduce((a, [, , p]) => a + (p[CC_RANGES[r].total] || 0), 0);
  const R = CC_RANGES[ccRange];
  const sum = tot(ccRange);

  $("ccRange").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.r === ccRange));
  $("ccBig").textContent = fmtMoney(sum);
  $("ccBigK").textContent = `${R.label} at API list rates`;

  // The split bar doubles as the colour legend for the chat list.
  const parts = provs.map(([name, cls, p]) => ({ name, cls, v: p[R.total] || 0 }));
  $("ccSplit").hidden = provs.length < 2;
  $("ccSplit").innerHTML = sum > 0
    ? parts.filter((x) => x.v > 0).map((x) => `<div class="${x.cls}" style="flex:${x.v}"></div>`).join("")
    : "";
  $("ccProv").innerHTML = parts.map((x) =>
    `<div class="cc-prov"><span class="cc-sw ${x.cls}"></span>${x.name}<b>${fmtMoney(x.v)}</b>` +
    (provs.length > 1 ? `<span class="pc">${sum > 0 ? Math.round((100 * x.v) / sum) : 0}%</span>` : "") +
    `</div>`).join("");
  $("ccOther").innerHTML = Object.keys(CC_RANGES).filter((r) => r !== ccRange).map((r) =>
    `<div><span>${CC_RANGES[r].short}</span><b>${fmtMoney(tot(r))}</b></div>`).join("");

  renderChats(provs);
}

// The priciest chats last used in the range, both providers in one list. Each
// row is the chat's whole cost, so a long thread counts in full in every range
// it touched.
function renderChats(provs) {
  const R = CC_RANGES[ccRange];
  let n = 0;
  const rows = [];
  for (const [name, cls, p] of provs) {
    const c = p.chats && p.chats[ccRange];
    if (!c) continue;
    n += c.n || 0;
    for (const r of c.rows || []) rows.push({ ...r, src: name, cls });
  }
  rows.sort((a, b) => b.cost - a.cost);
  $("ccCount").textContent = !n ? "" : ccRange === "all"
    ? `${n.toLocaleString()} chats`
    : `${n.toLocaleString()} ${n === 1 ? "chat" : "chats"} used in the ${R.label}`;
  if (!rows.length) {
    $("ccRows").innerHTML = `<div class="cc-empty muted">No chats in the ${R.label}</div>`;
    $("ccMore").hidden = true;
    return;
  }
  const shown = ccExpanded ? rows : rows.slice(0, CC_SHOWN);
  const max = rows[0].cost || 1;
  $("ccRows").innerHTML = shown.map((r) => {
    // Claude Code titles newer sessions itself; older ones and every Codex
    // session have none, so the working directory stands in.
    const sub = [r.title ? r.label : null, r.branch, modelShort(r.model)].filter(Boolean);
    const key = ccKey(r);
    return `<div class="cc-row${ccOpen.has(key) ? " open" : ""}" data-k="${ccEsc(key)}">` +
      `<span class="cc-sw ${r.cls}"></span>` +
      `<div class="cc-txt"><div class="t">${ccEsc(r.title || r.label)}</div>` +
      `<div class="s">${ccEsc(sub.join(" · "))}</div>` +
      `<div class="x">${ccEsc(chatDetail(r))}</div></div>` +
      `<div class="bar"><i class="cc-sw ${r.cls}" style="width:${Math.max(2, (100 * r.cost) / max)}%"></i></div>` +
      `<div class="c">${fmtMoney(r.cost)}</div>` +
      `<div class="w" title="last used">${ccEsc(ccDay(r.end || r.when))}</div></div>`;
  }).join("");
  const more = $("ccMore");
  more.hidden = rows.length <= CC_SHOWN;
  more.textContent = ccExpanded ? "Show fewer" : `Show ${rows.length - CC_SHOWN} more`;
}

function ccDay(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return "";
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function chatDetail(r) {
  const at = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false });
  const out = [];
  if (r.when) out.push("started " + at(r.when));
  if (r.when && r.end) out.push("ran for " + fmtDur((new Date(r.end) - new Date(r.when)) / 1000));
  if (r.calls) out.push(r.calls.toLocaleString() + " API calls");
  if (r.pct) out.push(r.pct.toFixed(1) + "% of all " + r.src + " spend");
  return out.join(" · ");
}

function wireCost() {
  const seg = $("ccRange");
  if (!seg) return;
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || !CC_RANGES[b.dataset.r]) return;
    ccRange = b.dataset.r;
    ccExpanded = false;
    localStorage.setItem("ccRange", ccRange);
    renderCost();
  });
  $("ccMore").addEventListener("click", () => { ccExpanded = !ccExpanded; renderCost(); });
  // A click unfolds the chat's detail line; toggled in place, no re-render.
  $("ccRows").addEventListener("click", (e) => {
    const row = e.target.closest(".cc-row");
    if (!row) return;
    const k = row.dataset.k;
    if (ccOpen.has(k)) ccOpen.delete(k); else ccOpen.add(k);
    row.classList.toggle("open", ccOpen.has(k));
  });
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
  const chk = $("checkUpdate");                   // either button starts it: lock both
  if (chk) { chk.dataset.busy = "1"; chk.disabled = true; }
  msg.textContent = "Updating… the app will restart in a moment.";
  try {
    const r = await fetch("/api/update", { method: "POST" });
    // 409: another page or button already started it — wait on that one.
    if (!r.ok && r.status !== 409) {   // nothing to apply (e.g. 400)
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
      for (const k in pending) delete pending[k];   // superseded by this snapshot
      loadHistory(m.history || []);
      offline = (m.offline || []).map(([a, b]) => [a / 1000, b / 1000]);   // drawn just below
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
      scoreForecasts();
      reveal();
      refreshIfBehind();                    // e.g. reconnected after the Mac slept
    } else if (m.type === "sample") {
      // A refresh landing, or the backlog a paused page drains on waking: put it
      // up as it stands rather than animate through each step.
      if (refreshUntil || Date.now() - sampleTs(m) > CATCHUP_AGE_MS) pending.quiet = true;
      refreshUntil = 0;
      if (m.claude) { appendPoint(C, m.claude.ts / 1000, m.claude.fh, m.claude.sd); pending.claude = m.claude; }
      if (m.claude2) { appendPoint(K, m.claude2.ts / 1000, m.claude2.fh, m.claude2.sd); pending.claude2 = m.claude2; }
      if (m.codex) { appendPoint(X, m.codex.ts / 1000, m.codex.cp, m.codex.cs); pending.codex = m.codex; }
      pending.status = m.status;
      drawSamplesSoon();
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
    } else if (m.type === "offline") {
      setOffline(m.offline);
    } else if (m.type === "interval") {
      setIntervalUI(m.interval);
    }
  };
}

// ---- 1-second tick: keep countdowns + forecasts fresh ----
// ---- usage meters: one per window ----
// A bar in blocks: what's used, the next hour at the current burn rate, the
// rest of the forecast to the reset (red when it runs out first) and what's left
// at the reset. Every block explains itself on hover or focus.
const CLAUDE_MAX = 100;   // %/h full scale for a 5-hour window
const CODEX_MAX = 8;      // %/h full scale for a 7-day window (its rate is inherently small)
const SCALES = {          // window → full scale, the green|amber and amber|red stops, and how far back the rate looks
  5:   { max: CLAUDE_MAX, zones: [0.3, 0.6], lookback: 5 * 60, over: "the last few minutes" },
  168: { max: CODEX_MAX, zones: [1 / 3, 2 / 3], lookback: 168 * 60, over: "the last few hours" },
};
const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;
const SMOKERS = new Set();   // each meter's puff timer, run from one animation loop
function smokeLoop(now) { for (const f of SMOKERS) f(now); requestAnimationFrame(smokeLoop); }
const METERS = new Map();   // "fh", "k_sd", "cx7", … → meter
const NO_METER = { used() {}, outlook() {}, rate() {}, reset() {} };
const meter = (key) => METERS.get(key) || NO_METER;
const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const RESET_ICON = `<svg class="cd-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg>`;

function makeMeter(key, color, label, provider) {
  const el = $(key + "Meter");
  if (!el) return;
  // Amber (Claude 5-hour) is too light for white numbers on it.
  el.innerHTML = `<div class="meter${color === "--fh" ? " light-m" : ""}" style="--m:var(${color})" role="group" aria-label="${label} limit">
      <div class="m-seg m-used" data-part="used" tabindex="0"><span class="m-lbl"></span></div>
      <div class="m-seg m-rate" data-part="rate" tabindex="0"><span class="m-lbl"></span></div>
      <div class="m-seg m-fc" data-part="fc" tabindex="0"><span class="m-lbl"></span></div>
      <div class="m-seg m-left" data-part="left" tabindex="0"><span class="m-cd">${RESET_ICON}<span></span></span></div>
    </div><div class="m-tip" role="tooltip" hidden></div>`;
  const smoke = document.createElement("div");
  smoke.className = "m-smoke";
  el.append(smoke);
  const bar = el.querySelector(".meter"), tip = el.querySelector(".m-tip");
  const seg = (part) => bar.querySelector(`[data-part="${part}"]`);
  const usedEl = seg("used"), fcEl = seg("fc"), leftEl = seg("left"), rateEl = seg("rate");
  // The countdown sits in the grey block; when that's too narrow it moves above
  // the bar's right end (the cell's own reset line).
  const cdEl = leftEl.querySelector(".m-cd"), outEl = $(key + "Reset");
  if (outEl) outEl.innerHTML = `${RESET_ICON}<span></span>`;
  const st = { used: null, reset: null, atReset: null, over: false, hitMs: null, note: "", rate: null, hours: 168 };

  // Each block is its share of the bar; a block with nothing in it drops out.
  const paint = () => {
    const u = Math.max(0, Math.min(100, st.used ?? 0));
    const f = st.over ? 100 : st.atReset == null ? u : Math.max(u, Math.min(100, st.atReset));
    const r = st.rate == null ? 0 : Math.min(100 - u, st.rate);   // one hour at this pace
    const end = Math.max(f, u + r);
    usedEl.style.width = u + "%";
    rateEl.style.width = r + "%";
    fcEl.style.width = (end - u - r) + "%";
    leftEl.style.width = (100 - end) + "%";
    usedEl.classList.toggle("empty", u < 0.5);
    rateEl.classList.toggle("empty", r < 0.3);
    fcEl.classList.toggle("empty", end - u - r < 0.5);
    leftEl.classList.toggle("empty", 100 - end < 0.5);
    fcEl.classList.toggle("over", st.over);
    const shown = [usedEl, rateEl, fcEl, leftEl].filter((e) => !e.classList.contains("empty"));
    for (const e of [usedEl, rateEl, fcEl, leftEl]) {
      e.classList.toggle("first", e === shown[0]);
      e.classList.toggle("last", e === shown[shown.length - 1]);
    }
    usedEl.firstChild.textContent = st.used == null ? "" : `${Math.round(st.used)}%`;
    fcEl.firstChild.textContent = st.over || st.atReset == null ? "" : `${Math.round(st.atReset)}%`;
    rateEl.firstChild.textContent = st.rate == null ? "" : fmtRate(st.rate);
    // A number only shows where its block can hold it (hover tells the rest).
    const W = bar.clientWidth || 300, px = (pct) => (pct / 100) * W;
    usedEl.classList.toggle("tight", px(u) < 40);
    fcEl.classList.toggle("tight", px(end - u - r) < 40);
    rateEl.classList.toggle("tight", px(r) < 56);
    paintReset(px(100 - end));
  };
  let leftPx = 0;
  const paintReset = (w = leftPx) => {
    leftPx = w;
    const txt = st.reset ? countdown(st.reset) : "";
    cdEl.lastChild.textContent = txt;
    const fits = txt !== "" && w - 2 >= cdEl.offsetWidth + 4;
    cdEl.style.visibility = fits ? "" : "hidden";   // not display:none, so it can still be measured
    if (outEl) {
      outEl.lastChild.textContent = txt;
      outEl.hidden = fits || txt === "";
      outEl.setAttribute("aria-label", txt ? `resets in ${txt}` : "");
    }
    leftEl.setAttribute("aria-label", txt ? `resets in ${txt}` : "");
  };

  // A fast burn smokes: puffs rise off the rate block, thicker past full scale.
  let heat = 0, lastPuff = 0;          // 0 calm, 1 in the red, 2 past full scale
  const puff = () => {
    const b = rateEl.classList.contains("empty") ? usedEl : rateEl;
    const br = bar.getBoundingClientRect(), r = b.getBoundingClientRect();
    const p = document.createElement("i");
    p.style.left = (r.left - br.left + Math.random() * Math.max(8, r.width) - 7).toFixed(1) + "px";
    p.style.setProperty("--dx", (Math.random() * 14 - 7).toFixed(1) + "px");
    p.addEventListener("animationend", () => p.remove());
    smoke.append(p);
  };
  SMOKERS.add((now) => {
    if (!heat || now - lastPuff < (heat > 1 ? 120 : 260)) return;
    lastPuff = now;
    puff();
  });
  new ResizeObserver(paint).observe(bar);

  const resetsIn = () => (st.reset ? ` It resets in ${countdown(st.reset)}.` : "");
  const hoursLeft = () => (st.reset ? (new Date(st.reset).getTime() - Date.now()) / 3600e3 : null);
  const tips = {
    used: () => [`Used · ${Math.round(st.used ?? 0)}%`,
      `How much of your ${label} limit you've used since it last reset.`],
    fc: () => st.over
      ? [`Runs out in ${fmtDur((st.hitMs - Date.now()) / 1000)}`,
         `At the forecast pace you reach 100% ${fmtDur((new Date(st.reset).getTime() - st.hitMs) / 1000)} before the limit resets.`]
      : [`Forecast · ${Math.round(st.atReset)}% at reset`,
         `About ${Math.max(0, Math.round(st.atReset - st.used))}% more before the reset. The model below makes this forecast and the dashed line on the chart.`],
    left: () => st.atReset == null || st.over
      ? [`Unused · ${Math.round(100 - (st.used ?? 0))}%`, `What's still free of your ${label} limit right now.${resetsIn()}`]
      : [`Left at reset · ${Math.round(100 - st.atReset)}%`,
         `What should still be unused when the limit resets.${resetsIn()}`],
    rate: () => {
      const h = hoursLeft(), sc = SCALES[st.hours] || SCALES[168];
      const pace = h > 0 ? (100 - (st.used ?? 0)) / h : null;
      return [`Burn rate · ${fmtRate(st.rate)}`,
        `What you'd add in the next hour if you keep going like this, measured over ${sc.over}.` +
        (pace != null ? ` Staying under ${fmtRate(pace)} lasts until the reset.` : "")];
    },
  };
  // The forecast's tooltip carries the model picker (and so does what's left
  // while there is no forecast block to hover, e.g. just after a reset).
  const models = () => `<div class="seg seg-sm m-models" data-p="${provider}" data-sync="model">` +
    FORECAST_MODELS.map((m) =>
      `<button data-m="${m}" class="${m === forecastModels[provider] ? "on" : ""}">${MODEL_NAMES[m]}</button>`).join("") + `</div>`;
  let hideTimer = null;
  const hide = () => { clearTimeout(hideTimer); hideTimer = setTimeout(() => { tip.hidden = true; }, 220); };
  const keep = () => clearTimeout(hideTimer);
  const show = (part, target) => {
    keep();
    if (!tips[part] || (part === "fc" && !st.over && st.atReset == null) || (part === "rate" && st.rate == null)) { tip.hidden = true; return; }
    const [title, text] = tips[part]();
    const picker = part === "fc" || (part === "left" && st.atReset == null && !st.over);
    tip.innerHTML = `<div class="tip-t">${escHtml(title)}</div><div class="tip-x">${escHtml(text)}</div>` + (picker ? models() : "");
    tip.classList.toggle("interactive", picker);
    tip.hidden = false;
    // Centred over the block, kept inside the meter's width.
    const br = bar.getBoundingClientRect(), tr = target.getBoundingClientRect();
    const w = tip.offsetWidth, mid = tr.left + tr.width / 2 - br.left;
    tip.style.left = Math.max(0, Math.min(br.width - w, mid - w / 2)) + "px";
    // Above the bar, unless that would run off the top of the window (the menu-bar
    // panel opens with the meters near its top edge): then below it.
    tip.classList.toggle("below", br.top - tip.offsetHeight - 8 < 0);
  };
  bar.addEventListener("pointerover", (e) => { const t = e.target.closest("[data-part]"); if (t) show(t.dataset.part, t); });
  bar.addEventListener("focusin", (e) => { const t = e.target.closest("[data-part]"); if (t) show(t.dataset.part, t); });
  // Leaving the bar gives the pointer a moment to cross onto the tooltip.
  bar.addEventListener("pointerleave", hide);
  bar.addEventListener("focusout", (e) => { if (!tip.contains(e.relatedTarget)) hide(); });
  tip.addEventListener("pointerenter", keep);
  tip.addEventListener("pointerleave", hide);
  tip.addEventListener("focusout", (e) => { if (!tip.contains(e.relatedTarget) && !bar.contains(e.relatedTarget)) hide(); });
  tip.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-m]");
    if (b) setForecastModel(provider, b.dataset.m);
  });

  METERS.set(key, {
    used(pct, resetIso) { st.used = pct; st.reset = resetIso || null; paint(); },
    // Re-reads the countdown (every tick); a new reset time can come with it.
    reset(resetIso) { if (resetIso !== undefined) st.reset = resetIso || null; paintReset(); },
    // atReset: % used at the reset (null when unknown); hitMs: when it reaches 100% first.
    outlook(atReset, hitMs) { st.over = hitMs != null; st.hitMs = hitMs; st.atReset = atReset; paint(); },
    // rate: true %/h (null hides it); hours picks the scale its colour is read on.
    rate(rate, hours) {
      st.rate = rate; st.hours = hours;
      const sc = SCALES[hours] || SCALES[168], f = (rate || 0) / sc.max;
      heat = REDUCED_MOTION || rate == null ? 0 : f > 1 ? 2 : f >= sc.zones[1] ? 1 : 0;
      paint();
    },
  });
}

const fmtRate = (r) => `${(r || 0).toFixed(r < 10 ? 1 : 0)}%/h`;

// The forecast for a meter, and the note beside it. `p` is the forecast row's
// verdict; a straight-line fallback verdict has no numbers, so `fallback()` supplies one.
function showOutlook(key, cur, p, fallback) {
  const el = $(key + "Fc");
  if (!el) return;
  let text = "", warn = false, atReset = p && p.atReset, hitMs = p && p.hitMs != null ? p.hitMs : null;
  if (hitMs != null) {
    text = `runs out in ${fmtDur((hitMs - Date.now()) / 1000)}`; warn = true;
  } else if (p && p.cls === "warn") {
    text = p.msg.replace(/ \(.*$/, ""); warn = true;          // "at the limit", "hits 100% in 3h"
    if (cur < 99.5) hitMs = Date.now() + 1;                    // fallback verdict: red, no time
  } else if (p && p.cls === "muted") {
    text = p.msg.split(" · ")[0]; atReset = null;              // "just reset — gathering data…"
  } else if (p && atReset == null) {
    atReset = fallback();
  }
  el.textContent = text;
  el.className = "dial-sub " + (warn ? "warn" : "muted");
  meter(key).outlook(atReset ?? null, cur >= 99.5 ? null : hitMs);
}

// Each meter shows its own window's burn rate.
function updateGauges() {
  const now = Date.now() / 1000;
  for (const st of CLAUDES) {
    meter(st.p + "fh").rate(burnRate(st.data[0], st.data[1], now, SCALES[5].lookback), 5);
    // A model-scoped weekly limit has no stored history, so no rate of its own.
    meter(st.p + "sd").rate(scopedLimit(st) ? null : burnRate(st.data[0], st.data[2], now, SCALES[168].lookback), 168);
  }
  meter("cx5").rate(burnRate(X.data[0], X.data[1], now, SCALES[5].lookback), 5);
  meter("cx7").rate(burnRate(X.data[0], X.data[2], now, SCALES[168].lookback), 168);
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
  for (const st of shownClaudes()) renderClaudeForecast(st);
  renderCodexForecast();
  updateGauges();
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
  // Hidden (a closed menu-bar panel, a background tab): do nothing. The first tick
  // after it shows again sees the gap and catches up, as after a real pause.
  if (document.hidden) return;
  const now = Date.now(), paused = now - lastTick > PAUSE_GAP_MS;
  lastTick = now;
  if (paused) resync(); else checkStale();
  for (const st of shownClaudes()) { renderClaudeResets(st); renderClaudeForecast(st); }
  for (const slot of CX_SLOTS) meter(slot.id).reset();
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
  wireAccuracy();
  wireSettings();
  wireChangelog();
  wireCost();
  wireUpdate();
  wireCheckUpdate();
  for (const st of CLAUDES) {
    makeMeter(st.p + "fh", "--fh", "5-hour", "claude");
    makeMeter(st.p + "sd", "--sd", "7-day", "claude");
  }
  makeMeter("cx5", "--cx1", "5-hour", "codex");
  makeMeter("cx7", "--cx2", "7-day", "codex");
  requestAnimationFrame(smokeLoop);
  connect();
  // Never stay hidden: if the server is down there is still a status to show.
  setTimeout(reveal, 1500);
  setInterval(tick, 1000);
});
