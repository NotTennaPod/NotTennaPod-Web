import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../src/journal/db.ts";
import { acknowledge, append, entries, installation, newAuthor, updateInstallation } from "../src/journal/journal.ts";
import { retainedEntries, takeSuccessor } from "../src/journal/successor.ts";

let n = 0;
const device = { name: "Browser", app_version: "1", capabilities: [] };
const note = (text: string) => ({ type: "test.note", targets: [], payload: { text } });

test("a successor renumbers unacknowledged facts unchanged and keeps acknowledged ones for recovery", async () => {
  const db = await openDB(indexedDB, `succ-${++n}`);
  const account = crypto.randomUUID();
  const before = await installation(db, account);
  await updateInstallation(db, account, (r) => (r.registered = true));
  const a = await newAuthor(db, account);
  const e1 = await append(db, account, a.author_id, note("acked"));
  const e2 = await append(db, account, a.author_id, note("pending 1"));
  const e3 = await append(db, account, a.author_id, note("pending 2"));
  const receipt = { op_id: e1.op_id, content_hash: "h", outcome: "applied" as const, normalized_time: 1, epoch: 1, seq: 2, index: 0, key_id: "k", mac: "m" };
  await acknowledge(db, account, [{ install_seq: 1, receipt }], { log_id: "old", epoch: 1 });
  const sent: Record<string, unknown>[] = [];
  const after = await takeSuccessor(db, account, async (b) => void sent.push(b), { freshNonce: false, device });
  assert.notEqual(after.install_id, before.install_id);
  assert.equal(after.instance_nonce, before.instance_nonce); // a restore keeps the profile's nonce
  assert.deepEqual(after.predecessors, [before.install_id]);
  assert.equal(after.next_install_seq, 3);
  assert.equal(after.acked_install_seq, 0);
  assert.equal(after.cursor, null);
  const left = await entries(db, account);
  assert.deepEqual(left.map((e) => [e.install_seq, e.op_id, e.install_id]), [[1, e2.op_id, after.install_id], [2, e3.op_id, after.install_id]]);
  assert.deepEqual(left[1]!.fact, e3.fact); // the fact itself is unchanged
  const kept = await retainedEntries(db, account);
  assert.deepEqual(kept.map((e) => e.op_id), [e1.op_id]);
  assert.equal(sent.length, 1);
});

test("a handoff interrupted after the request repeats with the same IDs", async () => {
  const db = await openDB(indexedDB, `succ-${++n}`);
  const account = crypto.randomUUID();
  await installation(db, account);
  const a = await newAuthor(db, account);
  await append(db, account, a.author_id, note("x"));
  const ids: string[] = [];
  await assert.rejects(takeSuccessor(db, account, async (b) => { ids.push(b.install_id); throw new Error("offline"); }, { freshNonce: true, device }));
  const done = await takeSuccessor(db, account, async (b) => void ids.push(b.install_id), { freshNonce: true, device });
  assert.equal(ids[0], ids[1]);
  assert.equal(done.install_id, ids[0]);
  assert.equal((await entries(db, account))[0]!.install_id, done.install_id);
});
