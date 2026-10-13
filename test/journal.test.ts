import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDB, type Fact } from "../src/journal/db.ts";
import { acknowledge, append, entries, installation, newAuthor, outcomeKeepMs, outcomeShown, retire, unacknowledged, updateInstallation } from "../src/journal/journal.ts";
import { pushAll, pushOnce, type PushResponse, type PushResult } from "../src/journal/pusher.ts";
import { canonical } from "../src/journal/jcs.ts";
import { takeSuccessor } from "../src/journal/successor.ts";

let n = 0;
async function fresh() {
  const db = await openDB(indexedDB, `test-${++n}`);
  const account = crypto.randomUUID();
  await installation(db, account);
  await updateInstallation(db, account, (r) => {
    r.registered = true;
    r.cursor = cursor(1);
  });
  return { db, account };
}

// Two lineages' log IDs; a cursor is the canonical JSON of {digest, epoch, log_id, seq} (PROTOCOL §3.2).
const LOG1 = "6a1f0e2c-1111-4222-8333-944455556666";
const LOG2 = "6a1f0e2c-2222-4222-8333-944455556666";

function cursor(seq: number, log = LOG1, epoch = 1): string {
  const json = JSON.stringify({ digest: "0".repeat(64), epoch, log_id: log, seq });
  return Buffer.from(json).toString("base64url");
}

const note = (text: string) => ({ type: "test.note", targets: [], payload: { text } });

/** A server that consumes contiguous slots, as PROTOCOL §6.4 does. */
function server(opts: { missing?: string[] } = {}) {
  let consumed = 0;
  let seq = 1;
  const facts: Fact[] = [];
  const parts = new Map<string, string[]>();
  const requests: Record<string, unknown>[] = [];
  const send = async (body: Record<string, unknown>): Promise<PushResponse> => {
    requests.push(body);
    const results: PushResult[] = [];
    for (const op of body.operations as { install_seq: number; fact?: Fact; part?: Record<string, unknown> }[]) {
      if (op.install_seq <= consumed) {
        results.push({ install_seq: op.install_seq, status: "duplicate", receipt: receiptOf(facts[op.install_seq - 1]!, seq) });
        continue;
      }
      if (op.install_seq > consumed + 1) {
        results.push({ install_seq: op.install_seq, status: "gap" });
        break;
      }
      let fact = op.fact;
      if (op.part) {
        const p = op.part as { transaction_id: string; part_index: number; part_count: number; data: string };
        const list = parts.get(p.transaction_id) ?? new Array(p.part_count).fill("");
        list[p.part_index] = Buffer.from(p.data, "base64url").toString("utf8");
        parts.set(p.transaction_id, list);
        if (list.some((x) => x === "")) {
          results.push({ install_seq: op.install_seq, status: "part_stored", parts_present: list.flatMap((x, i) => (x ? [i] : [])) });
          break;
        }
        fact = JSON.parse(list.join("")) as Fact;
      }
      if (opts.missing && fact!.dependencies.some((d) => opts.missing!.includes(d))) {
        results.push({ install_seq: op.install_seq, status: "dependency_missing", missing: opts.missing });
        break;
      }
      consumed++;
      seq++;
      facts.push(fact!);
      results.push({ install_seq: op.install_seq, status: "accepted", receipt: receiptOf(fact!, seq) });
    }
    return { head: cursor(seq), install_watermark: consumed, results };
  };
  return { send, facts, requests, get consumed() { return consumed; } };
}

function receiptOf(f: Fact, seq: number) {
  return { op_id: f.op_id, content_hash: "h", outcome: "applied" as const, normalized_time: 1, epoch: 1, seq, index: 0, key_id: "k", mac: "m" };
}

test("append allocates contiguous slots and chains each author", async () => {
  const { db, account } = await fresh();
  const a = await newAuthor(db, account);
  const e1 = await append(db, account, a.author_id, note("one"));
  const e2 = await append(db, account, a.author_id, { ...note("two"), dependencies: ["ffffffff-0000-4000-8000-000000000000"] });
  assert.equal(e1.install_seq, 1);
  assert.equal(e2.install_seq, 2);
  assert.equal(e1.fact.author_seq, 1);
  assert.equal(e2.fact.author_seq, 2);
  assert.equal(e2.fact.previous_op_id, e1.op_id);
  assert.deepEqual(e2.fact.dependencies, [e1.op_id, "ffffffff-0000-4000-8000-000000000000"].sort());
  assert.equal(e1.fact.previous_op_id, undefined);
});

test("tabs appending at once never share a slot or an author position", async () => {
  const { db, account } = await fresh();
  const tabs = await Promise.all([newAuthor(db, account), newAuthor(db, account), newAuthor(db, account)]);
  await Promise.all(tabs.flatMap((a) => Array.from({ length: 20 }, (_, i) => append(db, account, a.author_id, note(`${a.author_id}-${i}`)))));
  const all = await entries(db, account);
  assert.deepEqual(all.map((e) => e.install_seq), Array.from({ length: 60 }, (_, i) => i + 1));
  for (const a of tabs) {
    const mine = all.filter((e) => e.fact.author_id === a.author_id).map((e) => e.fact.author_seq);
    assert.deepEqual(mine, Array.from({ length: 20 }, (_, i) => i + 1));
  }
});

test("an action survives a reload before it is pushed", async () => {
  const name = `reload-${++n}`;
  const account = crypto.randomUUID();
  let db = await openDB(indexedDB, name);
  await installation(db, account);
  const a = await newAuthor(db, account);
  await append(db, account, a.author_id, note("kept"));
  db.close();
  db = await openDB(indexedDB, name);
  const left = await unacknowledged(db, account);
  assert.equal(left.length, 1);
  assert.equal(left[0]!.fact.payload.text, "kept");
});

test("pushes, acknowledges the contiguous prefix, and retires after a later view", async () => {
  const { db, account } = await fresh();
  const a = await newAuthor(db, account);
  for (let i = 0; i < 5; i++) await append(db, account, a.author_id, note(`n${i}`));
  const s = server();
  const out = await pushAll(db, account, s.send);
  assert.equal(out.remaining, 0);
  assert.equal(s.consumed, 5);
  assert.equal((await unacknowledged(db, account)).length, 0);
  // Retired only once a view at or after the receipts' commits is shown.
  assert.equal(await retire(db, account, { log_id: LOG1, epoch: 1, seq: 3 }), 2);
  assert.equal(await retire(db, account, { log_id: LOG2, epoch: 1, seq: 99 }), 0);
  assert.equal(await retire(db, account, { log_id: LOG1, epoch: 1, seq: 6 }), 3);
  assert.equal((await entries(db, account)).length, 0);
});

test("dependency_missing keeps the entry, says what is awaited, and pushes nothing after it", async () => {
  const { db, account } = await fresh();
  const a = await newAuthor(db, account);
  const missing = "aaaaaaaa-0000-4000-8000-000000000000";
  await append(db, account, a.author_id, note("first"));
  await append(db, account, a.author_id, { ...note("needs"), dependencies: [missing] });
  await append(db, account, a.author_id, note("after"));
  const s = server({ missing: [missing] });
  const out = await pushAll(db, account, s.send);
  assert.deepEqual(out.waiting, [missing]);
  assert.equal(s.consumed, 1);
  const left = await unacknowledged(db, account);
  assert.equal(left.length, 2);
  assert.deepEqual(left[0]!.waiting, [missing]);
});

test("a fact above the unframed bound goes in parts, one per request", async () => {
  const { db, account } = await fresh();
  const a = await newAuthor(db, account);
  await append(db, account, a.author_id, note("small"));
  const big = Array.from({ length: 3000 }, () => crypto.randomUUID());
  await append(db, account, a.author_id, { type: "history.clear", targets: [], payload: {}, dependencies: big });
  await append(db, account, a.author_id, note("after"));
  const s = server();
  const bounds = { max_operations: 500, max_request_bytes: 4 << 20, max_unframed_fact_bytes: 32 << 10, max_part_bytes: 32 << 10, max_part_count: 64 };
  const out = await pushAll(db, account, s.send, bounds);
  assert.equal(out.remaining, 0);
  assert.equal(s.consumed, 3);
  assert.equal(canonical(s.facts[1]), canonical((await entries(db, account))[1]!.fact));
  const partRequests = s.requests.filter((r) => (r.operations as { part?: unknown }[]).some((o) => o.part));
  assert.ok(partRequests.length >= 4, `parts in ${partRequests.length} requests`);
  for (const r of partRequests) assert.equal((r.operations as unknown[]).length, 1);
});

test("a paused installation pushes nothing until resumed", async () => {
  const { db, account } = await fresh();
  const a = await newAuthor(db, account);
  await append(db, account, a.author_id, note("x"));
  await updateInstallation(db, account, (r) => (r.paused = "version_unsupported"));
  const s = server();
  const out = await pushOnce(db, account, s.send);
  assert.equal(out.stopped, "paused");
  assert.equal(s.requests.length, 0);
});

test("secrets go with their fact's push and stay until the entry is retired", async () => {
  const { db, account } = await fresh();
  const a = await newAuthor(db, account);
  const secret = { secret_id: crypto.randomUUID(), username: "alice", password: "s3cret", approved_origins: ["https://feeds.example:443"] };
  await append(db, account, a.author_id, { ...note("subscribe"), secrets: [secret] });
  const s = server();
  await pushAll(db, account, s.send);
  assert.deepEqual((s.requests[0]!.secrets as unknown[])[0], secret);
  // Recovery may have to send the fact again, so acknowledgement keeps them.
  const left = await entries(db, account);
  assert.ok(left[0]!.receipt);
  assert.deepEqual(left[0]!.secrets, [secret]);
});

test("a framed fact keeps its transaction and stored parts across a reload", async () => {
  const { db, account } = await fresh();
  const a = await newAuthor(db, account);
  const big = Array.from({ length: 3000 }, () => crypto.randomUUID());
  await append(db, account, a.author_id, { type: "history.clear", targets: [], payload: {}, dependencies: big });
  const s = server();
  const bounds = { max_operations: 500, max_request_bytes: 4 << 20, max_unframed_fact_bytes: 32 << 10, max_part_bytes: 32 << 10, max_part_count: 64 };
  await pushOnce(db, account, s.send, bounds);
  await pushOnce(db, account, s.send, bounds);
  // A reload: nothing in memory survives, only the journal.
  const out = await pushAll(db, account, s.send, bounds);
  assert.equal(out.remaining, 0);
  const parts = s.requests.flatMap((r) => (r.operations as { part?: { transaction_id: string; part_index: number } }[]).flatMap((o) => (o.part ? [o.part] : [])));
  assert.equal(new Set(parts.map((p) => p.transaction_id)).size, 1);
  assert.equal(new Set(parts.map((p) => p.part_index)).size, parts.length, "no part is sent twice");
});

test("a late answer to a predecessor's request acknowledges nothing", async () => {
  const { db, account } = await fresh();
  const a = await newAuthor(db, account);
  const e = await append(db, account, a.author_id, note("x"));
  const receipt = receiptOf(e.fact, 2);
  const inst = await acknowledge(db, account, [{ install_seq: 1, receipt }], { log_id: LOG1, epoch: 1 }, crypto.randomUUID());
  assert.equal(inst.acked_install_seq, 0);
  assert.equal((await unacknowledged(db, account)).length, 1);
});

test("a handoff the server finished is completed without asking it again", async () => {
  const { db, account } = await fresh();
  const a = await newAuthor(db, account);
  await append(db, account, a.author_id, note("x"));
  const planned = { install_id: crypto.randomUUID(), instance_nonce: crypto.randomUUID() };
  await updateInstallation(db, account, (r) => (r.successor = planned));
  // boot: the session is already bound to the planned successor, so its send does nothing.
  let sent = 0;
  const inst = await takeSuccessor(db, account, async () => void sent++, { freshNonce: false, device: { name: "t", app_version: "0", capabilities: [] } });
  assert.equal(inst.install_id, planned.install_id);
  assert.equal(inst.successor, undefined);
  assert.equal((await unacknowledged(db, account))[0]!.install_id, planned.install_id);
});

test("a refusal its tab awaits outlasts retirement until shown, or for a day; other outcomes retire as before", async () => {
  const { db, account } = await fresh();
  const author = await newAuthor(db, account);
  const t0 = Date.now();
  const refused = await append(db, account, author.author_id, { ...note("refused"), awaited: true }, t0);
  const applied = await append(db, account, author.author_id, { ...note("applied"), awaited: true }, t0);
  const plain = await append(db, account, author.author_id, note("refused, not awaited"), t0);
  const receipt = (op: string, outcome: "applied" | "not_applied") =>
    ({ op_id: op, content_hash: "h", outcome, reason: outcome === "applied" ? undefined : "generation_closed", normalized_time: 0, epoch: 1, seq: 2, index: 0, key_id: "k", mac: "m" });
  await acknowledge(db, account, [
    { install_seq: refused.install_seq, receipt: receipt(refused.op_id, "not_applied") },
    { install_seq: applied.install_seq, receipt: receipt(applied.op_id, "applied") },
    { install_seq: plain.install_seq, receipt: receipt(plain.op_id, "not_applied") },
  ], { log_id: LOG1, epoch: 1 });
  const head = { log_id: LOG1, epoch: 1, seq: 2 };
  await retire(db, account, head, t0 + 1000);
  assert.deepEqual((await entries(db, account)).map((e) => e.op_id), [refused.op_id]);
  await retire(db, account, head, t0 + outcomeKeepMs + 1);
  assert.deepEqual(await entries(db, account), [], "a tab that closed without showing it holds it a day at most");
  // Shown by its tab: the next retirement drops it.
  const again = await append(db, account, author.author_id, { ...note("refused again"), awaited: true }, t0);
  await acknowledge(db, account, [{ install_seq: again.install_seq, receipt: receipt(again.op_id, "not_applied") }], { log_id: LOG1, epoch: 1 });
  await retire(db, account, head, t0 + 1000);
  assert.equal((await entries(db, account)).length, 1);
  await outcomeShown(db, account, again.op_id);
  await retire(db, account, head, t0 + 1000);
  assert.deepEqual(await entries(db, account), []);
});
