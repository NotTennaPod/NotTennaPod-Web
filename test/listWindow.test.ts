// Displayed lists at a newer head (PROTOCOL §12): a re-read costs one request
// of at most 200 rows whatever the depth scrolled, the rows on screen stay in
// place, rows above load again from the same view, a walk of the whole list
// that meets an expired view does nothing, views of a replaced query never
// fill the new one, a hidden tab waits, and the drawer's counters come from
// the screens' views.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import "./tsxHooks.ts";
import { ApiError } from "../src/api/http.ts";
import type { Counters, Head, ListPage } from "../src/api/views.ts";
import { deferred, head, L1, settle, testSync, type TestSync } from "./viewSync.ts";

const win = new Window({ width: 1024, height: 1500, url: "http://localhost/" });
Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement });
const { h, render } = await import("preact");
const { act } = await import("preact/test-utils");
const { usePaged, BulkExpired, maxHeldRows, setHeldRowsForTesting } = await import("../src/ui/paged.ts");
const { useView } = await import("../src/app/useView.ts");
const { SyncContext } = await import("../src/app/context.ts");
const { useListSelection, SelectActions, actionMode } = await import("../src/ui/selection.tsx");
const { reportFailuresTo } = await import("../src/ui/progress.ts");
const { addToQueue } = await import("../src/app/queueOps.ts");
const { compareKeys, parseKey } = await import("../src/queue/keys.ts");
test.after(() => win.happyDOM.close());

interface Row {
  episode_id: string;
  title: string;
  [k: string]: unknown;
}

const gen = "g1:" + "a".repeat(64);
const podcast = "p1:" + "b".repeat(64);
/** rowOf is an episode as the lists send it (enough of one for the queue's commands). */
function rowOf(i: number): Row {
  const id = `e${i}`;
  return {
    episode_id: id, title: `Episode ${i}`, podcast_id: podcast, pub_date: i, has_media: true, in_queue: false, play_state: "unplayed", favorite: false,
    position: 0, duration_ms: 1000, podcast: { title: "Show", display_title: "Show", image_url: "", state: "subscribed", generation_id: gen },
    records: { identity: { value: { podcast_id: podcast, occurrence: { k: "rss-guid", v: id, guid: id, title: `Episode ${i}`, publication_time: i } }, provenance: [] } },
  };
}

const viewport = 1500;
/** heightOf is a row's height: rows differ, so a spacer's estimate is never exact. */
const heightOf = (id: string) => 40 + (Number(id.slice(1)) % 3) * 15;
let scrollY = 0;
/** scrolledBy counts the page's own scrolls (a scroll in progress, as Home's, would stop). */
let scrolledBy = 0;
(win as unknown as { scrollBy: (x: number, y: number) => void }).scrollBy = (_x, y) => {
  scrolledBy++;
  scrollY += y;
};

/** Geometry: the spacer, then the list's rows one under the other, scrolled by scrollY. */
const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 1024, width: 1024, x: 0, y: top, toJSON() {} });
win.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
  const spacer = win.document.querySelector(".list-spacer") as HTMLElement | null;
  const S = spacer ? parseFloat(spacer.style.height) || 0 : 0;
  if (this.classList.contains("list-spacer")) return rect(-scrollY, S) as never;
  if (this.classList.contains("list-spacer-below")) {
    // Under the rows (and Load more, which takes no room here).
    const ul = win.document.querySelector("ul") as unknown as HTMLElement;
    const rows = [...ul.children] as HTMLElement[];
    return rect(S + rows.reduce((n, li) => n + heightOf(li.dataset.id!), 0) - scrollY, parseFloat(this.style.height) || 0) as never;
  }
  if (this.tagName === "UL") {
    const all = [...this.children] as HTMLElement[];
    return rect(S - scrollY, all.reduce((n, li) => n + heightOf(li.dataset.id!), 0)) as never;
  }
  if (this.dataset.id !== undefined) {
    let top = S;
    for (const li of [...this.parentElement!.children] as HTMLElement[]) {
      if (li === this) break;
      top += heightOf(li.dataset.id!);
    }
    return rect(top - scrollY, heightOf(this.dataset.id)) as never;
  }
  return rect(0, 0) as never;
} as never;

/** topOf is a row's top on screen (undefined when not held). */
function topOf(id: string): number | undefined {
  const el = win.document.querySelector(`[data-id="${id}"]`) as HTMLElement | null;
  return el ? el.getBoundingClientRect().top : undefined;
}

/** near checks a row's place on screen to within a pixel (the page keeps places to a pixel, not below). */
function near(actual: number | undefined, expected: number, what = "the row's place"): void {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1, `${what}: ${actual} instead of ${expected}`);
}

/** scrollTo puts a held row's top at `top` on screen. */
function scrollToRow(id: string, top: number) {
  scrollY += topOf(id)! - top;
  win.dispatchEvent(new win.Event("scroll"));
}

/** Tokens are opaque: the server keeps what each names, and refuses any it did not give (the client never makes one). */
const tokens = new Map<string, { view: string; offset: number }>();
let tokenSeq = 0;
const tokenOf = (view: string, offset: number) => {
  const t = `opaque-${++tokenSeq}-${Math.random().toString(36).slice(2)}`;
  tokens.set(t, { view, offset });
  return t;
};

/** ListServer is a list's server: views fixed at one head, tokens naming any offset, anchored windows (PROTOCOL §12). */
class ListServer {
  rows: Row[];
  seq = 1;
  views = new Map<string, { rows: Row[]; head: Head }>();
  expired = new Set<string>();
  requests: { kind: "first" | "anchored" | "token"; view: string; offset: number; limit: number; anchor?: string }[] = [];
  rowsSent = 0;
  counters: Counters = { queue: 1, inbox: 1 };
  #n = 0;
  constructor(n: number) {
    this.rows = Array.from({ length: n }, (_, i) => rowOf(i));
  }
  /** firstAt, when set, makes the next first request answer the window there (a window read before, seeded). */
  firstAt: number | null = null;
  /** holding holds each first request (not pages) in `waiting` until the test releases it. */
  holding = false;
  waiting: { resolve: (v: void) => void }[] = [];
  /** gate, while set, holds first requests (not pages) until it resolves. */
  gate: Promise<void> | null = null;
  /** remove is another device's change that takes a row off the list: a new head. */
  remove(id: string) {
    this.rows = this.rows.filter((r) => r.episode_id !== id);
    this.seq++;
  }
  /** removeFirst is another device's change that takes the first n rows off the list (a filter): a new head. */
  removeFirst(n: number) {
    this.rows = this.rows.slice(n);
    this.seq++;
  }
  /** bump is a change elsewhere: a new head, the same rows. */
  bump() {
    this.seq++;
  }
  /** change is a phone's change of one row: a new head. */
  change(i: number, title: string) {
    this.rows = this.rows.map((r, k) => (k === i ? { ...r, title } : r));
    this.seq++;
  }
  load = async (q: { page_token?: string; limit?: number; anchor?: string; anchor_index?: number; before?: number }): Promise<ListPage<Row>> => {
    const limit = q.limit ?? 100;
    let view: string;
    let offset: number;
    let anchored = false;
    if (q.page_token) {
      const named = tokens.get(q.page_token);
      if (!named) throw new ApiError(400, "invalid", "The page token is not valid.");
      ({ view, offset } = named);
      this.requests.push({ kind: "token", view, offset, limit });
      if (!this.views.has(view) || this.expired.has(view)) throw new ApiError(410, "view_expired", "This list changed; load it again.");
    } else {
      if (this.gate) await this.gate;
      if (this.holding) {
        const d = deferred<void>();
        this.waiting.push(d);
        await d.promise;
      }
      view = String(++this.#n).padStart(32, "0");
      this.views.set(view, { rows: this.rows, head: head(this.seq) });
      offset = 0;
      if (q.anchor !== undefined || q.anchor_index !== undefined) {
        anchored = true;
        let at = q.anchor === undefined ? -1 : this.rows.findIndex((r) => r.episode_id === q.anchor);
        if (at < 0) at = Math.min(q.anchor_index ?? 0, this.rows.length);
        offset = Math.max(0, at - (q.before ?? 0));
      }
      if (!anchored && this.firstAt !== null) {
        // A list read again deep down before (the test seeds it): the first answer is that window.
        anchored = true;
        offset = Math.max(0, this.firstAt - 40);
        this.firstAt = null;
      }
      this.requests.push({ kind: anchored ? "anchored" : "first", view, offset, limit, anchor: q.anchor ?? (q.anchor_index !== undefined ? `#${q.anchor_index}` : undefined) });
    }
    const v = this.views.get(view)!;
    const items = v.rows.slice(offset, offset + limit);
    this.rowsSent += items.length;
    const page: ListPage<Row> = {
      head: v.head,
      view: { counters: this.counters },
      total: v.rows.length,
      items,
      next_page_token: offset + limit < v.rows.length ? tokenOf(view, offset + limit) : null,
    };
    if (anchored) Object.assign(page, { offset, prev_page_token: offset > 0 ? tokenOf(view, Math.max(0, offset - limit)) : null, start_page_token: tokenOf(view, 0) });
    return page;
  };
}

type Paged = ReturnType<typeof usePaged<Row>>;

/** mount shows a list (as EpisodeList lays it out: the spacer, then the rows) in a tab. */
async function mount(server: ListServer, sync: TestSync, deps: unknown[] = []) {
  const root = win.document.createElement("div");
  win.document.body.append(root);
  const box: { list: Paged } = {} as never;
  let currentDeps = deps;
  function Probe({ d }: { d: unknown[] }) {
    const list = usePaged<Row>((q) => server.load(q), d);
    box.list = list;
    const w = list.window;
    return h(
      "div",
      null,
      w.offset > 0 ? h("div", { class: "list-spacer", ref: w.spacer, style: { height: `${Math.round(w.spacerHeight)}px` } }) : null,
      h("ul", { ref: w.ref }, (list.items ?? []).map((r) => h("li", { key: r.episode_id, "data-id": r.episode_id }, r.title))),
      w.below > 0 ? h("div", { class: "list-spacer-below", ref: w.spacerBelow, style: { height: `${w.below}px` } }) : null,
    );
  }
  const draw = () => render(h(SyncContext.Provider, { value: sync as never }, h(Probe, { d: currentDeps })), root);
  await act(async () => draw());
  await act(() => settle());
  return {
    box,
    rerender: async (d: unknown[]) => {
      currentDeps = d;
      await act(async () => draw());
      await act(() => settle());
    },
    unmount: async () => {
      await act(async () => render(null, root));
      root.remove();
    },
  };
}

const rowsInDom = () => win.document.querySelectorAll("li[data-id]").length;

/**
 * uncapped lets this test hold every row it pages in: it pages far with the
 * screen kept at the top, which scrolling never does, and then goes to rows a
 * person would have scrolled past (the bound has its own test). The next test
 * starts bounded again.
 */
function uncapped(): void {
  setHeldRowsForTesting(Infinity);
}
test.afterEach(() => setHeldRowsForTesting(maxHeldRows));

/** loadedTo is the index just past the last row held: how far the list was paged. */
const loadedTo = (list: Paged) => list.window.offset + (list.items?.length ?? 0);

/** until lets the page work (reads, renders) until the condition holds. */
async function until(check: () => boolean, what = "the condition", ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await act(async () => {
      await settle(10);
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  assert.fail(`${what} never held`);
}

for (const loaded of [400, 900, 5000]) {
  test(`after ${loaded} rows are loaded, a newer head costs one request of at most 200 rows, and the rows on screen stay put`, async () => {
    scrollY = 0;
    const server = new ListServer(6000);
    const sync = await testSync();
    const { box, unmount } = await mount(server, sync);
    while (loadedTo(box.list) < loaded) await act(() => box.list.loadMore());
    assert.equal(loadedTo(box.list), loaded);
    // Read the list near its end: a row 37px below the top of the screen.
    const r = loaded - 50;
    scrollToRow(`e${r}`, 37);
    server.requests = [];
    server.rowsSent = 0;
    // A phone changes a row on screen.
    server.change(r + 3, "Changed on the phone");
    await act(async () => {
      await sync.learn(head(2));
      await settle();
    });
    assert.equal(server.requests.length, 1, "one request");
    const req = server.requests[0]!;
    assert.equal(req.kind, "anchored");
    assert.ok(req.limit <= 200);
    assert.equal(req.anchor, `e${r - 1}`, "anchored on the first row on screen");
    assert.ok(server.rowsSent <= 200);
    assert.ok(rowsInDom() <= 200, `${rowsInDom()} rows in the page`);
    near(topOf(`e${r}`), 37, "the rows on screen stay where they were");
    assert.equal(win.document.querySelector(`[data-id="e${r + 3}"]`)!.textContent, "Changed on the phone");
    const lo = box.list.window.offset;
    assert.equal(lo, r - 1 - 40);
    // Scrolling up into the rows above loads them from the same view: its head, by token.
    scrollY -= topOf(`e${lo}`)! + 300; // the spacer's last 300px on screen
    const shownTop = topOf(`e${lo}`)!;
    server.requests = [];
    await act(async () => {
      box.list.window.loadPrevious();
      await settle();
    });
    const above = Math.max(0, lo - 200); // the page before the window, by the token the server gave
    assert.deepEqual(server.requests.map((q) => [q.kind, q.view, q.offset, q.limit]), [["token", req.view, above, lo - above]]);
    assert.equal(box.list.window.offset, above);
    assert.equal(box.list.data!.head.seq, 2);
    near(topOf(`e${lo}`), shownTop, "the rows on screen stay where they were");
    assert.equal(win.document.querySelector(`[data-id="e${r + 3}"]`)!.textContent, "Changed on the phone");
    // The top of the list (Home): rows there, from the same view.
    scrollY = 0;
    server.requests = [];
    await act(async () => {
      box.list.window.loadPrevious();
      await settle();
    });
    await until(() => box.list.window.offset === 0, "the top loaded");
    assert.ok(server.requests.length > 0);
    assert.ok(server.requests.every((q) => q.limit <= 200), "each read at most 200 rows");
    assert.equal(box.list.window.offset, 0);
    near(topOf("e0"), 0);
    await unmount();
  });
}

test("near the top, a newer head re-reads the first rows held (100 to 200) from the first page", async () => {
  scrollY = 0;
  const server = new ListServer(1000);
  const sync = await testSync();
  const { box, unmount } = await mount(server, sync);
  for (let i = 0; i < 3; i++) await act(() => box.list.loadMore());
  scrollToRow("e60", 10);
  server.requests = [];
  server.change(61, "Changed");
  await act(async () => {
    await sync.learn(head(2));
    await settle();
  });
  assert.deepEqual(server.requests.map((q) => [q.kind, q.limit]), [["first", 200]]);
  near(topOf("e60"), 10);
  assert.equal(rowsInDom(), 200);
  await unmount();
});

test("an expired view met by Load more is read again around the screen, keeping its place", async () => {
  scrollY = 0;
  const server = new ListServer(3000);
  const sync = await testSync();
  const { box, unmount } = await mount(server, sync);
  for (let i = 0; i < 4; i++) await act(() => box.list.loadMore());
  scrollToRow("e420", 25);
  server.expired.add(server.requests[0]!.view);
  server.requests = [];
  await act(async () => {
    await box.list.loadMore();
    await settle();
  });
  assert.deepEqual(server.requests.map((q) => q.kind), ["token", "anchored"]);
  assert.equal(server.requests[1]!.anchor, "e419");
  near(topOf("e420"), 25);
  assert.ok(rowsInDom() <= 200);
  await unmount();
});

test("a walk of the whole list that meets an expired view does nothing, says the server's message, and the list reloads though a selection holds it", async () => {
  scrollY = 0;
  const server = new ListServer(1200);
  const sync = await testSync();
  const { box, unmount } = await mount(server, sync);
  box.list.window.hold(true); // a selection is being made: Select all, then an action
  server.expired.add(server.requests[0]!.view);
  server.requests = [];
  const journaled: unknown[] = [];
  let failure: unknown;
  await act(async () => {
    try {
      journaled.push(await box.list.all());
    } catch (e) {
      failure = e;
    }
    await settle();
  });
  assert.ok(failure instanceof BulkExpired);
  assert.equal((failure as Error).message, "This list changed; load it again.");
  assert.deepEqual(journaled, [], "nothing to act on");
  assert.deepEqual(server.requests.map((q) => q.kind), ["token", "first"], "no restart of the walk; the list reloads");
  await unmount();
});

test("a walk of a window from its start reads the whole view at its head", async () => {
  scrollY = 0;
  const server = new ListServer(700);
  const sync = await testSync();
  const { box, unmount } = await mount(server, sync);
  for (let i = 0; i < 4; i++) await act(() => box.list.loadMore());
  scrollToRow("e400", 0);
  await act(async () => {
    await sync.learn(head(2));
    await settle();
  });
  assert.ok(box.list.window.offset > 0);
  server.change(5, "after the window");
  const all = await box.list.all();
  assert.equal(all.length, 700);
  assert.equal(all[5]!.title, "Episode 5", "the window's head, not a newer one");
  await unmount();
});

test("the answer for a replaced query never fills the new query", async () => {
  scrollY = 0;
  const server = new ListServer(50);
  const sync = await testSync();
  const gate = deferred<void>();
  const slow = server.load;
  let first = true;
  server.load = async (q) => {
    if (first) {
      first = false;
      await gate.promise;
      return { ...(await slow(q)), items: [{ episode_id: "old", title: "Old query" }] };
    }
    return slow(q);
  };
  const m = await mount(server, sync, ["a"]);
  await m.rerender(["b"]);
  assert.equal(m.box.list.items?.[0]?.title, "Episode 0");
  gate.resolve();
  await act(() => settle());
  assert.equal(m.box.list.items?.[0]?.title, "Episode 0");
  assert.equal(win.document.querySelector('[data-id="old"]'), null);
  await m.unmount();
});

test("while a selection holds the list it does not re-read; released, it reads once", async () => {
  scrollY = 0;
  const server = new ListServer(50);
  const sync = await testSync();
  const { box, unmount } = await mount(server, sync);
  box.list.window.hold(true);
  server.requests = [];
  for (let i = 2; i < 6; i++) {
    server.change(1, `v${i}`);
    await act(() => sync.learn(head(i)));
  }
  await act(() => settle());
  assert.equal(server.requests.length, 0);
  await act(async () => {
    box.list.window.hold(false);
    await settle();
  });
  assert.equal(server.requests.length, 1);
  assert.equal(win.document.querySelector('[data-id="e1"]')!.textContent, "v5");
  await unmount();
});

// ---- several views of one tab

function Views({ server, out }: { server: ListServer; out: { reads: number } }) {
  const one = useView(async () => {
    out.reads++;
    return { head: head(server.seq), counters: server.counters };
  }, []);
  usePaged<Row>((q) => server.load(q), []);
  return h("p", null, String(one.data?.head.seq));
}

async function views(sync: TestSync, server: ListServer, out: { reads: number }) {
  const root = win.document.createElement("div");
  win.document.body.append(root);
  await act(async () => render(h(SyncContext.Provider, { value: sync as never }, h(Views, { server, out })), root));
  await act(() => settle());
  return async () => {
    await act(async () => render(null, root));
    root.remove();
  };
}

test("a push's response and its event for the same head make one read per view; an equal head none; a revalidation one", async () => {
  const server = new ListServer(10);
  const sync = await testSync();
  const out = { reads: 0 };
  const done = await views(sync, server, out);
  const reads = () => out.reads + server.requests.length;
  assert.equal(reads(), 2);
  sync.heard(JSON.stringify({ log_id: head(1).log_id, epoch: 1, seq: 1 })); // the stream's first event: the head shown
  await act(() => settle());
  assert.equal(reads(), 2);
  server.change(1, "x");
  await act(async () => {
    await sync.learn(head(2)); // the push's response
    sync.heard(JSON.stringify({ log_id: head(2).log_id, epoch: 1, seq: 2 })); // its event
    await settle();
  });
  assert.equal(reads(), 4);
  await act(async () => {
    sync.revalidate.set(sync.revalidate.get() + 1); // focus
    await settle();
  });
  assert.equal(reads(), 6);
  await done();
});

test("a hidden tab's views read nothing for ten heads, then once each when it shows", async () => {
  const server = new ListServer(10);
  const sync = await testSync();
  const out = { reads: 0 };
  const done = await views(sync, server, out);
  const reads = () => out.reads + server.requests.length;
  sync.visible.set(false);
  for (let i = 2; i <= 11; i++) {
    server.change(1, `v${i}`);
    await act(() => sync.learn(head(i)));
  }
  await act(() => settle());
  assert.equal(reads(), 2);
  await act(async () => {
    sync.visible.set(true);
    await settle();
  });
  assert.equal(reads(), 4);
  await done();
});

test("a view applied moves the drawer's counters and the head shown", async () => {
  const server = new ListServer(10);
  const sync = await testSync();
  const out = { reads: 0 };
  server.counters = { queue: 4, inbox: 2 };
  const done = await views(sync, server, out);
  assert.deepEqual(sync.counters.get()?.counters, { queue: 4, inbox: 2 });
  assert.deepEqual(sync.shownHeads.map((x) => x.seq), [1, 1]);
  await done();
});

test("a delayed answer of the lineage the server left (a restore announced) is never shown: no head shown, no counters", async () => {
  const sync = await testSync({ log_id: L1, epoch: 1 });
  await sync.learn(head(1, L1, 2));
  let shown: unknown = "unset";
  function One() {
    const v = useView(async () => ({ head: head(5), counters: { queue: 9, inbox: 9 } }), []);
    shown = v.data;
    return null;
  }
  const root = win.document.createElement("div");
  win.document.body.append(root);
  await act(async () => render(h(SyncContext.Provider, { value: sync as never }, h(One, null)), root));
  await act(() => settle());
  assert.equal(shown, undefined);
  assert.deepEqual(sync.shownHeads, []);
  assert.equal(sync.counters.get(), null);
  await act(async () => render(null, root));
  root.remove();
});

test("a view's answer for another account (switched mid-read) is never shown", async () => {
  const a = await testSync();
  const b = await testSync();
  const gate = deferred<{ head: Head; counters: Counters }>();
  let shown: unknown;
  function One() {
    const v = useView(() => gate.promise, []);
    shown = v.data;
    return null;
  }
  const root = win.document.createElement("div");
  win.document.body.append(root);
  await act(async () => render(h(SyncContext.Provider, { value: a as never }, h(One, null)), root));
  await act(async () => render(h(SyncContext.Provider, { value: b as never }, h(One, null)), root));
  gate.resolve({ head: head(3), counters: { queue: 9, inbox: 9 } });
  await act(() => settle());
  // b's own read used the same (resolved) promise: it is b's; a applied nothing.
  assert.equal(a.shownHeads.length, 0);
  assert.equal(a.counters.get(), null);
  assert.ok(shown);
  await act(async () => render(null, root));
  root.remove();
});

// ---- the drawer

test("the drawer's counters follow the screens' views without a request; its podcasts re-read once per head while displayed", async () => {
  const { useDrawer } = await import("../src/ui/drawer.ts");
  let narrow = true;
  const listeners = new Set<() => void>();
  (globalThis as Record<string, unknown>).matchMedia = () => ({
    get matches() {
      return narrow;
    },
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  });
  let subscriptions = 0;
  let seq = 1;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).startsWith("/v1/read/subscriptions")) subscriptions++;
    return new Response(JSON.stringify({ head: head(seq), view: { counters: { queue: 0, inbox: 0 } }, total: 0, items: [], next_page_token: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const sync = await testSync();
    let drawer!: ReturnType<typeof useDrawer>;
    function Drawer({ open }: { open: boolean }) {
      drawer = useDrawer(open);
      return null;
    }
    const root = win.document.createElement("div");
    win.document.body.append(root);
    const draw = (open: boolean) => act(async () => render(h(SyncContext.Provider, { value: sync as never }, h(Drawer, { open })), root));
    await draw(false);
    await act(() => settle(40));
    assert.equal(subscriptions, 1, "its first read");
    // A screen's view at a newer head: the badges move, no subscriptions request (closed, narrow).
    seq = 2;
    await act(async () => {
      sync.applied(head(2), { queue: 7, inbox: 3 });
      await settle(40);
    });
    assert.deepEqual(drawer.counters, { queue: 7, inbox: 3 });
    assert.equal(subscriptions, 1);
    // Opened: read once for the head it missed.
    await draw(true);
    await act(() => settle(40));
    assert.equal(subscriptions, 2);
    // Wide (always displayed): once per newer head, none for an equal one.
    narrow = false;
    seq = 3;
    await act(async () => {
      await sync.learn(head(3));
      await settle(40);
    });
    assert.equal(subscriptions, 3);
    await act(async () => {
      await sync.learn(head(3));
      await settle(40);
    });
    assert.equal(subscriptions, 3);
    await act(async () => render(null, root));
    root.remove();
  } finally {
    globalThis.fetch = original;
  }
});

// ---- a selection on a window of the list (Android's SelectableAdapter), and reads in flight


interface Picker {
  list: Paged;
  selection: ReturnType<typeof useListSelection<Row>>;
  targets?: Row[];
}

/** pick mounts a list as EpisodeList wires its selection, with one action that records the rows it is given. */
async function pick(server: ListServer, sync: TestSync) {
  const root = win.document.createElement("div");
  win.document.body.append(root);
  const box: Picker = {} as never;
  function Probe() {
    const list = usePaged<Row>((q) => server.load(q), []);
    const w = list.window;
    const selection = useListSelection<Row>(list.items, list.total, w);
    box.list = list;
    box.selection = selection;
    return h(
      "div",
      null,
      w.offset > 0 ? h("div", { class: "list-spacer", ref: w.spacer, style: { height: `${Math.round(w.spacerHeight)}px` } }) : null,
      h("ul", { ref: w.ref }, (list.items ?? []).map((r) => h("li", { key: r.episode_id, "data-id": r.episode_id }, r.title))),
      selection.active
        ? h(SelectActions<Row>, { sync: sync as never, selection, all: list.all, actions: [{ icon: "check", label: "Capture", run: (rows: Row[]) => void (box.targets = rows) }] })
        : null,
    );
  }
  await act(async () => render(h(SyncContext.Provider, { value: sync as never }, h(Probe, null)), root));
  await act(() => settle());
  const capture = async () => {
    box.targets = undefined;
    const button = [...root.querySelectorAll("button")].find((b) => b.textContent?.includes("Capture"))!;
    await act(async () => {
      (button as unknown as HTMLButtonElement).click();
      await settle();
    });
    await until(() => !box.selection.active || box.targets !== undefined, "the action");
    await act(() => settle());
  };
  return {
    box,
    capture,
    unmount: async () => {
      await act(async () => render(null, root));
      root.remove();
    },
  };
}

/** windowAt360 loads 600 rows of a 1,000-row list, then reads it again around row 400: the window holds [360, 560). */
async function windowAt360(server: ListServer, sync: TestSync) {
  scrollY = 0;
  const p = await pick(server, sync);
  while (loadedTo(p.box.list) < 600) await act(() => p.box.list.loadMore());
  scrollToRow("e400", 0);
  server.bump();
  await act(async () => {
    await sync.learn(head(server.seq));
    await settle();
  });
  await until(() => p.box.list.window.offset === 360, "the window at 360");
  assert.equal(p.box.list.items!.length, 200);
  return p;
}

const ids = (rows: Row[] | undefined) => (rows ?? []).map((r) => r.episode_id);
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => `e${a + i}`);

test("on a window [360, 560), Select all below takes row 400 to the end, and nothing above it", async () => {
  const server = new ListServer(1000);
  const sync = await testSync();
  const p = await windowAt360(server, sync);
  await act(async () => p.box.selection.start("e400"));
  await act(async () => actionMode.get()!.below());
  assert.equal(actionMode.get()!.count, 600);
  await p.capture();
  assert.deepEqual(ids(p.box.targets), range(400, 1000));
  await p.unmount();
});

test("on a window [360, 560), Select all above takes the first row to row 400, the rows not loaded included", async () => {
  const server = new ListServer(1000);
  const sync = await testSync();
  const p = await windowAt360(server, sync);
  await act(async () => p.box.selection.start("e400"));
  await act(async () => actionMode.get()!.above());
  assert.equal(actionMode.get()!.count, 401);
  await p.capture();
  assert.deepEqual(ids(p.box.targets), range(0, 401));
  await p.unmount();
});

test("on a window [360, 560), Select all takes every row in list order, but those deselected; Add to queue keeps that order", async () => {
  const server = new ListServer(1000);
  const sync = await testSync();
  const p = await windowAt360(server, sync);
  await act(async () => p.box.selection.start("e400"));
  await act(async () => actionMode.get()!.toggleAll());
  assert.equal(actionMode.get()!.count, 1000);
  assert.equal(actionMode.get()!.allSelected, true);
  await act(async () => p.box.selection.click("e365", false));
  await act(async () => p.box.selection.click("e500", false));
  assert.equal(actionMode.get()!.count, 998);
  await p.capture();
  const want = range(0, 1000).filter((id) => id !== "e365" && id !== "e500");
  assert.deepEqual(ids(p.box.targets), want, "list order, not the window first");
  // Add to queue with Keep sorted off: the queue's order is the list's (EpisodeMultiSelectActionHandler → addQueueItem).
  const body = addToQueue(p.box.targets as never, [], { enqueue_location: "back", keep_sorted: false, sort_order: "date_new_old" } as never)!;
  const members = (body.payload as { members: { episode: { episode_id: string }; key: string }[] }).members;
  const queued = [...members].sort((a, b) => compareKeys(parseKey(a.key)!, parseKey(b.key)!)).map((m) => m.episode.episode_id);
  assert.deepEqual(queued, want);
  await p.unmount();
});

test("a selection whose view expires while its rows are read saves nothing, says why, and ends", async () => {
  const server = new ListServer(1000);
  const sync = await testSync();
  const p = await windowAt360(server, sync);
  const said: string[] = [];
  reportFailuresTo((text) => said.push(text));
  await act(async () => p.box.selection.start("e400"));
  await act(async () => actionMode.get()!.below());
  server.expired.add(server.requests.at(-1)!.view);
  await p.capture();
  assert.equal(p.box.targets, undefined, "the action never ran");
  assert.deepEqual(said, ["This list changed; load it again."]);
  await until(() => !p.box.selection.active, "the selection ended");
  reportFailuresTo(() => {});
  await p.unmount();
});

test("a re-read in flight when a selection starts waits until it ends: the selected row stays, and the action uses the selection's view", async () => {
  scrollY = 0;
  const server = new ListServer(600);
  const sync = await testSync();
  const p = await pick(server, sync);
  while (loadedTo(p.box.list) < 500) await act(() => p.box.list.loadMore());
  scrollToRow("e400", 0);
  const gate = deferred<void>();
  server.gate = gate.promise;
  server.requests = [];
  // Another device takes row 400 off the list; this tab re-reads around it.
  server.remove("e400");
  await act(async () => {
    await sync.learn(head(server.seq));
    await settle();
  });
  assert.deepEqual(server.requests, [], "the read waits at the server");
  await act(async () => p.box.selection.start("e400"));
  server.gate = null;
  gate.resolve();
  await act(() => settle(40));
  assert.equal(server.requests.length, 1, "the read was not aborted");
  assert.equal(p.box.list.data!.head.seq, 1, "the list holds still");
  assert.ok(win.document.querySelector('[data-id="e400"]'), "the selected row is still there");
  assert.ok(p.box.selection.isSelected("e400"));
  await act(async () => actionMode.get()!.toggleAll());
  await p.capture();
  assert.equal(p.box.targets!.length, 600, "the selection's view (row 400 included)");
  assert.equal(p.box.targets![400]!.episode_id, "e400");
  // The selection over, what arrived meanwhile shows.
  await until(() => p.box.list.data!.head.seq === 2, "the newer window");
  assert.equal(win.document.querySelector('[data-id="e400"]'), null);
  await p.unmount();
});

for (const [where, to] of [["down", "e850"], ["up", "e150"]] as const) {
  test(`scrolled ${where} while a re-read is in flight, the row on screen stays where it is and the window stays bounded`, async () => {
    uncapped();
    scrollY = 0;
    const server = new ListServer(2000);
    const sync = await testSync();
    const { box, unmount } = await mount(server, sync);
    while (loadedTo(box.list) < 1000) await act(() => box.list.loadMore());
    scrollToRow("e400", 0);
    const gate = deferred<void>();
    server.gate = gate.promise;
    server.requests = [];
    server.bump();
    await act(async () => {
      await sync.learn(head(server.seq));
      await settle();
    });
    // The read was planned around row 400; the person scrolls on meanwhile.
    scrollToRow(to, 25);
    server.gate = null;
    gate.resolve();
    await until(() => box.list.data!.head.seq === 2, "the newer window");
    await act(() => settle(40));
    near(topOf(to), 25, "the row on screen stays where it is");
    assert.ok(rowsInDom() <= 200, `${rowsInDom()} rows`);
    assert.ok(server.requests.every((q) => q.kind === "anchored" && q.limit <= 200), JSON.stringify(server.requests.map((q) => [q.kind, q.offset, q.limit])));
    assert.equal(server.requests.at(-1)!.anchor, `e${Number(to.slice(1)) - 1}`, "the window where the screen is");
    await unmount();
  });
}

test("rows above load page after page to the top with tokens the server gave (opaque to the client), and the top is the first page", async () => {
  uncapped();
  scrollY = 0;
  const server = new ListServer(2000);
  const sync = await testSync();
  const { box, unmount } = await mount(server, sync);
  while (loadedTo(box.list) < 900) await act(() => box.list.loadMore());
  scrollToRow("e800", 0);
  server.bump();
  await act(async () => {
    await sync.learn(head(server.seq));
    await settle();
  });
  await until(() => box.list.window.offset === 760, "the window at 760");
  server.requests = [];
  // Scrolling up, the spacer's end comes into sight again and again.
  for (let step = 0; step < 20 && box.list.window.offset > 0; step++) {
    const before = box.list.window.offset;
    const first = `e${before}`;
    scrollY += topOf(first)! - 200; // the spacer's last 200px on screen, above the first row
    const at = topOf(first)!;
    assert.equal(at, 200);
    await act(async () => {
      box.list.window.loadPrevious();
      await settle();
    });
    await until(() => box.list.window.offset < before, `rows above ${before}`);
    near(topOf(first), at, "the rows on screen stay where they were");
    assert.ok(win.document.querySelector(`[data-id="e${before - 1}"]`), "the row just above is there");
  }
  assert.equal(box.list.window.offset, 0);
  assert.ok(server.requests.every((q) => q.limit <= 200), "at most 200 rows a read");
  assert.ok(server.requests.length <= 10, `${server.requests.length} reads`);
  await unmount();

  // Home from the window at 760: the first page.
  scrollY = 0;
  const m = await mount(server, sync);
  while (loadedTo(m.box.list) < 900) await act(() => m.box.list.loadMore());
  scrollToRow("e800", 0);
  server.bump();
  await act(async () => {
    await sync.learn(head(server.seq));
    await settle();
  });
  await until(() => m.box.list.window.offset === 760, "the window at 760");
  server.requests = [];
  scrollY = 0;
  await act(async () => {
    m.box.list.window.loadPrevious();
    await settle();
  });
  await until(() => m.box.list.window.offset === 0, "the top");
  assert.deepEqual(server.requests.map((q) => [q.kind, q.limit]), [["first", 200]]);
  near(topOf("e0"), 0);
  await m.unmount();
});

test("a row on screen removed on another device: one read, and the next row stays where it was", async () => {
  uncapped();
  scrollY = 0;
  const server = new ListServer(1000);
  const sync = await testSync();
  const { box, unmount } = await mount(server, sync);
  while (loadedTo(box.list) < 1000) await act(() => box.list.loadMore());
  scrollToRow("e400", 0);
  const at = topOf("e401");
  assert.equal(at, 55);
  server.requests = [];
  server.rowsSent = 0;
  server.remove("e400");
  await act(async () => {
    await sync.learn(head(server.seq));
    await settle();
  });
  await until(() => box.list.data!.head.seq === 2, "the newer window");
  await act(() => settle(40));
  assert.equal(server.requests.length, 1, JSON.stringify(server.requests.map((q) => [q.kind, q.offset, q.anchor])));
  assert.equal(server.rowsSent, 200);
  near(topOf("e401"), at);
  assert.equal(win.document.querySelector('[data-id="e400"]'), null);
  await unmount();
});

test("scrolling on through five answers of a re-read: no answer without the row on screen is shown, and the reads stay bounded", async () => {
  uncapped();
  scrollY = 0;
  const server = new ListServer(3000);
  const sync = await testSync();
  const { box, unmount } = await mount(server, sync);
  while (loadedTo(box.list) < 3000) await act(() => box.list.loadMore());
  scrollToRow("e400", 0);
  server.requests = [];
  server.holding = true;
  server.bump();
  await act(async () => {
    await sync.learn(head(server.seq));
    await settle();
  });
  // Before each answer arrives, the person has scrolled on among the rows held.
  for (const to of ["e750", "e1100", "e1450", "e1800", "e2150"]) {
    await until(() => server.waiting.length > 0, "a read");
    scrollToRow(to, 25);
    server.waiting.shift()!.resolve();
    await act(() => settle(40));
    near(topOf(to), 25, `${to} stays where it is`);
    assert.equal(box.list.data!.head.seq, 1, "no answer that misses the screen is shown");
  }
  server.holding = false;
  for (const w of server.waiting.splice(0)) w.resolve();
  await until(() => box.list.data!.head.seq === 2, "the window where the screen is");
  near(topOf("e2150"), 25);
  assert.ok(rowsInDom() <= 200, `${rowsInDom()} rows`);
  assert.ok(server.requests.length <= 6, `${server.requests.length} reads`);
  assert.equal(server.requests.at(-1)!.anchor, "e2149");
  await unmount();
});

test("a jump far into the rows above a deep window reads the window where the screen is, in one read", async () => {
  uncapped();
  const server = new ListServer(50_000);
  server.firstAt = 45_000;
  const sync = await testSync();
  // The list was read again around row 45,000 before: the screen shows that window.
  scrollY = 44_960 * 72;
  const { box, unmount } = await mount(server, sync);
  assert.equal(box.list.window.offset, 44_960);
  assert.ok(topOf("e44960")! >= 0 && topOf("e44960")! < viewport, "the window's rows on screen");
  // The scrollbar dragged to about row 20,000.
  const perRow = box.list.window.spacerHeight / box.list.window.offset;
  server.requests = [];
  scrollY = Math.round(20_000 * perRow + 30);
  win.dispatchEvent(new win.Event("scroll"));
  await act(async () => {
    box.list.window.loadPrevious();
    await settle();
  });
  await until(() => box.list.window.offset < 44_960, "the window where the screen is");
  await act(() => settle(40));
  assert.ok(server.requests.length <= 2, `${server.requests.length} reads`);
  assert.equal(server.requests[0]!.anchor, "#20000", "one read at the screen's index");
  assert.equal(box.list.window.offset, 19_960);
  const first = [...win.document.querySelectorAll("li[data-id]")].find((li) => (li as unknown as HTMLElement).getBoundingClientRect().bottom > 0) as unknown as HTMLElement;
  assert.ok(["e20000", "e20001"].includes(first.dataset.id!), `the rows at that index are on screen (${first.dataset.id})`);
  assert.ok(first.getBoundingClientRect().top > -100 && first.getBoundingClientRect().top <= 0);
  await unmount();
});

test("rows kept in place correct the spacer, not the page's scroll (a scroll under way goes on)", async () => {
  uncapped();
  scrollY = 0;
  const server = new ListServer(1000);
  const sync = await testSync();
  const { box, unmount } = await mount(server, sync);
  while (loadedTo(box.list) < 900) await act(() => box.list.loadMore());
  scrollToRow("e800", 30);
  server.bump();
  scrolledBy = 0;
  await act(async () => {
    await sync.learn(head(server.seq));
    await settle();
  });
  await until(() => box.list.window.offset === 759, "the window around the screen");
  near(topOf("e800"), 30);
  // Rows above load as the screen moves up through them, and each keeps the rows on screen.
  scrollY += topOf("e759")! - 100;
  const at = topOf("e759")!;
  await act(async () => {
    box.list.window.loadPrevious();
    await settle();
  });
  await until(() => box.list.window.offset < 759, "rows above");
  near(topOf("e759"), at);
  assert.equal(scrolledBy, 0, "the page was not scrolled");
  await unmount();
});

// ---- the screen measured at the swap, the rows below a window, a return during a jump, the top

test("a scroll already on screen when the answer is accepted (no event yet) keeps its row: the window is read where the screen is", async () => {
  uncapped();
  scrollY = 0;
  const server = new ListServer(2000);
  const sync = await testSync();
  const { box, unmount } = await mount(server, sync);
  while (loadedTo(box.list) < 1000) await act(() => box.list.loadMore());
  scrollToRow("e350", 0);
  // The answer's acceptance waits (queued IndexedDB work), after the server has answered.
  const accepts = sync.accepts.bind(sync);
  let gate: Promise<void> | null = null;
  let release!: () => void;
  let waited = false;
  (sync as unknown as { accepts: typeof accepts }).accepts = async (h) => {
    if (gate) {
      waited = true;
      await gate;
    }
    return accepts(h);
  };
  gate = new Promise((r) => (release = r));
  server.requests = [];
  server.bump();
  await act(async () => {
    await sync.learn(head(server.seq));
    await settle();
  });
  await until(() => waited, "the answer waiting for acceptance");
  // The screen moves on to row 850 meanwhile; its scroll event has not run yet.
  scrollY += topOf("e850")! - 413;
  gate = null;
  release();
  await until(() => box.list.data!.head.seq === 2, "the newer window", 10_000);
  await act(() => settle(40));
  near(topOf("e850"), 413, "row 850 stays where it is");
  assert.ok(rowsInDom() <= 200, `${rowsInDom()} rows`);
  assert.equal(server.requests.length, 2, JSON.stringify(server.requests.map((q) => [q.kind, q.offset, q.anchor])));
  await unmount();
});

test("after a re-read in the middle, the rows below stay reachable: a jump into them reads the window there in one read, and the end of the list too", async () => {
  uncapped();
  scrollY = 0;
  const server = new ListServer(50_000);
  const sync = await testSync();
  const { box, unmount } = await mount(server, sync);
  while (loadedTo(box.list) < 1000) await act(() => box.list.loadMore());
  scrollToRow("e350", 0);
  server.bump();
  await act(async () => {
    await sync.learn(head(server.seq));
    await settle();
  });
  await until(() => box.list.window.offset === 310, "the window around row 350");
  const below = win.document.querySelector(".list-spacer-below") as unknown as HTMLElement;
  assert.ok(below, "a spacer stands for the rows below");
  const hi = box.list.window.offset + box.list.items!.length;
  const perRow = box.list.window.below / (50_000 - hi);
  // The scrollbar dragged down to about row 30,000.
  server.requests = [];
  scrollY += below.getBoundingClientRect().top + Math.round((30_000 - hi) * perRow) + 10;
  win.dispatchEvent(new win.Event("scroll"));
  await act(async () => {
    box.list.window.loadBelow();
    await settle();
  });
  await until(() => box.list.window.offset > 1000, "the window where the screen is");
  await act(() => settle(40));
  assert.ok(server.requests.length <= 2, `${server.requests.length} reads`);
  assert.equal(server.requests[0]!.anchor, "#30000", "one read at the screen's index");
  assert.equal(box.list.window.offset, 29_960);
  const firstOn = () => ([...win.document.querySelectorAll("li[data-id]")] as unknown as HTMLElement[]).find((li) => li.getBoundingClientRect().bottom > 0)!;
  assert.ok(["e30000", "e30001"].includes(firstOn().dataset.id!), `the rows at that index are on screen (${firstOn().dataset.id})`);
  // The end of the list (End): one read for its last rows.
  server.requests = [];
  const rest = win.document.querySelector(".list-spacer-below") as unknown as HTMLElement;
  scrollY += rest.getBoundingClientRect().bottom - viewport;
  win.dispatchEvent(new win.Event("scroll"));
  await act(async () => {
    box.list.window.loadBelow();
    await settle();
  });
  await until(() => !!win.document.querySelector('[data-id="e49999"]'), "the last row");
  assert.ok(server.requests.length <= 2, `${server.requests.length} reads`);
  assert.equal(box.list.window.below, 0, "nothing below the last row");
  await unmount();
});

test("a jump's newer answer while the person has come back to a row still held keeps that row where it is", async () => {
  uncapped();
  scrollY = 0;
  const server = new ListServer(5000);
  const sync = await testSync();
  const { box, unmount } = await mount(server, sync);
  while (loadedTo(box.list) < 1000) await act(() => box.list.loadMore());
  scrollToRow("e950", 0);
  server.bump();
  await act(async () => {
    await sync.learn(head(server.seq));
    await settle();
  });
  await until(() => box.list.window.offset === 910, "the window around row 950");
  // A jump up to about row 650, held at the server.
  server.holding = true;
  server.requests = [];
  const perRow = box.list.window.spacerHeight / box.list.window.offset;
  scrollY = Math.round(650 * perRow) + 5;
  win.dispatchEvent(new win.Event("scroll"));
  await act(async () => {
    box.list.window.loadPrevious();
    await settle();
  });
  await until(() => server.waiting.length > 0, "the jump's read");
  // The person comes back to row 950; meanwhile another device takes the first 200 rows off the list.
  scrollToRow("e950", 413);
  server.removeFirst(200);
  server.holding = false;
  server.waiting.shift()!.resolve();
  await until(() => box.list.data!.head.seq === 3, "the jump's answer");
  await act(() => settle(40));
  near(topOf("e950"), 413, "row 950 stays where it is");
  await unmount();
});

test("the top (Home) is the first page with no scroll of the page's own, so a scroll under way goes on", async () => {
  uncapped();
  scrollY = 0;
  const server = new ListServer(2000);
  const sync = await testSync();
  const { box, unmount } = await mount(server, sync);
  while (loadedTo(box.list) < 900) await act(() => box.list.loadMore());
  scrollToRow("e800", 0);
  server.bump();
  await act(async () => {
    await sync.learn(head(server.seq));
    await settle();
  });
  await until(() => box.list.window.offset === 760, "the window at 760");
  // Home under way: the screen passes about row 100 of the spacer.
  const perRow = box.list.window.spacerHeight / box.list.window.offset;
  scrollY = Math.round(100 * perRow);
  scrolledBy = 0;
  await act(async () => {
    box.list.window.loadPrevious();
    await settle();
  });
  await until(() => box.list.window.offset === 0, "the first page");
  assert.equal(scrolledBy, 0, "the page was not scrolled");
  await unmount();
});

test("Home and End on a windowed list: one read of the rows there, and the screen goes to them", async () => {
  uncapped();
  scrollY = 0;
  const server = new ListServer(5000);
  const sync = await testSync();
  const { box, unmount } = await mount(server, sync);
  while (loadedTo(box.list) < 1000) await act(() => box.list.loadMore());
  scrollToRow("e350", 0);
  server.bump();
  await act(async () => {
    await sync.learn(head(server.seq));
    await settle();
  });
  await until(() => box.list.window.offset === 310, "the window around row 350");
  const scrollTo = win.scrollTo;
  const went: number[] = [];
  // The page's bottom: the spacer above, the rows, the spacer below.
  const bottom = () => {
    const below = win.document.querySelector(".list-spacer-below") as unknown as HTMLElement | null;
    const ul = win.document.querySelector("ul") as unknown as HTMLElement;
    return (below ?? ul).getBoundingClientRect().bottom + scrollY;
  };
  (win as unknown as { scrollTo: (x: number, y: number) => void }).scrollTo = (_x, y) => {
    went.push(y);
    scrollY = Math.max(0, Math.min(y, bottom() - viewport));
  };
  Object.defineProperty(win.document.documentElement, "scrollHeight", { configurable: true, get: bottom });
  try {
    server.requests = [];
    let handled = false;
    await act(async () => {
      handled = box.list.window.toEdge("end");
      await settle();
    });
    assert.equal(handled, true);
    await until(() => !!win.document.querySelector('[data-id="e4999"]'), "the last row");
    assert.deepEqual(server.requests.map((q) => [q.kind, q.offset, q.limit, q.anchor]), [["anchored", 4800, 200, "#4999"]]);
    assert.equal(box.list.window.below, 0);
    assert.equal(went.length, 1, "the screen went to the end");
    server.requests = [];
    await act(async () => {
      box.list.window.toEdge("top");
      await settle();
    });
    await until(() => box.list.window.offset === 0, "the first rows");
    assert.deepEqual(server.requests.map((q) => [q.kind, q.limit]), [["first", 200]]);
    assert.equal(went.at(-1), 0, "the screen went to the top");
    assert.equal(box.list.window.toEdge("top"), false, "at the top, the browser's Home does it");
  } finally {
    (win as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo;
    delete (win.document.documentElement as unknown as Record<string, unknown>).scrollHeight;
  }
  await unmount();
});

test("while a selection holds a view, it is read once a minute so the server keeps it; never when nothing is held", async () => {
  scrollY = 0;
  const server = new ListServer(1000);
  const sync = await testSync();
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  (globalThis as Record<string, unknown>).setInterval = (fn: () => void, ms: number) => {
    const t = { fn, ms, cleared: false };
    timers.push(t);
    return t;
  };
  (globalThis as Record<string, unknown>).clearInterval = (t: { cleared: boolean } | undefined) => {
    if (t && typeof t === "object" && "cleared" in t) t.cleared = true;
  };
  try {
    const { box, unmount } = await mount(server, sync);
    await act(() => box.list.loadMore());
    assert.equal(timers.length, 0, "nothing held: no renewal");
    const view = server.requests[0]!.view;
    box.list.window.hold(true);
    assert.deepEqual(timers.map((t) => t.ms), [60_000]);
    server.requests = [];
    for (let minute = 1; minute <= 3; minute++) {
      await act(async () => {
        timers[0]!.fn();
        await settle();
      });
      assert.equal(server.requests.length, minute, "one read a minute");
    }
    assert.ok(server.requests.every((q) => q.kind === "token" && q.view === view && q.limit === 1), "the held view, one row");
    const rows = win.document.querySelectorAll("li[data-id]").length;
    assert.equal(rows, 200, "nothing changes on screen");
    box.list.window.hold(false);
    assert.equal(timers[0]!.cleared, true, "stopped when the selection ends");
    await unmount();
  } finally {
    (globalThis as Record<string, unknown>).setInterval = realSet;
    (globalThis as Record<string, unknown>).clearInterval = realClear;
  }
});

test("paging on through 100 pages holds at most 400 rows and draws as many, keeps the row on screen in place, and costs one page a step", async () => {
  scrollY = 0;
  const server = new ListServer(12_000);
  const sync = await testSync();
  const { box, unmount } = await mount(server, sync);
  const held: number[] = [];
  for (let step = 0; step < 100; step++) {
    // The person scrolls to the end of what is held; Load more comes into sight.
    const last = box.list.items!.at(-1)!.episode_id;
    scrollToRow(last, viewport - heightOf(last));
    const shown = box.list.items!.at(-3)!.episode_id;
    const top = topOf(shown)!;
    server.requests = [];
    server.rowsSent = 0;
    await act(() => box.list.loadMore());
    await act(() => settle());
    assert.equal(server.requests.length, 1, `step ${step}: one read`);
    assert.equal(server.rowsSent, 100, `step ${step}: one page`);
    near(topOf(shown), top, `step ${step}: the row on screen stays where it was`);
    assert.ok(box.list.items!.length <= maxHeldRows, `step ${step}: ${box.list.items!.length} rows held`);
    assert.equal(rowsInDom(), box.list.items!.length, `step ${step}: only the rows held are drawn`);
    // The rows held are one contiguous range of the list: a row's index is the window's offset plus its place.
    box.list.items!.forEach((r, k) => assert.equal(r.episode_id, `e${box.list.window.offset + k}`));
    held.push(box.list.items!.length);
  }
  assert.equal(loadedTo(box.list), 10_100);
  assert.deepEqual(held.slice(10), new Array(90).fill(maxHeldRows), "the same rows held at every step once full");
  // Back up into the rows let go: one bounded read around the first row held, which stays where it is.
  const first = `e${box.list.window.offset}`;
  scrollToRow(first, 300);
  server.requests = [];
  await act(async () => {
    box.list.window.loadPrevious();
    await settle();
  });
  assert.equal(server.requests.length, 1);
  assert.ok(server.requests[0]!.limit <= 200, `a read of ${server.requests[0]!.limit} rows`);
  near(topOf(first), 300, "the row on screen stays where it was");
  assert.ok(box.list.window.offset < 9_700, "the rows above are held again");
  assert.ok(rowsInDom() <= maxHeldRows, `${rowsInDom()} rows drawn`);
  await unmount();
});
