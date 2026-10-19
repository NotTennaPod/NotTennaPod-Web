// A push whose connection stalls (a laptop waking from sleep, flaky Wi-Fi)
// never blocks sync: unanswered by its deadline it is cancelled and sent again
// with the same facts in the same slots, which the server answers as it did
// if the first request reached it (PROTOCOL §6.4). Later changes then go out.
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../src/journal/db.ts";
import { entries, installation, newAuthor, updateInstallation } from "../src/journal/journal.ts";

(globalThis as Record<string, unknown>).BroadcastChannel = undefined;
const { Sync } = await import("../src/app/sync.ts");

const lineage = { log_id: "6a1f0e2c-1111-4222-8333-944455556666", epoch: 1 };
const cursor = Buffer.from(JSON.stringify({ digest: "0".repeat(64), epoch: lineage.epoch, log_id: lineage.log_id, seq: 1 })).toString("base64url");
const note = { type: "test.note", targets: [], payload: {} };

/** The server: the facts it consumed (once each, by op ID), and the pushes sent; `stall` makes the next push's answer never come back. */
const server = {
  consumed: new Map<string, number>(), // op ID → its slot
  pushes: [] as { ops: { install_seq: number; op_id: string }[]; signal: AbortSignal | undefined }[],
  stall: false,
};
globalThis.fetch = (async (path: string, init?: { body?: string; signal?: AbortSignal }) => {
  const body = init?.body ? JSON.parse(init.body) : {};
  if (path !== "/v1/push") return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  const ops = body.operations as { install_seq: number; fact: { op_id: string } }[];
  server.pushes.push({ ops: ops.map((o) => ({ install_seq: o.install_seq, op_id: o.fact.op_id })), signal: init?.signal });
  // The request reaches the server, which consumes it; a known op ID is a duplicate with its original receipt.
  const results = ops.map((o) => {
    const known = server.consumed.has(o.fact.op_id);
    if (!known) server.consumed.set(o.fact.op_id, o.install_seq);
    return {
      install_seq: o.install_seq,
      status: known ? "duplicate" : "accepted",
      receipt: { op_id: o.fact.op_id, content_hash: "h", outcome: "applied", normalized_time: 0, epoch: 1, seq: 2, index: 0, key_id: "k", mac: "m" },
    };
  });
  const answer = new Response(JSON.stringify({ head: cursor, install_watermark: Math.max(0, ...ops.map((o) => o.install_seq)), results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  if (!server.stall) return answer;
  server.stall = false;
  // The answer never comes back; only cancelling the request ends it, as fetch does.
  return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError"))));
}) as unknown as typeof fetch;

/** until waits for a condition (a deadline runs on a real timer). */
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`never: ${what}`);
}

test("a push that is never answered is cancelled at its deadline and sent again with the same facts and slots; later changes go out", async () => {
  const account = crypto.randomUUID();
  const db = await openDB(indexedDB, "stalled-push");
  await installation(db, account);
  await updateInstallation(db, account, (r) => {
    r.registered = true;
    r.cursor = cursor;
    r.lineage = lineage;
  });
  const author = await newAuthor(db, account);
  const tab = new Sync(
    { db, account: { account_id: account, namespace: "n", username: "u", is_admin: false }, author, installation: await installation(db, account) } as never,
    { pushDeadline: () => 100 },
  );
  const journaled = async () => (await entries(db, account)).map((e) => ({ install_seq: e.install_seq, op_id: e.op_id, acknowledged: !!e.receipt }));

  server.stall = true;
  await tab.act(note);
  await until(() => server.pushes.length === 1, "the first push is sent");
  // While it hangs, another change is made.
  await tab.act(note);
  await until(() => server.pushes.length >= 2, "the push loop sends again");
  await until(async () => (await journaled()).every((f) => f.acknowledged), "both are acknowledged");
  const facts = await journaled();
  assert.ok(server.pushes[0]!.signal?.aborted, "the stalled request was cancelled");
  assert.deepEqual(server.pushes[1]!.ops[0], server.pushes[0]!.ops[0], "the stalled fact again, in its slot");
  assert.deepEqual(server.pushes.slice(1).flatMap((x) => x.ops), facts.map(({ install_seq, op_id }) => ({ install_seq, op_id })), "then the second change after it");
  assert.deepEqual([...server.consumed.values()], [1, 2], "each consumed once, in its slot");

  // A later change goes out at once.
  const sent = server.pushes.length;
  await tab.act(note);
  await until(() => server.pushes.length === sent + 1, "a later change is pushed");
  await until(() => tab.pending.get() === 0, "nothing left to send");
});
