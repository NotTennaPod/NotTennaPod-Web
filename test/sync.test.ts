// A change's outcome reaches the tab that made it, whichever of the profile's
// tabs pushed it: the pushing tab's receipts reach the others at once, a stored
// receipt is found by the next push loop, and a refusal outlasts retirement,
// and the recovery after a server restore, until the tab that made the change
// has shown it.
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDB, type Receipt } from "../src/journal/db.ts";
import { entries, installation, newAuthor, retire, updateInstallation } from "../src/journal/journal.ts";
import { pushAll, type PushResponse } from "../src/journal/pusher.ts";
import { retainedEntries, takeSuccessor } from "../src/journal/successor.ts";
import { FakeServer } from "./fakeServer.ts";

/** FakeChannel is BroadcastChannel between the tabs of one test: a message reaches every other channel of its name. */
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

const head = { log_id: "6a1f0e2c-1111-4222-8333-944455556666", epoch: 1, seq: 1 };
// A contract cursor: the canonical JSON of {digest, epoch, log_id, seq}, in that order.
const cursor = Buffer.from(JSON.stringify({ digest: "0".repeat(64), epoch: head.epoch, log_id: head.log_id, seq: head.seq })).toString("base64url");
const refusal = { outcome: "not_applied", reason: "generation_closed" } as const;

/** answer is the server's reply to a push: every operation refused with generation_closed. */
function answer(body: { operations: { install_seq: number; fact: { op_id: string } }[] }): PushResponse {
  return {
    head: cursor,
    install_watermark: Math.max(0, ...body.operations.map((o) => o.install_seq)),
    results: body.operations.map((o) => ({
      install_seq: o.install_seq,
      status: "accepted",
      receipt: { op_id: o.fact.op_id, content_hash: "h", ...refusal, normalized_time: 0, epoch: 1, seq: 1, index: 0, key_id: "k", mac: "m" },
    })),
  };
}

let pushes = 0;
/** successors are the successor installations registered: a tab finishing another's plan repeats its request with the same IDs (idempotent, PROTOCOL §5). */
const successors = new Set<string>();
/** inventory is the restored server's answer for each recovered entry: it has it, or needs it uploaded (then joined). */
let inventory: "have" | "need" = "have";
const recoveryCalls: string[] = [];
/** server follows the real registration, session and cookie rules where a test sets it (fakeServer.ts). */
let server: FakeServer | null = null;
globalThis.fetch = (async (path: string, init: { body?: string }) => {
  const body = init.body ? JSON.parse(init.body) : {};
  if (server) {
    const answer = await server.answer(path, body, (p, b) => JSON.parse(answerOf(p, b)));
    if (path === "/v1/installations/successor" && answer.ok) successors.add(body.install_id);
    return answer;
  }
  if (path === "/v1/installations/successor") successors.add(body.install_id);
  return new Response(answerOf(path, body), { status: 200, headers: { "Content-Type": "application/json" } });
}) as unknown as typeof fetch;

function answerOf(path: string, body: Record<string, any>): string {
  let out: unknown = {};
  if (path === "/v1/push") {
    pushes++;
    out = answer(body as Parameters<typeof answer>[0]);
  } else if (path === "/v1/sync/recovery/inventory") {
    out = { results: body.entries.map((e: { op_id: string }) => ({ kind: "fact", id: e.op_id, status: inventory })) };
  } else if (path === "/v1/sync/recovery/upload") {
    out = { head: cursor, results: body.entries.map((e: { receipt: Receipt }) => ({ kind: "fact", id: e.receipt.op_id, status: "joined" })) };
  }
  if (path.startsWith("/v1/sync/recovery/") || path === "/v1/snapshot") recoveryCalls.push(path);
  return JSON.stringify(out);
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("the condition never held");
}

const tabs: InstanceType<typeof Sync>[] = [];
// Every tab's postponed push runs before the process ends, so no timer outlives the tests.
test.after(async () => {
  for (const t of tabs) t.schedule(0);
  await until(() => tabs.every((t) => t.pending.get() === 0));
});

let n = 0;
/** profile is one browser profile signed in to one account: tab() opens a tab with its own author and Sync. */
async function profile() {
  const name = `sync-${++n}`;
  const account = crypto.randomUUID();
  const db = await openDB(indexedDB, name);
  await installation(db, account);
  await updateInstallation(db, account, (r) => {
    r.registered = true;
    r.cursor = cursor;
    r.lineage = { log_id: head.log_id, epoch: head.epoch };
  });
  const tab = async () => {
    const tdb = await openDB(indexedDB, name);
    const author = await newAuthor(tdb, account);
    const s = new Sync({ db: tdb, account: { account_id: account, namespace: "n", username: "u", is_admin: false }, author, installation: await installation(tdb, account) });
    tabs.push(s);
    return s;
  };
  return { db, account, tab };
}

/** made journals a change in tab a, as an episode action does, and waits for its outcome, without letting a push it yet. */
async function made(a: InstanceType<typeof Sync>) {
  const entry = await a.act({ type: "favorite.set", targets: [], payload: {}, awaited: true });
  a.schedule(1_000_000); // tab a's own push comes later
  let got: Receipt | null | undefined;
  void a.outcome(entry.op_id).then((r) => (got = r));
  return { entry, got: () => got };
}

test("another tab's push of a change reaches the tab that made it at once", async () => {
  const p = await profile();
  const a = await p.tab();
  const b = await p.tab();
  const change = await made(a);
  b.schedule(0); // tab b pushes the profile's journal, a's change with it
  await until(() => change.got() !== undefined);
  assert.deepEqual([change.got()?.op_id, change.got()?.outcome, change.got()?.reason], [change.entry.op_id, "not_applied", "generation_closed"]);
  // b showed a view since and retired the entry: a's own push loop finds nothing to send and nothing to wait for.
  await retire(p.db, p.account, head);
  const before = pushes;
  a.schedule(0);
  await until(() => a.pending.get() === 0);
  assert.equal(pushes, before);
});

test("a receipt another tab stored is found by the next push loop, even after that tab retired the entry", async () => {
  // The other tab's receipts never reached this one (its channel was gone): the journal still has them.
  const p = await profile();
  const a = await p.tab();
  const change = await made(a);
  await pushAll(p.db, p.account, async (body) => answer(body as never));
  assert.equal((await entries(p.db, p.account))[0]!.receipt?.outcome, "not_applied");
  a.schedule(0);
  await until(() => change.got() !== undefined);
  assert.deepEqual([change.got()?.outcome, change.got()?.reason], ["not_applied", "generation_closed"]);
  // Acknowledged by another tab, which then showed its effect (retirement), before this one looked: the refusal is kept for it.
  const later = await made(a);
  await pushAll(p.db, p.account, async (body) => answer(body as never));
  await retire(p.db, p.account, head);
  const kept = async () => (await entries(p.db, p.account)).find((e) => e.op_id === later.entry.op_id);
  assert.ok(await kept(), "kept until the tab that made it has its outcome");
  a.schedule(0);
  await until(() => later.got() !== undefined);
  assert.deepEqual([later.got()?.outcome, later.got()?.reason], ["not_applied", "generation_closed"]);
  // Consumed, durably: the next retirement drops it like any other.
  await until(async () => !(await kept())?.awaited);
  await retire(p.db, p.account, head);
  assert.equal(await kept(), undefined);
});

test("the refused episode action's snackbar shows in the tab that made it, after another tab pushed and retired it", async () => {
  const { setFavorite } = await import("../src/ui/episodeActions.ts");
  const gen = "g1:" + "a".repeat(64);
  const row = {
    episode_id: "e1:" + "1".repeat(64),
    podcast_id: "p1:" + "b".repeat(64),
    records: { identity: { value: { podcast_id: "p1:" + "b".repeat(64), occurrence: { k: "rss-guid", v: "g1", guid: "g1" } }, provenance: [] } },
    podcast: { generation_id: gen },
  } as never;
  const p = await profile();
  const a = await p.tab();
  await setFavorite(a, [row], true);
  a.schedule(1_000_000); // tab a's own push comes later
  await pushAll(p.db, p.account, async (body) => answer(body as never)); // another tab pushes it, its receipts never reach a
  await retire(p.db, p.account, head); // and shows a view that retires it
  a.schedule(0);
  await until(() => a.notices.get().some((n) => n.text === "No subscriptions"));
  for (const n of a.notices.get()) a.dismiss(n.id);
});

test("a refusal the restore's recovery finds on the server is still shown by the tab that made it", async () => {
  const { setFavorite } = await import("../src/ui/episodeActions.ts");
  const row = {
    episode_id: "e1:" + "1".repeat(64),
    podcast_id: "p1:" + "b".repeat(64),
    records: { identity: { value: { podcast_id: "p1:" + "b".repeat(64), occurrence: { k: "rss-guid", v: "g1", guid: "g1" } }, provenance: [] } },
    podcast: { generation_id: "g1:" + "a".repeat(64) },
  } as never;
  for (const result of ["have", "need"] as const) {
    inventory = result;
    recoveryCalls.length = 0;
    const p = await profile();
    const a = await p.tab();
    await setFavorite(a, [row], true);
    a.schedule(1_000_000); // tab a's own push comes later
    await pushAll(p.db, p.account, async (body) => answer(body as never)); // another tab pushes it; its receipts never reach a
    await retire(p.db, p.account, head); // kept for a, as a refusal a waits for
    // The server is restored: another tab takes the successor, and the acknowledged entry is kept aside for recovery.
    await takeSuccessor(p.db, p.account, async () => {}, { from: (await installation(p.db, p.account)).install_id, freshNonce: false, device: { name: "b", app_version: "1", capabilities: [] }, recovery: true });
    a.schedule(0); // a's loop runs the recovery first (inventory: have, or need and then joined), then looks for its outcomes
    await until(() => a.notices.get().some((n) => n.text === "No subscriptions"));
    assert.ok(recoveryCalls.includes(result === "have" ? "/v1/sync/recovery/inventory" : "/v1/sync/recovery/upload"), recoveryCalls.join());
    assert.ok(recoveryCalls.includes("/v1/sync/recovery/finish"), "the recovery finished without it");
    // Shown: nothing of it is kept any longer.
    await until(async () => (await retainedEntries(p.db, p.account)).length === 0);
    assert.equal((await installation(p.db, p.account)).recovery?.finished, true);
    for (const n of a.notices.get()) a.dismiss(n.id);
  }
});

test("a late view of a lineage the profile left changes nothing: no successor, and the lineage never goes back", async () => {
  const p = await profile();
  const first = await installation(p.db, p.account);
  server = new FakeServer(p.account, first.install_id, first.instance_nonce);
  const a = await p.tab();
  const b = await p.tab();
  const lineage = async () => (await installation(p.db, p.account)).lineage;
  // The server was restored: a new epoch of its log. The profile takes a successor and retires the old epoch.
  await a.shown({ cursor, log_id: head.log_id, epoch: 2, seq: 1 });
  assert.equal(successors.size, 1);
  assert.deepEqual(await lineage(), { log_id: head.log_id, epoch: 2 });
  assert.deepEqual((await installation(p.db, p.account)).retired_lineages, [{ log_id: head.log_id, epoch: 1 }]);
  // A view answered before the restore arrives late, in this tab and in one that never saw the restore.
  for (const tab of [a, b]) {
    await tab.shown({ cursor, log_id: head.log_id, epoch: 1, seq: 9 });
    assert.equal(successors.size, 1, "no successor for a late view");
    assert.deepEqual(await lineage(), { log_id: head.log_id, epoch: 2 });
  }
  // The account's log is replaced: the log it leaves is retired too, and its late views change nothing.
  const replaced = crypto.randomUUID();
  await b.shown({ cursor, log_id: replaced, epoch: 1, seq: 1 });
  assert.equal(successors.size, 2);
  assert.deepEqual(await lineage(), { log_id: replaced, epoch: 1 });
  await a.shown({ cursor, log_id: head.log_id, epoch: 2, seq: 5 });
  assert.equal(successors.size, 2);
  assert.deepEqual(await lineage(), { log_id: replaced, epoch: 1 });
  // A successor the push asks for (lineage_mismatch) retires the lineage it leaves as well.
  await a.successor(false, { cursor, log_id: replaced, epoch: 2, seq: 1 }, (await installation(p.db, p.account)).install_id);
  assert.deepEqual((await installation(p.db, p.account)).retired_lineages?.at(-1), { log_id: replaced, epoch: 1 });
  assert.equal(server.registrations.length, successors.size, "each successor registered once");
  assert.equal(server.unauthorized, 0, "the browser's session was never revoked");
  for (const t of [a, b]) t.schedule(1_000_000);
  server = null;
});
