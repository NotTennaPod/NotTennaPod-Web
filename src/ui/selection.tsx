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
  /** selected are the rows selected that are known here (loaded, or picked one by one), in list order. */
  selected: T[];
  /** lazy: the selection takes rows not loaded (Select all, Select all above or below). */
  lazy: boolean;
  count: number;
  /**
   * resolve is what an action applies to, in list order: the rows picked, and
   * the rows of each range Select all, above and below took, but those
   * deselected since; rows not loaded are found by walking the whole view
   * (`walk`, in list order) the selection was made on.
   */
  resolve(walk: () => Promise<T[]>): Promise<T[]>;
}

/**
 * The selection's state, in indexes of the view it is made on (Android's
 * SelectableAdapter, whose positions are the list's): the rows picked one by
 * one, the ranges Select all, above and below took (Android's lazily loaded
 * rows included), and the rows deselected within those ranges since.
 */
interface Picked<T> {
  picked: Map<string, { row: T; i: number }>;
  ranges: [number, number][];
  excluded: Map<string, number>;
}

/** spanOf is how many indexes ranges cover together, within [0, total). */
function spanOf(ranges: [number, number][], total: number): number {
  const sorted = ranges.map(([a, b]): [number, number] => [Math.max(0, a), Math.min(total, b)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let n = 0;
  let end = 0;
  for (const [a, b] of sorted) {
    const from = Math.max(a, end);
    if (b > from) n += b - from;
    end = Math.max(end, b);
  }
  return n;
}

/**
 * useSelection keeps a list's selection by episode and by its place in the
 * list: `offset` is the index of the first row of `items` (a window of the
 * list), and `total` counts the rows not loaded (Android's totalNumberOfItems).
 */
export function useSelection<T = EpisodeRow>(
  items: T[] | undefined,
  total: number,
  idOf: (x: T) => string = (x) => (x as EpisodeRow).episode_id,
  offset = 0,
): Selection<T> {
  const [s, setS] = useState<Picked<T> | null>(null);
  const anchor = useRef<string | null>(null);
  const rows = items ?? [];
  const active = s !== null;
  const indexOf = new Map(rows.map((r, k) => [idOf(r), offset + k]));
  const inRange = (i: number) => !!s && s.ranges.some(([a, b]) => i >= a && i < b);
  const selectedAt = (id: string, i: number) => !!s && !s.excluded.has(id) && (s.picked.has(id) || inRange(i));
  const isSelected = (id: string) => {
    const i = indexOf.get(id);
    if (i !== undefined) return selectedAt(id, i);
    const p = s?.picked.get(id);
    return !!p && !s!.excluded.has(id);
  };
  // The rows known here: those loaded, and those picked one by one elsewhere in the list.
  const known: { row: T; i: number }[] = rows.map((row, k) => ({ row, i: offset + k }));
  if (s) for (const [id, p] of s.picked) if (!indexOf.has(id)) known.push(p);
  known.sort((x, y) => x.i - y.i);
  const selected = active ? known.filter((x) => selectedAt(idOf(x.row), x.i)).map((x) => x.row) : [];
  let count = 0;
  if (s) {
    const n = Math.max(total, offset + rows.length);
    count = spanOf(s.ranges, n);
    for (const [, i] of s.excluded) if (inRange(i)) count--;
    for (const [id, p] of s.picked) if (!s.excluded.has(id) && !inRange(p.i)) count++;
  }
  const loadedFrom = offset;
  const loadedTo = offset + rows.length;
  const lazy = !!s && s.ranges.some(([a, b]) => a < loadedFrom || Math.min(b, Math.max(total, loadedTo)) > loadedTo);
  const end = () => {
    setS(null);
    anchor.current = null;
  };
  /** change edits a copy of the state; nothing selected ends the mode (as a deselected last row does). */
  const change = (edit: (p: Picked<T>) => void, endIfEmpty = true) => {
    if (!s) return;
    const n: Picked<T> = { picked: new Map(s.picked), ranges: [...s.ranges], excluded: new Map(s.excluded) };
    edit(n);
    const left = n.picked.size > 0 && [...n.picked.keys()].some((id) => !n.excluded.has(id));
    if (endIfEmpty && !left && !n.ranges.length) end();
    else setS(n);
  };
  const pick = (n: Picked<T>, row: T, i: number) => {
    const id = idOf(row);
    n.excluded.delete(id);
    if (!n.ranges.some(([a, b]) => i >= a && i < b)) n.picked.set(id, { row, i });
  };
  const sel: Selection<T> = {
    active,
    isSelected,
    start(id) {
      const k = rows.findIndex((e) => idOf(e) === id);
      anchor.current = id;
      setS({ picked: k < 0 ? new Map() : new Map([[id, { row: rows[k]!, i: offset + k }]]), ranges: [], excluded: new Map() });
    },
    click(id, range) {
      if (!s) return;
      const from = range && anchor.current ? rows.findIndex((e) => idOf(e) === anchor.current) : -1;
      const to = rows.findIndex((e) => idOf(e) === id);
      anchor.current = id;
      if (to < 0) return;
      change((n) => {
        if (from >= 0) {
          for (let k = Math.min(from, to); k <= Math.max(from, to); k++) pick(n, rows[k]!, offset + k);
        } else if (selectedAt(id, offset + to)) {
          n.picked.delete(id);
          if (n.ranges.some(([a, b]) => offset + to >= a && offset + to < b)) n.excluded.set(id, offset + to);
        } else pick(n, rows[to]!, offset + to);
      });
    },
    end,
    selected,
    lazy,
    count,
    async resolve(walk) {
      if (!s) return [];
      if (!lazy) return selected;
      // In list order, as Android collects them: one walk of the view, filtered.
      const all = await walk();
      return all.filter((row, i) => selectedAt(idOf(row), i));
    },
  };
  const n = Math.max(total, offset + rows.length);
  const allSelected = active && count >= n;
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
    // Indexes of what is selected: the first and the last (SelectableAdapter's select_all_above / _below).
    const chosen: number[] = [];
    for (const x of known) if (selectedAt(idOf(x.row), x.i)) chosen.push(x.i);
    for (const [a, b] of s!.ranges) {
      for (let i = a; i < Math.min(b, n); i++) {
        const id = rows[i - offset] ? idOf(rows[i - offset]!) : null;
        if (id === null || !s!.excluded.has(id)) {
          chosen.push(i);
          break;
        }
      }
      for (let i = Math.min(b, n) - 1; i >= a; i--) {
        const id = rows[i - offset] ? idOf(rows[i - offset]!) : null;
        if (id === null || !s!.excluded.has(id)) {
          chosen.push(i);
          break;
        }
      }
    }
    actionMode.set({
      count,
      total: n,
      allSelected,
      close: end,
      toggleAll() {
        // Deselect all keeps the mode, with nothing selected; Select all takes every row of the list.
        change((p) => {
          p.picked.clear();
          p.excluded.clear();
          p.ranges = allSelected ? [] : [[0, n]];
        }, false);
      },
      above() {
        const first = chosen.length ? Math.min(...chosen) : 0;
        if (first > 0) change((p) => p.ranges.push([0, first]));
      },
      below() {
        const last = chosen.length ? Math.max(...chosen) : -1;
        if (last + 1 < n) change((p) => p.ranges.push([last + 1, n]));
      },
    });
  });
  return sel;
}

/**
 * useListSelection is a list's selection as a list window holds it: by the
 * window's place in the list; the list holds still while selecting (set
 * before anything else can apply); a view that expires ends the selection.
 */
export function useListSelection<T = EpisodeRow>(
  items: T[] | undefined,
  total: number,
  win?: { offset: number; hold: (on: boolean) => void; lost: number },
  idOf?: (x: T) => string,
): Selection<T> {
  const selection = useSelection(items, total, idOf, win?.offset ?? 0);
  const hold = useRef(win?.hold);
  hold.current = win?.hold;
  useLayoutEffect(() => hold.current?.(selection.active), [selection.active]);
  useEffect(() => {
    if (win?.lost) selection.end();
  }, [win?.lost]);
  return selection;
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
export function SelectActions<T = EpisodeRow>({ sync, selection, actions, all }: {
  sync: Sync;
  selection: Selection<T>;
  actions: BulkAction<T>[];
  /** all reads every row of the list (the view the selection was made on), in list order. */
  all: () => Promise<T[]>;
  /** Kept for callers: the rows loaded and their identity (the selection knows both). */
  items?: T[];
  idOf?: (x: T) => string;
}) {
  const [asking, setAsking] = useState<BulkAction<T> | null>(null);
  const perform = async (a: BulkAction<T>) => {
    // The rows selected in list order; rows not loaded are read from the view the selection was made on.
    const targets = await selection.resolve(all);
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
            // The dialog is gone: a failure (a list that expired while it was read) is the snackbar's to say.
            await track(perform(a));
          }}
        />
      )}
    </>
  );
}
