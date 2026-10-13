// The player in Android's look: the bar at the bottom of every screen
// (ExternalPlayerFragment: cover, title, podcast, play/pause, a thin progress
// line) that opens the player screen (AudioPlayerFragment: cover, title,
// podcast, show notes, the position bar with elapsed time and duration or
// remaining time, then speed, rewind, play/pause, fast-forward and skip),
// and the speed dialog (VariableSpeedDialog). As on Android, the position bar
// and the buttons stay left to right in right-to-left languages.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { t, w, plural } from "../i18n.ts";
import { useSync } from "../app/context.ts";
import { linkProps, navigate, pathOf } from "../app/router.ts";
import { Cover } from "../ui/Cover.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Menu } from "../ui/components.tsx";
import { durationLong } from "../ui/format.ts";
import { useLocalSetting } from "../ui/settings.ts";
import type { IconName } from "../generated/icons.ts";
import { ShowNotes } from "../shownotes/ShowNotes.tsx";
import { externalLink } from "../shownotes/sanitize.ts";
import { defaultSpeeds, formatSpeed, maxSpeed, minSpeed, rewindMs, fastForwardMs, speedStep } from "./accounting.ts";
import type { Chapter, Player, PlayerState } from "./engine.ts";
import { usePlayer } from "./instance.ts";
import "./player.css";

/** localized is Converter.getDurationStringLocalized, for screen readers. */
function localized(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(plural("time_hours_quantified", h));
  if (m > 0) parts.push(plural("time_minutes_quantified", m));
  if (sec > 0 || parts.length === 0) parts.push(plural("time_seconds_quantified", sec));
  return parts.join(" ");
}

function PlayButton({ s, player, big }: { s: PlayerState; player: Player; big?: boolean }) {
  const label = s.playing ? t("pause_label") : t("play_label");
  return (
    <button
      class={`icon-button play-button${big ? " big" : ""}${s.busy ? " busy" : ""}`}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        void player.toggle();
      }}
    >
      <Icon name={s.playing ? "pause" : "play_48dp"} size={big ? 64 : 36} />
    </button>
  );
}

function ControlButton({ icon, label, caption, onClick }: { icon: IconName; label: string; caption?: string; onClick: () => void }) {
  return (
    <button class="icon-button control-button" aria-label={label} title={label} onClick={onClick}>
      <Icon name={icon} size={36} />
      {caption !== undefined && (
        <span class="control-caption" aria-hidden="true">
          {caption}
        </span>
      )}
    </button>
  );
}

/**
 * BarPosition is the position bar in a wide window's player bar: the
 * player screen's slider, elapsed time and length, so a desktop window seeks
 * without opening the player.
 */
function BarPosition({ s, player }: { s: PlayerState; player: Player }) {
  const [drag, setDrag] = useState<number | null>(null);
  const position = drag ?? s.position;
  return (
    <span class="player-bar-wide player-bar-position" dir="ltr">
      <span class="player-elapsed">{durationLong(position)}</span>
      <input
        type="range"
        min={0}
        max={Math.max(s.duration, 1)}
        step={1000}
        value={position}
        disabled={!(s.duration > 0)}
        aria-label={w("position_bar")}
        aria-valuetext={w("position", localized(position))}
        onInput={(ev) => setDrag(Number((ev.target as HTMLInputElement).value))}
        onChange={(ev) => {
          const v = Number((ev.target as HTMLInputElement).value);
          setDrag(null);
          void player.seek(v);
        }}
      />
      <span class="player-length">{durationLong(s.duration)}</span>
    </span>
  );
}

/** PlayerBar is mounted under the content of every screen; a wide window adds the player's controls (the web client's layout). */
export function PlayerBar() {
  const sync = useSync();
  const [player, s] = usePlayer(sync);
  const [open, setOpen] = useState(false);
  const [speed, setSpeed] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (s?.mode !== "here") setOpen(false);
  }, [s?.mode]);
  if (!player || !s || s.mode === "none" || !s.episode) return null;
  const e = s.episode;
  const progress = s.duration > 0 ? Math.min(1, s.position / s.duration) : 0;
  const here = s.mode === "here";
  // Another tab that holds the player while paused just looks paused; its Play moves playback here.
  const elsewhere = !here && s.playing;
  return (
    <>
      <div class="player-bar" role="region" aria-label={t("playback_control")}>
        <button
          ref={opener}
          class="player-bar-open"
          aria-haspopup="dialog"
          disabled={!here}
          onClick={() => setOpen(true)}
        >
          <Cover url={e.image} title={e.podcast} size={64} />
          <span class="player-bar-text">
            <span class="player-bar-title">{e.title}</span>
            <span class={`player-bar-subtitle${s.error && here ? " error" : ""}`}>
              {elsewhere ? w("playing_elsewhere") : here ? (s.error ?? e.podcast) : e.podcast}
            </span>
          </span>
        </button>
        {here && (
          <span class="player-bar-wide">
            <ControlButton icon="fast_rewind" label={t("rewind_label")} caption={String(rewindMs / 1000)} onClick={() => void player.rewind()} />
          </span>
        )}
        {!elsewhere ? (
          <PlayButton s={s} player={player} />
        ) : (
          <button class="text-button" onClick={() => void player.moveHere()}>
            {w("play_here")}
          </button>
        )}
        {here && (
          <>
            <span class="player-bar-wide">
              <ControlButton icon="fast_forward" label={t("fast_forward_label")} caption={String(fastForwardMs / 1000)} onClick={() => void player.fastForward()} />
              <ControlButton icon="skip_48dp" label={t("skip_episode_label")} onClick={() => void player.skip()} />
            </span>
            <BarPosition s={s} player={player} />
            <span class="player-bar-wide">
              <ControlButton icon="playback_speed" label={t("playback_speed")} caption={formatSpeed(s.rate)} onClick={() => setSpeed(true)} />
            </span>
          </>
        )}
        <span class="player-bar-progress" aria-hidden="true">
          <span style={{ width: `${progress * 100}%` }} />
        </span>
      </div>
      {speed && here && <SpeedDialog player={player} rate={s.rate} onClose={() => setSpeed(false)} />}
      {open && here && (
        <PlayerScreen
          player={player}
          s={s}
          onClose={() => {
            setOpen(false);
            opener.current?.focus();
          }}
        />
      )}
    </>
  );
}

function PlayerScreen({ player, s, onClose }: { player: Player; s: PlayerState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [remaining, setRemaining] = useLocalSetting("show_remaining_time", "false");
  const [speed, setSpeed] = useState(false);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(".player-close")?.focus();
  }, []);
  const e = s.episode!;
  const position = drag ?? s.position;
  const chapters = e.chapters ?? [];
  const shown = shownChapter(chapters, position, s.duration);
  const left = Math.max(0, s.duration - position);
  const showLeft = remaining === "true";
  // On the document: Safari does not focus a button on click, so focus may be outside the player.
  // Before the browser paints, so Escape works as soon as the player is visible.
  useLayoutEffect(() => {
    if (speed || chaptersOpen) return;
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  const onKey = (ev: KeyboardEvent) => {
    if (ev.defaultPrevented) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      onClose();
    }
    if (ev.key === "Tab") {
      // Keep the keyboard inside the player while it covers the screen.
      const all = [...(ref.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), a[href]") ?? [])];
      const first = all[0];
      const last = all[all.length - 1];
      const inside = ref.current?.contains(document.activeElement);
      if (!inside || (ev.shiftKey && document.activeElement === first)) {
        ev.preventDefault();
        (ev.shiftKey ? last : first)?.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first?.focus();
      }
    }
  };
  return (
    <div class="player-screen" role="dialog" aria-modal="true" aria-label={e.title} ref={ref}>
      <header class="player-toolbar">
        <button class="icon-button player-close" aria-label={t("toolbar_back_button_content_description")} title={t("toolbar_back_button_content_description")} onClick={onClose}>
          <Icon name="arrow_down" />
        </button>
        <span class="player-toolbar-space" />
        {e.podcast_id && (
          <Menu
            label={t("overflow_more")}
            items={[
              {
                label: t("open_podcast"),
                run: () => {
                  onClose();
                  navigate(pathOf({ name: "podcast", id: e.podcast_id }));
                },
              },
            ]}
          />
        )}
      </header>
      <div class="player-content">
        <div class="player-cover">
          <Cover url={shown > -1 && chapters[shown]!.image?.startsWith("https://") ? chapters[shown]!.image! : e.image} title={e.podcast} size={320} />
          <div class="player-titles">
            <h2 class="player-title" dir="auto">
              {e.title}
            </h2>
            {e.podcast_id ? (
              <a
                class="player-podcast"
                dir="auto"
                {...linkProps(pathOf({ name: "podcast", id: e.podcast_id }))}
                onClick={(ev: MouseEvent) => {
                  if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
                  ev.preventDefault();
                  onClose();
                  navigate(pathOf({ name: "podcast", id: e.podcast_id }));
                }}
              >
                {e.podcast}
              </a>
            ) : (
              <span class="player-podcast">{e.podcast}</span>
            )}
          </div>
          {chapters.length > 0 && (
            <ChapterControl chapters={chapters} shown={shown} s={s} player={player} onOpen={() => setChaptersOpen(true)} />
          )}
          {s.error && (
            <p class="error" role="alert">
              {s.error}
            </p>
          )}
        </div>
        {chaptersOpen && <ChaptersDialog chapters={chapters} s={s} player={player} onClose={() => setChaptersOpen(false)} />}
        <div class="player-notes">
          <ShowNotes html={e.description} durationMs={s.duration} onSeek={(ms) => void player.seek(ms)} />
        </div>
      </div>
      <div class="player-controls" dir="ltr">
        <input
          type="range"
          class="player-position"
          min={0}
          max={Math.max(s.duration, 1)}
          step={1000}
          value={position}
          disabled={!(s.duration > 0)}
          aria-label={w("position_bar")}
          aria-valuetext={w("position", localized(position))}
          onInput={(ev) => setDrag(Number((ev.target as HTMLInputElement).value))}
          onChange={(ev) => {
            const v = Number((ev.target as HTMLInputElement).value);
            setDrag(null);
            void player.seek(v);
          }}
        />
        <div class="player-times">
          <span class="player-elapsed" aria-label={w("position", localized(position))}>
            {durationLong(position)}
          </span>
          <button
            class="player-length"
            aria-label={showLeft ? t("remaining_time", localized(left)) : t("chapter_duration", localized(s.duration))}
            onClick={() => setRemaining(showLeft ? "false" : "true")}
          >
            {showLeft ? `${left > 0 ? "-" : ""}${durationLong(left)}` : durationLong(s.duration)}
          </button>
        </div>
        <div class="player-buttons">
          <ControlButton icon="playback_speed" label={t("playback_speed")} caption={formatSpeed(s.rate)} onClick={() => setSpeed(true)} />
          <ControlButton icon="fast_rewind" label={t("rewind_label")} caption={String(rewindMs / 1000)} onClick={() => void player.rewind()} />
          <PlayButton s={s} player={player} big />
          <ControlButton icon="fast_forward" label={t("fast_forward_label")} caption={String(fastForwardMs / 1000)} onClick={() => void player.fastForward()} />
          <ControlButton icon="skip_48dp" label={t("skip_episode_label")} onClick={() => void player.skip()} />
        </div>
      </div>
      {speed && <SpeedDialog player={player} rate={s.rate} onClose={() => setSpeed(false)} />}
    </div>
  );
}

/** SpeedDialog is VariableSpeedDialog: the speed bar with − and +, and the presets. Skip silence needs audio processing the browser's player lacks. */
/** afterPosition is Chapter.getAfterPosition: the chapter playing at a position, or −1 before the first. */
/** chapterLink is a chapter's link when it may open outside the app. */
function chapterLink(link: string | null): string | null {
  return link ? externalLink(link, location.origin) : null;
}

function afterPosition(chapters: Chapter[], position: number): number {
  const i = chapters.findIndex((c) => c.start > position);
  return i === -1 ? chapters.length - 1 : i - 1;
}

/** shownChapter is CoverFragment's displayed chapter: past the end, or at the last, it is the last. */
function shownChapter(chapters: Chapter[], position: number, duration: number): number {
  const i = afterPosition(chapters, position);
  if (i < 0) return -1;
  return (duration > 0 && position > duration) || i >= chapters.length - 1 ? chapters.length - 1 : i;
}

/** ChapterControl is CoverFragment's chapter button: previous, Chapters (the list), next. */
function ChapterControl({ chapters, shown, s, player, onOpen }: { chapters: Chapter[]; shown: number; s: PlayerState; player: Player; onOpen: () => void }) {
  const prev = () => {
    if (shown === -1) return;
    if (shown < 1) void player.seek(0);
    else if (s.position - 10_000 * s.rate < chapters[shown]!.start) void player.seek(chapters[shown - 1]!.start);
    else void player.seek(chapters[shown]!.start);
  };
  const next = () => {
    if (shown === -1 || shown + 1 >= chapters.length) return;
    void player.seek(chapters[shown + 1]!.start);
  };
  const last = shown === chapters.length - 1;
  return (
    <div class="chapter-control" dir="ltr">
      <button class="icon-button" aria-label={t("prev_chapter")} title={t("prev_chapter")} onClick={prev}>
        <Icon name="chapter_prev" />
      </button>
      <button class="chapter-label" onClick={onOpen}>
        {t("chapters_label")}
      </button>
      <button
        class="icon-button"
        aria-label={t("next_chapter")}
        title={t("next_chapter")}
        onClick={next}
        style={last ? { visibility: "hidden" } : undefined}
      >
        <Icon name="chapter_next" />
      </button>
    </div>
  );
}

/** ChaptersDialog is ChaptersFragment: each chapter's title, start, duration and link; the current one marked. */
function ChaptersDialog({ chapters, s, player, onClose }: { chapters: Chapter[]; s: PlayerState; player: Player; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const current = afterPosition(chapters, s.position);
  useEffect(() => {
    ref.current?.showModal();
    ref.current?.querySelector(".chapter.current")?.scrollIntoView({ block: "nearest" });
  }, []);
  const play = async (c: Chapter) => {
    await player.seek(c.start);
    if (!s.playing) await player.play();
  };
  return (
    <dialog ref={ref} class="dialog chapters-dialog" aria-labelledby="chapters-title" onCancel={onClose} onClose={onClose}>
      <h2 id="chapters-title">{t("chapters_label")}</h2>
      <ul class="chapter-list">
        {chapters.map((c, i) => {
          const end = i + 1 < chapters.length ? chapters[i + 1]!.start : s.duration;
          const length = Math.max(0, end - c.start);
          const progress = i === current && length > 0 ? Math.min(100, Math.max(0, ((s.position - c.start) / length) * 100)) : 0;
          return (
            <li key={i} class={`chapter${i === current ? " current" : ""}`}>
              {c.image?.startsWith("https://") && <img class="chapter-image" src={c.image} alt="" loading="lazy" referrerpolicy="no-referrer" />}
              <div class="chapter-text">
                <span class="chapter-title" dir="auto">
                  {c.title}
                </span>
                <span class="secondary">
                  {durationLong(c.start)} · {t("chapter_duration").replace("%@", localized(length))}
                </span>
                {chapterLink(c.link) && (
                  <a class="chapter-link" href={chapterLink(c.link)!} target="_blank" rel="noopener noreferrer" dir="auto">
                    {c.link}
                  </a>
                )}
              </div>
              <button
                class="icon-button chapter-play"
                aria-label={t("play_chapter")}
                title={t("play_chapter")}
                style={progress > 0 ? { "--chapter-progress": `${progress}%` } : undefined}
                onClick={() => void play(c)}
              >
                <Icon name={i === current ? "replay" : "play_48dp"} />
              </button>
            </li>
          );
        })}
      </ul>
      <div class="dialog-buttons">
        <button class="text-button" onClick={onClose}>
          {t("close_label")}
        </button>
      </div>
    </dialog>
  );
}

function SpeedDialog({ player, rate, onClose }: { player: Player; rate: number; onClose: () => void }) {
  const sync = useSync();
  const ref = useRef<HTMLDialogElement>(null);
  const [, setSaved] = useLocalSetting("playback_speed", "1");
  const [presetsText, setPresets] = useLocalSetting("playback_speed_array", JSON.stringify(defaultSpeeds));
  let presets: number[];
  try {
    presets = (JSON.parse(presetsText) as unknown[]).map(Number).filter((n) => n >= minSpeed && n <= maxSpeed);
  } catch {
    presets = defaultSpeeds;
  }
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const set = (r: number) => {
    const v = Math.round(r * 100) / 100;
    player.setRate(v);
    setSaved(String(v));
  };
  const addCurrent = () => {
    if (presets.includes(rate)) {
      sync.notify(t("preset_already_exists").replace("%1$.2f", formatSpeed(rate)));
      return;
    }
    setPresets(JSON.stringify([...presets, rate].sort((a, b) => a - b)));
  };
  return (
    <dialog
      ref={ref}
      class="dialog speed-dialog"
      aria-labelledby="speed-title"
      onCancel={onClose}
      onClick={(ev) => {
        // A bottom sheet closes when the scrim is touched.
        if (ev.target === ref.current) onClose();
      }}
    >
      <div class="speed-header">
        <h2 id="speed-title">{t("playback_speed")}</h2>
        <button class="chip" aria-label={`${t("add_preset")} ${formatSpeed(rate)}`} onClick={addCurrent}>
          {formatSpeed(rate)}
          <Icon name="add" size={18} />
        </button>
      </div>
      <div class="speed-bar" dir="ltr">
        <button class="icon-button" aria-label={t("decrease_speed")} title={t("decrease_speed")} onClick={() => set(speedStep(rate, -1))}>
          <Icon name="minus" />
        </button>
        <input
          type="range"
          min={minSpeed}
          max={maxSpeed}
          step={0.05}
          value={rate}
          aria-label={t("playback_speed")}
          aria-valuetext={formatSpeed(rate)}
          onInput={(ev) => set(Number((ev.target as HTMLInputElement).value))}
        />
        <button class="icon-button" aria-label={t("increase_speed")} title={t("increase_speed")} onClick={() => set(speedStep(rate, 1))}>
          <Icon name="add" />
        </button>
      </div>
      <h3 class="speed-presets-title">{t("speed_presets")}</h3>
      <div class="speed-presets">
        {presets.map((p) => (
          <button
            key={p}
            class={`chip${p === rate ? " selected" : ""}`}
            aria-pressed={p === rate}
            onClick={() => {
              set(p);
              setTimeout(onClose, 200);
            }}
            aria-keyshortcuts="Delete"
            onContextMenu={(ev) => {
              // Android removes a preset with a long press: a right-click here.
              ev.preventDefault();
              setPresets(JSON.stringify(presets.filter((x) => x !== p)));
            }}
            onKeyDown={(ev) => {
              // The keyboard's way to the same: Delete (or Backspace) on a preset.
              if (ev.key !== "Delete" && ev.key !== "Backspace") return;
              ev.preventDefault();
              setPresets(JSON.stringify(presets.filter((x) => x !== p)));
            }}
          >
            {formatSpeed(p)}
          </button>
        ))}
      </div>
    </dialog>
  );
}
