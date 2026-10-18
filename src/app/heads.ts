// Re-reading a displayed view (PROTOCOL §12): once per newer head the server
// announces that the view does not already show or cover; always after a
// revalidation (a reconnect, focus, online, a recovery, a successor); never
// while the tab is hidden (once when it shows again); a failed re-read is
// retried with backoff until one succeeds. Nothing in flight is aborted: a
// head that arrives meanwhile is read once more after it.

/** HeadLike is a head's lineage and position. */
export interface HeadLike {
  log_id: string;
  epoch: number;
  seq: number;
}

export function sameLineage(a: Pick<HeadLike, "log_id" | "epoch">, b: Pick<HeadLike, "log_id" | "epoch">): boolean {
  return a.log_id === b.log_id && a.epoch === b.epoch;
}

/** newer tells whether a is a head b does not cover: later in b's lineage, or of another lineage (b none: always). */
export function newer(a: HeadLike, b: HeadLike | null | undefined): boolean {
  if (!b) return true;
  return !sameLineage(a, b) || a.seq > b.seq;
}

export interface ReaderDeps {
  /** known is the newest head the tab knows the server has. */
  known(): HeadLike | null;
  /** visible tells whether the view may re-read now (the tab is shown, nothing holds the view). */
  visible(): boolean;
  /** read loads and applies the view: the head it shows now, or null for an answer it did not use (older, or of a lineage left). */
  read(signal: AbortSignal): Promise<HeadLike | null>;
  /** failed reports a failed read; it answers whether to try again later (false: a refusal that will not pass by itself). */
  failed(e: unknown): boolean;
  /** shown, when given, is the head the view shows (moved by more than this reader's reads). */
  shown?(): HeadLike | null;
  /** Timers (tests replace them). */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
}

/**
 * Rereader schedules one view's reads. The first read happens at once,
 * hidden or not; after it, a read is due when a revalidation was asked since
 * the last successful read began, or when the known head is newer than both
 * the head shown and the head known when the last successful read began (the
 * server answered at or after it).
 */
export class Rereader {
  #d: ReaderDeps;
  #shown: HeadLike | null = null;
  #covered: HeadLike | null = null;
  #flight: AbortController | null = null;
  #asked = 0;
  #served = 0;
  #timer: unknown = undefined;
  #backoff = 0;
  #stopped = false;
  /** reads counts the reads begun (for tests and budgets). */
  reads = 0;

  constructor(d: ReaderDeps) {
    this.#d = d;
  }

  get shown(): HeadLike | null {
    return this.#d.shown ? this.#d.shown() : this.#shown;
  }

  /** saw: the view now shows this head (applied by another read of it). */
  saw(h: HeadLike): void {
    if (newer(h, this.#shown)) this.#shown = h;
  }

  /** pending tells whether a read is due (a revalidation, or a newer head) that no successful read has served yet. */
  get pending(): boolean {
    return this.#due();
  }

  start(): void {
    this.#asked++;
    this.#run();
  }

  /** known: the known head moved. */
  known(): void {
    this.#pump();
  }

  /** revalidate: read again, whatever the heads. */
  revalidate(): void {
    this.#asked++;
    this.#pump();
  }

  /** visible: the view may be able to read now. */
  visible(): void {
    this.#pump();
  }

  stop(): void {
    this.#stopped = true;
    this.#flight?.abort();
    this.#flight = null;
    this.#clearTimer();
  }

  #due(): boolean {
    if (this.#asked > this.#served) return true;
    const k = this.#d.known();
    return !!k && newer(k, this.shown) && newer(k, this.#covered);
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    (this.#d.clearTimeout ?? clearTimeout)(this.#timer as ReturnType<typeof setTimeout>);
    this.#timer = undefined;
  }

  #pump(): void {
    if (this.#stopped || this.#flight || !this.#due() || !this.#d.visible()) return;
    // Something new to read: a retry waiting for its backoff goes now.
    this.#clearTimer();
    this.#run();
  }

  #run(): void {
    const target = this.#asked;
    const covers = this.#d.known();
    const ac = new AbortController();
    this.#flight = ac;
    this.reads++;
    let retry = false;
    this.#d
      .read(ac.signal)
      .then(
        (h) => {
          if (this.#stopped || ac.signal.aborted) return;
          if (h && newer(h, this.#shown)) this.#shown = h;
          this.#covered = covers;
          this.#served = Math.max(this.#served, target);
          this.#backoff = 0;
        },
        (e: unknown) => {
          if (this.#stopped || ac.signal.aborted) return;
          if (this.#d.failed(e)) {
            retry = true;
          } else {
            // A final refusal: what was asked is answered (with it).
            this.#served = Math.max(this.#served, target);
            this.#covered = covers;
          }
        },
      )
      .finally(() => {
        if (this.#flight === ac) this.#flight = null;
        if (this.#stopped) return;
        if (retry && this.#due()) {
          this.#backoff = Math.min(60_000, this.#backoff ? this.#backoff * 2 : 2_000);
          this.#timer = (this.#d.setTimeout ?? setTimeout)(() => {
            this.#timer = undefined;
            this.#pump();
          }, this.#backoff);
          return;
        }
        this.#pump();
      });
  }
}
