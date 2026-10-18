// The audio element adapter (PROTOCOL §13) against a fake element
// whose metadata, play promises and status replies the test releases: a
// replaced source, a later seek, Pause and an unfinished end each win over
// the work still under way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AudioMedia, directFailureMax, directFailureMs, directFailures, type Descriptor, type DirectFailures, type MediaStatus, type Sources } from "../src/player/media.ts";
import { FakeMediaSource, install, settled as flush, sourceAt, Stream } from "./fakeMediaSource.ts";

/** FakeAudio is an <audio> element as far as AudioMedia uses it, with the browser's play-promise rules. */
class FakeAudio extends EventTarget {
  preload = "";
  hidden = false;
  defaultPlaybackRate = 1;
  playbackRate = 1;
  preservesPitch = true;
  currentTime = 0;
  duration = Number.POSITIVE_INFINITY;
  paused = true;
  ended = false;
  readyState = 0;
  error: { code: number } | null = null;
  disableRemotePlayback = false;
  #src = "";
  get src() {
    return this.#src;
  }
  /** A MediaSource's object URL attaches it, as a browser does: the element loads, and the MediaSource opens. */
  set src(url: string) {
    this.#src = url;
    const ms = sourceAt(url);
    if (ms) {
      this.load();
      ms.open();
    }
  }
  buffered = { length: 0, start: () => 0, end: () => 0 };
  /**
   * seekable is what is buffered unless a test sets it, as Firefox reports a
   * file served without byte ranges (a relay that is not seekable). Chromium
   * reports one as seekable only at 0; a file fetched in ranges is seekable whole.
   */
  #seekable: { length: number; start: (i: number) => number; end: (i: number) => number } | null = null;
  get seekable() {
    return this.#seekable ?? this.buffered;
  }
  set seekable(r) {
    this.#seekable = r;
  }
  /** holdMetadata keeps loadedmetadata until meta() is called. */
  holdMetadata = false;
  /** holdPlay keeps play() pending until started() is called. */
  holdPlay = false;
  plays = 0;
  /** refusePlay makes play() fail, as a browser does for a source it cannot start. */
  refusePlay = false;
  #pending: { resolve: () => void; reject: (e: Error) => void }[] = [];
  #loads = 0;

  load() {
    this.#reject("The play() request was interrupted by a new load request.");
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.readyState = 0;
    const n = ++this.#loads; // a newer load abandons this one's events, as browsers do
    if (!this.holdMetadata) queueMicrotask(() => n === this.#loads && this.meta());
  }
  meta() {
    this.readyState = 1;
    this.dispatchEvent(new Event("loadedmetadata"));
  }
  play(): Promise<void> {
    this.plays++;
    if (this.refusePlay) return Promise.reject(Object.assign(new Error("The element has no supported sources."), { name: "NotSupportedError" }));
    this.paused = false;
    this.ended = false;
    if (!this.holdPlay) return Promise.resolve();
    return new Promise((resolve, reject) => this.#pending.push({ resolve, reject }));
  }
  started() {
    for (const p of this.#pending.splice(0)) p.resolve();
  }
  pause() {
    this.#reject("The play() request was interrupted by a call to pause().");
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  /** end is the stream running out: paused, ended, then the events. */
  end() {
    this.paused = true;
    this.ended = true;
    this.dispatchEvent(new Event("pause"));
    this.dispatchEvent(new Event("ended"));
  }
  removeAttribute() {
    this.src = "";
  }
  canPlayType() {
    return "probably";
  }
  #reject(message: string) {
    for (const p of this.#pending.splice(0)) p.reject(Object.assign(new Error(message), { name: "AbortError" }));
  }
}

let element!: FakeAudio;
const g = globalThis as Record<string, unknown>;
g.HTMLMediaElement = { HAVE_METADATA: 1 };
g.document = { createElement: () => (element = new FakeAudio()), body: { append() {} } };

function descriptor(o: Partial<Descriptor> = {}): Descriptor {
  return {
    mode: "relay", url: "/v1/media/s/token", token: "token", type: "audio/mpeg", profile: null, offset_ms: 0, duration_ms: 600_000,
    seekable: false, representation: null, reason: null, message: null, error: null, ...o,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** settled lets every pending promise continuation and event of the adapter run (the fakes answer in microtasks). */
const settled = () => new Promise((r) => setImmediate(r));

function media(sources: Partial<Sources>, opts: { failures?: DirectFailures } = {}) {
  const calls = { ended: 0, error: 0, paused: 0, waiting: [] as boolean[] };
  const m = new AudioMedia(1, {
    capabilities: async () => [],
    describe: async () => descriptor(),
    status: async () => ({ state: "complete", error: null }),
    wording: (e) => e.message,
    ...sources,
  }, opts);
  m.listen({ paused: () => calls.paused++, ended: () => calls.ended++, time() {}, error: () => calls.error++, waiting: (on) => calls.waiting.push(on) });
  return { m, calls, el: element };
}

test("a previous episode's late status never ends, fails or reloads its replacement", async () => {
  for (const reply of [
    { state: "complete", error: null },
    { state: "failed", error: { error: "fetch_failed", label: "x", message: "failed" } },
    { state: "failed", error: null },
    null,
    { state: "streaming", error: null },
  ] as (MediaStatus | null)[]) {
    const status = deferred<MediaStatus | null>();
    const described: string[] = [];
    const { m, calls, el } = media({
      describe: async (id) => {
        described.push(id);
        return descriptor({ url: `/v1/media/s/${id}` });
      },
      status: () => status.promise,
    });
    await m.load("episode:a", 0);
    await m.play();
    el.currentTime = 6;
    el.end(); // A ran out; its status is on its way
    await settled();
    await m.load("episode:b", 0);
    await m.play();
    status.resolve(reply);
    await settled();
    await settled();
    assert.deepEqual([calls.ended, calls.error], [0, 0], `A's ${JSON.stringify(reply)} reached B`);
    assert.deepEqual(described, ["a", "b"], "nothing reloaded B at A's position");
    assert.equal(el.src, "/v1/media/s/b");
    assert.equal(el.paused, false);
    assert.equal(m.position, 0);
  }
});

test("a previous episode's seek that is still asking the server never moves its replacement", async () => {
  const held = deferred<Descriptor>();
  let calls = 0;
  const { m, calls: cb, el } = media({
    describe: async (id) => (id === "a" && ++calls === 2 ? held.promise : descriptor({ url: `/v1/media/s/${id}` })),
  });
  await m.load("episode:a", 0);
  await m.play();
  m.seek(300_000); // a relay without byte ranges: the compatibility path, from the server
  await settled();
  await m.load("episode:b", 0);
  await m.play();
  held.resolve(descriptor({ mode: "compat", url: "/v1/media/s/a-compat", offset_ms: 300_000 }));
  await settled();
  await settled();
  assert.equal(el.src, "/v1/media/s/b");
  assert.equal(m.position, 0);
  assert.equal(m.duration, 600_000);
  assert.deepEqual([cb.ended, cb.error], [0, 0]);
});

test("Pause while a seek reloads the stream keeps it paused, and is no error", async () => {
  // The compatibility stream starts again at the target; Pause comes while its metadata is on its way.
  const { m, calls, el } = media({ describe: async () => descriptor({ mode: "compat", url: "/v1/media/s/c" }) });
  await m.load("episode:a", 0);
  await m.play();
  el.holdMetadata = true;
  m.seek(100_000);
  m.pause();
  el.meta();
  await settled();
  assert.equal(el.paused, true, "the late metadata does not start the audio again");
  assert.equal(el.plays, 1);
  assert.equal(m.position, 100_000);
  // Pause while the reloaded stream's play is still starting: the start is cancelled, not failed.
  await m.play();
  el.holdMetadata = false;
  el.holdPlay = true;
  const plays = el.plays;
  m.seek(200_000);
  await settled();
  assert.equal(el.plays, plays + 1, "the reloaded stream is starting");
  m.pause();
  el.started();
  await settled();
  assert.equal(el.paused, true);
  assert.equal(m.position, 200_000);
  assert.deepEqual([calls.error, m.lastError], [0, null]);
});

test("the latest seek wins when the server answers an earlier one last", async () => {
  const replies: ((d: Descriptor) => void)[] = [];
  const { m, calls, el } = media({
    describe: (_id, body) => (body.force === "compat" ? new Promise<Descriptor>((r) => replies.push(r)) : Promise.resolve(descriptor())),
  });
  await m.load("episode:a", 0);
  await m.play();
  // A relay without byte ranges, the targets not buffered: each seek asks for the compatibility path there.
  m.seek(100_000);
  await settled();
  m.seek(200_000);
  await settled();
  assert.equal(replies.length, 2);
  replies[1]!(descriptor({ mode: "compat", url: "/v1/media/s/at200", offset_ms: 200_000 }));
  await settled();
  assert.deepEqual([el.src, m.position, el.paused], ["/v1/media/s/at200", 200_000, false]);
  replies[0]!(descriptor({ mode: "compat", url: "/v1/media/s/at100", offset_ms: 100_000 }));
  await settled();
  await settled();
  assert.deepEqual([el.src, m.position, el.paused], ["/v1/media/s/at200", 200_000, false], "the earlier seek's answer changes nothing");
  // Answered in order, the second seek still waits for its own stream while the first one's arrives.
  m.seek(300_000); // the compatibility stream starts again at the target
  el.holdMetadata = true;
  m.seek(400_000);
  assert.equal(m.position, 400_000);
  el.meta();
  await settled();
  assert.deepEqual([el.src, m.position], ["/v1/media/s/at200?start_ms=400000", 400_000]);
  el.dispatchEvent(new Event("pause"));
  assert.equal(calls.paused, 1, "the element's own events are the player's again once the latest reload is done");
  assert.equal(calls.error, 0);
});

test("an unfinished relay end plays on from where it stopped; Pause meanwhile wins; a stream that cannot start is an error", async () => {
  let status = deferred<MediaStatus | null>();
  const described: number[] = [];
  const { m, calls, el } = media({
    describe: async (_id, body) => {
      described.push(body.start_ms as number);
      // As the server answers: a relay, or with force the compatibility path, starting at start_ms.
      return body.force === "compat" ? descriptor({ mode: "compat", url: "/v1/media/s/compat", offset_ms: body.start_ms as number }) : descriptor();
    },
    status: () => status.promise,
  });
  await m.load("episode:a", 0);
  await m.play();
  el.currentTime = 12;
  el.end(); // the relay ran out early: the server is still streaming the file
  status.resolve({ state: "streaming", error: null });
  await settled();
  await settled();
  await settled();
  // A new descriptor at the interruption; a relay without ranges cannot start there itself, so the compatibility path does.
  assert.deepEqual(described, [0, 12_000, 12_000], "a new descriptor at the interruption");
  assert.deepEqual([calls.ended, calls.error], [0, 0]);
  assert.equal(el.paused, false, "playback goes on");
  assert.equal(el.src, "/v1/media/s/compat");
  assert.equal(m.position, 12_000);

  // Pause while the recovery waits for the server: it stays paused.
  await m.load("episode:b", 0);
  await m.play();
  status = deferred();
  el.currentTime = 30;
  el.end();
  m.pause();
  status.resolve({ state: "streaming", error: null });
  await settled();
  await settled();
  assert.equal(el.paused, true);
  assert.deepEqual([calls.ended, calls.error], [0, 0]);
  assert.equal(m.position, 30_000);

  // A recovered stream the browser cannot start is reported, not left silent.
  await m.load("episode:c", 0);
  await m.play();
  status = deferred();
  el.currentTime = 5;
  el.end();
  el.refusePlay = true;
  status.resolve({ state: "streaming", error: null });
  await settled();
  await settled();
  assert.deepEqual([calls.ended, calls.error], [0, 1]);
  assert.equal(el.paused, true);
});

test("a seek or Play while a seek's stream is loading keeps the player's intent", async () => {
  const replies: ((d: Descriptor) => void)[] = [];
  const { m, calls, el } = media({
    describe: (_id, body) => (body.force === "compat" ? new Promise<Descriptor>((r) => replies.push(r)) : Promise.resolve(descriptor())),
  });
  await m.load("episode:a", 0);
  await m.play();
  // A second seek while the first one's stream loads (the element is paused meanwhile) plays on.
  m.seek(100_000);
  await settled();
  replies[0]!(descriptor({ mode: "compat", url: "/v1/media/s/c", offset_ms: 100_000 }));
  el.holdMetadata = true;
  await settled();
  m.seek(150_000);
  el.meta();
  await settled();
  assert.deepEqual([el.src, m.position, el.paused], ["/v1/media/s/c?start_ms=150000", 150_000, false]);
  // Play pressed while a paused seek still asks the server: the new stream starts when it is ready.
  el.holdMetadata = false;
  await m.load("episode:b", 0);
  m.seek(300_000);
  await settled();
  await m.play();
  replies[1]!(descriptor({ mode: "compat", url: "/v1/media/s/d", offset_ms: 300_000 }));
  await settled();
  await settled();
  assert.deepEqual([el.src, m.position, el.paused], ["/v1/media/s/d", 300_000, false]);
  assert.deepEqual([calls.error, m.lastError], [0, null]);
});

test("a buffered seek after one still asking the server wins over it, and over a pending end", async () => {
  const replies: ((d: Descriptor) => void)[] = [];
  let status = deferred<MediaStatus | null>();
  const { m, calls, el } = media({
    describe: (_id, body) => (body.force === "compat" ? new Promise<Descriptor>((r) => replies.push(r)) : Promise.resolve(descriptor({ url: "/v1/media/s/relay" }))),
    status: () => status.promise,
  });
  await m.load("episode:a", 0);
  await m.play();
  el.buffered = { length: 1, start: () => 0, end: () => 50 }; // a relay without byte ranges, buffered through 50 s
  m.seek(100_000); // not buffered: the compatibility path, from the server
  await settled();
  assert.equal(replies.length, 1);
  m.seek(20_000); // buffered: the element moves at once
  assert.deepEqual([el.currentTime, m.position], [20, 20_000]);
  replies[0]!(descriptor({ mode: "compat", url: "/v1/media/s/old100", offset_ms: 100_000 }));
  await settled();
  await settled();
  assert.deepEqual([el.src, m.position, el.paused], ["/v1/media/s/relay", 20_000, false], "the earlier seek's answer changes nothing");
  el.dispatchEvent(new Event("pause"));
  assert.equal(calls.paused, 1, "the element's own events are the player's again");

  // The relay ran out while the server's status is on its way; a seek back (buffered) plays on from there.
  await m.play();
  el.currentTime = 48;
  el.end();
  await settled();
  m.seek(30_000);
  status.resolve({ state: "complete", error: null });
  await settled();
  await settled();
  assert.deepEqual([calls.ended, calls.error], [0, 0], "the end the person sought back from is not reported");
  assert.deepEqual([m.position, el.paused], [30_000, false]);
  status = deferred();
});

test("a target the element does not report as seekable is reached through the compatibility path, even when buffered (Chromium, a relay without ranges)", async () => {
  const described: { start: number; force: unknown }[] = [];
  const { m, calls, el } = media({
    describe: async (_id, body) => {
      described.push({ start: body.start_ms as number, force: body.force });
      return body.force === "compat"
        ? descriptor({ mode: "compat", url: `/v1/media/s/at${body.start_ms as number}`, offset_ms: body.start_ms as number })
        : descriptor({ url: "/v1/media/s/relay" });
    },
  });
  await m.load("episode:a", 0);
  await m.play();
  // Chromium: the whole file buffered, but seekable only at 0; setting currentTime would start it again from 0.
  el.buffered = { length: 1, start: () => 0, end: () => 225 };
  el.seekable = { length: 1, start: () => 0, end: () => 0 };
  el.currentTime = 3;
  m.seek(60_000);
  assert.equal(m.position, 60_000, "the target shows while the stream is asked for");
  await settled();
  await settled();
  assert.deepEqual(described.at(-1), { start: 60_000, force: "compat" });
  assert.deepEqual([el.src, m.position, el.paused], ["/v1/media/s/at60000", 60_000, false]);
  // Back to the start: 0 is seekable, but the compatibility stream starts at a time.
  m.seek(0);
  await settled();
  assert.deepEqual([el.src, m.position], ["/v1/media/s/at60000?start_ms=0", 0]);
  assert.equal(calls.error, 0);
});

test("a load at a position the element cannot seek to starts the compatibility path there, never at 0", async () => {
  const described: { start: number; force: unknown }[] = [];
  const { m, el } = media({
    describe: async (_id, body) => {
      described.push({ start: body.start_ms as number, force: body.force });
      return body.force === "compat"
        ? descriptor({ mode: "compat", url: `/v1/media/s/at${body.start_ms as number}`, offset_ms: body.start_ms as number })
        : descriptor({ url: "/v1/media/s/relay" });
    },
  });
  el.seekable = { length: 1, start: () => 0, end: () => 0 };
  await m.load("episode:a", 63_000);
  assert.deepEqual(described, [{ start: 63_000, force: undefined }, { start: 63_000, force: "compat" }]);
  assert.deepEqual([el.src, el.currentTime, m.position], ["/v1/media/s/at63000", 0, 63_000]);
  // At 0, the relay plays as it is.
  described.length = 0;
  await m.load("episode:b", 0);
  assert.deepEqual(described, [{ start: 0, force: undefined }]);
  assert.deepEqual([el.src, m.position], ["/v1/media/s/relay", 0]);
});

test("a source the element seeks in moves at once, and its load lands at its position", async () => {
  const described: unknown[] = [];
  const { m, el } = media({
    describe: async (_id, body) => {
      described.push(body.force);
      return descriptor({ seekable: true, url: "/v1/media/s/ranges" });
    },
  });
  el.seekable = { length: 1, start: () => 0, end: () => 600 }; // fetched in ranges: seekable whole
  await m.load("episode:a", 42_000);
  assert.deepEqual([el.src, el.currentTime, m.position], ["/v1/media/s/ranges", 42, 42_000]);
  m.seek(500_000);
  assert.deepEqual([el.currentTime, m.position], [500, 500_000]);
  assert.deepEqual(described, [undefined]);
});

test("a compatibility stream starts at 1× and plays at the player's speed once it plays (WebKit stays at the start of one started faster)", async () => {
  const { m, el } = media({
    describe: async (_id, body) =>
      body.force === "compat" ? descriptor({ mode: "compat", url: "/v1/media/s/compat", offset_ms: body.start_ms as number }) : descriptor({ seekable: true, url: "/v1/media/s/ranges" }),
  });
  m.rate = 1.5;
  // A source the element seeks in plays at the speed from the start.
  el.seekable = { length: 1, start: () => 0, end: () => 600 };
  await m.load("episode:a", 0);
  await m.play();
  assert.deepEqual([el.playbackRate, m.rate], [1.5, 1.5]);
  // A compatibility stream: 1× until it plays, then the speed; the player's speed never changes meanwhile.
  el.seekable = { length: 1, start: () => 0, end: () => 0 };
  m.pause();
  await m.load("episode:b", 63_000);
  assert.equal(el.src, "/v1/media/s/compat");
  m.rate = 1.75; // a speed chosen while it waits
  await m.play();
  assert.deepEqual([el.playbackRate, m.rate], [1, 1.75]);
  el.dispatchEvent(new Event("playing"));
  assert.deepEqual([el.playbackRate, m.rate], [1.75, 1.75]);
  // A speed chosen while it plays applies at once; a resume starts at 1× again.
  m.rate = 2;
  assert.equal(el.playbackRate, 2);
  m.pause();
  await m.play();
  assert.equal(el.playbackRate, 1);
  el.dispatchEvent(new Event("playing"));
  assert.deepEqual([el.playbackRate, m.rate], [2, 2]);
});

test("an engine that reports a file without byte ranges seekable whole (WebKit) seeks in it itself, also beyond its buffer", async () => {
  const described: unknown[] = [];
  const { m, el } = media({
    describe: async (_id, body) => {
      described.push(body.force);
      return descriptor({ url: "/v1/media/s/relay" }); // a relay that is not seekable
    },
  });
  el.seekable = { length: 1, start: () => 0, end: () => 1200 }; // WebKit: it reads the one response to the target
  await m.load("episode:a", 900_000);
  assert.deepEqual([el.src, el.currentTime, m.position], ["/v1/media/s/relay", 900, 900_000]);
  await m.play();
  m.seek(300_000);
  assert.deepEqual([el.currentTime, m.position], [300, 300_000]);
  assert.deepEqual(described, [undefined], "no compatibility path");
});

/** fed is an AudioMedia whose server offers a converted stream (ADTS AAC) from 60 s of a 120 s episode, with a feed it can watch. */
function fed() {
  const streams: Stream[] = [];
  const described: Record<string, unknown>[] = [];
  const m = new AudioMedia(
    1,
    {
      capabilities: async () => [],
      profiles: async () => [{ name: "aac", mime: "audio/aac" }],
      describe: async (id, body) => {
        described.push(body);
        if (id === "plain") return descriptor({ seekable: true, url: "/v1/media/s/plain" }); // an ordinary relayed file
        const start = body.start_ms as number;
        return descriptor({ mode: "compat", profile: "aac", type: "audio/aac", url: "/v1/media/s/conv", offset_ms: start, duration_ms: 120_000 });
      },
      status: async () => ({ state: "complete", error: null }),
      wording: (e) => e.message,
    },
    {
      feed: {
        fetch: (url, init) => {
          const s = new Stream();
          streams.push(s);
          return s.fetch(url, init);
        },
      },
    },
  );
  const calls = { ended: 0, error: 0, paused: 0 };
  m.listen({ paused: () => calls.paused++, ended: () => calls.ended++, time() {}, error: () => calls.error++ });
  return { m, el: element, streams, described, calls };
}

test("a converted stream goes through the browser's MediaSource where it takes the stream's type, with the remaining duration; elsewhere the element plays it", async () => {
  const undo = install("MediaSource");
  try {
    const { m, el, streams } = fed();
    await m.load("episode:a", 60_000);
    await flush();
    const ms = FakeMediaSource.made.at(-1)!;
    assert.equal(el.src, ms.url, "the element plays the MediaSource");
    assert.equal(ms.duration, 60, "120 s less the stream's start at 60 s");
    assert.equal(ms.buffers[0]!.type, "audio/aac", "the profile's full type");
    assert.equal(streams[0]!.requests[0]!.url, "/v1/media/s/conv");
    assert.equal(m.position, 60_000);
    // A browser whose MediaSource does not take the type (Firefox): the element plays the stream itself.
    FakeMediaSource.types = new Set();
    const other = fed();
    await other.m.load("episode:b", 60_000);
    assert.equal(other.el.src, "/v1/media/s/conv");
    m.unload();
    other.m.unload();
  } finally {
    undo();
  }
});

test("a seek in a fed stream restarts the conversion with a fresh MediaSource; the old stream is abandoned; unload abandons the last", async () => {
  const undo = install("MediaSource");
  try {
    const { m, el, streams, calls } = fed();
    await m.load("episode:a", 60_000);
    await m.play();
    await flush();
    m.seek(90_000);
    assert.equal(m.position, 90_000);
    await flush();
    await flush();
    assert.equal(FakeMediaSource.made.length, 2, "a fresh MediaSource");
    assert.equal(el.src, FakeMediaSource.made[1]!.url);
    assert.equal(streams[0]!.aborted, true, "the old stream's fetch is aborted");
    assert.equal(streams[1]!.requests[0]!.url, "/v1/media/s/conv?start_ms=90000");
    assert.equal(FakeMediaSource.made[1]!.duration, 30);
    assert.deepEqual([m.position, el.paused, calls.error], [90_000, false, 0]);
    m.unload();
    assert.equal(streams[1]!.aborted, true);
  } finally {
    undo();
  }
});

test("Pause while a fed seek's stream loads keeps it paused; the player's speed applies from the start (no 1x start on this path)", async () => {
  const undo = install("MediaSource");
  try {
    const { m, el, calls } = fed();
    m.rate = 1.5;
    await m.load("episode:a", 60_000);
    await m.play();
    assert.equal(el.playbackRate, 1.5);
    el.holdMetadata = true;
    m.seek(100_000);
    m.pause();
    await flush();
    el.meta();
    await flush();
    await flush();
    assert.deepEqual([el.paused, m.position, calls.error], [true, 100_000, 0]);
    await m.play();
    assert.deepEqual([el.paused, el.playbackRate], [false, 1.5]);
    m.unload();
  } finally {
    undo();
  }
});

test("ManagedMediaSource turns remote playback off only while a converted stream is the source", async () => {
  const undo = install("ManagedMediaSource");
  try {
    const { m, el } = fed();
    await m.load("episode:a", 60_000);
    assert.equal(el.disableRemotePlayback, true, "required by ManagedMediaSource");
    await m.load("episode:plain", 0);
    assert.deepEqual([el.src, el.disableRemotePlayback], ["/v1/media/s/plain", false], "an ordinary episode plays to AirPlay again");
    await m.load("episode:a", 60_000);
    assert.equal(el.disableRemotePlayback, true);
    m.unload();
    assert.equal(el.disableRemotePlayback, false);
    await m.load("episode:plain", 0);
    assert.equal(el.disableRemotePlayback, false);
    m.unload();
  } finally {
    undo();
  }
});

// ---- starting an episode: the media types ahead of time; publisher URLs that failed in this browser

test("the media types are asked once, before the first play: a play asks no more", async () => {
  const asked = { capabilities: 0, profiles: 0 };
  const { m } = media({
    capabilities: async () => (asked.capabilities++, ["audio/mpeg"]),
    profiles: async () => (asked.profiles++, []),
  });
  m.prepare();
  await settled();
  assert.deepEqual(asked, { capabilities: 1, profiles: 1 });
  await m.load("episode:a", 0);
  await m.load("episode:b", 0);
  assert.deepEqual(asked, { capabilities: 1, profiles: 1 });
});

/** MemoryStorage is the browser's localStorage, as directFailures uses it. */
class MemoryStorage {
  items = new Map<string, string>();
  getItem(k: string) {
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.items.set(k, v);
  }
}

/** publisher answers direct with the publisher's URL, and the relay once asked with direct_failed; it records each request's flag. */
function publisherDescriptors() {
  const flags: boolean[] = [];
  const describe = async (id: string, body: Record<string, unknown>) => {
    flags.push(body.direct_failed === true);
    return body.direct_failed
      ? descriptor({ mode: "relay", url: `/v1/media/s/${id}` })
      : descriptor({ mode: "direct", url: `https://publisher.test/${id}.mp3`, token: null });
  };
  return { flags, describe };
}

/** failSource makes the element fail the source it is loading, as a browser does for a URL it cannot fetch or play. */
function failSource(el: { error: { code: number } | null; dispatchEvent(e: Event): boolean }) {
  el.error = { code: 4 };
  el.dispatchEvent(new Event("error"));
}

test("a publisher URL that failed in this browser is remembered: the episode's next descriptors ask for the relay at once, also after a reload, for a day", async () => {
  const store = new MemoryStorage();
  let now = 1_800_000_000_000;
  const d = publisherDescriptors();
  const first = media({ describe: d.describe }, { failures: directFailures(store, "account-1", () => now) });
  first.el.holdMetadata = true;
  const loading = first.m.load("episode:a", 0);
  await settled();
  assert.equal(first.el.src, "https://publisher.test/a.mp3");
  failSource(first.el);
  await settled();
  assert.equal(first.el.src, "/v1/media/s/a", "the relay after the failure");
  first.el.error = null;
  first.el.meta();
  await loading;
  assert.deepEqual(d.flags, [false, true]);

  // A new page (a reload, the server perhaps restarted and forgot): the relay at once, never the publisher's URL.
  d.flags.length = 0;
  const second = media({ describe: d.describe }, { failures: directFailures(store, "account-1", () => now) });
  await second.m.load("episode:a", 0);
  assert.equal(second.el.src, "/v1/media/s/a");
  assert.deepEqual(d.flags, [true]);
  // Another episode, and the same episode in another account, still try the publisher's URL.
  await second.m.load("episode:b", 0);
  const other = media({ describe: d.describe }, { failures: directFailures(store, "account-2", () => now) });
  await other.m.load("episode:a", 0);
  assert.deepEqual(d.flags, [true, false, false]);
  // A day after the failure the publisher's URL is tried again.
  now += directFailureMs;
  const later = media({ describe: d.describe }, { failures: directFailures(store, "account-1", () => now) });
  await later.m.load("episode:a", 0);
  assert.equal(later.el.src, "https://publisher.test/a.mp3");
});

test("a publisher URL that fails while it plays is remembered too", async () => {
  const store = new MemoryStorage();
  const d = publisherDescriptors();
  const first = media({ describe: d.describe }, { failures: directFailures(store, "account-1") });
  await first.m.load("episode:a", 0);
  await first.m.play();
  assert.equal(first.el.src, "https://publisher.test/a.mp3");
  first.el.currentTime = 30;
  failSource(first.el); // the publisher's connection broke
  await settled();
  await settled();
  assert.equal(first.el.src.startsWith("https://publisher.test/"), false, "it plays on from the server");
  assert.deepEqual(d.flags.slice(0, 2), [false, true]);
  d.flags.length = 0;
  const second = media({ describe: d.describe }, { failures: directFailures(store, "account-1") });
  await second.m.load("episode:a", 0);
  assert.deepEqual(d.flags, [true], "a new page asks for the relay at once");
});

test("the failures kept are the newest, a bounded number; without storage the page still remembers", async () => {
  const store = new MemoryStorage();
  let now = 1_800_000_000_000;
  const f = directFailures(store, "account-1", () => now);
  for (let i = 0; i <= directFailureMax; i++) {
    now++;
    f.add(`e${i}`);
  }
  const kept = JSON.parse(store.getItem("nottennapod:account-1:direct_failed")!) as Record<string, number>;
  assert.equal(Object.keys(kept).length, directFailureMax);
  const fresh = directFailures(store, "account-1", () => now);
  assert.equal(fresh.has("e0"), false, "the oldest went first");
  assert.equal(fresh.has("e1"), true);
  assert.equal(fresh.has(`e${directFailureMax}`), true);
  const refusing = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
  const page = directFailures(refusing, "account-1", () => now);
  page.add("x");
  assert.equal(page.has("x"), true);
  assert.equal(directFailures(null, "account-1").has("x"), false);
});

/**
 * connection is this device's network as the player sees it: the browser's
 * online flag and event, and whether the app's own server answers; guard
 * makes a server call fail while it does not.
 */
function connection() {
  const events = new EventTarget();
  const net = { browser: true, server: true };
  const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator")!;
  Object.defineProperty(globalThis, "navigator", { configurable: true, get: () => ({ onLine: net.browser }) });
  g.addEventListener = events.addEventListener.bind(events);
  g.removeEventListener = events.removeEventListener.bind(events);
  const up = () => net.browser && net.server;
  return {
    net,
    reachable: async () => up(),
    guard<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
      return async (...a: A): Promise<R> => {
        if (!up()) throw new Error("unreachable");
        return fn(...a);
      };
    },
    /** back is the connection coming back: the browser says so. */
    back() {
      net.browser = net.server = true;
      events.dispatchEvent(new Event("online"));
    },
    /** online is the browser saying it is online, whatever the server answers. */
    online() {
      events.dispatchEvent(new Event("online"));
    },
    /** held answers each server check only when the test resolves it, in order. */
    held() {
      const checks: ((up: boolean) => void)[] = [];
      const reachable = () => {
        const d = deferred<boolean>();
        checks.push(d.resolve);
        return d.promise;
      };
      return { checks, reachable };
    },
    restore() {
      Object.defineProperty(globalThis, "navigator", saved);
      delete g.addEventListener;
      delete g.removeEventListener;
    },
  };
}

/** A file fetched in ranges: the element seeks anywhere in it. */
const whole = { length: 1, start: () => 0, end: () => 600 };

/** networkError is the element's transfer breaking (MEDIA_ERR_NETWORK). */
function networkError(el: { error: { code: number } | null; dispatchEvent(e: Event): boolean }) {
  el.error = { code: 2 };
  el.dispatchEvent(new Event("error"));
}

const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) await settled();
};

test("a network error while this device is offline waits for the connection, blames no publisher, and plays on at its position once connected", async () => {
  const c = connection();
  try {
    const store = new MemoryStorage();
    const failures = directFailures(store, "account-1");
    const d = publisherDescriptors();
    const { m, calls, el } = media({ describe: c.guard(d.describe), reachable: c.reachable }, { failures });
    el.seekable = whole;
    await m.load("episode:a", 0);
    await m.play();
    el.currentTime = 30;
    c.net.server = false; // the laptop's connection dropped: the browser has not noticed, but the app's server does not answer either
    networkError(el);
    await settle();
    assert.equal(failures.has("a"), false, "the publisher is not blamed for this device's connection");
    assert.equal(store.getItem("nottennapod:account-1:direct_failed"), null);
    assert.deepEqual(d.flags, [false], "nothing is asked while offline");
    assert.deepEqual(calls.waiting, [true], "the player shows the wait");
    assert.equal(calls.error, 0, "no connection error");
    assert.equal(m.position, 30_000);

    c.back();
    await settle();
    assert.deepEqual(d.flags, [false, false], "a new descriptor: the publisher's URL again");
    assert.equal(el.src, "https://publisher.test/a.mp3");
    assert.equal(el.currentTime, 30, "at the position it had");
    assert.equal(el.paused, false, "and it plays");
    assert.deepEqual(calls.waiting, [true, false]);
    assert.deepEqual([calls.ended, calls.error], [0, 0]);
    assert.equal(failures.has("a"), false);
  } finally {
    c.restore();
  }
});

test("two drops of the connection in one episode are both ridden out, with no connection error", async () => {
  const c = connection();
  try {
    const described: number[] = [];
    const { m, calls, el } = media({
      describe: c.guard(async (_id: string, body: Record<string, unknown>) => (described.push(body.start_ms as number), descriptor())),
      status: c.guard(async () => ({ state: "streaming", error: null }) as MediaStatus),
      reachable: c.reachable,
    });
    el.seekable = whole;
    await m.load("episode:a", 0);
    await m.play();
    // The first drop breaks the relayed stream; the browser knows it is offline.
    el.currentTime = 40;
    c.net.browser = false;
    networkError(el);
    await settle();
    assert.deepEqual(calls.waiting, [true]);
    c.back();
    await settle();
    assert.deepEqual(described, [0, 40_000]);
    assert.equal(el.paused, false);
    assert.equal(m.position, 40_000);
    el.error = null; // the reload's new source has none

    // The second drop ends the stream early, and the server cannot be asked why.
    el.currentTime = 95;
    c.net.browser = false;
    el.end();
    await settle();
    assert.deepEqual(calls.waiting, [true, false, true]);
    assert.equal(m.position, 95_000);
    c.back();
    await settle();
    assert.deepEqual(described, [0, 40_000, 95_000]);
    assert.equal(el.paused, false);
    assert.equal(el.currentTime, 95);
    assert.deepEqual(calls.waiting, [true, false, true, false]);
    assert.deepEqual([calls.ended, calls.error], [0, 0], "no connection error, and no end");
  } finally {
    c.restore();
  }
});

test("a publisher that fails while the app's server answers is remembered as direct-failed, and the relay plays on", async () => {
  const c = connection();
  try {
    const failures = directFailures(new MemoryStorage(), "account-1");
    const d = publisherDescriptors();
    const { m, calls, el } = media({ describe: c.guard(d.describe), reachable: c.reachable }, { failures });
    el.seekable = whole;
    await m.load("episode:a", 0);
    await m.play();
    el.currentTime = 30;
    networkError(el); // the publisher's transfer broke; this device is connected
    await settle();
    assert.equal(failures.has("a"), true);
    assert.deepEqual(d.flags, [false, true]);
    assert.equal(el.src, "/v1/media/s/a");
    assert.equal(el.currentTime, 30);
    assert.equal(el.paused, false);
    assert.deepEqual(calls.waiting, [], "no wait for a connection that is there");
    assert.equal(calls.error, 0);
  } finally {
    c.restore();
  }
});

test("Pause while waiting for the connection: nothing reloads when it comes back; Play then plays on there", async () => {
  const c = connection();
  try {
    const d = publisherDescriptors();
    const { m, calls, el } = media({ describe: c.guard(d.describe), reachable: c.reachable });
    el.seekable = whole;
    await m.load("episode:a", 0);
    await m.play();
    el.currentTime = 30;
    c.net.server = false;
    networkError(el);
    await settle();
    m.pause();
    await settle();
    assert.deepEqual(calls.waiting, [true, false], "the wait ends with Pause");
    c.back();
    await settle();
    assert.deepEqual(d.flags, [false], "no reload");
    assert.equal(el.paused, true);
    assert.equal(m.position, 30_000);
    assert.equal(calls.error, 0);

    await m.play();
    await settle();
    assert.deepEqual(d.flags, [false, false]);
    assert.equal(el.currentTime, 30);
    assert.equal(el.paused, false);
    assert.deepEqual(calls.waiting, [true, false, true, false]);
    assert.equal(calls.error, 0);
  } finally {
    c.restore();
  }
});

test("Pause, or another episode, while a connection check is pending: its late answer changes nothing", async () => {
  const c = connection();
  try {
    // Pause while the check is out: no reload when it answers, and it stays paused.
    let h = c.held();
    const d = publisherDescriptors();
    const one = media({ describe: d.describe, reachable: h.reachable });
    one.el.seekable = whole;
    await one.m.load("episode:a", 0);
    await one.m.play();
    one.el.currentTime = 30;
    networkError(one.el);
    await settle();
    h.checks[0]!(false); // offline: it waits
    await settle();
    c.online(); // the browser says online: a check goes out, and is not answered yet
    await settle();
    assert.equal(h.checks.length, 2);
    one.m.pause();
    h.checks[1]!(true);
    await settle();
    assert.deepEqual(d.flags, [false], "no reload after Pause");
    assert.equal(one.el.paused, true);
    assert.equal(one.m.position, 30_000);
    assert.deepEqual(one.calls.waiting, [true, false]);
    assert.equal(one.calls.error, 0);

    // Pause, then another episode, while the check is out: the old answer never moves the new episode.
    h = c.held();
    const described: string[] = [];
    const two = media({
      describe: async (id, body) => (described.push(`${id}@${body.start_ms as number}`), descriptor({ mode: "direct", url: `https://publisher.test/${id}.mp3`, token: null })),
      reachable: h.reachable,
    });
    two.el.seekable = whole;
    await two.m.load("episode:a", 0);
    await two.m.play();
    two.el.currentTime = 30;
    networkError(two.el);
    await settle();
    h.checks[0]!(false);
    await settle();
    c.online();
    await settle();
    two.m.pause();
    two.el.error = null;
    await two.m.load("episode:b", 90_000);
    await two.m.play();
    h.checks[1]!(true);
    await settle();
    assert.deepEqual(described, ["a@0", "b@90000"], "nothing asked at a's position");
    assert.equal(two.el.src, "https://publisher.test/b.mp3");
    assert.equal(two.m.position, 90_000);
    assert.equal(two.el.paused, false);
    assert.deepEqual(two.calls.waiting, [true, false], "the old wait ended with the new episode, and never again");
    assert.equal(two.calls.error, 0);
  } finally {
    c.restore();
  }
});

test("a second drop during the reconnect waits again, then plays on", async () => {
  const c = connection();
  try {
    const d = publisherDescriptors();
    let dropOnce = false;
    const describe = c.guard(async (id: string, body: Record<string, unknown>) => {
      if (dropOnce) {
        dropOnce = false;
        c.net.server = false; // the connection drops again while the episode is asked for
        throw new Error("unreachable");
      }
      return d.describe(id, body);
    });
    const { m, calls, el } = media({ describe, reachable: c.reachable });
    el.seekable = whole;
    await m.load("episode:a", 0);
    await m.play();
    el.currentTime = 30;
    c.net.server = false;
    networkError(el);
    await settle();
    dropOnce = true;
    c.back();
    await settle();
    assert.deepEqual(calls.waiting, [true], "still waiting");
    assert.equal(calls.error, 0, "no connection error");
    assert.equal(m.position, 30_000);
    assert.equal(m.lastError, null);
    c.back();
    await settle();
    assert.deepEqual(d.flags, [false, false]);
    assert.equal(el.src, "https://publisher.test/a.mp3");
    assert.equal(el.currentTime, 30);
    assert.equal(el.paused, false);
    assert.deepEqual(calls.waiting, [true, false]);
    assert.equal(calls.error, 0);
  } finally {
    c.restore();
  }
});

test("a seek while the first connection check is pending keeps the recovery, which plays on at the seek's target", async () => {
  const c = connection();
  try {
    const h = c.held();
    const d = publisherDescriptors();
    const { m, calls, el } = media({ describe: d.describe, reachable: h.reachable });
    el.seekable = whole;
    await m.load("episode:a", 0);
    await m.play();
    el.currentTime = 30;
    networkError(el);
    await settle();
    m.seek(90_000);
    h.checks[0]!(false);
    await settle();
    assert.deepEqual(calls.waiting, [true], "it waits for the connection");
    assert.equal(m.position, 90_000);
    c.online();
    await settle();
    h.checks[1]!(true);
    await settle();
    assert.deepEqual(d.flags, [false, false]);
    assert.equal(el.currentTime, 90);
    assert.equal(el.paused, false);
    assert.deepEqual(calls.waiting, [true, false]);
    assert.equal(calls.error, 0);
  } finally {
    c.restore();
  }
});

test("a drop while an episode loads blames no publisher: Play plays on once connected", async () => {
  const c = connection();
  try {
    const failures = directFailures(new MemoryStorage(), "account-1");
    const d = publisherDescriptors();
    const { m, calls, el } = media({ describe: c.guard(d.describe), reachable: c.reachable }, { failures });
    el.seekable = whole;
    el.holdMetadata = true;
    const loading = m.load("episode:a", 45_000);
    await settled();
    assert.equal(el.src, "https://publisher.test/a.mp3");
    c.net.server = false;
    networkError(el); // the connection dropped before the metadata came
    await loading;
    assert.equal(failures.has("a"), false, "the publisher is not blamed");
    assert.deepEqual(d.flags, [false]);
    assert.equal(m.position, 45_000);
    el.error = null;
    el.holdMetadata = false;
    await m.play();
    await settle();
    assert.deepEqual(calls.waiting, [true], "Play waits for the connection");
    c.back();
    await settle();
    assert.deepEqual(d.flags, [false, false]);
    assert.equal(el.currentTime, 45);
    assert.equal(el.paused, false);
    assert.deepEqual(calls.waiting, [true, false]);
    assert.equal(calls.error, 0);
    assert.equal(failures.has("a"), false);
  } finally {
    c.restore();
  }
});

/** asked answers each descriptor request after the first only when the test settles it, in order; it counts the element's loads. */
function askedLater(el: { load(): void }) {
  const flags: boolean[] = [];
  const pending: { body: Record<string, unknown>; resolve: (d: Descriptor) => void; reject: (e: Error) => void }[] = [];
  const describe = (id: string, body: Record<string, unknown>) => {
    flags.push(body.direct_failed === true);
    if (flags.length === 1) return Promise.resolve(descriptor({ mode: "direct", url: `https://publisher.test/${id}.mp3`, token: null }));
    return new Promise<Descriptor>((resolve, reject) => pending.push({ body, resolve, reject }));
  };
  const loads = { n: 0 };
  return {
    flags,
    pending,
    describe,
    loads,
    /** counting makes the element count its loads (a fresh source is a load). */
    counting() {
      const load = el.load.bind(el);
      el.load = () => {
        loads.n++;
        load();
      };
    },
  };
}

const direct = (id: string) => descriptor({ mode: "direct", url: `https://publisher.test/${id}.mp3`, token: null });

test("a seek while the reconnect's descriptor is pending: the fresh source is put in place and plays at the seek's target, also after another drop", async () => {
  const c = connection();
  try {
    let a!: ReturnType<typeof askedLater>;
    const { m, calls, el } = media({ describe: (id, body) => a.describe(id, body), reachable: c.reachable });
    a = askedLater(el);
    a.counting();
    el.seekable = whole;
    await m.load("episode:a", 0);
    await m.play();
    el.currentTime = 30;
    c.net.server = false;
    networkError(el);
    await settle();
    c.back();
    await settle();
    assert.equal(a.pending.length, 1, "the reconnect asks for the episode");
    const loadsBefore = a.loads.n;
    m.seek(90_000);
    assert.equal(m.position, 90_000);
    el.error = null; // the fresh source has none
    a.pending[0]!.resolve(direct("a"));
    await settle();
    assert.ok(a.loads.n > loadsBefore, "a fresh source is put in place");
    assert.equal(a.pending[1]?.body.start_ms, 90_000, "the recovery reloads at the seek's target");
    a.pending[1]!.resolve(direct("a"));
    await settle();
    assert.equal(el.currentTime, 90);
    assert.equal(el.paused, false);
    assert.deepEqual(calls.waiting, [true, false]);
    assert.equal(calls.error, 0);

    // Again, and the connection drops while the descriptor is pending: it waits again, for the seek's target.
    el.currentTime = 120;
    c.net.server = false;
    networkError(el);
    await settle();
    c.back();
    await settle();
    assert.equal(a.pending.length, 3);
    m.seek(200_000);
    c.net.server = false;
    a.pending[2]!.reject(new Error("unreachable"));
    await settle();
    assert.deepEqual(calls.waiting, [true, false, true], "waiting again");
    assert.equal(calls.error, 0);
    assert.equal(m.position, 200_000);
    const loadsDropped = a.loads.n;
    el.error = null;
    c.back();
    await settle();
    assert.equal(a.pending.length, 4);
    assert.equal(a.pending[3]!.body.start_ms, 200_000);
    a.pending[3]!.resolve(direct("a"));
    await settle();
    assert.ok(a.loads.n > loadsDropped, "a fresh source is put in place");
    assert.equal(el.currentTime, 200);
    assert.equal(el.paused, false);
    assert.deepEqual(calls.waiting, [true, false, true, false]);
    assert.equal(calls.error, 0);
    assert.ok(a.flags.every((f) => !f), "nothing blamed on the publisher");
  } finally {
    c.restore();
  }
});

test("Pause during the first connection check of a playing recovery: nothing is blamed or reloaded; Play plays on there", async () => {
  const c = connection();
  try {
    const h = c.held();
    const failures = directFailures(new MemoryStorage(), "account-1");
    const d = publisherDescriptors();
    const { m, calls, el } = media({ describe: d.describe, reachable: h.reachable }, { failures });
    el.seekable = whole;
    await m.load("episode:a", 0);
    await m.play();
    el.currentTime = 30;
    networkError(el);
    await settle();
    m.pause();
    h.checks[0]!(true); // connected, but the person paused first
    await settle();
    assert.deepEqual(d.flags, [false], "no reload while paused");
    assert.equal(failures.has("a"), false, "nothing blamed");
    assert.equal(el.paused, true);
    assert.equal(m.position, 30_000);
    assert.deepEqual([calls.error, calls.waiting.length], [0, 0]);

    el.error = null;
    await m.play();
    await settle();
    h.checks[1]!(true);
    await settle();
    assert.deepEqual(d.flags, [false, false], "a new descriptor, the publisher's URL again");
    assert.equal(el.currentTime, 30);
    assert.equal(el.paused, false);
    assert.equal(calls.error, 0);
    assert.equal(failures.has("a"), false);
  } finally {
    c.restore();
  }
});

test("Pause during the check after a failed reconnect: no late error; Play plays on there", async () => {
  const c = connection();
  try {
    const h = c.held();
    let refuse = true;
    const d = publisherDescriptors();
    const describe = async (id: string, body: Record<string, unknown>) => {
      if (d.flags.length === 1 && refuse) {
        refuse = false;
        d.flags.push(false);
        throw new Error("the request failed");
      }
      return d.describe(id, body);
    };
    const { m, calls, el } = media({ describe, reachable: h.reachable });
    el.seekable = whole;
    await m.load("episode:a", 0);
    await m.play();
    el.currentTime = 30;
    networkError(el);
    await settle();
    h.checks[0]!(false); // offline: it waits
    await settle();
    c.online();
    await settle();
    h.checks[1]!(true); // connected: the reconnect's request fails
    await settle();
    assert.equal(h.checks.length, 3, "the failure's cause is asked");
    m.pause();
    h.checks[2]!(true);
    await settle();
    assert.equal(calls.error, 0, "no late error after Pause");
    assert.equal(el.paused, true);
    assert.equal(m.position, 30_000);
    assert.deepEqual(calls.waiting, [true, false]);

    el.error = null;
    await m.play();
    await settle();
    h.checks[3]!(true);
    await settle();
    assert.equal(el.currentTime, 30);
    assert.equal(el.paused, false);
    assert.equal(calls.error, 0);
  } finally {
    c.restore();
  }
});

/**
 * converted answers a's first descriptor at once and every later one of a
 * only when the test settles it (each starts at its start_ms); b's at once.
 * The element plays the stream itself (no MediaSource here).
 */
function converted() {
  const asked: string[] = [];
  const pending: { start: number; resolve: () => void; reject: (e: Error) => void }[] = [];
  const compat = (id: string, start: number) => descriptor({ mode: "compat", url: `/v1/media/s/${id}-${start}`, offset_ms: start, seekable: true });
  const describe = (id: string, body: Record<string, unknown>) => {
    const start = body.start_ms as number;
    asked.push(`${id}@${start}`);
    if (id !== "a" || asked.length === 1) return Promise.resolve(compat(id, start));
    return new Promise<Descriptor>((resolve, reject) => pending.push({ start, resolve: () => resolve(compat(id, start)), reject }));
  };
  return { asked, pending, describe };
}

/** reconnecting plays converted a, breaks it at 30 s while offline, comes back, and leaves the reconnect's descriptor pending. */
async function reconnecting(c: ReturnType<typeof connection>, v: ReturnType<typeof converted>) {
  const made = media({ describe: v.describe, reachable: c.reachable });
  await made.m.load("episode:a", 0);
  await made.m.play();
  made.el.currentTime = 30;
  c.net.server = false;
  networkError(made.el);
  await settle();
  made.el.error = null;
  c.back();
  await settle();
  assert.deepEqual(v.asked, ["a@0", "a@30000"]);
  return made;
}

test("a converted stream: a seek while the reconnect's descriptor is pending, then a drop before the new stream's metadata, waits again and plays on at the seek's target", async () => {
  const c = connection();
  try {
    const v = converted();
    const { m, calls, el } = await reconnecting(c, v);
    m.seek(90_000);
    v.pending[0]!.resolve(); // the stream at 30 s is in place: the recovery asks again at the seek's target
    await settle();
    assert.deepEqual(v.asked, ["a@0", "a@30000", "a@90000"], "the recovery reloads at the seek's target");
    el.holdMetadata = true;
    v.pending[1]!.resolve();
    await settle();
    assert.equal(el.src, "/v1/media/s/a-90000");
    c.net.server = false;
    networkError(el); // the connection drops before the new stream's metadata
    await settle();
    assert.deepEqual(calls.waiting, [true], "it waits again");
    assert.equal(calls.error, 0, "no connection error");
    assert.equal(m.position, 90_000);
    el.error = null;
    el.holdMetadata = false;
    c.back();
    await settle();
    assert.deepEqual(v.asked, ["a@0", "a@30000", "a@90000", "a@90000"]);
    v.pending[2]!.resolve();
    await settle();
    assert.equal(el.src, "/v1/media/s/a-90000");
    assert.equal(m.position, 90_000);
    assert.equal(el.paused, false);
    assert.deepEqual(calls.waiting, [true, false]);
    assert.equal(calls.error, 0);
  } finally {
    c.restore();
  }
});

test("a converted stream: Pause, or another episode, while the reload at a seek's target is pending", async () => {
  const c = connection();
  try {
    // Pause: the stream at the target is put in place paused, with no error; Play plays it there.
    let v = converted();
    const one = await reconnecting(c, v);
    one.m.seek(90_000);
    v.pending[0]!.resolve();
    await settle();
    assert.equal(v.pending.length, 2, "the reload at the seek's target is pending");
    one.m.pause();
    v.pending[1]!.resolve();
    await settle();
    assert.equal(one.el.src, "/v1/media/s/a-90000");
    assert.equal(one.el.paused, true);
    assert.equal(one.m.position, 90_000);
    assert.deepEqual(one.calls.waiting, [true, false]);
    assert.equal(one.calls.error, 0);
    await one.m.play();
    await settle();
    assert.equal(one.el.paused, false);
    assert.equal(one.m.position, 90_000);
    assert.equal(v.asked.length, 3, "nothing asked again");

    // Another episode: the late descriptor of a never replaces it.
    v = converted();
    const two = await reconnecting(c, v);
    two.m.seek(90_000);
    v.pending[0]!.resolve();
    await settle();
    assert.equal(v.pending.length, 2);
    await two.m.load("episode:b", 10_000);
    await two.m.play();
    v.pending[1]!.resolve();
    await settle();
    assert.equal(two.el.src, "/v1/media/s/b-10000");
    assert.equal(two.m.position, 10_000);
    assert.equal(two.el.paused, false);
    assert.deepEqual(two.calls.waiting, [true, false]);
    assert.equal(two.calls.error, 0);
  } finally {
    c.restore();
  }
});
