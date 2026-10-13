// The shared contract vectors of NotTennaPod-Server (contract/vectors) that the web client's own
// code must reproduce: canonical JSON and the content hash of the facts it writes, and the cursors
// it decodes (PROTOCOL §16). The vectors are read from the server checkout (NTP_SERVER, default
// ../NotTennaPod-Server). Without NTP_SERVER and without that checkout the tests are skipped and
// say so; with NTP_SERVER set, missing vectors fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { base64url, canonical, contentHash, utf8 } from "../src/journal/jcs.ts";
import { decodeCursor } from "../src/journal/pusher.ts";
import { sha256 } from "../src/util/random.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(process.env.NTP_SERVER ?? join(root, "..", "NotTennaPod-Server"), "contract", "vectors");
const absent = !process.env.NTP_SERVER && !existsSync(dir);
const skip = absent ? `no server checkout at ${dir}; set NTP_SERVER to check the shared vectors` : false;

function vectors<T>(suite: string): T[] {
  const file = join(dir, `${suite}.json`);
  const v = JSON.parse(readFileSync(file, "utf8")) as { suite: string; cases: T[] };
  assert.equal(v.suite, suite, file);
  assert.ok(v.cases.length > 0, `${file} has no cases`);
  return v.cases;
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * representable says whether the contract can carry a decoded value at all:
 * integers within ±(2^53−1), well-formed strings, at most 64 nested levels
 * (PROTOCOL §3.1). The text-level rules (duplicate names, exponents,
 * leading zeros, a byte-order mark, invalid UTF-8) belong to decoders of
 * JSON text, which the web client is not: it hashes values it built.
 */
function representable(v: unknown, depth = 0): boolean {
  if (v === null || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isSafeInteger(v);
  if (typeof v === "string") return v.isWellFormed();
  if (Array.isArray(v)) return depth < 64 && v.every((x) => representable(x, depth + 1));
  if (typeof v === "object") return depth < 64 && Object.entries(v).every(([k, x]) => k.isWellFormed() && representable(x, depth + 1));
  return false;
}

test("canonical JSON: the web's canonical form of every valid input is the vector's, byte for byte", { skip }, () => {
  const cases = vectors<{ input?: string; input_hex?: string; output?: string; error?: boolean }>("canonical_json");
  let checked = 0;
  for (const c of cases) {
    if (c.error) continue;
    assert.equal(canonical(JSON.parse(c.input!)), c.output, `input ${JSON.stringify(c.input)}`);
    assert.deepEqual(utf8(canonical(JSON.parse(c.input!))), utf8(c.output!));
    checked++;
  }
  assert.ok(checked >= 20, `only ${checked} valid cases`);
});

test("canonical JSON: a value the contract cannot carry is never turned into one the server would take", { skip }, () => {
  const cases = vectors<{ input?: string; input_hex?: string; error?: boolean }>("canonical_json").filter((c) => c.error);
  let valueLevel = 0;
  for (const c of cases) {
    if (c.input === undefined) continue; // invalid UTF-8 bytes: a decoder's rule
    let v: unknown;
    try {
      v = JSON.parse(c.input);
    } catch {
      continue; // not JSON at all: a decoder's rule
    }
    if (representable(v)) continue; // a text-level rule (an exponent, a duplicate name, -0): a decoder's
    valueLevel++;
    // A non-integer, an integer beyond ±(2^53−1), a lone surrogate or nesting
    // past 64 levels: refused here, or kept unrepresentable so the server
    // refuses the push and says so, never hashed as a different value.
    let out: string;
    try {
      out = canonical(v);
    } catch {
      continue;
    }
    assert.equal(representable(JSON.parse(out)), false, `${JSON.stringify(c.input)} became ${JSON.stringify(out)}`);
  }
  assert.ok(valueLevel >= 5, `only ${valueLevel} value-level error cases`);
});

test("content hash: the web hashes every vector fact as the server does, with Web Crypto and without (plain HTTP)", { skip }, async () => {
  const cases = vectors<{ fact: Record<string, unknown>; output: string }>("content_hash");
  for (const c of cases) {
    assert.equal(await contentHash(c.fact), c.output, JSON.stringify(c.fact).slice(0, 80));
    // crypto.subtle is missing on a plain-HTTP origin (a Tailscale address): the fallback must agree.
    assert.equal(hex(sha256(utf8(canonical(c.fact)))), c.output);
  }
});

test("cursor: valid cursors decode to their lineage and position; every invalid one is refused", { skip }, () => {
  const cases = vectors<{ cursor?: { log_id: string; epoch: number; seq: number; digest: string }; encoded: string; error?: boolean }>("cursor");
  let valid = 0;
  let invalid = 0;
  for (const c of cases) {
    if (c.error) {
      assert.throws(() => decodeCursor(c.encoded), `accepted ${JSON.stringify(c.encoded)}`);
      invalid++;
      continue;
    }
    const k = c.cursor!;
    assert.deepEqual(decodeCursor(c.encoded), { log_id: k.log_id, epoch: k.epoch, seq: k.seq });
    // The encoding the web uses for parts and cursors agrees with the server's.
    assert.equal(base64url(utf8(canonical(k))), c.encoded);
    valid++;
  }
  assert.ok(valid >= 3 && invalid >= 10, `${valid} valid, ${invalid} invalid`);
});
