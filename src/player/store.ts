// The session journal and the player lease in IndexedDB (PROTOCOL §12, §8, §6.10). Every save is
// written here before it counts as made. An export (a session.checkpoint or session.end) is built
// from the latest save and appended to the fact journal in the same transaction that moves the
// session's export watermark, so a save is exported exactly once whatever tab or page load exports
// it.
import { req, tx, type EntryRow } from "../journal/db.ts";
import { appendIn, journalStores, uuid, type FactBody } from "../journal/journal.ts";
import type { EpisodeRef } from "../app/actions.ts";
import { contribution, thresholdMs, type Baseline } from "./accounting.ts";

/** A five-second (or start, pause, stop, end) save with its identity (PROTOCOL §6.10). */
export interface SaveRow {
  id: string;
  index: number; // the session's save counter
  baseline: string;
  position: number;
  contribution: number;
  time: number;
  page: string; // the page load (its author) that made it
}

export interface SessionRow {
  account_id: string;
  session_id: string;
  author_id: string; // the session's author: only it appends to the session
  episode: EpisodeRef;
  start_op: string;
  start_baseline: string;
  start_position: number;
  baseline: string; // the baseline in force
  base: Baseline; // where the accounting restarted with it
  saves: number;
  last: SaveRow; // a session always has its save at start
  first_unexported: string | null; // the first save after the last export
  exported_index: number;
  exported_at: number;
  ordinal: number; // of the last checkpoint or end
  last_op: string; // the session's latest fact
  export_baselines: string[];
  claims: string[]; // the session's facts that may own the position (PROTOCOL §6.10)
  sealed: string | null; // the end's reason
  completed?: boolean; // its end or finalization completed the episode
  finalized: boolean;
  closed: boolean; // never resumed: finalized, handed to another tab, or stopped
  page: string; // the page load that played it last
  tab: string; // the browser tab that played it: only that tab resumes it after a reload
  duration: number; // measured, 0 when unknown
  created_at: number;
  /** resume is a seek made while paused: the next save or start carries it (seek, then resume, PROTOCOL §12); it is no save and no fact. */
  resume?: number;
}

/** The profile's player: who plays (fenced lease, PROTOCOL §12) and its current episode. */
export interface LeaseRow {
  account_id: string;
  page: string | null;
  tab: string | null; // the browser tab, so a reloaded tab knows its own lease
  fence: number;
  expires: number;
  current: CurrentRow | null;
}

export interface CurrentRow {
  episode_id: string;
  session_id: string | null; // its latest session in this profile
  claim: string | null; // the claim the paused position stands under
  position: number;
  duration: number;
  playing: boolean;
  title: string;
  podcast: string;
  image: string;
  /** observed is the position record the paused position was last decided against (absent in rows saved before it was kept). */
  observed?: Observed | null;
  /** listened is the newest listening time (last_played) a settled decision saw; it never goes down. */
  listened?: number;
}

/**
 * Observed identifies one version of an episode's position record (PROTOCOL §8.6):
 * its lineage, generation, claim and provenance (no claim: the episode had no
 * position record yet), with the episode's last played time. settled says a
 * decision was taken on it (adopted, our own, a restore rebaselined, or the
 * position was loaded from it); a record seen while our own claim was
 * pending is not settled, and is decided again.
 */
export interface Observed {
  log_id: string;
  epoch: number;
  generation_id: string | null;
  claim_id: string | null;
  provenance: string[]; // sorted
  last_played: number;
  settled: boolean;
}

export const stores = [...journalStores, "sessions", "leases"];

const target = (r: EpisodeRef) => [{ entity: "episode", id: r.episode_id, generation: r.generation_id }];

/** addSave records a save at position (PROTOCOL §8.8 contribution) and returns it. */
export function addSave(row: SessionRow, position: number, time: number, page: string): SaveRow {
  const s: SaveRow = {
    id: uuid(),
    index: row.saves + 1,
    baseline: row.baseline,
    position: Math.max(0, Math.round(position)),
    contribution: 0,
    time,
    page,
  };
  s.contribution = contribution(row.base, row.last?.contribution ?? 0, s.position);
  row.saves = s.index;
  row.last = s;
  delete row.resume;
  row.first_unexported ??= s.id;
  row.page = page;
  return s;
}

/** saveIdentity is the export's save field: first only when it covers a new save. */
export function saveIdentity(row: SessionRow, page: string): Record<string, unknown> {
  const s: Record<string, unknown> = { id: row.last.id, index: row.last.index, baseline: row.last.baseline, passive: row.last.page !== page };
  if (row.last.index > row.exported_index && row.first_unexported) s.first = row.first_unexported;
  return s;
}

function withDuration(payload: Record<string, unknown>, row: SessionRow): Record<string, unknown> {
  if (row.duration > 0) payload.duration = Math.round(row.duration);
  return payload;
}

export interface EndSpec {
  reason: "ended" | "skipped" | "switched" | "removed" | "suspended" | "superseded";
  completed: boolean;
  removeFromQueue: boolean;
  history: boolean;
  dependencies?: string[];
}

/**
 * exportIn appends the session's next checkpoint (or its end) in t: the
 * latest save with its identity, the next ordinal, the session's author.
 * A checkpoint is made only for a new save; an end may cover none.
 */
export async function exportIn(t: IDBTransaction, row: SessionRow, page: string, now: number, end?: EndSpec): Promise<EntryRow | null> {
  const fresh = row.last.index > row.exported_index;
  if (row.sealed || (!end && !fresh)) return null;
  const passive = row.last.page !== page;
  const payload: Record<string, unknown> = {
    episode: row.episode,
    session_id: row.session_id,
    ordinal: row.ordinal + 1,
    position: row.last.position,
    contribution: row.last.contribution,
    activity: fresh,
    save: saveIdentity(row, page),
  };
  if (end) {
    Object.assign(payload, {
      reason: end.reason,
      completed: end.completed,
      threshold_ms: thresholdMs,
      remove_from_queue: end.removeFromQueue,
      history: end.history,
    });
  }
  const body: FactBody = {
    type: end ? "session.end" : "session.checkpoint",
    targets: target(row.episode),
    payload: withDuration(payload, row),
    dependencies: end?.dependencies ?? [],
  };
  const entry = await appendIn(t, row.account_id, row.author_id, body, end ? now : row.last.time);
  row.ordinal++;
  row.last_op = entry.op_id;
  if (fresh) {
    // A continuation's first export under a new baseline claims (PROTOCOL §6.10).
    if (!passive && row.last.baseline !== row.start_baseline && !row.export_baselines.includes(row.last.baseline)) row.claims.push(entry.op_id);
    if (!row.export_baselines.includes(row.last.baseline)) row.export_baselines.push(row.last.baseline);
    row.exported_index = row.last.index;
    row.first_unexported = null;
    row.exported_at = now;
  }
  if (end) {
    row.sealed = end.reason;
    if (end.completed) row.completed = true;
  }
  return entry;
}

export interface FinalizeSpec {
  claim: string;
  completed: boolean;
  removeFromQueue: boolean;
  dependencies?: string[];
}

/** finalizeIn is the lazy completion of a session no longer tracked (PROTOCOL §8). */
export async function finalizeIn(t: IDBTransaction, row: SessionRow, now: number, f: FinalizeSpec): Promise<EntryRow | null> {
  if (row.finalized || row.ordinal < 1) return null;
  const body: FactBody = {
    type: "session.finalize",
    targets: target(row.episode),
    payload: {
      episode: row.episode,
      session_id: row.session_id,
      ordinal: row.ordinal,
      claim_id: f.claim,
      completed: f.completed,
      threshold_ms: thresholdMs,
      remove_from_queue: f.removeFromQueue,
      history: true,
    },
    dependencies: f.dependencies ?? [],
  };
  const entry = await appendIn(t, row.account_id, row.author_id, body, now);
  row.last_op = entry.op_id;
  row.finalized = true;
  row.closed = true;
  if (f.completed) row.completed = true;
  return entry;
}

export interface StartSpec {
  account: string;
  author: string;
  page: string;
  tab: string;
  episode: EpisodeRef;
  position: number;
  duration: number;
  observedClaim: string | null;
  queueBundle: Record<string, unknown> | null; // {key, position_id, place}: the add the browser resolved
  dependencies: string[];
}

/** startIn journals session.start (a claim) with its first save, as one transaction's writes. */
export async function startIn(t: IDBTransaction, s: StartSpec, now: number): Promise<SessionRow> {
  const sessionId = uuid();
  const baseline = uuid();
  const payload: Record<string, unknown> = {
    episode: s.episode,
    session_id: sessionId,
    start_position: Math.max(0, Math.round(s.position)),
    activity: true,
    baseline,
  };
  if (s.observedClaim) payload.observed_claim = s.observedClaim;
  if (s.duration > 0) payload.duration = Math.round(s.duration);
  if (s.queueBundle) payload.queue_bundle = s.queueBundle;
  const entry = await appendIn(t, s.account, s.author, { type: "session.start", targets: target(s.episode), payload, dependencies: s.dependencies }, now);
  const row: SessionRow = {
    account_id: s.account,
    session_id: sessionId,
    author_id: s.author,
    episode: s.episode,
    start_op: entry.op_id,
    start_baseline: baseline,
    start_position: payload.start_position as number,
    baseline,
    base: { position: payload.start_position as number, contribution: 0 },
    saves: 0,
    last: undefined as unknown as SaveRow,
    first_unexported: null,
    exported_index: 0,
    exported_at: now,
    ordinal: 0,
    last_op: entry.op_id,
    export_baselines: [],
    claims: [entry.op_id],
    sealed: null,
    finalized: false,
    closed: false,
    page: s.page,
    tab: s.tab,
    duration: s.duration,
    created_at: now,
  };
  addSave(row, row.start_position, now, s.page);
  await req(t.objectStore("sessions").put(row));
  return row;
}

/** inPlayer runs fn in one transaction over the journal, the sessions and the lease. */
export function inPlayer<T>(db: IDBDatabase, fn: (t: IDBTransaction) => Promise<T>): Promise<T> {
  return tx(db, stores, "readwrite", fn);
}

export async function getSessionIn(t: IDBTransaction, account: string, id: string): Promise<SessionRow | undefined> {
  return (await req(t.objectStore("sessions").get([account, id]))) as SessionRow | undefined;
}

export async function putSessionIn(t: IDBTransaction, row: SessionRow): Promise<void> {
  await req(t.objectStore("sessions").put(row));
}

export async function getSession(db: IDBDatabase, account: string, id: string): Promise<SessionRow | undefined> {
  return tx(db, ["sessions"], "readonly", (t) => getSessionIn(t, account, id));
}

export async function sessionsOf(db: IDBDatabase, account: string): Promise<SessionRow[]> {
  return tx(db, ["sessions"], "readonly", async (t) => {
    const range = IDBKeyRange.bound([account, ""], [account, "￿"]);
    return (await req(t.objectStore("sessions").getAll(range))) as SessionRow[];
  });
}

/** sessionsOfEpisode is the account's sessions of one episode, read through the episode index: never the rest of the history. */
export async function sessionsOfEpisode(db: IDBDatabase, account: string, episodeId: string): Promise<SessionRow[]> {
  return tx(db, ["sessions"], "readonly", async (t) => (await req(t.objectStore("sessions").index("episode").getAll(IDBKeyRange.only([account, episodeId])))) as SessionRow[]);
}

export function emptyLease(account: string): LeaseRow {
  return { account_id: account, page: null, tab: null, fence: 0, expires: 0, current: null };
}

export async function getLeaseIn(t: IDBTransaction, account: string): Promise<LeaseRow> {
  return ((await req(t.objectStore("leases").get(account))) as LeaseRow | undefined) ?? emptyLease(account);
}

export async function putLeaseIn(t: IDBTransaction, row: LeaseRow): Promise<void> {
  await req(t.objectStore("leases").put(row));
}

export async function getLease(db: IDBDatabase, account: string): Promise<LeaseRow> {
  return tx(db, ["leases"], "readonly", (t) => getLeaseIn(t, account));
}

export async function updateLease<T>(db: IDBDatabase, account: string, fn: (row: LeaseRow) => T): Promise<T> {
  return tx(db, ["leases"], "readwrite", async (t) => {
    const row = await getLeaseIn(t, account);
    const out = fn(row);
    await putLeaseIn(t, row);
    return out;
  });
}

/** entryOf finds a journal entry by op ID (absent once retired). */
export async function entryOf(db: IDBDatabase, account: string, opId: string): Promise<EntryRow | undefined> {
  return tx(db, ["journal"], "readonly", async (t) => (await req(t.objectStore("journal").index("op").get([account, opId]))) as EntryRow | undefined);
}

/**
 * exportPending exports the latest unexported save of every open session of
 * the account that keep() accepts, each in its own transaction under its
 * session's author: the restart export at a page load (passive) and the
 * flush before a cut (PROTOCOL §12). It returns the op IDs of the exports made.
 */
export async function exportPending(db: IDBDatabase, account: string, page: string, now: number, keep: (row: SessionRow) => boolean = () => true): Promise<string[]> {
  const made: string[] = [];
  for (const s of await sessionsOf(db, account)) {
    if (s.sealed || s.last.index <= s.exported_index || !keep(s)) continue;
    const op = await inPlayer(db, async (t) => {
      const row = await getSessionIn(t, account, s.session_id);
      if (!row) return null;
      const entry = await exportIn(t, row, page, now);
      if (entry) await putSessionIn(t, row);
      return entry?.op_id ?? null;
    });
    if (op) made.push(op);
  }
  return made;
}

/**
 * listeningFrontier names each kept session's latest fact: a cut depends on
 * them, so it observes all the listening this profile knows (PROTOCOL §8),
 * whether or not a view has shown it yet (another tab may retire it between
 * the export and the cut; a dependency on a fact the server holds is valid).
 */
export async function listeningFrontier(db: IDBDatabase, account: string): Promise<string[]> {
  return (await sessionsOf(db, account)).map((s) => s.last_op);
}
