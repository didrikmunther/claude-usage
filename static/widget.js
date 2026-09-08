"use strict";

// The floating pill: one signed number per platform, nothing else.
//
//   <claude mark> -2.2d      <codex mark> +5.4h
//
// The number is the margin (see windowMargin in forecast.js): how long before
// the reset you run out (negative, red), or how much slack the reset gives you
// (positive, green). Per platform it is the WORST of that platform's windows —
// the one actually constraining you — so a 5-hour crunch can't hide behind a
// comfortable weekly number.
//
// It keeps the same rolling sample buffers the dashboard does, because the pace
// behind the margin needs this cycle's samples; the live payload alone only
// carries the current percentage.

const WS_URL = `ws://${location.host}/ws`;
const MAX_POINTS = 20000;

// series = index into C.data for the recent-rate method (null → cycle average).
const CLAUDE_WIN = [
  { key: "fh", reset: "five_hour", winMs: 5 * 3600e3, series: 1 },
  { key: "sd", reset: "seven_day", winMs: 7 * 24 * 3600e3, series: null },
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

// Smallest margin across a platform's windows — the binding constraint. null
// when no window has anything trustworthy to say yet.
function worst(margins) {
  const known = margins.filter((m) => m != null);
  return known.length ? Math.min(...known) : null;
}

function claudeMargin() {
  if (!C.last) return null;
  return worst(CLAUDE_WIN.map((w) => {
    const resetIso = C.resets[w.reset];
    const samples = (w.series && resetIso)
      ? cycleSamples(C.data, w.series, new Date(resetIso).getTime(), w.winMs) : null;
    return windowMargin(C.last[w.key], w.winMs, resetIso, samples);
  }));
}

function codexMargin() {
  if (!X.last) return null;
  return worst((X.last.windows || []).map((w) => {
    const idx = CX_SERIES[w.label] || null;
    const winMs = (w.window_seconds || 0) * 1000;
    const samples = (idx && w.reset_at)
      ? cycleSamples(X.data, idx, new Date(w.reset_at).getTime(), winMs) : null;
    return windowMargin(w.used_percent, winMs, w.reset_at, samples);
  }));
}

function paint(el, ms) {
  const txt = fmtMargin(ms);
  el.textContent = txt == null ? "–" : txt;
  el.classList.toggle("bad", txt != null && ms < 0);
  el.classList.toggle("good", txt != null && ms >= 0);
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
  paint($("cVal"), claudeMargin());
  paint($("xVal"), codexMargin());
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
