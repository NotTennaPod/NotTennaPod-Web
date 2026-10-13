// Android's item action buttons (ItemActionButton.forItem for list rows,
// ItemFragment's two buttons for the episode screen). A browser keeps no
// downloads, so media plays by streaming (Android with "Prefer streaming")
// and the screen has no Download button.
import { t, type StringKey } from "../i18n.ts";
import type { EpisodeRow } from "../api/views.ts";
import { useSync } from "../app/context.ts";
import type { IconName } from "../generated/icons.ts";
import { usePlayer } from "../player/instance.ts";
import { externalLink } from "../shownotes/sanitize.ts";
import { Icon } from "./Icon.tsx";
import { markPlayedNow, play } from "./episodeActions.ts";
import { track } from "./progress.ts";

interface ItemAction {
  label: StringKey;
  icon: IconName;
  visible: boolean;
  run: () => Promise<void>;
}

/** usePrimaryAction is ItemActionButton.forItem without downloads: Pause, Stream, or Mark as played. */
function usePrimaryAction(e: EpisodeRow): ItemAction {
  const sync = useSync();
  const [, state] = usePlayer(sync);
  if (!e.has_media) {
    return { label: "mark_read_no_media_label", icon: "check", visible: e.play_state !== "played", run: () => markPlayedNow(sync, e) };
  }
  const playing = !!state && state.mode === "here" && state.playing && state.episode?.episode_id === e.episode_id;
  return { label: playing ? "pause_label" : "stream_label", icon: playing ? "pause" : "stream", visible: true, run: () => play(sync, e) };
}

/** ItemButton is a list row's secondary action button. */
export function ItemButton({ e }: { e: EpisodeRow }) {
  const a = usePrimaryAction(e);
  return (
    <button
      class="icon-button item-button"
      aria-label={t(a.label)}
      title={t(a.label)}
      style={a.visible ? undefined : { visibility: "hidden" }}
      onClick={() => void track(a.run())}
    >
      <Icon name={a.icon} />
    </button>
  );
}

/** ItemScreenButtons are ItemFragment's buttons: the primary action and, without media, Visit website. */
export function ItemScreenButtons({ e }: { e: EpisodeRow }) {
  const a = usePrimaryAction(e);
  const site = !e.has_media && e.link ? externalLink(e.link, location.origin) : null;
  return (
    <div class="episode-buttons">
      {a.visible && (
        <button class="item-action" onClick={() => void track(a.run())}>
          <Icon name={a.icon} />
          <span>{t(a.label)}</span>
        </button>
      )}
      {site && (
        <a class="item-action" href={site} target="_blank" rel="noopener noreferrer">
          <Icon name="web" />
          <span>{t("visit_website_label")}</span>
        </a>
      )}
    </div>
  );
}
