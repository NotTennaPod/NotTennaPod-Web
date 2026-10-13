// Android's dialogs and actions for one or more podcasts: RemoveFeedDialog
// (unsubscribe, archive or restore, with its progress), PreferenceSwitchDialog
// for Keep updated, AuthenticationDialog for a podcast's login, and Remove all
// from inbox (FeedMultiSelectActionHandler).
import { useEffect, useRef, useState } from "preact/hooks";
import { t, w, plural } from "../i18n.ts";
import { reads, type EpisodeRow, type PodcastRow } from "../api/views.ts";
import type { Sync } from "../app/sync.ts";
import * as act from "../app/actions.ts";
import { uuid } from "../util/random.ts";
import { askingOrigin, feedURL, maxCredentialBytes } from "../app/feedLogin.ts";
import { Icon } from "./Icon.tsx";
import { failureText, track } from "./progress.ts";

/**
 * RemoveFeedDialog is Android's: the podcast's title (or "n subscriptions"),
 * what archiving and unsubscribing do, and Cancel, Unsubscribe (asked once
 * more) and Archive, or Restore when every podcast is archived.
 */
export function RemoveFeedDialog({ sync, podcasts, onClose, onUnsubscribed }: {
  sync: Sync;
  podcasts: PodcastRow[];
  onClose: () => void;
  onUnsubscribed?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [failed, setFailed] = useState<string>();
  useEffect(() => ref.current?.showModal(), []);
  const allArchived = podcasts.every((p) => p.state === "archived");
  const run = async (progressKey: "deleting_podcast_progress" | "archiving_podcast_progress" | "restoring_podcast_progress", body: (p: PodcastRow) => Parameters<Sync["act"]>[0]) => {
    setFailed(undefined);
    try {
      for (let i = 0; i < podcasts.length; i++) {
        setProgress(t(progressKey, i + 1, podcasts.length));
        await sync.act(body(podcasts[i]!));
      }
      onClose();
      if (progressKey === "deleting_podcast_progress") onUnsubscribed?.();
    } catch (e) {
      setProgress(null);
      setFailed(failureText(e));
    }
  };
  return (
    <dialog ref={ref} class="dialog" aria-labelledby="remove-title" aria-busy={progress !== null} onCancel={(e) => (e.preventDefault(), progress === null && onClose())}>
      <h2 id="remove-title">{t("remove_archive_feed_label")}</h2>
      <p dir="auto">{podcasts.length === 1 ? podcasts[0]!.display_title : plural("num_subscriptions", podcasts.length)}</p>
      {!allArchived && <p>{t("feed_delete_explanation_archive")}</p>}
      <p>{t("feed_delete_explanation_delete")}</p>
      {progress !== null && (
        <>
          <progress class="dialog-progress" aria-label={t("please_wait")} />
          <p role="status">{progress}</p>
        </>
      )}
      {failed && (
        <p class="dialog-error" role="alert" dir="auto">
          {failed}
        </p>
      )}
      {progress === null && (
        <div class="dialog-buttons">
          <button class="text-button" onClick={onClose}>
            {t("cancel_label")}
          </button>
          {confirming ? (
            <button class="text-button danger" onClick={() => void track(run("deleting_podcast_progress", act.unsubscribe))}>
              {t("remove_feed_label")}
            </button>
          ) : (
            <button class="text-button" onClick={() => setConfirming(true)}>
              {t("remove_feed_label")}
            </button>
          )}
          {allArchived ? (
            <button class="text-button" onClick={() => void track(run("restoring_podcast_progress", act.restore))}>
              {t("restore_archive_label")}
            </button>
          ) : (
            <button class="text-button" onClick={() => void track(run("archiving_podcast_progress", act.archive))}>
              {t("archive_feed_label_verb")}
            </button>
          )}
        </div>
      )}
    </dialog>
  );
}

/** KeepUpdatedDialog is Android's PreferenceSwitchDialog for Keep updated, for the podcasts chosen. */
export function KeepUpdatedDialog({ sync, podcasts, onClose }: { sync: Sync; podcasts: PodcastRow[]; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [on, setOn] = useState(false);
  useEffect(() => ref.current?.showModal(), []);
  const confirm = async () => {
    for (const p of podcasts) await sync.act(act.setPolicy(p, { keep_updated: on }));
    onClose();
  };
  return (
    <dialog ref={ref} class="dialog" aria-labelledby="keep-updated-title" onCancel={(e) => (e.preventDefault(), onClose())}>
      <h2 id="keep-updated-title">{t("kept_updated")}</h2>
      <label class="check-row">
        <input type="checkbox" role="switch" checked={on} onChange={(e) => setOn((e.target as HTMLInputElement).checked)} />
        {t("keep_updated_summary")}
      </label>
      <div class="dialog-buttons">
        <button class="text-button" onClick={onClose}>
          {t("cancel_label")}
        </button>
        <button class="text-button" onClick={() => void track(confirm())}>
          {t("confirm_label")}
        </button>
      </div>
    </dialog>
  );
}

/** removeAllInbox removes every episode of the podcasts from the Inbox (DBWriter.removeFeedNewFlag): their NEW episodes, every page. */
export async function removeAllInbox(sync: Sync, podcasts: PodcastRow[]): Promise<void> {
  for (const p of podcasts) {
    const fresh: EpisodeRow[] = [];
    for (let token: string | undefined, first = true; first || token; first = false) {
      const page = await reads.podcastEpisodes(p.podcast_id, { filter: "new", limit: 500, page_token: token });
      fresh.push(...page.items);
      token = page.next_page_token ?? undefined;
    }
    if (fresh.length) await sync.act(act.dismiss(fresh, true));
  }
}

/**
 * AuthenticationDialog is Android's feed settings Authentication
 * (AuthenticationDialog from FeedSettingsPreferenceFragment): the podcast's
 * username and password, a button that shows the password, Cancel and
 * Confirm. Confirm saves them for the podcast; the server then refreshes it
 * with them, as Android refreshes the feed once.
 *
 * A browser is never given a saved password (PROTOCOL §12: credentials
 * show as set, with the username), so the password field starts empty.
 * Leaving it empty with the username unchanged keeps the saved login; a
 * changed username needs its password. As on Android, no username means no
 * login: the podcast's credentials are removed.
 *
 * The new login goes to the origin that asks for it (askingOrigin). When
 * that cannot be found, the dialog says so and stays open with what was
 * typed, for another try; the saved login stays as it was.
 */
export function AuthenticationDialog({ sync, podcast, onClose }: { sync: Sync; podcast: PodcastRow; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const creds = typeof podcast.credentials === "object" ? podcast.credentials : { set: podcast.credentials, username: null };
  const known = creds.username ?? "";
  const [username, setUsername] = useState(known);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  useEffect(() => ref.current?.showModal(), []);
  const passwordNeeded = creds.set && username !== "" && username !== known;
  const save = async (password: string) => {
    const bytes = (v: string) => new TextEncoder().encode(v).length;
    if (bytes(username) > maxCredentialBytes || bytes(password) > maxCredentialBytes) throw new Error(w("credentials_too_long"));
    if (username === "") {
      if (creds.set) await sync.act(act.setCredentials(podcast, null));
      return;
    }
    if (creds.set && username === known && password === "") return; // the saved login stays
    const origin = await askingOrigin(feedURL(podcast));
    const secretId = uuid();
    await sync.act({
      ...act.setCredentials(podcast, secretId),
      secrets: [{ secret_id: secretId, username, password, approved_origins: [origin] }],
    });
  };
  return (
    <dialog ref={ref} class="dialog" aria-labelledby="authentication-title" aria-busy={busy} onCancel={(e) => (e.preventDefault(), !busy && onClose())}>
      <form
        class="authentication-form"
        onSubmit={(e) => {
          e.preventDefault();
          const password = String(new FormData(e.target as HTMLFormElement).get("password") ?? "");
          setBusy(true);
          setFailed(undefined);
          void track(
            save(password).then(onClose, (err: unknown) => {
              setBusy(false);
              setFailed(failureText(err));
            }),
          );
        }}
      >
        <h2 id="authentication-title">{t("authentication_label")}</h2>
        <label>
          {t("username_label")}
          <input name="username" autocomplete="off" dir="auto" value={username} onInput={(e) => setUsername((e.target as HTMLInputElement).value)} />
        </label>
        <div class="password-row">
          <label>
            {t("password_label")}
            {/* One element either way (Preact keeps the node, and what was typed). */}
            {shown ? (
              <input name="password" type="text" autocomplete="off" dir="auto" required={passwordNeeded} />
            ) : (
              <input name="password" type="password" autocomplete="new-password" dir="auto" required={passwordNeeded} />
            )}
          </label>
          <button
            type="button"
            class={`icon-button show-password${shown ? " shown" : ""}`}
            aria-label={t("show_password_accessibility")}
            title={t("show_password_accessibility")}
            aria-pressed={shown}
            onClick={() => setShown(!shown)}
          >
            <Icon name="eye" />
          </button>
        </div>
        {busy && <progress class="dialog-progress" aria-label={t("please_wait")} />}
        {failed && (
          <p class="dialog-error" role="alert" dir="auto">
            {failed}
          </p>
        )}
        <div class="dialog-buttons">
          <button type="button" class="text-button" onClick={onClose} disabled={busy}>
            {t("cancel_label")}
          </button>
          <button class="text-button" disabled={busy}>
            {t("confirm_label")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
