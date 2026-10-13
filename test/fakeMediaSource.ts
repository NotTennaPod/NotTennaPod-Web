// A MediaSource, its SourceBuffer and object URLs as far as the player's feed
// (src/player/mse.ts) uses them. An ADTS SourceBuffer measures what it holds
// by its frames (1024 samples each) and refuses a partial frame; any other
// type counts each byte as a second. Installed on globalThis by install().

export class Ranges {
  readonly spans: [number, number][];
  constructor(spans: [number, number][]) {
    this.spans = spans;
  }
  get length() {
    return this.spans.length;
  }
  start(i: number) {
    return this.spans[i]![0];
  }
  end(i: number) {
    return this.spans[i]![1];
  }
}

const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** adtsSeconds is the duration of whole ADTS frames; it throws on a partial or broken frame. */
export function adtsSeconds(chunk: Uint8Array): number {
  let at = 0;
  let s = 0;
  while (at < chunk.length) {
    if (chunk[at] !== 0xff || (chunk[at + 1]! & 0xf0) !== 0xf0) throw new Error(`not an ADTS frame at ${at}`);
    const length = ((chunk[at + 3]! & 3) << 11) | (chunk[at + 4]! << 3) | (chunk[at + 5]! >> 5);
    if (at + length > chunk.length) throw new Error("a partial ADTS frame was appended");
    s += 1024 / rates[(chunk[at + 2]! >> 2) & 0x0f]!;
    at += length;
  }
  return s;
}

/** frameS is one test frame's duration: 1024 samples at 8 kHz. */
export const frameS = 1024 / 8000;

/** adts makes frames ADTS frames at 8 kHz (frameS each), 8 bytes each; tag marks their payload. */
export function adts(frames: number, tag = 0): Uint8Array {
  const out = new Uint8Array(frames * 8);
  for (let i = 0; i < frames; i++) {
    const f = out.subarray(i * 8, i * 8 + 8);
    f.set([0xff, 0xf1, (1 << 6) | (11 << 2), 0x40, 0x01, 0x00, 0xfc, tag]); // length 8 (0x40,0x01,0x00 → 8 << 5)
    f[3] = 0x40;
    f[4] = 8 >> 3;
    f[5] = (8 & 7) << 5;
  }
  return out;
}

export class FakeSourceBuffer extends EventTarget {
  updating = false;
  mode = "sequence";
  from = 0;
  to = 0;
  appended: number[] = []; // each append's length in bytes
  removed: [number, number][] = [];
  /** quota is the most seconds it holds; an append beyond it throws QuotaExceededError. */
  quota = Number.POSITIVE_INFINITY;
  readonly type: string;
  constructor(type: string) {
    super();
    this.type = type;
  }
  get buffered() {
    return new Ranges(this.to > this.from ? [[this.from, this.to]] : []);
  }
  #seconds(chunk: Uint8Array) {
    return this.type === "audio/aac" ? adtsSeconds(chunk) : chunk.length;
  }
  appendBuffer(chunk: Uint8Array) {
    if (this.updating) throw Object.assign(new Error("updating"), { name: "InvalidStateError" });
    const seconds = this.#seconds(chunk);
    if (this.to - this.from + seconds > this.quota + 1e-9) throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
    this.updating = true;
    setTimeout(() => {
      this.appended.push(chunk.length);
      this.to += seconds;
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    });
  }
  remove(start: number, end: number) {
    this.updating = true;
    setTimeout(() => {
      this.removed.push([start, end]);
      this.from = Math.max(this.from, end);
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    });
  }
}

export class FakeMediaSource extends EventTarget {
  static types = new Set(["audio/aac"]);
  static made: FakeMediaSource[] = [];
  static isTypeSupported(type: string) {
    return this.types.has(type);
  }
  readyState: "closed" | "open" | "ended" = "closed";
  duration = Number.NaN;
  buffers: FakeSourceBuffer[] = [];
  ended: (string | undefined)[] = []; // endOfStream calls: undefined for a clean end
  url = "";
  constructor() {
    super();
    FakeMediaSource.made.push(this);
  }
  addSourceBuffer(type: string) {
    const b = new FakeSourceBuffer(type);
    this.buffers.push(b);
    return b;
  }
  endOfStream(error?: string) {
    this.ended.push(error);
    this.readyState = "ended";
  }
  /** open is the element attaching it: sourceopen, as a browser fires it. */
  open() {
    this.readyState = "open";
    setTimeout(() => this.dispatchEvent(new Event("sourceopen")));
  }
}

const objects = new Map<string, unknown>();
let next = 0;

/** sourceAt is the MediaSource an object URL names. */
export function sourceAt(url: string): FakeMediaSource | undefined {
  const o = objects.get(url);
  return o instanceof FakeMediaSource ? o : undefined;
}

/** install puts the fakes on globalThis (MediaSource, ManagedMediaSource or neither) and object URLs; it returns the undo. */
export function install(kind: "MediaSource" | "ManagedMediaSource" | "both" | "none" = "MediaSource"): () => void {
  const g = globalThis as Record<string, unknown>;
  const before = { MediaSource: g.MediaSource, ManagedMediaSource: g.ManagedMediaSource, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  delete g.MediaSource;
  delete g.ManagedMediaSource;
  if (kind === "MediaSource" || kind === "both") g.MediaSource = FakeMediaSource;
  if (kind === "ManagedMediaSource" || kind === "both") g.ManagedMediaSource = FakeMediaSource;
  URL.createObjectURL = ((o: unknown) => {
    const url = `blob:fake/${++next}`;
    objects.set(url, o);
    if (o instanceof FakeMediaSource) o.url = url;
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (url: string) => void objects.delete(url);
  FakeMediaSource.made = [];
  FakeMediaSource.types = new Set(["audio/aac", "audio/mpeg"]);
  return () => {
    for (const k of ["MediaSource", "ManagedMediaSource"] as const) {
      if (before[k] === undefined) delete g[k];
      else g[k] = before[k];
    }
    URL.createObjectURL = before.create;
    URL.revokeObjectURL = before.revoke;
  };
}

/** Request is one fetch of the stream: its address, its signal, and the body the test feeds. */
export interface Request {
  url: string;
  init: RequestInit;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  reads: number;
}

/** Stream answers each fetch with a body the test feeds (push, end, fail), and keeps every request. */
export class Stream {
  requests: Request[] = [];
  status = 200;
  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const r: Request = { url, init, reads: 0 };
    this.requests.push(r);
    if (this.status !== 200) return new Response(null, { status: this.status });
    const body = new ReadableStream<Uint8Array>(
      {
        start: (c) => {
          r.controller = c;
        },
        pull: () => {
          r.reads++;
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: 200 });
  };
  get last(): Request {
    return this.requests.at(-1)!;
  }
  /** push sends bytes on the last request. */
  push(bytes: Uint8Array) {
    try {
      this.last.controller!.enqueue(bytes);
    } catch {
      /* the feed cancelled it */
    }
  }
  end() {
    this.last.controller!.close();
  }
  fail() {
    this.last.controller!.error(new TypeError("network error"));
  }
  get aborted() {
    return this.last.init.signal?.aborted ?? false;
  }
}

/** settled lets every pending timer, promise continuation and event run. */
export const settled = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};
