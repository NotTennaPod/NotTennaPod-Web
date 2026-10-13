// Paging a list view (PROTOCOL §12): the first page is a view
// at one head; later pages continue it by token.
import { useRef, useState } from "preact/hooks";
import type { ListPage } from "../api/views.ts";
import { ApiError } from "../api/http.ts";
import { useView } from "../app/useView.ts";

/**
 * usePaged loads a list view's pages at the first page's head; reloading
 * starts again. Pages belong to the first page they continue: an answer for
 * an older first page or query is dropped, and each token is asked once.
 */
export function usePaged<T>(load: (q: { page_token?: string; limit?: number }, signal: AbortSignal) => Promise<ListPage<T>>, deps: unknown[]) {
  const first = useView((signal) => load({ limit: 100 }, signal), deps);
  const [more, setMore] = useState<{ of: unknown; items: T[]; next: string | null }>({ of: undefined, items: [], next: null });
  const asking = useRef<unknown>(undefined);
  const current = first.data;
  const shown = useRef(current);
  shown.current = current;
  const mine = more.of === current ? more : { of: current, items: [], next: current?.next_page_token ?? null };
  const loadMore = async () => {
    const of = current;
    const token = mine.next;
    if (!of || !token || asking.current === token) return;
    asking.current = token;
    try {
      const page = await load({ page_token: token, limit: 100 }, new AbortController().signal);
      if (shown.current !== of) return; // the view was replaced meanwhile: its pages are obsolete
      setMore((m) => {
        if (m.of !== undefined && m.of !== of && m.of === shown.current) return m;
        const base = m.of === of ? m : { of, items: [], next: of.next_page_token };
        if (base.next !== token) return m; // already added
        return { of, items: [...base.items, ...page.items], next: page.next_page_token };
      });
    } catch (e) {
      // Only the view shown is reloaded; an obsolete page's expiry changes nothing.
      if (e instanceof ApiError && e.code === "view_expired" && shown.current === of) first.reload();
    } finally {
      if (asking.current === token) asking.current = undefined;
    }
  };
  /** all reads every page of the view shown, for actions on the whole list. */
  const all = async (): Promise<T[]> => {
    if (!current) return [];
    const out = [...current.items];
    for (let token = current.next_page_token; token; ) {
      const page = await load({ page_token: token, limit: 500 }, new AbortController().signal);
      out.push(...page.items);
      token = page.next_page_token;
    }
    return out;
  };
  const items = current ? [...current.items, ...mine.items] : undefined;
  return { ...first, items, total: current?.total ?? 0, hasMore: !!mine.next, loadMore, all };
}
