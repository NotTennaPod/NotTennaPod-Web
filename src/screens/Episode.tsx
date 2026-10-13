// An episode (Android's ItemFragment): cover, title, podcast, date and
// duration, its actions, and the show notes.
import { t } from "../i18n.ts";
import { reads } from "../api/views.ts";
import { useSync } from "../app/context.ts";
import { linkProps, pathOf } from "../app/router.ts";
import { useView } from "../app/useView.ts";
import { Cover } from "../ui/Cover.tsx";
import { Loading, Menu, Toolbar } from "../ui/components.tsx";
import { actionsFor } from "../ui/episodeActions.ts";
import { ItemScreenButtons } from "../ui/ItemButton.tsx";
import { durationLong, formatAbbrev } from "../ui/format.ts";
import { ShowNotes } from "../shownotes/ShowNotes.tsx";

export function Episode({ id }: { id: string }) {
  const sync = useSync();
  const view = useView((signal) => reads.episode(id, signal), [id]);
  const e = view.data?.episode;
  if (!e) return view.error ? <p class="error">{view.error}</p> : <Loading />;
  const description = (e.metadata as { description?: string | null } | undefined)?.description ?? "";
  return (
    // data-episode-id says which episode the screen shows (for test drivers; nothing a person sees).
    <section data-episode-id={e.episode_id}>
      <Toolbar title={t("episode_information")}>
        <Menu label={t("overflow_more")} items={actionsFor(sync, e).map((a) => ({ label: t(a.label), run: a.run }))} />
      </Toolbar>
      <div class="episode-header">
        <Cover url={e.image_url || e.podcast.image_url} title={e.podcast.display_title} size={112} />
        <div>
          <a class="secondary" {...linkProps(pathOf({ name: "podcast", id: e.podcast_id }))}>
            {e.podcast.display_title}
          </a>
          <h2>{e.title}</h2>
          <p class="secondary">
            {formatAbbrev(e.pub_date)}
            {e.has_media && (e.duration_ms ?? 0) > 0 && ` · ${durationLong(e.duration_ms)}`}
          </p>
          <ItemScreenButtons e={e} />
        </div>
      </div>
      <h3>{t("shownotes_label")}</h3>
      <ShowNotes
        html={description}
        durationMs={e.has_media ? (e.duration_ms ?? 0) : undefined}
        onSeek={() => sync.notify(t("play_this_to_seek_position_message"))}
      />
    </section>
  );
}
