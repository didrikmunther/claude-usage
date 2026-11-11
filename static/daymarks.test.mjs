// Unit tests for dayMarks: how a weekly window splits into calendar days.
// Run: node --test static/daymarks.test.mjs
process.env.TZ = "Europe/Stockholm";   // fixed local midnights, whatever the machine
import { test } from "node:test";
import assert from "node:assert/strict";
import mod from "./predict.js";
const { dayMarks } = mod;

const at = (iso) => new Date(iso).getTime();
const sec = (iso) => at(iso) / 1000;

// Window: Thu 2026-11-05 14:00 → Thu 2026-11-12 14:00 (Stockholm, UTC+1).
const reset = at("2026-11-12T14:00:00+01:00");

test("splits at each local midnight, starting from the window's open", () => {
  const ts = [sec("2026-11-05T20:00:00+01:00"), sec("2026-11-06T12:00:00+01:00"), sec("2026-11-07T09:00:00+01:00")];
  const ys = [10, 30, 34];
  const days = dayMarks(ts, ys, reset, at("2026-11-07T10:00:00+01:00"));
  assert.deepEqual(days, [
    { start: at("2026-11-05T14:00:00+01:00"), from: 0 },
    { start: at("2026-11-06T00:00:00+01:00"), from: 10 },
    { start: at("2026-11-07T00:00:00+01:00"), from: 30 },
  ]);
});

test("ignores samples from before the window and nulls; a quiet day keeps the level", () => {
  const ts = [sec("2026-11-05T10:00:00+01:00"), sec("2026-11-05T22:00:00+01:00"), sec("2026-11-06T08:00:00+01:00")];
  const ys = [90, 5, null];
  const days = dayMarks(ts, ys, reset, at("2026-11-07T01:00:00+01:00"));
  assert.deepEqual(days.map((d) => d.from), [0, 5, 5]);
});

test("never decreases, even if a sample dips", () => {
  const ts = [sec("2026-11-05T20:00:00+01:00"), sec("2026-11-05T23:00:00+01:00")];
  const days = dayMarks(ts, [12, 11], reset, at("2026-11-06T09:00:00+01:00"));
  assert.deepEqual(days.map((d) => d.from), [0, 12]);
});

test("no reset or not yet open: nothing", () => {
  assert.deepEqual(dayMarks([], [], null, Date.now()), []);
  assert.deepEqual(dayMarks([], [], reset, at("2026-11-01T00:00:00+01:00")), []);
});
