// Android's DownloadLogDetailsDialog for a podcast's failed refresh, as the
// podcast's "Last refresh failed" notice opens it (isJumpToFeed false): the
// podcast, the status in Android's words, the technical details and the
// feed's address; OK, and Copy to clipboard. Tapping the technical details or
// the address copies that alone, as there.
import { useEffect, useRef, useState } from "preact/hooks";
import { t, w } from "../i18n.ts";
import type { PodcastRow } from "../api/views.ts";
import { useSync } from "../app/context.ts";
import { clipboardText, fileURL, statusText, technicalText, type RefreshError } from "./feedStatus.ts";

export function FeedErrorDialog({ podcast, error, onClose }: { podcast: PodcastRow; error: RefreshError; onClose: () => void }) {
  const sync = useSync();
  const ref = useRef<HTMLDialogElement>(null);
  // A copy under way keeps the dialog open: its fallback selects text inside it.
  const copying = useRef(false);
  const [copyFailed, setCopyFailed] = useState(false);
  // Open while shown; closing is the caller's (onClose), which removes it.
  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
  });
  const url = fileURL(podcast);
  const technical = technicalText(error);
  /** copy copies text; it says "Copied to clipboard" only when it did, and says so when it could not. */
  const copy = async (text: string, from: HTMLElement): Promise<boolean> => {
    const dialog = ref.current;
    if (!dialog || copying.current) return false;
    copying.current = true;
    setCopyFailed(false);
    try {
      const copied = await copyText(text, dialog, from);
      if (copied) sync.notify(t("copied_to_clipboard"));
      else setCopyFailed(true);
      return copied;
    } finally {
      copying.current = false;
    }
  };
  // Closed at once, so the page behind is no longer inert when the caller returns the focus there.
  const close = () => {
    if (copying.current) return;
    ref.current?.close();
    onClose();
  };
  return (
    <dialog ref={ref} class="dialog" aria-labelledby="feed-error-title" onCancel={(e) => (e.preventDefault(), close())}>
      <h2 id="feed-error-title">{t("download_error_details")}</h2>
      <dl class="details-list">
        <dt>{t("feed")}</dt>
        <dd class="details-single-line">
          <bdi>{podcast.display_title}</bdi>
        </dd>
        <dt>{t("download_log_details_human_readable_reason_title")}</dt>
        <dd>{statusText(error)}</dd>
        <dt>{t("download_log_details_technical_reason_title")}</dt>
        <dd>
          {technical && (
            <button type="button" class="details-copy" onClick={(e) => void copy(technical, e.currentTarget)}>
              <bdi>{technical}</bdi>
            </button>
          )}
        </dd>
        <dt>{t("download_log_details_file_url_title")}</dt>
        <dd>
          <button type="button" class="details-copy" onClick={(e) => void copy(url, e.currentTarget)}>
            <bdi>{url}</bdi>
          </button>
        </dd>
      </dl>
      {copyFailed && (
        <p class="dialog-error" role="alert">
          {w("copy_failed")}
        </p>
      )}
      <div class="dialog-buttons">
        <button
          type="button"
          class="text-button dialog-neutral"
          onClick={(e) => {
            // Closed once the copy is over (Android closes it); kept open, with its values, when it failed.
            void copy(clipboardText(error, url), e.currentTarget).then((copied) => copied && close());
          }}
        >
          {t("copy_to_clipboard")}
        </button>
        <button type="button" class="text-button" autofocus onClick={close}>
          {t("ok")}
        </button>
      </div>
    </dialog>
  );
}

/**
 * copyText puts text on the clipboard. Where the browser offers no clipboard
 * API (a plain-HTTP origin) or refuses it, it copies a selection instead,
 * made inside the open dialog (the page behind a modal dialog cannot be
 * selected), and gives the keyboard back to the control that asked. It is
 * true only when the text was copied.
 */
async function copyText(text: string, dialog: HTMLDialogElement, from: HTMLElement): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* refused: copy a selection */
    }
  }
  if (!dialog.isConnected || !dialog.open) return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.className = "visually-hidden";
  dialog.append(area);
  // The copy carries the text exactly (a browser's own copy of a selection can drop spaces at line ends).
  let carried = false;
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
    carried = true;
  };
  document.addEventListener("copy", onCopy);
  try {
    area.focus({ preventScroll: true });
    area.select();
    // Only the whole text, selected in the field, is a copy of it.
    const selected = document.activeElement === area && area.selectionStart === 0 && area.selectionEnd === text.length;
    return selected && document.execCommand("copy") && carried;
  } catch {
    return false;
  } finally {
    document.removeEventListener("copy", onCopy);
    area.remove();
    if (from.isConnected && dialog.contains(from)) from.focus({ preventScroll: true });
  }
}
