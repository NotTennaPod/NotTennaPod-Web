// Paging a list view (PROTOCOL §12): the rows held are one contiguous range
// [lo, hi) of one view, at one head. A newer head or a revalidation re-reads
// only the visible window: from the first page while the first visible row is
// near the top, else a window anchored on it (`anchor`, `before`). The new
// rows replace the old at once, and only if they hold the row on screen when
// they arrive (else the window where the screen now is is read); a spacer
// stands for the rows above the window, and the rows on screen stay where
// they were. Rows above load as they scroll into sight, with the documented
// read API only: the window's page before it (a token the server returned),
// else a window anchored on the first row held, and the first page for the
// top. Load more continues below. A list without anchors (the subscriptions)
// re-reads the rows it holds. While a selection is made the list holds still:
// an answer that arrives meanwhile waits until it ends, and actions on the
// selection walk the view it was made on.
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { headAtLeast, type EpisodeRow, type Head, type ListPage } from "../api/views.ts";
import { ApiError } from "../api/http.ts";
import { useSync } from "../app/context.ts";
import { acceptable, countersOf, retryable, useReader } from "../app/useView.ts";
import { Unreachable } from "../api/http.ts";
import { sameLineage } from "../app/heads.ts";

export type PageQuery = {
  page_token?: string;
  limit?: number;
  anchor?: string;
  anchor_index?: number;
  before?: number;
};

/** A re-read at most this many rows; the first page and Load more read a page. */
export const windowRows = 200;
export const pageRows = 100;
/** Rows read ahead of the anchor of a window. */
export const beforeRows = 40;
/**
 * The most rows a list holds: paging on (Load more) lets go of the rows
 * furthest above, and rows read above join only while they fit (else a
 * window around them is read), so the rows held and drawn stay bounded
 * however far the list is scrolled.
 */
export const maxHeldRows = 2 * windowRows;
let heldRows = maxHeldRows;

/** setHeldRowsForTesting sets the bound on the rows held, for tests that page far with the screen kept at the top (which scrolling never does). */
export function setHeldRowsForTesting(n: number): void {
  heldRows = n;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Origin is where a walk of a whole view starts: its first page's token, or its first page and the token after it. */
type Origin<T> = { token: string } | { rows: T[]; next: string | null };

interface Held<T> {
  of: unknown;
  head: Head;
  view: ListPage<T>["view"];
  total: number;
  lo: number;
  rows: T[];
  next: string | null;
  origin: Origin<T>;
  /** prev is the server's token for the page before an anchored window, while lo is still that window's start. */
  prev: { token: string; at: number } | null;
  /** spacer is the height that stands for the rows above (lo rows of the row height measured when the window was made). */
  spacer: number;
  /** perRow is the height a row not held is reckoned at (measured when the window was made). */
  perRow: number;
  /** windowed: a window read around the screen; the rows below it are reckoned by a spacer too, so the list's whole extent stays reachable. */
  windowed: boolean;
  /** below is the height that stands for the rows below a window (0 when not windowed, or at the end). */
  below: number;
}

/** ListWindow is what EpisodeList needs to show a windowed list: the rows above it, and holding it still. */
export interface ListWindow {
  /** offset is the index of the first row held. */
  offset: number;
  loadPrevious: () => void;
  /** ref is the list element, whose rows carry data-id. */
  ref: (el: HTMLElement | null) => void;
  /** spacer is the element that stands for the rows above. */
  spacer: (el: HTMLElement | null) => void;
  /** spacerHeight is its height in pixels; it changes only when the rows held do (the rows on screen are then kept in place). */
  spacerHeight: number;
  /** below is the height that stands for the rows below a window (0: none; Load more continues the list). */
  below: number;
  /** spacerBelow is the element that stands for the rows below. */
  spacerBelow: (el: HTMLElement | null) => void;
  /** loadBelow reads the rows the screen shows in the spacer below: the next page near the window, else the window at the screen's index. */
  loadBelow: () => void;
  /**
   * toEdge goes to the top or the end of a windowed list (Home, End) with one
   * read of the rows there, then scrolls to them; false when the rows there
   * are held already (the browser's own Home or End does it).
   */
  toEdge: (where: "top" | "end") => boolean;
  /** hold keeps the list still (a selection is being made); releasing it shows what arrived meanwhile, or reads once if due. */
  hold: (on: boolean) => void;
  /** lost counts the views that expired while shown: a selection made on one ends. */
  lost: number;
}

/** BulkExpired: a walk of the whole list met an expired view; nothing was done, and the list reloads. */
export class BulkExpired extends ApiError {}

/** rowsOf are the list element's rows. */
function rowsOf(el: HTMLElement | null): HTMLElement[] {
  if (!el) return [];
  return [...el.children].filter((c): c is HTMLElement => (c as HTMLElement).dataset?.id !== undefined);
}

/** firstVisible is the index (among the rows) of the first row whose bottom is below the top of the viewport. */
function firstVisible(rows: HTMLElement[]): number {
  let a = 0;
  let b = rows.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (rows[m]!.getBoundingClientRect().bottom > 0) b = m;
    else a = m + 1;
  }
  return a;
}

/** onScreen is the index of the first row on screen, or -1 when none is (the screen shows the spacer, or what is above the list). */
function onScreen(rows: HTMLElement[]): number {
  const k = firstVisible(rows);
  return k < rows.length && rows[k]!.getBoundingClientRect().top < window.innerHeight ? k : -1;
}

/** scrollSettled resolves once the page has not scrolled for `quiet` ms. */
function scrollSettled(signal: AbortSignal, quiet = 300): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(done, quiet);
    const moved = () => {
      clearTimeout(timer);
      timer = setTimeout(done, quiet);
    };
    const stop = () => {
      clearTimeout(timer);
      window.removeEventListener("scroll", moved);
      reject(new DOMException("The read was stopped.", "AbortError"));
    };
    function done() {
      window.removeEventListener("scroll", moved);
      signal.removeEventListener("abort", stop);
      resolve();
    }
    window.addEventListener("scroll", moved, { passive: true });
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** screenIds are the ids of the rows on screen now, top to bottom (measured, not remembered). */
function screenIds(el: HTMLElement | null): string[] {
  const rows = rowsOf(el);
  const out: string[] = [];
  for (let k = onScreen(rows); k >= 0 && k < rows.length && rows[k]!.getBoundingClientRect().top < window.innerHeight; k++) out.push(rows[k]!.dataset.id!);
  return out;
}

/**
 * usePaged loads a list view's pages at one head, re-reading its visible
 * window once per newer head. Pages belong to the view they continue: an
 * answer for a replaced view or query is dropped, and each token is asked once.
 */
export function usePaged<T>(
  load: (q: PageQuery, signal: AbortSignal) => Promise<ListPage<T>>,
  deps: unknown[],
  opts: { idOf?: (x: T) => string; anchored?: boolean } = {},
) {
  const sync = useSync();
  const idOf = opts.idOf ?? ((x: T) => (x as unknown as EpisodeRow).episode_id);
  const anchored = opts.anchored ?? true;
  // A new query starts over: nothing of the old one shows.
  const key = useRef<{ deps: unknown[] }>({ deps });
  if (deps.length !== key.current.deps.length || deps.some((d, i) => !Object.is(d, key.current.deps[i]))) key.current = { deps };
  const of = key.current;
  const [state, setState] = useState<{ held: Held<T> | undefined; error: string | undefined; refreshing: boolean; of: unknown }>({
    held: undefined,
    error: undefined,
    refreshing: false,
    of: undefined,
  });
  const [lost, setLost] = useState(0);
  const mine = state.of === of ? state : { held: undefined, error: undefined, refreshing: false, of };
  const current = mine.held;
  const live = useRef<Held<T> | undefined>(current);
  live.current = current;
  const list = useRef<HTMLElement | null>(null);
  const spacer = useRef<HTMLElement | null>(null);
  const spacerBelow = useRef<HTMLElement | null>(null);
  const rowHeight = useRef(72);
  const holding = useRef(false);
  /** pending is a newer window that arrived while the list was held: shown when the hold ends. */
  const pending = useRef<Held<T> | null>(null);
  /** selOrigin is the view a selection was made on: actions on it walk that view. */
  const selOrigin = useRef<Origin<T> | null>(null);
  /** keep: the rows to keep in place on screen after the next swap, with their viewport tops. */
  const keep = useRef<{ id: string; top: number }[] | null>(null);
  const asking = useRef(new Set<string>());
  const prevBusy = useRef(false);
  const prevAgain = useRef(false);

  /** extent: the list's height (spacers included) before a swap, kept after it by the spacer below. */
  const extent = useRef<number | null>(null);
  /** blockHeight is the list's height on the page, from the top of the spacer above to the bottom of the one below. */
  const blockHeight = () => {
    const top = (spacer.current?.isConnected ? spacer.current : list.current)?.getBoundingClientRect().top;
    const bottom = (spacerBelow.current?.isConnected ? spacerBelow.current : list.current)?.getBoundingClientRect().bottom;
    return top === undefined || bottom === undefined ? null : bottom - top;
  };
  const remember = () => {
    const rows = rowsOf(list.current);
    const k = onScreen(rows);
    keep.current = k < 0 ? null : rows.slice(k, k + 5).map((r) => ({ id: r.dataset.id!, top: r.getBoundingClientRect().top }));
  };
  /**
   * covers tells whether new rows hold a row on screen now, any of them (as
   * keeping them in place takes the first it finds): a row removed from the
   * list is not the screen moving. None on screen: nothing to keep.
   */
  const covers = (rows: T[]) => {
    const now = screenIds(list.current);
    if (!now.length) return true;
    const ids = new Set(rows.map(idOf));
    return now.some((id) => ids.has(id));
  };
  /** measure is the rows' height, measured on the rows shown. */
  const measure = () => {
    const rows = rowsOf(list.current);
    const height = rows.length && list.current ? list.current.getBoundingClientRect().height / rows.length : 0;
    if (height > 0) rowHeight.current = height;
    return rowHeight.current;
  };
  /**
   * swap shows other rows, keeping the rows on screen where they are
   * (`perRow`: the spacer's estimate of a row, else the rows measured;
   * `place`: the row to put where the screen is instead, or null for none).
   */
  const swap = (h: Omit<Held<T>, "spacer" | "perRow" | "below">, perRow?: number, place?: { id: string; top: number } | null) => {
    remember();
    if (place !== undefined) keep.current = place ? [place] : null;
    const row = perRow ?? measure();
    const old = live.current;
    // The list's whole height stays as it was when the rows change (same list, same length): a scroll under way is not cut short.
    extent.current = old && old.windowed && h.windowed && old.total === h.total ? blockHeight() : null;
    const n = { ...h, spacer: Math.round(h.lo * row), perRow: row, below: h.windowed && h.next ? Math.round(Math.max(0, h.total - h.lo - h.rows.length) * row) : 0 };
    live.current = n;
    setState({ held: n, error: undefined, refreshing: false, of: h.of });
  };
  /** show shows a window read anew (a view at its head): the tab learns the head and its counters. */
  const show = (n: Omit<Held<T>, "spacer" | "perRow" | "below">, perRow?: number, place?: { id: string; top: number } | null) => {
    swap(n, perRow, place);
    reader.current?.saw(n.head);
    sync.applied(n.head, countersOf({ view: n.view }));
  };
  /** later keeps a newer window for when the hold ends. */
  const later = (n: Omit<Held<T>, "spacer" | "perRow" | "below">) => {
    if (!pending.current || headAtLeast(n.head, pending.current.head)) pending.current = { ...n, spacer: 0, perRow: rowHeight.current, below: 0 };
  };
  const sameHead = (a: Head, b: Head) => sameLineage(a, b) && a.seq === b.seq;

  /** windowOf is a window from a first request's answer (and the pages that followed it). */
  const windowOf = (page: ListPage<T>, items: T[], next: string | null, limit: number, windowed = anchored): Omit<Held<T>, "spacer" | "perRow" | "below"> => {
    const lo = page.offset ?? 0;
    return {
      windowed,
      of,
      head: page.head,
      view: page.view,
      total: page.total,
      lo,
      rows: items,
      next,
      origin: page.start_page_token ? { token: page.start_page_token } : { rows: page.items, next: page.next_page_token },
      prev: page.prev_page_token ? { token: page.prev_page_token, at: Math.max(0, lo - limit) } : null,
    };
  };

  /** plan is a re-read's request: the first page near the top, else a window around the first visible row. */
  const plan = (h: Held<T> | undefined): PageQuery => {
    if (!h) return { limit: pageRows };
    const hi = h.lo + h.rows.length;
    if (!anchored) return { limit: clamp(hi, pageRows, 500) };
    const rows = rowsOf(list.current);
    const k = rows.length ? Math.min(firstVisible(rows), rows.length - 1) : 0;
    const i = h.lo + k;
    const row = h.rows[k];
    if (i > pageRows && row) return { anchor: idOf(row), anchor_index: i, before: beforeRows, limit: windowRows };
    // Near the top: the first rows, with rows enough below the screen that nothing pages by itself.
    return { limit: clamp(Math.max(hi, i + 60), pageRows, windowRows) };
  };

  const reader = useReader(
    async (signal) => {
      const first = live.current?.of === of ? live.current : undefined;
      if (first) setState((s) => (s.of === of ? { ...s, refreshing: true } : s));
      try {
        // The screen may move while a window is read: a window that no longer
        // holds a row on screen is never shown, and is read again where the
        // screen now is; after two such reads, once scrolling has settled. A
        // screen that did not move whose rows are all gone from the list has
        // nothing to keep: the window there is shown.
        for (let attempt = 0; ; attempt++) {
          if (attempt >= 2) await scrollSettled(signal);
          const h = live.current?.of === of ? live.current : undefined;
          const q = plan(h);
          const before = screenIds(list.current);
          const page = await load(q, signal);
          const items = [...page.items];
          let next = page.next_page_token;
          // A list without anchors keeps the rows it holds: their pages follow, at the same head.
          const want = h && !anchored ? h.lo + h.rows.length : 0;
          while (next && items.length < want) {
            const more = await load({ page_token: next, limit: clamp(want - items.length, 1, 500) }, signal);
            items.push(...more.items);
            next = more.next_page_token;
          }
          if (!(await acceptable(sync, page.head, h?.head, signal))) return null;
          const n = windowOf(page, items, next, q.limit ?? pageRows, anchored && !!h);
          if (holding.current) {
            later(n);
            return page.head;
          }
          // What is on screen now, measured at the swap: an answer without any
          // of it is shown only if the screen did not move (its rows are gone).
          if (h && !covers(items)) {
            const now = screenIds(list.current);
            if (now.length !== before.length || now.some((id, i) => id !== before[i])) continue;
          }
          show(n);
          return page.head;
        }
      } catch (e) {
        if (!signal.aborted) setState((s) => (s.of === of ? { ...s, refreshing: false } : s));
        throw e;
      }
    },
    (e) => {
      if (e instanceof Unreachable) sync.connection.set("unreachable");
      else if (!(e instanceof DOMException && e.name === "AbortError")) {
        const message = e instanceof ApiError ? e.message : String(e);
        setState((s) => (s.of === of ? { ...s, error: message, refreshing: false } : { held: undefined, error: message, refreshing: false, of }));
      }
      return retryable(e);
    },
    [of],
    { held: () => holding.current },
  );

  // After a swap: the rows kept stay where they were on screen. The spacer is
  // an estimate: what the rows above measured corrects it, rather than the
  // page's scroll position (which would stop a scroll under way, as Home's in
  // Safari); only what the spacer cannot take scrolls.
  useLayoutEffect(() => {
    const rows = rowsOf(list.current);
    const k = keep.current;
    keep.current = null;
    for (const { id, top } of k ?? []) {
      const el = rows.find((r) => r.dataset.id === id);
      if (!el) continue;
      let delta = el.getBoundingClientRect().top - top;
      const h = live.current;
      if (delta && h && h.spacer > 0 && spacer.current?.isConnected) {
        const height = Math.max(0, Math.round(h.spacer - delta));
        delta -= h.spacer - height;
        h.spacer = height; // the window's estimate, corrected (the next render shows the same)
        spacer.current.style.height = `${height}px`;
      }
      if (Math.abs(delta) >= 1) window.scrollBy(0, delta);
      break;
    }
    const to = edge.current;
    edge.current = null;
    if (to) {
      // Home or End: the rows there are shown; the screen goes to them at once.
      extent.current = null;
      window.scrollTo(0, to === "top" ? 0 : document.documentElement.scrollHeight);
    }
    // The spacer below takes up what the new rows changed in the list's height.
    const was = extent.current;
    extent.current = null;
    const h = live.current;
    if (was !== null && h && h.below > 0 && spacerBelow.current?.isConnected && list.current) {
      const top = (h.spacer > 0 && spacer.current?.isConnected ? spacer.current : list.current).getBoundingClientRect().top;
      const height = Math.round(was - (list.current.getBoundingClientRect().bottom - top));
      if (height > 0) {
        h.below = height;
        spacerBelow.current.style.height = `${height}px`;
      }
    }
    fill();
  }, [current]);

  /** expired: the view shown expired; a selection made on it ends, and it is read again around what is on screen. */
  const expired = (h: Held<T>) => {
    if (live.current !== h) return;
    holding.current = false;
    stopRenewal();
    pending.current = null;
    selOrigin.current = null;
    setLost((n) => n + 1);
    reader.current?.revalidate();
  };

  const loadMore = async () => {
    const h = live.current;
    const token = h?.next;
    if (!h || !token || asking.current.has(token)) return;
    asking.current.add(token);
    try {
      const page = await load({ page_token: token, limit: pageRows }, new AbortController().signal);
      if (live.current !== h) return; // the view was replaced meanwhile: its pages are obsolete
      let n = { ...h, rows: [...h.rows, ...page.items], next: page.next_page_token, below: page.next_page_token ? Math.max(0, Math.round(h.below - page.items.length * h.perRow)) : 0 };
      const drop = n.rows.length - heldRows;
      if (drop > 0) {
        // The rows furthest above go; the spacer takes their height (as drawn), and the rows on screen stay in place.
        const shown = rowsOf(list.current);
        const height = shown.length > drop ? shown[drop]!.getBoundingClientRect().top - shown[0]!.getBoundingClientRect().top : drop * h.perRow;
        remember();
        n = { ...n, lo: h.lo + drop, rows: n.rows.slice(drop), spacer: Math.round(h.spacer + height), prev: null };
      }
      live.current = n;
      setState((s) => (s.held === h ? { ...s, held: n } : s));
    } catch (e) {
      // Only the view shown is read again; an obsolete page's expiry changes nothing.
      if (e instanceof ApiError && e.code === "view_expired") expired(h);
    } finally {
      asking.current.delete(token);
    }
  };

  /**
   * ofSelection reads rows [from, from + limit) of the view a selection holds, as
   * Select all reads it: walking it from its start by the tokens it gave, so
   * rows let go of above (Load more) come back at the selection's head. The
   * window it makes continues by the token after its last row.
   */
  const ofSelection = async (h: Held<T>, from: number, limit: number): Promise<Omit<Held<T>, "spacer" | "perRow" | "below">> => {
    const origin = selOrigin.current ?? h.origin;
    const rows: T[] = [];
    let at = 0; // the index the token reads from
    let token: string | null;
    if ("rows" in origin) {
      rows.push(...origin.rows.slice(from));
      at = origin.rows.length;
      token = origin.next;
    } else token = origin.token;
    const end = Math.max(from + limit, at);
    while (token && at < end) {
      // Pages end where the rows wanted start, and where they end: the token after them is the window's.
      const page = await load({ page_token: token, limit: Math.min(500, (at < from ? from : end) - at) }, new AbortController().signal);
      if (at >= from) rows.push(...page.items);
      at += page.items.length;
      token = page.next_page_token;
      if (!page.items.length) break;
    }
    return { ...h, lo: from, rows, next: token, prev: null };
  };

  /**
   * previousOnce reads rows above the window. Near it: the server's page
   * before the window (same view), else a window anchored on the first row
   * held with rows before it. Far above it (a jump): one window where the
   * screen is, the first page near the top, else the window at the screen's
   * index (`anchor_index` without an anchor, PROTOCOL §12), shown at the
   * place the spacer gave it. While a selection holds the list, those rows
   * are read from the selection's view.
   */
  const previousOnce = async (): Promise<void> => {
    const h = live.current;
    if (!h || h.lo === 0 || !h.rows.length) return;
    const sp = spacer.current?.getBoundingClientRect();
    // The index the top of the screen is at, by the spacer's rows.
    const at = sp && h.spacer > 0 ? clamp(Math.floor((-sp.top / h.spacer) * h.lo), 0, h.lo) : h.lo;
    const far = h.lo - at > windowRows;
    try {
      const top = far && at <= windowRows; // the screen is at the top: the first page
      if (!far && h.prev && h.prev.at < h.lo && h.lo - h.prev.at + h.rows.length <= heldRows) {
        // The same view, by the token the server gave: the rows on screen stay.
        const limit = h.lo - h.prev.at;
        const page = await load({ page_token: h.prev.token, limit }, new AbortController().signal);
        if (live.current !== h) return;
        swap({ ...h, lo: h.prev.at, rows: [...page.items.slice(0, limit), ...h.rows], prev: null });
        return;
      }
      let q: PageQuery;
      if (top) q = { limit: windowRows };
      else if (far) q = { anchor_index: at, before: beforeRows, limit: windowRows };
      else {
        const before = Math.min(h.lo, pageRows);
        q = { anchor: idOf(h.rows[0]!), anchor_index: h.lo, before, limit: before + Math.min(h.rows.length, pageRows) };
      }
      let n: Omit<Held<T>, "spacer" | "perRow" | "below">;
      if (holding.current) {
        // The anchored window's rows, of the selection's view: a newer head's would wait until it ends.
        n = await ofSelection(h, top ? 0 : Math.max(0, (q.anchor_index ?? 0) - (q.before ?? 0)), q.limit ?? windowRows);
        if (live.current !== h) return;
      } else {
        const page = await load(q, new AbortController().signal);
        if (live.current !== h) return;
        if (!(await acceptable(sync, page.head, h.head, new AbortController().signal))) return;
        if (live.current !== h) return;
        n = windowOf(page, page.items, page.next_page_token, q.limit ?? pageRows);
      }
      // A window read away from what is on screen now is not shown (the screen moved on).
      if (!covers(n.rows)) return;
      // While held, only the same head joins (the selection's view stays); a newer one waits.
      if (holding.current && !sameHead(n.head, h.head)) {
        later(n);
        return;
      }
      if (top) {
        // Heading for the top (Home): the first rows, with no correction that would stop a scroll under way.
        show(n, undefined, screenIds(list.current).length ? undefined : null);
      } else if (far && sp && !screenIds(list.current).length) {
        // A jump lands where the screen is: the row at the screen's index takes the place the spacer gave it.
        const perRow = h.spacer / h.lo;
        const row = n.rows[at - n.lo];
        const now = spacer.current?.getBoundingClientRect() ?? sp;
        show(n, perRow, row ? { id: idOf(row), top: now.top + at * perRow } : undefined);
      } else show(n); // rows on screen again (the person came back): they stay where they are
    } catch (e) {
      if (e instanceof ApiError && e.code === "view_expired") expired(h);
    }
  };

  /**
   * belowOnce reads the rows the screen shows in the spacer below a window:
   * near the window, the next page of its view; far below it (a jump, End),
   * the window at the screen's index in one read, put where the spacer had it.
   */
  const belowOnce = async (): Promise<void> => {
    const h = live.current;
    if (!h || !h.windowed || !h.next) return;
    const hi = h.lo + h.rows.length;
    const sp = spacerBelow.current?.getBoundingClientRect();
    if (!sp || sp.height <= 0 || sp.bottom <= 0 || sp.top >= window.innerHeight) return;
    // The index the top of the screen is at, by the spacer's rows.
    const at = clamp(hi + Math.floor(Math.max(0, -sp.top) / h.perRow), hi, h.total - 1);
    if (at - hi <= windowRows) {
      await loadMore();
      return;
    }
    try {
      // Near the end (End), the window reaches it: nothing is left to page in.
      const q: PageQuery = { anchor_index: at, before: clamp(at - (h.total - windowRows), beforeRows, windowRows), limit: windowRows };
      const page = await load(q, new AbortController().signal);
      if (live.current !== h) return;
      if (!(await acceptable(sync, page.head, h.head, new AbortController().signal))) return;
      if (live.current !== h) return;
      const n = windowOf(page, page.items, page.next_page_token, windowRows, true);
      if (!covers(n.rows)) return;
      if (holding.current && !sameHead(n.head, h.head)) {
        later(n);
        return;
      }
      if (screenIds(list.current).length) {
        show(n); // rows on screen again (the person came back): they stay where they are
        return;
      }
      const row = n.rows[at - n.lo];
      const now = spacerBelow.current?.getBoundingClientRect() ?? sp;
      show(n, h.perRow, row ? { id: idOf(row), top: now.top + (at - hi) * h.perRow } : null);
    } catch (e) {
      if (e instanceof ApiError && e.code === "view_expired") expired(h);
    }
  };

  const belowBusy = useRef(false);
  const belowAgain = useRef(false);
  /** loadBelow reads rows below, one read at a time; a call meanwhile looks at the screen again once it is done. */
  const loadBelow = async () => {
    if (belowBusy.current) {
      belowAgain.current = true;
      return;
    }
    belowBusy.current = true;
    try {
      await belowOnce();
    } finally {
      belowBusy.current = false;
      if (belowAgain.current) {
        belowAgain.current = false;
        if (typeof requestAnimationFrame === "undefined") void loadBelow();
        else requestAnimationFrame(() => void loadBelow());
      }
    }
  };

  /** edge: after the next swap, scroll to the top or the end (Home, End). */
  const edge = useRef<"top" | "end" | null>(null);
  const toEdge = (where: "top" | "end"): boolean => {
    const h = live.current;
    if (!h || !h.windowed || (where === "top" ? h.lo === 0 : !h.next)) return false;
    void (async () => {
      const q: PageQuery = where === "top" ? { limit: windowRows } : { anchor_index: h.total - 1, before: windowRows - 1, limit: windowRows };
      try {
        const page = await load(q, new AbortController().signal);
        if (live.current !== h || !(await acceptable(sync, page.head, h.head, new AbortController().signal)) || live.current !== h) return;
        const n = windowOf(page, page.items, page.next_page_token, windowRows, true);
        if (holding.current && !sameHead(n.head, h.head)) {
          later(n);
          return;
        }
        edge.current = where;
        show(n, undefined, null);
      } catch (e) {
        if (e instanceof ApiError && e.code === "view_expired") expired(h);
      }
    })();
    return true;
  };

  /**
   * loadPrevious reads rows above, one read at a time: a call while one is
   * under way (scrolling on) looks at the screen again once it is done.
   */
  const loadPrevious = async () => {
    if (prevBusy.current) {
      prevAgain.current = true;
      return;
    }
    prevBusy.current = true;
    try {
      await previousOnce();
    } finally {
      prevBusy.current = false;
      // Rows read are looked at again once shown (after the swap); a call
      // that came meanwhile, once the screen has settled.
      if (prevAgain.current) {
        prevAgain.current = false;
        if (typeof requestAnimationFrame === "undefined") fill();
        else requestAnimationFrame(fill);
      }
    }
  };

  /** fill loads rows above while the spacer is on screen. */
  const fill = () => {
    const sp = spacer.current?.getBoundingClientRect();
    if (sp && sp.bottom > 0 && sp.top < window.innerHeight && sp.height > 0) void loadPrevious();
  };

  /**
   * all reads every row of the view shown (while a selection is made, of the
   * view it was made on), in list order, for actions on the whole list; an
   * expired view aborts it (nothing is done).
   */
  const all = async (): Promise<T[]> => {
    const h = live.current;
    if (!h) return [];
    const origin = (holding.current && selOrigin.current) || h.origin;
    const out = "rows" in origin ? [...origin.rows] : [];
    let token: string | null = "rows" in origin ? origin.next : origin.token;
    try {
      while (token) {
        const page = await load({ page_token: token, limit: 500 }, new AbortController().signal);
        out.push(...page.items);
        token = page.next_page_token;
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "view_expired") {
        expired(h);
        throw new BulkExpired(e.status, e.code, e.message);
      }
      throw e;
    }
    return out;
  };

  /**
   * renew keeps the view a selection is made on readable while the selection
   * lasts: the server leases a view from its last read (PROTOCOL §12), so it
   * is read (one row, the answer unused) about once a minute.
   */
  const renewal = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopRenewal = () => {
    if (renewal.current !== null) clearInterval(renewal.current);
    renewal.current = null;
  };
  const renew = () => {
    const origin = selOrigin.current;
    const token = origin ? ("token" in origin ? origin.token : origin.next) : null;
    if (token) void load({ page_token: token, limit: 1 }, new AbortController().signal).catch(() => {});
  };
  useLayoutEffect(() => stopRenewal, []);

  const hold = (on: boolean) => {
    if (holding.current === on) return;
    holding.current = on;
    stopRenewal();
    if (on) {
      selOrigin.current = live.current?.origin ?? null;
      renewal.current = setInterval(renew, 60_000);
      return;
    }
    selOrigin.current = null;
    const p = pending.current;
    pending.current = null;
    const h = live.current;
    if (p && h && p.of === h.of && headAtLeast(p.head, h.head)) {
      // What arrived meanwhile, if it still holds the row on screen; else the window where the screen is.
      if (covers(p.rows)) show(p);
      else reader.current?.revalidate();
    }
    reader.current?.visible();
  };

  const win: ListWindow = {
    offset: current?.lo ?? 0,
    loadPrevious: () => void loadPrevious(),
    ref: (el) => (list.current = el),
    spacer: (el) => {
      spacer.current = el;
    },
    spacerHeight: current?.spacer ?? 0,
    below: current?.below ?? 0,
    spacerBelow: (el) => {
      spacerBelow.current = el;
    },
    loadBelow: () => void loadBelow(),
    toEdge,
    hold,
    lost,
  };
  return {
    data: current ? { head: current.head, view: current.view, total: current.total, items: current.rows, next_page_token: current.next } : undefined,
    error: mine.error,
    loading: !current && !mine.error,
    refreshing: mine.refreshing,
    reload: () => reader.current?.revalidate(),
    items: current?.rows,
    total: current?.total ?? 0,
    hasMore: !!current?.next,
    hasBefore: (current?.lo ?? 0) > 0,
    loadMore,
    all,
    window: win,
  };
}
