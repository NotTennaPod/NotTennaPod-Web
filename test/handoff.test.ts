// One successor per lineage change, durably (PROTOCOL §5, §6.11, §12), with
// tabs stopped at the worst moments: a tab is held right after one of its
// installation transactions commits (the data is written, its continuation
// waits), while another tab or load runs; a held tab that is never let go
// is one that closed. The server follows the real registration, session and
// cookie rules (fakeServer.ts).
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDB, type InstallationRow } from "../src/journal/db.ts";
import { acknowledge, append, entries, installation, newAuthor, updateInstallation } from "../src/journal/journal.ts";
import { takeSuccessor } from "../src/journal/successor.ts";
import { handlers, post } from "../src/api/http.ts";
import { FakeServer } from "./fakeServer.ts";

/** FakeChannel is BroadcastChannel between the tabs of one test. */
class FakeChannel extends EventTarget {
  static open = new Set<FakeChannel>();
  readonly name: string;
  constructor(name: string) {
    super();
    this.name = name;
    FakeChannel.open.add(this);
  }
  postMessage(data: unknown) {
    for (const c of FakeChannel.open) if (c !== this && c.name === this.name) queueMicrotask(() => c.dispatchEvent(new MessageEvent("message", { data })));
  }
  close() {
    FakeChannel.open.delete(this);
  }
}
(globalThis as Record<string, unknown>).BroadcastChannel = FakeChannel;
const { Sync } = await import("../src/app/sync.ts");
const { boot, database } = await import("../src/app/boot.ts");

type Lineage = { log_id: string; epoch: number };
/** cursorOf is a contract cursor: the canonical JSON of {digest, epoch, log_id, seq}, in that order. */
const cursorOf = (l: Lineage, seq: number) => Buffer.from(JSON.stringify({ digest: "0".repeat(64), epoch: l.epoch, log_id: l.log_id, seq })).toString("base64url");
const headOf = (l: Lineage, seq: number) => ({ cursor: cursorOf(l, seq), log_id: l.log_id, epoch: l.epoch, seq });
const device = { name: "Browser", app_version: "1", capabilities: [] };
const note = { type: "test.note", targets: [], payload: {} };

/** The server's log head, the pushes and recovery requests this browser sent, and its registration rules (per test). */
const server = {
  head: headOf({ log_id: "6a1f0e2c-1111-4222-8333-944455556666", epoch: 1 }, 1),
  pushes: [] as { install_id: string; ops: string[] }[],
  recovery: [] as string[],
  fake: null as FakeServer | null,
};
let signedOut = 0;
handlers({ signedOut: () => void signedOut++ });
globalThis.fetch = (async (path: string, init?: { body?: string }) => {
  const body = init?.body ? JSON.parse(init.body) : {};
  return server.fake!.answer(path, body, (p, b) => {
    if (p.startsWith("/v1/sync/recovery/") || p === "/v1/snapshot") server.recovery.push(p);
    if (p === "/v1/push") {
      server.pushes.push({ install_id: b.install_id, ops: b.operations.map((o: { fact: { op_id: string } }) => o.fact.op_id) });
      return {
        head: server.head.cursor,
        install_watermark: Math.max(0, ...b.operations.map((o: { install_seq: number }) => o.install_seq)),
        results: b.operations.map((o: { install_seq: number; fact: { op_id: string } }) => ({
          install_seq: o.install_seq,
          status: "accepted",
          receipt: { op_id: o.fact.op_id, content_hash: "h", outcome: "applied", normalized_time: 0, epoch: server.head.epoch, seq: server.head.seq, index: 0, key_id: "k", mac: "m" },
        })),
      };
    }
    if (p === "/v1/read/summary") return { head: server.head };
    if (p === "/v1/sync/recovery/inventory") return { results: b.entries.map((e: { op_id: string }) => ({ kind: "fact", id: e.op_id, status: "have" })) };
    return {};
  });
}) as unknown as typeof fetch;

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (await check()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`never: ${what}`);
}

/**
 * hold stops a connection's next installation transaction after it commits:
 * the tab's continuation waits until release (never, for a tab that closed).
 */
function hold(db: IDBDatabase): { reached: Promise<void>; release: () => void } {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  const released = new Promise<void>((r) => (release = r));
  const original = db.transaction.bind(db);
  db.transaction = ((stores: string | string[], ...rest: unknown[]) => {
    const t = (original as (...a: unknown[]) => IDBTransaction)(stores, ...rest);
    if (JSON.stringify([stores].flat()) !== '["installations"]' || rest[0] !== "readwrite") return t;
    db.transaction = original;
    Object.defineProperty(t, "oncomplete", {
      get: () => null,
      set: (callback: () => void) =>
        t.addEventListener("complete", () => {
          reach();
          void released.then(() => callback());
        }),
    });
    return t;
  }) as typeof db.transaction;
  return { reached, release };
}

const tabs: InstanceType<typeof Sync>[] = [];
// Every tab's postponed push runs before the process ends, so no timer outlives the tests.
test.after(async () => {
  for (const t of tabs) t.schedule(0);
  await until(() => tabs.every((t) => t.pending.get() === 0), "every tab settles");
});

let n = 0;
/** profile is a browser profile registered on the server's lineage, with its cursor and its session. */
async function profile(name = `handoff-${++n}`) {
  const account = crypto.randomUUID();
  const db = await openDB(indexedDB, name);
  const first = await installation(db, account);
  await updateInstallation(db, account, (r) => {
    r.registered = true;
    r.cursor = server.head.cursor;
    r.lineage = { log_id: server.head.log_id, epoch: server.head.epoch };
  });
  server.fake = new FakeServer(account, first.install_id, first.instance_nonce);
  signedOut = 0;
  const tab = async () => {
    const tdb = await openDB(indexedDB, name);
    const author = await newAuthor(tdb, account);
    const s = new Sync({ db: tdb, account: { account_id: account, namespace: "n", username: "u", is_admin: false }, author, installation: await installation(tdb, account) });
    tabs.push(s);
    return { sync: s, db: tdb };
  };
  const inst = () => installation(db, account);
  return { db, account, tab, inst, old: first.install_id, fake: server.fake };
}

/** restore moves the server to a new epoch of its log, as a restore from a backup does. */
function restore(): ReturnType<typeof headOf> {
  server.head = headOf({ log_id: server.head.log_id, epoch: server.head.epoch + 1 }, 1);
  return server.head;
}

const register = (b: { install_id: string; instance_nonce: string }) => post("/v1/installations/successor", b);
const offline = async (): Promise<void> => {
  throw new Error("offline");
};
/** closedAfter registers, and the tab closes before it renumbers: the server has the successor, and the browser its cookie. */
const closedAfter = async (b: { install_id: string; instance_nonce: string }) => {
  await register(b);
  throw new Error("the tab closed");
};

/** pendingChange journals a change in a tab that has shown the server's head, without letting it push yet. */
async function pendingChange(a: { sync: InstanceType<typeof Sync> }) {
  await a.sync.shown(server.head);
  a.sync.schedule(1_000_000); // the push loop shown asks for comes later
  const change = await a.sync.act(note);
  a.sync.schedule(1_000_000);
  return change;
}
const acknowledged = (p: { db: IDBDatabase; account: string }, op: string) => async () => !!(await entries(p.db, p.account)).find((e) => e.op_id === op)?.receipt;

/** seedAcknowledged journals a change the server acknowledged before a restore: the restored server may lack it. */
async function seedAcknowledged(p: { db: IDBDatabase; account: string }) {
  const author = await newAuthor(p.db, p.account);
  const acked = await append(p.db, p.account, author.author_id, note);
  const receipt = { op_id: acked.op_id, content_hash: "h", outcome: "applied" as const, normalized_time: 0, epoch: server.head.epoch, seq: 2, index: 0, key_id: "k", mac: "m" };
  await acknowledge(p.db, p.account, [{ install_seq: 1, receipt }], { log_id: server.head.log_id, epoch: server.head.epoch });
}

test("a tab closed right after showing a restored server leaves the successor and the recovery to the next load", async () => {
  const p = await profile();
  await seedAcknowledged(p);
  const head = restore();
  const before = server.recovery.length;
  const a = await p.tab();
  const closed = hold(a.db);
  void a.sync.shown(head); // its installation transaction commits; the tab then closes
  await closed.reached;
  // The next load shows the same view and pushes.
  const c = await p.tab();
  await c.sync.shown(head);
  await until(async () => (await p.inst()).recovery?.finished === true, "the recovery finishes");
  const inst = await p.inst();
  assert.deepEqual(p.fake.registrations, [inst.install_id], "one successor");
  assert.deepEqual(inst.predecessors, [p.old]);
  assert.ok(server.recovery.slice(before).includes("/v1/sync/recovery/inventory"), "the acknowledged change was offered to the restored server");
  assert.deepEqual(inst.lineage, { log_id: head.log_id, epoch: head.epoch });
  assert.equal(inst.cursor, head.cursor);
});

test("a restore one tab shows while another's push is refused takes one successor", async () => {
  server.head = headOf({ log_id: crypto.randomUUID(), epoch: 1 }, 1);
  const p = await profile();
  const head = restore();
  const a = await p.tab();
  const b = await p.tab();
  const held = hold(a.db);
  const showing = a.sync.shown(head); // tab a has recorded the new lineage, and waits
  await held.reached;
  // Tab b's push, sent before the restore, comes back lineage_mismatch: it takes the successor.
  await b.sync.successor(false, undefined, p.old);
  held.release();
  await showing;
  const inst = await p.inst();
  assert.deepEqual(p.fake.registrations, [inst.install_id], "one successor");
  assert.deepEqual(inst.predecessors, [p.old]);
  assert.deepEqual(inst.lineage, { log_id: head.log_id, epoch: head.epoch });
  assert.equal(inst.cursor, head.cursor);
  assert.equal(signedOut, 0);
});

test("a reload while another tab finishes the handoff stays signed in, on that successor", async () => {
  server.head = headOf({ log_id: crypto.randomUUID(), epoch: 1 }, 1);
  const p = await profile("nottennapod"); // boot's own database
  // The server registered the successor (the browser has its cookie), and the tab closed before renumbering.
  await assert.rejects(takeSuccessor(p.db, p.account, closedAfter, { from: p.old, freshNonce: false, device }));
  const planned = (await p.inst()).successor!.install_id;
  const bdb = await database();
  const held = hold(bdb);
  const booting = boot(); // reads the plan, and waits
  await held.reached;
  const other = await openDB(indexedDB, "nottennapod");
  await takeSuccessor(other, p.account, async () => {}, { from: p.old, freshNonce: false, device, registered: planned }); // another tab finishes it
  held.release();
  const result = await booting;
  assert.equal(result.kind, "signed_in", "an innocent reload is not signed out");
  const inst = await p.inst();
  assert.equal(inst.install_id, planned);
  assert.deepEqual(inst.predecessors, [p.old], "no installation was invented");
  assert.equal(inst.successor, undefined);
});

test("a reload whose session answer was asked before another tab's handoff stays signed in", async () => {
  server.head = headOf({ log_id: crypto.randomUUID(), epoch: 1 }, 1);
  const p = await profile("nottennapod");
  p.fake.hold.add("/v1/session");
  const booting = boot(); // asks who the session is, with the predecessor's cookie; the answer is slow
  await until(() => p.fake.held.length === 1, "boot asked for its session");
  // Meanwhile another tab takes the successor: the browser now has its cookie.
  const other = await openDB(indexedDB, "nottennapod");
  const done = await takeSuccessor(other, p.account, register, { from: p.old, freshNonce: false, device });
  p.fake.hold.delete("/v1/session");
  p.fake.release(); // the slow answer names the predecessor
  const result = await booting;
  assert.equal(result.kind, "signed_in", "a session answer from before the handoff is not a copied profile");
  assert.equal((await p.inst()).install_id, done.install_id);
  assert.equal(signedOut, 0);
});

test("a restore shown while a copied profile's successor is still to be registered recovers what the server acknowledged", async () => {
  server.head = headOf({ log_id: crypto.randomUUID(), epoch: 1 }, 1);
  const p = await profile();
  await seedAcknowledged(p);
  // A copied profile's successor (another nonce), planned while the server could not be reached.
  await assert.rejects(takeSuccessor(p.db, p.account, offline, { from: p.old, freshNonce: true, device }));
  const head = restore();
  const before = server.recovery.length;
  const a = await p.tab();
  await a.sync.shown(head);
  await until(async () => (await p.inst()).recovery?.finished === true, "the recovery finishes");
  const inst = await p.inst();
  assert.deepEqual(p.fake.registrations, [inst.install_id], "one successor, the copy's");
  assert.notEqual(inst.instance_nonce, p.fake.installations.get(p.old)!.nonce);
  assert.ok(server.recovery.slice(before).includes("/v1/sync/recovery/inventory"), "the acknowledged change was offered to the restored server");
  assert.deepEqual(inst.lineage, { log_id: head.log_id, epoch: head.epoch });
});

test("a tab finishing a handoff whose registration reached the browser before its tab closed registers nothing again", async () => {
  server.head = headOf({ log_id: crypto.randomUUID(), epoch: 1 }, 1);
  const p = await profile();
  const a = await p.tab();
  const change = await pendingChange(a);
  // The server registered the successor and the browser took its cookie; the tab closed before renumbering.
  await assert.rejects(takeSuccessor(p.db, p.account, closedAfter, { from: p.old, freshNonce: false, device }));
  const planned = (await p.inst()).successor!.install_id;
  a.sync.schedule(0);
  await until(acknowledged(p, change.op_id), "tab a's change is acknowledged");
  const inst = await p.inst();
  assert.equal(inst.install_id, planned);
  assert.deepEqual(p.fake.registrations, [planned], "registered once");
  assert.ok(server.pushes.some((x) => x.install_id === planned && x.ops.includes(change.op_id)));
  assert.equal(p.fake.unauthorized, 0);
  assert.equal(signedOut, 0);
});

test("two tabs finishing the same handoff register it once, and the browser keeps a working session", async () => {
  server.head = headOf({ log_id: crypto.randomUUID(), epoch: 1 }, 1);
  const p = await profile();
  const a = await p.tab();
  const b = await p.tab();
  const change = await pendingChange(a);
  // A successor planned while the server could not be reached: both tabs will finish it.
  await assert.rejects(takeSuccessor(p.db, p.account, offline, { from: p.old, freshNonce: false, device }));
  p.fake.hold.add("/v1/installations/successor");
  a.sync.schedule(0); // tab a registers it; the answer is slow
  await until(() => p.fake.held.length === 1, "tab a's registration is on its way");
  let bDone = false;
  const bTook = b.sync.successor(false, undefined, p.old).finally(() => (bDone = true)); // tab b's push loop finds the plan too
  await until(() => bDone || p.fake.held.length === 2, "tab b waits or registers too");
  p.fake.hold.delete("/v1/installations/successor");
  p.fake.release(true); // the later answer arrives first
  await bTook;
  await until(acknowledged(p, change.op_id), "tab a's change is acknowledged");
  b.sync.schedule(0);
  await until(async () => (await p.inst()).successor === undefined, "the handoff is finished");
  assert.equal(p.fake.registrations.length, 1, "registered once");
  assert.equal(p.fake.unauthorized, 0, "the browser's session was never revoked");
  assert.equal(signedOut, 0);
});

for (const kind of ["copied profile", "refused push"] as const) {
  test(`a tab that finds a ${kind}'s successor taken by a tab that then closed still sends its changes`, async () => {
    server.head = headOf({ log_id: crypto.randomUUID(), epoch: 1 }, 1);
    const p = await profile();
    const a = await p.tab();
    await a.sync.shown(server.head);
    a.sync.schedule(1_000_000); // the push loop shown asks for comes later
    // A successor planned (another nonce for a copy, the same one after a restore) and not yet registered.
    const freshNonce = kind === "copied profile";
    await assert.rejects(takeSuccessor(p.db, p.account, offline, { from: p.old, freshNonce, device }));
    if (!freshNonce) restore();
    const change = await a.sync.act(note);
    a.sync.schedule(1_000_000);
    const held = hold(a.db);
    a.sync.schedule(0); // tab a's push loop sees the plan, and waits
    await held.reached;
    // Another tab registers and renumbers, and closes before it gives the profile its cursor.
    const other = await openDB(indexedDB, `handoff-${n}`);
    const done: InstallationRow = await takeSuccessor(other, p.account, register, { from: p.old, freshNonce, device });
    held.release();
    await until(acknowledged(p, change.op_id), "tab a's change is acknowledged");
    assert.ok(server.pushes.some((x) => x.install_id === done.install_id && x.ops.includes(change.op_id)), "sent under the successor");
    const inst = await p.inst();
    assert.equal(inst.install_id, done.install_id);
    assert.equal(inst.cursor, server.head.cursor);
    assert.deepEqual(inst.lineage, { log_id: server.head.log_id, epoch: server.head.epoch });
    assert.equal(p.fake.unauthorized, 0);
  });
}
