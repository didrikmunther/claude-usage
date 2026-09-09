// Unit tests for the backtest scorer. Run: node --test static/accuracy.test.mjs
//
// accuracy.js leans on predict.js's globals (Predictors, sampleAt) exactly as the
// browser does, so both are loaded into one vm context rather than imported.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ctx = vm.createContext({ console });
for (const f of ["predict.js", "accuracy.js"]) {
  vm.runInContext(fs.readFileSync(path.join(DIR, f), "utf8"), ctx, { filename: f });
}
const { scoreModels, actualAt } = ctx;   // HORIZONS is a const: read it off the result

const H = 3600;
// A dead-straight climb: 0.5 %/h for 6 days, sampled every 5 minutes.
const straight = [];
for (let t = 0; t <= 6 * 24 * H; t += 300) straight.push({ t, y: (t / H) * 0.5 });

test("actualAt returns the real value, and null inside a gap", () => {
  const s = [{ t: 0, y: 1 }, { t: 300, y: 2 }, { t: 40000, y: 9 }];
  assert.equal(actualAt(s, 300), 2);
  assert.equal(actualAt(s, 310), 2);              // within tolerance
  assert.equal(actualAt(s, 20000), null);         // mid-gap: no honest answer
});

test("a straight line is forecast almost exactly by the linear model", () => {
  const r = scoreModels(straight, { models: ["linear"], originStep: 12 * H });
  assert.ok(r.origins > 5, `expected several origins, got ${r.origins}`);
  for (const h of r.horizons) {
    assert.ok(r.models.linear[h] < 0.5,
      `linear should nail a straight line at +${h / H}h, got ${r.models.linear[h]}`);
  }
});

test("error grows with the horizon on a series that curves away", () => {
  // Accelerating usage: linear extrapolation must fall further behind the
  // further ahead it looks. This is the property the table exists to show.
  const curved = [];
  for (let t = 0; t <= 6 * 24 * H; t += 300) curved.push({ t, y: Math.pow(t / (24 * H), 2) * 3 });
  const r = scoreModels(curved, { models: ["linear"], originStep: 12 * H });
  const near = r.models.linear[r.horizons[0]];
  const far = r.models.linear[r.horizons[r.horizons.length - 1]];
  assert.ok(far > near, `expected +12h error (${far}) to exceed +1h error (${near})`);
});

test("every model gets a score and an origin count", () => {
  const r = scoreModels(straight, { originStep: 24 * H });
  for (const name of ["linear", "cycle", "cycle+tod"]) {
    assert.ok(r.models[name], `${name} produced no row`);
    assert.ok(r.models[name].n > 0, `${name} scored no origins`);
  }
});

test("too little history reports why instead of guessing", () => {
  const r = scoreModels([{ t: 0, y: 1 }, { t: 60, y: 2 }]);
  assert.equal(Object.keys(r.models).length, 0);
  assert.match(r.reason, /not enough history/);
});
