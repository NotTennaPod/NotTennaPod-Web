// The browser profile's durable store (PROTOCOL §12): IndexedDB,
// whose readwrite transactions serialize across tabs, so counters allocated
// inside one are never handed out twice.

export const DB_NAME = "nottennapod";
export const DB_VERSION = 3;

/** Installation is the profile's transport for one account. */
export interface InstallationRow {
  account_id: string;
  install_id: string;
  instance_nonce: string; // kept with the profile, never exported
  next_install_seq: number; // the next slot to allocate
  acked_install_seq: number; // the contiguous prefix the server acknowledged
  registered: boolean;
  cursor: string | null; // the newest cursor shown, sent with pushes
  lineage: { log_id: string; epoch: number } | null;
  /** retired_lineages are the lineages this profile left for a newer one (a restore): their late views are never used again. */
  retired_lineages?: { log_id: string; epoch: number }[];
  /** left is the lineage a successor after a refused push left before the new one is known: retired once the server names another. */
  left?: { log_id: string; epoch: number };
  paused: null | "version_unsupported" | "lineage_unknown";
  predecessors: string[]; // earlier installations of this profile and account (successors after a restore or copy)
  /**
   * successor is a successor being taken (repeated after a crash); `head` is the lineage a restore
   * moves to, when a view of it was shown: the handoff keeps that lineage and cursor. `sending` is
   * the tab registering it, until when: one tab of the profile sends the request at a time.
   */
  successor?: {
    install_id: string;
    instance_nonce: string;
    head?: { cursor: string; log_id: string; epoch: number };
    sending?: { by: string; until: number };
  };
  /**
   * recovery is the recovery after a restore, recorded before it starts. `evidence` counts the
   * predecessor receipts kept for it since: an attempt finishes it only if none arrived meanwhile.
   */
  recovery?: { recovery_id: string; opened: boolean; finished: boolean; evidence?: number };
}

/** Author is one tab load's author chain (PROTOCOL §12). */
export interface AuthorRow {
  author_id: string;
  account_id: string;
  next_seq: number;
  last_op_id: string | null;
  created_at: number;
}

export type Fact = {
  op_id: string;
  author_id: string;
  author_seq: number;
  previous_op_id?: string;
  dependencies: string[];
  type: string;
  type_version: number;
  client_time: number;
  targets: { entity: string; id: string; generation?: string }[];
  payload: Record<string, unknown>;
};

export interface Receipt {
  op_id: string;
  content_hash: string;
  outcome: "applied" | "superseded" | "not_applied" | "rejected";
  reason?: string;
  normalized_time: number;
  epoch: number;
  seq: number;
  index: number;
  key_id: string;
  mac: string;
  frontier?: string[];
  /** The sort values the server recorded with a queue placement or sort (PROTOCOL §7.6): signed, kept as received, sent back in recovery. */
  sort_values?: unknown[];
}

/** Secret is a feed credential sent beside the fact that references it (PROTOCOL §7.2). */
export interface Secret {
  secret_id: string;
  username: string;
  password: string;
  approved_origins?: string[];
}

/** Entry is a journaled fact in its transport slot. */
export interface EntryRow {
  account_id: string;
  install_seq: number;
  install_id: string;
  op_id: string;
  fact: Fact;
  receipt: Receipt | null;
  receipt_lineage: { log_id: string; epoch: number } | null; // the lineage that issued the receipt
  waiting: string[] | null; // dependency_missing: what the server is waiting for
  secrets?: Secret[]; // kept until the entry is retired
  awaited?: boolean; // the tab that made it waits for its outcome: a refusal outlasts retirement until that tab has it
  framing?: { transaction_id: string; present: number[] }; // a framed fact's transaction, never reframed
  created_at: number;
}

export function openDB(factory: IDBFactory = indexedDB, name = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (e.oldVersion < 1) {
        db.createObjectStore("installations", { keyPath: "account_id" });
        const authors = db.createObjectStore("authors", { keyPath: "author_id" });
        authors.createIndex("account", "account_id");
        const journal = db.createObjectStore("journal", { keyPath: ["account_id", "install_seq"] });
        journal.createIndex("op", ["account_id", "op_id"]);
        db.createObjectStore("sessions", { keyPath: ["account_id", "session_id"] });
        db.createObjectStore("leases", { keyPath: "account_id" });
      }
      if (e.oldVersion < 2) {
        // Receipted entries of earlier installations, kept for recovery.
        db.createObjectStore("retained", { keyPath: ["account_id", "install_id", "install_seq"] });
      }
      if (e.oldVersion < 3) {
        // The player's sessions by episode: deciding on one episode reads its sessions only, built from those already saved.
        req.transaction!.objectStore("sessions").createIndex("episode", ["account_id", "episode.episode_id"]);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // A newer page upgrades the database: this one lets go and reloads.
      db.onversionchange = () => {
        db.close();
        if (typeof location !== "undefined") location.reload();
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("The NotTennaPod database is open in an older tab; close it and reload."));
  });
}

/** tx runs fn in one transaction and resolves with its result once the transaction commits. */
export function tx<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode, { durability: "strict" });
    let result: T;
    let failed = false;
    t.oncomplete = () => resolve(result);
    t.onabort = () => reject(t.error ?? new Error("transaction aborted"));
    t.onerror = () => {};
    Promise.resolve()
      .then(() => fn(t))
      .then(
        (r) => {
          result = r;
        },
        (e) => {
          failed = true;
          try {
            t.abort();
          } catch {
            /* already finished */
          }
          reject(e);
        },
      );
    void failed;
  });
}

/** req resolves an IndexedDB request. */
export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
