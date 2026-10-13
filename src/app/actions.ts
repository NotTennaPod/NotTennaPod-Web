// The facts the browser writes (NotTennaPod-Server PROTOCOL §7–§9): each
// action is one fact whose payload and targets the server checks exactly.
// Episodes are named by EpisodeRef (episode, podcast, live generation and the
// occurrence evidence of their identity record).
import type { EpisodeRow, PodcastRow, Records } from "../api/views.ts";
import type { FactBody } from "../journal/journal.ts";
import { between, keyString, parseKey, uuidValue, type QueueKey } from "../queue/keys.ts";
import { uuid } from "../util/random.ts";

export interface EpisodeRef {
  episode_id: string;
  podcast_id: string;
  generation_id: string;
  occurrence: Record<string, unknown>;
}

type Target = { entity: string; id: string; generation?: string };

function sortTargets(ts: Target[]): Target[] {
  const seen = new Set<string>();
  return ts
    .filter((t) => {
      const k = `${t.entity}\u0000${t.id}\u0000${t.generation ?? ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => cmp(a.entity, b.entity) || cmp(a.id, b.id) || cmp(a.generation ?? "", b.generation ?? ""));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** provenance lists the nodes the shown records came from: what an action on them observed (PROTOCOL §12). */
export function provenance(records: Records, groups?: string[]): string[] {
  const out = new Set<string>();
  for (const [g, r] of Object.entries(records)) {
    if (!r || (groups && !groups.includes(g))) continue;
    for (const p of r.provenance) out.add(p);
  }
  return [...out].filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id));
}

export function ref(e: EpisodeRow): EpisodeRef {
  const identity = e.records.identity?.value as { podcast_id?: string; occurrence?: Record<string, unknown> } | undefined;
  const generation = (e.podcast as { generation_id?: string }).generation_id;
  if (!identity?.occurrence || !generation) throw new Error("This episode cannot be changed until its podcast is subscribed.");
  return { episode_id: e.episode_id, podcast_id: e.podcast_id, generation_id: generation, occurrence: identity.occurrence };
}

function target(r: EpisodeRef): Target {
  return { entity: "episode", id: r.episode_id, generation: r.generation_id };
}

function sortedRefs(rs: EpisodeRef[]): EpisodeRef[] {
  return [...new Map(rs.map((r) => [r.episode_id, r])).values()].sort((a, b) => cmp(a.episode_id, b.episode_id));
}

function single(type: string, e: EpisodeRow, payload: Record<string, unknown> = {}): FactBody {
  const r = ref(e);
  return { type, targets: [target(r)], payload: { episode: r, ...payload }, dependencies: provenance(e.records) };
}

// ---- episodes (PROTOCOL §7.2)

export const favorite = (e: EpisodeRow, on: boolean) => single("favorite.set", e, { on });
export const markPlayed = (e: EpisodeRow, resetPosition = true) => single("episode.mark_played", e, { reset_position: resetPosition });
export const markUnplayed = (e: EpisodeRow) => single("episode.mark_unplayed", e);
export const resetPosition = (e: EpisodeRow) => single("episode.reset_position", e);
export const restoreState = (e: EpisodeRow, playState: string, position: number) =>
  single("episode.restore_state", e, { play_state: playState, position });

/** dismiss removes episodes from the Inbox; dismissAll names exactly the observed NEW episodes. */
export function dismiss(es: EpisodeRow[], all = false): FactBody {
  const rs = sortedRefs(es.map(ref));
  return {
    type: all ? "inbox.dismiss_all" : "inbox.dismiss",
    targets: sortTargets(rs.map(target)),
    payload: { episodes: rs },
    dependencies: es.flatMap((e) => provenance(e.records)),
  };
}

// ---- history (PROTOCOL §8)

export const historyRemove = (e: EpisodeRow) => single("history.remove", e);
export const historyRestore = (e: EpisodeRow, removal: string, time: number) => single("history.restore", e, { removal, time });

/** A cut depends on the whole frontier of the view it was made on (PROTOCOL §12). */
export const historyClear = (frontier: string[]): FactBody => ({ type: "history.clear", targets: [], payload: {}, dependencies: frontier });
export const statisticsReset = (frontier: string[]): FactBody => ({ type: "statistics.reset", targets: [], payload: {}, dependencies: frontier });

// ---- queue (NotTennaPod-Server PROTOCOL §7.6)

/** Placement is a member and the key the browser predicts for it (keys are predictions of the server's replay, PROTOCOL §7.6). */
export interface Placement {
  episode: EpisodeRef;
  key: string;
  position_id: string;
}

/**
 * Place is the gap a placement put its episodes in, as the browser resolved
 * it against the queue it saw when it acted (PROTOCOL §7.6). The
 * anchor of `after` is context, never a target.
 */
export type Place = { kind: "start" } | { kind: "end" } | { kind: "after"; after: EpisodeRef };

export function keyOf(e: EpisodeRow): QueueKey | null {
  const k = e.records.queue_position?.value.key;
  return typeof k === "string" ? parseKey(k) : null;
}

export function placeBetween(e: EpisodeRow, low: EpisodeRow | undefined, high: EpisodeRow | undefined): Placement {
  const id = uuid();
  const key = between(low ? keyOf(low) : null, high ? keyOf(high) : null, uuidValue(id));
  return { episode: ref(e), key: keyString(key), position_id: id };
}

function queueFact(type: string, payload: Record<string, unknown>, episodes: EpisodeRef[], deps: string[]): FactBody {
  return { type, targets: sortTargets(episodes.map(target)), payload, dependencies: deps };
}

const observedDeps = (observed: EpisodeRow[]) => observed.flatMap((e) => provenance(e.records));

/** queueAdd adds episodes, in the order asked, at the place the enqueue location resolved to (the caller's). */
export function queueAdd(members: Placement[], place: Place, observed: EpisodeRow[]): FactBody {
  return queueFact("queue.add", { members, place }, members.map((p) => p.episode), observedDeps(observed));
}

export function queueRemove(es: EpisodeRow[]): FactBody {
  const rs = sortedRefs(es.map(ref));
  return queueFact("queue.remove", { episodes: rs, reason: "user" }, rs, es.flatMap((e) => provenance(e.records)));
}

/** queueRestore is Undo of a removal: the episodes back at the place their saved index resolves to at Undo time. */
export function queueRestore(members: Placement[], place: Place, observed: EpisodeRow[]): FactBody {
  return queueFact("queue.restore", { members, place }, members.map((p) => p.episode), observedDeps(observed));
}

/** queueMove moves one episode to a place. */
export function queueMove(p: Placement, place: Place, observed: EpisodeRow[]): FactBody {
  return queueFact("queue.move", { episode: p.episode, key: p.key, position_id: p.position_id, place }, [p.episode], observedDeps(observed));
}

/**
 * queueMoveRun moves several episodes (a multi-select move): the complete
 * selected run in its resulting order, its place, and the keys predicted for
 * the members whose key changes (none: no `members`).
 */
export function queueMoveRun(run: EpisodeRef[], place: Place, predicted: Placement[], observed: EpisodeRow[]): FactBody {
  const payload: Record<string, unknown> = { run, place };
  if (predicted.length) payload.members = predicted;
  return queueFact("queue.reorder", payload, run, observedDeps(observed));
}

/**
 * queueSort is the sort dialog's sort: the order, the queue the person saw
 * (possibly empty), and for random the resulting order of what was seen. Its
 * target is the account; it is sent even when it changes nothing here.
 */
export function queueSort(account: string, sortOrder: string, observed: EpisodeRow[], permutation?: EpisodeRef[]): FactBody {
  const sort: Record<string, unknown> = { sort_order: sortOrder };
  if (permutation) sort.permutation = permutation;
  return {
    type: "queue.reorder",
    targets: [{ entity: "account", id: account }],
    payload: { sort, observed: observed.map(ref) },
    dependencies: observedDeps(observed),
  };
}

/** queueClear removes exactly the observed members. */
export function queueClear(observed: EpisodeRow[]): FactBody {
  const rs = sortedRefs(observed.map(ref));
  return queueFact("queue.clear", { observed: rs }, rs, observed.flatMap((e) => provenance(e.records)));
}

/** setQueuePolicy depends on the policy record it was changed from (its provenance). */
export function setQueuePolicy(
  account: string,
  change: { enqueue_location?: string; sorting?: { keep_sorted: boolean; sort_order: string } },
  observed: Records = {},
): FactBody {
  return { type: "account.set_queue_policy", targets: [{ entity: "account", id: account }], payload: change, dependencies: provenance(observed, ["queue_policy"]) };
}

export function setDiscoveryPolicy(account: string, action: "inbox" | "queue" | "nothing", observed: Records = {}): FactBody {
  return {
    type: "account.set_discovery_policy",
    targets: [{ entity: "account", id: account }],
    payload: { new_episodes_action: action },
    dependencies: provenance(observed, ["discovery_policy"]),
  };
}

// ---- podcasts (5)

function podcastTarget(p: PodcastRow): Target[] {
  const generation = (p as { generation_id?: string }).generation_id;
  if (!generation) throw new Error("This podcast has no subscription.");
  return [{ entity: "podcast", id: p.podcast_id, generation }];
}

export function subscribe(feedURL: string, opts: { observed?: PodcastRow; secretId?: string } = {}): FactBody {
  const payload: Record<string, unknown> = { feed_url: feedURL };
  if (opts.observed) {
    const generation = (opts.observed as { generation_id?: string }).generation_id;
    payload.observed = { podcast_id: opts.observed.podcast_id, generation_id: generation, state: opts.observed.state };
  }
  if (opts.secretId) payload.credentials_secret = opts.secretId;
  return { type: "podcast.subscribe", targets: opts.observed ? [{ entity: "podcast", id: opts.observed.podcast_id }] : [], payload };
}

export const archive = (p: PodcastRow): FactBody => ({ type: "podcast.archive", targets: podcastTarget(p), payload: {}, dependencies: provenance(p.records) });
export const restore = (p: PodcastRow): FactBody => ({ type: "podcast.restore", targets: podcastTarget(p), payload: {}, dependencies: provenance(p.records) });
export const unsubscribe = (p: PodcastRow): FactBody => ({ type: "podcast.unsubscribe", targets: podcastTarget(p), payload: {}, dependencies: provenance(p.records) });

export function setPolicy(p: PodcastRow, change: { new_episodes_action?: string; keep_updated?: boolean }): FactBody {
  return { type: "podcast.set_policy", targets: podcastTarget(p), payload: change, dependencies: provenance(p.records, ["policy"]) };
}

export function setCredentials(p: PodcastRow, secretId: string | null): FactBody {
  return {
    type: "podcast.set_credentials",
    targets: podcastTarget(p),
    payload: secretId ? { secret_id: secretId } : { clear: true },
    dependencies: provenance(p.records, ["credentials"]),
  };
}
