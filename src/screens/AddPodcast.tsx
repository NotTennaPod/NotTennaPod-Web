// Add podcast (Android's AddFeedFragment and OnlineFeedViewActivity): add by
// RSS address with a preview (fetched by the server), credentials when the
// feed asks, subscribe, open an existing podcast; and importing an OPML list
// or an AntennaPod database into an empty account (PROTOCOL §11.5).
import { useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";
import { t, w, plural } from "../i18n.ts";
import { ApiError } from "../api/http.ts";
import { reads, type Preview } from "../api/views.ts";
import * as act from "../app/actions.ts";
import { useSync } from "../app/context.ts";
import { navigate, pathOf } from "../app/router.ts";
import { Cover } from "../ui/Cover.tsx";
import { Toolbar } from "../ui/components.tsx";
import { Icon } from "../ui/Icon.tsx";
import { formatAbbrev, durationLong } from "../ui/format.ts";
import { plainText } from "./Podcast.tsx";
import { uuid } from "../util/random.ts";
import { ImportProgress, useImportJob } from "../ui/ImportProgress.tsx";
import * as importJob from "../app/importJob.ts";
import { busy as importBusy } from "../app/importMachine.ts";
import { maxCredentialBytes } from "../app/feedLogin.ts";

const errorText: Record<string, Parameters<typeof t>[0]> = {
  unauthorized: "download_error_unauthorized",
  forbidden: "download_error_forbidden",
  not_found: "download_error_not_found",
  unsupported_type_html: "download_error_unsupported_type_html",
  io: "download_error_connection_error",
  time_limit: "download_error_connection_error",
  refused_destination: "download_error_unknown_host",
};

export function AddPodcast() {
  const sync = useSync();
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [creds, setCreds] = useState<{ username: string; password: string } | null>(null);
  const [credsError, setCredsError] = useState<string>();
  const load = async (url: string, c?: { username: string; password: string; origin?: string }) => {
    setBusy(true);
    try {
      setPreview(await reads.preview({ url, ...c }));
    } catch (e) {
      setPreview({ error: { label: "invalid", detail: e instanceof ApiError ? e.message : String(e) } });
    } finally {
      setBusy(false);
    }
  };
  const subscribe = async () => {
    if (!preview?.url) return;
    let secretId: string | undefined;
    // A podcast the account removed: subscribing again opens a fresh one (PROTOCOL §7.2).
    const body = act.subscribe(preview.url, { observed: preview.observed });
    if (creds && preview.feed) {
      secretId = uuid();
      body.payload.credentials_secret = secretId;
      body.secrets = [{ secret_id: secretId, username: creds.username, password: creds.password, ...(askedOrigin ? { approved_origins: [askedOrigin] } : {}) }];
    }
    await sync.act(body);
    sync.notify(t("subscribe_label"));
    navigate("/subscriptions");
  };
  const askedOrigin = preview?.error?.label === "unauthorized" ? preview.error.origin : lastOrigin;
  return (
    <section>
      <Toolbar title={t("add_feed_label")} />
      <form
        class="add-form"
        onSubmit={(e) => {
          e.preventDefault();
          setCreds(null);
          lastOrigin = undefined;
          void load(address.trim());
        }}
      >
        <label>
          {t("add_podcast_by_url")}
          <input type="url" required value={address} placeholder={t("rss_address")} onInput={(e) => setAddress((e.target as HTMLInputElement).value)} />
        </label>
        <button class="filled-button" disabled={busy}>
          {t("preview_episodes")}
        </button>
      </form>
      {preview?.error?.label === "unauthorized" && (
        <form
          class="add-form"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.target as HTMLFormElement);
            const c = { username: String(f.get("username")), password: String(f.get("password")) };
            // The server keeps at most 4096 bytes of each (UTF-8), and would refuse to sync more.
            const bytes = (v: string) => new TextEncoder().encode(v).length;
            if (bytes(c.username) > maxCredentialBytes || bytes(c.password) > maxCredentialBytes) {
              setCredsError(w("credentials_too_long"));
              return;
            }
            setCredsError(undefined);
            setCreds(c);
            lastOrigin = preview.error?.origin;
            void load(address.trim(), { ...c, origin: preview.error?.origin });
          }}
        >
          <p>{t("download_error_unauthorized")}</p>
          <label>
            {t("username_label")}
            <input name="username" autocomplete="username" required />
          </label>
          <label>
            {t("password_label")}
            <input name="password" type="password" autocomplete="current-password" required />
          </label>
          {credsError && (
            <p class="error" role="alert">
              {credsError}
            </p>
          )}
          <button class="filled-button" disabled={busy}>
            {t("confirm_label")}
          </button>
        </form>
      )}
      {preview?.error && preview.error.label !== "unauthorized" && (
        <p class="error" role="alert">
          {errorText[preview.error.label] ? t(errorText[preview.error.label]!) : preview.error.detail}
        </p>
      )}
      {preview?.links && (
        <ul class="feed-links">
          {preview.links.map((l) => (
            <li key={l.url}>
              <button class="text-button" onClick={() => void load(l.url)}>
                {l.title || l.url}
              </button>
            </li>
          ))}
        </ul>
      )}
      {preview?.feed && (
        <div class="preview">
          <div class="podcast-header">
            <Cover url={preview.feed.image_url} title={preview.feed.title ?? ""} size={112} />
            <div>
              <h2>{preview.feed.title}</h2>
              {preview.feed.author && <p class="secondary podcast-author">{preview.feed.author}</p>}
              {preview.podcast_id && !preview.observed ? (
                <button class="filled-button" onClick={() => navigate(pathOf({ name: "podcast", id: preview.podcast_id! }))}>
                  {t("open_podcast")}
                </button>
              ) : (
                <button class="filled-button" onClick={() => void subscribe()}>
                  {t("subscribe_label")}
                </button>
              )}
            </div>
          </div>
          {preview.feed.description && <p class="podcast-description">{plainText(preview.feed.description)}</p>}
          <h3>
            <span dir="auto">{plural("num_episodes", preview.feed.item_count)}</span>
          </h3>
          <ul class="episode-list">
            {preview.feed.items.map((it, i) => (
              <li key={i} class="episode">
                <div class="episode-text">
                  <span class="episode-title">{it.title}</span>
                  <span class="episode-status">
                    <span>{it.pub_date ? formatAbbrev(it.pub_date) : ""}</span>
                    {it.media && <span>{durationLong(it.media.duration_ms)}</span>}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Import />
    </section>
  );
}

let lastOrigin: string | undefined;

/** Import uploads a file and follows the import to publication and its first refresh (PROTOCOL §11.5), as the tab's job. */
function Import() {
  const view = useImportJob();
  const busy = importBusy(view.state);
  const opml = useRef<HTMLInputElement>(null);
  const database = useRef<HTMLInputElement>(null);
  // Android's AddPodcastTextView rows: a button (reached with Tab) that opens its own file chooser.
  const picker = (kind: "opml" | "android_db", accept: string, label: string, input: RefObject<HTMLInputElement | null>) => (
    <>
      <button type="button" class="add-podcast-row" disabled={busy} onClick={() => input.current?.click()}>
        <Icon name="download" />
        <span>{label}</span>
      </button>
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          const el = e.target as HTMLInputElement;
          const f = el.files?.[0];
          // Cleared, so the same file can be chosen again (to continue its upload).
          el.value = "";
          if (f) importJob.choose(f, kind);
        }}
      />
    </>
  );
  return (
    <div class="import">
      <h3>{t("import_export_pref")}</h3>
      <p class="secondary">{w("import_explanation")}</p>
      <div class="add-podcast-rows">
        {picker("opml", ".opml,.xml,text/xml,text/x-opml", t("opml_add_podcast_label"), opml)}
        {picker("android_db", ".db,application/octet-stream", t("database_import_label"), database)}
      </div>
      <ImportProgress view={view} />
    </div>
  );
}
