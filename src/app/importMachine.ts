// The library import's job (PROTOCOL §11.5) as a pure state machine: what the
// tab does after each answer of the server, which is authoritative. Every step
// is repeatable or reconciled by the import's ID and fingerprint, so a lost
// answer is never reported as a failure and nothing is resent blindly.
// importJob.ts runs the requests; this file decides.
import { ApiError, Unreachable, Unreadable } from "../api/http.ts";

/** chunkSize is the web client's chunking: chunk n is bytes [n·3 MiB, (n+1)·3 MiB) of the file. */
export const chunkSize = 3 << 20;
/** maxFile is the server's limit for an imported file (importer.MaxFile). */
export const maxFile = 2 * 2 ** 30;

export type Status = "uploading" | "processing" | "published" | "failed";

/** ImportRow is an import as the server answers it. */
export interface ImportRow {
  import_id: string;
  kind: string;
  fingerprint: string;
  size: number;
  file_name: string;
  status: Status;
  reason?: string;
  result?: unknown;
}

export interface Phase {
  phase: "reading" | "importing" | "finishing";
  done: number;
  total: number;
}

export interface RefreshProgress {
  status: "running" | "done" | "expired" | "unavailable";
  total?: number;
  attempted?: number;
  succeeded?: number;
  failed?: number;
  until: number;
}

/** Progress is GET /v1/import/{id}/progress's answer. */
export interface Progress extends ImportRow {
  received?: { chunks: [number, number][]; bytes: number };
  processing?: Phase | null;
  refresh?: RefreshProgress;
}

const statuses = new Set(["uploading", "processing", "published", "failed"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

/** entries: a report's list of skipped, merged or ambiguous items (null when empty). */
function entries(v: unknown): boolean {
  return v === null || v === undefined || (Array.isArray(v) && v.every((e) => isObject(e) && typeof e.title === "string"));
}

/** notCarried: what a backup held that stays on each device (absent from an older server's report). */
function notCarried(v: unknown): boolean {
  return v === undefined || (isObject(v) && count(v.episode_auto_download_off) && Array.isArray(v.podcasts) &&
    v.podcasts.every((p) => isObject(p) && typeof p.title === "string" && (p.url === undefined || typeof p.url === "string") &&
      Array.isArray(p.settings) && p.settings.every((s) => typeof s === "string")));
}

/** report: an import's result, as ImportReport shows it. */
function report(v: unknown): boolean {
  if (!isObject(v) || !isObject(v.imported)) return false;
  const i = v.imported;
  return [i.podcasts, i.episodes, i.queue, i.favorites, i.history, i.inbox].every(count) && entries(v.skipped) && entries(v.merged) &&
    entries(v.ambiguous) && notCarried(v.not_carried);
}

/**
 * parseImport is a success body as an import, or undefined when it is not one
 * (a cut-off or malformed answer): its fields, and its report when it has one.
 */
export function parseImport(v: unknown): ImportRow | undefined {
  if (!isObject(v)) return undefined;
  const { import_id, kind, fingerprint, size, file_name, status, reason, result } = v;
  if (typeof import_id !== "string" || !import_id || typeof kind !== "string" || typeof fingerprint !== "string" || !count(size) ||
    typeof file_name !== "string" || typeof status !== "string" || !statuses.has(status) || (reason !== undefined && typeof reason !== "string") ||
    (result !== undefined && !report(result))) {
    return undefined;
  }
  return v as unknown as ImportRow;
}

const phases = new Set(["reading", "importing", "finishing"]);
const refreshStatuses = new Set(["running", "done", "expired", "unavailable"]);

/** phase: a processing import's step, or null (not known). */
function phase(v: unknown): boolean {
  return v === null || (isObject(v) && typeof v.phase === "string" && phases.has(v.phase) && count(v.done) && count(v.total));
}

/** refresh: a first refresh's report; its counts are given unless unavailable. */
function refresh(v: unknown): boolean {
  if (!isObject(v) || typeof v.status !== "string" || !refreshStatuses.has(v.status) || typeof v.until !== "number") return false;
  return v.status === "unavailable" || [v.total, v.attempted, v.succeeded, v.failed].every(count);
}

/** parseProgress is a progress body, or undefined; each part is checked for the status it belongs to. */
export function parseProgress(v: unknown): Progress | undefined {
  const im = parseImport(v);
  if (!im) return undefined;
  const p = v as Record<string, unknown>;
  if (im.status === "uploading") {
    const r = p.received;
    if (!isObject(r) || !Array.isArray(r.chunks) || !count(r.bytes)) return undefined;
    if (!r.chunks.every((c) => Array.isArray(c) && c.length === 2 && count(c[0]) && count(c[1]))) return undefined;
  }
  if (im.status === "processing" && !("processing" in p && phase(p.processing))) return undefined;
  if (p.refresh !== undefined && !refresh(p.refresh)) return undefined;
  return im as Progress;
}

/** parseCurrent is GET /v1/import's body: the account's import, or null. */
export function parseCurrent(v: unknown): { import: ImportRow | null } | undefined {
  if (!isObject(v) || !("import" in v)) return undefined;
  if (v.import === null) return { import: null };
  const im = parseImport(v.import);
  return im ? { import: im } : undefined;
}

/** Outcome is a request's answer as the job sees it. */
export type Outcome<T> =
  | { ok: true; value: T }
  /** No answer, a server error, too many requests, or a success that could not be read: the request may have happened. */
  | { ok: false; kind: "ambiguous"; retryAfter?: number }
  /** The session ended or belongs to another account: the job stops; the app handles the sign-out. */
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "refused"; status: number; code: string; message: string };

/** outcome classifies a request's result: value when it succeeded with the expected shape. */
export function outcome<T>(value: T | undefined): Outcome<T> {
  return value === undefined ? { ok: false, kind: "ambiguous" } : { ok: true, value };
}

/** failure classifies a request's error. An abort is the job's own (it stopped): it is not classified. */
export function failure(e: unknown): Outcome<never> {
  if (e instanceof Unreachable || e instanceof Unreadable) return { ok: false, kind: "ambiguous" };
  if (e instanceof ApiError) {
    // A 401 signs the tab out and another account reloads it (http.ts); a 403 is shown, as any refusal.
    if (e.status === 401 || e.code === "account_changed") return { ok: false, kind: "auth" };
    if (e.status >= 500 || e.status === 429) return { ok: false, kind: "ambiguous", retryAfter: e.retryAfter };
    return { ok: false, kind: "refused", status: e.status, code: e.code, message: e.message };
  }
  return { ok: false, kind: "auth" }; // an AbortError: another sign-in, or the job's own stop
}

/** FileInfo is the file the person chose. */
export interface FileInfo {
  name: string;
  size: number;
  kind: "opml" | "android_db";
}

/** Notice is a message beside the state, which the next step clears. */
export type Notice =
  | { n: "wrong_file"; expected: string }
  | { n: "cancelled" }
  | { n: "other_import"; file: string }
  | { n: "error"; message: string };

export type JobState =
  | { k: "idle" }
  | { k: "hashing"; file: FileInfo; read: number; resume?: { im: ImportRow; legacy: boolean } }
  | { k: "reserving"; file: FileInfo; fingerprint: string }
  /** repaired: sending the chunks a finish found missing (once); refused: a chunk the server refused, the layout being checked. */
  | { k: "uploading"; im: ImportRow; sent: number; missing: number[]; legacy: boolean; repaired?: boolean; refused?: string }
  | { k: "finishing"; im: ImportRow; legacy: boolean; repaired: boolean }
  | { k: "processing"; im: ImportRow; phase: Phase | null; legacy: boolean }
  /** published: its report fetched (report), then its first refresh followed while it runs. */
  | { k: "published"; im: ImportRow; refresh?: RefreshProgress; legacy: boolean }
  | { k: "failed"; im: ImportRow }
  /** The account has an upload this tab is not sending: choosing the same file continues it. */
  | { k: "interrupted"; im: ImportRow; legacy: boolean }
  /** The upload's chunks cannot be continued (another chunking, or a damaged chunk): only starting again. */
  | { k: "mismatch"; im: ImportRow; why: "layout" | "damaged" }
  | { k: "gone" };

export type Command =
  | { c: "hash" }
  | { c: "reserve" }
  | { c: "current" }
  | { c: "get"; probe?: boolean }
  | { c: "received" }
  | { c: "put"; n: number }
  | { c: "finish" }
  | { c: "cancel"; restart: boolean }
  | { c: "progress" }
  | { c: "report" }
  | { c: "stop" };

/** Step is a state, what to do next, and after how long (ms). */
export interface Step {
  state: JobState;
  next: Command;
  after?: number;
  /** waiting: the server did not answer; the request is repeated after a pause. */
  waiting?: boolean;
  notice?: Notice;
  /** detach: the session ended or changed; the job stops without a word. */
  detach?: boolean;
}

const stop: Command = { c: "stop" };

/** expected is the length chunk n has in the web client's chunking. */
export function expected(size: number, n: number): number {
  return Math.min(chunkSize, size - chunkSize * n);
}

/** chunkCount is how many chunks a file of size has. */
export function chunkCount(size: number): number {
  return Math.ceil(size / chunkSize);
}

/**
 * layout checks the chunks the server holds against this client's chunking:
 * every one must be a chunk this client would send, of its length. It returns
 * the indices still to send, or undefined when the upload cannot be continued.
 */
export function layout(size: number, chunks: [number, number][]): number[] | undefined {
  const count = chunkCount(size);
  const held = new Set<number>();
  for (const [n, len] of chunks) {
    if (n < 0 || n >= count || len !== expected(size, n)) return undefined;
    held.add(n);
  }
  const missing: number[] = [];
  for (let n = 0; n < count; n++) if (!held.has(n)) missing.push(n);
  return missing;
}

/** backoff is the pause before the n-th retry (from 1): 1 s doubling to 30 s, never below the server's Retry-After. */
export function backoff(attempt: number, retryAfter?: number): number {
  const ms = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.max(ms, (retryAfter ?? 0) * 1000);
}

/** guarded: the tab's work would be lost by leaving the page (the unload prompt is on). */
export function guarded(s: JobState): boolean {
  return s.k === "hashing" || s.k === "reserving" || s.k === "uploading" || s.k === "finishing";
}

/** busy: the import rows are disabled. */
export const busy = guarded;

/** following: the job polls the server (processing, or a first refresh running). */
export function following(s: JobState): boolean {
  return s.k === "processing" || (s.k === "published" && s.refresh?.status === "running");
}

/** reservingAgain reserves the file of an import anew (Start again): the file this tab holds matched it. */
function reservingAgain(im: ImportRow): JobState {
  return { k: "reserving", file: { name: im.file_name, size: im.size, kind: im.kind === "opml" ? "opml" : "android_db" }, fingerprint: im.fingerprint };
}

/** adopt is the step for an import as the server reports it. */
export function adopt(im: ImportRow, legacy: boolean): Step {
  switch (im.status) {
    case "uploading":
      return legacy ? putAll(im) : { state: { k: "uploading", im, sent: 0, missing: [], legacy }, next: { c: "received" } };
    case "processing":
      return { state: { k: "processing", im, phase: null, legacy }, next: { c: "progress" } };
    case "published":
      return { state: { k: "published", im, legacy }, next: { c: "report" } };
    case "failed":
      return im.reason === "cancelled" ? { state: { k: "idle" }, next: stop, notice: { n: "cancelled" } } : { state: { k: "failed", im }, next: stop };
  }
}

/** putAll sends every chunk (an old server cannot say which it holds). */
function putAll(im: ImportRow): Step {
  const missing = [...Array(chunkCount(im.size)).keys()];
  return { state: { k: "uploading", im, sent: 0, missing, legacy: true }, next: { c: "put", n: missing[0]! } };
}

function sentOf(size: number, missing: number[]): number {
  let left = 0;
  for (const n of missing) left += expected(size, n);
  return size - left;
}

/** fromReceived continues an upload from the chunks the server holds. */
function fromReceived(im: ImportRow, chunks: [number, number][], repairing: boolean): Step {
  const missing = layout(im.size, chunks);
  if (!missing) return { state: { k: "mismatch", im, why: "layout" }, next: stop };
  // Every chunk is there, yet the file did not match: one of them was damaged.
  if (repairing && missing.length === 0) return { state: { k: "mismatch", im, why: "damaged" }, next: stop };
  if (missing.length === 0) return { state: { k: "finishing", im, legacy: false, repaired: repairing }, next: { c: "finish" } };
  return { state: { k: "uploading", im, sent: sentOf(im.size, missing), missing, legacy: false, repaired: repairing }, next: { c: "put", n: missing[0]! } };
}

/** ownsFile: the state is this tab's own upload, whose file it holds. */
function ownsFile(s: JobState): boolean {
  return s.k === "hashing" || s.k === "reserving" || s.k === "uploading" || s.k === "finishing";
}

/** errorStep shows a refusal; an upload this tab was sending stays continuable (interrupted). */
function errorStep(s: JobState, r: { message: string }): Step {
  const im = imOf(s);
  const notice: Notice = { n: "error", message: r.message };
  if (im && (s.k === "uploading" || s.k === "finishing" || s.k === "interrupted")) return { state: { k: "interrupted", im, legacy: legacyOf(s) }, next: stop, notice };
  return { state: { k: "idle" }, next: stop, notice };
}

/** adoptHere adopts the server's state of the import; an upload continues only where this tab holds its file. */
function adoptHere(s: JobState, cur: ImportRow, legacy: boolean): Step {
  if (cur.status === "uploading" && !ownsFile(s)) return { state: { k: "interrupted", im: cur, legacy }, next: stop };
  return adopt(cur, legacy);
}

/** imOf is the import a state is about. */
export function imOf(s: JobState): ImportRow | undefined {
  return "im" in s ? s.im : undefined;
}

function legacyOf(s: JobState): boolean {
  return "legacy" in s ? s.legacy : false;
}

/**
 * advance is the step after cmd answered out, in state s. attempt counts the
 * repeats of cmd so far (for the pause before the next one).
 */
export function advance(s: JobState, cmd: Command, out: Outcome<unknown>, attempt = 0): Step {
  if (!out.ok && out.kind === "auth") return { state: s, next: stop, detach: true };
  if (!out.ok && out.kind === "ambiguous") {
    // The request may have happened: it is repeated as it is (each is
    // idempotent or reconciled), never reported as failed.
    return { state: s, next: cmd, after: backoff(attempt + 1, out.retryAfter), waiting: true };
  }
  const im = imOf(s);
  const legacy = legacyOf(s);
  const refused = out.ok ? undefined : out;
  const value: unknown = out.ok ? out.value : undefined;
  const gone: Step = { state: { k: "gone" }, next: stop };
  switch (cmd.c) {
    case "reserve": {
      if (refused) {
        if (refused.status === 409 && refused.code === "import_exists") return { state: s, next: { c: "current" } };
        return errorStep(s, refused);
      }
      return adopt(value as ImportRow, false);
    }
    case "current": {
      if (refused) return errorStep(s, refused);
      const cur = (value as { import: ImportRow | null }).import;
      if (!cur) return { state: { k: "idle" }, next: stop };
      // Another file's import: shown, never continued with this tab's file.
      const step = cur.status === "uploading" ? { state: { k: "interrupted", im: cur, legacy: false } as JobState, next: stop } : adopt(cur, false);
      return { ...step, notice: { n: "other_import", file: cur.file_name } };
    }
    case "received": {
      if (refused) {
        // A 404 is an old server without the route, or an import gone: the import itself tells which.
        if (refused.status === 404) return { state: s, next: { c: "get", probe: true } };
        return errorStep(s, refused);
      }
      const p = value as Progress;
      if (p.status !== "uploading") return adoptHere(s, p, legacy);
      const step = fromReceived(p, p.received!.chunks, s.k === "finishing");
      // A chunk the server refused although the layout matches is not sent again.
      if (s.k === "uploading" && s.refused !== undefined && step.state.k !== "mismatch") return errorStep(s, { message: s.refused });
      return step;
    }
    case "get": {
      if (refused) return refused.status === 404 ? gone : errorStep(s, refused);
      // The import exists but its progress route does not: an old server.
      const cur = value as ImportRow;
      return adoptHere(s, cur, cmd.probe ? true : legacy);
    }
    case "put": {
      if (s.k !== "uploading") return { state: s, next: stop };
      if (refused) {
        if (refused.status === 409) return { state: s, next: { c: "get" } };
        if (refused.status === 404) return gone;
        if (refused.status === 400 && !legacy) return { state: { ...s, refused: refused.message }, next: { c: "received" } };
        return errorStep(s, refused);
      }
      const missing = s.missing.filter((n) => n !== cmd.n);
      const sent = s.sent + expected(s.im.size, cmd.n);
      if (missing.length) return { state: { ...s, missing, sent }, next: { c: "put", n: missing[0]! } };
      return { state: { k: "finishing", im: s.im, legacy: s.legacy, repaired: s.repaired ?? false }, next: { c: "finish" } };
    }
    case "finish": {
      if (refused) {
        if (refused.status === 404) return gone;
        if (refused.status === 400 && s.k === "finishing") {
          // The file does not match: an old server can only say so; a new one shows what it holds:
          // missing chunks are sent once, a damaged one means starting again (never another finish).
          if (legacy) return errorStep(s, refused);
          if (s.repaired) return { state: { k: "mismatch", im: s.im, why: "damaged" }, next: stop };
          return { state: s, next: { c: "received" } };
        }
        return errorStep(s, refused);
      }
      return adopt(value as ImportRow, legacy);
    }
    case "cancel": {
      if (refused) {
        // Not uploading any more (another tab finished it): its state is adopted; no new reservation.
        if (refused.status === 409) return { state: s, next: { c: "get" } };
        if (refused.status === 404) return im && legacy ? { state: { k: "interrupted", im, legacy: true }, next: stop } : gone;
        return errorStep(s, refused);
      }
      const cur = value as ImportRow;
      if (cur.status !== "failed") return adoptHere(s, cur, legacy);
      // Start again: the same file (the cancelled import's, which it matched) is reserved anew, sending as from the start.
      if (cmd.restart && im) return { state: reservingAgain(im), next: { c: "reserve" } };
      return { state: { k: "idle" }, next: stop, notice: { n: "cancelled" } };
    }
    case "progress": {
      if (refused) {
        if (refused.status === 404) return im && !legacy ? { state: s, next: { c: "get", probe: true } } : gone;
        return errorStep(s, refused);
      }
      const p = value as Progress;
      if (s.k === "published") {
        const st: JobState = { ...s, refresh: p.refresh };
        return following(st) ? { state: st, next: { c: "progress" }, after: 3000 } : { state: st, next: stop };
      }
      if (p.status === "processing") {
        return { state: { k: "processing", im: p, phase: legacy ? null : (p.processing ?? null), legacy }, next: { c: "progress" }, after: 1000 };
      }
      if (p.status === "published") {
        // An old server answers the whole import here, its report included.
        if (legacy) return { state: { k: "published", im: p, legacy }, next: stop };
        return { state: { k: "published", im: p, refresh: p.refresh, legacy }, next: { c: "report" } };
      }
      return adoptHere(s, p, legacy);
    }
    case "report": {
      if (refused) return refused.status === 404 ? gone : errorStep(s, refused);
      if (s.k !== "published") return { state: s, next: stop };
      const st: JobState = { ...s, im: value as ImportRow };
      if (legacy || (s.refresh && !following(st))) return { state: st, next: stop };
      // The refresh is followed from the report's progress on (or asked for, when not known yet).
      return { state: st, next: { c: "progress" }, after: s.refresh ? 3000 : 0 };
    }
    case "hash":
    case "stop":
      return { state: s, next: stop };
  }
}

/** mount is the step for the account's import found when a screen opens without a job in this tab. */
export function mount(cur: ImportRow | null): Step {
  if (!cur) return { state: { k: "idle" }, next: stop };
  switch (cur.status) {
    case "uploading":
      // Its chunks are asked for: whether this server can say which it holds, and cancel.
      return { state: { k: "interrupted", im: cur, legacy: false }, next: { c: "received" } };
    case "published":
      // The answer holds the report already: only the refresh is asked for.
      return { state: { k: "published", im: cur, legacy: false }, next: { c: "progress" } };
    case "failed":
      return cur.reason === "cancelled" ? { state: { k: "idle" }, next: stop } : { state: { k: "failed", im: cur }, next: stop };
    default:
      return adopt(cur, false);
  }
}

/**
 * mountReceived is the step for an interrupted upload's chunks, asked for at
 * mount: they tell whether this server can cancel (an old one has no such
 * route); an import gone or moved on is adopted.
 */
export function mountReceived(s: JobState & { k: "interrupted" }, out: Outcome<unknown>): Step {
  if (!out.ok && out.kind === "auth") return { state: s, next: stop, detach: true };
  if (!out.ok && out.kind === "refused" && out.status === 404) return { state: s, next: { c: "get", probe: true } };
  if (!out.ok) return { state: s, next: stop }; // shown as interrupted; Cancel is offered
  const p = out.value as Progress;
  if (p.status !== "uploading") return adoptHere(s, p, false);
  return { state: { ...s, im: p }, next: stop };
}

/** chooseCheck refuses, before reading it, a file that cannot be the one an upload is waiting for. */
export function chooseCheck(s: JobState, file: FileInfo): Notice | undefined {
  if (s.k === "interrupted" && (file.size !== s.im.size || file.kind !== s.im.kind)) return { n: "wrong_file", expected: s.im.file_name };
  if (file.size > maxFile) return { n: "error", message: "too_large" };
  return undefined;
}

/**
 * hashed is the step once the file is read: a resumed upload continues only
 * with the same file (its reservation untouched otherwise); a new one is reserved.
 */
export function hashed(s: JobState & { k: "hashing" }, fingerprint: string): Step {
  const r = s.resume;
  if (r) {
    if (fingerprint !== r.im.fingerprint) {
      return { state: { k: "interrupted", im: r.im, legacy: r.legacy }, next: stop, notice: { n: "wrong_file", expected: r.im.file_name } };
    }
    if (r.legacy) return putAll(r.im);
    return { state: { k: "uploading", im: r.im, sent: 0, missing: [], legacy: false }, next: { c: "received" } };
  }
  return { state: { k: "reserving", file: s.file, fingerprint }, next: { c: "reserve" } };
}
