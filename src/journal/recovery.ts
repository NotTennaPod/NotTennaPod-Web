// Recovery after a server restore (PROTOCOL §6.11, §12):
// the browser keeps no library replica, so it is a recovery source only for
// the entries it holds with receipts of the lost timeline, kept aside when it
// took a successor installation. It opens a recovery, asks which of them the
// restored server lacks, uploads those with their original receipts (and the
// secrets they carry), and finishes. Nothing acknowledged is pushed again as a
// new write. Every step is idempotent by ID, so a reload resumes where it
// stopped; the recovery's ID is recorded before the first request.
import { ApiError } from "../api/http.ts";
import { req, tx, type EntryRow, type InstallationRow, type Receipt, type Secret } from "./db.ts";
import { awaitingOutcome, keptForOutcome, updateInstallation } from "./journal.ts";
import { base64url, canonical, contentHash, utf8 } from "./jcs.ts";
import { defaultBounds, type Bounds } from "./pusher.ts";
import { uuid } from "../util/random.ts";

export interface RecoveryResult {
  kind: string;
  id: string;
  status: string;
  missing?: string[];
  parts_present?: number[];
}

export interface RecoveryTransport {
  /** snapshot opens (or resumes) the recovery: POST /v1/snapshot in mode "recovery". */
  snapshot(body: Record<string, unknown>): Promise<unknown>;
  inventory(body: Record<string, unknown>): Promise<{ results: RecoveryResult[] }>;
  upload(body: Record<string, unknown>): Promise<{ head?: string; results: RecoveryResult[] }>;
  finish(body: Record<string, unknown>): Promise<unknown>;
}

/** RecoveryState is what this browser still holds for a recovery: entries to send, and entries the server will never take. */
export interface RecoveryState {
  done: boolean;
  recovered: number;
  pending: number;
  problems: number;
}

/**
 * tooLarge marks an entry no upload request can hold: with its signed receipt
 * (whose sort values can list the whole queue, PROTOCOL §7.6) and its
 * secrets, its own request (measured as sent), or for a framed fact every
 * legal partition into parts, is over the server's request limit. Signed
 * values are never cut, so it is a problem like the server's refusals.
 */
const tooLarge = "too_large";

/** Problems are final: the entry stays in the browser as evidence and is never sent again (PROTOCOL §6.11). */
const problems = new Set(["conflict", "invalid_receipt", "invalid", tooLarge]);
const recovered = new Set(["joined", "known", "replaced", "have"]);

/** RecoveryEntry is a retained entry, with how its recovery went. */
type RecoveryEntry = EntryRow & {
  recovery?: { status: string; missing?: string[] };
  recovery_framing?: Framing;
};

function receiptOrder(a: RecoveryEntry, b: RecoveryEntry): number {
  const x = a.receipt!, y = b.receipt!;
  return x.epoch - y.epoch || x.seq - y.seq || x.index - y.index || (a.op_id < b.op_id ? -1 : a.op_id > b.op_id ? 1 : 0);
}

/** retained lists the entries recovery still holds; one kept only for its tab's refusal (awaitingOutcome) is done. */
async function retained(db: IDBDatabase, account: string): Promise<RecoveryEntry[]> {
  return tx(db, ["retained"], "readonly", async (t) => {
    const all = (await req(t.objectStore("retained").getAll())) as RecoveryEntry[];
    return all.filter((e) => e.account_id === account && e.receipt && e.recovery?.status !== awaitingOutcome);
  });
}

/**
 * recoveredRow is what a recovered entry leaves: nothing, unless it is a
 * refusal the tab that made it has not shown yet (journal retirement's rule):
 * that stays, out of the recovery's work and counts, until the tab shows it
 * (outcomeShown) or the day is over (retire).
 */
function recoveredRow(row: RecoveryEntry): RecoveryEntry | null {
  if (!keptForOutcome(row, Date.now())) return null;
  const kept: RecoveryEntry = { ...row, recovery: { status: awaitingOutcome } };
  delete kept.secrets; // nothing will be sent again
  delete kept.recovery_framing;
  return kept;
}

async function change(db: IDBDatabase, e: RecoveryEntry, fn: (row: RecoveryEntry) => RecoveryEntry | null): Promise<void> {
  await tx(db, ["retained"], "readwrite", async (t) => {
    const store = t.objectStore("retained");
    const key = [e.account_id, e.install_id, e.install_seq];
    const row = (await req(store.get(key))) as RecoveryEntry | undefined;
    if (!row) return;
    const next = fn(row);
    if (next) await req(store.put(next));
    else await req(store.delete(key)); // recovered: the entry and its secrets go
  });
}

/** recoveryState counts what the browser still holds for recovery. */
export async function recoveryState(db: IDBDatabase, account: string): Promise<RecoveryState> {
  const all = await retained(db, account);
  const bad = all.filter((e) => e.recovery && problems.has(e.recovery.status)).length;
  return { done: all.length === bad, recovered: 0, pending: all.length - bad, problems: bad };
}

/**
 * recover runs the recorded recovery as far as it can now. It returns null
 * when there is none to run. Network and busy errors are thrown, and the
 * caller retries; what was done stays done.
 *
 * A server that answers that the recovery is not open (it lost the session,
 * PROTOCOL §6.11) has it opened again, once per attempt, as the phone opens
 * it on every exchange: every step is idempotent by ID, so the attempt goes on
 * where it was instead of retrying a session that no longer exists.
 */
export async function recover(db: IDBDatabase, account: string, api: RecoveryTransport, bounds: Bounds = defaultBounds, inventoryBound = 2000): Promise<RecoveryState | null> {
  try {
    return await recoverOnce(db, account, api, bounds, inventoryBound);
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 400 && e.code === "invalid_request")) throw e;
    await updateInstallation(db, account, (r) => r.recovery && (r.recovery.opened = false));
    return recoverOnce(db, account, api, bounds, inventoryBound);
  }
}

async function recoverOnce(db: IDBDatabase, account: string, api: RecoveryTransport, bounds: Bounds, inventoryBound: number): Promise<RecoveryState | null> {
  let inst = (await tx(db, ["installations"], "readonly", (t) => req(t.objectStore("installations").get(account)))) as InstallationRow | undefined;
  // A successor handoff still under way has not moved the acknowledged entries
  // aside yet: until it finishes, there is nothing to judge (never "nothing to recover").
  if (!inst?.recovery || inst.recovery.finished || !inst.registered || inst.successor) return null;
  // The evidence this attempt answers for: what arrives later is the next attempt's.
  const attempt = { id: inst.recovery.recovery_id, evidence: inst.recovery.evidence ?? 0 };
  const state: RecoveryState = { done: false, recovered: 0, pending: 0, problems: 0 };
  const open = (await retained(db, account)).filter((e) => !(e.recovery && problems.has(e.recovery.status)));
  if (open.length === 0) {
    // Nothing (left) to send: a recovery with no entries needs no request.
    const counted = await recoveryState(db, account);
    if (inst.recovery.opened) await api.finish({ recovery_id: inst.recovery.recovery_id, complete: counted.problems === 0 });
    return { ...counted, done: await finished(db, account, attempt) };
  }
  if (!inst.recovery.opened) {
    try {
      await api.snapshot({ mode: "recovery", recovery_id: inst.recovery.recovery_id, install_id: inst.install_id, acked_install_seq: inst.acked_install_seq });
    } catch (e) {
      // A recovery opened by an earlier installation of this profile: start a new one under this one.
      if (e instanceof ApiError && e.status === 403) {
        await updateInstallation(db, account, (r) => (r.recovery = { recovery_id: uuid(), opened: false, finished: false }));
      }
      throw e;
    }
    inst = await updateInstallation(db, account, (r) => r.recovery && (r.recovery.opened = true));
  }
  const recoveryId = inst.recovery!.recovery_id;

  // 1. Inventory: which entries does the restored server lack?
  open.sort(receiptOrder);
  const need: RecoveryEntry[] = [];
  for (let i = 0; i < open.length; i += inventoryBound) {
    const batch = open.slice(i, i + inventoryBound);
    const res = await api.inventory({
      recovery_id: recoveryId,
      entries: batch.map((e) => ({ kind: "fact", op_id: e.op_id, content_hash: e.receipt!.content_hash, position: [e.receipt!.epoch, e.receipt!.seq, e.receipt!.index] })),
    });
    const byId = new Map(res.results.map((r) => [r.id, r.status]));
    for (const e of batch) {
      const status = byId.get(e.op_id);
      if (status === "have") {
        await change(db, e, recoveredRow);
        state.recovered++;
      } else if (status === "conflict") {
        await change(db, e, (row) => ({ ...row, recovery: { status } }));
      } else need.push(e);
    }
  }

  // 2. Upload in receipt order, so dependencies come first; entries waiting
  // for a dependency are sent again while a pass makes progress.
  let left = need;
  for (let pass = 0; left.length > 0 && pass < 8; pass++) {
    const before = left.length;
    const waiting: RecoveryEntry[] = [];
    for (let i = 0; i < left.length; ) {
      // A request holds what fits by its encoded size: each entry with its
      // complete receipt, and the secrets the batch carries once.
      const batch: RecoveryEntry[] = [];
      const secretIds = new Set<string>();
      let bytes = envelopeBytes;
      let framed = false;
      for (; i < left.length; i++) {
        const e = left[i]!;
        if (utf8(canonical(e.fact)).length > bounds.max_unframed_fact_bytes) {
          if (batch.length === 0) {
            batch.push(e);
            framed = true;
            i++;
          }
          break; // a framed fact goes alone, one part per request (uploadPart sizes its parts)
        }
        const fresh = (e.secrets ?? []).filter((x) => !secretIds.has(x.secret_id));
        const size = jsonBytes({ fact: e.fact, receipt: e.receipt }) + 1 + fresh.reduce((n, x) => n + jsonBytes(x) + 1, 0);
        if (envelopeBytes + size > bounds.max_request_bytes) {
          // The estimate only splits batches: the entry's own request, measured
          // as it would be sent, decides whether any request can hold it.
          if (jsonBytes(factsBody(recoveryId, [e])) > bounds.max_request_bytes) {
            await change(db, e, (row) => ({ ...row, recovery: { status: tooLarge } }));
            continue; // never sent: not even a request of its own can hold it
          }
          if (batch.length === 0) {
            batch.push(e);
            i++;
          }
          break; // it goes alone
        }
        if (batch.length >= bounds.max_operations || bytes + size > bounds.max_request_bytes) break;
        batch.push(e);
        for (const x of fresh) secretIds.add(x.secret_id);
        bytes += size;
      }
      if (batch.length === 0) continue; // only entries too large were left
      let results: Map<string, RecoveryResult>;
      if (framed) {
        // Part after part until the fact assembles (or the server refuses a part).
        const e = batch[0]!;
        results = await uploadPart(db, api, recoveryId, e, bounds);
        for (let k = 0; k < bounds.max_part_count && results.get(e.op_id)?.status === "part_stored"; k++) {
          results = await uploadPart(db, api, recoveryId, e, bounds);
        }
      } else results = await uploadFacts(api, recoveryId, batch);
      for (const e of batch) {
        const r = results.get(e.op_id);
        const status = r?.status ?? "invalid";
        if (recovered.has(status)) {
          await change(db, e, recoveredRow);
          state.recovered++;
        } else if (problems.has(status)) {
          await change(db, e, (row) => ({ ...row, recovery: { status } }));
        } else if (status === "dependency_missing") {
          await change(db, e, (row) => ({ ...row, recovery: { status, missing: r?.missing ?? [] } }));
          waiting.push(e);
        } else waiting.push(e); // part_stored, invalid_part: sent again
      }
    }
    left = waiting;
    if (left.length === before) break; // no progress this pass
  }

  const counted = await recoveryState(db, account);
  if (counted.pending === 0) {
    await api.finish({ recovery_id: recoveryId, complete: counted.problems === 0 });
    return { ...counted, recovered: state.recovered, done: await finished(db, account, attempt) };
  }
  // Entries still waiting for a dependency another device may restore: the
  // recovery stays open and is tried again later; the server records progress.
  await api.finish({ recovery_id: recoveryId, complete: false });
  return { ...counted, recovered: state.recovered, done: false };
}

/**
 * finished records an attempt's recovery as done, unless evidence was kept
 * for it after the attempt read what to send: then a new recovery is owed
 * that evidence (the server has this one finished), and the attempt is not done.
 */
async function finished(db: IDBDatabase, account: string, attempt: { id: string; evidence: number }): Promise<boolean> {
  let done = false;
  await updateInstallation(db, account, (r) => {
    if (r.recovery?.recovery_id !== attempt.id) return;
    if ((r.recovery.evidence ?? 0) === attempt.evidence) {
      r.recovery.finished = true;
      done = true;
    } else r.recovery = { recovery_id: uuid(), opened: false, finished: false };
  });
  return done;
}

/** jsonBytes is a value's size as a request carries it (JSON.stringify, UTF-8). */
const jsonBytes = (v: unknown) => utf8(JSON.stringify(v)).length;

/** envelopeBytes is the allowance batching makes for a request's own members (its recovery ID, brackets): an estimate, never a verdict. */
const envelopeBytes = 512;

function secretsOf(entries: RecoveryEntry[]): Secret[] {
  const out = new Map<string, Secret>();
  for (const e of entries) for (const s of e.secrets ?? []) out.set(s.secret_id, s);
  return [...out.values()];
}

/** factsBody is the upload request for whole facts, as it is sent: each with its receipt, and their secrets once. */
function factsBody(recoveryId: string, batch: RecoveryEntry[]): Record<string, unknown> {
  const body: Record<string, unknown> = { recovery_id: recoveryId, entries: batch.map((e) => ({ fact: e.fact, receipt: e.receipt as Receipt })) };
  const secrets = secretsOf(batch);
  if (secrets.length) body.secrets = secrets;
  return body;
}

async function uploadFacts(api: RecoveryTransport, recoveryId: string, batch: RecoveryEntry[]): Promise<Map<string, RecoveryResult>> {
  const res = await api.upload(factsBody(recoveryId, batch));
  return new Map(res.results.filter((r) => r.kind === "fact").map((r) => [r.id, r]));
}

/**
 * Framing is a framed fact's upload in progress: its transaction, the size
 * of its parts (kept with it, so a retry sends the same partition; absent:
 * the bound's, as before it was kept) and the parts the server holds.
 */
interface Framing {
  transaction_id: string;
  present: number[];
  part_bytes?: number;
}

interface Part {
  transaction_id: string;
  part_index: number;
  part_count: number;
  content_hash: string;
  data: string;
}

/** partBody is the upload request for one part of a framed fact, as it is sent: with the fact's receipt and secrets. */
function partBody(recoveryId: string, e: RecoveryEntry, part: Part): Record<string, unknown> {
  const body: Record<string, unknown> = { recovery_id: recoveryId, entries: [{ part, receipt: e.receipt }] };
  const secrets = secretsOf([e]);
  if (secrets.length) body.secrets = secrets;
  return body;
}

/** base64Length is the length of n bytes in unpadded base64url. */
const base64Length = (n: number) => Math.ceil((n * 4) / 3);

/**
 * fits tells whether every part's request fits the bound when a fact of
 * `length` bytes goes in parts of `size` bytes: the request with empty data,
 * measured once, plus each part's index and count digits and its data.
 */
function fits(base: number, length: number, size: number, bounds: Bounds): boolean {
  const count = Math.ceil(length / size);
  if (size > bounds.max_part_bytes || count > bounds.max_part_count) return false;
  const digits = (n: number) => String(n).length - 1; // over the one digit of the measured 0 and 1
  for (let i = 0; i < count; i++) {
    const data = Math.min(size, length - i * size);
    if (base + digits(i) + digits(count) + base64Length(data) > bounds.max_request_bytes) return false;
  }
  return true;
}

/**
 * partSize is the size of a framed fact's parts: the largest legal one (the
 * fewest parts) whose every request, receipt and secrets included, fits the
 * bound; null when no legal partition fits.
 */
function partSize(recoveryId: string, e: RecoveryEntry, length: number, hash: string, transaction: string, bounds: Bounds): number | null {
  const base = jsonBytes(partBody(recoveryId, e, { transaction_id: transaction, part_index: 0, part_count: 1, content_hash: hash, data: "" }));
  for (let count = Math.ceil(length / bounds.max_part_bytes); count <= bounds.max_part_count; count++) {
    const size = Math.ceil(length / count);
    if (fits(base, length, size, bounds)) return size;
  }
  return null;
}

/**
 * uploadPart sends the next missing part of a fact above the unframed bound,
 * with its receipt, in parts small enough for the request bound. A framing
 * whose parts no longer fit is started again; a fact no legal partition can
 * carry is too large.
 */
async function uploadPart(db: IDBDatabase, api: RecoveryTransport, recoveryId: string, e: RecoveryEntry, bounds: Bounds): Promise<Map<string, RecoveryResult>> {
  const bytes = utf8(canonical(e.fact));
  const hash = await contentHash(e.fact);
  let framing = e.recovery_framing;
  if (framing) {
    const base = jsonBytes(partBody(recoveryId, e, { transaction_id: framing.transaction_id, part_index: 0, part_count: 1, content_hash: hash, data: "" }));
    if (!fits(base, bytes.length, framing.part_bytes ?? bounds.max_part_bytes, bounds)) framing = undefined;
  }
  if (!framing) {
    const transaction = uuid();
    const size = partSize(recoveryId, e, bytes.length, hash, transaction, bounds);
    if (size === null) return new Map([[e.op_id, { kind: "fact", id: e.op_id, status: tooLarge }]]);
    const f: Framing = { transaction_id: transaction, present: [], part_bytes: size };
    framing = f;
    await change(db, e, (row) => ({ ...row, recovery_framing: f }));
    e.recovery_framing = f;
  }
  const size = framing.part_bytes ?? bounds.max_part_bytes;
  const count = Math.ceil(bytes.length / size);
  let index = 0;
  while (framing.present.includes(index) && index < count - 1) index++;
  const part: Part = {
    transaction_id: framing.transaction_id,
    part_index: index,
    part_count: count,
    content_hash: hash,
    data: base64url(bytes.subarray(index * size, (index + 1) * size)),
  };
  const res = await api.upload(partBody(recoveryId, e, part));
  const r = res.results.find((x) => x.id === e.op_id) ?? res.results[0];
  if (r?.status === "part_stored") {
    const kept: Framing = { ...framing, present: r.parts_present ?? [...framing.present, index] };
    await change(db, e, (row) => ({ ...row, recovery_framing: kept }));
    e.recovery_framing = kept;
  } else if (r?.status === "invalid_part") {
    await change(db, e, (row) => ({ ...row, recovery_framing: undefined }));
    e.recovery_framing = undefined;
  }
  return new Map([[e.op_id, { kind: "fact", id: e.op_id, status: r?.status ?? "invalid", missing: r?.missing }]]);
}

/** RecoveryProblem is a change this browser keeps because it could not go back to the restored server: what it was and why (never its secrets). */
export interface RecoveryProblem {
  op_id: string;
  type: string;
  reason: string;
  time: number;
}

/** recoveryProblems lists the changes kept as recovery problems (the Settings banner's count), in the order they were made. */
export async function recoveryProblems(db: IDBDatabase, account: string): Promise<RecoveryProblem[]> {
  return (await retained(db, account))
    .filter((e) => e.recovery && problems.has(e.recovery.status))
    .sort(receiptOrder)
    .map((e) => ({ op_id: e.op_id, type: e.fact.type, reason: e.recovery!.status, time: e.fact.client_time }));
}
