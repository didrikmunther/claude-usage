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

// Trailing window (seconds) used to rank the spike badges.
const SPIKE_WINS = [300, 900, 1800, 3600, 7200];
let spikeWin = SPIKE_WINS.includes(Number(localStorage.getItem("spikeWin"))) ? Number(localStorage.getItem("spikeWin")) : 300;
const winLabel = (sec) => (sec < 3600 ? `${Math.round(sec / 60)}m` : `${Math.round(sec / 3600)}h`);

// Claude's four windows (fixed lengths); Codex windows come from the payload.
// series = index into C.data for the recent-rate method (null → plain cycle
// average). Only the 5-hour window uses the reactive method; weekly windows
// average over the whole cycle.
const CLAUDE_WIN = [
  { key: "fh", label: "5-hour", reset: "five_hour",        winMs: 5 * 3600e3,      series: 1 },
  { key: "sd", label: "7-day",  reset: "seven_day",        winMs: 7 * 24 * 3600e3, series: null },
  { key: "so", label: "Opus",   reset: "seven_day_opus",   winMs: 7 * 24 * 3600e3, series: null },
  { key: "sn", label: "Sonnet", reset: "seven_day_sonnet", winMs: 7 * 24 * 3600e3, series: null },
];

const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// ---- charts ----
function makeChart(elId, series, plugins) {
  const el = $(elId);
  const opts = {
    width: el.clientWidth || 640, height: 240,
    padding: [8, 8, 0, 0],
    cursor: { y: false },
    legend: { show: false },
    plugins: plugins || [],
    scales: { y: { range: [0, 100] } },
    axes: [
      { grid: { show: false }, ticks: { show: false }, size: 34, values: fmtAxis },
      { grid: { stroke: css("--line"), width: 1 }, ticks: { show: false },
        size: 38, values: (u, vs) => vs.map((v) => v + "%") },
    ],
    series: [{}, ...series.map((s) => ({ label: s.label, stroke: css(s.color), width: 2, points: { show: false } }))],
  };
  return new uPlot(opts, [[], [], []], el);
}

const hm = (tsec) => new Date(tsec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

// Top-3 points by trailing-`winSec` consumption (reset-proof: uses cumulative
// positive increments). Spread apart so the three markers land on distinct spikes.
function top3Spikes(ts, ys, winSec) {
  const n = ts.length;
  if (n < 3) return [];
  const cum = new Array(n);
  let acc = 0, prev = null;
  for (let i = 0; i < n; i++) {
    const v = ys[i];
    if (v != null) { if (prev != null && v > prev) acc += v - prev; prev = v; }
    cum[i] = acc;
  }
  const cand = [];
  let lo = 0;
  for (let i = 0; i < n; i++) {
    if (ys[i] == null) continue;
    while (lo < i && ts[i] - ts[lo] > winSec) lo++;   // lo = oldest sample within the window
    const rate = cum[i] - cum[lo];                    // % consumed in the trailing window
    if (rate > 0) cand.push({ t: ts[i], y: ys[i], rate });
  }
  cand.sort((a, b) => b.rate - a.rate);
  const sep = Math.max(winSec, (ts[n - 1] - ts[0]) / 25);
  const picked = [];
  for (const c of cand) {
    if (picked.every((p) => Math.abs(p.t - c.t) > sep)) picked.push(c);
    if (picked.length === 3) break;
  }
  return picked;
}

// uPlot plugin: numbered circles at the top-3 5-min spikes, transparent until hover.
// pref = series indices to measure (first with data wins); accents = {idx: cssVar}.
function spikeMarkers(pref, accents) {
  let els = null;
  // uPlot fires "draw" before "ready" on first render, so create the elements
  // lazily here (never in "ready") to guarantee they exist before we use them.
  const ensure = (u) => {
    if (els) return;
    els = [];
    for (let r = 0; r < 3; r++) {
      const el = document.createElement("div");
      el.className = "gmark";
      el.innerHTML = `<span class="gnum">${r + 1}</span><div class="mtip"></div>`;
      el.style.display = "none";
      u.over.appendChild(el);
      els.push(el);
    }
  };
  return {
    hooks: {
      draw: (u) => {
        ensure(u);
        const si = pref.find((idx) => (u.data[idx] || []).some((v) => v != null));
        const picked = si ? top3Spikes(u.data[0], u.data[si], spikeWin) : [];
        const color = si ? css(accents[si]) : css("--fh");
        for (let r = 0; r < 3; r++) {
          const el = els[r], p = picked[r];
          if (!p) { el.style.display = "none"; continue; }
          const top = u.valToPos(p.y, "y");
          el.style.display = "";
          el.style.left = u.valToPos(p.t, "x") + "px";
          el.style.top = top + "px";
          el.classList.toggle("tip-below", top < 44);
          el.querySelector(".gnum").style.borderColor = color;
          el.querySelector(".mtip").textContent = `#${r + 1} · +${Math.round(p.rate)}% in ${winLabel(spikeWin)} · ${hm(p.t)}`;
        }
      },
    },
  };
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
  let vis = st.data;
  if (secs !== Infinity && st.data[0].length) {
    const cutoff = st.data[0][st.data[0].length - 1] - secs;
    let i = 0;
    while (i < st.data[0].length && st.data[0][i] < cutoff) i++;
    vis = st.data.map((s) => s.slice(i));
  }
  st.chart.setData(vis);
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
    { st: C, el: "consumed", cols: ["--fh", "--sd"] },
    { st: X, el: "cxConsumed", cols: ["--cx1", "--cx2"] },
  ];
  const LBL = ["5h", "7d"];
  for (const t of targets) {
    const el = $(t.el);
    if (!el) continue;
    const res = consumedInRange(t.st);
    const parts = res.map((r, idx) => r.n > 1
      ? `<b style="color:var(${t.cols[idx]})">${LBL[idx]} +${Math.round(r.sum)}%</b>` : null).filter(Boolean);
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
  $("mOpus").textContent = fmtPct(s.so);
  $("mSonnet").textContent = fmtPct(s.sn);
  $("mCredits").textContent = s.credits == null ? "–" : "$" + Number(s.credits).toFixed(2);
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

  $("cxPlan").textContent = s.plan_type || "–";
  const cr = s.credits || {};
  $("cxCredits").textContent = cr.unlimited ? "∞" : (cr.balance == null ? "–" : "$" + Number(cr.balance).toFixed(2));

  const add = (s.additional || []).filter((a) => a.used_percent != null);
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
  const usedW = new Set();
  // Same slotting as the bars: 5-hour row, then 7-day row (ghost where empty).
  const rows = CX_SLOTS.map((slot) => {
    const w = wins.find((x) => x.label === slot.label);
    if (w) { usedW.add(w); return progFor(w); }
    return GHOST_PROG;
  });
  wins.filter((w) => !usedW.has(w)).forEach((w) => rows.push(progFor(w)));
  $("cxProg").innerHTML = rows.join("") || emptyRow();
}

// ---- status ----
function setStatus(st) {
  const dot = $("dot"), txt = $("statusText"), banner = $("banner");
  if (!st) return;
  if (st.state === "ok") {
    dot.className = "dot ok"; txt.textContent = "live";
    banner.hidden = !st.message;
    if (st.message) banner.textContent = st.message;   // partial failure note
  } else if (st.state === "error") {
    dot.className = "dot err"; txt.textContent = "error";
    banner.hidden = false; banner.textContent = st.message || "poll failed";
  } else {
    dot.className = "dot"; txt.textContent = st.state;
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

function wireSpikeWin() {
  const sel = $("spikeWin");
  if (!sel) return;
  sel.value = String(spikeWin);
  sel.addEventListener("change", () => {
    spikeWin = Number(sel.value);
    localStorage.setItem("spikeWin", spikeWin);
    if (C.chart) C.chart.redraw();     // re-run the badge plugin with the new window
    if (X.chart) X.chart.redraw();
  });
}

function setIntervalUI(n) {
  $("ivalNum").value = n;
  $("ival").value = Math.min(Number($("ival").max), n);
}

// ---- websocket ----
let ws = null, backoff = 500;
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  sendInterval = (v) => ws && ws.readyState === 1 && ws.send(JSON.stringify({ set_interval: v }));
  ws.onopen = () => { backoff = 500; };
  ws.onclose = () => {
    $("dot").className = "dot"; $("statusText").textContent = "reconnecting…";
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
      setIntervalUI(m.interval);
      setStatus(m.status);
    } else if (m.type === "sample") {
      if (m.claude) { pushPoint(C, m.claude.ts / 1000, m.claude.fh, m.claude.sd); renderClaude(m.claude); }
      if (m.codex) { pushPoint(X, m.codex.ts / 1000, m.codex.cp, m.codex.cs); renderCodex(m.codex); }
      setStatus(m.status);
    } else if (m.type === "status") {
      setStatus(m.status);
    } else if (m.type === "interval") {
      setIntervalUI(m.interval);
    }
  };
}

// ---- 1-second tick: keep countdowns + forecasts fresh ----
function tick() {
  renderClaudeResets();
  renderClaudeForecast();
  document.querySelectorAll("#cxBars [data-reset]").forEach((el) => {
    el.textContent = countdown(el.dataset.reset);
  });
  renderCodexForecast();
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
    [spikeMarkers([1], { 1: "--fh" })]);                       // mark 5-hour spikes
  X.chart = makeChart("cxChart", [{ label: "primary", color: "--cx1" }, { label: "secondary", color: "--cx2" }],
    [spikeMarkers([1, 2], { 1: "--cx1", 2: "--cx2" })]);       // 5-hour if present, else 7-day
  observeSize("chart", () => C.chart);
  observeSize("cxChart", () => X.chart);
  wireControls();
  wireRange();
  wireSpikeWin();
  connect();
  setInterval(tick, 1000);
});
