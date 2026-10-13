// Subscriptions (Android's SubscriptionFragment): the grid of covers with
// counters, its order and counter settings, the archive, and the filter.
import { useRef, useState } from "preact/hooks";
import { t } from "../i18n.ts";
import { reads, type PodcastRow } from "../api/views.ts";
import { useSync } from "../app/context.ts";
import { linkProps, pathOf } from "../app/router.ts";
import { Cover } from "../ui/Cover.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Confirm, contextPoint, Empty, Menu, Toolbar, type MenuItem, type MenuPoint } from "../ui/components.tsx";
import { KeepUpdatedDialog, RemoveFeedDialog, removeAllInbox } from "../ui/podcastDialogs.tsx";
import { SelectActions, useSelection, type BulkAction } from "../ui/selection.tsx";
import { LoadMore, usePaged } from "../ui/EpisodeList.tsx";
import { useLocalSetting } from "../ui/settings.ts";

const idOf = (p: PodcastRow) => p.podcast_id;

/**
 * podcastActions are Android's actions for podcasts (nav_feed_action_speeddial,
 * as FeedMenuHandler.onPrepareMenu shows them): Remove all from inbox and
 * Unsubscribe / archive while all are subscribed, Unsubscribe / restore when
 * all are archived, and Keep updated. Tags, sharing and the phone's own
 * settings (notifications, downloads, speed) are not the browser's.
 */
function podcastActions(ps: PodcastRow[], open: (d: { kind: "remove" | "keep" | "inbox"; podcasts: PodcastRow[] }) => void): BulkAction<PodcastRow>[] {
  const allSubscribed = ps.every((p) => p.state === "subscribed");
  const allArchived = ps.every((p) => p.state === "archived");
  const out: BulkAction<PodcastRow>[] = [];
  if (allSubscribed) out.push({ icon: "check", label: t("remove_all_inbox_label"), run: (rows) => open({ kind: "inbox", podcasts: rows }) });
  if (!allArchived && allSubscribed) out.push({ icon: "delete", label: t("remove_archive_feed_label"), run: (rows) => open({ kind: "remove", podcasts: rows }) });
  if (allArchived) out.push({ icon: "delete", label: t("remove_restore_feed_label"), run: (rows) => open({ kind: "remove", podcasts: rows }) });
  out.push({ icon: "refresh", label: t("keep_updated"), run: (rows) => open({ kind: "keep", podcasts: rows }) });
  return out;
}

export function Subscriptions() {
  const [order, setOrder] = useLocalSetting("feed_order", "counter");
  const [counter, setCounter] = useLocalSetting("feed_counter", "new");
  const [state, setState] = useLocalSetting("feed_state", "subscribed");
  const [filter, setFilter] = useLocalSetting("feed_filter", "");
  const list = usePaged((q, s) => reads.subscriptions({ ...q, order, counter, state, filter }, s), [order, counter, state, filter]);
  const orders: MenuItem[] = [
    ["counter", t("drawer_feed_order_unplayed_episodes")],
    ["alphabetical", t("drawer_feed_order_alphabetical")],
    ["most_recent_episode", t("drawer_feed_order_last_update")],
    ["most_played", t("drawer_feed_order_most_played")],
  ].map(([v, label]) => ({ label: label!, checked: order === v, run: () => setOrder(v!) }));
  const counters: MenuItem[] = [
    ["new", t("drawer_feed_counter_inbox")],
    ["unplayed", t("drawer_feed_counter_unplayed")],
    ["none", t("drawer_feed_counter_none")],
  ].map(([v, label]) => ({ label: label!, checked: counter === v, run: () => setCounter(v!) }));
  const props = filter ? filter.split(",") : [];
  const toggle = (p: string, other?: string) =>
    setFilter((props.includes(p) ? props.filter((x) => x !== p) : [...props.filter((x) => x !== other), p]).join(","));
  const filters: MenuItem[] = [
    { label: t("subscriptions_counter_greater_zero"), checked: props.includes("counter_greater_zero"), run: () => toggle("counter_greater_zero") },
    { label: t("keep_updated"), checked: props.includes("enabled_updates"), run: () => toggle("enabled_updates", "disabled_updates") },
  ];
  // A tile's menu (Android's nav_feed_context, as FeedMenuHandler.onPrepareMenu shows it) and multi select.
  const sync = useSync();
  const [menu, setMenu] = useState<{ id: string; at: MenuPoint } | null>(null);
  const [dialog, setDialog] = useState<{ kind: "remove" | "keep" | "inbox"; podcasts: PodcastRow[] } | null>(null);
  const selection = useSelection(list.items, list.total, idOf);
  const shownActions = useRef<BulkAction<PodcastRow>[]>([]);
  if (selection.active && selection.count > 0) shownActions.current = podcastActions(selection.selected, setDialog);
  const podcastMenu = (p: PodcastRow): MenuItem[] => [
    ...podcastActions([p], setDialog)
      .filter((a) => a.label !== t("keep_updated"))
      .map((a) => ({ label: a.label, run: () => void a.run([p]) })),
    { label: t("multi_select"), run: () => selection.start(p.podcast_id) },
  ];
  return (
    <section>
      <Toolbar title={state === "archived" ? t("archive_feed_label_noun") : t("subscriptions_label")}>
        <Menu label={t("filter")} items={filters} icon={<Icon name="filter" />} />
        <Menu label={t("sort")} items={orders} />
        <Menu
          label={t("overflow_more")}
          items={[
            ...counters,
            {
              label: state === "archived" ? t("subscriptions_label") : t("archive_feed_label_noun"),
              run: () => setState(state === "archived" ? "subscribed" : "archived"),
            },
          ]}
        />
      </Toolbar>
      {list.items && list.items.length === 0 ? (
        <Empty icon="subscriptions" title={t("no_subscriptions_head_label")} text={t("no_subscriptions_label")} />
      ) : (
        <ul class="subscription-grid">
          {(list.items ?? []).map((p) => {
            const chosen = selection.isSelected(p.podcast_id);
            const body = (
              <>
                <Cover url={p.image_url} title={p.display_title} size={160} />
                <span class="subscription-title">{p.display_title}</span>
                {selection.active ? (
                  // Android's circle_checked and circle_unchecked; the counter is hidden while selecting.
                  <span class={`select-mark${chosen ? " checked" : ""}`} aria-hidden="true">
                    {chosen && <Icon name="check" size={18} />}
                  </span>
                ) : (
                  counter !== "none" && (p.counter ?? 0) > 0 && <span class="subscription-count">{p.counter}</span>
                )}
              </>
            );
            return (
              <li
                key={p.podcast_id}
                class={chosen ? "selected" : undefined}
                onContextMenu={(ev) => {
                  if (selection.active) return; // Android shows no menu while selecting
                  ev.preventDefault();
                  setMenu({ id: p.podcast_id, at: contextPoint(ev) });
                }}
              >
                {selection.active ? (
                  <button
                    type="button"
                    class="subscription-tile"
                    role="checkbox"
                    aria-checked={chosen}
                    aria-label={p.display_title}
                    onClick={(ev) => selection.click(p.podcast_id, ev.shiftKey)}
                  >
                    {body}
                  </button>
                ) : (
                  <a class="subscription-tile" {...linkProps(pathOf({ name: "podcast", id: p.podcast_id }))} aria-label={p.display_title}>
                    {body}
                  </a>
                )}
                {menu?.id === p.podcast_id && (
                  <Menu contextOnly label={p.display_title} items={podcastMenu(p)} at={menu.at} onDismiss={() => setMenu(null)} />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {list.hasMore && <LoadMore onLoad={list.loadMore} />}
      {selection.active && list.items && (
        <SelectActions sync={sync} selection={selection} items={list.items} all={list.all} idOf={idOf} actions={shownActions.current} />
      )}
      {dialog?.kind === "remove" && <RemoveFeedDialog sync={sync} podcasts={dialog.podcasts} onClose={() => setDialog(null)} />}
      {dialog?.kind === "keep" && <KeepUpdatedDialog sync={sync} podcasts={dialog.podcasts} onClose={() => setDialog(null)} />}
      {dialog?.kind === "inbox" && (
        <Confirm
          title={t("remove_all_inbox_label")}
          message={t("remove_all_inbox_confirmation_msg")}
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            await removeAllInbox(sync, dialog.podcasts);
            setDialog(null);
          }}
        />
      )}
    </section>
  );
}
