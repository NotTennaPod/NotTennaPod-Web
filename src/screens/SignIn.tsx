// Logging in to this server (PROTOCOL §5 web sign-in), or the first setup with
// the setup code.
import { useState } from "preact/hooks";
import { t, w } from "../i18n.ts";
import { ApiError } from "../api/http.ts";
import { setUp, signIn } from "../app/boot.ts";

export function SignIn({ setup, reason, onDone }: { setup: boolean; reason?: string; onDone: () => void }) {
  const [error, setError] = useState(reason);
  const [busy, setBusy] = useState(false);
  return (
    <main class="sign-in">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.target as HTMLFormElement);
          const username = String(f.get("username"));
          const password = String(f.get("password"));
          setBusy(true);
          (setup ? setUp(username, password, String(f.get("code"))) : signIn(username, password)).then(onDone, (err: unknown) => {
            setBusy(false);
            setError(err instanceof ApiError ? err.message : String(err));
          });
        }}
      >
        <h1>{setup ? w("setup_title") : w("sign_in_title")}</h1>
        <p>{setup ? w("setup_explanation") : t("synchronization_credentials_explanation")}</p>
        {setup && (
          <label>
            {w("setup_code_label")}
            <input name="code" required autocomplete="off" />
          </label>
        )}
        <label>
          {t("username_label")}
          <input name="username" required autocomplete="username" />
        </label>
        <label>
          {t("password_label")}
          <input name="password" type="password" required minLength={8} autocomplete={setup ? "new-password" : "current-password"} />
        </label>
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        <button class="filled-button" disabled={busy}>
          {setup ? w("setup_button") : t("synchronization_login_butLabel")}
        </button>
      </form>
    </main>
  );
}
