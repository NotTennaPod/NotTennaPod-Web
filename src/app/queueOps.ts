// The queue's commands as a phone makes them (NotTennaPod-Server
// PROTOCOL §7.6): every placement carries the place the
// browser resolved against the queue it saw when it acted (`start`, `after`
// an episode, `end`), as Android 3.12.1 resolves its location; the server
// replays the commands and publishes the keys. The keys sent are predictions
// of that replay: an add is inserted at its place and then, under Keep
// sorted, the queue is stable-sorted on the server's canonical values, as
// Android does and the replay does.
import { reads, type EpisodeRow, type Summary } from "../api/views.ts";
import { compareKeys, keyString, uuidValue, type QueueKey } from "../queue/keys.ts";
import { rekey, sortQueue, type Item, type Placed, type SortOrder } from "../queue/sort.ts";
import { keyOf, placeBetween, queueAdd, queueMove, queueMoveRun, queueRestore, queueSort, ref, type EpisodeRef, type Place, type Placement } from "./actions.ts";
import type { FactBody } from "../journal/journal.ts";
import { uuid } from "../util/random.ts";

/** wholeQueue reads every queue member at one head. */
export async function wholeQueue(): Promise<EpisodeRow[]> {
  let page = await reads.queue({ limit: 500 });
  const out = [...page.items];
  while (page.next_page_token) {
    page = await reads.queue({ limit: 500, page_token: page.next_page_token });
    out.push(...page.items);
  }
  return out;
}

// ---- canonical sort values

/** integer reads an integer as the server does (a JSON integer, or one in a decimal string); null otherwise. */
function integer(v: unknown): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) ? v : null;
  if (typeof v === "string" && /^[+-]?\d+$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function object(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * sortValues are an episode's canonical sort values, read from its records
 * the way the server reads them for a sort (its sortValues, PROTOCOL §7.6):
 * the occurrence evidence's title and publication time, replaced by the
 * catalog's; the feed's duration, replaced by the measured one; the
 * podcast's catalog title. (The row's shown title, date and duration can
 * differ: a date the server first saw, no duration without media.)
 */
export function sortValues(e: EpisodeRow): Item & { row: EpisodeRow } {
  const occurrence = object(object(e.records.identity?.value).occurrence);
  const meta = object(e.records.metadata?.value);
  let title = typeof occurrence.title === "string" ? occurrence.title : "";
  if (typeof meta.title === "string") title = meta.title;
  const publication = integer(meta.pub_date) ?? integer(occurrence.publication_time) ?? 0;
  const duration = integer(e.records.measured_duration?.value.duration_ms) ?? integer(object(meta.media).duration) ?? 0;
  return { row: e, episode_id: e.episode_id, podcast_id: e.podcast_id, title, podcast_title: e.podcast.title ?? "", publication_time: publication, duration };
}

// ---- places (PROTOCOL §7.6)

const start: Place = { kind: "start" };
const end: Place = { kind: "end" };

/** nameable is the reference a fact names an episode by; null when it cannot be named (no live subscription). */
function nameable(e: EpisodeRow): EpisodeRef | null {
  try {
    return ref(e);
  } catch {
    return null;
  }
}

/**
 * placeAfter is `after` the last of `before` a fact can name, else `start`:
 * a gap next to an episode no fact can name is the gap after the nearest one
 * before it (PROTOCOL §7.6, mixed queues).
 */
export function placeAfter(before: EpisodeRow[]): Place {
  for (let i = before.length - 1; i >= 0; i--) {
    const r = nameable(before[i]!);
    if (r) return { kind: "after", after: r };
  }
  return start;
}

/**
 * placeAt is the place of an index in the queue (PROTOCOL §7.6, the random index rule):
 * 0 is `start`, any other index `after` the episode before it, the tail too
 * (after the last, never `end`). The index is clamped to the queue.
 */
export function placeAt(queue: EpisodeRow[], index: number): Place {
  return placeAfter(queue.slice(0, Math.max(0, Math.min(index, queue.length))));
}

// ---- keys (predictions)

const newID = () => {
  const id = uuid();
  return { id, u: uuidValue(id) };
};

function placed(e: EpisodeRow, key: QueueKey | null = keyOf(e)): Placed<EpisodeRow> {
  const pid = e.records.queue_position?.value.position_id;
  return { item: e, key, position_id: key && typeof pid === "string" ? pid : "" };
}

function withKey(e: EpisodeRow, p: Placement): EpisodeRow {
  return { ...e, records: { ...e.records, queue_position: { value: { key: p.key, position_id: p.position_id }, provenance: [] } } };
}

// ---- adds

type QueuePolicy = Summary["policies"]["queue"];

/** AddPlan is an add as the browser executes it: its members with predicted keys, its place, and the queue it predicts. */
export interface AddPlan {
  members: Placement[]; // in the order asked
  place: Place;
  order: EpisodeRow[]; // the predicted queue: inserted at the place, then sorted under Keep sorted
  observed: EpisodeRow[];
}

/**
 * planAdd resolves an add of episodes (in the order asked) against the
 * queue and the account's queue policy. It skips episodes already queued
 * and episodes without media (DBWriter.addQueueItem), so an add of nothing
 * new is null: the sender emits no add.
 */
export function planAdd(
  adding: EpisodeRow[],
  queue: EpisodeRow[],
  policy: QueuePolicy,
  current: string | null = null,
  random = Math.random,
): AddPlan | null {
  const queued = new Set(queue.map((e) => e.episode_id));
  const fresh = adding.filter((e, i) => e.has_media && !queued.has(e.episode_id) && adding.findIndex((x) => x.episode_id === e.episode_id) === i);
  if (fresh.length === 0) return null;
  // ItemEnqueuePositionCalculator: one index, then the added episodes in order.
  let index: number;
  let place: Place;
  switch (policy.enqueue_location) {
    case "front":
      // Index 0, after the run of episodes being downloaded at the head: a browser downloads nothing.
      index = 0;
      place = start;
      break;
    case "after_current": {
      // After the episode loaded in this browser's player (playing or paused);
      // with none, or one not queued, the front scan from index 0.
      index = current ? queue.findIndex((e) => e.episode_id === current) + 1 : 0;
      place = placeAt(queue, index);
      break;
    }
    case "random":
      index = Math.floor(random() * (queue.length + 1));
      place = placeAt(queue, index);
      break;
    default: // back: appended
      index = queue.length;
      place = end;
  }
  let order = [...queue.slice(0, index), ...fresh, ...queue.slice(index)];
  if (policy.keep_sorted && policy.sort_order !== "random") {
    order = sortQueue(policy.sort_order as SortOrder, order.map(sortValues)).map((it) => it.row);
  }
  const added = new Set(fresh.map((e) => e.episode_id));
  const rekeyed = new Map(
    rekey(order.map((e) => placed(e, added.has(e.episode_id) ? null : keyOf(e))), newID).map((p) => [p.item.episode_id, p]),
  );
  const members = fresh.map((e) => {
    const p = rekeyed.get(e.episode_id)!;
    return { episode: ref(e), key: keyString(p.key), position_id: p.position_id };
  });
  return { members, place, order, observed: [...queue, ...fresh] };
}

/**
 * loadedHere is the current episode an after-current add follows: the one
 * loaded in this tab's player, playing or paused. Another tab's playback
 * (Playing in another tab) is not this player's, so it gives none: the front
 * scan.
 */
export function loadedHere(state: { mode: string; episode: { episode_id: string } | null } | undefined): string | null {
  return state?.mode === "here" ? (state.episode?.episode_id ?? null) : null;
}

/** addToQueue builds the queue.add fact for episodes (in the order asked) against the current queue and the account's queue policy. */
export function addToQueue(
  adding: EpisodeRow[],
  queue: EpisodeRow[],
  policy: QueuePolicy,
  current: string | null = null,
  random = Math.random,
): FactBody | null {
  const plan = planAdd(adding, queue, policy, current, random);
  return plan ? queueAdd(plan.members, plan.place, plan.observed) : null;
}

// ---- Undo of a removal

/** Saved is where a removed episode stood in the queue (RemoveFromQueueSwipeAction's saved index). */
export interface Saved {
  episode: EpisodeRow;
  index: number;
}

/** savedIndexes are the queue indexes of the episodes about to be removed, in queue order (those queued). */
export function savedIndexes(es: EpisodeRow[], queue: EpisodeRow[]): Saved[] {
  const removing = new Set(es.map((e) => e.episode_id));
  return queue.flatMap((e, index) => (removing.has(e.episode_id) ? [{ episode: e, index }] : []));
}

/**
 * restoreAt builds Undo's queue.restore facts (DBWriter.addQueueItemAt at
 * Undo time): each episode at its saved index resolved against the queue
 * now, clamped to it (PROTOCOL §7.6), in index order, so a removal of
 * several comes back as it was; consecutive ones go back as one run. An
 * episode queued again since is not restored (addQueueItemAt skips it).
 * Undo never sorts.
 */
export function restoreAt(saved: Saved[], queue: EpisodeRow[]): FactBody[] {
  let list = [...queue];
  const out: FactBody[] = [];
  let run: { place: Place; members: Placement[]; next: number } | null = null;
  const close = () => {
    if (run) out.push(queueRestore(run.members, run.place, queue));
    run = null;
  };
  for (const s of [...saved].sort((a, b) => a.index - b.index)) {
    if (list.some((e) => e.episode_id === s.episode.episode_id)) continue;
    const i = Math.max(0, Math.min(s.index, list.length));
    if (!run || run.next !== i) {
      close();
      run = { place: placeAt(list, i), members: [], next: i };
    }
    const p = placeBetween(s.episode, list[i - 1], list[i]);
    run.members.push(p);
    run.next = i + 1;
    list = [...list.slice(0, i), withKey(s.episode, p), ...list.slice(i)];
  }
  close();
  return out;
}

// ---- moves

/**
 * The place of Move to top and Move to bottom (PROTOCOL §7.6): the run lands at the
 * very start or the very end, whatever the queue holds around it, so the
 * command means the same when another device's unseen add arrives before it.
 */
const boundary = (where: "top" | "bottom"): Place => (where === "top" ? start : end);

/**
 * moveTo moves a queued episode to the top or the bottom of the queue
 * (queue.move). It is the person's command even when the episode is already
 * there, or alone: only an episode the queue does not hold moves nothing.
 */
export function moveTo(e: EpisodeRow, queue: EpisodeRow[], where: "top" | "bottom"): FactBody | null {
  if (!queue.some((x) => x.episode_id === e.episode_id)) return null;
  const others = queue.filter((x) => x.episode_id !== e.episode_id);
  const p = where === "top" ? placeBetween(e, undefined, others[0]) : placeBetween(e, others[others.length - 1], undefined);
  return queueMove(p, boundary(where), queue);
}

/**
 * moveAllTo moves episodes to the top or the bottom of the queue, in their
 * queue order (DBWriter.moveQueueItemsToTop and moveQueueItemsToBottom): a
 * run move naming the complete selected run, also when the selection is the
 * whole queue or already there; only a selection the queue does not hold
 * moves nothing.
 */
export function moveAllTo(es: EpisodeRow[], queue: EpisodeRow[], where: "top" | "bottom"): FactBody | null {
  const ids = new Set(es.map((e) => e.episode_id));
  const moved = queue.filter((e) => ids.has(e.episode_id));
  const rest = queue.filter((e) => !ids.has(e.episode_id));
  if (moved.length === 0) return null;
  return moveRun(where === "top" ? [...moved, ...rest] : [...rest, ...moved], moved, boundary(where), queue);
}

/**
 * moveRun is the run move that gives `order` (the run contiguous in it): its
 * key predictions keep the run's keys that still fit between its new
 * neighbours (the longest increasing run of them) and give the others fresh
 * keys there; unchanged keys are not predicted, and the other members' keys
 * do not change.
 */
function moveRun(order: EpisodeRow[], run: EpisodeRow[], place: Place, observed: EpisodeRow[]): FactBody {
  const ids = new Set(run.map((e) => e.episode_id));
  const first = order.findIndex((e) => ids.has(e.episode_id));
  const low = first > 0 ? keyOf(order[first - 1]!) : null;
  const high = first + run.length < order.length ? keyOf(order[first + run.length]!) : null;
  const fits = (k: QueueKey | null) => !!k && (!low || compareKeys(low, k) < 0) && (!high || compareKeys(k, high) < 0);
  const bounds = (k: QueueKey | null): Placed<EpisodeRow | null>[] => (k ? [{ item: null, key: k, position_id: "" }] : []);
  const rekeyed = rekey<EpisodeRow | null>(
    [...bounds(low), ...run.map((e) => placed(e, fits(keyOf(e)) ? keyOf(e) : null)), ...bounds(high)],
    newID,
  ).filter((p): p is Placed<EpisodeRow> & { key: QueueKey } => p.item !== null);
  const predicted = rekeyed
    .filter((p) => p.item.records.queue_position?.value.key !== keyString(p.key))
    .map((p) => ({ episode: ref(p.item), key: keyString(p.key), position_id: p.position_id }));
  return queueMoveRun(run.map(ref), place, predicted, observed);
}

// ---- the sort dialog

/**
 * sortQueueNow is the sort dialog's sort of the queue the person saw
 * (DBWriter.reorderQueue): sent even when it changes nothing here, since
 * another phone's add can make it matter; random carries the order it drew
 * (Collections.shuffle).
 */
export function sortQueueNow(account: string, queue: EpisodeRow[], order: SortOrder, random = Math.random): FactBody {
  const observed = queue.filter((e) => nameable(e));
  if (order !== "random") return queueSort(account, order, observed);
  const shuffled = [...observed];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return queueSort(account, order, observed, shuffled.map(ref));
}
