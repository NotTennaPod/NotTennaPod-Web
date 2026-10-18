// Loading a screen's view (PROTOCOL §12): one request is one head; a
// response is applied only if its head is at or after the one shown, and of
// the profile's lineage, so a delayed older response never takes a screen
// back. A displayed view re-reads once per newer head the server announces,
// and after a revalidation (heads.ts); the shown head advances the push
// cursor (PROTOCOL §12) and the drawer's counters.
import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, Unreachable } from "../api/http.ts";
import { headAtLeast, type Counters, type Head } from "../api/views.ts";
import { useSync } from "./context.ts";
import { Rereader, type HeadLike } from "./heads.ts";
import type { Sync } from "./sync.ts";

export interface ViewState<T> {
  data: T | undefined;
  error: string | undefined;
  /** loading is true only before the screen's first data. */
  loading: boolean;
  /** refreshing is true while a re-read of data already shown is under way. */
  refreshing: boolean;
  /** reload reads the view again now. */
  reload: () => void;
}

/** countersOf are the counters a view carries (a list's in its `view`). */
export function countersOf(v: unknown): Counters | undefined {
  const o = v as { counters?: Counters; view?: { counters?: Counters } };
  return o.counters ?? o.view?.counters;
}

/** retryable tells whether a failed read may pass by itself (unreachable, busy, a server error), so it is tried again later. */
export function retryable(e: unknown): boolean {
  if (e instanceof ApiError) return e.status >= 500 || e.status === 408 || e.status === 429 || e.code === "view_expired";
  return !(e instanceof DOMException && e.name === "AbortError");
}

export interface ReaderHooks {
  /** hold: while it answers true, the view does not re-read (it waits, then reads once). */
  held?: () => boolean;
}

/**
 * useReader runs a Rereader for a view while its deps stay the same: `read`
 * loads and applies (the head shown, or null for an answer not used). New
 * deps stop the old reader, whose answers are then never applied.
 */
export function useReader(read: (signal: AbortSignal) => Promise<HeadLike | null>, failed: (e: unknown) => boolean, deps: unknown[], hooks: ReaderHooks = {}): { current: Rereader | undefined } {
  const sync = useSync();
  const reader = useRef<Rereader | undefined>(undefined);
  const latest = useRef({ read, failed, hooks });
  latest.current = { read, failed, hooks };
  useEffect(() => {
    const r = new Rereader({
      known: () => sync.known.get(),
      visible: () => sync.visible.get() && !latest.current.hooks.held?.(),
      read: (signal) => latest.current.read(signal),
      failed: (e) => latest.current.failed(e),
    });
    reader.current = r;
    const offs = [sync.known.subscribe(() => r.known()), sync.revalidate.subscribe(() => r.revalidate()), sync.visible.subscribe(() => r.visible())];
    r.start();
    return () => {
      r.stop();
      for (const off of offs) off();
    };
  }, [sync, ...deps]);
  return reader;
}

/** apply shows a view's answer if it may be shown: its lineage accepted, at or after the head shown. */
export async function acceptable(sync: Sync, head: Head, shown: Head | undefined, signal: AbortSignal): Promise<boolean> {
  if (!(await sync.accepts(head))) return false;
  return !signal.aborted && headAtLeast(head, shown);
}

export function useView<T extends { head: Head }>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]): ViewState<T> {
  const sync = useSync();
  const [state, setState] = useState<{ data: T | undefined; error: string | undefined; loading: boolean; refreshing: boolean; of: unknown }>({
    data: undefined,
    error: undefined,
    loading: true,
    refreshing: false,
    of: undefined,
  });
  // A new screen (other deps) starts over: nothing of the old one shows.
  const key = useRef<{ deps: unknown[] }>({ deps });
  if (deps.length !== key.current.deps.length || deps.some((d, i) => !Object.is(d, key.current.deps[i]))) key.current = { deps };
  const of = key.current;
  // The head shown, for the screen it was shown on.
  const shown = useRef<{ of: unknown; head: Head } | undefined>(undefined);
  const reader = useReader(
    async (signal) => {
      const before = shown.current?.of === of ? shown.current.head : undefined;
      if (before) setState((s) => (s.of === of ? { ...s, refreshing: true } : s));
      try {
        const v = await load(signal);
        if (!(await acceptable(sync, v.head, before, signal))) return null;
        shown.current = { of, head: v.head };
        setState({ data: v, error: undefined, loading: false, refreshing: false, of });
        sync.applied(v.head, countersOf(v));
        return v.head;
      } catch (e) {
        if (!signal.aborted) setState((s) => (s.of === of ? { ...s, refreshing: false } : s));
        throw e;
      }
    },
    (e) => {
      if (e instanceof Unreachable) sync.connection.set("unreachable");
      else if (!(e instanceof DOMException && e.name === "AbortError")) {
        const message = e instanceof ApiError ? e.message : String(e);
        setState((s) => (s.of === of ? { ...s, error: message, loading: false, refreshing: false } : { data: undefined, error: message, loading: false, refreshing: false, of }));
      }
      return retryable(e);
    },
    [of],
  );
  const mine = state.of === of ? state : { data: undefined, error: undefined, loading: true, refreshing: false };
  return { data: mine.data, error: mine.error, loading: mine.loading, refreshing: mine.refreshing, reload: () => reader.current?.revalidate() };
}

/** useValue follows an observable value. */
export function useValue<T>(value: { get(): T; subscribe(l: () => void): () => void }): T {
  const [v, setV] = useState(value.get());
  useEffect(() => {
    const off = value.subscribe(() => setV(value.get()));
    // A change between rendering and subscribing is not missed.
    setV(value.get());
    return off;
  }, [value]);
  return v;
}
