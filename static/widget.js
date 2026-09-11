"use strict";

// The floating pill: one signed number per platform, nothing else.
//
//   <claude mark> -2.2d      <codex mark> +5.4h
//
// Two readings, depending on which way the window is going:
//   heading over  → "-2.2d" in red: you run out this long BEFORE the reset
//   staying under → "32%" in green: what you will have used when it resets
// The duration only carries information when you are going to overrun; once you
// are safe, the useful question is how much of the limit you will have spent.
// Per platform it is the WORST of that platform's windows — the one actually
// constraining you — so a 5-hour crunch can't hide behind a comfortable weekly
// number.
//
// It keeps the same rolling sample buffers the dashboard does, because the pace
// behind the margin needs this cycle's samples; the live payload alone only
// carries the current percentage.

const WS_URL = `ws://${location.host}/ws`;
const MAX_POINTS = 20000;

// series = index into C.data for the recent-rate method (null → cycle average).
const CLAUDE_WIN = [
  { key: "fh", reset: "five_hour", winMs: 5 * 3600e3, series: 1, label: "5h", col: 1 },
  { key: "sd", reset: "seven_day", winMs: 7 * 24 * 3600e3, series: null, label: "7d", col: 2 },
];
const CX_SERIES = { "5-hour": 1 };        // only Codex's 5-hour uses the recent rate
const CX_COL = { "5-hour": 1, "7-day": 2 };   // which charted series the window is

// One window's outlook. Read off the predictor's trajectory when there is one,
// so the pill agrees with the dashboard; the straight-line pace is the fallback
// for windows the chart never plots.
function outlook(cur, winMs, resetIso, samples, proj) {
  const t = proj && forecastFromPoints(cur, winMs, resetIso, proj);
  if (t && t.atReset != null) {
    // Same sign convention as windowMargin: negative means you hit 100% before
    // the reset. No crossing means the reset saves you, so the margin is +inf
    // and the pill shows where you land instead.
    const resetMs = new Date(resetIso).getTime();
    return { margin: t.hitMs == null ? Infinity : t.hitMs - resetMs, pct: t.atReset };
  }
  // Windows the chart never plots, and the edge cases forecastFromPoints
  // declines (no reset yet, at the limit): keep the straight-line pace.
  return {
    margin: windowMargin(cur, winMs, resetIso, samples),
    pct: projectedAtReset(cur, winMs, resetIso, samples),
  };
}

// Which predictor to use. The server owns it, so the pill and the dashboard
// cannot disagree; this web view has no persistent storage of its own.
let forecastModel = "adaptive";
let workingDays = [0, 1, 2, 3, 4, 5, 6];   // server-owned, same as the model

// The pill re-renders every second and cycle+tod is a simulation, so the
// trajectory is cached until the data, the model or the reset moves.
const projCache = new Map();
function projection(st, col, resetIso, reset) {
  const ts = st.data[0];
  if (col == null || !resetIso || !ts.length) return null;
  const now = ts[ts.length - 1];
  const horizon = new Date(resetIso).getTime() / 1000 - now;
  if (!(horizon > 0)) return null;
  const key = `${st === C ? "c" : "x"}|${col}|${forecastModel}|${workingDays}|${now}|${resetIso}`;
  if (projCache.has(key)) return projCache.get(key);
  const P = Predictors[forecastModel] || Predictors.linear;
  let pts = null;
  try {
    pts = P.predict(toPts(ts, st.data[col]),
                    { now, horizon, step: 3600, reset, workDays: workingDays }).points;
  } catch { pts = null; }
  if (projCache.size > 8) projCache.clear();
  projCache.set(key, pts);
  return pts;
}
const toPts = (ts, ys) => ts.map((t, i) => ({ t, y: ys[i] }));

// The authoritative reset the dashboard also feeds its predictor.
const resetOverride = (iso, winSec) => {
  if (!iso || !(winSec > 0)) return null;
  const R = new Date(iso).getTime() / 1000;
  return Number.isFinite(R) ? { P: winSec, R } : null;
};

const C = { data: [[], [], []], resets: {}, last: null };
const X = { data: [[], [], []], last: null };
const $ = (id) => document.getElementById(id);

function push(st, tsSec, a, b) {
  st.data[0].push(tsSec); st.data[1].push(a); st.data[2].push(b);
  if (st.data[0].length > MAX_POINTS) {
    const cut = st.data[0].length - MAX_POINTS;
    st.data = st.data.map((s) => s.slice(cut));
  }
}

// The binding window: the one with the smallest margin. Overrunning windows sort
// worst automatically (negative beats positive), and among safe ones the tightest
// margin is also the one landing highest, so a single ordering serves both
// readings. null when no window has anything trustworthy to say yet.
function worst(rows) {
  const known = rows.filter((r) => r && r.margin != null);
  if (!known.length) return null;
  return known.reduce((a, b) => (b.margin < a.margin ? b : a));
}

function claudeOutlook() {
  if (!C.last) return null;
  return worst(CLAUDE_WIN.map((w) => {
    const resetIso = C.resets[w.reset];
    const samples = (w.series && resetIso)
      ? cycleSamples(C.data, w.series, new Date(resetIso).getTime(), w.winMs) : null;
    const cur = C.last[w.key];
    const proj = projection(C, w.col, resetIso, resetOverride(resetIso, w.winMs / 1000));
    return { ...outlook(cur, w.winMs, resetIso, samples, proj), label: w.label };
  }));
}

function codexOutlook() {
  if (!X.last) return null;
  return worst((X.last.windows || []).map((w) => {
    const idx = CX_SERIES[w.label] || null;
    const winMs = (w.window_seconds || 0) * 1000;
    const samples = (idx && w.reset_at)
      ? cycleSamples(X.data, idx, new Date(w.reset_at).getTime(), winMs) : null;
    const proj = projection(X, CX_COL[w.label] || null, w.reset_at,
                            resetOverride(w.reset_at, w.window_seconds || 0));
    return outlook(w.used_percent, winMs, w.reset_at, samples, proj);
  }));
}

function paint(el, o) {
  const over = o != null && o.margin != null && o.margin < 0;
  let txt = null;
  if (o != null && o.margin != null) {
    // Overrunning: how long before the reset you run out. Safe: where you land.
    txt = over ? fmtMargin(o.margin)
               : (o.pct == null ? null : Math.floor(o.pct) + "%");
  }
  el.textContent = txt == null ? "–" : txt;
  // Which of the platform's windows this number is about, set as a superscript.
  // Built with the DOM rather than innerHTML so the label is never parsed as markup.
  if (txt != null && o && o.label) {
    const sup = document.createElement("sup");
    sup.className = "win";
    sup.textContent = o.label;
    el.appendChild(sup);
  }
  el.classList.toggle("bad", txt != null && over);
  el.classList.toggle("good", txt != null && !over);
}

// The pill's width shifts a little as units change (40m → 5.4h → 2.2d), so the
// panel is told what to be rather than guessing. Harmless in a browser tab.
let lastW = 0, lastH = 0;
function reportSize() {
  const r = $("pill").getBoundingClientRect();
  const w = Math.ceil(r.width) + 16;          // + #root padding
  const h = Math.ceil(r.height) + 16;
  if ((w === lastW && h === lastH) || !w || !h) return;
  lastW = w; lastH = h;
  const mh = window.webkit && window.webkit.messageHandlers;
  if (mh && mh.size) mh.size.postMessage({ w, h });
}

function render() {
  paint($("cVal"), claudeOutlook());
  paint($("xVal"), codexOutlook());
  reportSize();
}

// ---- websocket (same feed as the dashboard) ----
let ws = null, backoff = 500;

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => { backoff = 500; };
  ws.onclose = () => {
    // Keep the last numbers on screen rather than blanking; they keep counting
    // down against the wall clock until fresh data lands.
    setTimeout(connect, backoff);
    backoff = Math.min(8000, backoff * 2);
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "init") {
      C.data = [[], [], []]; X.data = [[], [], []];
      for (const r of m.history || []) {
        push(C, r.ts / 1000, r.fh, r.sd);
        push(X, r.ts / 1000, r.cp, r.cs);
      }
      if (m.claude) { C.last = m.claude; if (m.claude.resets) C.resets = m.claude.resets; }
      if (m.codex) X.last = m.codex;
      if (m.forecast_model) forecastModel = m.forecast_model;
      if (m.working_days != null) workingDays = String(m.working_days).split(",").filter(Boolean).map(Number);
      render();
    } else if (m.type === "forecast_model" || m.type === "working_days") {
      if (m.forecast_model) forecastModel = m.forecast_model;
      if (m.working_days != null) workingDays = String(m.working_days).split(",").filter(Boolean).map(Number);
      projCache.clear();
      render();
    } else if (m.type === "sample") {
      if (m.claude) {
        push(C, m.claude.ts / 1000, m.claude.fh, m.claude.sd);
        C.last = m.claude;
        if (m.claude.resets) C.resets = m.claude.resets;
      }
      if (m.codex) { push(X, m.codex.ts / 1000, m.codex.cp, m.codex.cs); X.last = m.codex; }
      render();
    }
  };
}

connect();
setInterval(render, 1000);   // the margin shrinks in real time between samples
