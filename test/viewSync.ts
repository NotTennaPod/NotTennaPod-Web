// A tab's Sync for the view tests: the real head and lineage logic over a
// fake IndexedDB, with the push loop left out (`shown` only records the heads
// shown) and no BroadcastChannel.
import "fake-indexeddb/auto";
import { openDB } from "../src/journal/db.ts";
import { installation, updateInstallation } from "../src/journal/journal.ts";
import type { Head } from "../src/api/views.ts";

(globalThis as Record<string, unknown>).BroadcastChannel = undefined;
const { Sync } = await import("../src/app/sync.ts");

export const L1 = "6a1f0e2c-1111-4222-8333-944455556666";
export const L2 = "7b2f0e2c-2222-4333-8444-a55566667777";

/** head is a view head (its cursor is not a contract cursor: nothing here decodes it). */
export function head(seq: number, log_id = L1, epoch = 1): Head {
  return { log_id, epoch, seq, cursor: `${log_id}/${epoch}/${seq}` };
}

export class TestSync extends Sync {
  readonly shownHeads: Head[] = [];
  override async shown(h: Head): Promise<void> {
    this.shownHeads.push(h);
  }
}

let n = 0;
/** testSync is a tab signed in to a fresh account whose accepted lineage is `lineage` (none: not known yet). */
export async function testSync(lineage: { log_id: string; epoch: number } | null = { log_id: L1, epoch: 1 }): Promise<TestSync> {
  const db = await openDB(indexedDB, `views-${++n}`);
  const account = `account-${n}`;
  await installation(db, account);
  await updateInstallation(db, account, (r) => {
    r.registered = true;
    r.lineage = lineage;
  });
  return new TestSync({
    db,
    account: { account_id: account, namespace: "n", username: "u", is_admin: false },
    author: { author_id: `author-${n}`, account_id: account, next_seq: 1, last_op_id: null, created_at: 0 },
    installation: await installation(db, account),
  } as never);
}

/** settle lets promises and IndexedDB requests run. */
export async function settle(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
