import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDB, req, tx, type AuthorRow, type EntryRow, type Fact, type InstallationRow } from "../src/journal/db.ts";
import { append, appendAll, entries, FactTooLarge, installation, journalStores, maxFactBytes, newAuthor, unacknowledged, updateInstallation, type FactBody } from "../src/journal/journal.ts";
import { defaultBounds, pushAll, type PushResponse, type PushResult } from "../src/journal/pusher.ts";
import { canonical, utf8 } from "../src/journal/jcs.ts";
import * as act from "../src/app/actions.ts";
import { restoreAt, savedIndexes } from "../src/app/queueOps.ts";
import { between, compareKeys, keyString, parseKey, uuidValue, type QueueKey } from "../src/queue/keys.ts";
import type { EpisodeRow } from "../src/api/views.ts";

// A list action on a power user's library (PROTOCOL §6.13): any number of
// episodes goes as facts the server accepts, journaled together before the
// action is done, and later changes stay sendable, across a reload.

// fake-indexeddb keeps every finished transaction, and what it read, for the
// life of its database; at 100,000 episodes that alone fills the heap. A
// browser lets them go, and so does this test.
const transaction = IDBDatabase.prototype.transaction;
IDBDatabase.prototype.transaction = function (this: IDBDatabase & { _rawDatabase: { transactions: { _state: string }[] } }, ...args: Parameters<IDBDatabase["transaction"]>) {
  this._rawDatabase.transactions = this._rawDatabase.transactions.filter((t) => t._state !== "finished");
  return transaction.apply(this, args);
} as IDBDatabase["transaction"];

const LOG = "6a1f0e2c-1111-4222-8333-944455556666";
const cursor = (seq: number) => Buffer.from(JSON.stringify({ digest: "0".repeat(64), epoch: 1, log_id: LOG, seq })).toString("base64url");
const hex = (i: number, n: number) => i.toString(16).padStart(n, "0");

/** episode is a NEW episode as a list shows it, with occurrence evidence of a realistic size. */
function episode(i: number): EpisodeRow {
  const podcast = `p1:${hex(i % 100, 64)}`;
  const id = `e1:${hex(i, 64)}`;
  return {
    episode_id: id,
    podcast_id: podcast,
    title: `Episode ${i}`,
    pub_date: 1_600_000_000_000 + i,
    link: null,
    image_url: "",
    has_media: true,
    duration_ms: 1000,
    size: 1,
    play_state: "new",
    position: 0,
    favorite: false,
    in_queue: false,
    history: null,
    last_played: 0,
    placeholder: false,
    podcast: { title: "P", display_title: "P", image_url: "", state: "subscribed", generation_id: `g1:${hex(i % 100, 64)}` },
    records: {
      identity: {
        value: {
          podcast_id: podcast,
          occurrence: {
            k: "guid",
            v: `urn:uuid:${hex(i, 8)}-0000-4000-8000-000000000000`,
            guid: `urn:uuid:${hex(i, 8)}-0000-4000-8000-000000000000`,
            enclosure_url: `https://media.example.com/podcasts/${i % 100}/episodes/${i}/audio-file.mp3`,
            title: `Episode ${i}: a title of an ordinary length`,
            publication_time: 1_600_000_000_000 + i,
          },
        },
        provenance: [`${hex(i, 8)}-1111-4222-8333-944455556666`],
      },
    },
  } as unknown as EpisodeRow;
}

/** server consumes contiguous slots as PROTOCOL §6.4 does, refusing what its bounds refuse, checks each author's chain (§6.1), and keeps an Inbox. */
function server(inbox: Set<string>) {
  let consumed = 0;
  let seq = 1;
  const favorites = new Set<string>();
  const facts: Fact[] = [];
  const chains = new Map<string, { seq: number; last: string }>();
  const parts = new Map<string, string[]>();
  let largest = 0;
  const send = async (body: Record<string, unknown>): Promise<PushResponse> => {
    if (utf8(JSON.stringify(body)).length > defaultBounds.max_request_bytes) throw new Error("413 payload_too_large");
    const ops = body.operations as { install_seq: number; fact?: Fact; part?: { transaction_id: string; part_index: number; part_count: number; data: string } }[];
    if (ops.length > defaultBounds.max_operations) throw new Error("too many operations");
    const results: PushResult[] = [];
    for (const op of ops) {
      if (op.install_seq !== consumed + 1) {
        results.push({ install_seq: op.install_seq, status: "gap" });
        break;
      }
      let fact = op.fact;
      if (op.part) {
        const p = op.part;
        if (p.part_count > defaultBounds.max_part_count) throw new Error("too many parts");
        const list = parts.get(p.transaction_id) ?? new Array<string>(p.part_count).fill("");
        list[p.part_index] = Buffer.from(p.data, "base64url").toString("latin1");
        parts.set(p.transaction_id, list);
        if (list.reduce((n, x) => n + x.length, 0) > maxFactBytes) {
          results.push({ install_seq: op.install_seq, status: "invalid_part" });
          break;
        }
        if (list.some((x) => x === "")) {
          results.push({ install_seq: op.install_seq, status: "part_stored", parts_present: list.flatMap((x, i) => (x ? [i] : [])) });
          break;
        }
        fact = JSON.parse(Buffer.from(list.join(""), "latin1").toString("utf8")) as Fact;
      } else if (utf8(canonical(fact)).length > defaultBounds.max_unframed_fact_bytes) throw new Error("413 an unframed fact over the bound");
      largest = Math.max(largest, utf8(canonical(fact)).length);
      const chain = chains.get(fact!.author_id);
      assert.equal(fact!.previous_op_id, chain?.last, "each fact follows its author's previous one");
      assert.ok(fact!.author_seq > (chain?.seq ?? 0), "author positions strictly increase");
      assert.deepEqual(fact!.dependencies, [...new Set(fact!.dependencies)].sort(), "dependencies sorted and unique");
      if (fact!.previous_op_id) assert.ok(fact!.dependencies.includes(fact!.previous_op_id), "the previous fact is a dependency");
      chains.set(fact!.author_id, { seq: fact!.author_seq, last: fact!.op_id });
      facts.push(fact!);
      consumed++;
      seq++;
      const payload = fact!.payload as { episodes?: { episode_id: string }[]; episode?: { episode_id: string } };
      if (fact!.type === "inbox.dismiss_all") for (const e of payload.episodes ?? []) inbox.delete(e.episode_id);
      if (fact!.type === "favorite.set") favorites.add(payload.episode!.episode_id);
      results.push({ install_seq: op.install_seq, status: "accepted", receipt: { op_id: fact!.op_id, content_hash: "h", outcome: "applied", normalized_time: 1, epoch: 1, seq, index: 0, key_id: "k", mac: "m" } });
    }
    return { head: cursor(seq), install_watermark: consumed, results };
  };
  return { send, favorites, facts, get consumed() { return consumed; }, get largest() { return largest; } };
}

test("Remove all from inbox at 100,000 NEW episodes: facts the server accepts, a later favorite sent, the Inbox empty after a reload", async () => {
  const name = `bulk-${crypto.randomUUID()}`;
  let db = await openDB(indexedDB, name);
  const account = crypto.randomUUID();
  await installation(db, account);
  await updateInstallation(db, account, (r) => {
    r.registered = true;
    r.cursor = cursor(1);
  });
  const author = await newAuthor(db, account);
  const episodes = Array.from({ length: 100_000 }, (_, i) => episode(i));
  const inbox = new Set(episodes.map((e) => e.episode_id));
  const bodies = act.dismissAll(episodes);
  const journaled = await appendAll(db, account, author.author_id, bodies);
  assert.ok(journaled.length > 1, "split into several facts");
  for (const e of journaled) assert.ok(utf8(canonical(e.fact)).length <= defaultBounds.max_unframed_fact_bytes, "each fact unframed");
  const named = new Set(journaled.flatMap((e) => (e.fact.payload as { episodes: { episode_id: string }[] }).episodes.map((x) => x.episode_id)));
  assert.equal(named.size, episodes.length, "every observed episode named once");
  await append(db, account, author.author_id, act.favorite(episodes[7]!, true));
  // A reload: only the journal survives.
  db.close();
  db = await openDB(indexedDB, name);
  assert.equal((await entries(db, account)).length, journaled.length + 1);
  const s = server(inbox);
  for (let i = 0; i < 10 && s.consumed < journaled.length + 1; i++) await pushAll(db, account, s.send);
  assert.equal(s.consumed, journaled.length + 1, "every fact acknowledged, the favorite too");
  assert.equal(inbox.size, 0, "the server's Inbox is empty");
  assert.ok(s.favorites.has(episodes[7]!.episode_id), "the later favorite reached the server");
});

test("a fact no request can carry is refused before it is journaled, and later changes are sent", async () => {
  const db = await openDB(indexedDB, `bulk-${crypto.randomUUID()}`);
  const account = crypto.randomUUID();
  await installation(db, account);
  await updateInstallation(db, account, (r) => {
    r.registered = true;
    r.cursor = cursor(1);
  });
  const author = await newAuthor(db, account);
  const huge = Array.from({ length: 20_000 }, (_, i) => episode(i));
  // A queue sort names the whole queue in one fact: it cannot be split.
  const sort = act.queueSort(account, "random", huge, huge.map(act.ref));
  await assert.rejects(appendAll(db, account, author.author_id, [act.favorite(huge[0]!, true), sort]), FactTooLarge);
  assert.equal((await entries(db, account)).length, 0, "nothing of the refused action is journaled");
  await append(db, account, author.author_id, act.favorite(huge[1]!, true));
  const s = server(new Set());
  await pushAll(db, account, s.send);
  assert.equal(s.consumed, 1);
  assert.ok(s.favorites.has(huge[1]!.episode_id));
});

/**
 * previousAppend is append as the version before list actions were split
 * journaled a fact: whole, however large (no size guard).
 */
async function previousAppend(db: IDBDatabase, account: string, authorId: string, body: FactBody, now = Date.now()): Promise<EntryRow> {
  return tx(db, journalStores, "readwrite", async (t) => {
    const insts = t.objectStore("installations");
    const authors = t.objectStore("authors");
    const inst = (await req(insts.get(account))) as InstallationRow;
    const author = (await req(authors.get(authorId))) as AuthorRow;
    const deps = [...(body.dependencies ?? [])];
    if (author.last_op_id) deps.push(author.last_op_id);
    const fact: Fact = {
      op_id: crypto.randomUUID(),
      author_id: author.author_id,
      author_seq: author.next_seq,
      dependencies: [...new Set(deps)].sort(),
      type: body.type,
      type_version: body.type_version ?? 1,
      client_time: now,
      targets: body.targets,
      payload: body.payload,
    };
    if (author.last_op_id) fact.previous_op_id = author.last_op_id;
    const entry: EntryRow = { account_id: account, install_seq: inst.next_install_seq, install_id: inst.install_id, op_id: fact.op_id, fact, receipt: null, receipt_lineage: null, waiting: null, created_at: now };
    if (body.awaited) entry.awaited = true;
    await req(t.objectStore("journal").add(entry));
    inst.next_install_seq++;
    author.next_seq++;
    author.last_op_id = fact.op_id;
    await req(insts.put(inst));
    await req(authors.put(author));
    return entry;
  });
}

/** registered is a browser profile signed in to a new account, with one tab's author. */
async function registered(name = `bulk-${crypto.randomUUID()}`) {
  const db = await openDB(indexedDB, name);
  const account = crypto.randomUUID();
  await installation(db, account);
  await updateInstallation(db, account, (r) => {
    r.registered = true;
    r.cursor = cursor(1);
  });
  const author = await newAuthor(db, account);
  return { name, db, account, author };
}

test("Remove all from inbox journaled as one fact by the previous version, at 100,000 NEW episodes: split in its place, sent with the changes around it, across a reload", async () => {
  const p = await registered();
  let db = p.db;
  const episodes = Array.from({ length: 100_000 }, (_, i) => episode(i));
  const inbox = new Set(episodes.map((e) => e.episode_id));
  await append(db, p.account, p.author.author_id, act.favorite(episodes[3]!, true));
  const whole = await previousAppend(db, p.account, p.author.author_id, act.dismiss(episodes, true));
  assert.ok(utf8(canonical(whole.fact)).length > maxFactBytes, "the previous version journaled a fact no request can carry");
  await append(db, p.account, p.author.author_id, act.favorite(episodes[7]!, true));
  db.close();
  db = await openDB(indexedDB, p.name);
  const s = server(inbox);
  for (let i = 0; i < 50 && (await unacknowledged(db, p.account)).length > 0; i++) {
    const out = await pushAll(db, p.account, s.send);
    assert.equal(out.stopped, null);
  }
  assert.equal((await unacknowledged(db, p.account)).length, 0, "nothing stays pending");
  assert.equal(inbox.size, 0, "the server's Inbox is empty");
  assert.ok(s.favorites.has(episodes[3]!.episode_id) && s.favorites.has(episodes[7]!.episode_id), "the favorites before and after it reached the server");
  // The action is the same: every episode named once, in its order, by facts of its type that follow each other in its author's chain.
  const parts = s.facts.filter((f) => f.type === "inbox.dismiss_all");
  assert.ok(parts.length > 1);
  assert.deepEqual(s.facts.map((f) => f.type), ["favorite.set", ...parts.map(() => "inbox.dismiss_all"), "favorite.set"]);
  const named = parts.flatMap((f) => (f.payload as { episodes: { episode_id: string }[] }).episodes.map((x) => x.episode_id));
  assert.deepEqual(named, (whole.fact.payload as { episodes: { episode_id: string }[] }).episodes.map((x) => x.episode_id));
  for (const f of parts) assert.deepEqual(f.targets.map((t) => t.id), (f.payload as { episodes: { episode_id: string }[] }).episodes.map((x) => x.episode_id));
  const first = new Set(parts[0]!.dependencies);
  assert.ok(whole.fact.dependencies.every((d) => first.has(d)), "the first part observes all the whole fact did");
  assert.equal(parts[0]!.previous_op_id, whole.fact.previous_op_id, "in the whole fact's place in the chain");
  assert.equal(s.facts.at(-1)!.previous_op_id, parts.at(-1)!.op_id, "the change after it follows its last part");
  // The tab's author goes on from there.
  const later = await append(db, p.account, p.author.author_id, act.favorite(episodes[9]!, true));
  assert.equal(later.fact.previous_op_id, s.facts.at(-1)!.op_id);
  assert.equal(later.fact.author_seq, s.facts.at(-1)!.author_seq + 1);
});

test("an unsent fact no request can carry, of an action that is not split, is kept with the changes after it, and the tab says they cannot be sent", async () => {
  const p = await registered();
  let db = p.db;
  const huge = Array.from({ length: 20_000 }, (_, i) => episode(i));
  await previousAppend(db, p.account, p.author.author_id, act.queueSort(p.account, "random", huge, huge.map(act.ref)));
  await append(db, p.account, p.author.author_id, act.favorite(huge[1]!, true));
  db.close();
  db = await openDB(indexedDB, p.name);
  const s = server(new Set());
  const out = await pushAll(db, p.account, s.send);
  assert.equal(out.stopped, "too_large");
  assert.equal(s.consumed, 0, "nothing sent past it");
  assert.equal((await entries(db, p.account)).length, 2, "both changes kept");
  // The tab shows it.
  const channel = globalThis.BroadcastChannel;
  (globalThis as Record<string, unknown>).BroadcastChannel = undefined;
  try {
    const { Sync } = await import("../src/app/sync.ts");
    const author = await newAuthor(db, p.account);
    const tab = new Sync({ db, account: { account_id: p.account, namespace: "n", username: "u", is_admin: false }, author, installation: await installation(db, p.account) });
    tab.schedule(0);
    for (let i = 0; i < 1000 && !tab.unsendable.get(); i++) await new Promise((r) => setTimeout(r, 1));
    assert.equal(tab.unsendable.get(), true);
    assert.equal(tab.pending.get(), 2);
    assert.equal((await entries(db, p.account)).length, 2);
  } finally {
    (globalThis as Record<string, unknown>).BroadcastChannel = channel;
  }
});

/** queued is a queue of n episodes, with keys in its order. */
function queued(n: number): EpisodeRow[] {
  let low: QueueKey | null = null;
  return Array.from({ length: n }, (_, i) => {
    const e = episode(i);
    const k = between(low, null, uuidValue(crypto.randomUUID()));
    low = k;
    e.records.queue_position = { value: { key: keyString(k), position_id: crypto.randomUUID() }, provenance: [] };
    e.in_queue = true;
    return e;
  });
}

test("Undo of a removal of 8,000 consecutive queued episodes: facts the server accepts, journaled together, each at the run's place, every episode back in its place", async () => {
  const p = await registered();
  const queue = queued(8_000);
  const saved = savedIndexes(queue, queue);
  const bodies = restoreAt(saved, []);
  const journaled = await appendAll(p.db, p.account, p.author.author_id, bodies);
  assert.ok(journaled.length > 1, "split into several facts");
  for (const e of journaled) assert.ok(utf8(canonical(e.fact)).length <= defaultBounds.max_unframed_fact_bytes, "each fact unframed");
  // Replayed as the server places them: each fact at its place, its members in order.
  type Payload = { members: act.Placement[]; place: act.Place };
  const order: string[] = [];
  for (const e of journaled) {
    const { members, place } = e.fact.payload as Payload;
    const at = place.kind === "start" ? 0 : place.kind === "end" ? order.length : order.indexOf(place.after.episode_id) + 1;
    assert.deepEqual(place, { kind: "start" }, "each fact at the run's place, never after an episode it restores");
    order.splice(at, 0, ...members.map((m) => m.episode.episode_id));
  }
  assert.deepEqual(order, queue.map((e) => e.episode_id), "the queue as it was");
  const predicted = new Map(journaled.flatMap((e) => (e.fact.payload as Payload).members.map((m) => [m.episode.episode_id, parseKey(m.key)!] as const)));
  const keys = order.map((id) => predicted.get(id)!);
  for (let i = 1; i < keys.length; i++) assert.ok(compareKeys(keys[i - 1]!, keys[i]!) < 0, "predicted keys in the queue's order");
  // The first depends on the queue seen; the others follow it in the chain.
  for (const e of journaled.slice(1)) assert.deepEqual(e.fact.dependencies, [e.fact.previous_op_id]);
});

test("Undo of a removal that fits in one fact the server accepts journals one fact, sent framed", async () => {
  const p = await registered();
  const queue = queued(600);
  const bodies = restoreAt(savedIndexes(queue, queue), []);
  assert.equal(bodies.length, 1, "one fact, as one restore");
  const [entry] = await appendAll(p.db, p.account, p.author.author_id, bodies);
  assert.ok(utf8(canonical(entry!.fact)).length > defaultBounds.max_unframed_fact_bytes, "larger than an unframed fact");
  const s = server(new Set());
  const out = await pushAll(p.db, p.account, s.send);
  assert.equal(out.stopped, null);
  assert.equal(out.remaining, 0);
  assert.deepEqual(s.facts.map((f) => f.type), ["queue.restore"]);
  const members = (s.facts[0]!.payload as { members: act.Placement[] }).members;
  assert.deepEqual(members.map((m) => m.episode.episode_id), queue.map((e) => e.episode_id), "every episode, in the queue's order");
});
