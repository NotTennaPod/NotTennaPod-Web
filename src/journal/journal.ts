// The durable pending-write journal (PROTOCOL §12): every action is
// a fact committed here before the UI calls it done; a reload or a closed tab
// loses nothing, and the next page load pushes what is left. The transport
// slot (install_seq) and the tab author's sequence are allocated in the same
// IndexedDB transaction that appends the entry, so tabs never hand out the
// same counter twice (PROTOCOL §12).
import { req, tx, type AuthorRow, type EntryRow, type Fact, type InstallationRow, type Receipt, type Secret } from "./db.ts";
import { uuid as randomUUID } from "../util/random.ts";

/** FactBody is an action to journal; awaited marks one whose tab shows its outcome (a refusal's snackbar). */
export type FactBody = Pick<Fact, "type" | "targets" | "payload"> & { type_version?: number; dependencies?: string[]; secrets?: Secret[]; awaited?: boolean };

export function uuid(): string {
  return randomUUID();
}

/** installation returns the profile's installation for the account, creating it unregistered. */
export async function installation(db: IDBDatabase, account: string): Promise<InstallationRow> {
  return tx(db, ["installations"], "readwrite", async (t) => {
    const store = t.objectStore("installations");
    const found = (await req(store.get(account))) as InstallationRow | undefined;
    if (found) return found;
    const row: InstallationRow = {
      account_id: account,
      install_id: uuid(),
      instance_nonce: uuid(),
      next_install_seq: 1,
      acked_install_seq: 0,
      registered: false,
      cursor: null,
      lineage: null,
      paused: null,
      predecessors: [],
    };
    await req(store.put(row));
    return row;
  });
}

/** updateInstallation changes the account's installation row in one transaction. */
export async function updateInstallation(
  db: IDBDatabase,
  account: string,
  change: (row: InstallationRow) => void,
): Promise<InstallationRow> {
  return tx(db, ["installations"], "readwrite", async (t) => {
    const store = t.objectStore("installations");
    const row = (await req(store.get(account))) as InstallationRow | undefined;
    if (!row) throw new Error("journal: no installation");
    change(row);
    await req(store.put(row));
    return row;
  });
}

/** newAuthor gives this tab load its own author (PROTOCOL §12). */
export async function newAuthor(db: IDBDatabase, account: string, now = Date.now()): Promise<AuthorRow> {
  const row: AuthorRow = { author_id: uuid(), account_id: account, next_seq: 1, last_op_id: null, created_at: now };
  await tx(db, ["authors"], "readwrite", (t) => req(t.objectStore("authors").put(row)));
  return row;
}

function sortedUnique(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * append journals one fact by the author: its op ID, author position and
 * transport slot are allocated in the same transaction. The fact depends on
 * the author's previous fact and on the given dependencies.
 */
export async function append(db: IDBDatabase, account: string, authorId: string, body: FactBody, now = Date.now()): Promise<EntryRow> {
  return tx(db, journalStores, "readwrite", (t) => appendIn(t, account, authorId, body, now));
}

/** The stores appendIn needs in its transaction. */
export const journalStores = ["installations", "authors", "journal"];

/**
 * appendIn is append inside a caller's readwrite transaction (which must
 * include journalStores), so other writes commit atomically with the entry
 * (a session export and its watermark, PROTOCOL §12).
 */
export async function appendIn(t: IDBTransaction, account: string, authorId: string, body: FactBody, now = Date.now()): Promise<EntryRow> {
  const insts = t.objectStore("installations");
  const authors = t.objectStore("authors");
  const inst = (await req(insts.get(account))) as InstallationRow | undefined;
  const author = (await req(authors.get(authorId))) as AuthorRow | undefined;
  if (!inst) throw new Error("journal: no installation");
  if (!author || author.account_id !== account) throw new Error("journal: the author belongs to another account");
  const deps = [...(body.dependencies ?? [])];
  if (author.last_op_id) deps.push(author.last_op_id);
  const fact: Fact = {
    op_id: uuid(),
    author_id: author.author_id,
    author_seq: author.next_seq,
    dependencies: sortedUnique(deps),
    type: body.type,
    type_version: body.type_version ?? 1,
    client_time: now,
    targets: body.targets,
    payload: body.payload,
  };
  if (author.last_op_id) fact.previous_op_id = author.last_op_id;
  const entry: EntryRow = {
    account_id: account,
    install_seq: inst.next_install_seq,
    install_id: inst.install_id,
    op_id: fact.op_id,
    fact,
    receipt: null,
    receipt_lineage: null,
    waiting: null,
    created_at: now,
  };
  if (body.secrets?.length) entry.secrets = body.secrets;
  if (body.awaited) entry.awaited = true;
  await req(t.objectStore("journal").add(entry));
  inst.next_install_seq++;
  author.next_seq++;
  author.last_op_id = fact.op_id;
  await req(insts.put(inst));
  await req(authors.put(author));
  return entry;
}

/** entries returns the account's journal in slot order. */
export async function entries(db: IDBDatabase, account: string): Promise<EntryRow[]> {
  return tx(db, ["journal"], "readonly", async (t) => {
    const range = IDBKeyRange.bound([account, 0], [account, Number.MAX_SAFE_INTEGER]);
    return (await req(t.objectStore("journal").getAll(range))) as EntryRow[];
  });
}

/** unacknowledged returns the entries the server has not acknowledged, in slot order. */
export async function unacknowledged(db: IDBDatabase, account: string): Promise<EntryRow[]> {
  return (await entries(db, account)).filter((e) => !e.receipt);
}

/**
 * acknowledge stores receipts and advances the contiguous acknowledged
 * prefix. installId is the installation the request was sent under: a late
 * answer to a predecessor's request acknowledges nothing of its successor's.
 */
export async function acknowledge(
  db: IDBDatabase,
  account: string,
  receipts: { install_seq: number; receipt: Receipt }[],
  lineage: { log_id: string; epoch: number },
  installId?: string,
): Promise<InstallationRow> {
  return tx(db, ["installations", "journal", "retained"], "readwrite", async (t) => {
    const journal = t.objectStore("journal");
    const insts = t.objectStore("installations");
    const inst = (await req(insts.get(account))) as InstallationRow;
    if (installId !== undefined && installId !== inst.install_id) {
      // A predecessor's late receipt is recovery evidence (PROTOCOL §6.11): it is kept with
      // its fact under the predecessor's slot, and acknowledges nothing here.
      if (inst.predecessors.includes(installId)) {
        const byOp = journal.index("op");
        for (const r of receipts) {
          const e = (await req(byOp.get([account, r.receipt.op_id]))) as EntryRow | undefined;
          if (!e) continue;
          const kept: EntryRow = { ...e, install_id: installId, install_seq: r.install_seq, receipt: r.receipt, receipt_lineage: lineage, waiting: null };
          delete kept.framing;
          await req(t.objectStore("retained").put(kept));
        }
      }
      return inst;
    }
    for (const r of receipts) {
      const e = (await req(journal.get([account, r.install_seq]))) as EntryRow | undefined;
      if (!e || e.install_id !== inst.install_id || e.op_id !== r.receipt.op_id) continue;
      e.receipt = r.receipt;
      e.receipt_lineage = lineage;
      e.waiting = null;
      delete e.framing;
      await req(journal.put(e)); // secrets stay until the entry is retired (recovery may need them)
    }
    // The acknowledged prefix: every slot up to it has a receipt (or was retired).
    let acked = inst.acked_install_seq;
    while (acked + 1 < inst.next_install_seq) {
      const e = (await req(journal.get([account, acked + 1]))) as EntryRow | undefined;
      if (e && !e.receipt) break;
      acked++;
    }
    inst.acked_install_seq = acked;
    await req(insts.put(inst));
    return inst;
  });
}

/** markWaiting records that the server waits for dependencies it does not hold (PROTOCOL §12). */
export async function markWaiting(db: IDBDatabase, account: string, installSeq: number, missing: string[]): Promise<void> {
  await tx(db, ["journal"], "readwrite", async (t) => {
    const journal = t.objectStore("journal");
    const e = (await req(journal.get([account, installSeq]))) as EntryRow | undefined;
    if (!e) return;
    e.waiting = missing;
    await req(journal.put(e));
  });
}

/** outcomeKeepMs bounds how long a refusal waits for a tab that made it and closed before showing it. */
export const outcomeKeepMs = 24 * 3600_000;

/** refusal tells whether a receipt refused the action: the tab that made it says so (PROTOCOL §12). */
export function refusal(r: Receipt | null): boolean {
  return r?.outcome === "not_applied" || r?.outcome === "rejected";
}

/** keptForOutcome tells whether an acknowledged entry stays for the tab that made it: a refusal it awaits and has not shown, for a day at most. */
export function keptForOutcome(e: EntryRow, now: number): boolean {
  return !!e.awaited && refusal(e.receipt) && now - e.created_at < outcomeKeepMs;
}

/**
 * awaitingOutcome is the recovery status of a kept-aside entry the restored
 * server has, kept only until its tab shows its refusal (keptForOutcome):
 * recovery has nothing more to do with it.
 */
export const awaitingOutcome = "awaiting_outcome";

type Retained = EntryRow & { recovery?: { status: string } };

/**
 * retire drops entries a view has shown the effect of: their receipt is of
 * the shown head's lineage and at or before it (PROTOCOL §12). A refusal whose tab
 * waits for it stays until that tab has shown it (outcomeShown), whichever
 * tab pushed it, or for outcomeKeepMs; one a restore's recovery kept for it
 * goes the same way. It returns how many journal entries it dropped.
 */
export async function retire(db: IDBDatabase, account: string, head: { log_id: string; epoch: number; seq: number }, now = Date.now()): Promise<number> {
  return tx(db, ["journal", "installations", "retained"], "readwrite", async (t) => {
    const kept = t.objectStore("retained");
    for (const e of (await req(kept.getAll())) as Retained[]) {
      if (e.account_id === account && e.recovery?.status === awaitingOutcome && !keptForOutcome(e, now)) await req(kept.delete([e.account_id, e.install_id, e.install_seq]));
    }
    const journal = t.objectStore("journal");
    const inst = (await req(t.objectStore("installations").get(account))) as InstallationRow | undefined;
    const range = IDBKeyRange.bound([account, 0], [account, Number.MAX_SAFE_INTEGER]);
    const all = (await req(journal.getAll(range))) as EntryRow[];
    let n = 0;
    for (const e of all) {
      const r = e.receipt;
      const l = e.receipt_lineage;
      if (!r || !l || l.log_id !== head.log_id || l.epoch !== head.epoch || r.seq > head.seq) continue;
      if (inst && e.install_id === inst.install_id && e.install_seq > inst.acked_install_seq) continue;
      if (keptForOutcome(e, now)) continue;
      await req(journal.delete([account, e.install_seq]));
      n++;
    }
    return n;
  });
}

/**
 * outcomeShown records that the tab that made an action has its outcome:
 * retirement may drop it now, and a restore's recovery drops it once the
 * server has it (or at once, if recovery kept it only for this).
 */
export async function outcomeShown(db: IDBDatabase, account: string, opId: string): Promise<void> {
  await tx(db, ["journal", "retained"], "readwrite", async (t) => {
    const journal = t.objectStore("journal");
    const e = (await req(journal.index("op").get([account, opId]))) as EntryRow | undefined;
    if (e?.awaited) {
      delete e.awaited;
      await req(journal.put(e));
    }
    const kept = t.objectStore("retained");
    for (const r of (await req(kept.getAll())) as Retained[]) {
      if (r.account_id !== account || r.op_id !== opId) continue;
      if (r.recovery?.status === awaitingOutcome) await req(kept.delete([r.account_id, r.install_id, r.install_seq]));
      else if (r.awaited) {
        delete r.awaited;
        await req(kept.put(r));
      }
    }
  });
}

/** pendingCount is how many of the account's actions are not yet acknowledged. */
export async function pendingCount(db: IDBDatabase, account: string): Promise<number> {
  return (await unacknowledged(db, account)).length;
}

/** framingOf returns the entry's framing transaction, allocating it once across tabs (it is never reframed). */
export async function framingOf(db: IDBDatabase, account: string, installSeq: number): Promise<{ transaction_id: string; present: number[] } | null> {
  return tx(db, ["journal"], "readwrite", async (t) => {
    const journal = t.objectStore("journal");
    const e = (await req(journal.get([account, installSeq]))) as EntryRow | undefined;
    if (!e) return null;
    if (!e.framing) {
      e.framing = { transaction_id: uuid(), present: [] };
      await req(journal.put(e));
    }
    return e.framing;
  });
}

/** recordParts records the parts the server holds for a framed entry. */
export async function recordParts(db: IDBDatabase, account: string, installId: string, installSeq: number, present: number[]): Promise<void> {
  await tx(db, ["journal"], "readwrite", async (t) => {
    const journal = t.objectStore("journal");
    const e = (await req(journal.get([account, installSeq]))) as EntryRow | undefined;
    if (!e || e.install_id !== installId || !e.framing) return;
    e.framing.present = [...new Set([...e.framing.present, ...present])].sort((a, b) => a - b);
    await req(journal.put(e));
  });
}
