// Loading a screen's view (PROTOCOL §12): one request is one head; a
// response is applied only if its head is at or after the one shown, so a
// delayed older response never takes a screen back; hints, reconnects and
// focus re-read; the shown head advances the push cursor (PROTOCOL §12).
import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, Unreachable } from "../api/http.ts";
import { headAtLeast, type Head } from "../api/views.ts";
import { useSync } from "./context.ts";

export interface ViewState<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
}

export function useView<T extends { head: Head }>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]): ViewState<T> {
  const sync = useSync();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const shown = useRef<Head | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const changed = useChanged();
  // A new screen (other deps) starts over.
  useEffect(() => {
    shown.current = undefined;
    setData(undefined);
  }, deps);
  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    load(ac.signal).then(
      (v) => {
        if (ac.signal.aborted || !headAtLeast(v.head, shown.current)) return;
        shown.current = v.head;
        setData(v);
        setError(undefined);
        setLoading(false);
        void sync.shown(v.head);
      },
      (e: unknown) => {
        if (ac.signal.aborted) return;
        setLoading(false);
        if (e instanceof Unreachable) sync.connection.set("unreachable");
        else setError(e instanceof ApiError ? e.message : String(e));
      },
    );
    return () => ac.abort();
  }, [...deps, tick, changed]);
  return { data, error, loading, reload: () => setTick((n) => n + 1) };
}

/** useChanged is a number that changes whenever views should re-read. */
export function useChanged(): number {
  const sync = useSync();
  const [v, setV] = useState(sync.changed.get());
  useEffect(() => sync.changed.subscribe(() => setV(sync.changed.get())), [sync]);
  return v;
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
