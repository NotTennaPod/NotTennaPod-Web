// The app's frame: Android's navigation drawer as a permanent side bar (a
// drawer behind a menu button in narrow windows), the screens, one banner
// when the server is unreachable, and Android-style snackbars.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { t, w, type StringKey } from "../i18n.ts";
import type { Counters } from "../api/views.ts";
import { useSync } from "../app/context.ts";
import { linkProps, pathOf, type Route } from "../app/router.ts";
import { useValue } from "../app/useView.ts";
import { useDrawer } from "./drawer.ts";
import type { IconName } from "../generated/icons.ts";
import { Icon } from "./Icon.tsx";
import { Cover } from "./Cover.tsx";
import { PlayerBar } from "../player/Player.tsx";
import { changeVolume, playerOf } from "../player/instance.ts";
import { keyAction } from "../app/keys.ts";
import { reportFailuresTo, track, workingValue } from "./progress.ts";
import { failure } from "./feedStatus.ts";

interface NavItem {
  route: Route["name"];
  label: StringKey;
  icon: IconName;
  counter?: keyof Counters;
}

// nav_drawer_section_tags (Android 3.12.1), without Downloads (device-only).
export const navItems: NavItem[] = [
  { route: "home", label: "home_label", icon: "home" },
  { route: "queue", label: "queue_label", icon: "playlist_play", counter: "queue" },
  { route: "inbox", label: "inbox_label", icon: "inbox", counter: "inbox" },
  { route: "subscriptions", label: "subscriptions_label", icon: "subscriptions" },
  { route: "episodes", label: "episodes_label", icon: "feed" },
  { route: "history", label: "playback_history_label", icon: "history" },
  { route: "favorites", label: "favorite_episodes_label", icon: "star" },
  { route: "statistics", label: "statistics_label", icon: "chart_box" },
  { route: "add", label: "add_feed_label", icon: "add" },
];

export function Shell({ route, children }: { route: Route; children: ComponentChildren }) {
  const sync = useSync();
  const connection = useValue(sync.connection);
  const waiting = useValue(sync.waiting);
  const paused = useValue(sync.paused);
  const refused = useValue(sync.refused);
  const unsendable = useValue(sync.unsendable);
  const notices = useValue(sync.notices);
  const working = useValue(workingValue);
  useEffect(() => reportFailuresTo((text) => sync.notify(text)), [sync]);
  const [open, setOpen] = useState(false);
  const { counters, podcasts } = useDrawer(open);
  useEffect(() => setOpen(false), [route]);
  const screen = useRef(route.name);
  screen.current = route.name;
  useEffect(() => {
    let volumeNotice: number | undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      const action = keyAction(e, screen.current);
      if (!action) return;
      e.preventDefault();
      const player = playerOf(sync);
      switch (action) {
        case "toggle":
          void player?.toggle();
          break;
        case "rewind":
          void player?.rewind();
          break;
        case "fast_forward":
          void player?.fastForward();
          break;
        case "top":
          window.scrollTo({ top: 0 });
          break;
        case "bottom":
          window.scrollTo({ top: document.documentElement.scrollHeight });
          break;
        default: {
          const v = changeVolume(sync, action === "volume_up" ? "up" : action === "volume_down" ? "down" : "mute");
          if (v === null) break;
          if (volumeNotice !== undefined) sync.dismiss(volumeNotice);
          volumeNotice = sync.notify(v === 0 ? w("volume_muted") : w("volume_level", v));
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sync]);
  const unreachable = connection === "unreachable";
  return (
    <div class={`shell${open ? " drawer-open" : ""}`}>
      <button class="drawer-toggle icon-button" aria-label={open ? t("drawer_close") : t("drawer_open")} aria-expanded={open} onClick={() => setOpen(!open)}>
        <MenuIcon />
      </button>
      <nav class="drawer" aria-label={t("drawer_open")}>
        <ul class="nav-items">
          {navItems.map((item) => {
            const n = item.counter && counters ? counters[item.counter] : 0;
            const current = route.name === item.route;
            return (
              <li key={item.route}>
                <a class={`nav-item${current ? " current" : ""}`} aria-current={current ? "page" : undefined} {...linkProps(pathOf({ name: item.route } as Route))}>
                  <Icon name={item.icon} />
                  <span class="nav-label">{t(item.label)}</span>
                  {n > 0 && <span class="nav-count">{n}</span>}
                </a>
              </li>
            );
          })}
        </ul>
        <hr />
        <ul class="nav-subscriptions">
          {podcasts.map((p) => (
            <li key={p.podcast_id}>
              <a class="nav-item" {...linkProps(pathOf({ name: "podcast", id: p.podcast_id }))}>
                <Cover url={p.image_url} title={p.display_title} size={40} />
                <span class="nav-label">{p.display_title}</span>
                {/* Android's itxtvFailure: before the counter, named for screen readers. */}
                {failure(p) && <Icon name="error" label={t("refresh_failed_msg")} />}
                {p.counter ? <span class="nav-count">{p.counter}</span> : null}
              </a>
            </li>
          ))}
        </ul>
        <hr />
        <a class={`nav-item${route.name === "settings" ? " current" : ""}`} {...linkProps("/settings")}>
          <Icon name="settings" />
          <span class="nav-label">{t("settings_label")}</span>
        </a>
      </nav>
      <div class="content" inert={unreachable ? true : undefined}>
        {working > 0 && <progress class="working" aria-label={t("please_wait")} />}
        {unreachable && (
          <div class="banner" role="alert">
            {w("server_unreachable")}
          </div>
        )}
        {!unreachable && waiting && waiting.length > 0 && (
          <div class="banner" role="status">
            {w("waiting_for_restore")}
          </div>
        )}
        {!unreachable && refused && (
          <div class="banner" role="alert" dir="auto">
            {w("push_refused", refused)}
          </div>
        )}
        {paused && (
          <div class="banner" role="alert">
            {paused === "lineage_unknown" ? w("lineage_unknown") : w("pushes_paused_version")}
          </div>
        )}
        {unsendable && (
          <div class="banner" role="alert">
            {w("changes_too_large")}
          </div>
        )}
        {children}
      </div>
      <PlayerBar />
      <div class="snackbars" aria-live="polite">
        {notices.map((n) => (
          <div class="snackbar" key={n.id}>
            <span dir="auto">{n.text}</span>
            {n.action && (
              <button
                class="text-button"
                onClick={() => {
                  const run = n.action!.run;
                  void track(Promise.resolve().then(run));
                  sync.dismiss(n.id);
                }}
              >
                {n.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The toolbar's menu icon (AppCompat's, which Android's drawer toggle shows). */
function MenuIcon() {
  return (
    <svg class="icon" width={24} height={24} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3,18h18v-2H3v2zM3,13h18v-2H3v2zM3,6v2h18V6H3z" fill="currentColor" />
    </svg>
  );
}
