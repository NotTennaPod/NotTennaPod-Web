import { useMemo } from "preact/hooks";
import type { TargetedMouseEvent } from "preact";
import { t } from "../i18n.ts";
import { sanitize } from "./sanitize.ts";

export interface ShowNotesProps {
  /** html is the episode's description as the feed has it. */
  html: string | null | undefined;
  /** origin is the app's origin; it defaults to the page's. */
  origin?: string;
  /** durationMs is the media's duration, 0 when unknown; omit it for an episode without media. */
  durationMs?: number;
  /** onSeek is called with a timecode's position in milliseconds. */
  onSeek: (ms: number) => void;
}

/**
 * ShowNotes shows an episode's notes as Android's show notes view does:
 * sanitized, in the text's own direction, with timecodes that seek, and
 * "This episode has no shownotes." when there are none.
 */
export function ShowNotes({ html, origin, durationMs, onSeek }: ShowNotesProps) {
  const appOrigin = origin ?? location.origin;
  const clean = useMemo(() => {
    if (!html) return null;
    try {
      return sanitize(html, { origin: appOrigin, durationMs });
    } catch (err) {
      console.error(err);
      return "";
    }
  }, [html, appOrigin, durationMs]);

  if (clean === null) {
    return (
      <div class="shownotes shownotes-empty" dir="auto">
        <p>{t("no_shownotes_label")}</p>
      </div>
    );
  }

  const onClick = (e: TargetedMouseEvent<HTMLDivElement>) => {
    const target = e.target as Element | null;
    const button = target?.closest?.("button[data-timecode]");
    if (!button || !e.currentTarget.contains(button)) return;
    e.preventDefault();
    onSeek(Number(button.getAttribute("data-timecode")));
  };
  return <div class="shownotes" dir="auto" onClick={onClick} dangerouslySetInnerHTML={{ __html: clean }} />;
}
