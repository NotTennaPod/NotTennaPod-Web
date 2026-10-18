// An episode's actions, as Android's episode context menu offers them, each
// journaled as a fact, with Android's snackbars and Undo where Android has
// them.
import { t, plural, type StringKey } from "../i18n.ts";
import { reads, type EpisodeRow } from "../api/views.ts";
import * as act from "../app/actions.ts";
import { addToQueue, loadedHere, moveAllTo, moveTo, restoreAt, savedIndexes, wholeQueue, type Saved } from "../app/queueOps.ts";
import { externalLink } from "../shownotes/sanitize.ts";
import { refusal } from "../journal/journal.ts";
import type { Sync } from "../app/sync.ts";
import { exportBeforeCut, playLabel, playerOf } from "../player/instance.ts";

export interface EpisodeAction {
  label: StringKey;
  run: () => Promise<void>;
}

/** run journals a fact and reports a refusal as a snackbar (not_applied, rejected), whichever tab pushes it. */
async function run(sync: Sync, body: Parameters<Sync["act"]>[0]): Promise<string> {
  const entry = await sync.act({ ...body, awaited: true });
  void sync.outcome(entry.op_id).then((r) => {
    if (r && refusal(r)) sync.notify(reasonText(r.reason));
  });
  return entry.op_id;
}

/**
 * runAll is run for an action split into several facts (actions.chunks): one
 * snackbar for a refusal, whichever part it was. Once journaled it gives
 * `acknowledged`, which resolves when the server has every part.
 */
async function runAll(sync: Sync, bodies: Parameters<Sync["act"]>[0][]): Promise<{ acknowledged: Promise<void> }> {
  const entries = await sync.actAll(bodies.map((b) => ({ ...b, awaited: true })));
  let told = false;
  const outcomes = entries.map((entry) =>
    sync.outcome(entry.op_id).then((r) => {
      if (r && refusal(r) && !told) {
        told = true;
        sync.notify(reasonText(r.reason));
      }
    }),
  );
  return { acknowledged: Promise.all(outcomes).then(() => {}) };
}

function reasonText(reason: string | undefined): string {
  switch (reason) {
    case "generation_closed":
    case "unknown_podcast":
      return t("no_subscriptions_head_label");
    default:
      return reason ? reason.replace(/_/g, " ") : "";
  }
}

export async function enqueue(sync: Sync, episodes: EpisodeRow[]): Promise<void> {
  await sync.pushed();
  const [queue, summary] = await Promise.all([wholeQueue(), reads.summary()]);
  const body = addToQueue(episodes, queue, summary.policies.queue, loadedHere(playerOf(sync)?.state));
  if (!body) return;
  await run(sync, body);
  sync.notify(plural("added_to_queue_message", episodes.length));
}

export async function move(sync: Sync, e: EpisodeRow, where: "top" | "bottom"): Promise<void> {
  await sync.pushed();
  const body = moveTo(e, await wholeQueue(), where);
  if (body) await run(sync, body);
}

/** moveAll moves the selection to the top or the bottom of the queue (Android's multi select). */
export async function moveAll(sync: Sync, episodes: EpisodeRow[], where: "top" | "bottom"): Promise<void> {
  await sync.pushed();
  const body = moveAllTo(episodes, await wholeQueue(), where);
  if (body) await run(sync, body);
}

/**
 * dequeue removes episodes from the queue; Undo puts each back at the index
 * it had (RemoveFromQueueSwipeAction), resolved against the queue at Undo
 * time (PROTOCOL §7.6).
 */
export async function dequeue(sync: Sync, episodes: EpisodeRow[]): Promise<void> {
  await sync.pushed();
  const saved = savedIndexes(episodes, await wholeQueue());
  const removal = await runAll(sync, act.chunks(episodes, act.queueRemove));
  sync.notify(plural("removed_from_queue_message", episodes.length), {
    label: t("undo"),
    run: () => undoRemoval(sync, saved, removal.acknowledged),
  });
}

/**
 * undoRemoval puts the removed episodes back once the server has the
 * removal (a large one takes a while to send): the queue it resolves their
 * places against is the queue without them. Its facts are journaled
 * together, in their order (restoreAt chains them).
 */
async function undoRemoval(sync: Sync, saved: Saved[], removed: Promise<void>): Promise<void> {
  await removed;
  await sync.pushed();
  const bodies = restoreAt(saved, await wholeQueue());
  if (bodies.length) await runAll(sync, bodies);
}

export async function removeFromInbox(sync: Sync, episodes: EpisodeRow[]): Promise<void> {
  await runAll(sync, act.chunks(episodes, (part) => act.dismiss(part)));
  sync.notify(plural("removed_from_inbox_batch_label", episodes.length), {
    label: t("undo"),
    run: async () => {
      for (const e of episodes) await run(sync, act.restoreState(e, "new", e.position));
    },
  });
}

/** play streams the episode in this tab's player, or pauses it while it plays (Android's item action button). */
export async function play(sync: Sync, e: EpisodeRow): Promise<void> {
  const player = playerOf(sync);
  if (!player) return;
  if (playLabel(sync, e.episode_id) === "pause_label") await player.pause();
  else await player.play(e);
}

/** withListening adds the listening a position reset or a cut must observe, after exporting it (PROTOCOL §8, §12). */
async function withListening(sync: Sync, body: Parameters<Sync["act"]>[0]): Promise<Parameters<Sync["act"]>[0]> {
  const listening = await exportBeforeCut(sync);
  return { ...body, dependencies: [...(body.dependencies ?? []), ...listening] };
}

export async function setPlayed(sync: Sync, episodes: EpisodeRow[], played: boolean): Promise<void> {
  for (const e of episodes) await run(sync, played ? await withListening(sync, act.markPlayed(e)) : act.markUnplayed(e));
  sync.notify(plural(played ? "marked_as_played_message" : "marked_as_unplayed_message", episodes.length), {
    label: t("undo"),
    run: async () => {
      for (const e of episodes) await run(sync, act.restoreState(e, e.play_state, e.position));
    },
  });
}

/** markPlayedNow is Android's MarkAsPlayedActionButton: played at once, no snackbar. */
export async function markPlayedNow(sync: Sync, e: EpisodeRow): Promise<void> {
  await run(sync, await withListening(sync, act.markPlayed(e)));
}

export async function setFavorite(sync: Sync, episodes: EpisodeRow[], on: boolean): Promise<void> {
  for (const e of episodes) await run(sync, act.favorite(e, on));
  sync.notify(plural(on ? "added_to_favorites_message" : "removed_from_favorites_message", episodes.length));
}

export async function resetPosition(sync: Sync, episodes: EpisodeRow[]): Promise<void> {
  // Android stops the player when its episode's position is reset.
  for (const e of episodes) await playerOf(sync)?.stopFor(e.episode_id);
  for (const e of episodes) await run(sync, await withListening(sync, act.resetPosition(e)));
  sync.notify(plural("reset_position_message", episodes.length));
}

export async function removeFromHistory(sync: Sync, e: EpisodeRow): Promise<void> {
  const time = e.history;
  const removal = await run(sync, await withListening(sync, act.historyRemove(e)));
  if (time) {
    sync.notify(t("removed_history_label"), {
      label: t("undo"),
      run: async () => {
        await run(sync, act.historyRestore(e, removal, time));
      },
    });
  }
}

/** actionsFor lists an episode's menu as Android builds it from the episode's state. */
export function actionsFor(sync: Sync, e: EpisodeRow, where?: "history" | "queue" | "inbox"): EpisodeAction[] {
  const out: EpisodeAction[] = [];
  if (e.has_media) out.push({ label: playLabel(sync, e.episode_id), run: () => play(sync, e) });
  if (e.in_queue) out.push({ label: "remove_from_queue_label", run: () => dequeue(sync, [e]) });
  else out.push({ label: "add_to_queue_label", run: () => enqueue(sync, [e]) });
  if (where === "queue") {
    out.push({ label: "move_to_top_label", run: () => move(sync, e, "top") });
    out.push({ label: "move_to_bottom_label", run: () => move(sync, e, "bottom") });
  }
  if (e.play_state === "new") out.push({ label: "remove_inbox_label", run: () => removeFromInbox(sync, [e]) });
  if (e.play_state === "played") out.push({ label: "mark_as_unplayed_label", run: () => setPlayed(sync, [e], false) });
  else out.push({ label: "mark_as_played_label", run: () => setPlayed(sync, [e], true) });
  if (e.position > 0) out.push({ label: "reset_playback_position_label", run: () => resetPosition(sync, [e]) });
  if (e.favorite) out.push({ label: "remove_from_favorite_label", run: () => setFavorite(sync, [e], false) });
  else out.push({ label: "add_to_favorite_label", run: () => setFavorite(sync, [e], true) });
  if (where === "history" && e.history) out.push({ label: "remove_history_label", run: () => removeFromHistory(sync, e) });
  const link = e.link ? externalLink(e.link, location.origin) : null;
  if (link) out.push({ label: "visit_website_label", run: async () => void window.open(link, "_blank", "noopener,noreferrer") });
  return out;
}
