import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Sha256, sha256, uuid } from "../src/util/random.ts";

test("uuids are version 4 and distinct", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const u = uuid();
    assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    seen.add(u);
  }
  assert.equal(seen.size, 1000);
});

test("the SHA-256 fallback matches Node's", () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 100_000]) {
    const data = new Uint8Array(n).map((_, i) => (i * 31 + n) & 0xff);
    assert.equal(Buffer.from(sha256(data)).toString("hex"), createHash("sha256").update(data).digest("hex"), `length ${n}`);
  }
});

test("Sha256 in parts equals the whole, at every split", () => {
  const data = new Uint8Array(300);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff;
  const whole = createHash("sha256").update(data).digest("hex");
  for (const parts of [[0], [1], [63], [64], [65], [55, 1, 8], [64, 64], [3, 61, 128, 1], [299]]) {
    const h = new Sha256();
    let at = 0;
    for (const n of parts) {
      h.update(data.subarray(at, at + n));
      at += n;
    }
    h.update(data.subarray(at));
    assert.equal(Buffer.from(h.digest()).toString("hex"), whole, `split ${parts}`);
  }
});
