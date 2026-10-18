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
import { acceptedLineage, lineages, uuid } from "../journal/journal.ts";
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
  sessionsOfEpisode,
  startIn,
  updateLease,
  type CurrentRow,
  type EndSpec,
  type LeaseRow,
  type Observed,
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
  listen(l: MediaListener): void;
}

export interface MediaListener {
  paused(): void;
  ended(): void;
  time(): void;
  error(): void;
  /** waiting tells that the media waits for this device's connection to play on (true), and when it no longer does (false). */
  waiting?(on: boolean): void;
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
  /** readyWaitMs bounds READY's wait for a read of a change announced while the episode started (1 s). */
  readyWaitMs?: number;
}

/** A chapter from the feed (Podlove simple chapters) or a chapters file, start in ms. */
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
  chapter_file?: boolean; // the episode has a chapters file (podcast:chapters), read through the server
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
  /** observed is the position record the paused position was last decided against (PROTOCOL §8.6); null when unknown (a row saved before it was kept). */
  observed: Observed | null;
  /** listened is the newest listening time a settled decision saw: across a restore, only newer listening moves the player. */
  listened: number;
  /** A newer claim seen while playing: sync never moves playing audio, but an intentional seek takes over from it (PROTOCOL §8). */
  superseding?: { claim: string; deps: string[] } | null;
  /** The queue add its session.start carries (playing an unqueued episode, PROTOCOL §7.6): the start's op and the key it takes. */
  queued?: { op: string; key: string } | null;
}

interface Bundle {
  bundle: { key: string; position_id: string; place: Place };
  deps: string[];
}

interface QueueRead {
  queue: EpisodeRow[];
  policy: Summary["policies"]["queue"];
}

/** Settled is a promise's outcome, kept until it is needed (a failure is never unhandled meanwhile). */
type Settled<T> = { ok: T } | { error: unknown };

function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (ok) => ({ ok }),
    (error: unknown) => ({ error }),
  );
}

/** within is a read's answer if it comes within ms; null when it fails or is later (it is then left to finish unused). */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Transition is what a start already read of its episode: the view, how
 * many changes had been announced when that read was asked, and the queue
 * add's reads begun beside the media's preparation.
 */
interface Transition {
  view: EpisodeView;
  asked: number;
  queue?: Promise<Settled<QueueRead | null>>;
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
  const meta = e.metadata as { description?: string | null; chapter_url?: unknown } | undefined;
  const description = meta?.description ?? null;
  return {
    episode_id: e.episode_id,
    podcast_id: e.podcast_id,
    title: e.title ?? "",
    podcast: e.podcast.display_title,
    image: e.image_url || e.podcast.image_url,
    description,
    chapters: chaptersOf(e.metadata),
    chapter_file: typeof meta?.chapter_url === "string" && meta.chapter_url !== "",
  };
}

function claimOf(e: EpisodeRow): string | null {
  const c = e.records.position?.value.claim_id;
  return typeof c === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(c) ? c : null;
}

/** versionOf identifies the view's position record (PROTOCOL §8.6): a new write changes its provenance, whatever the number. */
function versionOf(v: EpisodeView, settled: boolean): Observed {
  const rec = v.episode.records.position;
  const g = rec?.value.generation_id;
  return {
    log_id: v.head.log_id,
    epoch: v.head.epoch,
    generation_id: typeof g === "string" ? g : (v.episode.podcast.generation_id ?? null),
    claim_id: claimOf(v.episode),
    provenance: [...(rec?.provenance ?? [])].sort(),
    last_played: v.episode.last_played,
    settled,
  };
}

/** sameLine tells whether two records can be ordered by their versions: one lineage and one generation. */
function sameLine(a: Observed, b: Observed): boolean {
  return a.log_id === b.log_id && a.epoch === b.epoch && a.generation_id === b.generation_id;
}

function sameRecord(a: Observed, b: Observed): boolean {
  return sameLine(a, b) && a.claim_id === b.claim_id && a.provenance.length === b.provenance.length && a.provenance.every((x, i) => x === b.provenance[i]);
}

/** laterHead tells whether head a is at or after b: within a log by (epoch, seq), a restored epoch first; another log is a later read's. */
function laterHead(a: Head, b: Head): boolean {
  if (a.log_id !== b.log_id) return true;
  return a.epoch !== b.epoch ? a.epoch > b.epoch : a.seq >= b.seq;
}

/** A decision on a view's position record (PROTOCOL §8.6): move the paused player to it, or only take it as the baseline. */
type Decision = { adopt: Observed } | { rebaseline: Observed } | null;

/** Own is this profile's sessions of one episode, as adoption needs them. */
interface Own {
  sessions: SessionRow[];
  lastSave: number; // the newest listening save made here
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
  #intent = 0; // counts the person's player actions: a read begun before one is not applied over it
  #announced = 0; // counts the changes announced to the player (refresh): READY knows whether a read it holds predates one
  // Background reads of the current episode run beside the chain; only applying their result joins it.
  #refreshing: Promise<void> | null = null; // the running refresh loop
  #refreshAgain = false; // a view changed since the loop's read began: read once more
  #refreshFailed = false; // the last background read of the episode failed: the caller tries again later
  /** #refreshRead is the refresh's read in flight, with the announcements before it was asked: a start can wait for it, never for its chained application. */
  #refreshRead: { episodeId: string; read: Promise<EpisodeView>; asked: number } | null = null;
  /** #observation is the newest refresh result read and not yet applied: READY uses it even while its application waits behind the start. */
  #observation: EpisodeView | null = null;
  #observationAsked = 0; // the announcements before the observation's read was asked
  #waiting = false; // the media waits for this device's connection: the player shows it buffering, as Android does

  constructor(deps: PlayerDeps) {
    this.#d = { now: Date.now, timers: true, handoffMs: 3000, readTimeoutMs: 15_000, readyWaitMs: 1_000, ...deps };
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
      waiting: (on) => {
        this.#waiting = on;
        this.#set({ busy: on });
      },
    });
    this.#unlisten = deps.channel.listen((m) => this.#message(m));
  }

  // ---- observing

  get state(): PlayerState {
    return this.#state;
  }

  /** refreshFailed tells whether the last background read of the current episode failed (it is to be tried again). */
  get refreshFailed(): boolean {
    return this.#refreshFailed;
  }

  /** viewHead is the head of the current episode's view this page holds, or null. */
  get viewHead(): Head | null {
    return this.#current?.view?.head ?? null;
  }

  /** unappliedRead is the head of a background read's answer this page knows and has not applied yet (READY uses it), or null. */
  get unappliedRead(): Head | null {
    return this.#observation?.head ?? null;
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
    // A view of a lineage the profile left is no knowledge: the bar shows what the profile kept.
    if (view && !(await this.#accepted(view))) view = null;
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
      // The baseline is the one the profile kept, never replaced by the record just read.
      observed: c.observed ?? null,
      listened: c.listened ?? 0,
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

  /** #accepted tells whether a view is of the profile's lineage: a late view of a lineage it left is never used (PROTOCOL §12). */
  async #accepted(view: EpisodeView): Promise<boolean> {
    return acceptedLineage(await lineages(this.#d.db, this.#d.account), view.head);
  }

  /** #newest is the newest of the views this page holds of an episode, later ones winning ties; views of another lineage are dropped. */
  async #newest(...views: (EpisodeView | null | undefined)[]): Promise<EpisodeView | null> {
    const l = await lineages(this.#d.db, this.#d.account);
    let best: EpisodeView | null = null;
    for (const v of views) {
      if (!v || !acceptedLineage(l, v.head)) continue;
      if (!best || laterHead(v.head, best.head)) best = v;
    }
    return best;
  }

  /** #ownOf is this profile's sessions of an episode, any tab's, read through the episode index: never the rest of its history. */
  async #ownOf(episodeId: string): Promise<Own> {
    const sessions = await sessionsOfEpisode(this.#d.db, this.#d.account, episodeId);
    return { sessions, lastSave: Math.max(0, ...sessions.map((s) => s.last.time)) };
  }

  /** #pending tells whether a claim of ours on the episode is not in the view's past yet: our own intent, which the overlay keeps (PROTOCOL §8.6). */
  async #pending(own: Own, head: Head): Promise<boolean> {
    for (const s of own.sessions) if (!(await this.#inPast(s.claims.at(-1) ?? s.start_op, head))) return true;
    return false;
  }

  /**
   * #decide decides what a paused player does with a view's position record
   * (PROTOCOL §8.6). It starts from the newest record it knows: a record that
   * changed since the one the position was decided against is adopted,
   * whether its claim is new or the same claim moved on (a later checkpoint,
   * a completion back to 0). Our own claim the server has not shown yet
   * wins, and the record is decided again once it has: nothing is taken as
   * the baseline meanwhile. Our own record only becomes the baseline. Across
   * a restore (another lineage) or a new generation, versions cannot be
   * ordered: only listening newer than all this player knew moves it, so a
   * restored older record never does.
   */
  async #decide(cur: Current, view: EpisodeView): Promise<Decision> {
    if (this.#current !== cur || view.episode.episode_id !== cur.info.episode_id || !(await this.#accepted(view))) return null;
    if (!claimOf(view.episode)) return null;
    const v = versionOf(view, true);
    const own = await this.#ownOf(cur.info.episode_id);
    if (await this.#pending(own, view.head)) return null;
    if (own.sessions.some((s) => s.claims.includes(v.claim_id!))) return { rebaseline: v };
    const o = cur.observed;
    if (o?.settled && sameRecord(o, v)) return null; // unchanged: a seek made here while paused stands
    if (o && sameLine(o, v)) return { adopt: v };
    return view.episode.last_played > Math.max(cur.listened, own.lastSave) ? { adopt: v } : { rebaseline: v };
  }

  /** #takesOver is a newer claim of another device, known while playing: an intentional seek takes over from it (PROTOCOL §8). */
  async #takesOver(cur: Current, view: EpisodeView): Promise<string | null> {
    const claim = claimOf(view.episode);
    if (!claim || claim === cur.claim || !(await this.#accepted(view))) return null;
    const own = await this.#ownOf(cur.info.episode_id);
    if (own.sessions.some((s) => s.claims.includes(claim)) || (await this.#pending(own, view.head))) return null;
    return claim;
  }

  /**
   * #adoptIfNewer moves a paused player to a newer position another device
   * claimed: the local session is sealed at its pre-adoption save (reason
   * superseded, no activity) and resuming starts a new session. A record it
   * does not move to may still become its baseline.
   */
  async #adoptIfNewer(cur: Current, view: EpisodeView): Promise<boolean> {
    const d = await this.#decide(cur, view);
    if (!d) return false;
    cur.listened = Math.max(cur.listened, view.episode.last_played);
    if ("rebaseline" in d) {
      cur.observed = d.rebaseline;
      await this.#saveCurrent();
      return false;
    }
    const claim = d.adopt.claim_id!;
    const row = cur.sessionId ? await getSession(this.#d.db, this.#d.account, cur.sessionId) : undefined;
    const deps = provenance(view.episode.records, ["position"]);
    if (row) await this.#seal(row, deps);
    cur.position = view.episode.position;
    cur.claim = claim;
    cur.claimDeps = deps;
    cur.superseding = null;
    cur.lastPlayed = view.episode.last_played;
    cur.observed = d.adopt;
    if (cur.loaded && !this.#playing) this.#d.media.seek(cur.position);
    if (this.#live?.session_id === row?.session_id) this.#live = null;
    await this.#saveCurrent();
    return true;
  }

  /** #seal ends a paused session that no longer owns the position at its last save, without listening activity (reason superseded). */
  async #seal(row: SessionRow, deps: string[]): Promise<void> {
    if (row.sealed || row.closed) return;
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

  /**
   * refresh re-reads the current episode when views change: a paused player
   * adopts newer positions. The read runs beside the player's transitions, so
   * Play, Pause and the seeks never wait for it; requests made while one is in
   * flight are served by one more read after it. It resolves once the reads
   * asked for are applied.
   */
  refresh(): Promise<void> {
    this.#announced++;
    this.#refreshAgain = true;
    this.#refreshing ??= this.#beside(this.#refreshLoop());
    return this.#refreshing;
  }

  async #refreshLoop(): Promise<void> {
    await null; // the loop is this.#refreshing before it can end
    try {
      while (this.#refreshAgain && !this.#disposed) {
        this.#refreshAgain = false;
        const cur = this.#current;
        if (!cur || this.#state.mode !== "here") continue;
        const intent = this.#intent;
        const episodeId = cur.info.episode_id;
        const asked = this.#announced;
        const read = this.#read(this.#d.reads.episode(episodeId));
        this.#refreshRead = { episodeId, read, asked };
        let view: EpisodeView;
        try {
          view = await read;
          this.#refreshFailed = false;
        } catch {
          this.#refreshFailed = true;
          continue;
        } finally {
          if (this.#refreshRead?.read === read) this.#refreshRead = null;
        }
        // Known from now on, and kept until applied: a start the application waits behind still uses it
        // (whoever uses it takes it only if it is of the profile's lineage and the newest).
        if (this.#current === cur && view.episode.episode_id === cur.info.episode_id) {
          this.#observation = view;
          this.#observationAsked = asked;
        }
        await this.#run(() => this.#applyRefresh(cur, view, intent));
      }
    } finally {
      this.#refreshing = null;
    }
  }

  /** #applyRefresh applies a background read, in order with the player's transitions; it never reads. */
  async #applyRefresh(cur: Current, view: EpisodeView, intent: number): Promise<void> {
    if (this.#observation === view) this.#observation = null;
    if (this.#current !== cur || view.episode.episode_id !== cur.info.episode_id || this.#state.mode !== "here") return;
    // A view of a lineage the profile left, or older than one a transition read since, is no news.
    if ((await this.#newest(cur.view, view)) !== view) return;
    cur.view = view;
    cur.url = this.#urlOf(view);
    if (this.#playing) {
      // Sync never moves playing audio; the claim is remembered for an intentional seek.
      const claim = await this.#takesOver(cur, view);
      cur.superseding = claim ? { claim, deps: provenance(view.episode.records, ["position"]) } : null;
      return;
    }
    if (this.#intent !== intent) {
      // The person acted while it was read (a seek, Pause): it is read again rather than applied over that.
      this.#refreshAgain = true;
      return;
    }
    if (await this.#adoptIfNewer(cur, view)) this.#show();
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
        observed: c.observed ?? null,
        listened: c.listened ?? 0,
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
    // Waiting for the connection where the last save is, nothing is listened to: no save, no fresh activity.
    if (this.#waiting && Math.max(0, Math.round(this.#d.media.position)) === live.last.position) return;
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
      observed: c.observed,
      listened: c.listened,
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
    this.#intent++;
    this.#wantsPlay = true;
    return this.#run(async () => {
      this.#set({ busy: true, error: null });
      try {
        await this.#own();
        if (!e || e.episode_id === this.#current?.info.episode_id) await this.#resume();
        else await this.#switchTo(e.episode_id, "switched");
      } finally {
        this.#set({ busy: this.#waiting });
      }
    }) as Promise<void>;
  }

  /**
   * pause stops the audio at once; its final save is journaled in order with
   * the other transitions. It resolves once that save is made (at once when
   * nothing played), not when the transitions before it end.
   */
  pause(): Promise<void> {
    this.#intent++;
    const h = this.#halt();
    void this.#run(async () => {
      if (h) await h.saved;
    });
    return h ? h.saved : Promise.resolve();
  }

  toggle(): Promise<void> {
    return this.#playing ? this.pause() : this.play();
  }

  /** moveHere is "Playing in another tab"'s button: this tab takes the player and resumes. */
  moveHere(): Promise<void> {
    return this.play();
  }

  seek(position: number): Promise<void> {
    this.#intent++;
    const known = this.#observation; // what this page knew when the person chose
    return this.#run(async () => {
      const c = this.#current;
      if (!c || this.#state.mode !== "here") return;
      const d = this.#d.media.duration || c.duration;
      const p = Math.max(0, d > 0 ? Math.min(position, d) : position);
      await this.#seekTo(c, p, known);
    }) as Promise<void>;
  }

  /**
   * #seekTo is an intentional seek: it takes over from a newer claim known
   * while playing (PROTOCOL §8); while paused it is kept, chosen against
   * every record known when it was made. known is a background read's
   * answer this page held at the person's command and has not applied yet.
   */
  async #seekTo(c: Current, p: number, known: EpisodeView | null): Promise<void> {
    if (this.#playing && this.#live && c.superseding && (await this.#takeOver(c, c.superseding, p))) return;
    if (c.loaded) this.#d.media.seek(p);
    c.position = p;
    this.#show();
    if (this.#playing) return;
    await this.#chosenAgainst(c, known);
    await this.#keepPausedSeek(c, p);
  }

  /**
   * #chosenAgainst ties a seek made while paused to the records this page
   * knew when the person made it (PROTOCOL §8.6): the position was chosen
   * after them, so the newest of them becomes the baseline, and only a record
   * learned later moves the player. A record our own pending claim keeps
   * undecided stays undecided, and nothing of another lineage is taken.
   */
  async #chosenAgainst(c: Current, known: EpisodeView | null): Promise<void> {
    const view = await this.#newest(c.view, known?.episode.episode_id === c.info.episode_id ? known : null);
    if (!view) return;
    const d = await this.#decide(c, view);
    if (!d) return;
    c.view = view;
    c.observed = "adopt" in d ? d.adopt : d.rebaseline;
    c.listened = Math.max(c.listened, view.episode.last_played);
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
    this.#intent++;
    const known = this.#observation;
    return this.#run(async () => {
      const c = this.#current;
      if (!c || this.#state.mode !== "here") return;
      const p = Math.max(0, (c.loaded ? this.#d.media.position : c.position) - rewindMs);
      await this.#seekTo(c, p, known);
    }) as Promise<void>;
  }

  /** fastForward seeks 30 s on; past the end it ends the episode, as Android's seekForward does. */
  fastForward(): Promise<void> {
    this.#intent++;
    const known = this.#observation;
    return this.#run(async () => {
      const c = this.#current;
      if (!c || this.#state.mode !== "here") return;
      const d = this.#d.media.duration || c.duration;
      const p = (c.loaded ? this.#d.media.position : c.position) + fastForwardMs;
      if (d > 0 && p >= d) {
        await this.#finish(false);
        return;
      }
      await this.#seekTo(c, p, known);
    }) as Promise<void>;
  }

  /** skip ends the episode as skipped and starts the next one in the queue. */
  skip(): Promise<void> {
    this.#intent++;
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
    this.#intent++;
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

  /**
   * pageHidden makes a last save when the page goes away (best effort). A
   * page that goes for good (one the browser does not keep to come back to)
   * then lets go of its media, once the save has the position: Firefox
   * would otherwise give the old page's download to the next page load's
   * element, whose first request then starts mid-file, and it can block
   * such a request to another site as the first of a page (Opaque Response
   * Blocking): the publisher's URL fails there, and the episode needs the
   * relay.
   */
  pageHidden(persisted = false): void {
    if (this.#playing && this.#live) void this.#save(this.#d.media.position, "pause");
    if (!persisted) this.#d.media.unload();
  }

  // ---- transitions

  async #resume(): Promise<void> {
    const cur = this.#current;
    if (!cur) return;
    let read: Transition | null = null; // the episode's view this resume read, which a new session starts from
    if (!cur.loaded) {
      if (!cur.view || !cur.url) {
        try {
          const asked = this.#announced;
          const fresh = await this.#read(this.#d.reads.episode(cur.info.episode_id));
          read = { view: fresh, asked };
          cur.info = infoOf(fresh);
          cur.url = this.#urlOf(fresh);
          cur.view = await this.#newest(cur.view, fresh);
          if (cur.view) await this.#adoptIfNewer(cur, cur.view);
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
    // READY: resuming never waits for a read, but starts from the newest position this page knows.
    await this.#newestBeforeStart(cur, null);
    const now = this.#now;
    let live = this.#live;
    const known = live && !live.sealed && cur.view ? await this.#takesOver(cur, cur.view) : null;
    if (live && known) {
      // Another device's newer claim is known and the person chose to stay here (a seek made after it): the
      // open session no longer owns the position, so Play claims it with a new session observing that claim (PROTOCOL §8.1).
      await this.#seal(live, provenance(cur.view!.episode.records, ["position"]));
      this.#live = live = null;
    }
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
    await this.#startSession(cur, true, read);
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

  /**
   * #newestBeforeStart is READY's one gate (PROTOCOL §8.6): a paused player
   * starts from the newest position it knows. The newest view this page holds
   * (one just read, one a refresh read whose application still waits behind
   * this start, or the episode's) becomes the episode's view, and its record
   * is decided on, unless Pause came, the lease was lost or the episode
   * changed meanwhile. It answers that view, or null when this page holds
   * none of the profile's lineage: a view it dropped is never used instead.
   * It never waits for a read (#caughtUp does, before it).
   */
  async #newestBeforeStart(cur: Current, ...fresh: (EpisodeView | null)[]): Promise<EpisodeView | null> {
    const seen = this.#observation?.episode.episode_id === cur.info.episode_id ? this.#observation : null;
    const newest = await this.#newest(cur.view, seen, ...fresh);
    if (!newest || newest.episode.episode_id !== cur.info.episode_id) return null;
    if (this.#current !== cur) return newest;
    cur.view = newest;
    if (this.#playing || !this.#wantsPlay || !this.#ownsCurrent(await getLease(this.#d.db, this.#d.account))) return newest;
    if (await this.#adoptIfNewer(cur, newest)) this.#show();
    return newest;
  }

  /**
   * #startSession is an intentional start: session.start (a claim), with the
   * queue add Android makes on play. A transition that read the episode
   * hands that view over, and the queue add's reads it began: the episode is
   * not read again. Otherwise it is read here.
   */
  async #startSession(cur: Current, rewind = true, from: Transition | null = null): Promise<void> {
    let fresh: EpisodeView | null = from?.view ?? null;
    const asked = from?.asked ?? this.#announced;
    if (!from) {
      try {
        fresh = await this.#read(this.#d.reads.episode(cur.info.episode_id));
      } catch {
        /* the last view stands */
      }
    }
    const first = await this.#newest(cur.view, fresh);
    if (!first) {
      this.#fail(this.#d.unreachable);
      return;
    }
    let queue: QueueRead | null;
    try {
      const read = from?.queue ? await from.queue : { ok: await this.#queueRead(first) };
      if ("error" in read) throw read.error;
      queue = read.ok;
    } catch {
      this.#fail(this.#d.unreachable);
      return;
    }
    // READY, after every wait that comes before the start: the newest view this page holds decides the position
    // and the claim it observes, and the queue add is placed for that view (no second read). A change announced
    // since the episode was read is waited for, briefly.
    const caught = await this.#caughtUp(cur, asked);
    const view = await this.#newestBeforeStart(cur, fresh, caught);
    if (!view) {
      this.#fail(this.#d.unreachable);
      return;
    }
    const bundle = this.#bundle(view, queue);
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

  /**
   * #caughtUp is READY's only wait (PROTOCOL §8.6). When a change was
   * announced after the read this start holds was asked, and no answer read
   * since is held, it takes the answer of a read asked since: the background
   * refresh's raw read (never its chained application, which waits behind
   * this start), else one asked now. It waits at most readyWaitMs; a read
   * that fails or comes later is not waited for, and the start goes on with
   * the newest view it holds. The refresh's answer is applied after the
   * start in any case; when READY's own read is not used, a refresh follows
   * the start, so the change still reaches the player.
   */
  async #caughtUp(cur: Current, asked: number): Promise<EpisodeView | null> {
    const latest = this.#announced;
    const id = cur.info.episode_id;
    if (asked >= latest) return null;
    if (this.#observation?.episode.episode_id === id && this.#observationAsked >= latest) return null;
    const pending = this.#refreshRead;
    if (pending && pending.episodeId === id && pending.asked >= latest) return within(pending.read, this.#d.readyWaitMs);
    const answer = await within(this.#d.reads.episode(id), this.#d.readyWaitMs);
    if (!answer) void this.refresh();
    return answer;
  }

  /** #queueRead reads what the queue add of playing an unqueued episode needs (PROTOCOL §7.6): the queue and its policy; null for a queued one. */
  async #queueRead(view: EpisodeView): Promise<QueueRead | null> {
    if (view.episode.in_queue) return null;
    const [queue, summary] = await Promise.all([this.#read(this.#d.reads.queue()), this.#read(this.#d.reads.summary())]);
    this.#queue = queue;
    return { queue, policy: summary.policies.queue };
  }

  /**
   * #bundle places the queue add of playing an unqueued episode (PROTOCOL
   * §7.6): its predicted key and its place, from the queue read before
   * READY. An episode the read view had queued has none to place.
   */
  #bundle(view: EpisodeView, read: QueueRead | null): Bundle | null {
    if (view.episode.in_queue || !read) return null;
    const { queue } = read;
    if (queue.some((e) => e.episode_id === view.episode.episode_id)) return null;
    let policy = read.policy;
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
    const asked = this.#announced;
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
    // A view of a lineage the profile left (a read answered before a restore) initializes nothing: the
    // profile's own position stands until READY decides on a view of its lineage.
    const known = (await this.#accepted(view)) ? view : null;
    const local = known ? await this.#localPosition(known) : await this.#ownPosition(episodeId);
    const cur: Current = {
      info: infoOf(view),
      view: known,
      url,
      loaded: false,
      position: local.position,
      duration: view.episode.duration_ms ?? 0,
      claim: local.claim,
      claimDeps: [],
      sessionId: null,
      lastPlayed: Math.max(known?.episode.last_played ?? 0, local.lastPlayed),
      baseline: uuid(),
      // The record this load read: decided on, unless our own pending claim kept the local position.
      observed: known ? versionOf(known, local.settled) : null,
      listened: known && local.settled ? known.episode.last_played : 0,
    };
    this.#current = cur;
    this.#live = null;
    this.#observation = null;
    this.#show();
    await this.#saveCurrent();
    // The queue add's reads (an unqueued episode's) run while the media prepares; READY waits for them.
    const queue = known ? settle(this.#queueRead(known)) : undefined;
    try {
      // After an ending, the next episode is current even when it needs the relay, as on Android.
      await this.#load(cur);
    } catch {
      this.#fail();
      return;
    }
    await this.#startSession(cur, true, known ? { view: known, asked, queue } : null);
  }

  /** #ownPosition is where this profile's latest session of an episode stands, with no view to weigh it against (0 without one). */
  async #ownPosition(episodeId: string): Promise<{ position: number; claim: string | null; lastPlayed: number; settled: false }> {
    let best: SessionRow | null = null;
    for (const s of (await this.#ownOf(episodeId)).sessions) if (!best || s.last.time > best.last.time) best = s;
    if (!best || (best.sealed === "ended" && !best.completed)) return { position: 0, claim: null, lastPlayed: 0, settled: false };
    return { position: best.completed ? 0 : (best.resume ?? best.last.position), claim: best.start_op, lastPlayed: best.last.time, settled: false };
  }

  /**
   * #localPosition is the newest position this profile knows: its own unsent
   * saves win over the view (PROTOCOL §8). settled is false when our own
   * claim the server has not shown yet decided it: the view's record is then
   * decided again once it has.
   */
  async #localPosition(view: EpisodeView): Promise<{ position: number; claim: string | null; lastPlayed: number; settled: boolean }> {
    const claim = claimOf(view.episode);
    const own = await this.#ownOf(view.episode.episode_id);
    let best: SessionRow | null = null;
    for (const s of own.sessions) if (!best || s.last.time > best.last.time) best = s;
    const pending = await this.#pending(own, view.head);
    if (best && ((claim && best.claims.includes(claim)) || pending)) {
      // A completion the server has not shown yet still resets the position, as on Android.
      if (best.completed) return { position: 0, claim: best.start_op, lastPlayed: best.last.time, settled: !pending };
      if (best.sealed !== "ended") return { position: best.resume ?? best.last.position, claim: best.start_op, lastPlayed: best.last.time, settled: !pending };
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
    return { position: view.episode.position, claim, lastPlayed: view.episode.last_played, settled: !pending };
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
