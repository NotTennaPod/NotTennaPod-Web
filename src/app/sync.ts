// The tab's sync loop (PROTOCOL §12): actions are journaled
// first and pushed in the background; every view shown advances the cursor
// pushes name and retires what it shows; the event stream, reconnects and
// focus make visible views re-read. With the server unreachable, one banner
// says so and controls wait.
import { ApiError, get, post, refused, Unreachable } from "../api/http.ts";
import type { Head } from "../api/views.ts";
import type { EntryRow, Receipt } from "../journal/db.ts";
import { append, entries, installation, outcomeShown, retire, updateInstallation, type FactBody } from "../journal/journal.ts";
import { pushAll, type PushResponse } from "../journal/pusher.ts";
import { retainedEntries, takeSuccessor } from "../journal/successor.ts";
import { recover, type RecoveryState, type RecoveryTransport } from "../journal/recovery.ts";
import { appVersion, browserName, capabilities, type Session } from "./boot.ts";
import { reads } from "../api/views.ts";

type Listener = () => void;

/** A tiny observable value. */
export class Value<T> {
  #v: T;
  #ls = new Set<Listener>();
  constructor(v: T) {
    this.#v = v;
  }
  get(): T {
    return this.#v;
  }
  set(v: T): void {
    if (Object.is(v, this.#v)) return;
    this.#v = v;
    for (const l of [...this.#ls]) l();
  }
  subscribe(l: Listener): () => void {
    this.#ls.add(l);
    return () => this.#ls.delete(l);
  }
}

export type Connection = "online" | "unreachable";

export interface Notice {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

export class Sync {
  readonly session: Session;
  readonly connection = new Value<Connection>("online");
  readonly pending = new Value(0);
  readonly waiting = new Value<string[] | null>(null); // dependency_missing (PROTOCOL §12)
  readonly paused = new Value<string | null>(null);
  /** refused is the server's message when it refuses this browser's push as invalid; it is retried, and shown until a push succeeds. */
  readonly refused = new Value<string | null>(null);
  /** recovery is how far this browser's recovery after a restore has come (null: none running). */
  readonly recovery = new Value<RecoveryState | null>(null);
  readonly notices = new Value<Notice[]>([]);
  /** changed bumps when visible views should re-read. */
  readonly changed = new Value(0);
  #shown: Head | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #again = false;
  #backoff = 0;
  #events: EventSource | undefined;
  #noticeId = 0;
  /** receipts reports each acknowledged action's outcome to whoever waits for it. */
  #receiptWaiters = new Map<string, ((r: Receipt | null) => void)[]>();
  /** #receipts reaches the profile's other tabs: whichever tab pushes a change, its outcome reaches the tab that made it. */
  #receipts: BroadcastChannel | null;

  constructor(session: Session) {
    this.session = session;
    this.#receipts = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(`nottennapod-receipts:${session.account.account_id}`);
    this.#receipts?.addEventListener("message", (ev) => {
      const list = (ev as MessageEvent<{ receipts?: unknown }>).data?.receipts;
      if (!Array.isArray(list)) return;
      for (const r of list as Receipt[]) if (typeof r?.op_id === "string" && typeof r.outcome === "string") this.#deliver(r.op_id, r);
    });
  }

  get account(): string {
    return this.session.account.account_id;
  }

  /** act journals an action; it is done once this resolves (PROTOCOL §12). */
  async act(body: FactBody): Promise<EntryRow> {
    const entry = await append(this.session.db, this.account, this.session.author.author_id, body);
    this.pending.set(this.pending.get() + 1);
    this.schedule(0);
    return entry;
  }

  /**
   * pushed resolves once every action this browser journaled has reached the
   * server, or after `timeoutMs` (an entry waiting for a dependency). A queue
   * placement is computed from the server's queue, so it waits for this tab's
   * own earlier queue changes first: a play's queue add and a quick Add to
   * queue after it must not both land "after the last one" in an arbitrary order.
   */
  async pushed(timeoutMs = 5000): Promise<void> {
    if (this.pending.get() === 0) return;
    this.schedule(0);
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      const off = this.pending.subscribe(() => {
        if (this.pending.get() === 0) done();
      });
    });
  }

  /**
   * outcome resolves with the action's receipt once the server acknowledges
   * it, whichever of the profile's tabs pushed it. An action journaled as
   * awaited keeps a refusal past retirement until this tab has it; for any
   * other, null says it can no longer be known (another tab acknowledged and
   * retired it unseen).
   */
  outcome(opId: string): Promise<Receipt | null> {
    return new Promise((resolve) => this.#receiptWaiters.set(opId, [...(this.#receiptWaiters.get(opId) ?? []), resolve]));
  }

  #deliver(opId: string, r: Receipt | null): void {
    const ws = this.#receiptWaiters.get(opId);
    if (!ws) return;
    this.#receiptWaiters.delete(opId);
    for (const w of ws) w(r);
    // This tab has the outcome: a refusal kept for it may be retired now.
    if (r) void outcomeShown(this.session.db, this.account, opId).catch((e: unknown) => console.error("sync: outcome", e));
  }

  /**
   * #fromJournal settles the waiters the push responses did not: another
   * tab may have pushed the entry and stored its receipt (in the journal, or
   * kept for recovery by a successor). An entry gone without one was retired
   * by a tab that showed its effect: its outcome can no longer be told, and
   * nothing waits for it any longer.
   */
  async #fromJournal(): Promise<void> {
    if (this.#receiptWaiters.size === 0) return;
    const byOp = new Map((await entries(this.session.db, this.account)).map((e) => [e.op_id, e]));
    const missing = [...this.#receiptWaiters.keys()].filter((op) => !byOp.has(op));
    if (missing.length) for (const e of await retainedEntries(this.session.db, this.account)) if (e.receipt && missing.includes(e.op_id)) byOp.set(e.op_id, e);
    for (const op of [...this.#receiptWaiters.keys()]) {
      const e = byOp.get(op);
      if (!e) this.#deliver(op, null);
      else if (e.receipt) this.#deliver(op, e.receipt);
    }
  }

  /** shown records the head of a view the tab displayed: pushes name it, and it retires what it shows (PROTOCOL §12). */
  async shown(head: Head): Promise<void> {
    const s = this.#shown;
    if (s && s.log_id === head.log_id && s.epoch === head.epoch && s.seq >= head.seq) return;
    this.#shown = head;
    let restored = false;
    await updateInstallation(this.session.db, this.account, (r) => {
      // Another lineage than the one this browser's receipts came from: the
      // server was restored. Its facts continue under a successor (PROTOCOL §12).
      restored = !!r.lineage && (r.lineage.log_id !== head.log_id || r.lineage.epoch !== head.epoch);
      r.lineage = { log_id: head.log_id, epoch: head.epoch };
      r.cursor = head.cursor;
    });
    if (restored) await this.successor(false, head);
    await retire(this.session.db, this.account, head);
    this.schedule(0);
  }

  /** successor continues this browser's writes under a new installation (PROTOCOL §12). */
  async successor(freshNonce: boolean, head?: Head): Promise<void> {
    // After a restore (not a copied profile), what this browser had acknowledged is
    // recovered before its later writes go out; the recovery is recorded with the
    // successor's plan, in one transaction (PROTOCOL §6.11).
    await this.#handoff(freshNonce, head, !freshNonce);
  }

  /**
   * #handoff takes the planned successor, or finishes one an earlier load
   * planned and could not register (its request lost, the tab closed): the
   * plan's IDs are reused, so the request is the same.
   */
  async #handoff(freshNonce: boolean, head?: Head, recovery = false): Promise<void> {
    await takeSuccessor(this.session.db, this.account, (body) => post("/v1/installations/successor", body), {
      freshNonce,
      recovery,
      device: { name: browserName(), app_version: appVersion, capabilities },
    });
    const h = head ?? (await reads.summary()).head;
    await updateInstallation(this.session.db, this.account, (r) => {
      r.lineage = { log_id: h.log_id, epoch: h.epoch };
      r.cursor = h.cursor;
    });
  }

  notify(text: string, action?: Notice["action"]): number {
    const n: Notice = { id: ++this.#noticeId, text, action };
    this.notices.set([...this.notices.get(), n]);
    setTimeout(() => this.dismiss(n.id), 4000);
    return n.id;
  }

  dismiss(id: number): void {
    this.notices.set(this.notices.get().filter((n) => n.id !== id));
  }

  schedule(delay: number): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#push(), delay);
  }

  async #push(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = true;
    try {
      // A successor handoff left unfinished goes first, then a recovery after a
      // restore; both resume after a reload (PROTOCOL §12).
      if ((await installation(this.session.db, this.account)).successor) await this.#handoff(false);
      const rec = await recover(this.session.db, this.account, recoveryApi);
      if (rec) {
        this.recovery.set(rec);
        if (rec.recovered > 0) this.changed.set(this.changed.get() + 1);
      }
      const out = await pushAll(this.session.db, this.account, (body) => post<PushResponse>("/v1/push", body).then((r) => this.#received(r)));
      await this.#fromJournal();
      this.connection.set("online");
      this.refused.set(null);
      if (out.stopped === "lineage_mismatch" || out.stopped === "conflict") {
        // A restored server, or another profile sharing this transport.
        await this.successor(out.stopped === "conflict");
        this.#again = true;
        return;
      }
      this.pending.set(out.remaining);
      this.waiting.set(out.waiting);
      if (out.stopped === "paused" || out.stopped === "lineage_unknown") {
        this.paused.set(out.stopped);
      }
      if (out.waiting) this.#retryLater();
      else this.#backoff = 0;
    } catch (e) {
      if (e instanceof Unreachable) {
        this.connection.set("unreachable");
        this.#retryLater();
      } else if (e instanceof ApiError && (e.code === "server_busy" || e.code === "rate_limited")) {
        this.schedule((e.retryAfter ?? 5) * 1000);
      } else if (e instanceof ApiError && (e.status === 400 || e.status === 413)) {
        // A refusal that will not pass by itself: say so, keep the changes, and try again later.
        this.connection.set("online");
        this.refused.set(e.message);
        this.#retryLater();
      } else {
        this.#retryLater();
      }
    } finally {
      this.#running = false;
      if (this.#again) {
        this.#again = false;
        this.schedule(0);
      }
    }
  }

  #received(r: PushResponse): PushResponse {
    const receipts = r.results.flatMap((res) => (res.receipt ? [res.receipt] : []));
    for (const receipt of receipts) this.#deliver(receipt.op_id, receipt);
    if (receipts.length) {
      // The change may be another tab's: its outcome is that tab's to show.
      this.#receipts?.postMessage({ receipts });
      this.changed.set(this.changed.get() + 1);
    }
    return r;
  }

  #retryLater(): void {
    this.#backoff = Math.min(60_000, this.#backoff ? this.#backoff * 2 : 2_000);
    this.schedule(this.#backoff);
  }

  /** start pushes what an earlier load left, opens the event stream and watches focus. */
  start(): () => void {
    this.schedule(0);
    const reread = () => this.changed.set(this.changed.get() + 1);
    const open = () => {
      this.#events?.close();
      const es = new EventSource("/v1/events");
      es.addEventListener("changed", reread);
      es.addEventListener("open", () => {
        this.connection.set("online");
        reread();
      });
      es.addEventListener("closed", () => {
        // The server ended the stream. A session it no longer takes is an account
        // transition, with the player's last save first; one still valid for this
        // account (rebound to this browser's successor installation) only needs a new stream.
        es.close();
        get<{ account?: { account_id: string } }>("/v1/session").then(
          (who) => (who.account?.account_id === this.account ? setTimeout(open, 1000) : refused()),
          (e: unknown) => {
            // A 401 is the http layer's sign-out; a 403 (a disabled account) is a refusal
            // as final, so it takes the same transition. Anything else may pass: try again.
            if (e instanceof ApiError && e.status === 403) refused();
            else if (!(e instanceof ApiError && e.status === 401)) setTimeout(open, 5000);
          },
        );
      });
      es.addEventListener("error", () => {
        if (es.readyState === EventSource.CLOSED) setTimeout(open, 5000);
      });
      this.#events = es;
    };
    open();
    const focus = () => {
      reread();
      this.schedule(0);
    };
    window.addEventListener("focus", focus);
    const online = () => this.schedule(0);
    window.addEventListener("online", online);
    return () => {
      this.#receipts?.close();
      this.#receipts = null;
      this.#events?.close();
      window.removeEventListener("focus", focus);
      window.removeEventListener("online", online);
      if (this.#timer) clearTimeout(this.#timer);
    };
  }
}

/** recoveryApi is the server's recovery API (PROTOCOL §6.11). */
const recoveryApi: RecoveryTransport = {
  snapshot: (body) => post("/v1/snapshot", body),
  inventory: (body) => post("/v1/sync/recovery/inventory", body),
  upload: (body) => post("/v1/sync/recovery/upload", body),
  finish: (body) => post("/v1/sync/recovery/finish", body),
};
