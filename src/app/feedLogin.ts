// A podcast's login (Android's feed settings, Authentication): where the
// podcast is refreshed from, and the origin a new login is approved for.
import { t, w, type StringKey } from "../i18n.ts";
import { ApiError } from "../api/http.ts";
import { reads, type PodcastRow, type Preview } from "../api/views.ts";

/** feedURL is the address the podcast is refreshed from. */
export function feedURL(p: PodcastRow): string {
  const identity = p.records.identity?.value as { refresh_url?: string; aliases?: { url: string }[] } | undefined;
  return identity?.refresh_url || identity?.aliases?.[0]?.url || "";
}

/** originOf is an address's origin as the server writes approved origins: scheme://host:port, the port explicit. */
export function originOf(address: string): string | null {
  try {
    const u = new URL(address);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return `${u.protocol}//${u.hostname.replace(/^\[|\]$/g, "").toLowerCase()}:${port}`;
  } catch {
    return null;
  }
}

/** Android's download-error wording for the labels of the server's feed fetches (PROTOCOL §9.3). */
const fetchErrors: Record<string, StringKey> = {
  unauthorized: "download_error_unauthorized",
  forbidden: "download_error_forbidden",
  not_found: "download_error_not_found",
  http_status: "download_error_http_data_error",
  too_many_redirects: "download_error_http_data_error",
  size_limit: "download_error_http_data_error",
  io: "download_error_connection_error",
  time_limit: "download_error_connection_error",
  refused_destination: "download_error_unknown_host",
  parser_exception: "download_error_parser_exception",
  unsupported_type: "download_error_unsupported_type",
  unsupported_type_html: "download_error_unsupported_type_html",
};

/**
 * askingOrigin is the origin a podcast's new login is for: the one whose 401
 * asks for it, found as Add podcast finds it (the server's preview of the
 * feed), or the feed address's own when the feed answers without asking. A
 * preview that fails (the feed unreachable, an error, no feed) says nothing
 * about where the login belongs: it rejects with Android's wording, and
 * nothing is recorded, so the saved login and its origins stay.
 */
export async function askingOrigin(url: string, preview: (body: { url: string }) => Promise<Preview> = reads.preview): Promise<string> {
  const notSaved = (reason: string) => new Error(w("credentials_not_saved", reason));
  let answer;
  try {
    answer = await preview({ url });
  } catch (e) {
    throw notSaved(e instanceof ApiError ? e.message : t("download_error_connection_error"));
  }
  if (answer.error?.label === "unauthorized") {
    if (answer.error.origin) return answer.error.origin;
    throw notSaved(t("download_error_unauthorized"));
  }
  if (answer.error) throw notSaved(t(fetchErrors[answer.error.label] ?? "download_error_error_unknown"));
  const own = originOf(url);
  if (!answer.feed || !own) throw notSaved(t("download_error_unsupported_type_html"));
  return own;
}

/** maxCredentialBytes is the server's limit for a feed's username and password, each (UTF-8). */
export const maxCredentialBytes = 4096;
