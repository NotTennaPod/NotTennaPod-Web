// Converted streams through Media Source Extensions (PROTOCOL §13). The server's
// compatibility path streams a conversion of unknown length. WebKit treats such
// a response as live while it is open: it plays it at 1x whatever its speed,
// reads only a little ahead, and never ends it. Fed through a MediaSource whose
// duration is known, the element plays it at its speed and ends it, in WebKit as
// in Chromium. Firefox's MediaSource does not take the server's stream, and
// Firefox plays it as it is.

export interface MediaSourceCtor {
  new (): MediaSource;
  isTypeSupported(type: string): boolean;
}

/**
 * mediaSourceFor is the MediaSource that takes a stream of the type: plain
 * MediaSource where the browser has it (desktop Safari, Chromium), else
 * ManagedMediaSource (iOS Safari, where the element then cannot play to
 * AirPlay while the feed is its source); none when it does not accept the type.
 */
export function mediaSourceFor(type: string): MediaSourceCtor | null {
  const g = globalThis as { MediaSource?: MediaSourceCtor; ManagedMediaSource?: MediaSourceCtor };
  const MS = g.MediaSource ?? g.ManagedMediaSource;
  try {
    return MS && MS.isTypeSupported(type) ? MS : null;
  } catch {
    return null;
  }
}

export interface FeedOptions {
  /** aheadS is how far beyond the playing position the feed holds, in seconds. */
  aheadS?: number;
  /** resumeS is how far ahead the feed lets playback come before it continues a stopped transfer (default aheadS / 2). */
  resumeS?: number;
  /** behindS is how much already played the feed keeps, in seconds. */
  behindS?: number;
  /** firstByteMs bounds the wait for a transfer's first bytes; stallMs a silence once bytes flow. */
  firstByteMs?: number;
  stallMs?: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/** Ten minutes ahead: about 10 MB at the conversion's 128 kbit/s. One minute behind, for a short rewind. */
const defaultAheadS = 600;
const defaultBehindS = 60;
/**
 * A conversion that starts far into a file the relay cannot read in ranges
 * first reads up to its start, so its first bytes may be slow (the server
 * itself waits 60 s for a silent publisher); once bytes flow, 30 s of silence
 * is a stalled stream.
 */
const defaultFirstByteMs = 60_000;
const defaultStallMs = 30_000;

/**
 * Feed plays one converted stream in an element through a MediaSource, from
 * startMs on the episode's timeline. It holds at most aheadS beyond the
 * playing position and keeps behindS behind it, so a long episode never sits
 * in memory whole. For ADTS AAC (what the server sends) the bound is the
 * transfer's too: when the window is full the transfer stops, and once
 * playback has used it down to resumeS the feed asks the server to continue
 * the conversion where the appended content ends, dropping the
 * continuation's encoder priming frame, so the join is seamless and nothing
 * is fetched during a long pause. A clean end of the stream ends the
 * MediaSource and the element ends where it does; a refused, failed or
 * stalled transfer ends it with a network error, which the element reports
 * as its error (the player then reloads at its position). close() abandons
 * it: the transfer is aborted, nothing more is appended, and the element's
 * remote playback is as it was.
 */
export class Feed {
  readonly #el: HTMLMediaElement;
  readonly #ms: MediaSource;
  readonly #url: string;
  readonly #startMs: number;
  readonly #type: string;
  readonly #durationS: number;
  readonly #aheadS: number;
  readonly #resumeS: number;
  readonly #behindS: number;
  readonly #firstByteMs: number;
  readonly #stallMs: number;
  readonly #fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly #ac = new AbortController();
  #objectURL = "";
  #remote: boolean | null = null; // the element's remote playback before a ManagedMediaSource feed turned it off
  /** transfers counts the stream's requests: the first, then each continuation. */
  transfers = 0;

  constructor(el: HTMLMediaElement, MS: MediaSourceCtor, url: string, startMs: number, type: string, durationS: number, opts: FeedOptions = {}) {
    this.#el = el;
    this.#ms = new MS();
    this.#url = url;
    this.#startMs = startMs;
    this.#type = type;
    this.#durationS = durationS;
    this.#aheadS = opts.aheadS ?? defaultAheadS;
    this.#resumeS = opts.resumeS ?? this.#aheadS / 2;
    this.#behindS = opts.behindS ?? defaultBehindS;
    this.#firstByteMs = opts.firstByteMs ?? defaultFirstByteMs;
    this.#stallMs = opts.stallMs ?? defaultStallMs;
    this.#fetch = opts.fetch ?? ((u, init) => fetch(u, init));
  }

  /** attach makes the feed the element's source; the element then loads as from any source. */
  attach(): void {
    // ManagedMediaSource plays only with remote playback off (or an AirPlay source the server does not have).
    if ("ManagedMediaSource" in globalThis && !("MediaSource" in globalThis)) {
      this.#remote = this.#el.disableRemotePlayback;
      this.#el.disableRemotePlayback = true;
    }
    this.#ms.addEventListener("sourceopen", () => void this.#pump(), { once: true });
    this.#objectURL = URL.createObjectURL(this.#ms);
    this.#el.src = this.#objectURL;
  }

  /** close abandons the stream: its transfer is aborted, nothing more is appended, and remote playback is restored. */
  close(): void {
    this.#ac.abort();
    if (this.#objectURL) URL.revokeObjectURL(this.#objectURL);
    if (this.#remote !== null) this.#el.disableRemotePlayback = this.#remote;
    this.#remote = null;
  }

  get #closed(): boolean {
    return this.#ac.signal.aborted;
  }

  async #pump(): Promise<void> {
    const ms = this.#ms;
    try {
      if (this.#durationS > 0) ms.duration = this.#durationS; // known before the stream ends: not live
      const sb = ms.addSourceBuffer(this.#type);
      const frames = isAdts(this.#type) ? new Adts() : null;
      // contentS is the stream's content appended, from startMs (a first stream's priming frame not counted).
      let contentS = 0;
      for (let first = true; ; first = false) {
        const from = this.#startMs + Math.round(contentS * 1000);
        const url = first ? this.#url : withStart(this.#url, from);
        const outcome = await this.#transfer(sb, url, frames, !first, (s) => (contentS += s));
        if (this.#closed) return;
        if (outcome === "ended") break;
        // The window is full and its transfer stopped: continue once playback has used it.
        while (!this.#closed && end(sb.buffered) - this.#el.currentTime > this.#resumeS) await this.#nap();
        if (this.#closed) return;
      }
      await idle(sb);
      if (!this.#closed && ms.readyState === "open") ms.endOfStream();
    } catch {
      if (this.#closed) return; // replaced or abandoned: nothing to report
      try {
        if (ms.readyState === "open") ms.endOfStream("network");
      } catch {
        /* the element has let the source go */
      }
    }
  }

  /**
   * #transfer fetches one stream and appends it. With ADTS framing it appends
   * whole frames only, counts their content (onContent), drops a
   * continuation's priming frame, and stops the transfer when the window is
   * full ("full"); otherwise it holds back reading while the window is full.
   * "ended" is the stream's end.
   */
  async #transfer(sb: SourceBuffer, url: string, frames: Adts | null, continuation: boolean, onContent: (s: number) => void): Promise<"ended" | "full"> {
    this.transfers++;
    const ac = new AbortController();
    const abort = () => ac.abort();
    this.#ac.signal.addEventListener("abort", abort, { once: true });
    try {
      const res = await this.#within(this.#fetch(url, { signal: ac.signal, credentials: "same-origin", cache: "no-store" }), this.#firstByteMs, ac);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      // Stopping the transfer (close, a stall, a full window) also ends a read under way.
      ac.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
      frames?.reset(continuation);
      let flowing = false;
      for (;;) {
        if (this.#closed) return "ended";
        if (frames) {
          if (end(sb.buffered) - this.#el.currentTime > this.#aheadS) {
            ac.abort(); // the window is full: stop the transfer, nothing more is fetched now
            return "full";
          }
        } else {
          while (!this.#closed && end(sb.buffered) - this.#el.currentTime > this.#aheadS) await this.#nap();
        }
        const { value, done } = await this.#within(reader.read(), flowing ? this.#stallMs : this.#firstByteMs, ac);
        if (done) {
          if (ac.signal.aborted && !this.#closed) throw new Error("the stream stalled"); // ended by its stop, not by the server
          return "ended";
        }
        flowing = true;
        let chunk: Uint8Array = value;
        if (frames) {
          const whole = frames.push(value);
          chunk = whole.bytes;
          // A first stream's priming frame is played (as the element path plays it) but is not content.
          onContent(whole.seconds - whole.firstSeconds);
          if (chunk.length === 0) continue;
        }
        await this.#append(sb, chunk);
        await this.#evictBehind(sb);
      }
    } finally {
      this.#ac.signal.removeEventListener("abort", abort);
      ac.abort();
    }
  }

  /** #within waits for a step of the transfer at most ms; a step that takes longer stops the transfer as stalled. */
  #within<T>(step: Promise<T>, ms: number, ac: AbortController): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      step,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("the stream stalled")); // first: aborting ends the read, which must not win the race
          ac.abort();
        }, ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /** #append appends a chunk; a full buffer drops what is behind and waits for playback to make room. */
  async #append(sb: SourceBuffer, chunk: Uint8Array): Promise<void> {
    for (;;) {
      await idle(sb);
      if (this.#closed) return;
      try {
        sb.appendBuffer(chunk as BufferSource);
      } catch (e) {
        if ((e as { name?: string }).name !== "QuotaExceededError") throw e;
        if (!(await this.#evictBehind(sb, 1))) await this.#nap(); // nothing to drop yet: wait for playback
        continue;
      }
      await updated(sb);
      return;
    }
  }

  /** #evictBehind removes what lies more than keepS behind the playing position; it says whether it removed anything. */
  async #evictBehind(sb: SourceBuffer, keepS = this.#behindS): Promise<boolean> {
    const b = sb.buffered;
    const cut = this.#el.currentTime - keepS;
    if (this.#closed || b.length === 0 || b.start(0) >= cut - 1) return false;
    await idle(sb);
    sb.remove(b.start(0), cut);
    await updated(sb);
    return true;
  }

  /** #nap waits for the playing position to move (timeupdate), at most a second, or for close(). */
  #nap(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#el.removeEventListener("timeupdate", done);
        this.#ac.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, 1000);
      this.#el.addEventListener("timeupdate", done);
      this.#ac.signal.addEventListener("abort", done);
    });
  }
}

/** isAdts says whether a type is ADTS AAC, the framing the feed can stop and continue at a frame. */
export function isAdts(type: string): boolean {
  return /^audio\/aac\b/i.test(type.trim());
}

/** withStart is a converted stream's address starting at ms on the episode's timeline. */
function withStart(url: string, ms: number): string {
  const u = new URL(url, "http://x");
  u.searchParams.set("start_ms", String(Math.max(0, Math.round(ms))));
  return url.startsWith("http") ? u.href : u.pathname + u.search;
}

const sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/**
 * Adts splits a byte stream into whole ADTS frames (ISO 14496-3 1.A.2): each
 * push returns the complete frames received so far and their duration, and
 * keeps a partial frame for the next. With drop set (a continuation), the
 * stream's first frame, the encoder's priming, is left out.
 */
export class Adts {
  #rest = new Uint8Array(0);
  #drop = false;
  #first = true;

  /** reset starts a stream: drop leaves out its first frame (a continuation's priming). */
  reset(drop: boolean): void {
    this.#rest = new Uint8Array(0);
    this.#drop = drop;
    this.#first = true;
  }

  /** push returns the whole frames, their duration in seconds, and the duration of the stream's first frame if it is among them. */
  push(chunk: Uint8Array): { bytes: Uint8Array; seconds: number; firstSeconds: number } {
    const data = new Uint8Array(this.#rest.length + chunk.length);
    data.set(this.#rest);
    data.set(chunk, this.#rest.length);
    let at = 0;
    let keepFrom = 0;
    let seconds = 0;
    let firstSeconds = 0;
    const parts: Uint8Array[] = [];
    while (at + 7 <= data.length) {
      if (data[at] !== 0xff || (data[at + 1]! & 0xf0) !== 0xf0) throw new Error("the stream is not ADTS");
      const length = ((data[at + 3]! & 0x03) << 11) | (data[at + 4]! << 3) | (data[at + 5]! >> 5);
      const rate = sampleRates[(data[at + 2]! >> 2) & 0x0f];
      if (length < 7 || !rate) throw new Error("the stream is not ADTS");
      if (at + length > data.length) break;
      const frameSeconds = (1024 * ((data[at + 6]! & 0x03) + 1)) / rate;
      if (this.#drop) {
        this.#drop = false; // the continuation's priming: not appended, not counted
      } else {
        parts.push(data.subarray(at, at + length));
        seconds += frameSeconds;
        if (this.#first) firstSeconds = frameSeconds;
      }
      this.#first = false;
      at += length;
      keepFrom = at;
    }
    this.#rest = data.slice(keepFrom);
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      bytes.set(p, o);
      o += p.length;
    }
    return { bytes, seconds, firstSeconds };
  }
}

/** end is where the buffered data ends, in seconds (0 with none). */
function end(b: TimeRanges): number {
  return b.length ? b.end(b.length - 1) : 0;
}

/** idle waits until the source buffer has finished its update. */
async function idle(sb: SourceBuffer): Promise<void> {
  while (sb.updating) await updated(sb);
}

/** updated resolves when the source buffer's current update ends, and rejects when it fails. */
function updated(sb: SourceBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = () => {
      off();
      resolve();
    };
    const failed = () => {
      off();
      reject(new Error("the stream could not be appended"));
    };
    const off = () => {
      sb.removeEventListener("updateend", ok);
      sb.removeEventListener("error", failed);
      sb.removeEventListener("abort", failed);
    };
    sb.addEventListener("updateend", ok);
    sb.addEventListener("error", failed);
    sb.addEventListener("abort", failed);
  });
}
