// The durable pending-write journal (PROTOCOL §12): every action is
// a fact committed here before the UI calls it done; a reload or a closed tab
// loses nothing, and the next page load pushes what is left. The transport
// slot (install_seq) and the tab author's sequence are allocated in the same
// IndexedDB transaction that appends the entry, so tabs never hand out the
// same counter twice (PROTOCOL §12).
import { req, tx, type AuthorRow, type EntryRow, type Fact, type InstallationRow, type Receipt, type Secret } from "./db.ts";
import { canonical, utf8 } from "./jcs.ts";
import { uuid as randomUUID } from "../util/random.ts";

/** maxFactBytes is the largest fact the server accepts (`max_framed_fact_bytes`, PROTOCOL §6.13), in canonical bytes. */
export const maxFactBytes = 8 << 20;

/** maxUnframedFactBytes is the largest fact sent whole, unframed (`max_unframed_fact_bytes`, PROTOCOL §6.13). */
export const maxUnframedFactBytes = 256 << 10;

/**
 * FactTooLarge refuses an action no fact the server accepts can hold: it is
 * not journaled, so it never stands in front of later changes (a list's
 * actions are split into facts that fit; see actions.ts).
 */
export class FactTooLarge extends Error {
  constructor() {
    super("journal: a fact is larger than the server accepts");
  }
}

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

export type Lineages = Pick<InstallationRow, "lineage" | "retired_lineages">;
type LineageOf = { log_id: string; epoch: number };

/**
 * staleLineage tells whether a head belongs to a lineage the profile has
 * left: an older epoch of its log (the server was restored since), or a
 * retired one. Such a view is a late answer and is never used.
 */
export function staleLineage(l: Lineages, head: LineageOf): boolean {
  if (l.lineage && l.lineage.log_id === head.log_id && head.epoch < l.lineage.epoch) return true;
  return (l.retired_lineages ?? []).some((r) => r.log_id === head.log_id && head.epoch <= r.epoch);
}

/** acceptedLineage tells whether a head is of the profile's lineage (any lineage not stale while none is known yet). */
export function acceptedLineage(l: Lineages, head: LineageOf): boolean {
  if (staleLineage(l, head)) return false;
  return !l.lineage || (l.lineage.log_id === head.log_id && l.lineage.epoch === head.epoch);
}

/** lineages reads the profile's accepted and retired lineages for the account. */
export async function lineages(db: IDBDatabase, account: string): Promise<Lineages> {
  return tx(db, ["installations"], "readonly", async (t) => {
    const row = (await req(t.objectStore("installations").get(account))) as InstallationRow | undefined;
    return { lineage: row?.lineage ?? null, retired_lineages: row?.retired_lineages ?? [] };
  });
}

/** retireLineage moves the profile to a new lineage, keeping the one it leaves (or a successor left) as retired. */
export function retireLineage(r: InstallationRow, next: LineageOf): void {
  const old = r.lineage ?? r.left;
  delete r.left;
  if (old && (old.log_id !== next.log_id || old.epoch !== next.epoch)) {
    r.retired_lineages = [...(r.retired_lineages ?? []).filter((x) => x.log_id !== old.log_id || x.epoch !== old.epoch), { ...old }];
  }
  r.lineage = { log_id: next.log_id, epoch: next.epoch };
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

/** appendAll journals facts in order in one transaction: all of them, or (a refusal) none. */
export async function appendAll(db: IDBDatabase, account: string, authorId: string, bodies: FactBody[], now = Date.now()): Promise<EntryRow[]> {
  return tx(db, journalStores, "readwrite", async (t) => {
    const out: EntryRow[] = [];
    for (const body of bodies) out.push(await appendIn(t, account, authorId, body, now));
    return out;
  });
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
  if (utf8(canonical(fact)).length > maxFactBytes) throw new FactTooLarge();
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

/**
 * replaceEntry replaces an unsent entry no request can carry (an action an
 * earlier version journaled as one fact) by the facts of the same action that
 * fit (actions.resplit), in one transaction: they take its slot and its place
 * in its author's chain, and every later entry moves up behind them, its
 * author position and its link to the replaced fact renumbered. None of those
 * was sent: nothing is sent past an unsent slot. It returns false when it
 * cannot (a part still too large, a later entry already answered), leaving
 * the journal as it was; true when it replaced the entry, or when the entry
 * is no longer there to replace (another tab did it).
 */
export async function replaceEntry(db: IDBDatabase, account: string, old: EntryRow, bodies: FactBody[]): Promise<boolean> {
  return tx(db, journalStores, "readwrite", async (t) => {
    const journal = t.objectStore("journal");
    const insts = t.objectStore("installations");
    const authors = t.objectStore("authors");
    const inst = (await req(insts.get(account))) as InstallationRow | undefined;
    const cur = (await req(journal.get([account, old.install_seq]))) as EntryRow | undefined;
    if (!inst || !cur || cur.op_id !== old.op_id || cur.receipt) return true;
    const later = (await req(journal.getAll(IDBKeyRange.bound([account, cur.install_seq + 1], [account, Number.MAX_SAFE_INTEGER])))) as EntryRow[];
    if (bodies.length === 0 || later.some((e) => e.receipt || e.install_id !== cur.install_id)) return false;
    const f = cur.fact;
    const parts: Fact[] = [];
    let previous = f.previous_op_id;
    for (const body of bodies) {
      const fact: Fact = {
        op_id: uuid(),
        author_id: f.author_id,
        author_seq: f.author_seq + parts.length,
        dependencies: sortedUnique([...(body.dependencies ?? []), ...(previous ? [previous] : [])]),
        type: body.type,
        type_version: body.type_version ?? f.type_version,
        client_time: f.client_time,
        targets: body.targets,
        payload: body.payload,
      };
      if (previous) fact.previous_op_id = previous;
      if (utf8(canonical(fact)).length > maxFactBytes) return false;
      parts.push(fact);
      previous = fact.op_id;
    }
    const last = parts[parts.length - 1]!.op_id;
    const shift = parts.length - 1;
    await req(journal.delete([account, cur.install_seq]));
    for (const e of later) await req(journal.delete([account, e.install_seq]));
    for (const [i, fact] of parts.entries()) {
      const entry: EntryRow = { account_id: account, install_seq: cur.install_seq + i, install_id: cur.install_id, op_id: fact.op_id, fact, receipt: null, receipt_lineage: null, waiting: null, created_at: cur.created_at };
      if (i === 0 && cur.secrets?.length) entry.secrets = cur.secrets;
      if (cur.awaited) entry.awaited = true;
      await req(journal.add(entry));
    }
    for (const e of later) {
      const fact: Fact = { ...e.fact, dependencies: sortedUnique(e.fact.dependencies.map((d) => (d === f.op_id ? last : d))) };
      if (fact.previous_op_id === f.op_id) fact.previous_op_id = last;
      if (fact.author_id === f.author_id && fact.author_seq > f.author_seq) fact.author_seq += shift;
      const { framing: _, ...moved } = e; // a new slot is a new framing transaction
      await req(journal.add({ ...moved, install_seq: e.install_seq + shift, fact, waiting: null }));
    }
    inst.next_install_seq += shift;
    await req(insts.put(inst));
    const author = (await req(authors.get(f.author_id))) as AuthorRow | undefined;
    if (author) {
      if (author.next_seq > f.author_seq) author.next_seq += shift;
      if (author.last_op_id === f.op_id) author.last_op_id = last;
      await req(authors.put(author));
    }
    return true;
  });
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
      // its fact under the predecessor's slot, and acknowledges nothing here. Its recovery is
      // owed from this transaction on: a new one if the last finished, else one more piece of
      // evidence the open one must not finish without.
      if (inst.predecessors.includes(installId)) {
        const byOp = journal.index("op");
        let kept = 0;
        for (const r of receipts) {
          const e = (await req(byOp.get([account, r.receipt.op_id]))) as EntryRow | undefined;
          if (!e) continue;
          const row: EntryRow = { ...e, install_id: installId, install_seq: r.install_seq, receipt: r.receipt, receipt_lineage: lineage, waiting: null };
          delete row.framing;
          await req(t.objectStore("retained").put(row));
          kept++;
        }
        if (kept) {
          inst.recovery = !inst.recovery || inst.recovery.finished
            ? { recovery_id: uuid(), opened: false, finished: false }
            : { ...inst.recovery, evidence: (inst.recovery.evidence ?? 0) + 1 };
          await req(insts.put(inst));
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
