// A server that refuses this browser's facts as too new (version_unsupported,
// PROTOCOL §10.2: an image rolled back while a tab runs newer app code) pauses
// pushing until it is updated. The pause is not for good: a page load and a
// reconnect of the event stream send the same facts again, unchanged, and the
// journal never loses one to recover.
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../src/journal/db.ts";
import { entries, installation, newAuthor, updateInstallation } from "../src/journal/journal.ts";

(globalThis as Record<string, unknown>).BroadcastChannel = undefined;
/** FakeEventSource is the tab's event stream: a test opens it again as a reconnect does. */
class FakeEventSource extends EventTarget {
  static CLOSED = 2;
  static last: FakeEventSource | null = null;
  readyState = 1;
  constructor(_url: string) {
    super();
    FakeEventSource.last = this;
  }
  close() {
    this.readyState = 2;
  }
}
Object.assign(globalThis, { EventSource: FakeEventSource, window: new EventTarget(), document: Object.assign(new EventTarget(), { visibilityState: "visible" }) });
const { Sync } = await import("../src/app/sync.ts");

const lineage = { log_id: "6a1f0e2c-1111-4222-8333-944455556666", epoch: 1 };
const cursor = Buffer.from(JSON.stringify({ digest: "0".repeat(64), epoch: lineage.epoch, log_id: lineage.log_id, seq: 1 })).toString("base64url");
const note = { type: "test.note", targets: [], payload: {} };

/** The server: rolled back (it refuses the browser's facts as too new) or updated, and the pushes it was sent. */
const server = { updated: false, pushes: [] as { install_seq: number; op_id: string }[][] };
globalThis.fetch = (async (path: string, init?: { body?: string }) => {
  const body = init?.body ? JSON.parse(init.body) : {};
  let out: unknown = {};
  if (path === "/v1/push") {
    const ops = body.operations as { install_seq: number; fact: { op_id: string } }[];
    server.pushes.push(ops.map((o) => ({ install_seq: o.install_seq, op_id: o.fact.op_id })));
    out = {
      head: cursor,
      install_watermark: server.updated ? Math.max(0, ...ops.map((o) => o.install_seq)) : body.acked_install_seq,
      results: server.updated
        ? ops.map((o) => ({
            install_seq: o.install_seq,
            status: "accepted",
            receipt: { op_id: o.fact.op_id, content_hash: "h", outcome: "applied", normalized_time: 0, epoch: 1, seq: 2, index: 0, key_id: "k", mac: "m" },
          }))
        : [{ install_seq: ops[0]!.install_seq, status: "version_unsupported" }], // processing stops there; nothing is consumed
    };
  }
  return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
}) as unknown as typeof fetch;

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (await check()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`never: ${what}`);
}

test("a push paused by a server too old for its facts resumes once the server is updated, with the same facts", async () => {
  const account = crypto.randomUUID();
  const db = await openDB(indexedDB, "version-pause");
  await installation(db, account);
  await updateInstallation(db, account, (r) => {
    r.registered = true;
    r.cursor = cursor;
    r.lineage = lineage;
  });
  /** load is a page load of the profile: its own author and Sync. */
  const load = async () => {
    const tdb = await openDB(indexedDB, "version-pause");
    const author = await newAuthor(tdb, account);
    return new Sync({ db: tdb, account: { account_id: account, namespace: "n", username: "u", is_admin: false }, author, installation: await installation(tdb, account) });
  };
  const paused = async () => (await installation(db, account)).paused;
  const journaled = async () => (await entries(db, account)).map((e) => ({ install_seq: e.install_seq, op_id: e.op_id, acknowledged: !!e.receipt }));

  // The server is rolled back: this tab's change is refused as too new, and pushing pauses.
  const a = await load();
  const stop = a.start();
  FakeEventSource.last!.dispatchEvent(new Event("open")); // the event stream's first opening
  await a.act(note);
  await until(async () => (await paused()) === "version_unsupported" && a.paused.get() === "paused", "pushing pauses");
  await a.act(note);
  await until(() => a.pending.get() === 2, "the second change is journaled");
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); // its push loop runs
  assert.equal(server.pushes.length, 1, "no push while paused");
  const facts = await journaled();
  assert.deepEqual(facts.map((f) => f.acknowledged), [false, false]);

  // A page load while the server is still old (a reload, or signing in again): the facts are sent again, and refused again.
  const b = await load();
  b.schedule(0);
  await until(() => server.pushes.length === 2, "the page load sends them again");
  await until(async () => (await paused()) === "version_unsupported", "pushing pauses again");
  assert.deepEqual(server.pushes[1], facts.map(({ install_seq, op_id }) => ({ install_seq, op_id })), "the same facts, in their slots");

  // The server is updated: it restarts, so the running tab's event stream reconnects, and pushing resumes.
  server.updated = true;
  FakeEventSource.last!.dispatchEvent(new Event("open"));
  await until(async () => (await journaled()).every((f) => f.acknowledged), "the changes are acknowledged");
  assert.deepEqual(server.pushes.at(-1), facts.map(({ install_seq, op_id }) => ({ install_seq, op_id })), "sent as they were journaled");
  assert.deepEqual((await journaled()).map(({ install_seq, op_id }) => ({ install_seq, op_id })), facts.map(({ install_seq, op_id }) => ({ install_seq, op_id })), "nothing journaled was lost or changed");
  assert.equal(await paused(), null);
  await until(() => a.paused.get() === null && a.pending.get() === 0, "the tab no longer says pushing is paused");
  stop();
  b.schedule(0);
  await until(() => b.pending.get() === 0, "the other page load settles");
});
