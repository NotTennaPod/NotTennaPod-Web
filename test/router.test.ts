import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoute, pathOf } from "../src/app/router.ts";

test("routes round-trip", () => {
  for (const p of ["/", "/queue", "/inbox", "/subscriptions", "/episodes", "/history", "/favorites", "/statistics", "/add", "/settings",
    "/podcast/p1%3Aabc", "/episode/e1%3Adef"]) {
    assert.equal(pathOf(parseRoute(p)), p);
  }
  assert.deepEqual(parseRoute("/podcast/p1:abc"), { name: "podcast", id: "p1:abc" });
  assert.deepEqual(parseRoute("/nope/x/y"), { name: "not_found" });
});

test("a path whose escapes are not UTF-8 is not found, not an error", () => {
  for (const p of ["/episode/%FF", "/episode/%E0%A4", "/settings/%C0%AF"]) assert.deepEqual(parseRoute(p), { name: "not_found" });
});
