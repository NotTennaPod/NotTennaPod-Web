// What the import's states say (PROTOCOL §11.5): its progress line and its
// notices, in the browser's wording (src/webStrings.ts).
import { t, w, type StringKey } from "../i18n.ts";
import type { JobState, Notice, RefreshProgress } from "../app/importMachine.ts";
import { bytes } from "./format.ts";

/** Line is a progress line: its text, and its bar (value of max; none: not known). */
export interface Line {
  text: string;
  value?: number;
  max?: number;
  bar?: boolean;
}

/** sent is the size sent so far: nothing is 0 KB. */
function sent(n: number): string {
  return n > 0 ? bytes(n) : "0 KB";
}

function refreshLine(r: RefreshProgress | undefined): Line | undefined {
  if (!r) return undefined;
  const total = r.total ?? 0;
  switch (r.status) {
    case "running":
      return { text: w("import_refreshing_count", String(r.attempted ?? 0), String(total)), value: r.attempted ?? 0, max: total, bar: true };
    case "done":
      return (r.failed ?? 0) > 0 ? { text: w("import_refreshed_failed", String(r.succeeded ?? 0), String(total), String(r.failed)) } : undefined;
    case "expired":
      return { text: w("import_refresh_expired", String(r.succeeded ?? 0), String(total)) };
    case "unavailable":
      return { text: w("import_refresh_unavailable") };
  }
}

/** progressLine is what a state says about the import's progress. */
export function progressLine(s: JobState): Line | undefined {
  switch (s.k) {
    case "hashing":
      return { text: w("import_reading", `${Math.floor((100 * s.read) / Math.max(1, s.file.size))}%`), value: s.read, max: s.file.size, bar: true };
    case "reserving":
      return { text: w("import_sending", sent(0), bytes(s.file.size)), value: 0, max: s.file.size, bar: true };
    case "uploading":
      return { text: w("import_sending", sent(s.sent), bytes(s.im.size)), value: s.sent, max: s.im.size, bar: true };
    case "finishing":
      return { text: w("import_checking"), bar: true };
    case "processing":
      // Not known (waiting, or the server restarted) is shown without numbers, never as zero.
      return s.phase?.phase === "importing"
        ? { text: w("import_importing", String(s.phase.done), String(s.phase.total)), value: s.phase.done, max: s.phase.total, bar: true }
        : { text: w("import_uploading"), bar: true };
    case "published":
      return refreshLine(s.refresh);
    case "interrupted":
      return { text: w("import_interrupted", s.im.file_name) };
    case "mismatch":
      return { text: s.why === "layout" ? w("import_layout") : w("import_damaged") };
    case "gone":
      return { text: w("import_gone") };
    default:
      return undefined;
  }
}

export function noticeText(n: Notice): string {
  switch (n.n) {
    case "wrong_file":
      return w("import_wrong_file", n.expected);
    case "cancelled":
      return w("import_cancelled");
    case "other_import":
      return w("import_other", n.file);
    case "error":
      return `${t("import_error_label")}: ${n.message === "too_large" ? w("import_too_large") : n.message}`;
  }
}

/** NotCarried is what an AntennaPod backup held that stays on each device (PROTOCOL §11.5 `not_carried`). */
export interface NotCarried {
  podcasts: { title: string; url?: string; source_feed_id: number; settings: string[] }[];
  episode_auto_download_off: number;
}

// Each setting by Android's name for it (its podcast settings screen, and the podcast screen's Filter and Sort).
const settingNames: Record<string, StringKey> = {
  tags: "feed_tags_label",
  playback_speed: "playback_speed",
  skip_silence: "pref_skip_silence_title",
  skip_intro: "pref_feed_skip_intro",
  skip_ending: "pref_feed_skip_ending",
  volume_adaptation: "feed_volume_adapdation",
  episode_notification: "episode_notification",
  auto_delete: "pref_auto_delete_playback_title",
  auto_download: "auto_download_label",
  auto_download_filter: "episode_filters_label",
  episode_list_filter: "filter",
  sort_order: "sort",
};

/** settingName is a podcast setting the server names, in Android's words; one this version doesn't know reads as its name. */
export function settingName(key: string): string {
  if (key === "custom_title") return w("import_setting_custom_title");
  const s = settingNames[key];
  return s ? t(s) : key.replace(/_/g, " ");
}

/**
 * notCarriedText is what the report says is not carried: each podcast with its settings (and its feed's
 * address when another listed podcast has the same title), and the episodes line (none when nothing).
 */
export function notCarriedText(
  nc: NotCarried | null | undefined,
): { podcasts: { title: string; address?: string; settings: string }[]; episodes?: string } | undefined {
  if (!nc) return undefined;
  const titles = new Map<string, number>();
  for (const p of nc.podcasts) titles.set(p.title, (titles.get(p.title) ?? 0) + 1);
  const podcasts = nc.podcasts.map((p) => ({
    title: p.title,
    ...((titles.get(p.title) ?? 0) > 1 && p.url ? { address: p.url } : {}),
    settings: p.settings.map(settingName).join(", "),
  }));
  const episodes = nc.episode_auto_download_off > 0 ? w("import_not_carried_auto_download", String(nc.episode_auto_download_off)) : undefined;
  if (!podcasts.length && !episodes) return undefined;
  return { podcasts, episodes };
}
