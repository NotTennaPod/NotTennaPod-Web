import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDB, req, tx, type Receipt } from "../src/journal/db.ts";
import { acknowledge, append, installation, newAuthor, outcomeKeepMs, outcomeShown, retire, updateInstallation } from "../src/journal/journal.ts";
import { retainedEntries, takeSuccessor } from "../src/journal/successor.ts";
import { recover, recoveryProblems, recoveryState, type RecoveryResult, type RecoveryTransport } from "../src/journal/recovery.ts";
import { defaultBounds } from "../src/journal/pusher.ts";

let n = 0;
const device = { name: "Browser", app_version: "1", capabilities: [] };
const note = (text: string) => ({ type: "test.note", targets: [], payload: { text } });

/** restored sets up a profile whose acknowledged entries were kept aside by a successor after a restore. */
async function restored(texts: string[], opts: { secrets?: boolean } = {}) {
  const db = await openDB(indexedDB, `recovery-${++n}`);
  const account = crypto.randomUUID();
  await installation(db, account);
  await updateInstallation(db, account, (r) => (r.registered = true));
  const a = await newAuthor(db, account);
  const receipts: { install_seq: number; receipt: Receipt }[] = [];
  const ops: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    const body = { ...note(texts[i]!), ...(opts.secrets && i === 0 ? { secrets: [{ secret_id: "s1", username: "u", password: "p" }] } : {}) };
    const e = await append(db, account, a.author_id, body);
    ops.push(e.op_id);
    // Receipts in an order that is not the journal's: receipt order decides the upload order.
    const seq = 10 + texts.length - i;
    receipts.push({ install_seq: e.install_seq, receipt: { op_id: e.op_id, content_hash: `h${i}`, outcome: "applied", normalized_time: 1, epoch: 1, seq, index: 0, key_id: "k", mac: "m" } });
  }
  await acknowledge(db, account, receipts, { log_id: "old", epoch: 1 });
  const pending = await append(db, account, a.author_id, note("written after the backup, never acknowledged"));
  await takeSuccessor(db, account, async () => {}, { freshNonce: false, device, recovery: true });
  return { db, account, ops, pending };
}

/** fake answers like the server: per-op inventory and upload statuses, with a log of calls. */
function fake(inventory: (op: string) => string, upload: (op: string, attempt: number) => Partial<RecoveryResult>) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const attempts = new Map<string, number>();
  const api: RecoveryTransport = {
    snapshot: async (body) => void calls.push({ path: "snapshot", body }),
    inventory: async (body) => {
      calls.push({ path: "inventory", body });
      return { results: (body.entries as { op_id: string }[]).map((e) => ({ kind: "fact", id: e.op_id, status: inventory(e.op_id) })) };
    },
    upload: async (body) => {
      calls.push({ path: "upload", body });
      return {
        head: "h",
        results: (body.entries as { fact?: { op_id: string }; receipt: Receipt }[]).map((e) => {
          const op = e.receipt.op_id;
          const k = (attempts.get(op) ?? 0) + 1;
          attempts.set(op, k);
          return { kind: "fact", id: op, status: "joined", ...upload(op, k) };
        }),
      };
    },
    finish: async (body) => void calls.push({ path: "finish", body }),
  };
  return { api, calls };
}

test("recovery uploads what the restored server lacks, in receipt order, and keeps what it will not take", async () => {
  const { db, account, ops } = await restored(["a", "b", "c", "d", "e"], { secrets: true });
  const [a, b, c, d, e] = ops as [string, string, string, string, string];
  const { api, calls } = fake(
    (op) => (op === a ? "have" : op === d ? "conflict" : "need"),
    (op, k) => (op === e ? { status: "invalid_receipt" } : op === b && k === 1 ? { status: "dependency_missing", missing: [c] } : {}),
  );
  const out = await recover(db, account, api);
  assert.deepEqual(calls.map((x) => x.path), ["snapshot", "inventory", "upload", "upload", "finish"]);
  const snap = calls[0]!.body;
  assert.equal(snap.mode, "recovery");
  const inst = await installation(db, account);
  assert.equal(snap.recovery_id, inst.recovery!.recovery_id);
  assert.equal(snap.install_id, inst.install_id);
  // Receipt order: e (seq 11), d, c, b, a (seq 15); a is held and d conflicts, so neither is uploaded.
  const first = (calls[2]!.body.entries as { fact: { op_id: string } }[]).map((x) => x.fact.op_id);
  assert.deepEqual(first, [e, c, b]);
  // b waited for c, which the same request joined: the next pass sends b alone.
  assert.deepEqual((calls[3]!.body.entries as { fact: { op_id: string } }[]).map((x) => x.fact.op_id), [b]);
  assert.deepEqual(calls[4]!.body, { recovery_id: inst.recovery!.recovery_id, complete: false });
  assert.equal(inst.recovery!.finished, true);
  const left = await retainedEntries(db, account);
  assert.deepEqual(left.map((x) => x.op_id).sort(), [d, e].sort(), "only the conflict and the invalid receipt stay, as evidence");
  assert.deepEqual(out, { done: true, recovered: 3, pending: 0, problems: 2 });
  assert.deepEqual(await recoveryState(db, account), { done: true, recovered: 0, pending: 0, problems: 2 });
  // Nothing runs again once finished.
  assert.equal(await recover(db, account, api), null);
});

test("secrets travel beside the entries that carry them, and the receipt with each fact", async () => {
  const { db, account, ops } = await restored(["with a login", "plain"], { secrets: true });
  const { api, calls } = fake(() => "need", () => ({}));
  await recover(db, account, api);
  const up = calls.find((x) => x.path === "upload")!.body;
  assert.deepEqual(up.secrets, [{ secret_id: "s1", username: "u", password: "p" }]);
  const entries = up.entries as { fact: { op_id: string }; receipt: Receipt }[];
  assert.deepEqual(entries.map((x) => x.receipt.op_id), entries.map((x) => x.fact.op_id));
  assert.deepEqual(entries.map((x) => x.fact.op_id).sort(), [...ops].sort());
  assert.deepEqual(await retainedEntries(db, account), [], "recovered entries and their secrets are gone");
});

test("a recovery cut off by the network resumes with the same ID and does not open it again", async () => {
  const { db, account } = await restored(["a", "b"]);
  const first = fake(() => "need", () => ({}));
  first.api.upload = async () => {
    throw new Error("offline");
  };
  await assert.rejects(recover(db, account, first.api));
  const id = (await installation(db, account)).recovery!.recovery_id;
  const second = fake(() => "need", () => ({}));
  const out = await recover(db, account, second.api);
  assert.deepEqual(second.calls.map((x) => x.path), ["inventory", "upload", "finish"]);
  assert.equal(second.calls[0]!.body.recovery_id, id);
  assert.deepEqual(second.calls[2]!.body, { recovery_id: id, complete: true });
  assert.equal(out!.done, true);
});

test("an entry still waiting for a dependency keeps the recovery open, to be tried again", async () => {
  const { db, account, ops } = await restored(["a"]);
  const { api, calls } = fake(() => "need", () => ({ status: "dependency_missing", missing: ["elsewhere"] }));
  const out = await recover(db, account, api);
  assert.deepEqual(out, { done: false, recovered: 0, pending: 1, problems: 0 });
  assert.equal(calls.at(-1)!.path, "finish");
  assert.equal(calls.at(-1)!.body.complete, false);
  assert.equal((await installation(db, account)).recovery!.finished, false);
  assert.deepEqual((await retainedEntries(db, account)).map((x) => x.op_id), ops);
  const later = fake(() => "need", () => ({}));
  assert.equal((await recover(db, account, later.api))!.done, true);
});

test("a fact above the unframed bound goes in parts, one per request, each with its receipt", async () => {
  // Twenty parts: more than the passes a recovery makes, so the parts of one fact go together.
  const { db, account, ops } = await restored(["x".repeat(19_500)]);
  const bounds = { ...defaultBounds, max_unframed_fact_bytes: 1000, max_part_bytes: 1000 };
  const sent: number[] = [];
  const { api, calls } = fake(() => "need", () => ({}));
  api.upload = async (body) => {
    calls.push({ path: "upload", body });
    const [entry] = body.entries as { part: { part_index: number; part_count: number; transaction_id: string }; receipt: Receipt }[];
    sent.push(entry!.part.part_index);
    assert.equal(entry!.receipt.op_id, ops[0]);
    const done = sent.length === entry!.part.part_count;
    return { results: [{ kind: "part", id: ops[0]!, status: done ? "joined" : "part_stored", parts_present: [...sent] }] };
  };
  const out = await recover(db, account, api, bounds);
  assert.deepEqual(sent, Array.from({ length: 20 }, (_, i) => i));
  assert.equal(out!.done, true);
  const ids = new Set(calls.filter((x) => x.path === "upload").map((x) => (x.body.entries as { part: { transaction_id: string } }[])[0]!.part.transaction_id));
  assert.equal(ids.size, 1, "one framing transaction for the fact");
});

/** sortValues are a receipt's recorded sort values for a queue of n (PROTOCOL §7.6): about 330 bytes a member. */
const sortValues = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    episode_id: "e1:" + String(i).padStart(64, "0"),
    generation_id: "g1:" + "a".repeat(64),
    values: { title: "Typical episode title", podcast_id: "p1:" + "b".repeat(64), podcast_title: "A podcast", publication_time: 1800000000000, duration: 3600000 },
  }));

/** withSortValues gives the retained receipts (the first `count`, or all) the sort values of a queue of n. */
async function withSortValues(db: IDBDatabase, n: number, count = Infinity): Promise<void> {
  await tx(db, ["retained"], "readwrite", async (t) => {
    const store = t.objectStore("retained");
    let k = 0;
    for (const e of (await req(store.getAll())) as { receipt: Receipt }[]) {
      if (k++ >= count) break;
      e.receipt.sort_values = sortValues(n);
      await req(store.put(e));
    }
  });
}

test("receipts' sort values count toward a request: batches stay under the server's limit, and the signed values go back untouched", async () => {
  const { db, account, ops } = await restored(Array.from({ length: 16 }, (_, i) => String(i)), { secrets: true });
  await withSortValues(db, 1000);
  const { api, calls } = fake(() => "need", () => ({}));
  const out = await recover(db, account, api);
  const uploads = calls.filter((c) => c.path === "upload").map((c) => c.body);
  assert.ok(uploads.length > 1, "split into several requests");
  for (const b of uploads) assert.ok(Buffer.byteLength(JSON.stringify(b)) <= defaultBounds.max_request_bytes, `${Buffer.byteLength(JSON.stringify(b))} bytes`);
  const sent = uploads.flatMap((b) => b.entries as { receipt: Receipt }[]);
  assert.deepEqual(sent.map((e) => e.receipt.op_id).sort(), [...ops].sort(), "each entry once");
  for (const e of sent) assert.deepEqual(e.receipt.sort_values, sortValues(1000));
  assert.ok(uploads.some((b) => (b.secrets as unknown[] | undefined)?.length), "the secret goes with its entry");
  assert.deepEqual([out!.done, out!.recovered, out!.problems], [true, 16, 0]);
});

test("an entry whose signed receipt alone is over the request limit is never sent: kept as a problem, the others recovered", async () => {
  const { db, account, ops } = await restored(["big", "small"]);
  // Receipt order uploads "small" first (its seq is lower); the oversized one is "big".
  await tx(db, ["retained"], "readwrite", async (t) => {
    const store = t.objectStore("retained");
    for (const e of (await req(store.getAll())) as { op_id: string; receipt: Receipt }[]) {
      if (e.op_id !== ops[0]) continue;
      e.receipt.sort_values = sortValues(14_000);
      await req(store.put(e));
    }
  });
  const { api, calls } = fake(() => "need", () => ({}));
  const out = await recover(db, account, api);
  const uploads = calls.filter((c) => c.path === "upload").map((c) => c.body);
  for (const b of uploads) assert.ok(Buffer.byteLength(JSON.stringify(b)) <= defaultBounds.max_request_bytes);
  assert.deepEqual(uploads.flatMap((b) => (b.entries as { receipt: Receipt }[]).map((e) => e.receipt.op_id)), [ops[1]]);
  assert.deepEqual([out!.done, out!.recovered, out!.problems, out!.pending], [true, 1, 1, 0]);
  assert.deepEqual(calls.at(-1), { path: "finish", body: { recovery_id: (calls.at(-1)!.body as { recovery_id: string }).recovery_id, complete: false } });
  const kept = (await retainedEntries(db, account)) as { op_id: string; recovery?: { status: string }; receipt: Receipt }[];
  assert.deepEqual(kept.map((e) => [e.op_id, e.recovery?.status]), [[ops[0], "too_large"]]);
  assert.equal(kept[0]!.receipt.sort_values!.length, 14_000, "kept whole, as evidence");
});

const bytesOf = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/**
 * padTo gives the retained entry `op` a receipt whose sort values make
 * `measure(entry)` exactly `target` bytes: ten
 * thousand short values, then titles lengthened byte by byte.
 */
async function padTo(db: IDBDatabase, op: string, target: number, measure: (e: { fact: unknown; receipt: Receipt; secrets?: unknown[] }) => number): Promise<Receipt> {
  let out!: Receipt;
  await tx(db, ["retained"], "readwrite", async (t) => {
    const store = t.objectStore("retained");
    const e = ((await req(store.getAll())) as { op_id: string; fact: unknown; receipt: Receipt }[]).find((x) => x.op_id === op)!;
    const values = Array.from({ length: 10_000 }, (_, i) => ({ episode_id: "e1:" + String(i).padStart(64, "0"), generation_id: "g1:" + "a".repeat(64), values: { title: "T", podcast_id: "p1:" + "b".repeat(64), podcast_title: "P", publication_time: 1, duration: 1 } }));
    e.receipt.sort_values = values;
    let gap = target - measure(e);
    assert.ok(gap >= 0, `${gap}`);
    for (let i = 0; gap > 0; i++) {
      const n = Math.min(gap, 1000);
      values[i]!.values.title += "x".repeat(n);
      gap -= n;
    }
    assert.equal(measure(e), target);
    await req(store.put(e));
    out = structuredClone(e.receipt);
  });
  return out;
}

const recoveryId = async (db: IDBDatabase, account: string) => (await installation(db, account)).recovery!.recovery_id;

test("the allowance batching makes never decides: an entry whose own request fits is sent alone, however close to the limit", async () => {
  const limit = defaultBounds.max_request_bytes;
  for (const [target, sent] of [[limit - 100, true], [limit, true], [limit + 1, false]] as const) {
    const { db, account, ops } = await restored(["boundary", "small"], { secrets: true });
    const id = await recoveryId(db, account);
    const secrets = [{ secret_id: "s1", username: "u", password: "p" }];
    const receipt = await padTo(db, ops[0]!, target, (e) => bytesOf({ recovery_id: id, entries: [{ fact: e.fact, receipt: e.receipt }], secrets }));
    const { api, calls } = fake(() => "need", () => ({}));
    const out = await recover(db, account, api);
    const uploads = calls.filter((c) => c.path === "upload").map((c) => c.body);
    for (const b of uploads) assert.ok(bytesOf(b) <= limit);
    const big = uploads.find((b) => (b.entries as { receipt: Receipt }[]).some((e) => e.receipt.op_id === ops[0]));
    if (sent) {
      assert.equal(bytesOf(big), target, "exactly the request measured");
      assert.equal((big!.entries as unknown[]).length, 1, "alone");
      assert.deepEqual((big!.entries as { receipt: Receipt }[])[0]!.receipt, receipt);
      assert.deepEqual([out!.recovered, out!.problems], [2, 0]);
    } else {
      assert.equal(big, undefined);
      assert.deepEqual([out!.recovered, out!.problems], [1, 1]);
    }
  }
});

/** partsServer acknowledges parts as the server does: stored until the last, then joined. */
function partsServer(api: RecoveryTransport, calls: { path: string; body: Record<string, unknown> }[], fail?: (n: number) => boolean) {
  let n = 0;
  api.upload = async (body) => {
    calls.push({ path: "upload", body });
    if (fail?.(++n)) throw new Error("the network is gone");
    const [e] = body.entries as { part: { part_index: number; part_count: number }; receipt: Receipt }[];
    const last = e!.part.part_index === e!.part.part_count - 1;
    return { results: [{ kind: "fact", id: e!.receipt.op_id, status: last ? "joined" : "part_stored", parts_present: Array.from({ length: e!.part.part_index + 1 }, (_, i) => i) }] };
  };
}

test("a framed fact's parts are as small as its receipt needs, and a retry sends the same partition", async () => {
  const limit = defaultBounds.max_request_bytes;
  const { db, account, ops } = await restored(["x".repeat(300_000)]);
  const id = await recoveryId(db, account);
  // The whole fact and its receipt would be 4,180,000 bytes: a 256 KiB part (349,526 in base64) with it is over the limit; smaller parts fit.
  const receipt = await padTo(db, ops[0]!, 4_180_000, (e) => bytesOf({ recovery_id: id, entries: [{ fact: e.fact, receipt: e.receipt }] }));
  const { api, calls } = fake(() => "need", () => ({}));
  partsServer(api, calls, (n) => n === 2); // the second part's request is lost
  await assert.rejects(recover(db, account, api));
  const kept = (await retainedEntries(db, account))[0] as { recovery_framing?: { transaction_id: string; part_bytes?: number } };
  assert.ok(kept.recovery_framing?.part_bytes && kept.recovery_framing.part_bytes < defaultBounds.max_part_bytes, "the part size is kept with the transaction");
  partsServer(api, calls);
  const out = await recover(db, account, api);
  const parts = calls.filter((c) => c.path === "upload").map((c) => c.body);
  for (const b of parts) assert.ok(bytesOf(b) <= limit, `${bytesOf(b)} bytes`);
  const framing = parts.map((b) => (b.entries as { part: { transaction_id: string; part_count: number } }[])[0]!.part);
  assert.equal(new Set(framing.map((p) => `${p.transaction_id}/${p.part_count}`)).size, 1, "one transaction, one partition, across the retry");
  assert.ok(framing[0]!.part_count >= 2);
  for (const b of parts) assert.deepEqual((b.entries as { receipt: Receipt }[])[0]!.receipt, receipt);
  assert.deepEqual([out!.done, out!.recovered, out!.problems], [true, 1, 0]);
});

test("a framed fact is too large only when no legal partition fits: its receipt alone is over the limit", async () => {
  const { db, account, ops } = await restored(["x".repeat(300_000)]);
  await padTo(db, ops[0]!, defaultBounds.max_request_bytes, (e) => bytesOf(e.receipt));
  const { api, calls } = fake(() => "need", () => ({}));
  const out = await recover(db, account, api);
  assert.equal(calls.filter((c) => c.path === "upload").length, 0);
  assert.deepEqual([out!.problems, out!.pending], [1, 0]);
  assert.equal(((await retainedEntries(db, account))[0] as { recovery?: { status: string } }).recovery?.status, "too_large");
});

test("the changes kept as problems are listed by kind, reason and time, never with their secrets", async () => {
  const { db, account, ops } = await restored(["big", "small"], { secrets: true });
  await tx(db, ["retained"], "readwrite", async (t) => {
    const store = t.objectStore("retained");
    for (const e of (await req(store.getAll())) as { op_id: string; receipt: Receipt }[]) {
      if (e.op_id !== ops[0]) continue;
      e.receipt.sort_values = sortValues(14_000);
      await req(store.put(e));
    }
  });
  const { api } = fake(() => "need", (op) => (op === ops[1] ? { status: "conflict" } : {}));
  await recover(db, account, api);
  const listed = await recoveryProblems(db, account);
  assert.deepEqual(listed.map((p) => [p.op_id, p.type, p.reason]), [[ops[1], "test.note", "conflict"], [ops[0], "test.note", "too_large"]]);
  for (const p of listed) assert.ok(p.time > 0);
  assert.ok(!JSON.stringify(listed).includes("s1") && !JSON.stringify(listed).includes('"p"'), "no secret");
  assert.equal(listed.length, (await recoveryState(db, account)).problems, "as many as the banner counts");
});

test("a profile with nothing acknowledged before the restore sends no recovery request", async () => {
  const db = await openDB(indexedDB, `recovery-${++n}`);
  const account = crypto.randomUUID();
  await installation(db, account);
  await updateInstallation(db, account, (r) => (r.registered = true));
  await takeSuccessor(db, account, async () => {}, { freshNonce: false, device, recovery: true });
  const { api, calls } = fake(() => "need", () => ({}));
  const out = await recover(db, account, api);
  assert.deepEqual(calls, []);
  assert.equal(out!.done, true);
  assert.equal((await installation(db, account)).recovery!.finished, true);
  // The store is untouched by other accounts' rows.
  assert.equal((await tx(db, ["retained"], "readonly", (t) => req(t.objectStore("retained").count()))) as number, 0);
});

test("a recovery waits while its successor handoff is under way, then runs once the handoff finishes", async () => {
  const db = await openDB(indexedDB, `recovery-${++n}`);
  const account = crypto.randomUUID();
  await installation(db, account);
  await updateInstallation(db, account, (r) => (r.registered = true));
  const a = await newAuthor(db, account);
  const e = await append(db, account, a.author_id, note("acknowledged before the restore"));
  await acknowledge(db, account, [{ install_seq: e.install_seq, receipt: { op_id: e.op_id, content_hash: "h", outcome: "applied", normalized_time: 1, epoch: 1, seq: 9, index: 0, key_id: "k", mac: "m" } }], { log_id: "old", epoch: 1 });
  // The successor is planned, but its registration does not reach the server.
  await assert.rejects(takeSuccessor(db, account, async () => { throw new Error("offline"); }, { freshNonce: false, device, recovery: true }));
  // The plan and the recovery were recorded together: no tab ever sees the recovery without its handoff.
  const planned = await installation(db, account);
  assert.ok(planned.successor && planned.recovery && !planned.recovery.finished);
  const early = fake(() => "need", () => ({}));
  assert.equal(await recover(db, account, early.api), null, "nothing is judged before the entries are moved aside");
  assert.deepEqual(early.calls, []);
  assert.equal((await installation(db, account)).recovery!.finished, false);
  // The handoff is finished later (another load, the same plan); the recovery then sends the entry.
  await takeSuccessor(db, account, async () => {}, { freshNonce: false, device });
  const later = fake(() => "need", () => ({}));
  const out = await recover(db, account, later.api);
  assert.equal(out!.done, true);
  assert.deepEqual((later.calls.find((x) => x.path === "upload")!.body.entries as { fact: { op_id: string } }[]).map((x) => x.fact.op_id), [e.op_id]);
});

test("a recovered refusal its tab has not shown stays out of the recovery until shown, or for a day", async () => {
  for (const result of ["have", "need"] as const) {
    for (const end of ["shown", "expired"] as const) {
      const db = await openDB(indexedDB, `recovery-${++n}`);
      const account = crypto.randomUUID();
      await installation(db, account);
      await updateInstallation(db, account, (r) => (r.registered = true));
      const a = await newAuthor(db, account);
      const t0 = Date.now();
      const refused = await append(db, account, a.author_id, { ...note("refused, awaited"), awaited: true }, t0);
      const other = await append(db, account, a.author_id, note("refused, nobody waits"), t0);
      const receipt = (op: string, seq: number): Receipt =>
        ({ op_id: op, content_hash: "h", outcome: "not_applied", reason: "generation_closed", normalized_time: 1, epoch: 1, seq, index: 0, key_id: "k", mac: "m" });
      await acknowledge(db, account, [{ install_seq: refused.install_seq, receipt: receipt(refused.op_id, 1) }, { install_seq: other.install_seq, receipt: receipt(other.op_id, 2) }], { log_id: "old", epoch: 1 });
      await takeSuccessor(db, account, async () => {}, { freshNonce: false, device, recovery: true });
      const { api, calls } = fake(() => result, () => ({}));
      const out = await recover(db, account, api);
      assert.deepEqual(out, { done: true, recovered: 2, pending: 0, problems: 0 }, `${result}: the recovery finishes`);
      assert.equal(calls.at(-1)!.path, "finish");
      assert.deepEqual(calls.at(-1)!.body.complete, true);
      assert.deepEqual((await retainedEntries(db, account)).map((e) => e.op_id), [refused.op_id], `${result}: kept for its tab only`);
      assert.deepEqual(await recoveryState(db, account), { done: true, recovered: 0, pending: 0, problems: 0 });
      assert.equal(await recover(db, account, api), null, "nothing runs again");
      const head = { log_id: "new", epoch: 1, seq: 1 };
      await retire(db, account, head, t0 + 1000);
      assert.equal((await retainedEntries(db, account)).length, 1, "ordinary retirement keeps it");
      if (end === "shown") await outcomeShown(db, account, refused.op_id);
      else await retire(db, account, head, t0 + outcomeKeepMs + 1);
      assert.deepEqual(await retainedEntries(db, account), [], `${result}, ${end}: then it goes`);
    }
  }
});
