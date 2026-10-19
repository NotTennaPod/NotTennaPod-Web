// A page going away (pagehide; the only tab, closed while it plays) sends what
// the journal has unsent with keepalive. Nothing that waits runs after
// pagehide, so the push is prepared from the journal while the page lives
// (after each push, and when the page is hidden, once the player has journaled
// its position), and pagehide starts the request at once. It carries the facts
// exactly as journaled (op IDs, author chain, slots), in slot order from the
// front, as many as fit the browser's keepalive limit, and never anything not
// journaled. They stay journaled until a push's answer acknowledges them, so
// the next push sends them again as duplicates (PROTOCOL §6.4).
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDB, type EntryRow } from "../src/journal/db.ts";
import { acknowledge, append, entries, installation, newAuthor, updateInstallation } from "../src/journal/journal.ts";
import { keepaliveBytes } from "../src/journal/pusher.ts";
import { FakeServer } from "./fakeServer.ts";

(globalThis as Record<string, unknown>).BroadcastChannel = undefined;
class FakeEventSource extends EventTarget {
  static CLOSED = 2;
  readyState = 1;
  close() {}
}
const page = new EventTarget();
Object.assign(globalThis, { EventSource: FakeEventSource, window: page, document: Object.assign(new EventTarget(), { visibilityState: "visible" }) });
const { Sync } = await import("../src/app/sync.ts");

const lineage = { log_id: "6a1f0e2c-1111-4222-8333-944455556666", epoch: 1 };
const cursor = Buffer.from(JSON.stringify({ digest: "0".repeat(64), epoch: lineage.epoch, log_id: lineage.log_id, seq: 1 })).toString("base64url");
const note = (text = "") => ({ type: "test.note", targets: [], payload: { text } });

/** The server (its session rules: fakeServer.ts), the facts it consumed once each by op ID, and the keepalive pushes sent; `down` fails the tab's ordinary pushes. */
const server = {
  fake: null as FakeServer | null,
  down: true,
  consumed: new Map<string, number>(),
  keepalive: [] as { bytes: number; ops: { install_seq: number; fact: Record<string, unknown> }[] }[],
};
globalThis.fetch = (async (path: string, init?: { body?: string; keepalive?: boolean }) => {
  const body = init?.body ? JSON.parse(init.body) : {};
  if (path === "/v1/push" && init?.keepalive) server.keepalive.push({ bytes: Buffer.byteLength(init.body!), ops: body.operations });
  else if (server.down) throw new TypeError("The network connection was lost.");
  return server.fake!.answer(path, body, (p, b) => {
    if (p !== "/v1/push") return {};
    const ops = b.operations as { install_seq: number; fact: { op_id: string } }[];
    return {
      head: cursor,
      install_watermark: Math.max(0, ...ops.map((o) => o.install_seq)),
      results: ops.map((o) => {
        const known = server.consumed.has(o.fact.op_id);
        if (!known) server.consumed.set(o.fact.op_id, o.install_seq);
        return {
          install_seq: o.install_seq,
          status: known ? "duplicate" : "accepted",
          receipt: { op_id: o.fact.op_id, content_hash: "h", outcome: "applied", normalized_time: 0, epoch: 1, seq: 2, index: 0, key_id: "k", mac: "m" },
        };
      }),
    };
  });
}) as unknown as typeof fetch;

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (await check()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`never: ${what}`);
}

/** leave is the page going away: the keepalive push it starts before anything else can run, or null. */
function leave() {
  const before = server.keepalive.length;
  page.dispatchEvent(new Event("pagehide"));
  return server.keepalive.length > before ? server.keepalive.at(-1)! : null;
}
const asJournaled = (es: EntryRow[]) => es.map((e) => ({ install_seq: e.install_seq, fact: e.fact }));

test("a page going away starts its keepalive push at once, from the journal's unsent facts prepared while it lived", async () => {
  const account = crypto.randomUUID();
  const db = await openDB(indexedDB, "leaving");
  const first = await installation(db, account);
  await updateInstallation(db, account, (r) => {
    r.registered = true;
    r.cursor = cursor;
    r.lineage = lineage;
  });
  server.fake = new FakeServer(account, first.install_id, first.instance_nonce);
  const author = await newAuthor(db, account);
  const acked = await append(db, account, author.author_id, note());
  await acknowledge(db, account, [{ install_seq: 1, receipt: { op_id: acked.op_id, content_hash: "h", outcome: "applied", normalized_time: 0, epoch: 1, seq: 2, index: 0, key_id: "k", mac: "m" } }], lineage);
  server.consumed.set(acked.op_id, 1);
  await append(db, account, author.author_id, note());
  const unsent = async () => (await entries(db, account)).filter((e) => !e.receipt);

  const tab = new Sync({ db, account: { account_id: account, namespace: "n", username: "u", is_admin: false }, author, installation: await installation(db, account) } as never);
  const stop = tab.start(); // its push fails (the network is down), and the departure's push is prepared after it
  let sent: ReturnType<typeof leave> = null;
  await until(() => (sent = leave()) !== null, "pagehide starts the keepalive request before anything else can run");
  assert.deepEqual(sent!.ops, asJournaled(await unsent()), "the unsent fact, exactly as journaled");

  // The page is hidden: the player journals its position (an export, not pushed), then the push is prepared again.
  await append(db, account, author.author_id, note("checkpoint"));
  await tab.prepare();
  assert.deepEqual(leave()!.ops, asJournaled(await unsent()), "the export journaled on hiding goes too");

  // Newer changes: each push (failing) prepares it again. Two are too large to go together.
  for (const text of ["x".repeat(35_000), "y".repeat(35_000), ""]) await tab.act(note(text));
  await until(() => leave()?.ops.length === 3, "the push is prepared again after the newer changes");
  const last = server.keepalive.at(-1)!;
  const all = await unsent();
  assert.equal(all.length, 5);
  assert.ok(last.bytes <= keepaliveBytes && keepaliveBytes <= 64 << 10, `${last.bytes} bytes`);
  assert.deepEqual(last.ops, asJournaled(all.slice(0, 3)), "from the front as journaled: the fourth does not fit, and nothing after it skips ahead");
  for (const k of server.keepalive) for (const op of k.ops) assert.ok(all.some((e) => e.install_seq === op.install_seq && JSON.stringify(e.fact) === JSON.stringify(op.fact)), "only facts the journal has");
  assert.deepEqual((await unsent()).length, 5, "kept until a push's answer acknowledges them");

  // The network is back: the next push sends them all again; the server has each once, and nothing is left to send on leaving.
  server.down = false;
  tab.schedule(0);
  await until(async () => (await unsent()).length === 0, "all acknowledged");
  assert.deepEqual([...server.consumed.values()], [1, 2, 3, 4, 5, 6], "each consumed once, in its slot");
  await tab.prepare();
  assert.equal(leave(), null, "nothing unsent: no request");
  stop();
});
