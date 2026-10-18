// Re-reading displayed views (PROTOCOL §12): one read per newer head the
// server announces, a revalidation always reads, a failed re-read retries
// until one succeeds, a hidden tab waits, heads and counters never go back
// or to a lineage left, and the player reads its episode once per change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Rereader, type HeadLike } from "../src/app/heads.ts";
import { ApiError } from "../src/api/http.ts";
import { deferred, head, L1, L2, settle, testSync, type Deferred } from "./viewSync.ts";

/** reader is a Rereader whose reads, heads, visibility and timers the test holds. */
function reader() {
  const s = {
    known: null as HeadLike | null,
    visible: true,
    reads: [] as { d: Deferred<HeadLike | null>; signal: AbortSignal }[],
    timers: [] as { fn: () => void; ms: number; cleared: boolean }[],
    final: false,
  };
  const r = new Rereader({
    known: () => s.known,
    visible: () => s.visible,
    read: (signal) => {
      const d = deferred<HeadLike | null>();
      s.reads.push({ d, signal });
      return d.promise;
    },
    failed: () => !s.final,
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      s.timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      (t as { cleared: boolean }).cleared = true;
    },
  });
  /** answer settles the latest read. */
  const answer = async (h: HeadLike | null) => {
    s.reads.at(-1)!.d.resolve(h);
    await settle();
  };
  const fail = async (e: unknown = new ApiError(503, "server_busy", "busy")) => {
    s.reads.at(-1)!.d.reject(e);
    await settle();
  };
  return { s, r, answer, fail };
}

test("a view reads once per newer head: its own push and the event for the same head make one read", async () => {
  const { s, r, answer } = reader();
  r.start();
  await answer(head(1));
  assert.equal(s.reads.length, 1);
  s.known = head(1); // the event stream's first head, the one shown
  r.known();
  assert.equal(s.reads.length, 1, "an equal head reads nothing");
  s.known = head(2); // the push's response
  r.known();
  assert.equal(s.reads.length, 2);
  s.known = head(2); // its event
  r.known();
  await answer(head(2));
  s.known = head(2);
  r.known();
  assert.equal(s.reads.length, 2, "the event for the same head reads nothing");
});

test("a newer head mid-flight is read once more after the read in flight, which is not aborted", async () => {
  const { s, r, answer } = reader();
  r.start();
  await answer(head(1));
  s.known = head(2);
  r.known();
  assert.equal(s.reads.length, 2);
  s.known = head(3);
  r.known();
  s.known = head(4);
  r.known();
  assert.equal(s.reads.length, 2, "nothing more while one is in flight");
  assert.equal(s.reads[1]!.signal.aborted, false);
  await answer(head(2));
  assert.equal(s.reads.length, 3, "exactly one more");
  await answer(head(4));
  assert.equal(s.reads.length, 3);
  assert.deepEqual(r.shown, head(4));
});

test("a read that started after a head was announced covers it: no second read when the event arrives meanwhile", async () => {
  const { s, r, answer } = reader();
  r.start(); // the page loads; the stream's first event names the head the read will show
  s.known = head(5);
  r.known();
  await answer(head(5));
  assert.equal(s.reads.length, 1);
});

test("focus, online and a reconnect revalidate: a read at an equal head", async () => {
  const { s, r, answer } = reader();
  r.start();
  await answer(head(1));
  s.known = head(1);
  for (let i = 0; i < 3; i++) {
    r.revalidate();
    assert.equal(s.reads.length, 2 + i);
    await answer(head(1));
  }
});

test("a revalidation during a read reads once more after it", async () => {
  const { s, r, answer } = reader();
  r.start();
  r.revalidate();
  r.revalidate();
  assert.equal(s.reads.length, 1);
  await answer(head(1));
  assert.equal(s.reads.length, 2);
  await answer(head(1));
  assert.equal(s.reads.length, 2);
});

test("a focus revalidation that fails at an equal head retries with backoff, without any event, until it catches up", async () => {
  const { s, r, answer, fail } = reader();
  r.start();
  await answer(head(1));
  s.known = head(1);
  r.revalidate();
  await fail();
  assert.deepEqual(s.timers.map((t) => t.ms), [2000]);
  s.timers[0]!.fn();
  assert.equal(s.reads.length, 3);
  await fail();
  s.timers[1]!.fn();
  await fail();
  assert.deepEqual(s.timers.map((t) => t.ms), [2000, 4000, 8000]);
  s.timers[2]!.fn();
  await answer(head(7)); // the server had moved on
  assert.deepEqual(r.shown, head(7));
  assert.equal(s.timers.length, 3, "no retry after a success");
  assert.equal(s.reads.length, 5);
});

test("a failed read of a newer head retries; a newer head while waiting reads at once", async () => {
  const { s, r, answer, fail } = reader();
  r.start();
  await answer(head(1));
  s.known = head(2);
  r.known();
  await fail(new TypeError("network"));
  assert.equal(s.timers.length, 1);
  s.known = head(3);
  r.known();
  assert.equal(s.timers[0]!.cleared, true);
  assert.equal(s.reads.length, 3);
  await answer(head(3));
});

test("the backoff tops out at a minute", async () => {
  const { s, r, answer, fail } = reader();
  r.start();
  await answer(head(1));
  r.revalidate();
  for (let i = 0; i < 8; i++) {
    await fail();
    s.timers.at(-1)!.fn();
  }
  assert.deepEqual(s.timers.map((t) => t.ms), [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
});

test("a refusal that will not pass by itself is not retried", async () => {
  const { s, r, answer, fail } = reader();
  r.start();
  await answer(head(1));
  s.final = true;
  r.revalidate();
  await fail(new ApiError(404, "not_found", "Not found."));
  assert.equal(s.timers.length, 0);
  assert.equal(s.reads.length, 2);
});

test("a hidden tab receiving ten heads reads nothing, and reads once when shown", async () => {
  const { s, r, answer } = reader();
  r.start();
  await answer(head(1));
  s.visible = false;
  for (let i = 2; i <= 11; i++) {
    s.known = head(i);
    r.known();
  }
  r.revalidate();
  assert.equal(s.reads.length, 1);
  s.visible = true;
  r.visible();
  assert.equal(s.reads.length, 2);
  await answer(head(11));
  r.visible();
  assert.equal(s.reads.length, 2);
});

test("the first read happens even in a hidden tab", () => {
  const { s, r } = reader();
  s.visible = false;
  r.start();
  assert.equal(s.reads.length, 1);
});

test("a new lineage is read", async () => {
  const { s, r, answer } = reader();
  r.start();
  await answer(head(40));
  s.known = head(1, L2);
  r.known();
  assert.equal(s.reads.length, 2);
  await answer(head(1, L2));
  assert.deepEqual(r.shown, head(1, L2));
});

test("a stopped reader (another screen, another account) applies nothing and reads no more", async () => {
  const { s, r, answer } = reader();
  r.start();
  r.stop();
  assert.equal(s.reads[0]!.signal.aborted, true);
  await answer(head(1));
  assert.equal(r.shown, null);
  s.known = head(2);
  r.known();
  r.revalidate();
  assert.equal(s.reads.length, 1);
});

// ---- the tab's heads and counters

test("a push response and the event for the same head move the known head once; a non-head event revalidates", async () => {
  const sync = await testSync();
  let moved = 0;
  sync.known.subscribe(() => moved++);
  await sync.learn(head(2)); // the push response
  sync.heard(JSON.stringify({ log_id: L1, epoch: 1, seq: 2 })); // its event
  await settle();
  assert.equal(moved, 1);
  assert.deepEqual(sync.known.get(), { log_id: L1, epoch: 1, seq: 2 });
  sync.heard(JSON.stringify({ log_id: L1, epoch: 1, seq: 1 })); // a late older one
  await settle();
  assert.equal(moved, 1);
  const before = sync.revalidate.get();
  sync.heard("{}");
  assert.equal(sync.revalidate.get(), before + 1);
});

test("epoch 1, then epoch 2, then a delayed epoch-1 answer and event: epoch 2 stays, counters and the head shown do not change", async () => {
  const sync = await testSync({ log_id: L1, epoch: 1 });
  sync.applied(head(9), { queue: 3, inbox: 2 });
  await sync.learn(head(1, L1, 2)); // the server was restored: epoch 2
  assert.deepEqual(sync.known.get(), { log_id: L1, epoch: 2, seq: 1 });
  await sync.learn(head(10)); // a delayed event of epoch 1
  assert.deepEqual(sync.known.get(), { log_id: L1, epoch: 2, seq: 1 });
  assert.equal(await sync.accepts(head(10)), false, "a delayed epoch-1 answer is not shown");
  assert.equal(await sync.accepts(head(1, L1, 2)), true);
  assert.deepEqual(sync.counters.get()?.counters, { queue: 3, inbox: 2 });
  assert.deepEqual(sync.shownHeads, [head(9)]);
});

test("a retired lineage is never learnt or accepted", async () => {
  const sync = await testSync({ log_id: L2, epoch: 1 });
  const { updateInstallation } = await import("../src/journal/journal.ts");
  await updateInstallation(sync.session.db, sync.account, (r) => (r.retired_lineages = [{ log_id: L1, epoch: 1 }]));
  await sync.learn(head(50));
  assert.equal(sync.known.get(), null);
  assert.equal(await sync.accepts(head(50)), false);
});

test("counters from views landing out of order never go back", async () => {
  const sync = await testSync();
  sync.applied(head(5), { queue: 5, inbox: 5 });
  sync.applied(head(3), { queue: 3, inbox: 3 });
  sync.applied(head(5), { queue: 9, inbox: 9 });
  assert.deepEqual(sync.counters.get()?.counters, { queue: 5, inbox: 5 });
  sync.applied(head(6), { queue: 6, inbox: 6 });
  assert.deepEqual(sync.counters.get()?.counters, { queue: 6, inbox: 6 });
  assert.deepEqual(sync.known.get(), { log_id: L1, epoch: 1, seq: 6 });
  sync.applied(head(2, L2), { queue: 1, inbox: 1 }); // a new lineage (accepted by the view before it applied)
  assert.deepEqual(sync.counters.get()?.counters, { queue: 1, inbox: 1 });
});

// ---- the player

test("the player reads its episode once per own change, not for the event, nor for a head it holds", async () => {
  const { followHeads } = await import("../src/player/instance.ts");
  const sync = await testSync();
  let reads = 0;
  const player = { state: { playing: false }, viewHead: head(1) as HeadLike | null, refresh: async () => void reads++ };
  const off = followHeads(sync, player as never);
  await sync.learn(head(1));
  assert.equal(reads, 0, "the head it holds");
  await sync.learn(head(2)); // its own push's response
  sync.heard(JSON.stringify({ log_id: L1, epoch: 1, seq: 2 }));
  await settle();
  assert.equal(reads, 1);
  player.viewHead = head(2);
  sync.revalidate.set(sync.revalidate.get() + 1);
  assert.equal(reads, 2, "a revalidation reads");
  // Hidden: only while playing.
  sync.visible.set(false);
  await sync.learn(head(3));
  assert.equal(reads, 2);
  sync.visible.set(true);
  assert.equal(reads, 3, "once when shown again");
  sync.visible.set(false);
  player.state.playing = true;
  await sync.learn(head(4));
  assert.equal(reads, 4, "a hidden tab's playing player reads");
  off();
});
