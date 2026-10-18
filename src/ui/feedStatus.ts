// A podcast's last refresh, from its refresh_status record (PROTOCOL §9.6),
// in Android's words: a failed refresh is shown as Android shows a feed whose
// last update failed (the error icon on its tile and drawer row, the notice
// under its header), and its details as DownloadLogDetailsDialog shows them.
import { t, w, type StringKey } from "../i18n.ts";
import type { PodcastRow } from "../api/views.ts";
import { feedURL } from "../app/feedLogin.ts";

/** RefreshError is a refresh_status error: the server's label, an HTTP status, a sanitized detail. */
export interface RefreshError {
  label: string;
  code?: number;
  detail?: string;
}

/** failure is the podcast's last refresh error, or null when its last refresh worked or it has none yet. */
export function failure(p: Pick<PodcastRow, "records">): RefreshError | null {
  const status = p.records.refresh_status?.value as { error?: unknown } | undefined;
  const e = status?.error;
  if (!e || typeof e !== "object") return null;
  const { label, code, detail } = e as Record<string, unknown>;
  return {
    label: typeof label === "string" ? label : "",
    ...(typeof code === "number" ? { code } : {}),
    ...(typeof detail === "string" && detail ? { detail } : {}),
  };
}

/**
 * The server's refresh labels (PROTOCOL §9.3) as Android's DownloadErrorLabel
 * words the DownloadError each stands for; any other label is Android's
 * unknown error.
 */
const statusKeys: Record<string, StringKey> = {
  unauthorized: "download_error_unauthorized",
  forbidden: "download_error_forbidden",
  not_found: "download_error_not_found",
  http_status: "download_error_http_data_error",
  io: "download_error_io_error",
  too_many_redirects: "download_error_io_error",
  time_limit: "download_error_connection_error",
  refused_destination: "download_error_unknown_host",
  parser_exception: "download_error_parser_exception",
  unsupported_type: "download_error_unsupported_type",
  unsupported_type_html: "download_error_unsupported_type_html",
};

/**
 * statusText is the dialog's Status: Android's wording for the error. A host
 * that is not found is an I/O failure the server names in its fixed detail;
 * Android tells it apart (UnknownHostException, ERROR_UNKNOWN_HOST), as a
 * feed whose domain has lapsed shows.
 */
export function statusText(e: RefreshError): string {
  if (e.label === "io" && e.detail === "host not found") return t("download_error_unknown_host");
  return t(Object.hasOwn(statusKeys, e.label) ? statusKeys[e.label]! : "download_error_error_unknown");
}

/** technicalText is the dialog's Technical details: the server's detail, else the HTTP status (as Android's), else nothing. */
export function technicalText(e: RefreshError): string {
  return e.detail || (e.code !== undefined ? String(e.code) : "");
}

/** fileURL is the dialog's File URL: the address the podcast is refreshed from (Android's "unknown" without one). */
export function fileURL(p: Pick<PodcastRow, "records">): string {
  return feedURL(p as PodcastRow) || w("file_url_unknown");
}

/** clipboardText is what Copy to clipboard copies: Android's text, "null" standing for no technical details as there. */
export function clipboardText(e: RefreshError, url: string): string {
  return (
    `${t("download_log_details_human_readable_reason_title")}: \n${statusText(e)} \n\n` +
    `${t("download_log_details_technical_reason_title")}: \n${technicalText(e) || "null"} \n\n` +
    `${t("download_log_details_file_url_title")}: \n${url}`
  );
}

/** tileName is a podcast's name for screen readers where its error icon is shown without its own name. */
export function tileName(p: Pick<PodcastRow, "records" | "display_title">): string {
  return failure(p) ? `${p.display_title}, ${t("refresh_failed_msg")}` : p.display_title;
}
