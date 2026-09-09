"use strict";

// Scoring the models is ~1s of arithmetic over the whole history — enough to
// visibly stall the page, and it runs while charts are animating. So it happens
// out here instead. predict.js and accuracy.js are classic scripts, which is
// exactly what importScripts wants.
importScripts("/static/predict.js", "/static/accuracy.js");

onmessage = (e) => {
  const { samples, opts } = e.data || {};
  try {
    postMessage({ ok: true, result: scoreModels(samples || [], opts || {}) });
  } catch (err) {
    postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};
