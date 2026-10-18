// Episode lists as Android shows them (EpisodeItemViewHolder): cover, title,
// status icons, date and duration, progress when started, and the episode's
// actions; paged from a materialized view (PROTOCOL §12).
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { t, w } from "../i18n.ts";
import type { EpisodeRow, ListPage } from "../api/views.ts";
import { ApiError } from "../api/http.ts";
import { useSync } from "../app/context.ts";
import { linkProps, pathOf } from "../app/router.ts";
import { Cover } from "./Cover.tsx";
import { Icon } from "./Icon.tsx";
import { contextPoint, Loading, Menu, type MenuItem, type MenuPoint } from "./components.tsx";
import { bulkActions, SelectActions, useListSelection, type QueueContext, type Selection } from "./selection.tsx";
import { actionsFor } from "./episodeActions.ts";
export { usePaged } from "./paged.ts";
import type { ListWindow } from "./paged.ts";
import { ItemButton } from "./ItemButton.tsx";
import { durationLong, formatAbbrev } from "./format.ts";

/** EpisodeItem is a list row; with `selection`, its list can select (Android's multi select). */
export function EpisodeItem({ e, where, leading, selection }: {
  e: EpisodeRow;
  where?: "history" | "queue" | "inbox";
  leading?: ComponentChildren;
  selection?: Selection;
}) {
  const sync = useSync();
  const progress = e.has_media && e.position > 0 && e.duration_ms ? Math.min(100, (e.position / e.duration_ms) * 100) : 0;
  const [menuAt, setMenuAt] = useState<MenuPoint | null>(null);
  const selecting = !!selection?.active;
  const selected = !!selection?.isSelected(e.episode_id);
  const body = (
    <>
      <Cover url={e.image_url || e.podcast.image_url} title={e.podcast.display_title} />
      <div class="episode-text">
        <span class="episode-title">{e.title}</span>
        <span class="episode-status">
          {e.play_state === "new" && <Icon name="inbox" size={16} label={t("inbox_label")} />}
          {e.in_queue && <Icon name="playlist_play" size={16} label={t("in_queue_label")} />}
          {e.favorite && <Icon name="star" size={16} label={t("favorite_episodes_label")} />}
          <span>{formatAbbrev(e.pub_date)}</span>
          {e.has_media && !progress && (e.duration_ms ?? 0) > 0 && <span>{durationLong(e.duration_ms)}</span>}
        </span>
        {progress > 0 && (
          <span class="episode-progress">
            <span>{durationLong(e.position)}</span>
            <progress max={100} value={progress} />
            <span>{durationLong(e.duration_ms)}</span>
          </span>
        )}
      </div>
    </>
  );
  const items = actionsFor(sync, e, where).map((a): MenuItem => ({ label: t(a.label), run: a.run }));
  if (selection) items.push({ label: t("multi_select"), run: () => selection.start(e.episode_id) });
  return (
    <li
      data-id={e.episode_id}
      class={`episode${e.play_state === "played" ? " played" : ""}${selected ? " selected" : ""}`}
      onContextMenu={(ev) => {
        if (selecting) return; // Android shows no row menu while selecting
        ev.preventDefault();
        setMenuAt(contextPoint(ev));
      }}
    >
      {leading}
      {selecting ? (
        // While selecting, a row's click selects it; Shift-click selects up to it.
        <button
          type="button"
          class="episode-main"
          role="checkbox"
          aria-checked={selected}
          aria-label={e.title ?? ""}
          onClick={(ev) => selection!.click(e.episode_id, ev.shiftKey)}
        >
          {body}
        </button>
      ) : (
        <a
          class="episode-main"
          aria-label={e.play_state === "played" ? `${e.title ?? ""}. ${t("is_played")}` : undefined}
          {...linkProps(pathOf({ name: "episode", id: e.episode_id }))}
        >
          {body}
        </a>
      )}
      {selecting ? (
        // Android's row button selects too while selecting.
        <div
          class="item-button-select"
          onClickCapture={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            selection!.click(e.episode_id, ev.shiftKey);
          }}
        >
          <ItemButton e={e} />
        </div>
      ) : (
        <ItemButton e={e} />
      )}
      {!selecting && <Menu label={t("overflow_more")} items={items} at={menuAt} onDismiss={() => setMenuAt(null)} />}
    </li>
  );
}

/**
 * EpisodeList is a paged episode list. Given `select`, it can select, and
 * shows the floating actions for the selection (Android's multi select).
 * Given `window`, the rows are a window of the list: a spacer stands for the
 * rows above it, which load as they come into sight (or by Load previous
 * page), and the list holds still while a selection is made.
 */
export function EpisodeList({ items, where, hasMore, loadMore, loading, empty, select, window: win }: {
  items: EpisodeRow[] | undefined;
  where?: "history" | "queue" | "inbox";
  hasMore: boolean;
  loadMore: () => void;
  loading: boolean;
  empty: ComponentChildren;
  select?: { total: number; all: () => Promise<EpisodeRow[]>; queue?: QueueContext };
  window?: ListWindow;
}) {
  const sync = useSync();
  const selection = useListSelection(items, select?.total ?? 0, win);
  // With nothing selected, the actions stay as they were (onPrepareMenu leaves them), and say so when used.
  const shownActions = useRef<ReturnType<typeof bulkActions>>([]);
  if (select && selection.active && selection.count > 0) shownActions.current = bulkActions(sync, selection.selected, select.queue);
  // Home and End on a windowed list: one read of the rows there, not a walk through the rows between.
  const edges = useRef(win);
  edges.current = win;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== "Home" && e.key !== "End")) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector("dialog[open], [role=menu]")) return;
      if (edges.current?.toEdge(e.key === "Home" ? "top" : "end")) e.preventDefault();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  if (!items) return loading ? <Loading /> : null;
  if (items.length === 0 && !win?.offset) return <>{empty}</>;
  return (
    <>
      {win && win.offset > 0 && (
        <>
          <Spacer win={win} />
          <LoadMore onLoad={win.loadPrevious} label={w("load_previous_page_label")} observe={false} />
        </>
      )}
      <ul class="episode-list" ref={win?.ref}>
        {items.map((e) => (
          <EpisodeItem key={e.episode_id} e={e} where={where} selection={select ? selection : undefined} />
        ))}
      </ul>
      {hasMore && <LoadMore onLoad={loadMore} />}
      {win && win.below > 0 && <Spacer win={win} below />}
      {select && selection.active && (
        <SelectActions sync={sync} selection={selection} all={select.all} actions={shownActions.current} />
      )}
    </>
  );
}

/**
 * Spacer stands for the rows above a window, or (`below`) the rows below it,
 * by the row height measured: whenever scrolling brings it into sight, the
 * rows there load.
 */
function Spacer({ win, below = false }: { win: ListWindow; below?: boolean }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const latest = useRef(win);
  latest.current = win;
  // The list knows its spacer as soon as it is in the page (before its layout effects run).
  const ref = useRef((e: HTMLDivElement | null) => {
    if (below) latest.current.spacerBelow(e);
    else latest.current.spacer(e);
    setEl(e);
  }).current;
  useEffect(() => {
    if (!el) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      const r = el.getBoundingClientRect();
      if (r.bottom > 0 && r.top < window.innerHeight) (below ? latest.current.loadBelow : latest.current.loadPrevious)();
    };
    const scrolled = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    window.addEventListener("scroll", scrolled, { passive: true });
    return () => {
      window.removeEventListener("scroll", scrolled);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [el]);
  return <div ref={ref} class={below ? "list-spacer-below" : "list-spacer"} aria-hidden="true" style={{ height: `${below ? win.below : win.spacerHeight}px` }} />;
}

/** LoadMore loads the next page when it scrolls into view (unless `observe` is false), or when pressed. */
export function LoadMore({ onLoad, label, observe = true }: { onLoad: () => void; label?: string; observe?: boolean }) {
  const [el, setEl] = useState<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!observe || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) onLoad();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [el, onLoad, observe]);
  return (
    <button ref={setEl} class="text-button load-more" onClick={onLoad}>
      {label ?? t("load_next_page_label")}
    </button>
  );
}
