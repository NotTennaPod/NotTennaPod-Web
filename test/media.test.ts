// The audio element adapter (PROTOCOL §13) against a fake element
// whose metadata, play promises and status replies the test releases: a
// replaced source, a later seek, Pause and an unfinished end each win over
// the work still under way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AudioMedia, type Descriptor, type MediaStatus, type Sources } from "../src/player/media.ts";
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

function media(sources: Partial<Sources>) {
  const calls = { ended: 0, error: 0, paused: 0 };
  const m = new AudioMedia(1, {
    capabilities: async () => [],
    describe: async () => descriptor(),
    status: async () => ({ state: "complete", error: null }),
    wording: (e) => e.message,
    ...sources,
  });
  m.listen({ paused: () => calls.paused++, ended: () => calls.ended++, time() {}, error: () => calls.error++ });
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
