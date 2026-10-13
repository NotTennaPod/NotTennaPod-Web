// Which of Android's multi-select actions a selection shows
// (FeedItemMenuHandler.onPrepareMenu for a selection, and QueueFragment's
// canMove): pure rules, so they are tested without a page.
import type { EpisodeRow } from "../api/views.ts";

/** BulkKind is an action of Android's episodes_apply_action_speeddial the browser has, in its order. */
export type BulkKind =
  | "mark_unplayed"
  | "mark_played"
  | "remove_from_queue"
  | "add_to_queue"
  | "remove_inbox"
  | "add_favorite"
  | "remove_favorite"
  | "reset_position"
  | "move_to_top"
  | "move_to_bottom";

/** QueueContext is what the queue's moves need: its order, and whether it keeps sorted. */
export interface QueueContext {
  order: string[];
  keepSorted: boolean;
}

/**
 * bulkKinds are the actions shown for a selection, in Android's order. The
 * queue hides Add to queue and Remove from inbox and shows the moves as
 * canMove decides; elsewhere the moves are hidden. Downloads, deletion and
 * sharing are the phone's.
 */
export function bulkKinds(sel: EpisodeRow[], queue?: QueueContext): BulkKind[] {
  const any = (f: (e: EpisodeRow) => boolean) => sel.some(f);
  let addFavorite = any((e) => !e.favorite);
  let removeFavorite = any((e) => e.favorite);
  if (sel.length > 1 && addFavorite) removeFavorite = false;
  const out: BulkKind[] = [];
  if (any((e) => e.play_state === "played")) out.push("mark_unplayed");
  if (any((e) => e.play_state !== "played") && !(sel.length === 1 && sel[0]!.podcast.state === "not_subscribed")) out.push("mark_played");
  if (any((e) => e.in_queue)) out.push("remove_from_queue");
  if (!queue && any((e) => e.has_media && !e.in_queue)) out.push("add_to_queue");
  if (!queue && any((e) => e.play_state === "new")) out.push("remove_inbox");
  if (addFavorite) out.push("add_favorite");
  if (removeFavorite) out.push("remove_favorite");
  if (any((e) => e.has_media && e.position !== 0)) out.push("reset_position");
  if (queue) {
    const [top, bottom] = canMove(queue, sel);
    if (top) out.push("move_to_top");
    if (bottom) out.push("move_to_bottom");
  }
  return out;
}

/** canMove is QueueFragment.canMove: whether moving the selection to the top or the bottom changes anything. */
export function canMove(queue: QueueContext, sel: EpisodeRow[]): [boolean, boolean] {
  const n = queue.order.length;
  const k = sel.length;
  if (k === 0 || n === 0 || queue.keepSorted || k === n) return [false, false];
  const ids = sel.map((e) => e.episode_id);
  const first = ids[0] === queue.order[0];
  const last = ids[k - 1] === queue.order[n - 1];
  if (k === 1) return [!first, !last];
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (first && same(ids, queue.order.slice(0, k))) return [false, true];
  if (last && same(ids, queue.order.slice(n - k))) return [true, false];
  return [true, true];
}
