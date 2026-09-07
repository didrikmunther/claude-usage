"use strict";

// The floating widget: the dashboard's forecast sentences and nothing else.
//
// It keeps the same rolling sample buffers the dashboard does, because
// forecast() needs this cycle's samples to work out the recent burn rate — the
// live payload alone only carries the current percentage. Wording comes from
// forecast.js, so the widget and the dashboard can never disagree.

const WS_URL = `ws://${location.host}/ws`;
const MAX_POINTS = 20000;

// Mirrors app.js's CLAUDE_WIN, trimmed to the two windows worth glancing at.
// series = index into C.data for the recent-rate method (null → cycle average).
const CLAUDE_WIN = [
  { key: "fh", label: "5-hour", reset: "five_hour", winMs: 5 * 3600e3, series: 1 },
  { key: "sd", label: "7-day", reset: "seven_day", winMs: 7 * 24 * 3600e3, series: null },
];
const CX_ORDER = ["5-hour", "7-day"];
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

function row(label, p) {
  if (!p) return "";
  return `<div class="row ${p.cls}"><span class="label">${label}</span>` +
         `<span class="msg" title="${p.msg.replace(/"/g, "&quot;")}">${p.msg}</span></div>`;
}

function claudeRows() {
  if (!C.last) return [];
  const out = [];
  for (const w of CLAUDE_WIN) {
    const cur = C.last[w.key];
    if (cur == null) continue;
    const resetIso = C.resets[w.reset];
    const samples = (w.series && resetIso)
      ? cycleSamples(C.data, w.series, new Date(resetIso).getTime(), w.winMs) : null;
    out.push(row(w.label, forecast(cur, w.winMs, resetIso, samples)));
  }
  return out.filter(Boolean);
}

function codexRows() {
  if (!X.last) return [];
  const wins = (X.last.windows || []).slice();
  // Same order the dashboard uses, with anything unexpected appended.
  wins.sort((a, b) => {
    const ia = CX_ORDER.indexOf(a.label), ib = CX_ORDER.indexOf(b.label);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return wins.map((w) => {
    const idx = CX_SERIES[w.label] || null;
    const winMs = (w.window_seconds || 0) * 1000;
    const samples = (idx && w.reset_at)
      ? cycleSamples(X.data, idx, new Date(w.reset_at).getTime(), winMs) : null;
    return row(w.label, forecast(w.used_percent, winMs, w.reset_at, samples));
  }).filter(Boolean);
}

// The row count changes as windows appear and disappear (Codex's 5-hour shows up
// only when it has data), so the panel is told what height to be rather than
// guessing. Native side listens on the "size" handler; harmless in a browser tab.
let lastH = 0;
function reportHeight() {
  const h = Math.ceil($("card").getBoundingClientRect().height);
  if (h === lastH || !h) return;
  lastH = h;
  const mh = window.webkit && window.webkit.messageHandlers;
  if (mh && mh.size) mh.size.postMessage(h);
}

function render() {
  const cl = claudeRows(), cx = codexRows();
  const parts = [];
  if (cl.length) parts.push(`<div class="src">Claude</div>`, ...cl);
  if (cx.length) parts.push(`<div class="src">Codex</div>`, ...cx);
  $("card").innerHTML = parts.length ? parts.join("") : `<div id="empty">gathering data…</div>`;
  reportHeight();
}

// ---- websocket (same feed as the dashboard) ----
let ws = null, backoff = 500;

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => { backoff = 500; };
  ws.onclose = () => {
    // Keep the last numbers on screen rather than blanking; the clock in
    // forecast() keeps counting them down until fresh data lands.
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
setInterval(render, 1000);   // keep the countdowns ticking between samples
