// Android's multi select in the episode lists (SelectableAdapter,
// FloatingSelectMenu, EpisodeMultiSelectActionHandler): "Multi select" in a
// row's menu starts it; the toolbar becomes the action mode ("n/m selected",
// Select all, Select all above and below); a row's click selects it, and
// Shift-click selects a range, as desktop lists do; the actions float at the
// bottom; an action applies to the selection, and the mode ends.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { t, w } from "../i18n.ts";
import type { EpisodeRow } from "../api/views.ts";
import { Value, type Sync } from "../app/sync.ts";
import type { IconName } from "../generated/icons.ts";
import { Confirm, IconButton, Menu } from "./components.tsx";
import { Icon } from "./Icon.tsx";
import { dequeue, enqueue, moveAll, removeFromInbox, resetPosition, setFavorite, setPlayed } from "./episodeActions.ts";
import { track } from "./progress.ts";
import { bulkKinds, type BulkKind, type QueueContext } from "./bulk.ts";

export type { QueueContext } from "./bulk.ts";

/** ActionMode is what the toolbar shows while a list selects (Android's ActionMode). */
export interface ActionMode {
  count: number;
  total: number;
  allSelected: boolean;
  close(): void;
  toggleAll(): void;
  above(): void;
  below(): void;
}

/** actionMode is the screen's action mode, if its list is selecting. */
export const actionMode = new Value<ActionMode | null>(null);

/** ActionModeBar replaces the screen's toolbar while its list selects. */
export function ActionModeBar({ mode }: { mode: ActionMode }) {
  return (
    <header class="toolbar action-mode">
      <IconButton icon="close" label={t("close_label")} onClick={mode.close} />
      <h1 aria-live="polite" dir="auto">
        {t("num_selected_label", mode.count, mode.total)}
      </h1>
      <div class="toolbar-actions">
        <Menu
          label={t("overflow_more")}
          items={[
            { label: mode.allSelected ? t("deselect_all_label") : t("select_all_label"), run: mode.toggleAll },
            { label: t("select_all_above"), run: mode.above },
            { label: t("select_all_below"), run: mode.below },
          ]}
        />
      </div>
    </header>
  );
}

/** Selection is a list's multi select (of episodes, or of podcasts). */
export interface Selection<T = EpisodeRow> {
  active: boolean;
  isSelected(id: string): boolean;
  /** start begins selecting, with this row selected ("Multi select"). */
  start(id: string): void;
  /** click toggles a row, or with `range` selects from the last clicked row to this one. */
  click(id: string, range: boolean): void;
  end(): void;
  /** selected are the loaded rows selected, in list order. */
  selected: T[];
  /** lazy: Select all or Select all below also takes the rows not loaded yet. */
  lazy: boolean;
  count: number;
}

/**
 * useSelection keeps a list's selection: by episode, so a reload keeps it,
 * and `total` counts the rows not loaded yet (Android's totalNumberOfItems).
 */
export function useSelection<T = EpisodeRow>(items: T[] | undefined, total: number, idOf: (x: T) => string = (x) => (x as EpisodeRow).episode_id): Selection<T> {
  const [ids, setIds] = useState<Set<string> | null>(null);
  const [lazy, setLazy] = useState(false);
  const anchor = useRef<string | null>(null);
  const rows = items ?? [];
  const active = ids !== null;
  // After Select all or Select all below, rows loaded later are selected too (Android's
  // shouldSelectLazyLoadedItems): they join the selection as they arrive.
  const known = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!ids || !lazy) {
      known.current = new Set(rows.map(idOf));
      return;
    }
    const fresh = rows.map(idOf).filter((id) => !known.current.has(id));
    known.current = new Set(rows.map(idOf));
    if (fresh.length) setIds(new Set([...ids, ...fresh]));
  }, [rows, ids, lazy]);
  const selected = active ? rows.filter((e) => ids.has(idOf(e))) : [];
  const count = selected.length + (lazy ? Math.max(0, total - rows.length) : 0);
  const end = () => {
    setIds(null);
    setLazy(false);
    anchor.current = null;
  };
  const set = (next: Set<string>) => (next.size === 0 ? end() : setIds(next));
  const sel: Selection<T> = {
    active,
    isSelected: (id) => !!ids?.has(id),
    start(id) {
      anchor.current = id;
      setLazy(false);
      setIds(new Set([id]));
    },
    click(id, range) {
      if (!ids) return;
      const next = new Set(ids);
      const from = range && anchor.current ? rows.findIndex((e) => idOf(e) === anchor.current) : -1;
      const to = rows.findIndex((e) => idOf(e) === id);
      if (from >= 0 && to >= 0) {
        for (let i = Math.min(from, to); i <= Math.max(from, to); i++) next.add(idOf(rows[i]!));
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      anchor.current = id;
      set(next);
    },
    end,
    selected,
    lazy,
    count,
  };
  const allSelected = active && selected.length === rows.length;
  // The toolbar's action mode follows the selection; Escape ends it, as Android's back does.
  const live = useRef(sel);
  live.current = sel;
  useLayoutEffect(() => {
    if (!active) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector("[role=menu], dialog[open]")) return;
      live.current.end();
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      actionMode.set(null);
    };
  }, [active]);
  // Before the browser paints, so the title never shows an old count.
  useLayoutEffect(() => {
    if (!active) return;
    actionMode.set({
      count,
      total: Math.max(total, rows.length),
      allSelected,
      close: end,
      toggleAll() {
        setLazy(!allSelected);
        setIds(allSelected ? new Set() : new Set(rows.map(idOf)));
      },
      above() {
        const first = rows.findIndex((e) => ids!.has(idOf(e)));
        const next = new Set(ids);
        for (let i = 0; i < first; i++) next.add(idOf(rows[i]!));
        setIds(next);
      },
      below() {
        let last = -1;
        rows.forEach((e, i) => ids!.has(idOf(e)) && (last = i));
        const next = new Set(ids);
        for (let i = last + 1; i < rows.length; i++) next.add(idOf(rows[i]!));
        setLazy(true);
        setIds(next);
      },
    });
  });
  return sel;
}

/** A bulk action of the floating menu (Android's episodes_apply_action_speeddial, nav_feed_action_speeddial). */
export interface BulkAction<T = EpisodeRow> {
  icon: IconName;
  label: string;
  /** confirm: the confirmation Android asks before a large selection is changed. */
  confirm?: string;
  run(rows: T[]): void | Promise<void>;
}

const icons: Record<BulkKind, IconName> = {
  mark_unplayed: "mark_unplayed",
  mark_played: "mark_played",
  remove_from_queue: "playlist_remove",
  add_to_queue: "playlist_play",
  remove_inbox: "check",
  add_favorite: "star",
  remove_favorite: "star_border",
  reset_position: "replay",
  move_to_top: "arrow_full_up",
  move_to_bottom: "arrow_full_down",
};

/** bulkActions are the floating menu's actions for the selection (bulkKinds), with what each does. */
export function bulkActions(sync: Sync, sel: EpisodeRow[], queue?: QueueContext): BulkAction[] {
  const noMedia = sel.length === 1 && !sel[0]!.has_media;
  return bulkKinds(sel, queue).map((k): BulkAction => {
    const a = { icon: icons[k] };
    switch (k) {
      case "mark_unplayed":
        return { ...a, label: t(noMedia ? "mark_unread_label_no_media" : "mark_as_unplayed_label"), confirm: w("multi_select_mark_unplayed_confirmation"), run: (es) => setPlayed(sync, es, false) };
      case "mark_played":
        return { ...a, label: t(noMedia ? "mark_read_no_media_label" : "mark_as_played_label"), confirm: w("multi_select_mark_played_confirmation"), run: (es) => setPlayed(sync, es, true) };
      case "remove_from_queue":
        return { ...a, label: t("remove_from_queue_label"), run: (es) => dequeue(sync, es.filter((e) => e.in_queue)) };
      case "add_to_queue":
        return { ...a, label: t("add_to_queue_label"), run: (es) => enqueue(sync, es.filter((e) => e.has_media && !e.in_queue)) };
      case "remove_inbox":
        return { ...a, label: t("remove_inbox_label"), run: (es) => removeFromInbox(sync, es.filter((e) => e.play_state === "new")) };
      case "add_favorite":
        return { ...a, label: t("add_to_favorite_label"), run: (es) => setFavorite(sync, es.filter((e) => !e.favorite), true) };
      case "remove_favorite":
        return { ...a, label: t("remove_from_favorite_label"), run: (es) => setFavorite(sync, es.filter((e) => e.favorite), false) };
      case "reset_position":
        return { ...a, label: t("reset_playback_position_label"), run: (es) => resetPosition(sync, es.filter((e) => e.has_media && e.position !== 0)) };
      case "move_to_top":
        return { ...a, label: t("move_to_top_label"), run: (es) => moveAll(sync, es, "top") };
      case "move_to_bottom":
        return { ...a, label: t("move_to_bottom_label"), run: (es) => moveAll(sync, es, "bottom") };
    }
  });
}

/**
 * SelectActions is Android's FloatingSelectMenu: the selection's actions at
 * the bottom, each an icon over its name. An action on no selection says so;
 * marking 25 or more, or a selection with rows not loaded yet, asks first;
 * the rows not loaded yet are read before the action runs; then the mode ends.
 */
export function SelectActions<T = EpisodeRow>({ sync, selection, actions, items, all, idOf = (x) => (x as EpisodeRow).episode_id }: {
  sync: Sync;
  selection: Selection<T>;
  actions: BulkAction<T>[];
  /** items are the rows loaded; `all` reads every row of the list. */
  items: T[];
  all: () => Promise<T[]>;
  idOf?: (x: T) => string;
}) {
  const [asking, setAsking] = useState<BulkAction<T> | null>(null);
  const perform = async (a: BulkAction<T>) => {
    let targets = selection.selected;
    if (selection.lazy) {
      // Select all and Select all below take the rows not loaded yet, as Android loads its next pages.
      const loaded = new Set(items.map(idOf));
      targets = [...targets, ...(await all()).filter((e) => !loaded.has(idOf(e)))];
    }
    await a.run(targets);
    selection.end();
  };
  const choose = (a: BulkAction<T>) => {
    if (selection.count === 0) {
      sync.notify(t("no_items_selected_message"));
      return;
    }
    if (a.confirm && (selection.count >= 25 || selection.lazy)) setAsking(a);
    else void track(perform(a));
  };
  return (
    <>
      <div class="floating-select" role="toolbar" aria-label={t("multi_select")}>
        <span class="visually-hidden" aria-live="polite">
          {t("multi_select_started_talkback")}
        </span>
        {actions.map((a) => (
          <button key={a.label} class="floating-select-item" onClick={() => choose(a)}>
            <Icon name={a.icon} size={28} />
            <span dir="auto">{a.label}</span>
          </button>
        ))}
      </div>
      {asking && (
        <Confirm
          title={t("multi_select")}
          message={asking.confirm!}
          onCancel={() => setAsking(null)}
          onConfirm={async () => {
            const a = asking;
            setAsking(null);
            await perform(a);
          }}
        />
      )}
    </>
  );
}
