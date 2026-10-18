// Refresh (Android's refresh_item, on Home, Queue, Inbox, Episodes,
// Favorites, Subscriptions and a podcast's screen) with progress that ends
// when the server has answered this browser's requests (NotTennaPod-Server
// PROTOCOL §9.6): a refresh that finds nothing new commits nothing and sends
// no event, so the status read, not the event stream, says when it ended.
//
// Each request's answer gives each podcast's request sequence; the progress
// waits, per podcast, for the newest sequence this browser asked for. A
// podcast is done once the status read shows that sequence answered
// (done_seq), or the podcast merged into another, or gone; a refresh of every
// podcast that leaves one to its Retry-After records no request for it, and
// nothing waits for it. The sequences are kept by the server across its
// restarts, so the progress never ends early, and polling keeps going (more
// slowly) while the server cannot be reached.
import { ApiError, Unreachable, get, post } from "../api/http.ts";
import { Value } from "../util/value.ts";

/** RefreshItem is one podcast's status in the refresh API's answers. */
export interface RefreshItem {
  podcast_id: string;
  request_seq: number | null;
  done_seq: number;
  in_progress: boolean;
  running: boolean;
  merged_into: string | null;
}

/** RefreshProgress is how many of the podcasts this browser asked to refresh are done. */
export interface RefreshProgress {
  done: number;
  total: number;
}

export interface RefreshApi {
  /** request asks for a refresh of one podcast, or (undefined) of every podcast kept updated. */
  request(podcastId: string | undefined): Promise<RefreshItem[]>;
  /** status reads the named podcasts' statuses (at most maxStatusPodcasts). */
  status(podcastIds: string[]): Promise<RefreshItem[]>;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

/** The server's limit on podcasts in one status read. */
export const maxStatusPodcasts = 500;
/** Polling: every 2 s, every 5 s after the first 30 s, and backing off to 30 s while the server cannot be reached. */
export const pollFirst = 2_000;
export const pollLater = 5_000;
export const pollSlowAfter = 30_000;
export const pollUnreachableMax = 30_000;

export const httpRefreshApi: RefreshApi = {
  request: async (podcastId) => (await post<{ podcasts: RefreshItem[] }>("/v1/refresh", podcastId ? { podcast_id: podcastId } : {})).podcasts,
  status: async (ids) => (await get<{ podcasts: RefreshItem[] }>("/v1/refresh", { podcast_id: ids.join(",") })).podcasts,
};

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/** answered: the podcast's request up to seq is done, or it was merged into another (its requests are answered). */
function answered(item: RefreshItem, seq: number): boolean {
  return item.merged_into != null || item.done_seq >= seq;
}

/**
 * Refreshes are one account's refresh requests from this browser and their
 * progress. Requests add to what is shown: a refresh of one podcast while
 * all are refreshing, or of all while one is, waits for both.
 */
export class Refreshes {
  /** progress is null when nothing this browser asked for is pending. */
  readonly progress = new Value<RefreshProgress | null>(null);
  readonly #api: RefreshApi;
  readonly #timers: Timers;
  /** #targets: by podcast, the newest request sequence this browser received. */
  #targets = new Map<string, number>();
  #total = 0;
  #timer: unknown;
  #since = 0; // when the current progress started
  #unreachable = 0; // polls in a row that found the server unreachable
  #stopped = false;

  constructor(api: RefreshApi = httpRefreshApi, timers: Timers = realTimers) {
    this.#api = api;
    this.#timers = timers;
  }

  /** request asks the server for a refresh (one podcast, or all); a failure to ask is thrown to the caller. */
  async request(podcastId?: string): Promise<void> {
    const items = await this.#api.request(podcastId);
    if (this.#stopped) return;
    const starting = this.#targets.size === 0;
    for (const item of items) {
      const seq = item.request_seq;
      if (seq == null) continue; // left to its Retry-After: no request recorded, nothing to wait for
      const had = this.#targets.get(item.podcast_id);
      if (had === undefined) {
        if (answered(item, seq)) continue;
        this.#total++;
      }
      // A newer request replaces the sequence waited for; answers can arrive out of order.
      this.#targets.set(item.podcast_id, Math.max(had ?? 0, seq));
    }
    if (starting && this.#targets.size > 0) {
      this.#since = this.#timers.now();
      this.#unreachable = 0;
      this.#schedule(pollFirst);
    }
    this.#publish();
  }

  /** stop ends polling for good (the account's session ended). */
  stop(): void {
    this.#stopped = true;
    this.#clear();
  }

  #publish(): void {
    if (this.#targets.size === 0) {
      this.#total = 0;
      this.#timers.clear(this.#timer);
      this.#timer = undefined;
      this.progress.set(null);
      return;
    }
    const p = this.progress.get();
    const done = this.#total - this.#targets.size;
    if (!p || p.done !== done || p.total !== this.#total) this.progress.set({ done, total: this.#total });
  }

  #clear(): void {
    this.#targets.clear();
    this.#publish();
  }

  #schedule(ms: number): void {
    this.#timers.clear(this.#timer);
    this.#timer = this.#timers.set(() => void this.#poll(), ms);
  }

  async #poll(): Promise<void> {
    this.#timer = undefined;
    if (this.#stopped || this.#targets.size === 0) return;
    const asked = new Map(this.#targets);
    const ids = [...asked.keys()];
    try {
      for (let i = 0; i < ids.length; i += maxStatusPodcasts) {
        const chunk = ids.slice(i, i + maxStatusPodcasts);
        const items = await this.#api.status(chunk);
        if (this.#stopped) return;
        const seen = new Set<string>();
        for (const item of items) {
          seen.add(item.podcast_id);
          const seq = this.#targets.get(item.podcast_id);
          // Compared with the sequence waited for now: a reply to an older poll never ends a newer request.
          if (seq !== undefined && answered(item, seq)) this.#targets.delete(item.podcast_id);
        }
        // A podcast the account no longer has is done, unless a newer request (which found it) came meanwhile.
        for (const id of chunk) if (!seen.has(id) && this.#targets.get(id) === asked.get(id)) this.#targets.delete(id);
      }
      this.#unreachable = 0;
    } catch (e) {
      if (this.#stopped) return;
      if (e instanceof Unreachable || (e instanceof ApiError && (e.status >= 500 || e.status === 429))) {
        // Kept while the server cannot answer; it keeps the requests across a restart.
        this.#unreachable++;
        this.#schedule(Math.min(pollUnreachableMax, pollLater * 2 ** (this.#unreachable - 1)));
        return;
      }
      // Signed out, the account changed, or a refusal: nothing more can be learnt.
      this.#clear();
      return;
    }
    this.#publish();
    if (this.#targets.size > 0) this.#schedule(this.#timers.now() - this.#since >= pollSlowAfter ? pollLater : pollFirst);
  }
}

const byAccount = new WeakMap<object, Refreshes>();

/** refreshesOf is the account's refreshes (one per signed-in session, as its Sync is). */
export function refreshesOf(owner: object): Refreshes {
  let r = byAccount.get(owner);
  if (!r) {
    r = new Refreshes();
    byAccount.set(owner, r);
  }
  return r;
}
