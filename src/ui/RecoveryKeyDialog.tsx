// Save recovery key (PROTOCOL §11.1): the account's password and a
// passphrase, then the server's keys sealed under it, downloaded as a file.
// The browser can only be asked to save it, so the dialog says so, offers the
// download again, and the warning goes only once the person confirms the file
// is saved. The file and every field live only while the dialog is open.
// The person can always leave, also while a request waits on a slow
// connection: closing gives the request up, and an answer arriving later is
// ignored (no download, no message); the warning is then whatever the server
// reports at its next reading.
import { useEffect, useRef, useState } from "preact/hooks";
import { t, w } from "../i18n.ts";
import type { WebKey } from "../webStrings.ts";
import { ApiError, Unreachable } from "../api/http.ts";
import { failureText } from "./progress.ts";
import {
  confirmSaved,
  download,
  passphraseProblem,
  recoveryKeyFileName,
  requestRecoveryKey,
  type PassphraseProblem,
  type RecoveryKey,
} from "./recoveryKey.ts";

const problems: Record<PassphraseProblem, WebKey> = {
  short: "recovery_key_short",
  long: "recovery_key_long",
  blank: "recovery_key_blank",
  password: "recovery_key_same",
  mismatch: "recovery_key_mismatch",
};

/** A Blob URL stays for a minute after its download starts: long enough for every browser to read it. */
const revokeAfter = 60_000;

function failed(e: unknown): string {
  return e instanceof Unreachable ? w("recovery_key_unreachable") : failureText(e);
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/**
 * RecoveryKeyDialog: offer is the one-time offer after setup ("Not now"
 * instead of Cancel, and why it matters first). onClose is a dismissal;
 * onSaved follows the person's confirmation, accepted by the server.
 */
export function RecoveryKeyDialog({ offer = false, onClose, onSaved }: { offer?: boolean; onClose: () => void; onSaved: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [stage, setStage] = useState<"form" | "working" | "requested" | "confirming">("form");
  const [error, setError] = useState<string>();
  const [key, setKey] = useState<RecoveryKey>();
  const urls = useRef<{ url: string; timer: ReturnType<typeof setTimeout> }[]>([]);
  // The dialog's lifetime: closing it aborts its requests, and their late answers are ignored.
  const [life] = useState(() => new AbortController());
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => {
      life.abort();
      for (const u of urls.current) {
        clearTimeout(u.timer);
        URL.revokeObjectURL(u.url);
      }
      urls.current = [];
      if (dialog?.open) dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  const busy = stage === "working" || stage === "confirming";
  const save = (k: RecoveryKey) => {
    if (life.signal.aborted) return;
    const url = download(k.bundle, recoveryKeyFileName(k.created_at));
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      urls.current = urls.current.filter((u) => u.url !== url);
    }, revokeAfter);
    urls.current.push({ url, timer });
  };
  const request = (form: HTMLFormElement) => {
    const f = new FormData(form);
    const password = String(f.get("password") ?? "");
    const passphrase = String(f.get("passphrase") ?? "");
    const problem = passphraseProblem(passphrase, String(f.get("again") ?? ""), password);
    if (problem) {
      setError(w(problems[problem]));
      return;
    }
    setStage("working");
    setError(undefined);
    requestRecoveryKey(password, passphrase, life.signal).then(
      (k) => {
        if (life.signal.aborted) return;
        setKey(k);
        setStage("requested");
        save(k);
      },
      (e: unknown) => {
        // Closed, or another account or a sign-out (the tab reloads).
        if (life.signal.aborted || isAbort(e)) return;
        setStage("form");
        setError(failed(e));
      },
    );
  };
  const confirm = (k: RecoveryKey) => {
    setStage("confirming");
    setError(undefined);
    confirmSaved(k.export_id, life.signal).then(
      () => {
        if (!life.signal.aborted) onSaved();
      },
      (e: unknown) => {
        if (life.signal.aborted || isAbort(e)) return;
        if (e instanceof ApiError && e.status === 404) {
          setKey(undefined);
          setStage("form");
          setError(w("recovery_key_expired"));
          return;
        }
        setStage("requested");
        setError(failed(e));
      },
    );
  };
  const errorLine = error && (
    <p class="dialog-error" role="alert" dir="auto">
      {error}
    </p>
  );
  const progress = busy && <progress class="dialog-progress" aria-label={t("please_wait")} />;
  return (
    <dialog
      ref={ref}
      class="dialog recovery-key"
      aria-labelledby="recovery-key-title"
      aria-busy={busy}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id="recovery-key-title">{w("recovery_key_title")}</h2>
      {key ? (
        <>
          <p dir="auto">{w("recovery_key_requested", recoveryKeyFileName(key.created_at))}</p>
          {progress}
          {errorLine}
          <div class="dialog-buttons">
            <button type="button" class="text-button dialog-neutral" disabled={busy} onClick={() => save(key)}>
              {w("recovery_key_download_again")}
            </button>
            <button type="button" class="text-button" onClick={onClose}>
              {offer ? w("recovery_key_not_now") : t("cancel_label")}
            </button>
            <button type="button" class="text-button" disabled={busy} onClick={() => confirm(key)}>
              {w("recovery_key_confirm")}
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            request(e.currentTarget);
          }}
        >
          {offer && <p dir="auto">{w("recovery_key_offer")}</p>}
          <p dir="auto">{w("recovery_key_explanation")}</p>
          <div class="authentication-form">
            <label>
              {w("recovery_key_password")}
              <input name="password" type="password" autocomplete="current-password" required disabled={busy} />
            </label>
            <label>
              {w("recovery_key_passphrase")}
              <input name="passphrase" type="password" autocomplete="new-password" required disabled={busy} />
            </label>
            <label>
              {w("recovery_key_passphrase_again")}
              <input name="again" type="password" autocomplete="new-password" required disabled={busy} />
            </label>
          </div>
          {progress}
          {errorLine}
          <div class="dialog-buttons">
            <button type="button" class="text-button" onClick={onClose}>
              {offer ? w("recovery_key_not_now") : t("cancel_label")}
            </button>
            <button class="text-button" disabled={busy}>
              {t("download_label")}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
