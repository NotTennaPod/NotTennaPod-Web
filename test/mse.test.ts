// The player's feed of converted streams through Media Source Extensions
// (src/player/mse.ts): which MediaSource it takes; whole ADTS frames appended
// in order; the window held ahead bounding the transfer itself, continued where
// the content ends without the continuation's priming; nothing fetched during a
// pause; a stalled transfer ended as an error; what it keeps behind; how it
// ends, fails and is abandoned; remote playback restored after
// ManagedMediaSource.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Adts, Feed, isAdts, mediaSourceFor, type FeedOptions, type MediaSourceCtor } from "../src/player/mse.ts";
import { adts, FakeMediaSource, frameS, install, settled, sourceAt, Stream } from "./fakeMediaSource.ts";

/** Element is a media element as far as the feed uses it: its time, its source, its events. */
class Element extends EventTarget {
  currentTime = 0;
  disableRemotePlayback = false;
  #src = "";
  get src() {
    return this.#src;
  }
  set src(url: string) {
    this.#src = url;
    sourceAt(url)?.open();
  }
  /** playTo moves the playing position, as playback does. */
  playTo(t: number) {
    this.currentTime = t;
    this.dispatchEvent(new Event("timeupdate"));
  }
}

let undo: () => void = () => {};
const feeds: Feed[] = [];
afterEach(() => {
  for (const f of feeds.splice(0)) f.close(); // a feed left waiting would keep polling
  undo();
});

function feed(opts: FeedOptions & { durationS?: number; type?: string } = {}) {
  const el = new Element();
  const stream = new Stream();
  const f = new Feed(el as unknown as HTMLMediaElement, FakeMediaSource as unknown as MediaSourceCtor, "/v1/media/s/t?start_ms=60000", 60_000, opts.type ?? "audio/aac", opts.durationS ?? 120, {
    ...opts,
    fetch: stream.fetch,
  });
  f.attach();
  feeds.push(f);
  return { el, stream, f, ms: () => FakeMediaSource.made.at(-1)!, sb: () => FakeMediaSource.made.at(-1)!.buffers[0]! };
}

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);

test("plain MediaSource where the browser has it, ManagedMediaSource only without it, and neither for a type it refuses", () => {
  undo = install("both");
  assert.equal(mediaSourceFor("audio/aac"), (globalThis as { MediaSource?: unknown }).MediaSource);
  undo();
  undo = install("ManagedMediaSource");
  assert.equal(mediaSourceFor("audio/aac"), (globalThis as { ManagedMediaSource?: unknown }).ManagedMediaSource);
  assert.equal(mediaSourceFor('audio/mp4; codecs="mp4a.40.2"'), null, "a type it refuses");
  undo();
  undo = install("none");
  assert.equal(mediaSourceFor("audio/aac"), null, "no MediaSource (an older browser)");
  assert.equal(isAdts("audio/aac"), true);
  assert.equal(isAdts("audio/mpeg"), false);
});

test("ADTS framing: whole frames only, a partial frame kept for the next chunk, a continuation's first frame (priming) left out", () => {
  const a = new Adts();
  a.reset(false);
  const three = adts(3);
  let r = a.push(three.subarray(0, 20)); // two whole frames and half of the third
  assert.deepEqual([r.bytes.length, r.seconds, r.firstSeconds], [16, 2 * frameS, frameS]);
  r = a.push(three.subarray(20));
  assert.deepEqual([r.bytes.length, r.seconds, r.firstSeconds], [8, frameS, 0]);
  a.reset(true);
  r = a.push(adts(3, 7));
  assert.deepEqual([r.bytes.length, r.seconds, r.firstSeconds], [16, 2 * frameS, 0], "the priming frame dropped");
  assert.throws(() => a.push(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /not ADTS/);
});

test("the feed is the element's source: the remaining duration, the stream's type, whole frames appended in order, ended where it ends", async () => {
  undo = install();
  const { el, stream, ms, sb } = feed({ durationS: 30 });
  assert.equal(el.src, ms().url);
  await settled();
  assert.equal(ms().duration, 30, "known before the stream ends: not live");
  assert.equal(sb().type, "audio/aac");
  assert.deepEqual(stream.requests.map((r) => [r.url, r.init.credentials, r.init.cache]), [["/v1/media/s/t?start_ms=60000", "same-origin", "no-store"]]);
  const frames = adts(5);
  stream.push(frames.subarray(0, 12)); // a frame and a half
  stream.push(frames.subarray(12));
  await settled();
  stream.end();
  await settled();
  assert.deepEqual(sb().appended, [8, 32], "whole frames only");
  near(sb().to, 5 * frameS);
  assert.deepEqual(ms().ended, [undefined], "a clean end ends the MediaSource");
  assert.equal(el.disableRemotePlayback, false, "AirPlay stays with plain MediaSource");
});

test("a full window stops the transfer; playback using it continues the conversion where the content ends, without the continuation's priming", async () => {
  undo = install();
  const { el, stream, f, sb } = feed({ aheadS: 10.5 * frameS, resumeS: 5 * frameS });
  await settled();
  for (let i = 0; i < 30; i++) stream.push(adts(1));
  await settled(20);
  near(sb().to, 11 * frameS); // more than 10.5 frames ahead of 0: the transfer stops
  assert.equal(stream.requests[0]!.init.signal!.aborted, true, "the transfer is stopped, not just left unread");
  assert.equal(f.transfers, 1);
  el.playTo(7 * frameS); // 4 frames ahead now: under resumeS
  await settled(10);
  assert.equal(f.transfers, 2);
  // The first stream's 11 frames hold 10 frames of content (its first is the encoder's priming).
  assert.equal(stream.last.url, `/v1/media/s/t?start_ms=${60_000 + Math.round(10 * frameS * 1000)}`);
  stream.push(adts(4, 9)); // the continuation: its priming and three frames
  await settled(10);
  near(sb().to, 14 * frameS);
  assert.deepEqual(sb().appended.slice(-1), [24], "three frames appended, the priming left out");
});

test("during a pause with the window full nothing is fetched, however long", async () => {
  undo = install();
  const { stream, f } = feed({ aheadS: 4 * frameS, stallMs: 100 });
  await settled();
  for (let i = 0; i < 10; i++) stream.push(adts(1));
  await settled(20);
  assert.equal(f.transfers, 1);
  assert.equal(stream.aborted, true);
  await new Promise((r) => setTimeout(r, 1_500)); // past the feed's own waits, and its stall bound
  assert.equal(f.transfers, 1, "no new request while paused");
  assert.deepEqual(FakeMediaSource.made.at(-1)!.ended, [], "waiting on the window is not a stall");
});

test("a transfer that stops sending ends as a network error, the player's cue to reload at its position", async () => {
  undo = install();
  const silent = feed({ stallMs: 80, firstByteMs: 80 });
  await settled();
  silent.stream.push(adts(2));
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(silent.ms().ended, ["network"]);
  assert.equal(silent.stream.aborted, true);
  const never = feed({ firstByteMs: 80 });
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(never.ms().ended, ["network"], "no first byte either");
});

test("it keeps behindS behind the playing position and drops what is older", async () => {
  undo = install();
  const { el, stream, sb } = feed({ aheadS: 1000, behindS: 15 * frameS });
  await settled();
  stream.push(adts(40));
  await settled();
  el.playTo(30 * frameS);
  stream.push(adts(1));
  await settled();
  assert.equal(sb().removed.length, 1);
  near(sb().removed[0]![1], 15 * frameS);
});

test("a full buffer drops what is behind and appends once playback makes room", async () => {
  undo = install();
  const { el, stream, sb } = feed({ aheadS: 1000, behindS: 1000 });
  await settled();
  sb().quota = 25 * frameS;
  stream.push(adts(20));
  await settled();
  stream.push(adts(10)); // 30 > 25: full
  await settled();
  near(sb().to, 20 * frameS);
  el.playTo(20 * frameS); // what lies more than a second behind can go
  await settled(10);
  near(sb().to, 30 * frameS);
});

test("a refused or failed stream ends with a network error, which the element reports as its error", async () => {
  undo = install();
  const refused = feed();
  refused.stream.status = 503;
  await settled();
  assert.deepEqual(refused.ms().ended, ["network"]);
  const failed = feed();
  await settled();
  failed.stream.push(adts(2));
  await settled();
  failed.stream.fail();
  await settled();
  assert.deepEqual(failed.ms().ended, ["network"]);
});

test("another type than ADTS (no frames to continue at) is bounded by reading, in one transfer", async () => {
  undo = install();
  const { el, stream, f, sb } = feed({ type: "audio/mpeg", aheadS: 25 });
  await settled();
  for (let i = 0; i < 6; i++) stream.push(new Uint8Array(10));
  await settled(10);
  assert.equal(sb().to, 30, "30 s ahead of 0: past 25, so it stops reading");
  el.playTo(10);
  await settled(10);
  assert.equal(sb().to, 40);
  assert.equal(f.transfers, 1);
});

test("close abandons the stream: the transfer is aborted, nothing more is appended, and nothing is reported", async () => {
  undo = install();
  const { f, stream, ms, sb } = feed();
  await settled();
  stream.push(adts(2));
  await settled();
  f.close();
  assert.equal(stream.aborted, true);
  stream.push(adts(2));
  await settled();
  assert.deepEqual(sb().appended, [16]);
  assert.deepEqual(ms().ended, [], "no end, no error: the element has another source");
});

test("with ManagedMediaSource (iOS Safari) remote playback is off while the feed is the source, and as it was after", async () => {
  undo = install("ManagedMediaSource");
  const { el, f } = feed();
  assert.equal(el.disableRemotePlayback, true);
  f.close();
  assert.equal(el.disableRemotePlayback, false);
});
