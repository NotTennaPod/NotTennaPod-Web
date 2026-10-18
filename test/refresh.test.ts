// Refresh's progress (NotTennaPod-Server PROTOCOL §9.6): it waits, per
// podcast, for the server to answer the newest request this browser made,
// read from the status read, so a refresh that changed nothing ends it, a
// server restart never ends it early, and an older reply never ends a newer
// request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, Unreachable } from "../src/api/http.ts";
import {
  Refreshes,
  maxStatusPodcasts,
  pollFirst,
  pollLater,
  refreshesOf,
  type RefreshApi,
  type RefreshItem,
  type Timers,
} from "../src/app/refresh.ts";

const item = (podcast_id: string, request_seq: number | null, done_seq = 0, extra: Partial<RefreshItem> = {}): RefreshItem => ({
  podcast_id,
  request_seq,
  done_seq,
  in_progress: request_seq != null && done_seq < request_seq,
  running: false,
  merged_into: null,
  ...extra,
});

/** A fake server: request answers are queued per call; status answers come from a function of the asked IDs. */
class FakeApi implements RefreshApi {
  requests: (string | undefined)[] = [];
  statusCalls: string[][] = [];
  answers: (RefreshItem[] | Error)[] = [];
  done = new Map<string, number>(); // podcast → done_seq the status read shows
  gone = new Set<string>();
  merged = new Map<string, string>();
  statusError: Error | undefined;
  /** held: the next status read waits until released (a slow answer). */
  held: { ids: string[]; release: (items?: RefreshItem[]) => void } | undefined;
  hold = false;
  async request(podcastId: string | undefined): Promise<RefreshItem[]> {
    this.requests.push(podcastId);
    const a = this.answers.shift();
    if (!a) throw new Error("no answer queued");
    if (a instanceof Error) throw a;
    return a;
  }
  async status(ids: string[]): Promise<RefreshItem[]> {
    this.statusCalls.push(ids);
    const answer = () =>
      ids.filter((id) => !this.gone.has(id)).map((id) => item(id, null, this.done.get(id) ?? 0, { merged_into: this.merged.get(id) ?? null }));
    if (this.hold) {
      this.hold = false;
      const snapshot = answer();
      return new Promise((resolve) => (this.held = { ids, release: (items) => resolve(items ?? snapshot) }));
    }
    if (this.statusError) throw this.statusError;
    return answer();
  }
}

/** Fake timers: one pending timer at a time, run by fire(). */
class FakeTimers implements Timers {
  t = 0;
  pending: { fn: () => void; ms: number; id: number } | undefined;
  delays: number[] = [];
  #id = 0;
  set(fn: () => void, ms: number): unknown {
    this.pending = { fn, ms, id: ++this.#id };
    this.delays.push(ms);
    return this.pending.id;
  }
  clear(h: unknown): void {
    if (this.pending?.id === h) this.pending = undefined;
  }
  now(): number {
    return this.t;
  }
  /** fire advances to the pending timer, runs it and lets its promises settle. */
  async fire(): Promise<void> {
    const p = this.pending;
    assert.ok(p, "a poll is scheduled");
    this.pending = undefined;
    this.t += p.ms;
    p.fn();
    await settle();
  }
}

const settle = () => new Promise<void>((r) => setImmediate(r));

function setup() {
  const api = new FakeApi();
  const timers = new FakeTimers();
  const r = new Refreshes(api, timers);
  return { api, timers, r };
}

test("a refresh that changes nothing ends the progress once the status read shows its request answered, with no event", async () => {
  const { api, timers, r } = setup();
  api.answers.push([item("p1", 3, 2)]);
  await r.request("p1");
  assert.deepEqual(r.progress.get(), { done: 0, total: 1 });
  assert.deepEqual(api.requests, ["p1"]);
  assert.equal(timers.pending?.ms, pollFirst);
  await timers.fire(); // still pending on the server
  assert.deepEqual(api.statusCalls, [["p1"]]);
  assert.deepEqual(r.progress.get(), { done: 0, total: 1 });
  api.done.set("p1", 3); // the fetch found the feed unchanged: answered, nothing else happened
  await timers.fire();
  assert.equal(r.progress.get(), null);
  assert.equal(timers.pending, undefined);
});

test("a refresh of all counts the podcasts done; one left to its Retry-After is not waited for", async () => {
  const { api, timers, r } = setup();
  api.answers.push([item("a", 1), item("b", 1), item("limited", null), item("c", 4)]);
  await r.request();
  assert.deepEqual(r.progress.get(), { done: 0, total: 3 });
  api.done.set("a", 1);
  await timers.fire();
  assert.deepEqual(r.progress.get(), { done: 1, total: 3 });
  assert.deepEqual(api.statusCalls.at(-1), ["a", "b", "c"]);
  api.done.set("b", 1);
  api.done.set("c", 4);
  await timers.fire();
  assert.equal(r.progress.get(), null);
  // Only podcasts left to their Retry-After: nothing to show.
  api.answers.push([item("limited", null)]);
  await r.request();
  assert.equal(r.progress.get(), null);
  assert.equal(timers.pending, undefined);
});

test("a reply to an older poll never ends a newer request for the same podcast", async () => {
  const { api, timers, r } = setup();
  api.answers.push([item("p", 1)]);
  await r.request("p");
  api.hold = true;
  const timer = timers.pending!;
  timers.pending = undefined;
  timer.fn(); // poll R1 is on its way
  await settle();
  api.done.set("p", 1); // R1's answer: sequence 1 done
  api.answers.push([item("p", 2, 0)]);
  await r.request("p"); // the person asks again: sequence 2
  api.held!.release([item("p", null, 1)]);
  await settle();
  assert.deepEqual(r.progress.get(), { done: 0, total: 1 }, "R1's answer ended the newer request");
  api.done.set("p", 2);
  await timers.fire();
  assert.equal(r.progress.get(), null);
});

test("a request while one is pending adds its podcasts; repeated clicks wait for the newest", async () => {
  const { api, timers, r } = setup();
  api.answers.push([item("p", 5)]);
  await r.request("p");
  api.answers.push([item("p", 6), item("q", 1), item("r", 2)]);
  await r.request();
  assert.deepEqual(r.progress.get(), { done: 0, total: 3 });
  api.answers.push([item("p", 7)]);
  await r.request("p");
  assert.deepEqual(r.progress.get(), { done: 0, total: 3 });
  api.done.set("p", 6);
  api.done.set("q", 1);
  api.done.set("r", 2);
  await timers.fire();
  assert.deepEqual(r.progress.get(), { done: 2, total: 3 }, "p is waited for until its newest request");
  api.done.set("p", 7);
  await timers.fire();
  assert.equal(r.progress.get(), null);
});

test("across a server restart the request stays pending, and the progress with it, until it is answered", async () => {
  const { api, timers, r } = setup();
  api.answers.push([item("p", 2, 1, { running: true })]); // joined a running fetch
  await r.request("p");
  // The server restarts: the fetch was cut short, nothing is running, the request is still pending.
  api.statusError = new Unreachable("down");
  await timers.fire();
  api.statusError = undefined;
  await timers.fire();
  assert.deepEqual(r.progress.get(), { done: 0, total: 1 });
  api.done.set("p", 2);
  await timers.fire();
  assert.equal(r.progress.get(), null);
});

test("offline, the progress stays and polling backs off; online again, it ends", async () => {
  const { api, timers, r } = setup();
  api.answers.push([item("p", 1)]);
  await r.request("p");
  api.statusError = new Unreachable("offline");
  for (let i = 0; i < 5; i++) await timers.fire();
  assert.deepEqual(timers.delays, [pollFirst, pollLater, pollLater * 2, pollLater * 4, 30_000, 30_000]);
  assert.deepEqual(r.progress.get(), { done: 0, total: 1 });
  api.statusError = new ApiError(503, "server_busy", "Try again.");
  await timers.fire();
  assert.deepEqual(r.progress.get(), { done: 0, total: 1 });
  api.statusError = undefined;
  api.done.set("p", 1);
  await timers.fire();
  assert.equal(r.progress.get(), null);
});

test("polling is every 2 s, then every 5 s after the first 30 s", async () => {
  const { api, timers, r } = setup();
  api.answers.push([item("p", 1)]);
  await r.request("p");
  while (timers.t < 40_000) await timers.fire();
  const after = timers.delays.slice(1);
  assert.ok(after.slice(0, 14).every((d) => d === pollFirst), `${after}`);
  assert.equal(after.at(-1), pollLater);
});

test("a refusal (signed out, the account changed) ends the progress; a request that fails shows nothing", async () => {
  const { api, timers, r } = setup();
  api.answers.push([item("p", 1)]);
  await r.request("p");
  api.statusError = new ApiError(401, "unauthorized", "Log in again.");
  await timers.fire();
  assert.equal(r.progress.get(), null);
  assert.equal(timers.pending, undefined);
  api.answers.push(new ApiError(404, "not_found", "No such podcast."));
  await assert.rejects(r.request("gone"));
  assert.equal(r.progress.get(), null);
  const other = setup();
  other.api.answers.push([item("p", 1)]);
  await other.r.request("p");
  other.api.statusError = new DOMException("The account changed.", "AbortError");
  await other.timers.fire();
  assert.equal(other.r.progress.get(), null);
});

test("a podcast merged into another, or gone, is done", async () => {
  const { api, timers, r } = setup();
  api.answers.push([item("m", 1), item("g", 1), item("x", 1)]);
  await r.request();
  api.merged.set("m", "survivor");
  api.gone.add("g");
  await timers.fire();
  assert.deepEqual(r.progress.get(), { done: 2, total: 3 });
});

test("a refresh of more podcasts than one status read takes is read in parts", async () => {
  const { api, timers, r } = setup();
  const ids = Array.from({ length: 1_200 }, (_, i) => `p${i}`);
  api.answers.push(ids.map((id) => item(id, 1)));
  await r.request();
  await timers.fire();
  assert.deepEqual(
    api.statusCalls.map((c) => c.length),
    [maxStatusPodcasts, maxStatusPodcasts, 200],
  );
  assert.deepEqual(r.progress.get(), { done: 0, total: 1_200 });
});

test("the progress belongs to the account's session, not a screen: leaving a screen keeps it", () => {
  const session = {};
  assert.equal(refreshesOf(session), refreshesOf(session));
  assert.notEqual(refreshesOf(session), refreshesOf({}));
});
