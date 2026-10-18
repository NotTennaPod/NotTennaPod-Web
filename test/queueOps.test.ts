// The queue's commands as the server's queue replay takes them
// (NotTennaPod-Server PROTOCOL §7.6): each placement's
// place as the browser resolves it, the command shapes, and the browser's
// prediction (insert at the place, then sort under Keep sorted).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EpisodeRow } from "../src/api/views.ts";
import type { Place, Placement } from "../src/app/actions.ts";
import { addToQueue, moveAllTo, moveTo, planAdd, restoreAt, savedIndexes, sortQueueNow, sortValues } from "../src/app/queueOps.ts";
import { between, compareKeys, keyString, parseKey, uuidValue } from "../src/queue/keys.ts";

const gen = "g1:" + "a".repeat(64);
const podcast = "p1:" + "b".repeat(64);
function row(id: string, title: string, pub: number, key?: string): EpisodeRow {
  const records: EpisodeRow["records"] = {
    identity: { value: { podcast_id: podcast, occurrence: { k: "rss-guid", v: id, guid: id, title, publication_time: pub } }, provenance: [`0000000${id.slice(-1)}-0000-4000-8000-000000000000`] },
    metadata: { value: { title, pub_date: pub, media: { url: `https://example.test/${id}.mp3`, duration: 1000 } }, provenance: [] },
  };
  if (key) records.queue_position = { value: { key, position_id: crypto.randomUUID() }, provenance: [] };
  return {
    episode_id: `e1:${id.padStart(64, "0")}`, podcast_id: podcast, title, pub_date: pub, link: null, image_url: "",
    has_media: true, duration_ms: 1000, size: 0, play_state: "unplayed", position: 0, favorite: false, in_queue: !!key, history: null,
    last_played: 0, placeholder: false, podcast: { title: "P", image_url: "", state: "subscribed", generation_id: gen } as EpisodeRow["podcast"],
    records,
  };
}

/** queueOf is a queue in key order, titled and dated as given (dates 1000, 2000, … unless given). */
function queueOf(...titles: (string | [string, number])[]): EpisodeRow[] {
  let low = null;
  const out: EpisodeRow[] = [];
  for (const [i, t] of titles.entries()) {
    const k = between(low, null, uuidValue(crypto.randomUUID()));
    const [title, pub] = typeof t === "string" ? [t, (i + 1) * 1000] : t;
    out.push(row(String(i + 1), title, pub, keyString(k)));
    low = k;
  }
  return out;
}

const policy = (o: Partial<{ enqueue_location: string; keep_sorted: boolean; sort_order: string }>) => ({
  enqueue_location: "back", keep_sorted: false, sort_order: "date_new_old", ...o,
});

const ids = (xs: EpisodeRow[]) => xs.map((e) => e.episode_id);
const after = (e: EpisodeRow): Place => ({ kind: "after", after: { episode_id: e.episode_id, podcast_id: podcast, generation_id: gen, occurrence: (e.records.identity!.value as { occurrence: Record<string, unknown> }).occurrence } });
const start: Place = { kind: "start" };
const end: Place = { kind: "end" };
type Payload = { members: Placement[]; place: Place; moves?: unknown };

/** orderAfter is the queue's episode IDs by key once the placements' keys are applied. */
function orderAfter(q: EpisodeRow[], placements: Placement[]): string[] {
  const keys = new Map(q.map((e) => [e.episode_id, e.records.queue_position!.value.key as string]));
  for (const p of placements) keys.set(p.episode.episode_id, p.key);
  return [...keys].sort((a, b) => compareKeys(parseKey(a[1])!, parseKey(b[1])!)).map(([id]) => id);
}

// ---- adds (PROTOCOL §7.6)

test("back is end; the members come in the order asked, after the last", () => {
  const q = queueOf("a", "b");
  const adds = [row("8", "x", 1), row("9", "y", 2)];
  const back = addToQueue(adds, q, policy({}))!;
  const p = back.payload as Payload;
  assert.equal(back.type, "queue.add");
  assert.deepEqual(p.place, end);
  assert.equal(p.moves, undefined, "moves are not part of a placement");
  assert.deepEqual(p.members.map((m) => m.episode.episode_id), ids(adds));
  assert.deepEqual(orderAfter(q, p.members), [...ids(q), ...ids(adds)]);
  assert.deepEqual(back.targets.map((t) => t.id), ids(adds).sort());
  assert.deepEqual(Object.keys(p).sort(), ["members", "place"]);
});

test("front is start (a browser downloads nothing, so no downloading run to pass)", () => {
  const q = queueOf("a", "b");
  const adds = [row("8", "x", 1), row("9", "y", 2)];
  const p = addToQueue(adds, q, policy({ enqueue_location: "front" }))!.payload as Payload;
  assert.deepEqual(p.place, start);
  assert.deepEqual(orderAfter(q, p.members), [...ids(adds), ...ids(q)]);
});

test("after current is after the loaded episode, the tail too; with none, or one not queued, the front scan: start", () => {
  const q = queueOf("a", "b", "c");
  const adds = [row("8", "x", 1), row("9", "y", 2)];
  const at = (current: string | null) => addToQueue(adds, q, policy({ enqueue_location: "after_current" }), current)!.payload as Payload;
  assert.deepEqual(at(q[1]!.episode_id).place, after(q[1]!));
  assert.deepEqual(orderAfter(q, at(q[1]!.episode_id).members), [...ids(q.slice(0, 2)), ...ids(adds), q[2]!.episode_id]);
  assert.deepEqual(at(q[2]!.episode_id).place, after(q[2]!), "after the last is after it, never end");
  assert.deepEqual(at(null).place, start);
  assert.deepEqual(orderAfter(q, at(null).members), [...ids(adds), ...ids(q)]);
  assert.deepEqual(at("e1:elsewhere").place, start);
});

test("random index i is start for 0, else after the episode at i−1; the tail is after the last, never end", () => {
  const q = queueOf("a", "b", "c");
  const adds = [row("8", "x", 1), row("9", "y", 2)];
  const draw = (r: number) => addToQueue(adds, q, policy({ enqueue_location: "random" }), null, () => r)!.payload as Payload;
  assert.deepEqual(draw(0).place, start);
  assert.deepEqual(draw(0.3).place, after(q[0]!)); // floor(0.3 × 4) = 1
  assert.deepEqual(draw(0.5).place, after(q[1]!)); // 2
  assert.deepEqual(draw(0.99).place, after(q[2]!)); // 3: the tail
  const order = orderAfter(q, draw(0.5).members);
  assert.deepEqual(order, [...ids(q.slice(0, 2)), ...ids(adds), q[2]!.episode_id], "one draw, the added episodes together");
  assert.deepEqual((addToQueue(adds, [], policy({ enqueue_location: "random" }), null, () => 0.9)!.payload as Payload).place, start, "an empty queue's only index is 0");
});

test("an episode already queued is not added: no add when nothing is new; episodes without media are skipped", () => {
  const q = queueOf("a");
  assert.equal(addToQueue([q[0]!], q, policy({})), null);
  const silent = { ...row("7", "no media", 1), has_media: false };
  const p = addToQueue([q[0]!, silent, row("9", "y", 2)], q, policy({}))!.payload as Payload;
  assert.deepEqual(p.members.map((m) => m.episode.episode_id), [row("9", "y", 2).episode_id]);
});

test("an anchor no fact can name is projected onto the nearest episode before it that can be named, else start", () => {
  const q = queueOf("a", "b", "c");
  const unnamed = { ...q[1]!, podcast: { ...q[1]!.podcast, generation_id: undefined } } as EpisodeRow;
  const mixed = [q[0]!, unnamed, q[2]!];
  const draw = (queue: EpisodeRow[], r: number) => (addToQueue([row("9", "y", 2)], queue, policy({ enqueue_location: "random" }), null, () => r)!.payload as Payload).place;
  assert.deepEqual(draw(mixed, 0.5), after(q[0]!)); // index 2: after the unnamed one, so after a
  assert.deepEqual(draw([unnamed, q[2]!], 0.4), start); // index 1: nothing nameable before
});

// ---- Keep sorted: insert at the place, then sort (PROTOCOL §7.6)

test("keep sorted inserts at the place, then sorts; the place is the insertion's, and only the added members are sent", () => {
  const q = queueOf("alpha", "charlie", "delta");
  const bravo = row("9", "bravo", 5);
  const front = addToQueue([bravo], q, policy({ enqueue_location: "front", keep_sorted: true, sort_order: "episode_title_a_z" }))!;
  const p = front.payload as Payload;
  assert.deepEqual(p.place, start, "where it was inserted, before the sort");
  assert.equal(p.moves, undefined);
  assert.deepEqual(p.members.map((m) => m.episode.episode_id), [bravo.episode_id]);
  assert.deepEqual(front.targets.map((t) => t.id), [bravo.episode_id]);
  assert.deepEqual(orderAfter(q, p.members), [q[0]!.episode_id, bravo.episode_id, q[1]!.episode_id, q[2]!.episode_id], "its key predicts the sorted place");
});

test("keep sorted is stable over the queue with the add inserted: ties keep the inserted order (not the add at the end)", () => {
  // All dated alike: a sort by date changes nothing, so the add stays where it was inserted.
  const q = queueOf(["a", 7], ["b", 7]);
  const x = row("9", "x", 7);
  const sorted = policy({ keep_sorted: true, sort_order: "date_old_new" });
  const front = planAdd([x], q, { ...sorted, enqueue_location: "front" })!;
  assert.deepEqual(ids(front.order), [x.episode_id, ...ids(q)]);
  assert.deepEqual(orderAfter(q, front.members), [x.episode_id, ...ids(q)]);
  const random = planAdd([x], q, { ...sorted, enqueue_location: "random" }, null, () => 0.5)!;
  assert.deepEqual(ids(random.order), [q[0]!.episode_id, x.episode_id, q[1]!.episode_id]);
  assert.deepEqual(random.place, after(q[0]!));
});

test("keep sorted sorts on the server's canonical values: the catalog's over the occurrence's, the measured duration over the feed's", () => {
  const e = row("1", "shown", 5);
  e.records.identity = { value: { podcast_id: podcast, occurrence: { k: "rss-guid", v: "1", title: "occurrence", publication_time: 3 } }, provenance: [] };
  e.records.metadata = { value: { title: "catalog", media: { url: "u", duration: 40 } }, provenance: [] };
  e.records.measured_duration = { value: { duration_ms: 41 }, provenance: [] };
  e.pub_date = 99; // the date the server first saw it, shown but never sorted on
  const v = sortValues(e);
  assert.deepEqual([v.title, v.publication_time, v.duration, v.podcast_title, v.podcast_id], ["catalog", 3, 41, "P", podcast]);
  delete e.records.metadata;
  delete e.records.measured_duration;
  assert.deepEqual([sortValues(e).title, sortValues(e).duration], ["occurrence", 0]);
  e.records.metadata = { value: { title: "c", pub_date: "12", media: { duration: 7 } }, provenance: [] };
  assert.deepEqual([sortValues(e).publication_time, sortValues(e).duration], [12, 7]);
});

// ---- the play bundle's add is the same resolution

test("the add of a play resolves its place as an add does", () => {
  const q = queueOf("a", "b");
  const x = row("9", "x", 1);
  assert.deepEqual(planAdd([x], q, policy({}))!.place, end);
  assert.deepEqual(planAdd([x], q, policy({ enqueue_location: "front" }))!.place, start);
});

// ---- Undo of a removal (PROTOCOL §7.6): the saved index at Undo time

test("Undo restores at the saved index resolved against the queue at Undo time: after a front add, one earlier", () => {
  const q = queueOf("a", "b", "c");
  const saved = savedIndexes([q[1]!], q);
  assert.deepEqual(saved.map((s) => s.index), [1]);
  const now = [q[0]!, q[2]!];
  const [restore, ...rest] = restoreAt(saved, now);
  assert.equal(rest.length, 0);
  assert.equal(restore!.type, "queue.restore");
  const p = restore!.payload as Payload;
  assert.deepEqual(p.place, after(q[0]!));
  assert.deepEqual(Object.keys(p).sort(), ["members", "place"]);
  assert.deepEqual(restore!.targets.map((t) => t.id), [q[1]!.episode_id]);
  assert.deepEqual(orderAfter(now, p.members), ids(q));
  // Another device added X at the front meanwhile: index 1 is now after X (Android's addQueueItemAt).
  const x = row("9", "x", 1, keyString(between(null, parseKey(q[0]!.records.queue_position!.value.key as string), uuidValue(crypto.randomUUID()))));
  const withX = [x, q[0]!, q[2]!];
  assert.deepEqual((restoreAt(saved, withX)[0]!.payload as Payload).place, after(x));
});

test("Undo's index is clamped to the queue; index 0 and an empty queue are start", () => {
  const q = queueOf("a", "b", "c");
  const last = savedIndexes([q[2]!], q);
  assert.deepEqual((restoreAt(last, [q[0]!])[0]!.payload as Payload).place, after(q[0]!), "index 2 of a queue of 1: after the last");
  assert.deepEqual((restoreAt(last, [])[0]!.payload as Payload).place, start);
  assert.deepEqual((restoreAt(savedIndexes([q[0]!], q), q.slice(1))[0]!.payload as Payload).place, start);
});

test("Undo of several puts each back at its index: consecutive ones as one run, an episode queued again since not at all", () => {
  const q = queueOf("a", "b", "c", "d", "e");
  const saved = savedIndexes([q[3]!, q[1]!, q[2]!], q);
  assert.deepEqual(saved.map((s) => s.index), [1, 2, 3]);
  const sep = savedIndexes([q[1]!, q[3]!], q);
  const now = [q[0]!, q[2]!, q[4]!];
  const facts = restoreAt(sep, now);
  assert.equal(facts.length, 2);
  assert.deepEqual(facts.map((f) => (f.payload as Payload).place), [after(q[0]!), after(q[2]!)]);
  assert.deepEqual(orderAfter(now, facts.flatMap((f) => (f.payload as Payload).members)), ids(q));
  const run = restoreAt(saved, [q[0]!, q[4]!]);
  assert.equal(run.length, 1);
  assert.deepEqual((run[0]!.payload as Payload).place, after(q[0]!));
  assert.deepEqual((run[0]!.payload as Payload).members.map((m) => m.episode.episode_id), ids(q.slice(1, 4)));
  assert.deepEqual(orderAfter([q[0]!, q[4]!], (run[0]!.payload as Payload).members), ids(q));
  // c was added again before Undo: b and d go back around it; c is not restored.
  const again = restoreAt(saved, [q[0]!, q[2]!, q[4]!]);
  assert.deepEqual(again.flatMap((f) => (f.payload as Payload).members.map((m) => m.episode.episode_id)), [q[1]!.episode_id, q[3]!.episode_id]);
  assert.deepEqual(restoreAt(savedIndexes([q[0]!], q), q), [], "nothing to restore: no fact");
});

// ---- moves (PROTOCOL §7.6)

test("Move to top and to bottom are queue.move with start and end", () => {
  const q = queueOf("a", "b", "c");
  const top = moveTo(q[2]!, q, "top")!;
  assert.equal(top.type, "queue.move");
  const tp = top.payload as unknown as Placement & { place: Place };
  assert.deepEqual(tp.place, start);
  assert.deepEqual(Object.keys(tp).sort(), ["episode", "key", "place", "position_id"]);
  assert.deepEqual(orderAfter(q, [tp]), [q[2]!.episode_id, q[0]!.episode_id, q[1]!.episode_id]);
  const bottom = moveTo(q[0]!, q, "bottom")!.payload as unknown as Placement & { place: Place };
  assert.deepEqual(bottom.place, end);
  assert.deepEqual(orderAfter(q, [bottom]), [q[1]!.episode_id, q[2]!.episode_id, q[0]!.episode_id]);
  // The person's command stands when the episode is already there, or alone.
  assert.deepEqual((moveTo(q[0]!, q, "top")!.payload as { place: Place }).place, start);
  const alone = moveTo(q[0]!, [q[0]!], "bottom")!;
  assert.deepEqual([alone.type, (alone.payload as { place: Place }).place], ["queue.move", end]);
  assert.equal(moveTo(q[0]!, q.slice(1), "top"), null, "an episode the queue does not hold moves nothing");
});

test("a multi-select move is a run move: the complete run in its resulting order, start or end, sparse key predictions", () => {
  const q = queueOf("a", "b", "c", "d", "e");
  const sel = [q[3]!, q[1]!]; // selected in any order: they move in queue order
  const top = moveAllTo(sel, q, "top")!;
  assert.equal(top.type, "queue.reorder");
  const p = top.payload as { run: { episode_id: string }[]; place: Place; members?: Placement[] };
  assert.deepEqual(p.run.map((r) => r.episode_id), [q[1]!.episode_id, q[3]!.episode_id]);
  assert.deepEqual(p.place, start);
  assert.deepEqual(top.targets.map((t) => t.id), [q[1]!.episode_id, q[3]!.episode_id].sort());
  for (const m of p.members!) assert.deepEqual(m.episode, p.run.find((r) => r.episode_id === m.episode.episode_id), "named exactly as the run names it");
  assert.deepEqual(orderAfter(q, p.members!), ids([q[1]!, q[3]!, q[0]!, q[2]!, q[4]!]));
  const bottom = moveAllTo(sel, q, "bottom")!.payload as typeof p;
  assert.deepEqual(bottom.place, end);
  assert.deepEqual(orderAfter(q, bottom.members!), ids([q[0]!, q[2]!, q[4]!, q[1]!, q[3]!]));
  // Only what changes is predicted: a, c to the top keeps a's key.
  const kept = moveAllTo([q[0]!, q[2]!], q, "top")!.payload as typeof p;
  assert.deepEqual(kept.members!.map((m) => m.episode.episode_id), [q[2]!.episode_id]);
  assert.deepEqual(orderAfter(q, kept.members!), ids([q[0]!, q[2]!, q[1]!, q[3]!, q[4]!]));
  // A move that changes nothing here is still the command the person made; with no key to predict, no members.
  const same = moveAllTo([q[0]!, q[1]!], q, "top")!.payload as typeof p;
  assert.deepEqual([same.place, same.members], [start, undefined]);
  // The whole queue selected: still the person's command, start or end as asked, with no key to predict
  // (another device's unseen add can make it matter).
  for (const [where, place] of [["top", start], ["bottom", end]] as const) {
    const whole = moveAllTo([...q].reverse(), q, where)!;
    const w = whole.payload as typeof p;
    assert.equal(whole.type, "queue.reorder");
    assert.deepEqual([w.run.map((r) => r.episode_id), w.place, w.members], [ids(q), place, undefined]);
  }
  assert.equal(moveAllTo([row("9", "x", 1)], q, "top"), null, "a selection the queue does not hold moves nothing");
});

// ---- the sort dialog (PROTOCOL §7.6)

test("the sort dialog's sort names the account and the queue seen, even when it changes nothing, even when the queue is empty", () => {
  const q = queueOf("a", "b");
  const sort = sortQueueNow("acct", q, "episode_title_a_z");
  assert.equal(sort.type, "queue.reorder");
  assert.deepEqual(sort.targets, [{ entity: "account", id: "acct" }]);
  const refs = q.map((e) => (after(e) as { after: unknown }).after);
  assert.deepEqual(sort.payload, { sort: { sort_order: "episode_title_a_z" }, observed: refs });
  const empty = sortQueueNow("acct", [], "date_new_old");
  assert.deepEqual(empty.payload, { sort: { sort_order: "date_new_old" }, observed: [] });
});

test("a random sort carries its permutation: the order drawn, of exactly the episodes seen", () => {
  const q = queueOf("a", "b", "c");
  const draws = [0, 0]; // Fisher–Yates: i=2 swaps with 0, i=1 swaps with 0
  const sort = sortQueueNow("acct", q, "random", () => draws.shift()!);
  const p = sort.payload as { sort: { sort_order: string; permutation: { episode_id: string }[] }; observed: { episode_id: string }[] };
  assert.equal(p.sort.sort_order, "random");
  assert.deepEqual(p.observed.map((r) => r.episode_id), ids(q));
  assert.deepEqual(p.sort.permutation.map((r) => r.episode_id), ids([q[1]!, q[2]!, q[0]!]));
  assert.ok(!("permutation" in (sortQueueNow("acct", q, "date_old_new").payload.sort as object)), "only random carries one");
});

test("wholeQueue meeting an expired view mid-walk stops with the server's message and never starts the walk again", async () => {
  const { wholeQueue } = await import("../src/app/queueOps.ts");
  const { ApiError } = await import("../src/api/http.ts");
  const asked: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    asked.push(String(url));
    if (String(url).includes("page_token")) {
      return new Response(JSON.stringify({ error: "view_expired", message: "This list changed; load it again." }), { status: 410, headers: { "Content-Type": "application/json" } });
    }
    const head = { cursor: "c", log_id: "l", epoch: 1, seq: 1 };
    return new Response(JSON.stringify({ head, view: { counters: { queue: 600, inbox: 0 } }, total: 600, items: queueOf("A", "B"), next_page_token: "t2" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await assert.rejects(wholeQueue(), (e: unknown) => e instanceof ApiError && e.code === "view_expired" && e.message === "This list changed; load it again.");
    assert.equal(asked.length, 2, "no second walk");
  } finally {
    globalThis.fetch = original;
  }
});
