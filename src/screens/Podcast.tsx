// A podcast (Android's FeedItemlistFragment with its info and settings):
// header, Subscribe for a preview, the episode list with Android's filter and
// sort, the account-level settings (keep updated, new episodes action,
// credentials shown as set), the statistics card, archive and unsubscribe.
import { useState } from "preact/hooks";
import { t, w, plural, type StringKey } from "../i18n.ts";
import { reads, type PodcastRow } from "../api/views.ts";
import * as act from "../app/actions.ts";
import { useSync } from "../app/context.ts";
import { navigate } from "../app/router.ts";
import { useView } from "../app/useView.ts";
import { Cover } from "../ui/Cover.tsx";
import { Confirm, Empty, Loading, Menu, Toolbar, type MenuItem } from "../ui/components.tsx";
import { AuthenticationDialog, RemoveFeedDialog, removeAllInbox } from "../ui/podcastDialogs.tsx";
import { feedURL } from "../app/feedLogin.ts";
import { EpisodeList, usePaged } from "../ui/EpisodeList.tsx";
import { SortDialog, dateOption, durationOption, titleOption } from "../ui/SortDialog.tsx";
import { durationLong } from "../ui/format.ts";
import { useLocalSetting } from "../ui/settings.ts";
import { track } from "../ui/progress.ts";

const actions: [string, StringKey][] = [
  ["global", "global_default"],
  ["inbox", "feed_new_episodes_action_add_to_inbox"],
  ["queue", "feed_new_episodes_action_add_to_queue"],
  ["nothing", "feed_new_episodes_action_nothing"],
];

export function Podcast({ id }: { id: string }) {
  const sync = useSync();
  const view = useView((signal) => reads.podcast(id, signal), [id]);
  const [order, setOrder] = useLocalSetting(`podcast_sort:${id}`, "date_new_old");
  const list = usePaged((q, s) => reads.podcastEpisodes(id, { ...q, sort: order }, s), [id, order]);
  const [removing, setRemoving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [sorting, setSorting] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const p = view.data?.podcast;
  if (!p) return view.error ? <Empty icon="error" title={w("not_found_title")} text={view.error} /> : <Loading />;
  const policy = p.records.policy?.value as { new_episodes_action?: string; keep_updated?: boolean } | undefined;
  const meta = p.records.metadata?.value as { author?: string | null; description?: string | null } | undefined;
  const creds = typeof p.credentials === "object" ? p.credentials : { set: p.credentials };
  const settings: MenuItem[] =
    p.state === "not_subscribed"
      ? []
      : [
          {
            label: t("keep_updated"),
            checked: !!policy?.keep_updated,
            run: async () => void (await sync.act(act.setPolicy(p, { keep_updated: !policy?.keep_updated }))),
          },
          ...actions.map(([v, label]) => ({
            label: `${t("pref_new_episodes_action_title")}: ${t(label)}`,
            checked: policy?.new_episodes_action === v,
            run: async () => void (await sync.act(act.setPolicy(p, { new_episodes_action: v }))),
          })),
          // Android's feed settings: Advanced, Authentication.
          { label: t("authentication_label"), run: () => setAuthenticating(true) },
          ...(p.state === "subscribed" ? [{ label: t("remove_all_inbox_label"), run: () => setClearing(true) }] : []),
          p.state === "archived"
            ? { label: t("remove_restore_feed_label"), run: () => setRemoving(true) }
            : { label: t("remove_archive_feed_label"), run: () => setRemoving(true) },
        ];
  const st = p.statistics;
  return (
    // data-podcast-id says which podcast the screen shows (for test drivers; nothing a person sees).
    <section data-podcast-id={p.podcast_id}>
      <Toolbar title={p.display_title ?? p.title ?? ""}>
        <Menu label={t("overflow_more")} items={[{ label: t("sort"), run: () => setSorting(true) }, ...settings]} />
      </Toolbar>
      {sorting && (
        <SortDialog options={[titleOption, dateOption, durationOption]} value={order} onChange={setOrder} onClose={() => setSorting(false)} />
      )}
      <div class="podcast-header">
        <Cover url={p.image_url} title={p.display_title ?? p.title ?? ""} size={112} />
        <div>
          <h2>{p.display_title ?? p.title}</h2>
          {meta?.author && <p class="secondary podcast-author">{meta.author}</p>}
          {p.state === "not_subscribed" && (
            <button class="filled-button" onClick={() => void track(sync.act(act.subscribe(feedURL(p), { observed: p })).then(() => {}))}>
              {t("subscribe_label")}
            </button>
          )}
          {creds.set && (
            <p class="secondary">
              {t("authentication_label")}: {"username" in creds && creds.username ? creds.username : "✓"}
            </p>
          )}
          {st && (
            <p class="secondary">
              {t("statistics_label")}: {durationLong(st.played_marked_ms)} · {plural("num_episodes", st.episodes)}
            </p>
          )}
        </div>
      </div>
      {meta?.description && <p class="podcast-description">{plainText(meta.description)}</p>}
      <EpisodeList
        key={id}
        items={list.items}
        select={{ total: list.total, all: list.all }}
        hasMore={list.hasMore}
        loadMore={list.loadMore}
        loading={list.loading}
        empty={<Empty icon="feed" title={t("no_all_episodes_head_label")} text={t("no_all_episodes_label")} />}
      />
      {authenticating && <AuthenticationDialog sync={sync} podcast={p} onClose={() => setAuthenticating(false)} />}
      {removing && <RemoveFeedDialog sync={sync} podcasts={[p]} onClose={() => setRemoving(false)} onUnsubscribed={() => navigate("/subscriptions")} />}
      {clearing && (
        <Confirm
          title={t("remove_all_inbox_label")}
          message={t("remove_all_inbox_confirmation_msg")}
          onCancel={() => setClearing(false)}
          onConfirm={async () => {
            await removeAllInbox(sync, [p]);
            setClearing(false);
          }}
        />
      )}
    </section>
  );
}

/** plainText is the text of markup, parsed in an inert document (nothing loads or runs). */
export function plainText(html: string): string {
  return new DOMParser().parseFromString(html, "text/html").body.textContent?.trim() ?? "";
}
