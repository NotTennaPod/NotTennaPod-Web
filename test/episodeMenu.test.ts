// An episode's own menu, as Android's FeedItemMenuHandler builds it from the
// episode's state.
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EpisodeRow } from "../src/api/views.ts";

(globalThis as Record<string, unknown>).BroadcastChannel = undefined;
const { actionsFor } = await import("../src/ui/episodeActions.ts");

function ep(o: Partial<EpisodeRow> = {}): EpisodeRow {
  return {
    episode_id: "e1", has_media: true, in_queue: false, play_state: "unplayed", favorite: false, position: 0, link: null,
    podcast: { title: "Show", display_title: "Show", image_url: "", state: "subscribed" },
    ...o,
  } as EpisodeRow;
}

const labels = (e: EpisodeRow) => actionsFor({} as never, e).map((a) => a.label);

test("an episode without audio has no Add to queue", () => {
  assert.ok(labels(ep()).includes("add_to_queue_label"));
  assert.ok(!labels(ep({ has_media: false })).includes("add_to_queue_label"));
  assert.ok(labels(ep({ has_media: false, in_queue: true })).includes("remove_from_queue_label"), "one queued before keeps Remove from queue");
});
