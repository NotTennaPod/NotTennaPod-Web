import { test } from "node:test";
import assert from "node:assert/strict";
import { durationLong } from "../src/ui/format.ts";

test("durations are Android's HH:MM:SS", () => {
  assert.equal(durationLong(0), "00:00:00");
  assert.equal(durationLong(30_040), "00:00:30");
  assert.equal(durationLong(3_725_000), "01:02:05");
  assert.equal(durationLong(null), "00:00:00");
});
