// The navigation drawer's data: its counters and its podcast list.
import { useEffect, useRef, useState } from "preact/hooks";
import { reads, type Counters, type Head, type PodcastRow } from "../api/views.ts";
import { useSync } from "../app/context.ts";
import { acceptable, retryable, useReader, useValue } from "../app/useView.ts";

/** The width below which the drawer is behind the menu button (styles.css). */
const narrow = "(max-width: 840px)";

/**
 * useDrawer keeps the drawer current: its counters come from the newest view
 * any screen applied (no request of their own); its podcast list re-reads once
 * per newer head while the drawer is displayed (always in wide windows, when
 * open in narrow ones) and the tab is shown, and once when it shows again.
 */
export function useDrawer(open: boolean): { counters: Counters | undefined; podcasts: PodcastRow[] } {
  const sync = useSync();
  const counters = useValue(sync.counters)?.counters;
  const [podcasts, setPodcasts] = useState<PodcastRow[]>([]);
  const shown = useRef<Head | undefined>(undefined);
  const displayed = useRef(open);
  const media = useRef(typeof matchMedia === "undefined" ? null : matchMedia(narrow));
  const reader = useReader(
    async (signal) => {
      const p = await reads.subscriptions({ limit: 500 }, signal);
      if (!(await acceptable(sync, p.head, shown.current, signal))) return null;
      shown.current = p.head;
      setPodcasts(p.items);
      sync.applied(p.head, p.view.counters, false);
      return p.head;
    },
    retryable,
    [],
    { held: () => !displayed.current && !!media.current?.matches },
  );
  useEffect(() => {
    displayed.current = open;
    reader.current?.visible();
  }, [open]);
  useEffect(() => {
    const m = media.current;
    if (!m) return;
    const change = () => reader.current?.visible();
    m.addEventListener("change", change);
    return () => m.removeEventListener("change", change);
  }, []);
  return { counters, podcasts };
}

