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
  { key: "fh", reset: "five_hour", winMs: 5 * 3600e3, series: 1, label: "5h" },
  { key: "sd", reset: "seven_day", winMs: 7 * 24 * 3600e3, series: null, label: "7d" },
];
const CX_SERIES = { "5-hour": 1 };        // only Codex's 5-hour uses the recent rate

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
    return {
      margin: windowMargin(cur, w.winMs, resetIso, samples),
      pct: projectedAtReset(cur, w.winMs, resetIso, samples),
      label: w.label,           // which reset this number is about
    };
  }));
}

function codexOutlook() {
  if (!X.last) return null;
  return worst((X.last.windows || []).map((w) => {
    const idx = CX_SERIES[w.label] || null;
    const winMs = (w.window_seconds || 0) * 1000;
    const samples = (idx && w.reset_at)
      ? cycleSamples(X.data, idx, new Date(w.reset_at).getTime(), winMs) : null;
    return {
      margin: windowMargin(w.used_percent, winMs, w.reset_at, samples),
      pct: projectedAtReset(w.used_percent, winMs, w.reset_at, samples),
    };
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
