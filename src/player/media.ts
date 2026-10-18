// The <audio> element behind the player (PROTOCOL §12, §13):
// positions in ms. An episode's source comes from the server's descriptor:
// the publisher's URL (direct), the server's relay, or the compatibility
// path, whose stream starts at a time and is offset onto the episode's
// timeline, and is fed through a MediaSource where the browser takes it
// (mse.ts). Media Session metadata and actions where the browser has them.
import type { EpisodeInfo, Media, MediaListener } from "./engine.ts";
import { Feed, mediaSourceFor, type FeedOptions } from "./mse.ts";

const metadataWaitMs = 15_000;
const playWaitMs = 30_000;
/** A dropped connection is asked about again with the views' backoff (2, 4 … 60 s), and at once when the browser comes online. */
const connectionWaitMs = 2_000;
const connectionWaitMaxMs = 60_000;
const mediaErrNetwork = 2; // MediaError.MEDIA_ERR_NETWORK

/** Descriptor is the server's answer on how to play an episode (PROTOCOL §13). */
export interface Descriptor {
  mode: "direct" | "relay" | "compat" | "unsupported" | "failed";
  url: string | null;
  token: string | null;
  type: string | null;
  profile: string | null;
  offset_ms: number;
  duration_ms: number | null;
  seekable: boolean;
  representation: string | null;
  reason: string | null;
  message: string | null;
  error: { error: string; label: string; message: string; code?: number } | null;
}

export interface MediaStatus {
  state: "streaming" | "complete" | "failed";
  error: { error: string; label: string; message: string } | null;
}

/** Sources are the server calls the element needs (the relay, PROTOCOL §13). */
export interface Sources {
  capabilities(): Promise<string[]>;
  /** profiles names the compatibility path's output formats with their full types (the server's media types). */
  profiles?(): Promise<{ name: string; mime: string }[]>;
  describe(episodeId: string, body: Record<string, unknown>): Promise<Descriptor>;
  /** status answers null when the token is unknown or expired (404). */
  status(url: string): Promise<MediaStatus | null>;
  /** wording is Android's text for an error label (PROTOCOL §13). */
  wording(e: { label: string; message: string }): string;
  /** reachable says whether the app's own server answers at all; without it, this device is taken as connected. */
  reachable?(): Promise<boolean>;
}

/** episodeKey names an episode's source for the element: the server chooses it. */
export function episodeKey(episodeId: string): string {
  return `episode:${episodeId}`;
}

/**
 * DirectFailures are the episodes whose publisher URL failed in this browser
 * (PROTOCOL §13): their descriptors are asked with direct_failed, so the
 * server chooses the relay at once rather than a URL that fails again.
 */
export interface DirectFailures {
  has(episodeId: string): boolean;
  add(episodeId: string): void;
}

export const directFailureMs = 24 * 60 * 60 * 1000;
export const directFailureMax = 200;

/**
 * directFailures keeps them in the browser's storage, per account, for a day
 * and the newest 200: a reload and a server restart (which forgets what it
 * was told) do not make the browser try them again. Without storage they last
 * the page load.
 */
export function directFailures(storage: Pick<Storage, "getItem" | "setItem"> | null, account: string, now: () => number = Date.now): DirectFailures {
  const key = `nottennapod:${account}:direct_failed`;
  const here = new Map<string, number>(); // this page's, whatever the storage does
  const stored = (): Record<string, unknown> => {
    try {
      const v: unknown = JSON.parse(storage?.getItem(key) ?? "{}");
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const live = (at: unknown, t: number): at is number => typeof at === "number" && t - at < directFailureMs && at - t < directFailureMs;
  return {
    has(episodeId) {
      const t = now();
      return live(here.get(episodeId), t) || live(stored()[episodeId], t);
    },
    add(episodeId) {
      const t = now();
      here.set(episodeId, t);
      const kept = Object.entries(stored())
        .filter((e): e is [string, number] => e[0] !== episodeId && live(e[1], t))
        .sort((a, b) => b[1] - a[1])
        .slice(0, directFailureMax - 1);
      try {
        storage?.setItem(key, JSON.stringify(Object.fromEntries([[episodeId, t], ...kept])));
      } catch {
        /* storage full or refused: this page still remembers */
      }
    },
  };
}

export class AudioMedia implements Media {
  readonly el: HTMLAudioElement;
  #key: string | null = null;
  #desc: Descriptor | null = null;
  #offset = 0; // compat: the stream's start on the episode's timeline
  #pendingSeek: number | null = null;
  #target: number | null = null; // the position while a reload is under way
  #loading = false; // a load error is the load's to report
  #reloading = false; // the element's own events during a reload are not the player's
  #recovered = 0; // reloads after errors or unfinished ends, per load
  #held: number | null = null; // where a source a network error broke plays on, while its recovery is pending (#broke)
  #riding: (() => void) | null = null; // wakes the recovery under way; null when none runs
  #owner = 0; // the newest recovery of a broken source: an older one's late answers change nothing
  #shown = false; // the player was told the media waits for the connection
  #epoch = 0; // the source's generation (each load, unload and reload): work begun for an older one changes nothing
  #wantsPlay = false; // the player's intent: play() sets it, pause() clears it; the element's paused state is only transient
  #rate: number; // the player's speed; on the element path a compatibility stream gets it once it plays (#started)
  #caps: Promise<Record<string, string>> | null = null;
  #mimes = new Map<string, string>(); // the output profiles' full types, by name
  #mimesAsked: Promise<void> | null = null;
  #feed: Feed | null = null; // a compatibility stream fed through Media Source Extensions (mse.ts)
  #feedOptions: FeedOptions;
  #sources: Sources | null;
  #failures: DirectFailures | null;
  #l: MediaListener | null = null;
  lastError: string | null = null;

  constructor(rate: number, sources: Sources | null = null, opts: { feed?: FeedOptions; failures?: DirectFailures } = {}) {
    this.#sources = sources;
    this.#rate = rate;
    this.#feedOptions = opts.feed ?? {};
    this.#failures = opts.failures ?? null;
    const el = document.createElement("audio");
    el.preload = "metadata";
    el.hidden = true;
    el.defaultPlaybackRate = rate;
    el.playbackRate = rate;
    el.preservesPitch = true;
    document.body.append(el);
    this.el = el;
    // Metadata that comes later (some browsers load it only on play) moves the
    // element to its pending position; a load or reload moves its own source (#reach).
    el.addEventListener("loadedmetadata", () => {
      if (this.#pendingSeek !== null && !this.#loading && !this.#reloading) this.#movePending();
    });
    // A compatibility stream starts at 1× (#started); once it plays, it plays at the player's speed.
    el.addEventListener("playing", () => {
      if (el.playbackRate !== this.#rate) el.playbackRate = this.#rate;
    });
  }

  get #compat(): boolean {
    return this.#desc?.mode === "compat";
  }

  get position(): number {
    if (this.#held !== null) return this.#held;
    if (this.#target !== null) return this.#target;
    if (this.#pendingSeek !== null) return this.#pendingSeek;
    return this.#offset + Math.round(this.el.currentTime * 1000);
  }

  get duration(): number {
    if (this.#compat) return this.#desc?.duration_ms ?? 0; // the element's is Infinity
    const d = this.el.duration;
    if (Number.isFinite(d) && d > 0) return Math.round(d * 1000);
    return this.#desc?.duration_ms ?? 0;
  }

  get paused(): boolean {
    return this.el.paused;
  }

  get ended(): boolean {
    return this.el.ended;
  }

  get rate(): number {
    return this.#rate;
  }

  set rate(r: number) {
    this.#rate = r;
    this.el.defaultPlaybackRate = r; // a new source starts at the default rate
    // On the element path a compatibility stream that is not playing gets its speed when it plays (#started).
    if (!(this.#compat && !this.#feed && this.el.paused)) this.el.playbackRate = r;
  }

  /** #profiles learns the output profiles' full types once, for the MediaSource's type check. */
  #profiles(): Promise<void> {
    this.#mimesAsked ??= (async () => {
      for (const p of (await this.#sources?.profiles?.()) ?? []) this.#mimes.set(p.name, p.mime);
    })().catch(() => {
      this.#mimesAsked = null;
    });
    return this.#mimesAsked;
  }

  #capabilities(): Promise<Record<string, string>> {
    this.#caps ??= (async () => {
      const out: Record<string, string> = {};
      for (const c of (await this.#sources?.capabilities()) ?? []) out[c] = this.el.canPlayType(c);
      return out;
    })().catch(() => {
      this.#caps = null;
      return {};
    });
    return this.#caps;
  }

  /**
   * prepare asks the server's media types ahead of the first play, so
   * starting an episode never waits for them (the answer is kept for the page load).
   */
  prepare(): void {
    void this.#capabilities();
    void this.#profiles();
  }

  /**
   * #describe asks the server how to play the episode at position; one wait
   * when it is busy. An episode whose publisher URL failed in this browser
   * is asked for with direct_failed.
   */
  async #describe(episodeId: string, position: number, extra: Record<string, unknown> = {}): Promise<Descriptor> {
    const [capabilities] = await Promise.all([this.#capabilities(), this.#profiles()]);
    const remembered = this.#failures?.has(episodeId) ? { direct_failed: true } : {};
    const body = { capabilities, start_ms: Math.max(0, Math.round(position)), ...remembered, ...extra };
    try {
      return await this.#sources!.describe(episodeId, body);
    } catch (e) {
      const retry = (e as { retryAfter?: number; code?: string }).retryAfter;
      if (retry !== undefined && retry <= 10) {
        await new Promise((r) => setTimeout(r, retry * 1000));
        return this.#sources!.describe(episodeId, body);
      }
      throw e;
    }
  }

  /** #use takes a descriptor: the source to set, or the reason it cannot play. */
  #use(d: Descriptor, position: number): string {
    this.#desc = d;
    if (d.mode === "unsupported") throw new Error(d.message ?? "unsupported");
    if (d.mode === "failed") throw new Error(d.error ? this.#sources!.wording(d.error) : "failed");
    if (!d.url) throw new Error("no media address");
    if (d.mode === "compat") {
      this.#offset = d.offset_ms;
      this.#pendingSeek = null;
    } else {
      this.#offset = 0;
      this.#pendingSeek = position;
    }
    return d.url;
  }

  #episodeOf(key: string): string | null {
    return key.startsWith("episode:") ? key.slice("episode:".length) : null;
  }

  /**
   * #setSource sets the source and waits for metadata (or the browser's
   * error). A compatibility stream goes through Media Source Extensions
   * where the browser's MediaSource takes its type (mse.ts), with the
   * duration from the descriptor; otherwise, and for every other source, it
   * is the element's src. The previous source's feed is abandoned.
   */
  #setSource(url: string): Promise<boolean> {
    const el = this.el;
    this.#feed?.close();
    this.#feed = null;
    const d = this.#desc;
    const type = d?.mode === "compat" ? (d.profile ? this.#mimes.get(d.profile) : undefined) ?? d.type ?? "" : "";
    const MS = type ? mediaSourceFor(type) : null;
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        el.removeEventListener("loadedmetadata", onMeta);
        el.removeEventListener("error", onError);
        resolve(ok);
      };
      const onMeta = () => done(true);
      const onError = () => done(false);
      // Some browsers load metadata only on play; the seek then waits for it.
      const timer = setTimeout(() => done(true), metadataWaitMs);
      el.addEventListener("loadedmetadata", onMeta);
      el.addEventListener("error", onError);
      if (MS) {
        const remaining = (d?.duration_ms ?? 0) - this.#offset; // the stream starts at the offset
        this.#feed = new Feed(el, MS, url, this.#offset, type, remaining > 0 ? remaining / 1000 : 0, this.#feedOptions);
        this.#feed.attach();
      } else {
        el.src = url;
        el.load();
      }
    });
  }

  /**
   * load sets the episode's source and waits for its metadata. An episode
   * key asks the server (PROTOCOL §13): a publisher URL that fails is asked again as
   * failed; a relayed file the browser cannot decode goes the compatibility
   * path. A source that cannot play rejects with the words to show.
   */
  async load(key: string, position: number): Promise<void> {
    const el = this.el;
    if (key === this.#key && el.readyState >= HTMLMediaElement.HAVE_METADATA && !el.error) {
      this.seek(position);
      return;
    }
    const mine = this.#begin();
    const current = () => mine === this.#epoch;
    const superseded = () => new Error("superseded");
    this.#wantsPlay = false; // a new source waits for play()
    this.#key = key;
    this.#recovered = 0;
    this.lastError = null;
    this.#loading = true;
    try {
      const episode = this.#episodeOf(key);
      if (!episode || !this.#sources) {
        this.#desc = null;
        this.#offset = 0;
        this.#pendingSeek = position;
        const ok = await this.#setSource(key);
        if (!current()) throw superseded();
        if (!ok) throw new Error("media error");
        if ((await this.#reach(null, false, current)) === "superseded") throw superseded();
        return;
      }
      const d = await this.#describe(episode, position);
      if (!current()) throw superseded();
      let url = this.#use(d, position);
      const ok = await this.#setSource(url);
      if (!current()) throw superseded();
      if (ok) {
        const reached = await this.#reach(episode, false, current);
        if (reached === "superseded") throw superseded();
        if (reached === "failed") throw new Error(this.lastError ?? "media error");
        return;
      }
      if (this.el.error?.code === mediaErrNetwork) {
        // Offline, the publisher is not blamed: the source waits for the connection, and Play plays on once connected.
        const at = await this.#broke(position);
        if (!current()) throw superseded();
        if (at === null) return;
        position = at;
      }
      const retry = this.#desc?.mode === "direct" ? { direct_failed: true } : this.#desc?.mode === "relay" ? { force: "compat" } : null;
      if (!retry) throw new Error(this.lastError ?? "media error");
      if ("direct_failed" in retry) this.#failures?.add(episode);
      const again = await this.#describe(episode, position, retry);
      if (!current()) throw superseded();
      url = this.#use(again, position);
      const retried = await this.#setSource(url);
      if (!current()) throw superseded();
      if (!retried) throw new Error("media error");
      const reached = await this.#reach(episode, "force" in retry, current);
      if (reached === "superseded") throw superseded();
      if (reached === "failed") throw new Error(this.lastError ?? "media error");
    } catch (e) {
      if (current()) {
        this.#key = null;
        this.lastError = e instanceof Error ? e.message : String(e);
      }
      throw e;
    } finally {
      if (current()) this.#loading = false;
    }
  }

  /**
   * #reach moves a source just set to its pending position. The element
   * moves itself only where it can (#elementSeeks); otherwise the
   * compatibility path starts the episode there (PROTOCOL §13), asked for once, so
   * playback never starts at 0:00 while the player shows the position.
   * Metadata not loaded yet leaves the position pending, for the listener.
   */
  async #reach(episode: string | null, compatAsked: boolean, current: () => boolean): Promise<"ok" | "failed" | "superseded"> {
    const at = this.#pendingSeek;
    if (at === null || this.el.readyState < HTMLMediaElement.HAVE_METADATA) return "ok";
    if (!episode || compatAsked || this.#compat || this.#elementSeeks(at) || !this.#reloads()) {
      this.#moveElement(at);
      return "ok";
    }
    const d = await this.#describe(episode, at, { force: "compat" });
    if (!current()) return "superseded";
    const ok = await this.#setSource(this.#use(d, at));
    if (!current()) return "superseded";
    if (!ok) return "failed";
    if (this.#pendingSeek !== null && this.el.readyState >= HTMLMediaElement.HAVE_METADATA) this.#moveElement(this.#pendingSeek);
    return "ok";
  }

  /** #moveElement sets the element's time for a position on the episode's timeline. */
  #moveElement(position: number): void {
    this.#pendingSeek = null;
    this.el.currentTime = Math.max(0, position - this.#offset) / 1000;
  }

  /**
   * #elementSeeks says whether the element can move to the position itself:
   * it reports the target as seekable. A target it already plays at needs no
   * move. For a file served without byte ranges (a relay that is not
   * seekable) the engines differ, and each reports what it can do: Chromium
   * reports it seekable only at 0 (a seek elsewhere starts it again from 0),
   * Firefox only what it has buffered (a seek beyond stops at the buffer's
   * end), and WebKit all of it (it reads the one response to the target).
   */
  #elementSeeks(position: number): boolean {
    const t = Math.max(0, position - this.#offset) / 1000;
    if (Math.abs(this.el.currentTime - t) < 0.01) return true;
    return within(this.el.seekable, t);
  }

  /** #reloads says whether a position the element cannot reach can be played by reloading: the server describes the episode. */
  #reloads(): boolean {
    const mode = this.#desc?.mode;
    return !!this.#sources && !!this.#key && this.#episodeOf(this.#key) !== null && (mode === "direct" || mode === "relay" || mode === "compat");
  }

  /** #movePending moves the element to its pending position outside a load: itself, or by reloading where it cannot. */
  #movePending(): void {
    const at = this.#pendingSeek;
    if (at === null) return;
    if (this.#elementSeeks(at) || !this.#reloads()) {
      this.#moveElement(at);
      return;
    }
    this.#pendingSeek = null; // the reload's target shows meanwhile
    void this.#reload(at, this.#compat ? null : { force: "compat" }).then((ok) => ok || this.#failed());
  }

  /** #begin starts a new generation of the source: what an older one still awaits (a status, a descriptor, metadata) is dropped. */
  #begin(): number {
    this.#held = null;
    this.#riding?.();
    this.#showWait(false);
    this.#loading = false;
    this.#reloading = false;
    this.#target = null;
    return ++this.#epoch;
  }

  /**
   * #reload plays on from position after a seek the source cannot do, an
   * error, or an unfinished end: the same compatibility stream from that
   * time, or a new descriptor. The element's events meanwhile are not the
   * player's. It plays the new stream if the player wants playback when the
   * stream is ready (the element is paused by then, at an end or by the
   * reload itself, so it cannot tell). Each reload is a new generation:
   * only the latest sets the source, the target and the end of reloading,
   * so an earlier seek answered last never wins.
   */
  async #reload(position: number, extra: Record<string, unknown> | null): Promise<boolean> {
    const episode = this.#key ? this.#episodeOf(this.#key) : null;
    if (!episode || !this.#desc) return false;
    // A reload a later one (or another source) replaced answers true: it has nothing to report.
    const mine = ++this.#epoch;
    const current = () => mine === this.#epoch;
    this.#reloading = true;
    this.#target = position;
    try {
      let url: string;
      if (extra === null && this.#compat && this.#desc.url) {
        url = `${this.#desc.url}?start_ms=${Math.max(0, Math.round(position))}`;
        this.#offset = Math.max(0, Math.round(position));
      } else {
        const d = await this.#describe(episode, position, extra ?? {});
        if (!current()) return true;
        url = this.#use(d, position);
      }
      const ok = await this.#setSource(url);
      if (!current()) return true;
      if (!ok) return false;
      const reached = await this.#reach(episode, extra?.force === "compat", current);
      if (reached === "superseded") return true;
      if (reached === "failed") return false;
      // It plays on only if nothing paused it meanwhile: Pause wins over a pending reload.
      if (this.#wantsPlay) {
        try {
          await this.#started();
        } catch (e) {
          if (current() && this.#wantsPlay) throw e;
          return true; // Pause cancelled the start: nothing failed
        }
        if (current() && !this.#wantsPlay) this.el.pause();
      }
      return true;
    } catch (e) {
      if (!current()) return true;
      this.lastError = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      if (current()) {
        this.#target = null;
        this.#reloading = false;
      }
    }
  }

  async play(): Promise<void> {
    this.#wantsPlay = true;
    // A reload under way starts its stream when it is ready, or reports that it cannot.
    if (this.#reloading) return;
    // A source a dropped connection broke plays on once connected: a wait under way asks at once.
    if (this.#held !== null) {
      if (this.#riding) this.#riding();
      else void this.#rideOut(this.#own(this.#held), 0);
      return;
    }
    try {
      await this.#started();
    } catch (e) {
      this.el.pause();
      if (!this.#wantsPlay) return; // Pause cancelled the start: not a failure
      this.#wantsPlay = false;
      throw e;
    }
    if (!this.#wantsPlay) this.el.pause(); // Pause came while it started
  }

  /**
   * #started starts the element, or rejects when it has not started within
   * playWaitMs. On the element path (a browser whose MediaSource does not
   * take the stream), a compatibility stream starts at 1x and the "playing"
   * listener gives it the player's speed: a stream of unknown length may not
   * start at all at another speed. Fed through a MediaSource, it starts at
   * its speed.
   */
  async #started(): Promise<void> {
    if (this.#compat && !this.#feed && this.el.paused) this.el.playbackRate = 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.el.play(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("playback did not start")), playWaitMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  pause(): void {
    this.#wantsPlay = false;
    this.#riding?.();
    this.el.pause();
  }

  /**
   * seek moves the position. A compatibility stream starts again at the
   * target. A target the element does not report as seekable (a relay
   * without byte ranges, beyond what the engine can reach) asks for the
   * compatibility path there (PROTOCOL §13). Any other seek moves the element at
   * once, and is the newest: what an earlier seek or an end still awaits
   * from the server is dropped, and the player's intent stands.
   */
  seek(position: number): void {
    const p = Math.max(0, Math.round(position));
    if (this.#held !== null) {
      this.#held = p; // a source the dropped connection broke plays on there once connected
      return;
    }
    if (this.#compat) {
      void this.#reload(p, null).then((ok) => ok || this.#failed());
      return;
    }
    if (!this.#loading && this.el.readyState >= HTMLMediaElement.HAVE_METADATA && !this.#elementSeeks(p) && this.#reloads()) {
      void this.#reload(p, { force: "compat" }).then((ok) => ok || this.#failed());
      return;
    }
    const mine = this.#loading ? this.#epoch : this.#supersede();
    // Paused while the player wants playback: an end not reported yet, or a dropped reload's stream.
    const resume = this.#wantsPlay && this.el.paused;
    if (this.el.readyState >= HTMLMediaElement.HAVE_METADATA) {
      this.#pendingSeek = null;
      this.el.currentTime = p / 1000;
    } else this.#pendingSeek = p;
    if (resume) {
      this.#started().catch((e: unknown) => {
        if (mine !== this.#epoch || !this.#wantsPlay) return; // a later seek or Pause decides
        this.lastError = e instanceof Error ? e.message : String(e);
        this.#failed();
      });
    }
  }

  /** #supersede begins a new generation for a seek the element makes itself: pending reloads and status checks are dropped. */
  #supersede(): number {
    this.#reloading = false;
    this.#target = null;
    return ++this.#epoch;
  }

  unload(): void {
    this.#begin();
    this.#feed?.close();
    this.#feed = null;
    this.#wantsPlay = false;
    this.#key = null;
    this.#desc = null;
    this.#offset = 0;
    this.#pendingSeek = null;
    this.el.removeAttribute("src");
    this.el.load();
  }

  #failed(): void {
    this.#wantsPlay = false;
    if (!this.el.paused) this.el.pause();
    this.#l?.error();
  }

  /**
   * #ended decides what an end of a relayed or converted stream is: only a
   * complete one ends the episode; an unfinished one reloads at the position
   * once; a changed file plays on from a new descriptor (PROTOCOL §13).
   */
  async #ended(): Promise<void> {
    const d = this.#desc;
    if (!d || d.mode === "direct" || !this.#sources || !d.url) {
      this.#l?.ended();
      return;
    }
    const mine = this.#epoch;
    let position = this.position;
    const st = await this.#sources.status(d.url).catch(() => undefined);
    // Another source, or a seek's stream, replaced the one that ended: its end is not the new one's.
    if (mine !== this.#epoch) return;
    if (st?.state === "complete") {
      this.#l?.ended();
      return;
    }
    if (st?.state === "failed" && st.error && st.error.error !== "media_changed") {
      this.lastError = this.#sources.wording(st.error);
      this.#l?.error();
      return;
    }
    if (st?.state === "failed" || st === null) {
      // A changed file, or an expired token: a new descriptor at the position.
      if (!(await this.#reload(position, {}))) this.#failed();
      return;
    }
    if (st === undefined) {
      // The server could not be asked: offline, the drop is waited out.
      const at = await this.#broke(position);
      if (at === null) return;
      position = at;
    }
    if (this.#recovered++ > 0 || !(await this.#reload(position, null))) this.#failed();
  }

  /**
   * #errored handles an error while playing: one recovery, then the player
   * is told. A network error while this device is offline is waited out
   * instead (#rideOut): it uses up no recovery, and the publisher is not
   * blamed for it. Only a publisher that fails while the app's own server
   * answers is remembered as direct-failed.
   */
  async #errored(): Promise<void> {
    const d = this.#desc;
    if (!d || !this.#sources) {
      this.#l?.error();
      return;
    }
    const mine = this.#epoch;
    let position = this.position;
    if (this.el.error?.code === mediaErrNetwork) {
      const at = await this.#broke(position);
      if (at === null) return;
      position = at;
    }
    if (d.url && d.mode !== "direct") {
      const st = await this.#sources.status(d.url).catch(() => undefined);
      if (mine !== this.#epoch) return; // another source, or a seek's stream, replaced the one that failed
      if (st?.state === "failed" && st.error && st.error.error !== "media_changed") this.lastError = this.#sources.wording(st.error);
    }
    if (this.#recovered++ > 0) {
      this.#failed();
      return;
    }
    const retry = d.mode === "direct" ? { direct_failed: true } : d.mode === "relay" ? { force: "compat" } : {};
    const episode = this.#key ? this.#episodeOf(this.#key) : null;
    if (d.mode === "direct" && episode) this.#failures?.add(episode);
    if (!(await this.#reload(position, retry))) this.#failed();
  }

  /** #offline says whether this device is offline: the browser says so, or the app's own server does not answer either. */
  async #offline(): Promise<boolean> {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
    return this.#sources?.reachable ? !(await this.#sources.reachable()) : false;
  }

  /** #own makes a recovery of the source broken at position the newest: it holds the position (a seek moves it) until it plays on. */
  #own(position: number): number {
    this.#held = position;
    this.#pendingSeek = null;
    this.#riding = () => {};
    return ++this.#owner;
  }

  /**
   * #owns says whether a recovery still owns the media: the newest, its
   * position still held. Only another source or an unload lets the position
   * go before the recovery ends (a seek moves it), so a reload of its own
   * never ends it.
   */
  #owns(id: number): boolean {
    return id === this.#owner && this.#held !== null;
  }

  #showWait(on: boolean): void {
    if (this.#shown === on) return;
    this.#shown = on;
    this.#l?.waiting?.(on);
  }

  /**
   * #broke takes on a source a network error broke at position: its recovery
   * is pending from before the connection check, so a seek meanwhile moves
   * where it plays on. Offline, the drop is waited out (#rideOut) and the
   * answer is null; connected, the answer is the position, to recover as a
   * real failure. Null too when another source or a newer recovery took
   * over meanwhile, and when Pause came during a playing recovery: the
   * position stays held for Play, and nothing is blamed. A recovery that
   * began paused (a load) still classifies its failure.
   */
  async #broke(position: number): Promise<number | null> {
    const playing = this.#wantsPlay;
    const id = this.#own(position);
    const offline = await this.#offline();
    if (!this.#owns(id)) return null;
    if (offline || (playing && !this.#wantsPlay)) {
      void this.#rideOut(id);
      return null;
    }
    const at = this.#held!;
    this.#held = null;
    this.#riding = null;
    return at;
  }

  /**
   * #rideOut waits for this device's connection while the player wants
   * playback, and shows the wait. It asks again with the views' backoff and
   * at once when the browser comes online; once connected it reloads at the
   * held position from a new descriptor, again while a seek meanwhile moved
   * it, and lets the position go only once a reload at it is in place. A
   * reload that fails offline waits again; one that fails while connected is
   * a real failure, reported as before. Pause ends the wait (Play waits
   * again), after any of its steps; another source, an unload or a newer
   * recovery takes it over: what it learns later changes nothing, and only
   * the recovery that owns the wait ends it.
   */
  async #rideOut(id: number, delay = connectionWaitMs): Promise<void> {
    const owns = () => this.#owns(id) && this.#wantsPlay;
    let wake = () => {};
    this.#riding = () => wake();
    const online = () => wake();
    globalThis.addEventListener?.("online", online);
    try {
      for (;;) {
        if (!owns()) return;
        this.#showWait(true);
        if (delay > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delay);
            wake = () => (clearTimeout(timer), resolve());
          });
          wake = () => {};
          if (!owns()) return;
        }
        delay = Math.min(connectionWaitMaxMs, Math.max(connectionWaitMs, delay * 2));
        const offline = await this.#offline();
        if (!owns()) return;
        if (offline) continue;
        const at = this.#held!;
        const ok = await this.#reload(at, {});
        if (!this.#owns(id)) return;
        if (ok) {
          if (this.#held === at) {
            this.#held = null; // in place at its target (playing, unless Pause came)
            return;
          }
          delay = 0; // a seek moved the target meanwhile: reload there
          continue;
        }
        // The reload failed: a drop during it waits again, a real failure ends as before.
        const dropped = await this.#offline();
        if (!owns()) return;
        if (!dropped) {
          this.#held = null;
          this.#failed();
          return;
        }
        this.lastError = null; // a dropped connection is no failure to report
        delay = connectionWaitMs;
      }
    } finally {
      globalThis.removeEventListener?.("online", online);
      if (this.#owner === id) {
        this.#riding = null;
        this.#showWait(false);
      }
    }
  }

  listen(l: MediaListener): void {
    this.#l = l;
    // While a dropped connection holds the source (#held), the broken element's own events are not the player's.
    this.el.addEventListener("pause", () => {
      if (!this.#reloading && this.#held === null) l.paused();
    });
    this.el.addEventListener("ended", () => {
      if (!this.#reloading && this.#held === null) void this.#ended();
    });
    this.el.addEventListener("timeupdate", () => l.time());
    this.el.addEventListener("error", () => {
      if (this.el.error && this.#key && !this.#loading && !this.#reloading && this.#held === null) void this.#errored();
    });
  }
}

/** within says whether a time in seconds lies in one of the ranges (to a hundredth of a second). */
function within(ranges: TimeRanges, t: number): boolean {
  for (let i = 0; i < ranges.length; i++) if (t >= ranges.start(i) - 0.01 && t <= ranges.end(i) + 0.01) return true;
  return false;
}

/** Handlers are the player's actions for the system's media controls. */
export interface Handlers {
  play(): void;
  pause(): void;
  rewind(): void;
  fastForward(): void;
  skip(): void;
  seek(ms: number): void;
}

/** artworkOf is the episode's image for the system's controls: a well-formed HTTPS URL, or none. */
function artworkOf(image: string): MediaImage[] {
  try {
    return new URL(image).protocol === "https:" ? [{ src: image }] : [];
  } catch {
    return [];
  }
}

/** mediaSession shows the episode in the system's media controls, where the browser has them. */
export function mediaSession(h: Handlers): { show(e: EpisodeInfo | null, playing: boolean): void; position(p: number, d: number, rate: number): void } {
  const ms = typeof navigator !== "undefined" && "mediaSession" in navigator ? navigator.mediaSession : undefined;
  const set = (action: MediaSessionAction, fn: MediaSessionActionHandler) => {
    try {
      ms?.setActionHandler(action, fn);
    } catch {
      /* this browser does not have the action */
    }
  };
  set("play", () => h.play());
  set("pause", () => h.pause());
  set("seekbackward", () => h.rewind());
  set("seekforward", () => h.fastForward());
  set("nexttrack", () => h.skip());
  set("seekto", (d) => {
    if (typeof d.seekTime === "number") h.seek(d.seekTime * 1000);
  });
  let shown: string | null = null;
  return {
    show(e, playing) {
      if (!ms) return;
      // The system's controls are a convenience: nothing here may stop the player.
      try {
        const key = e ? `${e.episode_id}` : null;
        if (key !== shown) {
          ms.metadata = e ? new MediaMetadata({ title: e.title, artist: e.podcast, artwork: artworkOf(e.image) }) : null;
          shown = key;
        }
        ms.playbackState = e ? (playing ? "playing" : "paused") : "none";
      } catch {
        /* a value this browser refuses */
      }
    },
    position(p, d, rate) {
      if (!ms?.setPositionState || !(d > 0)) return;
      try {
        ms.setPositionState({ duration: d / 1000, position: Math.min(p, d) / 1000, playbackRate: rate });
      } catch {
        /* an inconsistent moment while seeking */
      }
    },
  };
}
