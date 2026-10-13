// The browser's player (PROTOCOL §12, §8; Android's
// Media3PlaybackService). An intentional play starts a session; saves every
// 5 s and at start, resume, pause, stop and end are journaled before they
// count; checkpoints are exported at most once a minute while playing and at
// pause, stop, switch and before cuts. One tab per profile plays, by a fenced
// lease in IndexedDB; listening is never refused because of the lease. A page
// load exports what an earlier one left and restores the current episode
// paused, without a fact.
import type { EpisodeRow, Head, PodcastRow, Summary } from "../api/views.ts";
import { provenance, type Place, type Placement } from "../app/actions.ts";
import { addToQueue } from "../app/queueOps.ts";
import { uuid } from "../journal/journal.ts";
import { compareKeys, parseKey } from "../queue/keys.ts";
import { almostEnded, exportIntervalMs, fastForwardMs, rewindAfterPause, rewindMs, saveIntervalMs } from "./accounting.ts";
import {
  addSave,
  entryOf,
  exportIn,
  exportPending,
  finalizeIn,
  getLease,
  getLeaseIn,
  getSession,
  getSessionIn,
  inPlayer,
  listeningFrontier,
  putLeaseIn,
  putSessionIn,
  sessionsOf,
  startIn,
  updateLease,
  type CurrentRow,
  type EndSpec,
  type LeaseRow,
  type SessionRow,
} from "./store.ts";

/** Media is the audio element, as the engine needs it (positions in ms). */
export interface Media {
  load(url: string, position: number): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(position: number): void;
  unload(): void;
  readonly position: number;
  readonly duration: number; // 0 when unknown
  readonly paused: boolean;
  readonly ended: boolean;
  rate: number;
  /** lastError is the words for the last source that could not play (the relay's, PROTOCOL §12), if any. */
  readonly lastError?: string | null;
  listen(l: { paused(): void; ended(): void; time(): void; error(): void }): void;
}

export interface EpisodeView {
  head: Head;
  episode: EpisodeRow;
  podcast: PodcastRow;
}

/** Reads are the read API calls the player makes. */
export interface Reads {
  episode(id: string): Promise<EpisodeView>;
  queue(): Promise<EpisodeRow[]>;
  summary(): Promise<Summary>;
}

export type Message =
  | { type: "handoff"; fence: number; to: string }
  | { type: "released"; fence: number }
  | { type: "state"; page: string; fence: number; current: CurrentRow | null };

/** Channel reaches the profile's other tabs (a BroadcastChannel). */
export interface Channel {
  post(m: Message): void;
  listen(fn: (m: Message) => void): () => void;
}

export interface PlayerDeps {
  db: IDBDatabase;
  account: string;
  page: string; // this page load's author
  tab: string; // the browser tab (kept across reloads)
  media: Media;
  reads: Reads;
  channel: Channel;
  now?: () => number;
  timers?: boolean; // false in tests, which call tick() and leaseTick()
  handoffMs?: number;
  appended?: (n: number) => void; // facts were journaled: push them
  notify?: (text: string) => void;
  needsRelay?: string; // the wording for media the browser cannot play directly
  unreachable?: string;
  lastInQueue?: string;
  storageFailed?: string; // the wording when the journal cannot be written
  /** relay: the server chooses every episode's source (PROTOCOL §13); without it, only HTTPS enclosures play. */
  relay?: boolean;
  /** tabInUse tells whether another live document already uses this tab ID (a duplicated tab). */
  tabInUse?: (tab: string) => Promise<boolean>;
  newTab?: () => string;
  readTimeoutMs?: number;
}

/** A chapter from the feed (Podlove simple chapters), start in ms. */
export interface Chapter {
  start: number;
  title: string;
  link: string | null;
  image: string | null;
}

export interface EpisodeInfo {
  episode_id: string;
  podcast_id: string;
  title: string;
  podcast: string;
  image: string;
  description: string | null;
  chapters?: Chapter[]; // absent in rows saved before chapters were shown
}

/** chaptersOf reads the episode's chapters in start order (ChapterUtils sorts them). */
export function chaptersOf(metadata: unknown): Chapter[] {
  const list = (metadata as { chapters?: unknown } | undefined)?.chapters;
  if (!Array.isArray(list)) return [];
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  return list
    .map((c: Record<string, unknown>) => ({ start: Number(c.start), title: str(c.title) ?? "", link: str(c.link), image: str(c.image_url) }))
    .filter((c) => Number.isFinite(c.start) && c.start >= 0)
    .sort((a, b) => a.start - b.start);
}

export interface PlayerState {
  mode: "none" | "here" | "elsewhere";
  episode: EpisodeInfo | null;
  playing: boolean;
  position: number;
  duration: number;
  rate: number;
  error: string | null;
  busy: boolean;
}

/** The current episode as this page holds it. */
interface Current {
  info: EpisodeInfo;
  view: EpisodeView | null;
  url: string | null; // null: needs the relay
  loaded: boolean;
  position: number;
  duration: number;
  claim: string | null; // the claim the paused position stands under
  claimDeps: string[]; // the provenance of an adopted position
  sessionId: string | null; // its latest session in this profile
  lastPlayed: number;
  baseline: string; // begun when this page loaded the episode
  /** A newer claim seen while playing: sync never moves playing audio, but an intentional seek takes over from it (PROTOCOL §8). */
  superseding?: { claim: string; deps: string[] } | null;
  /** The queue add its session.start carries (playing an unqueued episode, PROTOCOL §7.6): the start's op and the key it takes. */
  queued?: { op: string; key: string } | null;
}

interface Bundle {
  bundle: { key: string; position_id: string; place: Place };
  deps: string[];
}

export const leaseRenewMs = 2_000;
export const leaseLapseMs = 10_000;

/** mediaURL is the episode's enclosure if the browser may play it directly (PROTOCOL §12). */
export function mediaURL(v: EpisodeView): string | null {
  const meta = v.episode.metadata as { media?: { url?: unknown } } | undefined;
  const occurrence = v.episode.records.identity?.value.occurrence as { enclosure_url?: unknown } | undefined;
  const url = typeof meta?.media?.url === "string" ? meta.media.url : typeof occurrence?.enclosure_url === "string" ? occurrence.enclosure_url : null;
  const credentials = v.podcast.credentials;
  const priv = credentials === true || (typeof credentials === "object" && credentials !== null && credentials.set);
  if (!url || priv || !/^https:\/\//i.test(url)) return null;
  return url;
}

function infoOf(v: EpisodeView): EpisodeInfo {
  const e = v.episode;
  const description = (e.metadata as { description?: string | null } | undefined)?.description ?? null;
  return {
    episode_id: e.episode_id,
    podcast_id: e.podcast_id,
    title: e.title ?? "",
    podcast: e.podcast.display_title,
    image: e.image_url || e.podcast.image_url,
    description,
    chapters: chaptersOf(e.metadata),
  };
}

function claimOf(e: EpisodeRow): string | null {
  const c = e.records.position?.value.claim_id;
  return typeof c === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(c) ? c : null;
}

export class Player {
  readonly #d: Required<Omit<PlayerDeps, "appended" | "notify" | "needsRelay" | "unreachable" | "lastInQueue" | "storageFailed" | "tabInUse" | "newTab" | "relay">> &
    PlayerDeps;
  #listeners = new Set<() => void>();
  #state: PlayerState = { mode: "none", episode: null, playing: false, position: 0, duration: 0, rate: 1, error: null, busy: false };
  #current: Current | null = null;
  #live: SessionRow | null = null; // the session this page plays
  #playing = false;
  #fence: number | null = null;
  #lastSaveAt = 0;
  #saving = false;
  #queue: EpisodeRow[] | null = null; // the last queue read, for the next episode offline
  #chain: Promise<unknown> = Promise.resolve();
  #timers: ReturnType<typeof setInterval>[] = [];
  #unlisten: () => void = () => {};
  #lastBroadcast = 0;
  #disposed = false;
  #side = new Set<Promise<unknown>>(); // saves and lease renewals running beside the chain
  #lapsed = -1; // the fence of an owner whose lease lapsed here: its late messages are stale
  #wantsPlay = false; // a play was asked for and no Pause since: a pending start may begin the audio

  constructor(deps: PlayerDeps) {
    this.#d = { now: Date.now, timers: true, handoffMs: 3000, readTimeoutMs: 15_000, ...deps };
    this.#state.rate = deps.media.rate;
    // An end or an error belongs to the episode current when it happened: a
    // transition queued before it (a switch) may have replaced that episode.
    const ofCurrent = (fn: () => Promise<void>) => {
      const cur = this.#current;
      void this.#run(async () => {
        if (this.#current === cur) await fn();
      });
    };
    deps.media.listen({
      paused: () => this.#pausedByMedia(),
      ended: () => ofCurrent(() => this.#finish(true)),
      time: () => this.#time(),
      error: () => ofCurrent(() => this.#mediaError()),
    });
    this.#unlisten = deps.channel.listen((m) => this.#message(m));
  }

  // ---- observing

  get state(): PlayerState {
    return this.#state;
  }

  subscribe(l: () => void): () => void {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }

  #set(change: Partial<PlayerState>): void {
    this.#state = { ...this.#state, ...change };
    for (const l of [...this.#listeners]) l();
  }

  #show(): void {
    const c = this.#current;
    this.#set({
      mode: c ? "here" : "none",
      episode: c?.info ?? null,
      playing: this.#playing,
      position: c ? (c.loaded ? this.#d.media.position : c.position) : 0,
      duration: c ? this.#d.media.duration || c.duration : 0,
    });
  }

  // ---- serialization: user actions and media events never interleave

  #run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const next = this.#chain.then(fn).catch((e: unknown) => {
      console.error("player", e);
      return undefined;
    });
    this.#chain = next;
    return next;
  }

  get #now(): number {
    return this.#d.now();
  }

  /** #read bounds a read API call, so a stalled request never holds the player's transitions forever. */
  #read<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("player: read timed out")), this.#d.readTimeoutMs);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  /**
   * #halt stops the audio at once, outside the serialized transitions, and
   * returns what its final save needs: Pause and a lost lease never wait
   * behind a transition that waits on the network.
   */
  #halt(): { saved: Promise<void> } | null {
    this.#wantsPlay = false;
    if (!this.#playing) {
      this.#d.media.pause(); // a start still pending is cancelled
      return null;
    }
    this.#playing = false;
    const position = this.#d.media.position;
    this.#d.media.pause();
    this.#show();
    const live = this.#live;
    const cur = this.#current;
    if (!live || !cur) return null;
    // The final save is its own transaction, made now: whatever transition is
    // pending (a switch, an adoption) runs after it and sees it.
    const saved = this.#beside(this.#saveTo(live, cur, position, "pause").catch((e: unknown) => this.#storageFailed(e)));
    return { saved };
  }

  /** #storageFailed stops playback the journal cannot record, and says so. */
  #storageFailed(e: unknown): void {
    console.error("player: the journal could not be written", e);
    this.#halt();
    this.#fail(this.#d.storageFailed ?? "storage failed");
  }

  /** #ownsCurrent tells whether this page may write the profile's current episode (the lease's owner, or nobody else's). */
  #ownsCurrent(lease: LeaseRow): boolean {
    return this.#fence !== null ? lease.fence === this.#fence : !this.#liveOther(lease, this.#now);
  }

  #appended(n: number): void {
    if (n > 0) this.#d.appended?.(n);
  }

  // ---- boot: restart export, passive paused loading

  /** boot exports what earlier page loads left (passively) and restores the current episode paused, with no fact. */
  boot(): Promise<void> {
    return this.#run(async () => {
      // A duplicated tab copies its tab ID: it takes its own before anything else.
      if (this.#d.tabInUse && this.#d.newTab && (await this.#d.tabInUse(this.#d.tab))) this.#d.tab = this.#d.newTab();
      const now = this.#now;
      const lease = await getLease(this.#d.db, this.#d.account);
      const other = this.#liveOther(lease, now);
      const made = await exportPending(this.#d.db, this.#d.account, this.#d.page, now, (s) => !(other && s.session_id === lease.current?.session_id));
      this.#appended(made.length);
      await this.#prune(lease);
      if (this.#d.timers) {
        this.#timers.push(setInterval(() => this.tick(), 1000));
        this.#timers.push(setInterval(() => void this.leaseTick(), leaseRenewMs));
      }
      if (other) this.#elsewhere(lease);
      else if (lease.current) await this.#restore(lease.current);
    }) as Promise<void>;
  }

  /** idle resolves once every queued action and event has been handled. */
  async idle(): Promise<void> {
    let seen: Promise<unknown> | undefined;
    while (seen !== this.#chain || this.#side.size > 0) {
      seen = this.#chain;
      await Promise.all([seen, ...this.#side]);
    }
  }

  /** #beside tracks work that runs outside the chain, so idle() waits for it too. */
  #beside<T>(p: Promise<T>): Promise<T> {
    this.#side.add(p);
    const done = () => void this.#side.delete(p);
    p.then(done, done);
    return p;
  }

  dispose(): void {
    this.#disposed = true;
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    this.#unlisten();
  }

  /**
   * #prune drops finished sessions whose facts every view has shown (PROTOCOL §8:
   * the journal may be pruned). A session that holds a seek made while
   * paused, which no save has carried yet, is the only record of where its
   * episode resumes: it stays while it is the episode's latest session here
   * (a later one carried or replaced it; #localPosition clears one another
   * device's claim superseded).
   */
  async #prune(lease: LeaseRow): Promise<void> {
    const all = await sessionsOf(this.#d.db, this.#d.account);
    for (const s of all) {
      if (s.session_id === lease.current?.session_id || !(s.sealed || s.closed) || s.last.index > s.exported_index) continue;
      if (s.resume !== undefined && !s.completed && !all.some((o) => o.episode.episode_id === s.episode.episode_id && o.created_at > s.created_at)) continue;
      if (await entryOf(this.#d.db, this.#d.account, s.last_op)) continue;
      await inPlayer(this.#d.db, async (t) => void t.objectStore("sessions").delete([s.account_id, s.session_id]));
    }
  }

  #liveOther(lease: LeaseRow, now: number): boolean {
    return lease.page !== null && lease.page !== this.#d.page && lease.tab !== this.#d.tab && lease.expires > now;
  }

  /** #away drops a passively loaded player: another tab plays. */
  #away(lease: LeaseRow): void {
    if (this.#current && this.#fence === null && !this.#playing) {
      this.#current = null;
      this.#live = null;
      this.#d.media.unload();
    }
    this.#elsewhere(lease);
  }

  #elsewhere(lease: LeaseRow): void {
    const c = lease.current;
    this.#set({
      mode: c ? "elsewhere" : "none",
      episode: c ? { episode_id: c.episode_id, podcast_id: "", title: c.title, podcast: c.podcast, image: c.image, description: null } : null,
      playing: c?.playing ?? false,
      position: c?.position ?? 0,
      duration: c?.duration ?? 0,
      error: null,
    });
  }

  /** #restore loads the profile's current episode paused: a new local baseline, no fact (PROTOCOL §8). */
  async #restore(c: CurrentRow): Promise<void> {
    let view: EpisodeView | null = null;
    try {
      view = await this.#read(this.#d.reads.episode(c.episode_id));
    } catch {
      /* offline: the bar shows what the profile kept */
    }
    const cur: Current = {
      info: view ? infoOf(view) : { episode_id: c.episode_id, podcast_id: "", title: c.title, podcast: c.podcast, image: c.image, description: null },
      view,
      url: view ? this.#urlOf(view) : null,
      loaded: false,
      position: c.position,
      duration: c.duration || view?.episode.duration_ms || 0,
      claim: c.claim,
      claimDeps: [],
      sessionId: c.session_id,
      lastPlayed: view?.episode.last_played ?? 0,
      baseline: uuid(),
    };
    this.#current = cur;
    await this.#lastPlayedFrom(cur);
    if (view) await this.#adoptIfNewer(cur, view);
    this.#live = null;
    this.#playing = false;
    this.#show();
    if (cur.url) await this.#load(cur).catch(() => {});
  }

  /** #lastPlayedFrom takes the episode's last save in this profile, for rewind after pause. */
  async #lastPlayedFrom(cur: Current): Promise<void> {
    const row = cur.sessionId ? await getSession(this.#d.db, this.#d.account, cur.sessionId) : undefined;
    if (row) cur.lastPlayed = Math.max(cur.lastPlayed, row.last.time);
  }

  async #load(cur: Current): Promise<void> {
    if (!cur.url) throw new Error("needs relay");
    await this.#d.media.load(cur.url, cur.position);
    cur.loaded = true;
    if (this.#d.media.duration > 0) cur.duration = this.#d.media.duration;
    this.#show();
  }

  // ---- adoption (PROTOCOL §8: applying remote position)

  /** #ours tells whether a position claim is one of this profile's own for the episode. */
  async #inPast(opId: string, head: Head): Promise<boolean> {
    const e = await entryOf(this.#d.db, this.#d.account, opId);
    if (!e) return true; // retired: a shown view held it
    if (!e.receipt || !e.receipt_lineage) return false;
    return e.receipt_lineage.log_id === head.log_id && e.receipt_lineage.epoch === head.epoch && e.receipt.seq <= head.seq;
  }

  /**
   * #adoptIfNewer moves a paused player to a newer position another device
   * claimed: the local session is sealed at its pre-adoption save (reason
   * superseded, no activity) and resuming starts a new session.
   */
  /** #superseding is the view's claim when it is newer than this profile's: another device took the position. */
  async #superseding(cur: Current, view: EpisodeView): Promise<{ claim: string; row: SessionRow | undefined } | null> {
    const claim = claimOf(view.episode);
    if (!claim || claim === cur.claim) return null;
    const row = cur.sessionId ? await getSession(this.#d.db, this.#d.account, cur.sessionId) : undefined;
    if (row?.claims.includes(claim)) return null;
    if (row && !(await this.#inPast(row.start_op, view.head))) return null; // the server has not seen our claim yet
    return { claim, row };
  }

  async #adoptIfNewer(cur: Current, view: EpisodeView): Promise<boolean> {
    const found = await this.#superseding(cur, view);
    if (!found) return false;
    const { claim, row } = found;
    const deps = provenance(view.episode.records, ["position"]);
    if (row && !row.sealed && !row.closed) {
      const op = await inPlayer(this.#d.db, async (t) => {
        const r = await getSessionIn(t, this.#d.account, row.session_id);
        if (!r || r.sealed) return null;
        const end: EndSpec = { reason: "superseded", completed: false, removeFromQueue: false, history: false, dependencies: deps };
        const entry = await exportIn(t, r, this.#d.page, this.#now, end);
        r.closed = true;
        await putSessionIn(t, r);
        return entry;
      });
      if (op) this.#appended(1);
    }
    cur.position = view.episode.position;
    cur.claim = claim;
    cur.claimDeps = deps;
    cur.superseding = null;
    cur.lastPlayed = view.episode.last_played;
    if (cur.loaded) this.#d.media.seek(cur.position);
    if (this.#live?.session_id === row?.session_id) this.#live = null;
    await this.#saveCurrent();
    return true;
  }

  /** refresh re-reads the current episode when views change: a paused player adopts newer positions. */
  refresh(): Promise<void> {
    return this.#run(async () => {
      const cur = this.#current;
      if (!cur || this.#state.mode !== "here") return;
      let view: EpisodeView;
      try {
        view = await this.#read(this.#d.reads.episode(cur.info.episode_id));
      } catch {
        return;
      }
      if (this.#current !== cur) return;
      cur.view = view;
      cur.url = this.#urlOf(view);
      if (this.#playing) {
        // Sync never moves playing audio; the claim is remembered for an intentional seek.
        const found = await this.#superseding(cur, view);
        cur.superseding = found ? { claim: found.claim, deps: provenance(view.episode.records, ["position"]) } : null;
        return;
      }
      if (await this.#adoptIfNewer(cur, view)) this.#show();
    }) as Promise<void>;
  }

  // ---- the lease (PROTOCOL §12)

  /** #own makes this page the player, asking a live owner to hand over first. */
  async #own(): Promise<boolean> {
    const now = this.#now;
    if (this.#fence !== null) {
      const still = await updateLease(this.#d.db, this.#d.account, (row) => {
        if (row.fence !== this.#fence) return false;
        row.expires = now + leaseLapseMs;
        return true;
      });
      if (still) return true;
      await this.#lost();
    }
    const lease = await getLease(this.#d.db, this.#d.account);
    let answered = true;
    if (this.#liveOther(lease, now)) answered = await this.#handoff(lease.fence);
    const won = await updateLease(this.#d.db, this.#d.account, (row) => {
      row.fence++;
      row.page = this.#d.page;
      row.tab = this.#d.tab;
      row.expires = this.#now + leaseLapseMs;
      return { ...row };
    });
    this.#fence = won.fence;
    // A dead or silent owner's saves are exported now (PROTOCOL §12).
    if (!answered) this.#appended((await exportPending(this.#d.db, this.#d.account, this.#d.page, this.#now)).length);
    const c = won.current;
    if (c && (c.episode_id !== this.#current?.info.episode_id || c.session_id !== this.#current.sessionId)) {
      // The profile played on in another tab: its current episode is ours now.
      this.#live = null;
      this.#current = {
        info: { episode_id: c.episode_id, podcast_id: "", title: c.title, podcast: c.podcast, image: c.image, description: null },
        view: null,
        url: null,
        loaded: false,
        position: c.position,
        duration: c.duration,
        claim: c.claim,
        claimDeps: [],
        sessionId: c.session_id,
        lastPlayed: 0,
        baseline: uuid(),
      };
      await this.#lastPlayedFrom(this.#current);
    } else if (!c) {
      this.#current = null;
    }
    this.#show();
    return true;
  }

  /** #handoff asks the owner to pause with a final save and waits for it, up to 3 s. */
  #handoff(fence: number): Promise<boolean> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const off = this.#d.channel.listen((m) => {
        if (m.type === "released" && m.fence === fence) done(true);
      });
      const done = (ok: boolean) => {
        off();
        if (timer) clearTimeout(timer);
        resolve(ok);
      };
      timer = setTimeout(() => done(false), this.#d.handoffMs);
      this.#d.channel.post({ type: "handoff", fence, to: this.#d.page });
    });
  }

  #message(m: Message): void {
    if (this.#disposed) return;
    if (m.type === "handoff" && m.fence === this.#fence && m.to !== this.#d.page) {
      const h = this.#halt();
      void this.#run(async () => {
        if (h) await h.saved;
        if (this.#fence !== m.fence) return;
        await this.#release();
        this.#d.channel.post({ type: "released", fence: m.fence });
      });
    } else if (m.type === "state" && m.page !== this.#d.page && m.fence > this.#lapsed && this.#fence === null && !this.#playing) {
      this.#away({ account_id: this.#d.account, page: m.page, tab: null, fence: m.fence, expires: 0, current: m.current });
    }
  }

  /** #release gives the player to another tab: a final save, and this page stops tracking its session. */
  async #release(): Promise<void> {
    await this.#pauseAndSave();
    await this.#close();
    this.#fence = null;
    this.#elsewhere(await getLease(this.#d.db, this.#d.account));
  }

  /** #lost: another tab took the lease; pause with a final save (PROTOCOL §12). */
  async #lost(): Promise<void> {
    await this.#pauseAndSave();
    await this.#close();
    this.#fence = null;
    const lease = await getLease(this.#d.db, this.#d.account);
    this.#elsewhere(lease);
  }

  async #close(): Promise<void> {
    const live = this.#live;
    this.#live = null;
    if (!live) return;
    await inPlayer(this.#d.db, async (t) => {
      const r = await getSessionIn(t, this.#d.account, live.session_id);
      if (!r) return;
      r.closed = true;
      await putSessionIn(t, r);
    });
  }

  /** leaseTick renews the owner's lease every 2 s; other tabs follow the owner, or take the player back when it lapses. */
  leaseTick(): Promise<void> {
    const fence = this.#fence;
    if (fence !== null) {
      // Renewal never waits behind a transition: a lost lease pauses at once (PROTOCOL §12).
      const now = this.#now;
      return this.#beside(updateLease(this.#d.db, this.#d.account, (row) => {
        if (row.fence !== fence) return false;
        row.expires = now + leaseLapseMs;
        return true;
      })).then((mine) => {
        if (mine || this.#fence !== fence) return;
        const h = this.#halt();
        return this.#run(async () => {
          if (h) await h.saved;
          if (this.#fence === fence) await this.#lost();
        }) as Promise<void>;
      });
    }
    return this.#run(async () => {
      const now = this.#now;
      if (this.#fence !== null) return;
      const lease = await getLease(this.#d.db, this.#d.account);
      if (this.#liveOther(lease, now)) {
        this.#away(lease);
        return;
      }
      if (this.#state.mode !== "elsewhere") return;
      // The owner closed or froze: its lease lapsed, and its saves are exported here (PROTOCOL §12).
      this.#lapsed = Math.max(this.#lapsed, lease.fence);
      this.#appended((await exportPending(this.#d.db, this.#d.account, this.#d.page, now)).length);
      if (lease.current) await this.#restore(lease.current);
      else this.#set({ mode: "none", episode: null, playing: false });
    }) as Promise<void>;
  }

  // ---- saving

  #time(): void {
    const c = this.#current;
    if (c?.loaded && this.#state.mode === "here") {
      this.#set({ position: this.#d.media.position, duration: this.#d.media.duration || c.duration });
      const now = this.#now;
      if (this.#fence !== null && now - this.#lastBroadcast >= 1000) {
        this.#lastBroadcast = now;
        this.#d.channel.post({ type: "state", page: this.#d.page, fence: this.#fence, current: this.#currentRow(this.#d.media.position) });
      }
    }
    this.tick();
  }

  /** tick saves every 5 s while playing, exporting at most once a minute. */
  tick(): void {
    const live = this.#live;
    const cur = this.#current;
    if (!this.#playing || !live || !cur || this.#saving || this.#now - this.#lastSaveAt < saveIntervalMs) return;
    // Saves are their own transactions and never wait behind a transition (a sealed session takes none).
    this.#saving = true;
    void this.#beside(
      this.#saveTo(live, cur, this.#d.media.position, "interval")
        .catch((e: unknown) => this.#storageFailed(e))
        .finally(() => (this.#saving = false)),
    );
  }

  #currentRow(position: number, c: Current | null = this.#current): CurrentRow | null {
    if (!c) return null;
    return {
      episode_id: c.info.episode_id,
      session_id: c.sessionId,
      claim: c.claim,
      position: Math.round(position),
      duration: Math.round(this.#d.media.duration || c.duration),
      playing: this.#playing,
      title: c.info.title,
      podcast: c.info.podcast,
      image: c.info.image,
    };
  }

  /** #saveCurrent records the profile's current episode in the lease row. */
  async #saveCurrent(): Promise<void> {
    const row = this.#currentRow(this.#current?.loaded ? this.#d.media.position : (this.#current?.position ?? 0));
    await updateLease(this.#d.db, this.#d.account, (l) => {
      if (this.#ownsCurrent(l)) l.current = row;
    });
  }

  /**
   * #save journals a save of the live session; an interval save exports when
   * a minute has passed since the last export, a pause or stop always does.
   */
  async #save(position: number, why: "interval" | "pause" | "flush"): Promise<void> {
    const live = this.#live;
    const cur = this.#current;
    if (!live || !cur) return;
    await this.#saveTo(live, cur, position, why);
  }

  /** #saveTo journals a save of a given session: the one playing when Pause was pressed, even if a transition followed. */
  async #saveTo(live: SessionRow, cur: Current, position: number, why: "interval" | "pause" | "flush"): Promise<void> {
    const now = this.#now;
    const duration = this.#d.media.duration;
    const out = await inPlayer(this.#d.db, async (t) => {
      const r = await getSessionIn(t, this.#d.account, live.session_id);
      if (!r || r.sealed) return null;
      if (duration > 0) r.duration = duration;
      addSave(r, position, now, this.#d.page);
      const due = why !== "interval" || now - r.exported_at >= exportIntervalMs;
      const entry = due ? await exportIn(t, r, this.#d.page, now) : null;
      await putSessionIn(t, r);
      const lease = await getLeaseIn(t, this.#d.account);
      cur.position = r.last.position;
      // Only the lease's owner moves the profile's current episode, and only
      // while this episode is still the current one; a losing tab's or a
      // superseded transition's save still counts (PROTOCOL §12).
      if (this.#ownsCurrent(lease) && cur === this.#current) {
        lease.current = this.#currentRow(r.last.position, cur);
        await putLeaseIn(t, lease);
      }
      return { r, entry };
    });
    this.#lastSaveAt = now;
    if (!out) return;
    if (this.#live?.session_id === live.session_id) this.#live = out.r;
    cur.lastPlayed = now;
    if (out.entry) this.#appended(1);
  }

  /** #pauseAndSave pauses a playing session with its final save and export. */
  async #pauseAndSave(): Promise<void> {
    const h = this.#halt();
    if (h) await h.saved;
  }

  /** #pausedByMedia is a pause the browser made (headphones, another app): handled at once, saved in order. */
  #pausedByMedia(): void {
    // A late event of a pause already handled (or of the previous episode) is ignored.
    if (!this.#playing || !this.#d.media.paused || this.#d.media.ended) return;
    const h = this.#halt();
    void this.#run(async () => {
      if (h) await h.saved;
    });
  }

  async #mediaError(): Promise<void> {
    const wasPlaying = this.#playing;
    if (wasPlaying) {
      this.#playing = false;
      await this.#save(this.#d.media.position, "pause");
    }
    if (this.#current) this.#current.loaded = false;
    this.#fail();
  }

  /** #urlOf is the episode's source for the element: the server's choice with the relay, else its HTTPS enclosure. */
  #urlOf(v: EpisodeView): string | null {
    if (!this.#d.relay) return mediaURL(v);
    return v.episode.has_media ? `episode:${v.episode.episode_id}` : null;
  }

  #fail(text = this.#d.media.lastError || this.#d.needsRelay || "needs relay"): void {
    this.#show();
    this.#set({ error: text, busy: false });
    this.#d.notify?.(text);
  }

  // ---- user actions

  /** play plays an episode intentionally, or resumes the current one. */
  play(e?: EpisodeRow): Promise<void> {
    this.#wantsPlay = true;
    return this.#run(async () => {
      this.#set({ busy: true, error: null });
      try {
        await this.#own();
        if (!e || e.episode_id === this.#current?.info.episode_id) await this.#resume();
        else await this.#switchTo(e.episode_id, "switched");
      } finally {
        this.#set({ busy: false });
      }
    }) as Promise<void>;
  }

  /** pause stops the audio at once; its final save is journaled in order with the other transitions. */
  pause(): Promise<void> {
    const h = this.#halt();
    return this.#run(async () => {
      if (h) await h.saved;
    }) as Promise<void>;
  }

  toggle(): Promise<void> {
    return this.#playing ? this.pause() : this.play();
  }

  /** moveHere is "Playing in another tab"'s button: this tab takes the player and resumes. */
  moveHere(): Promise<void> {
    return this.play();
  }

  seek(position: number): Promise<void> {
    return this.#run(async () => {
      const c = this.#current;
      if (!c || this.#state.mode !== "here") return;
      const d = this.#d.media.duration || c.duration;
      const p = Math.max(0, d > 0 ? Math.min(position, d) : position);
      await this.#seekTo(c, p);
    }) as Promise<void>;
  }

  /** #seekTo is an intentional seek: it takes over from a newer claim known while playing (PROTOCOL §8); while paused it is kept. */
  async #seekTo(c: Current, p: number): Promise<void> {
    if (this.#playing && this.#live && c.superseding && (await this.#takeOver(c, c.superseding, p))) return;
    if (c.loaded) this.#d.media.seek(p);
    c.position = p;
    this.#show();
    if (!this.#playing) await this.#keepPausedSeek(c, p);
  }

  /**
   * #keepPausedSeek records a seek made while paused, so a reload, a return
   * after another episode and the completion of the episode left all see
   * it: the profile's current episode moves, and the episode's open session
   * keeps it as the position its next save carries (seek, then resume, PROTOCOL §12).
   * Nothing was listened to, so it is no save and no fact. Only the tab that
   * holds the profile's player, on the episode and session the profile has
   * current, records it; in any other tab (one whose lease lapsed and was
   * renewed elsewhere) it stays that tab's own, and never reaches the owner's
   * resume position or completion.
   */
  async #keepPausedSeek(c: Current, p: number): Promise<void> {
    await inPlayer(this.#d.db, async (t) => {
      const lease = await getLeaseIn(t, this.#d.account);
      const held = lease.current;
      if (!this.#ownsCurrent(lease) || c !== this.#current || !held || held.episode_id !== c.info.episode_id || held.session_id !== c.sessionId) return;
      const sessionId = this.#live?.session_id ?? c.sessionId;
      const r = sessionId ? await getSessionIn(t, this.#d.account, sessionId) : undefined;
      if (r && !r.sealed && !r.closed && r.episode.episode_id === c.info.episode_id) {
        r.resume = Math.max(0, Math.round(p));
        await putSessionIn(t, r);
      }
      lease.current = this.#currentRow(p, c);
      await putLeaseIn(t, lease);
    }).catch((e: unknown) => this.#storageFailed(e));
  }

  /**
   * #takeOver is an intentional seek while another device's newer claim is
   * known (PROTOCOL §8): in one transaction, with no network wait, the playing
   * session is sealed at its pre-seek save and a new session claims the
   * chosen position, depending on that claim; then the audio moves. The view
   * the claim came from is the one the new session observed.
   */
  async #takeOver(cur: Current, sup: { claim: string; deps: string[] }, position: number): Promise<boolean> {
    const live = this.#live!;
    const view = cur.view;
    if (!view) return false;
    const now = this.#now;
    const before = this.#d.media.position;
    const duration = this.#d.media.duration;
    let row: SessionRow | null;
    try {
      row = await inPlayer(this.#d.db, async (t) => {
        const r = await getSessionIn(t, this.#d.account, live.session_id);
        if (!r || r.sealed) return null;
        addSave(r, before, now, this.#d.page);
        await exportIn(t, r, this.#d.page, now, { reason: "superseded", completed: false, removeFromQueue: false, history: false, dependencies: sup.deps });
        r.closed = true;
        await putSessionIn(t, r);
        const started = await startIn(
          t,
          {
            account: this.#d.account,
            author: this.#d.page,
            page: this.#d.page,
            tab: this.#d.tab,
            episode: refOf(view),
            position,
            duration,
            observedClaim: sup.claim,
            queueBundle: null, // it plays here, so it was queued when it started (or removed since, by the person)
            dependencies: [...provenance(view.episode.records), ...sup.deps],
          },
          now,
        );
        const lease = await getLeaseIn(t, this.#d.account);
        if (this.#ownsCurrent(lease)) {
          cur.sessionId = started.session_id;
          lease.current = this.#currentRow(position, cur);
          await putLeaseIn(t, lease);
        }
        return started;
      });
    } catch (e) {
      this.#storageFailed(e);
      return true;
    }
    if (!row) return false;
    this.#appended(2);
    this.#d.media.seek(position);
    cur.position = position;
    cur.sessionId = row.session_id;
    cur.claim = row.start_op;
    cur.claimDeps = [];
    cur.superseding = null;
    cur.lastPlayed = now;
    this.#live = row;
    this.#lastSaveAt = now;
    this.#show();
    return true;
  }

  rewind(): Promise<void> {
    return this.#run(async () => {
      const c = this.#current;
      if (!c || this.#state.mode !== "here") return;
      const p = Math.max(0, (c.loaded ? this.#d.media.position : c.position) - rewindMs);
      await this.#seekTo(c, p);
    }) as Promise<void>;
  }

  /** fastForward seeks 30 s on; past the end it ends the episode, as Android's seekForward does. */
  fastForward(): Promise<void> {
    return this.#run(async () => {
      const c = this.#current;
      if (!c || this.#state.mode !== "here") return;
      const d = this.#d.media.duration || c.duration;
      const p = (c.loaded ? this.#d.media.position : c.position) + fastForwardMs;
      if (d > 0 && p >= d) {
        await this.#finish(false);
        return;
      }
      await this.#seekTo(c, p);
    }) as Promise<void>;
  }

  /** skip ends the episode as skipped and starts the next one in the queue. */
  skip(): Promise<void> {
    this.#wantsPlay = true; // the next episode plays, as before
    return this.#run(async () => {
      const cur = this.#current;
      if (!cur || this.#state.mode !== "here") return;
      const next = await this.#nextInQueue(cur);
      await this.#leave("skipped");
      if (next) await this.#switchTo(next.episode_id, null);
      else {
        await this.#clear();
        if (this.#d.lastInQueue) this.#d.notify?.(this.#d.lastInQueue);
      }
    }) as Promise<void>;
  }

  setRate(rate: number): void {
    this.#d.media.rate = rate;
    this.#set({ rate });
  }

  /**
   * beforeCut exports every unexported save of the account, whichever tab's
   * session it is (PROTOCOL §12), after a fresh save of this tab's playing session,
   * and returns the listening facts a cut must depend on.
   */
  beforeCut(): Promise<string[]> {
    return this.#run(async () => {
      if (this.#playing) await this.#save(this.#d.media.position, "flush");
      const made = await exportPending(this.#d.db, this.#d.account, this.#d.page, this.#now);
      this.#appended(made.length);
      // The exports just made are named even if another tab already retired them (a coherent observation).
      return [...new Set([...made, ...(await listeningFrontier(this.#d.db, this.#d.account))])];
    }).then((r) => r ?? []);
  }

  /** stopFor stops the player when its episode's position is reset, as Android's menu does. */
  stopFor(episodeId: string): Promise<void> {
    return this.#run(async () => {
      if (this.#current?.info.episode_id !== episodeId || this.#state.mode !== "here") return;
      await this.#pauseAndSave();
      await this.#close();
      await this.#clear();
    }) as Promise<void>;
  }

  /**
   * leave pauses playback and waits for its last save, before an account
   * transition reloads the page; pageHidden stays the fallback for exits the
   * app does not control.
   */
  leave(): Promise<void> {
    // At once, not queued: a queued step (a refresh whose read stalls) must not
    // spend the transition's time before playback stops and the save starts.
    const h = this.#halt();
    return h ? h.saved : Promise.resolve();
  }

  /** pageHidden makes a last save when the page goes away (best effort). */
  pageHidden(): void {
    if (!this.#playing || !this.#live) return;
    void this.#save(this.#d.media.position, "pause");
  }

  // ---- transitions

  async #resume(): Promise<void> {
    const cur = this.#current;
    if (!cur) return;
    if (!cur.loaded) {
      if (!cur.view || !cur.url) {
        try {
          cur.view = await this.#read(this.#d.reads.episode(cur.info.episode_id));
          cur.info = infoOf(cur.view);
          cur.url = this.#urlOf(cur.view);
          await this.#adoptIfNewer(cur, cur.view);
        } catch {
          /* handled below */
        }
      }
      try {
        await this.#load(cur);
      } catch {
        this.#fail();
        return;
      }
    }
    const now = this.#now;
    const live = this.#live;
    if (live && !live.sealed) {
      // Ordinary pause and resume keep the session (PROTOCOL §8).
      this.#rewind(cur, live.last.time, now);
      if (!(await this.#start())) return;
      await this.#save(this.#d.media.position, "interval");
      return;
    }
    const restored = cur.sessionId ? await getSession(this.#d.db, this.#d.account, cur.sessionId) : undefined;
    if (restored && !restored.sealed && !restored.closed && restored.tab === this.#d.tab && (!cur.claim || restored.claims.includes(cur.claim))) {
      // The open session of this tab before a reload resumes, with the baseline this load began (PROTOCOL §12).
      this.#rewind(cur, restored.last.time, now);
      if (!(await this.#start())) return;
      const position = this.#d.media.position;
      const row = await inPlayer(this.#d.db, async (t) => {
        const r = await getSessionIn(t, this.#d.account, restored.session_id);
        if (!r) return null;
        r.baseline = cur.baseline;
        r.base = { position: Math.round(position), contribution: r.last.contribution };
        r.tab = this.#d.tab;
        addSave(r, position, now, this.#d.page);
        await putSessionIn(t, r);
        const lease = await getLeaseIn(t, this.#d.account);
        if (this.#ownsCurrent(lease)) {
          lease.current = this.#currentRow(position);
          await putLeaseIn(t, lease);
        }
        return r;
      }).catch((e: unknown) => {
        this.#storageFailed(e);
        return null;
      });
      if (!row) return;
      this.#live = row;
      this.#lastSaveAt = now;
      this.#show();
      return;
    }
    // Resuming the same episode never finalizes it; a new session claims (PROTOCOL §8).
    await this.#startSession(cur);
  }

  #rewind(cur: Current, lastPlayed: number, now: number): void {
    const p = rewindAfterPause(this.#d.media.position, Math.max(lastPlayed, cur.lastPlayed), now);
    if (p !== this.#d.media.position) this.#d.media.seek(p);
  }

  /** #start starts the audio; false when it cannot play, or Pause was pressed before or while it started. */
  async #start(): Promise<boolean> {
    if (!this.#wantsPlay) {
      this.#show();
      return false;
    }
    try {
      await this.#d.media.play();
    } catch {
      if (this.#wantsPlay) this.#fail();
      else this.#show(); // Pause cancelled the start
      return false;
    }
    if (!this.#wantsPlay) {
      // Pause came while the audio started: it stays paused, and no session begins.
      this.#d.media.pause();
      this.#show();
      return false;
    }
    this.#playing = true;
    this.#show();
    return true;
  }

  /** #startSession is an intentional start: session.start (a claim), with the queue add Android makes on play. */
  async #startSession(cur: Current, rewind = true): Promise<void> {
    let view = cur.view;
    try {
      view = await this.#read(this.#d.reads.episode(cur.info.episode_id));
      cur.view = view;
    } catch {
      /* the last view stands */
    }
    if (!view) {
      this.#fail(this.#d.unreachable);
      return;
    }
    let bundle: Bundle | null;
    try {
      bundle = await this.#bundle(view);
    } catch {
      this.#fail(this.#d.unreachable);
      return;
    }
    const now = this.#now;
    if (rewind) this.#rewind(cur, view.episode.last_played, now);
    if (!this.#playing && !(await this.#start())) return;
    const position = this.#d.media.position;
    const duration = this.#d.media.duration;
    const row = await inPlayer(this.#d.db, async (t) => {
      const r = await startIn(
        t,
        {
          account: this.#d.account,
          author: this.#d.page,
          page: this.#d.page,
          tab: this.#d.tab,
          episode: refOf(view),
          position,
          duration,
          observedClaim: claimOf(view.episode),
          queueBundle: bundle?.bundle ?? null,
          dependencies: [...provenance(view.episode.records), ...(bundle?.deps ?? []), ...cur.claimDeps],
        },
        now,
      );
      cur.sessionId = r.session_id;
      cur.claim = r.start_op;
      cur.claimDeps = [];
      cur.superseding = null;
      const lease = await getLeaseIn(t, this.#d.account);
      if (this.#ownsCurrent(lease)) {
        lease.current = this.#currentRow(position);
        await putLeaseIn(t, lease);
      }
      return r;
    }).catch((e: unknown) => {
      // Audio that the journal cannot record does not play on.
      this.#storageFailed(e);
      return null;
    });
    if (!row) return;
    this.#live = row;
    this.#lastSaveAt = now;
    cur.lastPlayed = now;
    this.#appended(1);
    this.#show();
    cur.queued = bundle ? { op: row.start_op, key: String(bundle.bundle.key) } : null;
    void this.#nextInQueue(cur); // keep the queue for continuous playback offline
  }

  /** #bundle resolves the queue add of playing an unqueued episode (PROTOCOL §7.6): its predicted key and its place. */
  async #bundle(view: EpisodeView): Promise<Bundle | null> {
    if (view.episode.in_queue) return null;
    const [queue, summary] = await Promise.all([this.#read(this.#d.reads.queue()), this.#read(this.#d.reads.summary())]);
    this.#queue = queue;
    if (queue.some((e) => e.episode_id === view.episode.episode_id)) return null;
    let policy = summary.policies.queue;
    // After the current episode: the playing one is this, not queued, so the front (ItemEnqueuePositionCalculator).
    if (policy.enqueue_location === "after_current") policy = { ...policy, enqueue_location: "front" };
    const body = addToQueue([view.episode], queue, policy);
    if (!body) return null;
    const p = body.payload as { members: Placement[]; place: Place };
    const m = p.members[0]!;
    return { bundle: { key: m.key, position_id: m.position_id, place: p.place }, deps: body.dependencies ?? [] };
  }

  /**
   * #nextInQueue is the episode after this one in the queue
   * (DBReader.getNextInQueue): none when the queue does not hold it, as after
   * Clear queue. A queue read is the queue; the last one stands only when
   * the server cannot be read. Playing an unqueued episode added it to the
   * queue: until the server has that add, the episode stands at its key, and
   * a read answered while its acknowledgement arrived is asked again, since
   * it may predate the add.
   */
  async #nextInQueue(cur: Current): Promise<EpisodeRow | null> {
    const add = cur.queued ?? null;
    const unsent = add ? await this.#unsent(add.op) : false; // before the read is asked
    const queue = (await this.#readQueue()) ?? this.#queue; // unreadable: the last read stands
    if (!queue) return null;
    const after = (q: EpisodeRow[]) => {
      const i = q.findIndex((e) => e.episode_id === cur.info.episode_id);
      return i >= 0 ? (q[i + 1] ?? null) : undefined;
    };
    const next = after(queue);
    if (next !== undefined) return next;
    if (!add || !unsent) return null; // the server had the add before this read: the read is the queue
    if (!(await this.#unsent(add.op))) {
      // Acknowledged while the queue was read: a read asked now has it applied (or what came after it).
      const again = await this.#readQueue();
      if (again) return after(again) ?? null;
    }
    const key = parseKey(add.key);
    if (!key) return null;
    return (
      queue.find((e) => {
        const k = e.records.queue_position?.value.key;
        const q = typeof k === "string" ? parseKey(k) : null;
        return q !== null && compareKeys(q, key) > 0;
      }) ?? null
    );
  }

  /** #readQueue reads the queue, keeping it for when the server cannot be read; null when it cannot. */
  async #readQueue(): Promise<EpisodeRow[] | null> {
    try {
      const queue = await this.#read(this.#d.reads.queue());
      this.#queue = queue;
      return queue;
    } catch {
      return null;
    }
  }

  /** #unsent tells whether the server has not acknowledged a fact of this profile yet. */
  async #unsent(opId: string): Promise<boolean> {
    const e = await entryOf(this.#d.db, this.#d.account, opId);
    return !!e && !e.receipt;
  }

  /**
   * #leave closes the current episode before another one starts: a playing
   * (or skipped) session ends with its final save; anything else is the lazy
   * finalization of the episode's last session (PROTOCOL §8, §12).
   */
  async #leave(reason: "switched" | "skipped"): Promise<void> {
    const cur = this.#current;
    if (!cur) return;
    const now = this.#now;
    const duration = this.#d.media.duration || cur.duration;
    const live = this.#live;
    if (live && !live.sealed && (this.#playing || reason === "skipped")) {
      const playing = this.#playing;
      const position = this.#d.media.position;
      this.#playing = false;
      this.#d.media.pause();
      await inPlayer(this.#d.db, async (t) => {
        const r = await getSessionIn(t, this.#d.account, live.session_id);
        if (!r || r.sealed) return;
        if (duration > 0) r.duration = duration;
        if (playing) addSave(r, position, now, this.#d.page);
        // Completion is decided at the position the player stands at: a seek made while paused counts (Android saves it).
        const end: EndSpec = { reason, completed: almostEnded(r.resume ?? r.last.position, r.duration || duration), removeFromQueue: false, history: true };
        await exportIn(t, r, this.#d.page, now, end);
        r.closed = true;
        await putSessionIn(t, r);
      });
      this.#live = null;
      this.#appended(1);
      return;
    }
    this.#playing = false;
    this.#live = null;
    if (!cur.sessionId) return;
    const sessionId = cur.sessionId;
    const made = await inPlayer(this.#d.db, async (t) => {
      const r = await getSessionIn(t, this.#d.account, sessionId);
      if (!r || r.finalized || (r.sealed && r.sealed !== "superseded")) return 0;
      let n = (await exportIn(t, r, this.#d.page, now)) ? 1 : 0;
      const adopted = cur.claim !== null && !r.claims.includes(cur.claim);
      const position = adopted ? cur.position : (r.resume ?? r.last.position);
      const f = await finalizeIn(t, r, now, {
        claim: adopted ? cur.claim! : r.start_op,
        completed: almostEnded(position, r.duration || duration),
        removeFromQueue: false,
        dependencies: adopted ? cur.claimDeps : [],
      });
      if (f) n++;
      await putSessionIn(t, r);
      return n;
    });
    this.#appended(made);
  }

  /** #finish is the end of the episode: natural, or fast-forwarded past it; the next queue item follows. */
  async #finish(natural: boolean): Promise<void> {
    const cur = this.#current;
    if (!cur) return;
    const live = this.#live;
    if (natural && (!live || !this.#playing)) return;
    // The next item is chosen before the end is journaled, so no push can
    // take the ended episode out of the server's queue first (PROTOCOL §8;
    // Android chooses it before the removal too).
    const next = await this.#nextInQueue(cur);
    const now = this.#now;
    const duration = this.#d.media.duration || cur.duration;
    const wasPlaying = this.#playing;
    this.#playing = false;
    if (!natural) this.#d.media.pause();
    let made = 0;
    if (live && !live.sealed) {
      await inPlayer(this.#d.db, async (t) => {
        const r = await getSessionIn(t, this.#d.account, live.session_id);
        if (!r || r.sealed) return;
        if (duration > 0) r.duration = duration;
        if (wasPlaying) addSave(r, duration, now, this.#d.page);
        if (await exportIn(t, r, this.#d.page, now, { reason: "ended", completed: true, removeFromQueue: false, history: true })) made++;
        r.closed = true;
        await putSessionIn(t, r);
      });
    } else if (cur.sessionId) {
      const sessionId = cur.sessionId;
      made = await inPlayer(this.#d.db, async (t) => {
        const r = await getSessionIn(t, this.#d.account, sessionId);
        if (!r || r.finalized || (r.sealed && r.sealed !== "superseded")) return 0;
        let n = (await exportIn(t, r, this.#d.page, now)) ? 1 : 0;
        const adopted = cur.claim !== null && !r.claims.includes(cur.claim);
        if (await finalizeIn(t, r, now, { claim: adopted ? cur.claim! : r.start_op, completed: true, removeFromQueue: false, dependencies: adopted ? cur.claimDeps : [] })) n++;
        await putSessionIn(t, r);
        return n;
      });
    }
    this.#live = null;
    this.#appended(made);
    if (next) await this.#switchTo(next.episode_id, null);
    else await this.#clear();
  }

  /**
   * #switchTo makes another episode current and plays it: the previous one
   * is left first (unless it already ended), at the newest local position.
   */
  async #switchTo(episodeId: string, leaving: "switched" | null): Promise<void> {
    let view: EpisodeView;
    try {
      view = await this.#read(this.#d.reads.episode(episodeId));
    } catch {
      this.#fail(this.#d.unreachable);
      return;
    }
    const url = this.#urlOf(view);
    if (!url && leaving) {
      // The browser cannot play it directly: the episode playing stays current.
      this.#fail();
      return;
    }
    if (leaving) await this.#leave(leaving);
    const local = await this.#localPosition(view);
    const cur: Current = {
      info: infoOf(view),
      view,
      url,
      loaded: false,
      position: local.position,
      duration: view.episode.duration_ms ?? 0,
      claim: local.claim,
      claimDeps: [],
      sessionId: null,
      lastPlayed: Math.max(view.episode.last_played, local.lastPlayed),
      baseline: uuid(),
    };
    this.#current = cur;
    this.#live = null;
    this.#show();
    await this.#saveCurrent();
    try {
      // After an ending, the next episode is current even when it needs the relay, as on Android.
      await this.#load(cur);
    } catch {
      this.#fail();
      return;
    }
    await this.#startSession(cur);
  }

  /** #localPosition is the newest position this profile knows: its own unsent saves win over the view (PROTOCOL §8). */
  async #localPosition(view: EpisodeView): Promise<{ position: number; claim: string | null; lastPlayed: number }> {
    const claim = claimOf(view.episode);
    let best: SessionRow | null = null;
    for (const s of await sessionsOf(this.#d.db, this.#d.account)) {
      if (s.episode.episode_id === view.episode.episode_id && (!best || s.last.time > best.last.time)) best = s;
    }
    if (best && ((claim && best.claims.includes(claim)) || !(await this.#inPast(best.start_op, view.head)))) {
      // A completion the server has not shown yet still resets the position, as on Android.
      if (best.completed) return { position: 0, claim: best.start_op, lastPlayed: best.last.time };
      if (best.sealed !== "ended") return { position: best.resume ?? best.last.position, claim: best.start_op, lastPlayed: best.last.time };
    } else if (best?.resume !== undefined) {
      // Another device's newer claim superseded the position the paused seek chose here: it is no longer kept.
      const id = best.session_id;
      await inPlayer(this.#d.db, async (t) => {
        const r = await getSessionIn(t, this.#d.account, id);
        if (!r || r.resume === undefined) return;
        delete r.resume;
        await putSessionIn(t, r);
      });
    }
    return { position: view.episode.position, claim, lastPlayed: view.episode.last_played };
  }

  async #clear(): Promise<void> {
    this.#current = null;
    this.#live = null;
    this.#playing = false;
    this.#d.media.unload();
    await updateLease(this.#d.db, this.#d.account, (l) => {
      if (this.#ownsCurrent(l)) l.current = null;
    });
    this.#show();
  }
}

function refOf(v: EpisodeView) {
  const identity = v.episode.records.identity?.value as { occurrence?: Record<string, unknown> } | undefined;
  const generation = v.episode.podcast.generation_id ?? v.podcast.generation_id;
  if (!identity?.occurrence || !generation) throw new Error("This episode cannot be played until its podcast is subscribed.");
  return { episode_id: v.episode.episode_id, podcast_id: v.episode.podcast_id, generation_id: generation, occurrence: identity.occurrence };
}
