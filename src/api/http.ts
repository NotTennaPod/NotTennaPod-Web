// Requests to NotTennaPod-Server's API from the browser: same-origin JSON
// with the session cookie, every request naming the account the tab shows
// (PROTOCOL §12), errors as PROTOCOL §10.3 bodies.

/** ApiError is a refused or failed request, with its error code (PROTOCOL §10.3). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter: number | undefined;
  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** Unreachable is a request that never got an answer: the server is down or the network is. */
export class Unreachable extends Error {}

/**
 * Unreadable is a success whose body could not be read whole (the connection
 * ended part-way): the server did the request, but what it answered is not
 * known. Only requestStrict throws it.
 */
export class Unreadable extends Error {}

let account: string | undefined;
let generation = 0; // the tab's authentication generation (PROTOCOL §12)
let onAccountChanged: () => void = () => location.reload();
let onSignedOut: () => void = () => {};

/** useAccount fences every later request to the account (a tab shows one account). */
export function useAccount(id: string | undefined): void {
  account = id;
  generation++;
}

/** endGeneration discards every answer still on its way: a sign-in or sign-out happened. */
export function endGeneration(): void {
  generation++;
}

export function currentAccount(): string | undefined {
  return account;
}

/** currentGeneration is the tab's authentication generation: a job bound to one stops when it changes. */
export function currentGeneration(): number {
  return generation;
}

/** handlers sets what happens when the server says another account signed in, or the session ended. */
/** refused reports a session the server refused outside a request (the event stream's `closed`): the same transition as a 401. */
export function refused(): void {
  onSignedOut();
}

export function handlers(h: { accountChanged?: () => void; signedOut?: () => void }): void {
  if (h.accountChanged) onAccountChanged = h.accountChanged;
  if (h.signedOut) onSignedOut = h.signedOut;
}

export type Query = Record<string, string | number | boolean | undefined>;

export function withQuery(path: string, q?: Query): string {
  if (!q) return path;
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `${path}?${s}` : path;
}

/** request sends one API request and returns its JSON body. */
export function request<T = Record<string, unknown>>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return send<T>(method, path, body, signal, false);
}

/**
 * requestStrict is request for answers that must be known exactly (an
 * import's reservation, finish and cancel): a success whose body cannot be read
 * throws Unreadable instead of answering {}.
 */
export function requestStrict<T = Record<string, unknown>>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return send<T>(method, path, body, signal, true);
}

async function send<T>(method: string, path: string, body: unknown, signal: AbortSignal | undefined, strict: boolean, keepalive = false): Promise<T> {
  const started = generation;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (account) headers["X-NotTennaPod-Account"] = account;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      signal,
      keepalive,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Unreachable(String(e));
  }
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch (e) {
    if (signal?.aborted) throw e;
    if (res.status >= 500 || res.status === 0) throw new Unreachable(`HTTP ${res.status}`);
    if (strict && res.ok && generation === started) throw new Unreadable(`HTTP ${res.status}: ${String(e)}`);
  }
  // An answer is used only by the account and sign-in it was asked for (PROTOCOL §12).
  if (generation !== started) throw new DOMException("The account changed.", "AbortError");
  if (!res.ok) {
    const code = typeof data.error === "string" ? data.error : `http_${res.status}`;
    const message = typeof data.message === "string" ? data.message : res.statusText;
    const retry = typeof data.retry_after === "number" ? data.retry_after : undefined;
    if (code === "account_changed") onAccountChanged();
    if (res.status === 401) onSignedOut();
    throw new ApiError(res.status, code, message, retry);
  }
  return data as T;
}

export const get = <T = Record<string, unknown>>(path: string, q?: Query, signal?: AbortSignal) =>
  request<T>("GET", withQuery(path, q), undefined, signal);
export const post = <T = Record<string, unknown>>(path: string, body: unknown = {}) => request<T>("POST", path, body);
/** postKeepalive is a POST that outlives the page (fetch's keepalive), for a page going away: its body must fit the browser's keepalive limit (64 KiB). */
export const postKeepalive = <T = Record<string, unknown>>(path: string, body: unknown) => send<T>("POST", path, body, undefined, false, true);
