// Pushing the journal (PROTOCOL §6.4 rules, as phones push): contiguous
// install_seq from the acknowledged prefix, receipts stored durably, gaps
// repaired from the server's watermark, dependency_missing waited for,
// version_unsupported pausing pushes while reads continue, and facts above
// the unframed bound sent in parts, one part per request.
import { ApiError } from "../api/http.ts";
import { resplit } from "../app/actions.ts";
import { req, tx, type EntryRow, type InstallationRow, type Receipt } from "./db.ts";
import { acknowledge, framingOf, markWaiting, maxFactBytes, maxUnframedFactBytes, recordParts, replaceEntry, unacknowledged, updateInstallation } from "./journal.ts";
import { base64url, canonical, contentHash, utf8 } from "./jcs.ts";

export interface PushResult {
  install_seq: number;
  status: string;
  receipt?: Receipt;
  missing?: string[];
  parts_present?: number[];
}

export interface PushResponse {
  head: string;
  install_watermark: number;
  results: PushResult[];
}

export interface Bounds {
  max_operations: number;
  max_request_bytes: number;
  max_unframed_fact_bytes: number;
  max_part_bytes: number;
  max_part_count: number;
  max_framed_fact_bytes?: number; // absent: max_part_count parts
}

export const defaultBounds: Bounds = {
  max_operations: 500,
  max_request_bytes: 4 << 20,
  max_unframed_fact_bytes: maxUnframedFactBytes,
  max_part_bytes: 256 << 10,
  max_part_count: 64,
  max_framed_fact_bytes: maxFactBytes,
};

export type Transport = (body: Record<string, unknown>) => Promise<PushResponse>;

export interface PushOutcome {
  acknowledged: number;
  remaining: number;
  waiting: string[] | null; // dependencies the server waits for
  /** too_large: an unsent entry no request can carry, of an action that cannot be split; it and the entries after it are kept. */
  stopped: null | "paused" | "no_cursor" | "unregistered" | "conflict" | "lineage_mismatch" | "lineage_unknown" | "too_large";
  partsStored?: boolean; // a framed fact made progress
}

/**
 * decodeCursor reads a cursor's lineage and position. A cursor is strict
 * base64url of exactly the canonical JSON of {log_id, epoch, seq, digest}
 * (PROTOCOL §3.2); anything else is refused, so a malformed head never
 * becomes a receipt's lineage.
 */
export function decodeCursor(cursor: string): { log_id: string; epoch: number; seq: number } {
  const refuse = (): never => {
    throw new Error("journal: the server's cursor is not a contract-v1 cursor");
  };
  if (!/^[A-Za-z0-9_-]*$/.test(cursor) || cursor.length % 4 === 1) refuse();
  const b64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
  if (base64url(bytes) !== cursor) refuse(); // non-zero unused trailing bits
  let json = "";
  let v: Record<string, unknown> = {};
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    v = JSON.parse(json) as Record<string, unknown>;
  } catch {
    refuse();
  }
  const ok =
    typeof v === "object" && v !== null && !Array.isArray(v) &&
    Object.keys(v).length === 4 &&
    typeof v.log_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v.log_id) &&
    Number.isSafeInteger(v.epoch) && (v.epoch as number) >= 0 &&
    Number.isSafeInteger(v.seq) && (v.seq as number) >= 0 &&
    typeof v.digest === "string" && /^[0-9a-f]{64}$/.test(v.digest) &&
    canonical(v) === json; // exactly the canonical bytes: member order, no whitespace, no duplicates
  if (!ok) refuse();
  return { log_id: v.log_id as string, epoch: v.epoch as number, seq: v.seq as number };
}

/** sendable tells whether a fact of this many canonical bytes fits the server's framing bounds. */
const sendable = (size: number, bounds: Bounds) => Math.ceil(size / bounds.max_part_bytes) <= bounds.max_part_count && size <= (bounds.max_framed_fact_bytes ?? Infinity);

async function partsOf(db: IDBDatabase, e: EntryRow, bounds: Bounds): Promise<{ transaction_id: string; present: number[]; hash: string; parts: Uint8Array[] }> {
  const bytes = utf8(canonical(e.fact));
  const parts: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += bounds.max_part_bytes) parts.push(bytes.subarray(i, i + bounds.max_part_bytes));
  const f = await framingOf(db, e.account_id, e.install_seq);
  if (!f) throw new Error("journal: the entry is gone");
  return { transaction_id: f.transaction_id, present: f.present, hash: await contentHash(e.fact), parts };
}

/**
 * pushOnce sends one request of the account's unacknowledged entries and
 * records the results. Call it again while it acknowledges or stores parts.
 */
export async function pushOnce(db: IDBDatabase, account: string, send: Transport, bounds: Bounds = defaultBounds): Promise<PushOutcome> {
  const inst = (await tx(db, ["installations"], "readonly", (t) => req(t.objectStore("installations").get(account)))) as
    | InstallationRow
    | undefined;
  const out: PushOutcome = { acknowledged: 0, remaining: 0, waiting: null, stopped: null };
  if (!inst || !inst.registered) return { ...out, stopped: "unregistered" };
  const pending = (await unacknowledged(db, account)).filter((e) => e.install_id === inst.install_id && e.install_seq > inst.acked_install_seq);
  out.remaining = pending.length;
  if (pending.length === 0) return out;
  if (inst.paused) return { ...out, stopped: "paused" };
  if (!inst.cursor) return { ...out, stopped: "no_cursor" };

  // One request: whole facts in slot order, or one part of a framed fact.
  const operations: Record<string, unknown>[] = [];
  let bytes = 512;
  for (const e of pending) {
    const size = utf8(canonical(e.fact)).length;
    if (size > bounds.max_unframed_fact_bytes) {
      if (operations.length > 0) break; // a framed fact goes alone
      if (!sendable(size, bounds)) {
        // An action an earlier version journaled as one fact, before list actions
        // were split: it becomes the facts this version journals for it, in its
        // place, and is sent as they are. One that cannot be split is kept, and
        // so is everything after it; the tab says the changes cannot be sent.
        const parts = resplit(e.fact);
        if (!parts || !(await replaceEntry(db, account, e, parts))) return { ...out, stopped: "too_large" };
        return pushOnce(db, account, send, bounds);
      }
      const { transaction_id, present, hash, parts } = await partsOf(db, e, bounds);
      const index = parts.findIndex((_, i) => !present.includes(i));
      const i = index < 0 ? parts.length - 1 : index;
      operations.push({
        install_seq: e.install_seq,
        part: { transaction_id, part_index: i, part_count: parts.length, content_hash: hash, data: base64url(parts[i]!) },
      });
      break;
    }
    if (operations.length >= bounds.max_operations || bytes + size + 64 > bounds.max_request_bytes) break;
    operations.push({ install_seq: e.install_seq, fact: e.fact });
    bytes += size + 64;
  }

  const secrets = pending
    .filter((e) => operations.some((o) => o.install_seq === e.install_seq))
    .flatMap((e) => e.secrets ?? []);
  const body: Record<string, unknown> = { cursor: inst.cursor, install_id: inst.install_id, acked_install_seq: inst.acked_install_seq, operations };
  if (secrets.length) body.secrets = secrets;
  let res: PushResponse;
  try {
    res = await send(body);
  } catch (e) {
    if (e instanceof ApiError) {
      switch (e.code) {
        case "lineage_mismatch":
          return { ...out, stopped: "lineage_mismatch" };
        case "lineage_unknown":
          await updateInstallation(db, account, (r) => (r.paused = "lineage_unknown"));
          return { ...out, stopped: "lineage_unknown" };
        case "installation_superseded":
          return { ...out, stopped: "conflict" };
      }
    }
    throw e;
  }
  const lineage = decodeCursor(res.head);
  let partsStored = false;
  const receipts: { install_seq: number; receipt: Receipt }[] = [];
  for (const r of res.results) {
    switch (r.status) {
      case "accepted":
      case "duplicate":
        if (r.receipt) receipts.push({ install_seq: r.install_seq, receipt: r.receipt });
        break;
      case "part_stored":
        await recordParts(db, account, inst.install_id, r.install_seq, r.parts_present ?? []);
        partsStored = true;
        break;
      case "dependency_missing":
        out.waiting = r.missing ?? [];
        await markWaiting(db, account, r.install_seq, out.waiting);
        break;
      case "version_unsupported":
        await updateInstallation(db, account, (row) => (row.paused = "version_unsupported"));
        out.stopped = "paused";
        break;
      case "gap":
        // The server consumed less than we believe: push again from its watermark.
        await updateInstallation(db, account, (row) => {
          row.acked_install_seq = Math.min(row.acked_install_seq, res.install_watermark);
        });
        break;
      case "installation_conflict":
        out.stopped = "conflict";
        break;
      case "invalid_part":
        break;
      default: // op_id_conflict: another fact holds this ID; a bug, kept for diagnosis
        out.waiting = [];
    }
  }
  if (receipts.length) {
    await acknowledge(db, account, receipts, lineage, inst.install_id);
    out.acknowledged = receipts.length;
  }
  out.remaining -= receipts.length;
  out.partsStored = partsStored;
  return out;
}

/** pushAll pushes until nothing more can be pushed now. */
export async function pushAll(db: IDBDatabase, account: string, send: Transport, bounds: Bounds = defaultBounds): Promise<PushOutcome> {
  let last: PushOutcome = { acknowledged: 0, remaining: 0, waiting: null, stopped: null };
  for (let i = 0; i < 200; i++) {
    last = await pushOnce(db, account, send, bounds);
    const progressed = last.acknowledged > 0 || last.partsStored || last.remaining === 0;
    if (last.stopped || last.waiting || last.remaining === 0 || !progressed) break;
  }
  return last;
}
