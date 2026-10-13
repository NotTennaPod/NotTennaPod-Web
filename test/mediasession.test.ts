// The system's media controls: a feed's artwork that is not a well-formed HTTPS
// URL is left out, and a value the browser refuses never stops the player.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mediaSession } from "../src/player/media.ts";

const episode = { episode_id: "e1", podcast_id: "p1", title: "Episode", podcast: "Show", image: "", description: "" };
const handlers = { play() {}, pause() {}, rewind() {}, fastForward() {}, skip() {}, seek() {} };

/** withSession installs a Media Session whose MediaMetadata checks artwork as browsers do. */
function withSession(fn: (ms: { metadata: unknown; playbackState: string }) => void, refuse = false): void {
  const ms = { metadata: null as unknown, playbackState: "none", setActionHandler() {}, setPositionState() {} };
  const g = globalThis as Record<string, unknown>;
  const saved = { metadata: g.MediaMetadata, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator") };
  g.MediaMetadata = class {
    artwork: { src: string }[];
    constructor(init: { artwork: { src: string }[] }) {
      if (refuse) throw new TypeError("refused");
      for (const a of init.artwork) new URL(a.src); // browsers throw a TypeError for a malformed src
      this.artwork = init.artwork;
    }
  };
  Object.defineProperty(globalThis, "navigator", { value: { mediaSession: ms }, configurable: true });
  try {
    fn(ms);
  } finally {
    g.MediaMetadata = saved.metadata;
    if (saved.navigator) Object.defineProperty(globalThis, "navigator", saved.navigator);
  }
}

test("artwork that is not a well-formed HTTPS URL is left out", () => {
  for (const image of ["https://[", "http://example.com/a.jpg", "javascript:alert(1)", "", "https://"]) {
    withSession((ms) => {
      mediaSession(handlers).show({ ...episode, image }, true);
      assert.deepEqual((ms.metadata as { artwork: unknown[] }).artwork, [], image);
      assert.equal(ms.playbackState, "playing");
    });
  }
  withSession((ms) => {
    mediaSession(handlers).show({ ...episode, image: "https://example.com/a.jpg" }, false);
    assert.deepEqual((ms.metadata as { artwork: unknown[] }).artwork, [{ src: "https://example.com/a.jpg" }]);
  });
});

test("a value the browser refuses never stops the player", () => {
  withSession((ms) => {
    const s = mediaSession(handlers);
    assert.doesNotThrow(() => s.show({ ...episode, image: "https://example.com/a.jpg" }, true));
    assert.equal(ms.metadata, null);
  }, true);
});
