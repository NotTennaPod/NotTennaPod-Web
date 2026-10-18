// Taking a successor installation (PROTOCOL §5, §12):
// after the server was restored from a backup (lineage_mismatch), or when
// another profile shares this one's transport (a copied profile), the browser
// continues under a new installation. Unacknowledged facts are renumbered
// from 1 in their order, unchanged (IDs, authors, dependencies); facts
// already acknowledged are kept aside with their receipts for recovery
// upload. The successor's IDs are recorded before the request, so a reload
// in the middle repeats the same handoff.
import { req, tx, type EntryRow, type InstallationRow } from "./db.ts";
import { uuid } from "./journal.ts";

export type SuccessorRequest = (body: {
  install_id: string;
  instance_nonce: string;
  device: { name: string; app_version: string; capabilities: string[] };
}) => Promise<unknown>;

export interface SuccessorPlan {
  /** freshNonce: a copied profile takes a new nonce; after a restore the profile keeps its own. */
  freshNonce: boolean;
  /**
   * recovery: after a restore, record the recovery in the same transaction
   * as the plan, so no tab can see the recovery without its handoff and judge
   * it empty before the entries are moved aside.
   */
  recovery?: boolean;
  /** head: the lineage a restore moves to, when a view of it was shown. */
  head?: { cursor: string; log_id: string; epoch: number };
}

export interface SuccessorOptions extends SuccessorPlan {
  device: { name: string; app_version: string; capabilities: string[] };
  /**
   * from is the installation the caller saw and means to replace: when another
   * tab has replaced it meanwhile (the profile has another installation and no
   * handoff in progress), nothing is taken, so one lineage change or copied
   * profile takes one successor whichever tabs see it.
   */
  from: string;
  /**
   * registered: finish only this plan, which the server has registered (no
   * request is made): when another tab finished it, or the profile has no such
   * plan, nothing is taken and the profile's installation is returned as it is.
   */
  registered?: string;
}

/**
 * planSuccessor records a successor's plan in the caller's transaction, so a
 * transition that needs one commits with it (or adds the head a view showed to
 * a restore's plan under way).
 */
export function planSuccessor(inst: InstallationRow, plan: SuccessorPlan): void {
  if (!inst.successor) {
    inst.successor = { install_id: uuid(), instance_nonce: plan.freshNonce ? uuid() : inst.instance_nonce, ...(plan.head ? { head: plan.head } : {}) };
  } else if (plan.head && !inst.successor.head && inst.successor.instance_nonce === inst.instance_nonce) {
    inst.successor.head = plan.head;
  }
  // A restore's recovery joins whatever plan is under way (a copied profile's too), keeping its IDs.
  if (plan.recovery && (!inst.recovery || inst.recovery.finished)) inst.recovery = { recovery_id: uuid(), opened: false, finished: false };
}

/** SuccessorBusy: another tab of the profile is registering the planned successor; ask again later. */
export class SuccessorBusy extends Error {}

/**
 * sendLeaseMs is how long a tab's claim to register a plan lasts: a tab that
 * closed while registering leaves it to another tab after this.
 */
export const sendLeaseMs = 60_000;

export async function takeSuccessor(db: IDBDatabase, account: string, send: SuccessorRequest, opts: SuccessorOptions): Promise<InstallationRow> {
  // 1. Choose the successor's IDs durably (or reuse a handoff in progress),
  // and claim its registration: the server answers a repeat with a new
  // credential that revokes the one it issued before, so tabs never overlap.
  let current: InstallationRow | undefined;
  let busy = false;
  const claim = uuid();
  const planned = await tx(db, ["installations"], "readwrite", async (t) => {
    const store = t.objectStore("installations");
    const inst = (await req(store.get(account))) as InstallationRow | undefined;
    if (!inst) throw new Error("journal: no installation");
    current = inst;
    if (opts.registered !== undefined ? inst.successor?.install_id !== opts.registered : !inst.successor && opts.from !== inst.install_id) return null; // another tab took it
    if (!inst.successor) planSuccessor(inst, opts);
    const plan = inst.successor!;
    if (opts.registered === undefined) {
      const now = Date.now();
      if (plan.sending && plan.sending.until > now) {
        busy = true;
        return null;
      }
      plan.sending = { by: claim, until: now + sendLeaseMs };
    }
    await req(store.put(inst));
    return plan;
  });
  if (busy) throw new SuccessorBusy("another tab is registering the successor");
  if (!planned) return current!;
  // 2. Register it; the server binds this browser's session to it.
  try {
    await send({ install_id: planned.install_id, instance_nonce: planned.instance_nonce, device: opts.device });
  } catch (e) {
    // Not registered here: the next attempt (any tab's) may send it at once.
    await tx(db, ["installations"], "readwrite", async (t) => {
      const inst = (await req(t.objectStore("installations").get(account))) as InstallationRow | undefined;
      if (inst?.successor?.sending?.by !== claim) return;
      delete inst.successor.sending;
      await req(t.objectStore("installations").put(inst));
    });
    throw e;
  }
  // 3. Renumber in one transaction.
  return tx(db, ["installations", "journal", "retained"], "readwrite", async (t) => {
    const insts = t.objectStore("installations");
    const journal = t.objectStore("journal");
    const retained = t.objectStore("retained");
    const inst = (await req(insts.get(account))) as InstallationRow;
    const plan = inst.successor;
    if (!plan || plan.install_id !== planned.install_id) return inst; // another tab finished it
    const range = IDBKeyRange.bound([account, 0], [account, Number.MAX_SAFE_INTEGER]);
    const all = (await req(journal.getAll(range))) as EntryRow[];
    let next = 1;
    for (const e of all) {
      await req(journal.delete([account, e.install_seq]));
      if (e.receipt) {
        await req(retained.put(e));
        continue;
      }
      // A new slot is a new framing transaction; the predecessor's parts are void.
      await req(journal.add({ ...e, install_id: planned.install_id, install_seq: next++, waiting: null, framing: undefined }));
    }
    // A restore whose new lineage no view has shown yet (the push was refused): the next view (or
    // the server's summary) names the new one, and the lineage left is retired then, if it is
    // another. A restore a view showed keeps its lineage and cursor, and so does a copied profile
    // (another nonce), whose lineage is the same.
    if (plan.instance_nonce === inst.instance_nonce && !plan.head) {
      if (inst.lineage) inst.left = inst.lineage;
      inst.cursor = null;
      inst.lineage = null;
    }
    inst.predecessors = [...inst.predecessors, inst.install_id];
    inst.install_id = planned.install_id;
    inst.instance_nonce = planned.instance_nonce;
    inst.next_install_seq = next;
    inst.acked_install_seq = 0;
    inst.registered = true;
    inst.paused = null;
    delete inst.successor;
    await req(insts.put(inst));
    return inst;
  });
}

/** retainedEntries lists the acknowledged entries kept for recovery upload. */
export async function retainedEntries(db: IDBDatabase, account: string): Promise<EntryRow[]> {
  return tx(db, ["retained"], "readonly", async (t) => {
    const all = (await req(t.objectStore("retained").getAll())) as EntryRow[];
    return all.filter((e) => e.account_id === account);
  });
}
