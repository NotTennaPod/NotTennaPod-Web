// The web actor's errors and waits (docs/ACTOR-PROTOCOL.md): every failure is an
// ActorError with a stable code, and every wait is for a condition, bounded
// by the command's deadline.

/** ActorError is a structured failure: its code is part of the protocol. */
export class ActorError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Deadline is a command's time limit; every wait inside the command uses what is left of it. */
export class Deadline {
  readonly ms: number;
  readonly end: number;
  constructor(ms: number) {
    this.ms = ms;
    this.end = Date.now() + ms;
  }
  /** left is the time remaining for one Playwright call (at least 1 ms, so the call times out itself). */
  left(): number {
    return Math.max(1, this.end - Date.now());
  }
  get expired(): boolean {
    return Date.now() >= this.end;
  }
}

/**
 * until waits for probe to return a value (anything but undefined, null or
 * false), checking again every 100 ms until the deadline. On timeout the
 * error says what was awaited and, through details, what was seen last.
 */
export async function until<T>(
  d: Deadline,
  waitingFor: string,
  probe: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  details?: () => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<T> {
  for (;;) {
    const v = await probe();
    if (v !== undefined && v !== null && v !== false) return v;
    if (d.expired) {
      throw new ActorError("timeout", `Timed out after ${d.ms} ms waiting for ${waitingFor}.`, { waiting_for: waitingFor, ...(details ? await details() : {}) });
    }
    await new Promise((r) => setTimeout(r, Math.min(100, d.left())));
  }
}

/** within waits for an event's promise until the deadline. */
export async function within<T>(d: Deadline, waitingFor: string, event: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ActorError("timeout", `Timed out after ${d.ms} ms waiting for ${waitingFor}.`, { waiting_for: waitingFor })), d.left());
  });
  try {
    return await Promise.race([event, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * matches says whether a reading matches an expectation: objects match
 * member by member (other members are ignored), arrays element by element
 * with the same length, everything else by equality.
 */
export function matches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matches(actual[i], e));
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([k, e]) => matches((actual as Record<string, unknown>)[k], e));
  }
  return Object.is(actual, expected);
}

/** hms reads Android's HH:MM:SS (Converter.getDurationStringLong) as milliseconds. */
export function hms(text: string | null | undefined): number | null {
  const m = /^(\d+):(\d{2}):(\d{2})$/.exec((text ?? "").trim());
  return m ? (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 : null;
}

/** minutes reads the Statistics screen's "2 hours 5 minutes" or "5 minutes" as milliseconds. */
export function minutes(text: string): number | null {
  const n = [...text.matchAll(/\d+/g)].map((x) => Number(x[0]));
  if (n.length === 2) return (n[0]! * 60 + n[1]!) * 60_000;
  if (n.length === 1) return n[0]! * 60_000;
  return null;
}

/** pathMatcher matches a URL path against a pattern: `*` is one path segment, `**` any run of them. */
export function pathMatcher(pattern: string): (path: string) => boolean {
  if (!pattern.startsWith("/")) throw new ActorError("bad_request", `A path pattern starts with "/": ${pattern}`);
  const re = pattern
    .split("/")
    .map((seg) => (seg === "**" ? ".*" : seg.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")))
    .join("/");
  const rx = new RegExp(`^${re}$`);
  return (path) => rx.test(path);
}
