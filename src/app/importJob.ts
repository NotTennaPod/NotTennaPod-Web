// The tab's library import (PROTOCOL §11.5): one job per tab, kept while the
// person moves between the account's screens, run here and decided by
// importMachine.ts. The job belongs to the account and sign-in it began under:
// an answer that arrives after either changed is dropped and the job stops
// (detach); the server keeps the uploaded chunks for that account. Leaving
// the page while the file is read or sent asks first.
import { currentAccount, currentGeneration, request, requestStrict } from "../api/http.ts";
import { Sha256 } from "../util/random.ts";
import * as m from "./importMachine.ts";

export interface JobView {
  state: m.JobState;
  notice?: m.Notice;
  /** waiting: the server did not answer; the job asks again after a pause. */
  waiting: boolean;
}

interface Job {
  account: string | undefined;
  generation: number;
  abort: AbortController;
  /** run counts the job's loops: a loop whose number is no longer current stops. */
  run: number;
  file?: File;
  info?: m.FileInfo;
  fingerprint?: string;
  state: m.JobState;
}

let job: Job | undefined;
let view: JobView = { state: { k: "idle" }, waiting: false };
const listeners = new Set<() => void>();

/** hooks are the job's clock, which tests replace. */
export const hooks = {
  sleep: (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (ms <= 0) return resolve();
      const t = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    }),
};

export function snapshot(): JobView {
  return view;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function publish(v: JobView): void {
  view = v;
  guard();
  for (const fn of listeners) fn();
}

/** live: the job is the tab's, under the account and sign-in it began with, and run is its current loop. */
function live(j: Job, run: number): boolean {
  return job === j && j.run === run && j.account === currentAccount() && j.generation === currentGeneration() && !j.abort.signal.aborted;
}

function newJob(): Job {
  return { account: currentAccount(), generation: currentGeneration(), abort: new AbortController(), run: 0, state: { k: "idle" } };
}

/** restartLoop stops the job's running loop (its request is aborted) and returns the new loop's number. */
function restartLoop(j: Job): number {
  j.abort.abort();
  j.abort = new AbortController();
  return ++j.run;
}

function apply(j: Job, step: Pick<m.Step, "state" | "notice" | "waiting">, clearNotice = false): void {
  j.state = step.state;
  publish({ state: step.state, notice: step.notice ?? (clearNotice ? undefined : view.notice), waiting: step.waiting ?? false });
}

// ---- the unload guard: on while the file is read or sent, for this sign-in only.

let guardOn = false;

function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (job && m.guarded(job.state) && job.generation === currentGeneration()) {
    e.preventDefault();
    e.returnValue = "";
  }
}

function guard(): void {
  const want = !!job && m.guarded(job.state);
  if (want === guardOn || typeof globalThis.addEventListener !== "function") return;
  guardOn = want;
  if (want) globalThis.addEventListener("beforeunload", onBeforeUnload);
  else globalThis.removeEventListener("beforeunload", onBeforeUnload);
}

/**
 * detach stops the tab's job without a word: its requests are aborted, its
 * answers dropped and the unload guard removed. The app calls it before an
 * account transition reloads the tab, and before logging out.
 */
export function detach(): void {
  if (job) job.abort.abort();
  job = undefined;
  attached = false;
  publish({ state: { k: "idle" }, waiting: false });
}

// ---- requests

const enc = encodeURIComponent;

/** chunkBody is chunk n of the file as the server takes it: JSON {data: base64}. */
async function chunkBody(file: File, n: number): Promise<{ data: string }> {
  const bytes = new Uint8Array(await file.slice(n * m.chunkSize, (n + 1) * m.chunkSize).arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(s) };
}

async function perform(j: Job, cmd: m.Command): Promise<m.Outcome<unknown>> {
  const signal = j.abort.signal;
  const im = m.imOf(j.state);
  const id = im ? enc(im.import_id) : "";
  const legacy = "legacy" in j.state && j.state.legacy;
  try {
    switch (cmd.c) {
      case "reserve": {
        // What the reserving state names: the chosen file, or the file of an import started again.
        const r = j.state.k === "reserving" ? j.state : { file: j.info!, fingerprint: j.fingerprint };
        return m.outcome(
          m.parseImport(await requestStrict("POST", "/v1/import", { kind: r.file.kind, fingerprint: r.fingerprint, size: r.file.size, file_name: r.file.name }, signal)),
        );
      }
      case "current":
        return m.outcome(m.parseCurrent(await requestStrict("GET", "/v1/import", undefined, signal)));
      case "get":
      case "report":
        return m.outcome(m.parseImport(await requestStrict("GET", `/v1/import/${id}`, undefined, signal)));
      case "received":
        return m.outcome(m.parseProgress(await requestStrict("GET", `/v1/import/${id}/progress`, undefined, signal)));
      case "progress":
        // An old server has no progress route: its import's own answer is polled.
        if (legacy) return m.outcome(m.parseImport(await requestStrict("GET", `/v1/import/${id}`, undefined, signal)));
        return m.outcome(m.parseProgress(await requestStrict("GET", `/v1/import/${id}/progress`, undefined, signal)));
      case "put":
        // A 200 means the chunk is stored, whatever its body; without one it is sent again (idempotent).
        await request("PUT", `/v1/import/${id}/chunks/${cmd.n}`, await chunkBody(j.file!, cmd.n), signal);
        return { ok: true, value: {} };
      case "finish":
        return m.outcome(m.parseImport(await requestStrict("POST", `/v1/import/${id}/finish`, {}, signal)));
      case "cancel":
        return m.outcome(m.parseImport(await requestStrict("POST", `/v1/import/${id}/cancel`, {}, signal)));
      case "hash":
      case "stop":
        return { ok: true, value: undefined };
    }
  } catch (e) {
    return m.failure(e);
  }
}

/** loop runs the job's commands until one stops it, applying each answer while the job is still live. */
async function loop(j: Job, run: number, first: m.Command, after = 0): Promise<void> {
  let cmd = first;
  let attempt = 0;
  while (cmd.c !== "stop") {
    if (after > 0) await hooks.sleep(after, j.abort.signal);
    if (!live(j, run)) return stale(j, run);
    const out = await perform(j, cmd);
    // An answer for another sign-in or account, or for a stopped loop, is dropped.
    if (!live(j, run)) return stale(j, run);
    const step = m.advance(j.state, cmd, out, attempt);
    if (step.detach) return detach();
    attempt = step.waiting ? attempt + 1 : 0;
    apply(j, step);
    after = step.after ?? 0;
    cmd = step.next;
  }
}

/** stale ends a loop that is no longer live: the job is detached when its identity changed. */
function stale(j: Job, run: number): void {
  if (job === j && j.run === run && (j.account !== currentAccount() || j.generation !== currentGeneration())) detach();
}

// ---- what the screens call

let attached = false;

/**
 * attach finds the account's import when a screen with the import opens, once
 * per page load: none, an upload this tab is not sending (interrupted), one
 * processing (followed), published (its report, then its first refresh) or
 * failed. A job already running in this tab is kept.
 */
export function attach(): void {
  if (attached || job) return;
  attached = true;
  const j = newJob();
  job = j;
  void (async () => {
    const run = j.run;
    let attempt = 0;
    for (;;) {
      const out = await perform(j, { c: "current" });
      if (!live(j, run)) return stale(j, run);
      if (out.ok) {
        const step = m.mount((out.value as { import: m.ImportRow | null }).import);
        apply(j, step);
        if (step.state.k === "interrupted") {
          const r = await perform(j, { c: "received" });
          if (!live(j, run)) return stale(j, run);
          const next = m.mountReceived(step.state, r);
          if (next.detach) return detach();
          apply(j, next);
          return loop(j, run, next.next, next.after);
        }
        return loop(j, run, step.next, step.after);
      }
      if (out.kind === "auth") return detach();
      if (out.kind === "refused") return apply(j, { state: { k: "idle" }, notice: { n: "error", message: out.message } });
      apply(j, { state: j.state, waiting: true });
      await hooks.sleep(m.backoff(++attempt, out.retryAfter), j.abort.signal);
    }
  })();
}

/** choose starts an import of file, or continues the interrupted upload with it (only the same file). */
export function choose(file: File, kind: "opml" | "android_db"): void {
  const info: m.FileInfo = { name: file.name, size: file.size, kind };
  const before = job?.state ?? view.state;
  if (m.busy(before)) return;
  const refusal = m.chooseCheck(before, info);
  if (refusal) {
    publish({ ...view, notice: refusal });
    return;
  }
  const resume = before.k === "interrupted" ? { im: before.im, legacy: before.legacy } : undefined;
  const j = job ?? newJob();
  job = j;
  attached = true;
  const run = restartLoop(j);
  j.account = currentAccount();
  j.generation = currentGeneration();
  j.file = file;
  j.info = info;
  j.fingerprint = undefined;
  apply(j, { state: { k: "hashing", file: info, read: 0, resume } }, true);
  void (async () => {
    try {
      // The file is read one chunk at a time, so a large backup never sits in memory whole.
      const hash = new Sha256();
      for (let i = 0; i < file.size; i += m.chunkSize) {
        hash.update(new Uint8Array(await file.slice(i, i + m.chunkSize).arrayBuffer()));
        if (!live(j, run)) return stale(j, run);
        apply(j, { state: { k: "hashing", file: info, read: Math.min(file.size, i + m.chunkSize), resume } });
      }
      j.fingerprint = [...hash.digest()].map((x) => x.toString(16).padStart(2, "0")).join("");
    } catch (e) {
      if (!live(j, run)) return stale(j, run);
      const back: m.JobState = resume ? { k: "interrupted", im: resume.im, legacy: resume.legacy } : { k: "idle" };
      return apply(j, { state: back, notice: { n: "error", message: e instanceof Error ? e.message : String(e) } });
    }
    const step = m.hashed(j.state as m.JobState & { k: "hashing" }, j.fingerprint);
    apply(j, step);
    await loop(j, run, step.next, step.after);
  })();
}

/** canRestart: the upload can be started again here (this tab holds its file). */
export function canRestart(): boolean {
  return !!job?.file && !!job.fingerprint;
}

/** cancel cancels the account's upload (this tab's, or an interrupted one); restart reserves the same file again afterwards. */
export function cancel(restart = false): void {
  const j = job;
  if (!j || !m.imOf(j.state) || (restart && !canRestart())) return;
  const run = restartLoop(j);
  publish({ ...view, notice: undefined });
  void loop(j, run, { c: "cancel", restart });
}
