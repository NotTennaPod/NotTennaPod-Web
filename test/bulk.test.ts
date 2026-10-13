// Android's multi-select actions for a selection (FeedItemMenuHandler.onPrepareMenu,
// QueueFragment.canMove).
import { test } from "node:test";
import assert from "node:assert/strict";
import { bulkKinds, canMove } from "../src/ui/bulk.ts";
import type { EpisodeRow } from "../src/api/views.ts";

function ep(id: string, o: Partial<EpisodeRow> = {}): EpisodeRow {
  return {
    episode_id: id, has_media: true, in_queue: false, play_state: "unplayed", favorite: false, position: 0,
    podcast: { title: "Show", display_title: "Show", image_url: "", state: "subscribed" },
    ...o,
  } as EpisodeRow;
}

test("the actions follow the selection's states, in Android's order", () => {
  assert.deepEqual(bulkKinds([ep("a")]), ["mark_played", "add_to_queue", "add_favorite"]);
  assert.deepEqual(
    bulkKinds([ep("a", { play_state: "played", in_queue: true, favorite: true, position: 5 }), ep("b", { play_state: "new" })]),
    ["mark_unplayed", "mark_played", "remove_from_queue", "add_to_queue", "remove_inbox", "add_favorite", "reset_position"],
    "several rows: Remove from favorites gives way to Add to favorites",
  );
  assert.deepEqual(bulkKinds([ep("a", { favorite: true })]), ["mark_played", "add_to_queue", "remove_favorite"]);
  assert.deepEqual(bulkKinds([ep("a", { favorite: true }), ep("b", { favorite: true })]), ["mark_played", "add_to_queue", "remove_favorite"]);
  assert.deepEqual(bulkKinds([ep("a", { has_media: false, position: 0 })]), ["mark_played", "add_favorite"], "no media: no queue, no reset");
  assert.deepEqual(bulkKinds([ep("a", { podcast: { title: "", display_title: "", image_url: "", state: "not_subscribed" } })]), ["add_to_queue", "add_favorite"],
    "one episode of a podcast not subscribed is not marked played");
});

test("the queue hides Add to queue and Remove from inbox, and moves only what moving changes", () => {
  const q = { order: ["a", "b", "c", "d"], keepSorted: false };
  const queued = (id: string) => ep(id, { in_queue: true, play_state: "new" });
  assert.deepEqual(bulkKinds([queued("b")], q), ["mark_played", "remove_from_queue", "add_favorite", "move_to_top", "move_to_bottom"]);
  assert.deepEqual(canMove(q, [queued("a")]), [false, true], "the first one");
  assert.deepEqual(canMove(q, [queued("d")]), [true, false], "the last one");
  assert.deepEqual(canMove(q, [queued("a"), queued("b")]), [false, true], "a block at the top");
  assert.deepEqual(canMove(q, [queued("c"), queued("d")]), [true, false], "a block at the bottom");
  assert.deepEqual(canMove(q, [queued("a"), queued("c")]), [true, true], "not a block");
  assert.deepEqual(canMove(q, ["a", "b", "c", "d"].map(queued)), [false, false], "the whole queue");
  assert.deepEqual(canMove({ ...q, keepSorted: true }, [queued("b")]), [false, false], "keep sorted");
  assert.deepEqual(canMove({ order: ["a", "b", ""], keepSorted: false }, [queued("b")]), [true, true], "more pages after the last loaded");
});
