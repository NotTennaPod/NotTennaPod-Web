// A slow but working upload (8 KB/s) gets a multi-megabyte push through: a
// push its deadline cancels is sent again smaller, halving down to one fact,
// with each fact's op ID, slot and order unchanged; answered pushes grow the
// batch back. The server reads a whole request before it processes it, so a
// cancelled upload consumes nothing. Time runs a thousand times faster here:
// the deadline is the production one divided by 1,000, and so is the upload.
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../src/journal/db.ts";
import { append, entries, installation, newAuthor, updateInstallation } from "../src/journal/journal.ts";

(globalThis as Record<string, unknown>).BroadcastChannel = undefined;
const { Sync, pushDeadline } = await import("../src/app/sync.ts");

const lineage = { log_id: "6a1f0e2c-1111-4222-8333-944455556666", epoch: 1 };
const cursor = Buffer.from(JSON.stringify({ digest: "0".repeat(64), epoch: lineage.epoch, log_id: lineage.log_id, seq: 1 })).toString("base64url");
const speedup = 1000;
const bytesPerMs = 8 * speedup; // 8 KB/s

/** The server: the facts it consumed (by op ID, in order, with their slots), and each push's size and whether it was cancelled. */
const server = {
  consumed: [] as { op_id: string; install_seq: number }[],
  pushes: [] as { ops: number; bytes: number; cancelled: boolean }[],
};
globalThis.fetch = (async (path: string, init?: { body?: string; signal?: AbortSignal }) => {
  if (path !== "/v1/push") return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  const raw = init!.body!;
  const body = JSON.parse(raw);
  const push = { ops: body.operations.length, bytes: Buffer.byteLength(raw), cancelled: false };
  server.pushes.push(push);
  // The upload takes its time; cancelled before it is whole, the server never saw it.
  return new Promise<Response>((resolve, reject) => {
    const done = setTimeout(() => {
      const ops = body.operations as { install_seq: number; fact: { op_id: string } }[];
      const results = ops.map((o) => {
        const known = server.consumed.some((c) => c.op_id === o.fact.op_id);
        if (!known) server.consumed.push({ op_id: o.fact.op_id, install_seq: o.install_seq });
        return {
          install_seq: o.install_seq,
          status: known ? "duplicate" : "accepted",
          receipt: { op_id: o.fact.op_id, content_hash: "h", outcome: "applied", normalized_time: 0, epoch: 1, seq: 2, index: 0, key_id: "k", mac: "m" },
        };
      });
      resolve(new Response(JSON.stringify({ head: cursor, install_watermark: Math.max(0, ...ops.map((o) => o.install_seq)), results }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }, push.bytes / bytesPerMs);
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(done);
      push.cancelled = true;
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
  });
}) as unknown as typeof fetch;

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`never: ${what}`);
}

test("a slow upload gets a multi-megabyte prefix through in smaller pushes, then a later edit", async () => {
  const account = crypto.randomUUID();
  const db = await openDB(indexedDB, "slow-push");
  await installation(db, account);
  await updateInstallation(db, account, (r) => {
    r.registered = true;
    r.cursor = cursor;
    r.lineage = lineage;
  });
  const author = await newAuthor(db, account);
  // Twenty facts of about 100 KB of UTF-8 each (two bytes a character): a bulk action's prefix of 2 MB.
  for (let i = 0; i < 20; i++) await append(db, account, author.author_id, { type: "test.note", targets: [], payload: { text: "é".repeat(50_000) } });
  const journaled = await entries(db, account);
  const deadlines: number[] = [];
  const tab = new Sync(
    { db, account: { account_id: account, namespace: "n", username: "u", is_admin: false }, author, installation: await installation(db, account) } as never,
    {
      pushDeadline: (bytes) => {
        deadlines.push(bytes);
        return pushDeadline(bytes) / speedup;
      },
    },
  );
  const unsent = async () => (await entries(db, account)).filter((e) => !e.receipt).length;

  tab.schedule(0);
  await until(async () => (await unsent()) === 0, "the whole prefix is acknowledged");
  assert.ok(server.pushes[0]!.ops === 20 && server.pushes[0]!.cancelled, "the first push, whole, was cancelled at its deadline");
  assert.equal(deadlines[0], server.pushes[0]!.bytes, "the deadline counts the body's UTF-8 bytes");
  assert.deepEqual(server.consumed, journaled.map((e) => ({ op_id: e.op_id, install_seq: e.install_seq })), "each fact once, in its slot, in order");

  // A later edit goes out too.
  const later = await tab.act({ type: "test.note", targets: [], payload: { text: "later" } });
  await until(() => server.consumed.some((c) => c.op_id === later.op_id), "the later edit is pushed");
  await until(async () => (await unsent()) === 0, "nothing left to send");
});
