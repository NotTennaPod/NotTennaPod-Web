import { test } from "node:test";
import assert from "node:assert/strict";
import { between, compareKeys, keyOrder, type QueueKey } from "../src/queue/keys.ts";
import { longestRun } from "../src/queue/sort.ts";

// The run selection as it was before it searched, kept as the oracle: every
// pair of keyed members compared.
function lisQuadratic(keys: (QueueKey | null)[]): boolean[] {
  const n = keys.length;
  const keep = new Array<boolean>(n).fill(false);
  const from = new Array<number>(n).fill(1);
  let longest = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (!keys[i]) {
      from[i] = 0;
      continue;
    }
    for (let j = i + 1; j < n; j++) {
      if (keys[j] && compareKeys(keys[i]!, keys[j]!) < 0 && from[j]! + 1 > from[i]!) from[i] = from[j]! + 1;
    }
    longest = Math.max(longest, from[i]!);
  }
  let need = longest;
  let last = -1;
  for (let i = 0; i < n && need > 0; i++) {
    if (from[i] === need && (last < 0 || compareKeys(keys[last]!, keys[i]!) < 0)) {
      keep[i] = true;
      last = i;
      need--;
    }
  }
  return keep;
}

// A seeded generator, so a failure reproduces.
function rng(seed: number) {
  let s = seed >>> 0;
  return (k: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % k;
  };
}

// pool returns n increasing keys of varied exponents: each after an earlier
// one, sometimes between it and the next, as devices allocate them.
function pool(r: (k: number) => number, n: number): QueueKey[] {
  const keys: QueueKey[] = [];
  while (keys.length < n) {
    let low: QueueKey | null = null;
    let high: QueueKey | null = null;
    if (keys.length > 0) {
      const i = r(keys.length);
      low = keys[i]!;
      if (i + 1 < keys.length && r(3) === 0) high = keys[i + 1]!;
    }
    let u = 0n;
    for (let b = 0; b < 4; b++) u = (u << 32n) | BigInt(r(2 ** 32));
    const k = between(low, high, u);
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareKeys(keys[mid]!, k) < 0) lo = mid + 1;
      else hi = mid;
    }
    keys.splice(lo, 0, k);
  }
  return keys;
}

test("key order strings order as the keys do", () => {
  const r = rng(5);
  const ks = pool(r, 300);
  for (let t = 0; t < 20000; t++) {
    const a = ks[r(ks.length)]!;
    const b = ks[r(ks.length)]!;
    const o = keyOrder(a) < keyOrder(b) ? -1 : keyOrder(a) > keyOrder(b) ? 1 : 0;
    assert.equal(o, Math.sign(compareKeys(a, b)));
  }
});

test("the run kept is the quadratic selection's, over queues of every shape", () => {
  const r = rng(13);
  const ks = pool(r, 400);
  const shapes: Record<string, (n: number) => number[]> = {
    random: (n) => Array.from({ length: n }, () => r(ks.length)),
    increasing: (n) => {
      const start = r(ks.length - n + 1);
      return Array.from({ length: n }, (_, i) => start + i);
    },
    reversed: (n) => Array.from({ length: n }, (_, i) => n - 1 - i),
    "a few moved": (n) => {
      const out = Array.from({ length: n }, (_, i) => i);
      for (let m = 1 + r(4); m > 0; m--) {
        const [x] = out.splice(r(n), 1);
        out.splice(r(n), 0, x!);
      }
      return out;
    },
    "sorted runs": (n) => {
      const out: number[] = [];
      while (out.length < n) {
        const start = r(ks.length);
        const l = 1 + r(n);
        for (let i = start; i < Math.min(ks.length, start + l) && out.length < n; i++) out.push(i);
      }
      return out;
    },
    "equal keys": (n) => Array.from({ length: n }, () => r(4)),
  };
  for (const [name, shape] of Object.entries(shapes)) {
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + r(Math.min(ks.length, 1 + trial * 2));
      const keys = shape(n).map((x) => (r(8) > 0 ? ks[x]! : null));
      assert.deepEqual(longestRun(keys).keep, lisQuadratic(keys), `${name}, trial ${trial}`);
    }
  }
  assert.deepEqual(longestRun([]).keep, []);
});

test("a run over 10,000 members makes O(Q log Q) comparisons", () => {
  const r = rng(3);
  const q = 10000;
  const ks = pool(r, q);
  const keys: (QueueKey | null)[] = [...ks.slice(1), ks[0]!]; // the first member moved to the end
  const { keep, comparisons } = longestRun(keys);
  assert.equal(keep.filter(Boolean).length, q - 1);
  const limit = q * (Math.ceil(Math.log2(q)) + 2);
  assert.ok(comparisons <= limit, `${comparisons} comparisons, want at most ${limit}`);
});
