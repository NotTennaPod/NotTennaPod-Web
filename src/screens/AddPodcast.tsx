// Add podcast (Android's AddFeedFragment and OnlineFeedViewActivity): add by
// RSS address with a preview (fetched by the server), credentials when the
// feed asks, subscribe, open an existing podcast; and importing an OPML list
// or an AntennaPod database into an empty account (PROTOCOL §11.5).
import { useState } from "preact/hooks";
import { t, w, plural } from "../i18n.ts";
import { ApiError, get, post, request } from "../api/http.ts";
import { reads, type Preview } from "../api/views.ts";
import * as act from "../app/actions.ts";
import { useSync } from "../app/context.ts";
import { navigate, pathOf } from "../app/router.ts";
import { Cover } from "../ui/Cover.tsx";
import { Toolbar } from "../ui/components.tsx";
import { formatAbbrev, durationLong } from "../ui/format.ts";
import { plainText } from "./Podcast.tsx";
import { Sha256, uuid } from "../util/random.ts";
import { ImportReport, type ImportStatus } from "../ui/ImportReport.tsx";
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
    const body = act.subscribe(preview.url);
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
              {preview.podcast_id ? (
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

/** importMaxFile is the server's limit for an imported file (importer.MaxFile). */
const importMaxFile = 2 * 2 ** 30;

/** Import uploads a file in base64 chunks and follows the import to publication (PROTOCOL §11.5). */
function Import() {
  const [status, setStatus] = useState<string>();
  const [report, setReport] = useState<ImportStatus>();
  const upload = async (file: File, kind: "opml" | "android_db") => {
    setStatus(w("import_uploading"));
    setReport(undefined);
    try {
      // The server takes at most 2 GiB; the file is read one chunk at a time,
      // so a large backup never sits in memory whole.
      if (file.size > importMaxFile) throw new Error(w("import_too_large"));
      const chunk = 3 << 20;
      const slice = async (i: number) => new Uint8Array(await file.slice(i, i + chunk).arrayBuffer());
      const hash = new Sha256();
      for (let i = 0; i < file.size; i += chunk) hash.update(await slice(i));
      const fingerprint = [...hash.digest()].map((x) => x.toString(16).padStart(2, "0")).join("");
      const r = await post<{ import_id: string; status: string }>("/v1/import", { kind, fingerprint, size: file.size, file_name: file.name });
      for (let i = 0, n = 0; i < file.size; i += chunk, n++) {
        let s = "";
        for (const b of await slice(i)) s += String.fromCharCode(b);
        await request("PUT", `/v1/import/${r.import_id}/chunks/${n}`, { data: btoa(s) });
      }
      await post(`/v1/import/${r.import_id}/finish`);
      setStatus(undefined);
      for (;;) {
        const s = await get<ImportStatus>(`/v1/import/${r.import_id}`);
        setReport(s);
        if (s.status === "published" || s.status === "failed") return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (e) {
      setStatus(`${t("import_error_label")}: ${e instanceof ApiError || e instanceof Error ? e.message : String(e)}`);
    }
  };
  const picker = (kind: "opml" | "android_db", accept: string, label: string) => (
    <label class="outlined-button">
      {label}
      <input
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          const f = (e.target as HTMLInputElement).files?.[0];
          if (f) void upload(f, kind);
        }}
      />
    </label>
  );
  return (
    <div class="import">
      <h3>{t("import_export_pref")}</h3>
      <p class="secondary">{w("import_explanation")}</p>
      {picker("opml", ".opml,.xml,text/xml,text/x-opml", t("opml_add_podcast_label"))}
      {picker("android_db", ".db,application/octet-stream", t("database_import_label"))}
      {status && <p role="status">{status}</p>}
      {report && <ImportReport status={report} />}
    </div>
  );
}
