// The episode list screens: Queue, Inbox, Episodes, Favorites and Playback
// history (Android's QueueFragment, InboxFragment, AllEpisodesFragment,
// FavoritesFragment, PlaybackHistoryFragment).
import { useRef, useState } from "preact/hooks";
import { t, plural, type StringKey } from "../i18n.ts";
import { reads, type EpisodeRow, type Records, type Summary } from "../api/views.ts";
import { useSync } from "../app/context.ts";
import * as act from "../app/actions.ts";
import { Confirm, Empty, Menu, RefreshBar, Toolbar, refreshItem, type MenuItem } from "../ui/components.tsx";
import { Icon } from "../ui/Icon.tsx";
import { SortDialog, dateOption, durationOption, titleOption, type SortOption } from "../ui/SortDialog.tsx";
import { sortQueueNow, wholeQueue } from "../app/queueOps.ts";
import { useView } from "../app/useView.ts";
import type { SortOrder as SortOrderName } from "../queue/sort.ts";
import { EpisodeList, usePaged } from "../ui/EpisodeList.tsx";
import { removeFromInbox } from "../ui/episodeActions.ts";
import { useLocalSetting } from "../ui/settings.ts";
import { exportBeforeCut } from "../player/instance.ts";
import { track } from "../ui/progress.ts";

// QueueFragment.QueueSortDialog: no size or file name, and date and smart
// shuffle start ascending.
const queueSortOptions: SortOption[] = [
  titleOption,
  { label: "feed_title", ascending: "feed_title_a_z", descending: "feed_title_z_a", ascendingIsDefault: true },
  durationOption,
  { ...dateOption, ascendingIsDefault: true },
  { label: "random", ascending: "random", descending: "random", ascendingIsDefault: true },
  { label: "smart_shuffle", ascending: "smart_shuffle_old_new", descending: "smart_shuffle_new_old", ascendingIsDefault: true },
];

type QueuePolicy = Summary["policies"]["queue"];

/**
 * QueueSort is Android's QueueSortDialog: picking an order sorts the queue
 * now and keeps it as the Keep sorted order; Keep sorted starts disabled
 * until an order is picked (unless it is on), and Random turns it off,
 * restoring it when another order is picked.
 */
function QueueSort({ policy, records, onClose }: { policy: QueuePolicy; records: Records; onClose: () => void }) {
  const sync = useSync();
  const [order, setOrder] = useState(policy.keep_sorted ? policy.sort_order : "");
  const [keep, setKeep] = useState(policy.keep_sorted);
  const [keepEnabled, setKeepEnabled] = useState(policy.keep_sorted);
  const offForRandom = useRef(false);
  const written = useRef({ keep_sorted: policy.keep_sorted, sort_order: policy.sort_order });
  const apply = async (o: string, k: boolean) => {
    await sync.pushed();
    const queue = await wholeQueue();
    if (written.current.keep_sorted !== k || written.current.sort_order !== o) {
      written.current = { keep_sorted: k, sort_order: o };
      await sync.act(act.setQueuePolicy(sync.account, { sorting: { keep_sorted: k, sort_order: o } }, records));
    }
    await sync.act(sortQueueNow(sync.account, queue, o as SortOrderName));
  };
  const changed = (o: string, wanted: boolean) => {
    let k = wanted;
    if (o === "random") {
      offForRandom.current ||= wanted;
      k = false;
      setKeepEnabled(false);
    } else {
      if (offForRandom.current) {
        k = true;
        offForRandom.current = false;
      }
      setKeepEnabled(true);
    }
    setOrder(o);
    setKeep(k);
    void track(apply(o, k));
  };
  return (
    <SortDialog options={queueSortOptions} value={order} onChange={(o) => changed(o, keep)} onClose={onClose}>
      <label class="check-row">
        <input type="checkbox" checked={keep} disabled={!keepEnabled} onChange={(e) => changed(order, (e.target as HTMLInputElement).checked)} />
        {t("keep_sorted")}
      </label>
    </SortDialog>
  );
}

export function Queue() {
  const sync = useSync();
  const list = usePaged((q, s) => reads.queue(q, s), []);
  const summary = useView((signal) => reads.summary(signal), []);
  const [confirm, setConfirm] = useState(false);
  const [sorting, setSorting] = useState(false);
  const items = list.items ?? [];
  const policy = summary.data?.policies.queue;
  // Clear queue removes the whole queue shown, not only the loaded pages.
  const clear = async () => {
    await sync.actAll(act.chunks(await list.all(), act.queueClear));
    setConfirm(false);
  };
  return (
    <section>
      <Toolbar title={t("queue_label")}>
        <span class="toolbar-info" dir="auto">{list.items ? plural("num_episodes", list.total) : ""}</span>
        <Menu
          label={t("overflow_more")}
          items={[
            // Android orders its menus by category: Sort and Clear queue, then Refresh (a container item).
            { label: t("sort"), run: () => setSorting(true) },
            { label: t("clear_queue_label"), disabled: items.length === 0, run: () => setConfirm(true) },
            refreshItem(sync),
          ]}
        />
      </Toolbar>
      <RefreshBar />
      {sorting && policy && summary.data && <QueueSort policy={policy} records={summary.data.records} onClose={() => setSorting(false)} />}
      <EpisodeList
        items={list.items}
        select={{
          total: list.total,
          all: list.all,
          // The loaded order; more before and after it while rows remain (the selection is never first or last then).
          queue: { order: [...(list.hasBefore ? [""] : []), ...items.map((e) => e.episode_id), ...(list.hasMore ? [""] : [])], keepSorted: !!policy?.keep_sorted },
        }}
        where="queue"
        hasMore={list.hasMore}
        loadMore={list.loadMore}
        loading={list.loading}
        window={list.window}
        empty={<Empty icon="playlist_play" title={t("no_items_header_label")} text={t("no_items_label")} />}
      />
      {confirm && (
        <Confirm title={t("clear_queue_label")} message={t("clear_queue_confirmation_msg")} onCancel={() => setConfirm(false)} onConfirm={clear} />
      )}
    </section>
  );
}

export function Inbox() {
  const sync = useSync();
  const [order, setOrder] = useLocalSetting("inbox_sort", "date_new_old");
  const list = usePaged((q, s) => reads.inbox({ ...q, sort: order }, s), [order]);
  const [confirm, setConfirm] = useState(false);
  const [sorting, setSorting] = useState(false);
  const items = list.items ?? [];
  return (
    <section>
      <Toolbar title={t("inbox_label")}>
        <Menu
          label={t("overflow_more")}
          items={[
            // Sort, then the container items in Android's order: Refresh, Remove all from Inbox.
            { label: t("sort"), run: () => setSorting(true) },
            refreshItem(sync),
            { label: t("remove_all_inbox_label"), disabled: items.length === 0, run: () => setConfirm(true) },
          ]}
        />
      </Toolbar>
      <RefreshBar />
      {sorting && <SortDialog options={[dateOption, durationOption]} value={order} onChange={setOrder} onClose={() => setSorting(false)} />}
      <EpisodeList
        items={list.items}
        select={{ total: list.total, all: list.all }}
        where="inbox"
        hasMore={list.hasMore}
        loadMore={list.loadMore}
        loading={list.loading}
        window={list.window}
        empty={<Empty icon="inbox" title={t("no_inbox_head_label")} text={t("no_inbox_label")} />}
      />
      {confirm && (
        <Confirm
          title={t("remove_all_inbox_label")}
          message={t("remove_all_inbox_confirmation_msg")}
          onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            // Exactly the observed NEW episodes, every page of them (PROTOCOL §7.2: dismiss_all), in facts the server accepts.
            await sync.actAll(act.dismissAll(await list.all()));
            setConfirm(false);
          }}
        />
      )}
    </section>
  );
}

const filterGroups: [StringKey, string, StringKey, string][] = [
  ["hide_played_episodes_label", "played", "not_played", "unplayed"],
  ["hide_paused_episodes_label", "paused", "not_paused", "not_paused"],
  ["hide_is_favorite_label", "is_favorite", "not_favorite", "not_favorite"],
  ["has_media", "has_media", "no_media", "no_media"],
  ["queued_label", "queued", "not_queued_label", "not_queued"],
];

export function Episodes() {
  const sync = useSync();
  const [order, setOrder] = useLocalSetting("episodes_sort", "date_new_old");
  const [filter, setFilter] = useLocalSetting("episodes_filter", "");
  const list = usePaged((q, s) => reads.episodes({ ...q, sort: order, filter }, s), [order, filter]);
  const props = filter ? filter.split(",") : [];
  const toggle = (on: string, off: string) => {
    const without = props.filter((p) => p !== on && p !== off);
    setFilter((props.includes(on) ? without : [...without, on]).join(","));
  };
  const filterItems: MenuItem[] = filterGroups.flatMap(([onLabel, on, offLabel, off]) => [
    { label: t(onLabel), checked: props.includes(on), run: () => toggle(on, off) },
    { label: t(offLabel), checked: props.includes(off), run: () => toggle(off, on) },
  ]);
  const [sorting, setSorting] = useState(false);
  return (
    <section>
      <Toolbar title={t("episodes_label")}>
        <span class="toolbar-info" dir="auto">{list.items ? plural("num_episodes", list.total) : ""}</span>
        <Menu label={t("filter")} items={filterItems} icon={<Icon name="filter" />} />
        <Menu label={t("overflow_more")} items={[{ label: t("sort"), run: () => setSorting(true) }, refreshItem(sync)]} />
      </Toolbar>
      <RefreshBar />
      {sorting && <SortDialog options={[dateOption, durationOption]} value={order} onChange={setOrder} onClose={() => setSorting(false)} />}
      <EpisodeList
        items={list.items}
        select={{ total: list.total, all: list.all }}
        hasMore={list.hasMore}
        loadMore={list.loadMore}
        loading={list.loading}
        window={list.window}
        empty={
          <Empty icon="feed" title={t("no_all_episodes_head_label")} text={props.length ? t("no_all_episodes_filtered_label") : t("no_all_episodes_label")} />
        }
      />
    </section>
  );
}

export function Favorites() {
  const sync = useSync();
  const [order, setOrder] = useLocalSetting("favorites_sort", "date_new_old");
  const list = usePaged((q, s) => reads.favorites({ ...q, sort: order }, s), [order]);
  const [sorting, setSorting] = useState(false);
  return (
    <section>
      <Toolbar title={t("favorite_episodes_label")}>
        <Menu label={t("overflow_more")} items={[refreshItem(sync), { label: t("sort"), run: () => setSorting(true) }]} />
      </Toolbar>
      <RefreshBar />
      {sorting && <SortDialog options={[dateOption, durationOption]} value={order} onChange={setOrder} onClose={() => setSorting(false)} />}
      <EpisodeList
        items={list.items}
        select={{ total: list.total, all: list.all }}
        hasMore={list.hasMore}
        loadMore={list.loadMore}
        loading={list.loading}
        window={list.window}
        empty={<Empty icon="star" title={t("no_fav_episodes_head_label")} text={t("no_fav_episodes_label")} />}
      />
    </section>
  );
}

export function History() {
  const sync = useSync();
  const list = usePaged((q, s) => reads.history(q, s), []);
  const [confirm, setConfirm] = useState(false);
  const clear = async () => {
    // The cut depends on the whole frontier of the view shown (PROTOCOL §12), after
    // every unexported save of the account is exported (PROTOCOL §12).
    const head = list.data?.head;
    if (!head) return;
    const listening = await exportBeforeCut(sync);
    const { frontier } = await reads.frontier(head.cursor);
    await sync.act(act.historyClear([...frontier, ...listening]));
    setConfirm(false);
  };
  return (
    <section>
      <Toolbar title={t("playback_history_label")}>
        <Menu label={t("overflow_more")} items={[{ label: t("clear_history_label"), disabled: !list.items?.length, run: () => setConfirm(true) }]} />
      </Toolbar>
      <EpisodeList
        items={list.items}
        select={{ total: list.total, all: list.all }}
        where="history"
        hasMore={list.hasMore}
        loadMore={list.loadMore}
        loading={list.loading}
        window={list.window}
        empty={<Empty icon="history" title={t("no_history_head_label")} text={t("no_history_label")} />}
      />
      {confirm && (
        <Confirm
          title={t("clear_history_label")}
          message={t("clear_playback_history_msg")}
          onCancel={() => setConfirm(false)}
          onConfirm={clear}
        />
      )}
    </section>
  );
}

export function InboxBulkRemove({ episodes }: { episodes: EpisodeRow[] }) {
  const sync = useSync();
  return (
    <button class="text-button" onClick={() => void track(removeFromInbox(sync, episodes))}>
      {t("remove_inbox_label")}
    </button>
  );
}
