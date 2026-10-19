// The tab's sync loop (PROTOCOL §12): actions are journaled
// first and pushed in the background; every view shown advances the cursor
// pushes name and retires what it shows. The heads the server announces (push
// responses, the event stream, views applied) make displayed views re-read
// once per newer head; reconnects, focus, online, a recovery and a successor
// make them revalidate. With the server unreachable, one banner says so and
// controls wait.
import { ApiError, get, post, postKeepalive, refused, request, Unreachable } from "../api/http.ts";
import type { Counters, Head } from "../api/views.ts";
import type { EntryRow, Receipt } from "../journal/db.ts";
import { append, appendAll, entries, installation, lineages, outcomeShown, retire, retireLineage, staleLineage, updateInstallation, type FactBody, type Lineages } from "../journal/journal.ts";
import { decodeCursor, defaultBounds, leavingPush, pushAll, type Bounds, type PushResponse } from "../journal/pusher.ts";
import { utf8 } from "../journal/jcs.ts";
import { planSuccessor, retainedEntries, SuccessorBusy, takeSuccessor } from "../journal/successor.ts";
import { recover, type RecoveryState, type RecoveryTransport } from "../journal/recovery.ts";
import { appVersion, browserName, capabilities, type Session } from "./boot.ts";
import { reads } from "../api/views.ts";
import { sameLineage, type HeadLike } from "./heads.ts";

import { Value } from "../util/value.ts";

export { Value };

export type Connection = "online" | "unreachable";

export interface Notice {
  id: number;
  text: string;
  /** action is the notice's button (Undo); a failure of what it starts is shown as any action's is (progress.track). */
  action?: { label: string; run: () => void | Promise<void> };
}

/**
 * registeredAlready settles a refused successor registration: when the
 * browser's credential already is that successor (an earlier answer reached
 * the browser, and its tab closed before finishing), the server refuses the
 * repeat as a request for its own ID, and the handoff finishes here without
 * registering again. Anything else is the refusal it is.
 */
async function registeredAlready(e: unknown, installId: string): Promise<void> {
  if (e instanceof ApiError && e.status === 400 && (await get<{ install_id: string | null }>("/v1/session")).install_id === installId) return;
  throw e;
}

/**
 * pushDeadline is how long a push of a body of this many bytes may go
 * unanswered (a connection stalled by sleep or a weak network) before it is
 * cancelled and sent again with the same slots, which the server answers as
 * it did if it had them (PROTOCOL §6.4): a minute, and a slow link's time for
 * the body (16 KB/s). A slower link gets smaller pushes (Sync.#batch).
 */
export const pushDeadline = (bytes: number) => 60_000 + bytes / 16;

/** PushTimeout is a push its deadline cancelled. */
class PushTimeout extends Error {}

export class Sync {
  readonly session: Session;
  readonly connection = new Value<Connection>("online");
  readonly pending = new Value(0);
  readonly waiting = new Value<string[] | null>(null); // dependency_missing (PROTOCOL §12)
  readonly paused = new Value<string | null>(null);
  /** refused is the server's message when it refuses this browser's push as invalid; it is retried, and shown until a push succeeds. */
  readonly refused = new Value<string | null>(null);
  /** unsendable is whether an unsent change is too large for the server and cannot be split: it and the changes after it are kept, unsent. */
  readonly unsendable = new Value(false);
  /** recovery is how far this browser's recovery after a restore has come (null: none running). */
  readonly recovery = new Value<RecoveryState | null>(null);
  readonly notices = new Value<Notice[]>([]);
  /**
   * known is the newest head the tab knows the server has: from push
   * responses, the event stream and the views applied. It only moves forward
   * within a lineage, and never to a lineage the profile has left.
   */
  readonly known = new Value<HeadLike | null>(null);
  /** revalidate bumps when displayed views should read again whatever the heads (a reconnect, focus, online, a recovery, a successor). */
  readonly revalidate = new Value(0);
  /** visible is whether the tab is shown: a hidden tab's views wait, and read once when it shows again. */
  readonly visible = new Value(typeof document === "undefined" || document.visibilityState !== "hidden");
  /** counters are the drawer's counters, from the newest view applied (never an older one of its lineage). */
  readonly counters = new Value<{ head: HeadLike; counters: Counters } | null>(null);
  #shown: Head | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #again = false;
  /** #versionCheck: the next push sends again what a server refused as too new (a page load, a reconnect: it may have been updated). */
  #versionCheck = true;
  #backoff = 0;
  #events: EventSource | undefined;
  #noticeId = 0;
  /** receipts reports each acknowledged action's outcome to whoever waits for it. */
  #receiptWaiters = new Map<string, ((r: Receipt | null) => void)[]>();
  /** #receipts reaches the profile's other tabs: whichever tab pushes a change, its outcome reaches the tab that made it. */
  #receipts: BroadcastChannel | null;

  #pushDeadline: (bytes: number) => number;
  /**
   * #batch is the most facts a push carries: halved after a push its deadline
   * cancelled, down to one fact (or part), so whole facts move however slow
   * the upload; doubled back after each push answered. The facts keep their
   * slots and order: a push always sends the front of what is unsent.
   */
  #batch = defaultBounds.max_operations;
  #bounds: Bounds;
  /** #prepared is the push a page going away sends (leavingPush), built while the page can read the journal. */
  #prepared: Record<string, unknown> | null = null;
  #preparing: Promise<void> | null = null;
  #prepareAgain = false;

  constructor(session: Session, opts: { pushDeadline?: (bytes: number) => number } = {}) {
    this.session = session;
    this.#pushDeadline = opts.pushDeadline ?? pushDeadline;
    const self = this;
    this.#bounds = {
      ...defaultBounds,
      get max_operations() {
        return self.#batch;
      },
    };
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
    this.journaled(1);
    return entry;
  }

  /** actAll journals an action made of several facts (actions.chunks), all in one transaction; it is done once this resolves. */
  async actAll(bodies: FactBody[]): Promise<EntryRow[]> {
    const entries = await appendAll(this.session.db, this.account, this.session.author.author_id, bodies);
    this.journaled(entries.length);
    return entries;
  }

  /**
   * journaled takes facts just journaled (an action, a player's export): they
   * are pushed, and the departure's push is prepared again with them at once,
   * whatever becomes of a push still under way.
   */
  journaled(n: number): void {
    this.pending.set(this.pending.get() + n);
    this.schedule(0);
    void this.prepare();
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

  /**
   * shown records the head of a view the tab displayed: pushes name it, and it
   * retires what it shows (PROTOCOL §12). The profile's lineage only moves
   * forward: a late view of a lineage it has left (an older epoch, a retired
   * log) changes nothing.
   */
  async shown(head: Head): Promise<void> {
    const s = this.#shown;
    if (s && s.log_id === head.log_id && s.epoch === head.epoch && s.seq >= head.seq) return;
    this.#shown = head;
    let restored = false;
    let stale = false;
    let from = "";
    await updateInstallation(this.session.db, this.account, (r) => {
      if (staleLineage(r, head)) {
        stale = true;
        return;
      }
      // Another lineage than the one this browser's receipts came from: the
      // server was restored. Its facts continue under a successor (PROTOCOL §12),
      // after what it had acknowledged is recovered (§6.11). Both are planned in
      // this transaction, with the new lineage, so whichever tab or load comes
      // next finishes them.
      restored = !!r.lineage && (r.lineage.log_id !== head.log_id || r.lineage.epoch !== head.epoch);
      retireLineage(r, head);
      r.cursor = head.cursor;
      if (restored) planSuccessor(r, { freshNonce: false, recovery: true, head: { cursor: head.cursor, log_id: head.log_id, epoch: head.epoch } });
      from = r.install_id;
    });
    if (stale) {
      if (this.#shown === head) this.#shown = s;
      return;
    }
    if (restored) await this.successor(false, head, from);
    await retire(this.session.db, this.account, head);
    this.schedule(0);
  }

  /**
   * accepts tells whether a view's head may be shown: not of a lineage the
   * profile has left, and not a late answer of the profile's lineage once the
   * server has announced another (a restore the tab has not shown yet).
   */
  async accepts(head: HeadLike): Promise<boolean> {
    return this.#accepts(await lineages(this.session.db, this.account), head);
  }

  #accepts(l: Lineages, head: HeadLike): boolean {
    if (staleLineage(l, head)) return false;
    const k = this.known.get();
    return !(k && !sameLineage(k, head) && l.lineage && sameLineage(head, l.lineage) && !staleLineage(l, k));
  }

  /** learn takes a head the server announced: displayed views re-read once if it is newer than theirs. */
  async learn(head: HeadLike): Promise<void> {
    const l = await lineages(this.session.db, this.account);
    if (this.#accepts(l, head)) this.#advance(head);
  }

  #advance(head: HeadLike): void {
    const k = this.known.get();
    if (k && sameLineage(k, head) && head.seq <= k.seq) return;
    this.known.set({ log_id: head.log_id, epoch: head.epoch, seq: head.seq });
  }

  /**
   * applied records a view the tab applied (its head accepted): the known
   * head, the drawer's counters when newer, and, unless `display` is false,
   * the head shown (the push cursor and retirement).
   */
  applied(head: Head, counters?: Counters, display = true): void {
    this.#advance(head);
    const c = this.counters.get();
    if (counters && (!c || !sameLineage(c.head, head) || head.seq > c.head.seq)) {
      this.counters.set({ head: { log_id: head.log_id, epoch: head.epoch, seq: head.seq }, counters });
    }
    if (display) void this.shown(head);
  }

  /**
   * heard takes the event stream's `changed` data, the server's head
   * (PROTOCOL §12): views not at it re-read once; data that is not a head
   * makes them revalidate.
   */
  heard(data: string): void {
    let head: HeadLike | null = null;
    try {
      const v = JSON.parse(data) as Record<string, unknown>;
      if (typeof v.log_id === "string" && Number.isSafeInteger(v.epoch) && Number.isSafeInteger(v.seq)) head = { log_id: v.log_id, epoch: v.epoch as number, seq: v.seq as number };
    } catch {
      /* not a head */
    }
    if (head) void this.learn(head).catch((e: unknown) => console.error("sync: learn", e));
    else this.#revalidate();
  }

  #revalidate(): void {
    this.revalidate.set(this.revalidate.get() + 1);
  }

  /**
   * successor continues this browser's writes under a new installation (PROTOCOL §12).
   * `from` is the installation it replaces: if another tab replaced that one
   * meanwhile, nothing more is taken, and this tab finishes what is missing.
   * False while another tab registers it: the push loop asks again later.
   */
  async successor(freshNonce: boolean, head: Head | undefined, from: string): Promise<boolean> {
    // After a restore (not a copied profile), what this browser had acknowledged is
    // recovered before its later writes go out; the recovery is recorded with the
    // successor's plan, in one transaction (PROTOCOL §6.11).
    try {
      await this.#handoff(freshNonce, head, !freshNonce, from);
    } catch (e) {
      if (!(e instanceof SuccessorBusy)) throw e;
      this.#retryLater();
      return false;
    }
    this.#revalidate();
    return true;
  }

  /**
   * #handoff takes the planned successor, or finishes one an earlier load
   * planned and could not register (its request lost, the tab closed): the
   * plan's IDs are reused, so the request is the same.
   */
  async #handoff(freshNonce: boolean, head: Head | undefined, recovery: boolean, from: string): Promise<void> {
    await takeSuccessor(this.session.db, this.account, (body) => post("/v1/installations/successor", body).catch((e: unknown) => registeredAlready(e, body.install_id)), {
      freshNonce,
      recovery,
      from,
      device: { name: browserName(), app_version: appVersion, capabilities },
    });
    // Taken here or by another tab (which may be gone): the new lineage and cursor, if still missing.
    await this.#complete(head);
  }

  /**
   * #complete gives a registered installation without a cursor (a successor
   * after a refused push, PROTOCOL §12) the server's lineage and cursor: the
   * head given, else the summary's. It is idempotent, and returns whether it
   * set a cursor.
   */
  async #complete(head?: Head): Promise<boolean> {
    const inst = await installation(this.session.db, this.account);
    if (inst.successor || inst.cursor || !inst.registered) return false;
    const h = head ?? (await reads.summary()).head;
    let done = false;
    await updateInstallation(this.session.db, this.account, (r) => {
      if (r.successor || r.cursor || staleLineage(r, h)) return;
      retireLineage(r, h);
      r.cursor = h.cursor;
      done = true;
    });
    return done;
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
      // Only that handoff: if another tab finishes it meanwhile, none is taken here.
      const inst = await installation(this.session.db, this.account);
      if (inst.successor && !(await this.successor(false, undefined, inst.install_id))) return; // another tab registers it
      const rec = await recover(this.session.db, this.account, recoveryApi);
      if (rec) {
        this.recovery.set(rec);
        if (rec.recovered > 0) this.#revalidate();
      }
      if (this.#versionCheck) {
        // A server that refused this browser's facts as too new pauses pushing until it is
        // updated (PROTOCOL §10.2): the same facts are sent again, and a refusal pauses again.
        await updateInstallation(this.session.db, this.account, (r) => {
          if (r.paused === "version_unsupported") r.paused = null;
        });
        this.#versionCheck = false;
      }
      const pushedAs = (await installation(this.session.db, this.account)).install_id;
      const out = await pushAll(this.session.db, this.account, (body) => this.#send(body), this.#bounds);
      await this.#fromJournal();
      this.connection.set("online");
      this.refused.set(null);
      if (out.stopped === "lineage_mismatch" || out.stopped === "conflict") {
        // A restored server, or another profile sharing this transport.
        if (await this.successor(out.stopped === "conflict", undefined, pushedAs)) this.#again = true;
        return;
      }
      // Changes to send and no cursor: a successor another tab took and could not finish.
      if (out.stopped === "no_cursor" && (await entries(this.session.db, this.account)).some((e) => !e.receipt) && (await this.#complete())) {
        this.#again = true;
        return;
      }
      this.pending.set(out.remaining);
      this.waiting.set(out.waiting);
      this.unsendable.set(out.stopped === "too_large");
      if (out.stopped === "paused" || out.stopped === "lineage_unknown") {
        this.paused.set(out.stopped);
      } else if (this.paused.get() && !(await installation(this.session.db, this.account)).paused) {
        this.paused.set(null); // resumed (here or in another tab)
      }
      if (out.waiting) this.#retryLater();
      else this.#backoff = 0;
    } catch (e) {
      if (e instanceof Unreachable) {
        this.connection.set("unreachable");
        this.#retryLater();
      } else if (e instanceof PushTimeout) {
        this.schedule(0); // at once, smaller: the time is in the deadline already
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
      void this.prepare(); // what is left unsent, and what was journaled meanwhile
    }
  }

  /** #send sends one push; one unanswered by its deadline is cancelled (PushTimeout, which the push loop retries smaller), so it never holds the loop. */
  async #send(body: Record<string, unknown>): Promise<PushResponse> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.#pushDeadline(utf8(JSON.stringify(body)).length));
    const sent = (body.operations as unknown[]).length;
    try {
      const r = await request<PushResponse>("POST", "/v1/push", body, ac.signal);
      this.#batch = Math.min(defaultBounds.max_operations, this.#batch * 2);
      return this.#received(r);
    } catch (e) {
      if (!ac.signal.aborted) throw e;
      this.#batch = Math.max(1, Math.floor(sent / 2));
      throw new PushTimeout("push: no answer in time");
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * prepare builds the push a page going away sends, from the journal's
   * unsent facts as they are now (leavingPush): whenever the journal gains a
   * fact, after each push, and when the page is hidden. Calls meanwhile build
   * it once more after.
   */
  prepare(): Promise<void> {
    if (this.#preparing) {
      this.#prepareAgain = true;
      return this.#preparing;
    }
    this.#preparing = (async () => {
      do {
        this.#prepareAgain = false;
        try {
          this.#prepared = await leavingPush(this.session.db, this.account);
        } catch (e) {
          console.error("sync: prepare", e);
        }
      } while (this.#prepareAgain);
    })().finally(() => (this.#preparing = null));
    return this.#preparing;
  }

  /**
   * leaving sends the prepared push as the page goes away (pagehide): the
   * request starts at once, as nothing that waits runs after pagehide. Its
   * facts stay journaled until a push's answer acknowledges them; a resend is
   * a duplicate (PROTOCOL §6.4).
   */
  leaving(): void {
    const body = this.#prepared;
    if (body) postKeepalive<PushResponse>("/v1/push", body).catch(() => {});
  }

  #received(r: PushResponse): PushResponse {
    const receipts = r.results.flatMap((res) => (res.receipt ? [res.receipt] : []));
    for (const receipt of receipts) this.#deliver(receipt.op_id, receipt);
    // The change may be another tab's: its outcome is that tab's to show.
    if (receipts.length) this.#receipts?.postMessage({ receipts });
    // The server's head after the push: views re-read once for it (its event
    // for the same head then changes nothing). A head that is not a contract
    // cursor is the push loop's to refuse.
    let head: HeadLike | null = null;
    try {
      head = decodeCursor(r.head);
    } catch {
      /* refused by pushAll */
    }
    if (head) void this.learn(head).catch((e: unknown) => console.error("sync: learn", e));
    return r;
  }

  #retryLater(): void {
    this.#backoff = Math.min(60_000, this.#backoff ? this.#backoff * 2 : 2_000);
    this.schedule(this.#backoff);
  }

  /** start pushes what an earlier load left, opens the event stream and watches focus and visibility. */
  start(): () => void {
    this.schedule(0);
    let opened = false;
    const changed = (ev: Event) => this.heard(String((ev as MessageEvent).data));
    const open = () => {
      this.#events?.close();
      const es = new EventSource("/v1/events");
      es.addEventListener("changed", changed);
      es.addEventListener("open", () => {
        this.connection.set("online");
        // A reconnect may have missed events: views revalidate. The first
        // opening needs none: the views are reading, and its first event
        // names the head they must reach. The server may have been updated
        // meanwhile: pushes it paused as too new are tried again.
        if (opened) {
          this.#revalidate();
          this.#versionCheck = true;
          this.schedule(0);
        }
        opened = true;
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
      this.#revalidate();
      this.schedule(0);
    };
    window.addEventListener("focus", focus);
    const online = () => {
      this.#revalidate();
      this.schedule(0);
    };
    window.addEventListener("online", online);
    const visibility = () => this.visible.set(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", visibility);
    const leaving = () => this.leaving();
    window.addEventListener("pagehide", leaving);
    return () => {
      this.#receipts?.close();
      this.#receipts = null;
      this.#events?.close();
      window.removeEventListener("focus", focus);
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", leaving);
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
