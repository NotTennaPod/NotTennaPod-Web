import { test } from "node:test";
import assert from "node:assert/strict";
import { almostEnded, contribution, rewindAfterPause, speedStep, formatSpeed } from "../src/player/accounting.ts";

test("contribution is forward displacement from the baseline, frozen below it", () => {
  const base = { position: 100_000, contribution: 0 };
  let c = 0;
  c = contribution(base, c, 100_000);
  assert.equal(c, 0);
  c = contribution(base, c, 160_000); // a minute played, or a forward seek: both count
  assert.equal(c, 60_000);
  c = contribution(base, c, 130_000); // a rewind above the start lowers it
  assert.equal(c, 30_000);
  c = contribution(base, c, 40_000); // below the start it keeps its value
  assert.equal(c, 30_000);
  c = contribution(base, c, 110_000);
  assert.equal(c, 10_000);
});

test("a later baseline (a reload) continues from the session's contribution", () => {
  const base = { position: 300_000, contribution: 45_000 };
  assert.equal(contribution(base, 45_000, 290_000), 45_000);
  assert.equal(contribution(base, 45_000, 330_000), 75_000);
});

test("completion: Android's smart threshold of 30 s, never without a duration", () => {
  assert.equal(almostEnded(570_000, 600_000), true);
  assert.equal(almostEnded(569_999, 600_000), false);
  assert.equal(almostEnded(600_000, 600_000), true);
  assert.equal(almostEnded(5_000, 0), false);
});

test("rewind after pause follows RewindAfterPauseUtils", () => {
  const now = 10_000_000_000;
  assert.equal(rewindAfterPause(60_000, now - 10_000, now), 59_200);
  assert.equal(rewindAfterPause(60_000, now - 2 * 60_000, now), 57_000);
  assert.equal(rewindAfterPause(60_000, now - 2 * 3600_000, now), 50_000);
  assert.equal(rewindAfterPause(60_000, now - 2 * 86400_000, now), 40_000);
  assert.equal(rewindAfterPause(500, now - 2 * 86400_000, now), 0);
  assert.equal(rewindAfterPause(0, now - 10_000, now), 0);
  assert.equal(rewindAfterPause(60_000, 0, now), 60_000);
});

test("the speed bar moves in 0.05 steps between 0.5 and 4.0, shown with two decimals", () => {
  assert.equal(speedStep(1, 1), 1.05);
  assert.equal(speedStep(1.25, -1), 1.2);
  assert.equal(speedStep(0.5, -1), 0.5);
  assert.equal(speedStep(4, 1), 4);
  assert.equal(formatSpeed(1.5), "1.50");
});
