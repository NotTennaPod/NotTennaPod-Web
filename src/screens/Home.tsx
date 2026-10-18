// Home (Android's HomeFragment with its default sections): continue
// listening, see what's new, get surprised, check your classics. Each
// section links to its full screen, as Android's "more" buttons do.
import { useState } from "preact/hooks";
import { t } from "../i18n.ts";
import { reads, type EpisodeRow, type PodcastRow } from "../api/views.ts";
import { linkProps, pathOf, type Route } from "../app/router.ts";
import { useView } from "../app/useView.ts";
import { Cover } from "../ui/Cover.tsx";
import { EpisodeItem } from "../ui/EpisodeList.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton, Loading, Menu, RefreshBar, Toolbar, refreshItem } from "../ui/components.tsx";
import { useSync } from "../app/context.ts";
import { readSetting } from "../ui/settings.ts";

// Android keeps one seed per process; the browser keeps one per tab.
let seed = Math.floor(Math.random() * 2 ** 31) + 1;

function Section({ title, more, to, children }: { title: string; more: string; to: Route; children: preact.ComponentChildren }) {
  return (
    <section class="home-section">
      <div class="home-section-header">
        <h2>{title}</h2>
        <a class="text-button" {...linkProps(pathOf(to))}>
          {more}
        </a>
      </div>
      {children}
    </section>
  );
}

function EpisodeCard({ e }: { e: EpisodeRow }) {
  const progress = e.has_media && e.position > 0 && e.duration_ms ? (e.position / e.duration_ms) * 100 : 0;
  return (
    <li class="card">
      <a {...linkProps(pathOf({ name: "episode", id: e.episode_id }))}>
        <Cover url={e.image_url || e.podcast.image_url} title={e.podcast.display_title} size={128} />
        {progress > 0 && <progress max={100} value={progress} />}
        <span class="card-title">{e.title}</span>
      </a>
    </li>
  );
}

function PodcastCard({ p }: { p: PodcastRow }) {
  return (
    <li class="card">
      <a {...linkProps(pathOf({ name: "podcast", id: p.podcast_id }))} aria-label={p.display_title}>
        <Cover url={p.image_url} title={p.display_title} size={128} />
      </a>
    </li>
  );
}

export function Home() {
  const sync = useSync();
  const [shuffle, setShuffle] = useState(seed);
  const view = useView(
    (signal) =>
      reads.home(
        { seed: shuffle, inbox_sort: readSetting("inbox_sort", "date_new_old"), include_marked: readSetting("statistics_include_marked", "false") },
        signal,
      ),
    [shuffle],
  );
  const h = view.data;
  return (
    <section>
      <Toolbar title={t("home_label")}>
        <Menu label={t("overflow_more")} items={[refreshItem(sync)]} />
      </Toolbar>
      <RefreshBar />
      {!h ? (
        <Loading />
      ) : (
        <div class="home">
          <Section title={t("home_continue_title")} more={t("queue_label")} to={{ name: "queue" }}>
            {h.continue.length ? (
              <ul class="carousel">
                {h.continue.map((e) => (
                  <EpisodeCard key={e.episode_id} e={e} />
                ))}
              </ul>
            ) : (
              <p class="home-empty">{t("home_continue_empty_text")}</p>
            )}
          </Section>
          <Section title={t("home_new_title")} more={h.new_count > 0 ? `${t("inbox_label")} (${h.new_count})` : t("inbox_label")} to={{ name: "inbox" }}>
            {h.new.length ? (
              <ul class="episode-list">
                {h.new.map((e) => (
                  <EpisodeItem key={e.episode_id} e={e} where="inbox" />
                ))}
              </ul>
            ) : (
              <p class="home-empty">{t("home_new_empty_text")}</p>
            )}
          </Section>
          <Section title={t("home_surprise_title")} more={t("episodes_label")} to={{ name: "episodes" }}>
            <div class="carousel-row">
              {h.surprise.length ? (
                <ul class="carousel">
                  {h.surprise.map((e) => (
                    <EpisodeCard key={e.episode_id} e={e} />
                  ))}
                </ul>
              ) : (
                <p class="home-empty">{t("home_no_recent_unplayed_episodes_text")}</p>
              )}
              <IconButton
                icon="shuffle"
                label={t("home_surprise_title")}
                onClick={() => {
                  seed = Math.floor(Math.random() * 2 ** 31) + 1;
                  setShuffle(seed);
                }}
              />
            </div>
          </Section>
          <Section title={t("home_classics_title")} more={t("subscriptions_label")} to={{ name: "subscriptions" }}>
            {h.classics.length ? (
              <ul class="carousel">
                {h.classics.map((p) => (
                  <PodcastCard key={p.podcast_id} p={p} />
                ))}
              </ul>
            ) : (
              <p class="home-empty">
                <Icon name="subscriptions" /> {t("no_subscriptions_label")}
              </p>
            )}
          </Section>
        </div>
      )}
    </section>
  );
}
