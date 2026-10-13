import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { between, compareKeys, keyString, parseKey } from "../src/queue/keys.ts";
import { sortQueue, type Item, type SortOrder } from "../src/queue/sort.ts";

const vectors = (name: string) => JSON.parse(readFileSync(new URL(`./vectors/${name}.json`, import.meta.url), "utf8")).cases;

test("queue keys parse as the contract says", () => {
  for (const c of vectors("queue_parse")) {
    const k = parseKey(c.input);
    assert.equal(k !== null, c.valid, c.input);
    if (k) assert.equal(keyString(k), c.input);
  }
});

test("queue keys compare numerically", () => {
  for (const c of vectors("queue_compare")) {
    assert.equal(Math.sign(compareKeys(parseKey(c.a)!, parseKey(c.b)!)), c.output, `${c.a} ${c.b}`);
  }
});

test("keys between bounds match the server's allocator", () => {
  for (const c of vectors("queue_between")) {
    const low = c.low ? parseKey(c.low) : null;
    const high = c.high ? parseKey(c.high) : null;
    if (c.output === null || c.error) {
      assert.throws(() => between(low, high, BigInt(`0x${c.u}`)));
      continue;
    }
    assert.equal(keyString(between(low, high, BigInt(`0x${c.u}`))), c.output);
  }
});

test("the canonical keep-sorted order matches the server's", () => {
  let n = 0;
  for (const c of vectors("queue_sort")) {
    const items: Item[] = c.items.map((x: Record<string, unknown>, i: number) => ({
      episode_id: String(x.episode_id ?? i),
      podcast_id: x.podcast_id as string,
      title: (x.title as string) ?? "",
      podcast_title: (x.podcast_title as string) ?? "",
      publication_time: (x.publication_time as number) ?? 0,
      duration: (x.duration as number) ?? 0,
    }));
    for (const [order, want] of Object.entries(c.output as Record<string, number[]>)) {
      const got = sortQueue(order as SortOrder, items).map((it) => items.indexOf(it));
      assert.deepEqual(got, want, `${c.description} ${order}`);
      n++;
    }
  }
  assert.ok(n > 10);
});
