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

export interface SuccessorOptions {
  /** freshNonce: a copied profile takes a new nonce; after a restore the profile keeps its own. */
  freshNonce: boolean;
  /**
   * recovery: after a restore, record the recovery in the same transaction
   * as the plan, so no tab can see the recovery without its handoff and judge
   * it empty before the entries are moved aside.
   */
  recovery?: boolean;
  device: { name: string; app_version: string; capabilities: string[] };
}

export async function takeSuccessor(db: IDBDatabase, account: string, send: SuccessorRequest, opts: SuccessorOptions): Promise<InstallationRow> {
  // 1. Choose the successor's IDs durably (or reuse a handoff in progress).
  const planned = await tx(db, ["installations"], "readwrite", async (t) => {
    const store = t.objectStore("installations");
    const inst = (await req(store.get(account))) as InstallationRow | undefined;
    if (!inst) throw new Error("journal: no installation");
    if (!inst.successor) {
      inst.successor = { install_id: uuid(), instance_nonce: opts.freshNonce ? uuid() : inst.instance_nonce };
      if (opts.recovery && (!inst.recovery || inst.recovery.finished)) inst.recovery = { recovery_id: uuid(), opened: false, finished: false };
      await req(store.put(inst));
    }
    return inst.successor;
  });
  // 2. Register it (idempotent for the same IDs); the server binds this
  // browser's session to it.
  await send({ install_id: planned.install_id, instance_nonce: planned.instance_nonce, device: opts.device });
  // 3. Renumber in one transaction.
  return tx(db, ["installations", "journal", "retained"], "readwrite", async (t) => {
    const insts = t.objectStore("installations");
    const journal = t.objectStore("journal");
    const retained = t.objectStore("retained");
    const inst = (await req(insts.get(account))) as InstallationRow;
    if (!inst.successor || inst.successor.install_id !== planned.install_id) return inst; // another tab finished it
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
    inst.predecessors = [...inst.predecessors, inst.install_id];
    inst.install_id = planned.install_id;
    inst.instance_nonce = planned.instance_nonce;
    inst.next_install_seq = next;
    inst.acked_install_seq = 0;
    inst.registered = true;
    inst.cursor = null; // the next view shown names the new lineage
    inst.lineage = null;
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
