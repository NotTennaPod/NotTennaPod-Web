// The canonical keep-sorted order (PROTOCOL §7.6; NotTennaPod-Server
// internal/queue): Android 3.12.1's queue comparators on canonical values,
// stable over the current order, and re-keying that keeps the longest
// increasing run of existing keys.
import { between, compareKeys, type QueueKey } from "./keys.ts";

export interface Item {
  episode_id: string;
  podcast_id: string;
  title: string;
  podcast_title: string;
  publication_time: number; // ms; 0 when unknown
  duration: number; // ms; 0 when unknown
}

export const sortOrders = [
  "episode_title_a_z",
  "episode_title_z_a",
  "feed_title_a_z",
  "feed_title_z_a",
  "duration_short_long",
  "duration_long_short",
  "date_old_new",
  "date_new_old",
  "random",
  "smart_shuffle_old_new",
  "smart_shuffle_new_old",
] as const;
export type SortOrder = (typeof sortOrders)[number];

/** fold is the title collation key: Unicode simple lowercase per code point. */
export function fold(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const lower = ch.toLowerCase();
    out.push(lower.codePointAt(0)!);
  }
  return out;
}

function compareCodePoints(a: number[], b: number[]): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length - b.length;
}

function cmp(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** sortQueue returns items (in current queue order) in the canonical order; random is never canonical. */
export function sortQueue<T extends Item>(order: SortOrder, items: T[]): T[] {
  const out = [...items];
  let less: (a: T, b: T) => number;
  switch (order) {
    case "episode_title_a_z":
      less = (a, b) => compareCodePoints(fold(a.title), fold(b.title));
      break;
    case "episode_title_z_a":
      less = (a, b) => compareCodePoints(fold(b.title), fold(a.title));
      break;
    case "feed_title_a_z":
      less = (a, b) => compareCodePoints(fold(a.podcast_title), fold(b.podcast_title));
      break;
    case "feed_title_z_a":
      less = (a, b) => compareCodePoints(fold(b.podcast_title), fold(a.podcast_title));
      break;
    case "duration_short_long":
      less = (a, b) => cmp(a.duration, b.duration);
      break;
    case "duration_long_short":
      less = (a, b) => cmp(b.duration, a.duration);
      break;
    case "date_old_new":
      less = (a, b) => cmp(a.publication_time, b.publication_time);
      break;
    case "date_new_old":
      less = (a, b) => cmp(b.publication_time, a.publication_time);
      break;
    case "smart_shuffle_old_new":
      return smartShuffle(out, true);
    case "smart_shuffle_new_old":
      return smartShuffle(out, false);
    case "random":
      throw new Error("queue: random is not a keep-sorted order");
  }
  return out.map((x, i) => ({ x, i })).sort((p, q) => less(p.x, q.x) || p.i - q.i).map((p) => p.x);
}

function smartShuffle<T extends Item>(items: T[], ascending: boolean): T[] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const g = groups.get(it.podcast_id);
    if (g) g.push(it);
    else groups.set(it.podcast_id, [it]);
  }
  for (const [p, g] of groups) {
    groups.set(
      p,
      g
        .map((x, i) => ({ x, i }))
        .sort((a, b) => (ascending ? cmp(a.x.publication_time, b.x.publication_time) : cmp(b.x.publication_time, a.x.publication_time)) || a.i - b.i)
        .map((e) => e.x),
    );
  }
  const podcasts = [...groups.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  podcasts.sort((a, b) => groups.get(b)!.length - groups.get(a)!.length);
  const out: T[] = new Array(items.length);
  let empty = items.map((_, i) => i);
  for (const p of podcasts) {
    const g = groups.get(p)!;
    const spread = empty.length / (g.length + 1);
    let skipped = 0;
    let placed = 0;
    const remaining: number[] = [];
    for (let k = 0; k < empty.length; k++) {
      const slot = empty[k]!;
      if (placed === g.length) {
        remaining.push(...empty.slice(k));
        break;
      }
      skipped++;
      if (skipped >= spread * (placed + 1)) {
        out[slot] = g[placed]!;
        placed++;
        continue;
      }
      remaining.push(slot);
    }
    empty = remaining;
  }
  return out;
}

export interface Placed<T> {
  item: T;
  key: QueueKey | null; // null: a member without a key yet (a new add), which always gets one
  position_id: string;
}

/**
 * rekey gives the members, in their sorted order, increasing keys: members
 * along the lexicographically first longest increasing run of their current
 * keys keep their keys and position IDs; the others get fresh keys between
 * their sorted neighbours.
 */
export function rekey<T>(sorted: Placed<T>[], newID: () => { id: string; u: bigint }): (Placed<T> & { key: QueueKey })[] {
  const keep = lis(sorted);
  const out = sorted.map((p) => ({ ...p }));
  for (let i = 0; i < out.length; ) {
    if (keep[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && !keep[j]) j++;
    const high = j < out.length ? out[j]!.key! : null;
    for (let k = i; k < j; k++) {
      const low = k > 0 ? out[k - 1]!.key : null;
      const { id, u } = newID();
      out[k]!.key = between(low, high, u);
      out[k]!.position_id = id;
    }
    i = j;
  }
  return out as (Placed<T> & { key: QueueKey })[];
}

function lis<T>(ps: Placed<T>[]): boolean[] {
  const n = ps.length;
  const keep = new Array<boolean>(n).fill(false);
  if (n === 0) return keep;
  const from = new Array<number>(n).fill(1);
  let longest = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (!ps[i]!.key) {
      from[i] = 0;
      continue;
    }
    for (let j = i + 1; j < n; j++) {
      if (ps[j]!.key && compareKeys(ps[i]!.key!, ps[j]!.key!) < 0 && from[j]! + 1 > from[i]!) from[i] = from[j]! + 1;
    }
    longest = Math.max(longest, from[i]!);
  }
  let need = longest;
  let last = -1;
  for (let i = 0; i < n && need > 0; i++) {
    if (from[i] === need && (last < 0 || compareKeys(ps[last]!.key!, ps[i]!.key!) < 0)) {
      keep[i] = true;
      last = i;
      need--;
    }
  }
  return keep;
}
