// Settings: the account (Android's Synchronization page for this server):
// who is logged in, the account's devices with removal, password change,
// diagnostics, the account's import, logging out (warning about changes not
// yet sent), and the administrators' account management (PROTOCOL §5 API).
import { useEffect, useRef, useState } from "preact/hooks";
import { t, w } from "../i18n.ts";
import { ApiError, get, post, request } from "../api/http.ts";
import { reads, type Installation } from "../api/views.ts";
import { signOut } from "../app/boot.ts";
import { useSync } from "../app/context.ts";
import { useView, useValue } from "../app/useView.ts";
import { Confirm, Loading, Menu, Toolbar } from "../ui/components.tsx";
import { ImportReport, type ImportStatus } from "../ui/ImportReport.tsx";
import { recoveryProblems, recoveryState, type RecoveryProblem, type RecoveryState } from "../journal/recovery.ts";
import { formatAbbrev } from "../ui/format.ts";
import { leavePlayer } from "../player/instance.ts";

function Devices({ devices, onChange }: { devices: Installation[]; onChange: () => void }) {
  const [removing, setRemoving] = useState<Installation>();
  return (
    <section class="settings-group">
      <h2>{w("devices_label")}</h2>
      <ul class="device-list">
        {devices
          .filter((d) => !d.revoked)
          .map((d) => (
            <li key={d.install_id}>
              <span>
                <strong>{d.current ? `${d.name} (${w("this_browser")})` : d.name}</strong>
                <br />
                <span class="secondary">{w("last_seen", formatAbbrev(d.last_seen_at))}</span>
              </span>
              {!d.current && (
                <button class="text-button" onClick={() => setRemoving(d)}>
                  {w("revoke_device")}
                </button>
              )}
            </li>
          ))}
      </ul>
      {removing && (
        <Confirm
          title={w("revoke_device")}
          message={removing.name}
          onCancel={() => setRemoving(undefined)}
          onConfirm={async () => {
            await post(`/v1/installations/${encodeURIComponent(removing.install_id)}/revoke`);
            setRemoving(undefined);
            onChange();
          }}
        />
      )}
    </section>
  );
}

function Password() {
  const [message, setMessage] = useState<string>();
  return (
    <form
      class="settings-group"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.target as HTMLFormElement);
        post("/v1/account/password", { current: String(f.get("current")), new: String(f.get("new")) }).then(
          () => {
            setMessage(w("password_changed"));
            (e.target as HTMLFormElement).reset();
          },
          (err: unknown) => setMessage(err instanceof ApiError ? err.message : String(err)),
        );
      }}
    >
      <h2>{w("change_password")}</h2>
      <label>
        {w("current_password")}
        <input name="current" type="password" autocomplete="current-password" required />
      </label>
      <label>
        {w("new_password")}
        <input name="new" type="password" autocomplete="new-password" minLength={8} required />
      </label>
      <button class="outlined-button">{w("change_password")}</button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}

/**
 * Diagnostics lists the server's diagnostics (feed errors, refused changes)
 * and the changes this browser keeps because recovery after a restore could
 * not send them back (the Recovery banner's count): each by its kind, why,
 * and when it was made.
 */
function Diagnostics() {
  const sync = useSync();
  const running = useValue(sync.recovery);
  const [data, setData] = useState<Record<string, unknown>>();
  const [kept, setKept] = useState<RecoveryProblem[]>([]);
  useEffect(() => {
    get("/v1/diagnostics").then(setData, () => {});
  }, []);
  useEffect(() => {
    recoveryProblems(sync.session.db, sync.account).then(setKept, () => {});
  }, [sync, running]);
  if (!data && kept.length === 0) return null;
  const rejections = (data?.rejections as { type: string; reason: string; op_id: string }[]) ?? [];
  const refresh = (data?.refresh_errors as { title: string; status: { error: { label: string } } }[]) ?? [];
  return (
    <section class="settings-group">
      <h2>{w("diagnostics_label")}</h2>
      {rejections.length === 0 && refresh.length === 0 && kept.length === 0 && <p class="secondary">—</p>}
      <ul>
        {refresh.map((r, i) => (
          <li key={`r${i}`}>
            {r.title}: {r.status.error.label}
          </li>
        ))}
        {rejections.map((r) => (
          <li key={r.op_id}>
            {r.type}: {r.reason}
          </li>
        ))}
        {kept.map((r) => (
          <li key={`k${r.op_id}`} class="recovery-problem">
            {r.type}: {r.reason} ({formatAbbrev(r.time)})
          </li>
        ))}
      </ul>
    </section>
  );
}

interface AdminAccount {
  account_id: string;
  username: string;
  is_admin: boolean;
  state: string;
}

type AccountForm = { kind: "rename" | "password" | "delete"; account: AdminAccount };

/** AccountDialog asks for an administrator's change to one account and stays open until the server answers. */
function AccountDialog({ form, onClose, onDone }: { form: AccountForm; onClose: () => void; onDone: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  useEffect(() => ref.current?.showModal(), []);
  const a = form.account;
  const base = `/v1/admin/accounts/${encodeURIComponent(a.account_id)}`;
  const title = form.kind === "rename" ? t("rename_feed_label") : form.kind === "password" ? w("reset_password") : w("delete_account");
  const submit = async (f: FormData) => {
    const value = String(f.get("value"));
    if (form.kind === "rename") await request("PATCH", base, { username: value });
    else if (form.kind === "password") await post(`${base}/password`, { password: value });
    else await post(`${base}/delete`, { confirm_username: value });
  };
  return (
    <dialog ref={ref} class="dialog" aria-labelledby="account-title" aria-busy={busy} onCancel={(e) => (e.preventDefault(), !busy && onClose())}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setFailed(undefined);
          submit(new FormData(e.target as HTMLFormElement)).then(
            () => onDone(),
            (err: unknown) => {
              setBusy(false);
              setFailed(err instanceof ApiError ? err.message : String(err));
            },
          );
        }}
      >
        <h2 id="account-title">{title}</h2>
        {form.kind === "delete" && <p>{w("delete_account_message", a.username)}</p>}
        <label>
          {form.kind === "rename" ? w("rename_account") : form.kind === "password" ? w("new_password") : t("username_label")}
          {form.kind === "password" ? (
            <input name="value" type="password" autocomplete="new-password" minLength={8} required />
          ) : (
            <input name="value" autocomplete="off" required defaultValue={form.kind === "rename" ? a.username : ""} />
          )}
        </label>
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
          <button class={`text-button${form.kind === "delete" ? " danger" : ""}`} disabled={busy}>
            {form.kind === "delete" ? t("delete_label") : t("confirm_label")}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function Accounts() {
  const [accounts, setAccounts] = useState<AdminAccount[]>();
  const [form, setForm] = useState<AccountForm>();
  const [message, setMessage] = useState<string>();
  const reload = () => get<{ accounts: AdminAccount[] | null }>("/v1/admin/accounts").then((r) => setAccounts(r.accounts ?? []), () => {});
  useEffect(() => void reload(), []);
  if (!accounts) return null;
  const patch = (a: AdminAccount, change: Record<string, unknown>) => async () => {
    await request("PATCH", `/v1/admin/accounts/${encodeURIComponent(a.account_id)}`, change);
    await reload();
  };
  return (
    <section class="settings-group">
      <h2>{w("accounts_label")}</h2>
      <ul class="device-list">
        {accounts.map((a) => (
          <li key={a.account_id}>
            <span>
              <strong dir="auto">{a.username}</strong>
              {a.is_admin && <span class="secondary"> · {w("administrator")}</span>}
              {a.state !== "active" && <span class="secondary"> · {w("disable_account")}</span>}
            </span>
            <Menu
              label={t("overflow_more")}
              items={[
                { label: a.state === "active" ? w("disable_account") : w("enable_account"), run: patch(a, { state: a.state === "active" ? "disabled" : "active" }) },
                { label: a.is_admin ? w("remove_administrator") : w("make_administrator"), run: patch(a, { is_admin: !a.is_admin }) },
                { label: t("rename_feed_label"), run: () => setForm({ kind: "rename", account: a }) },
                { label: w("reset_password"), run: () => setForm({ kind: "password", account: a }) },
                { label: w("delete_account"), run: () => setForm({ kind: "delete", account: a }) },
              ]}
            />
          </li>
        ))}
      </ul>
      {form && (
        <AccountDialog
          form={form}
          onClose={() => setForm(undefined)}
          onDone={() => {
            setForm(undefined);
            void reload();
          }}
        />
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const el = e.target as HTMLFormElement;
          const f = new FormData(el);
          setMessage(undefined);
          post("/v1/admin/accounts", { username: String(f.get("username")), password: String(f.get("password")), is_admin: f.get("is_admin") === "on" }).then(
            () => {
              el.reset();
              void reload();
            },
            (err: unknown) => setMessage(err instanceof ApiError ? err.message : String(err)),
          );
        }}
      >
        <label>
          {t("username_label")}
          <input name="username" required />
        </label>
        <label>
          {t("password_label")}
          <input name="password" type="password" autocomplete="new-password" minLength={8} required />
        </label>
        <label class="check-row">
          <input name="is_admin" type="checkbox" />
          {w("administrator")}
        </label>
        <button class="outlined-button">{w("add_account")}</button>
        {message && <p role="alert">{message}</p>}
      </form>
    </section>
  );
}

interface ServiceReport {
  version: string;
  uptime_seconds: number;
  data_dir: string;
  database_bytes: number;
  schema_version: number;
  keys_exported_at: number;
  listen: { address: string; https: boolean; certificate_expires_at?: number };
  backups: {
    dir: string;
    next_due: number;
    last_success: number;
    last_file: string;
    last_bytes: number;
    kept: number;
    used_bytes: number;
    failures: number;
    last_error: string;
    write_check: string;
  } | null;
  refresh?: { due_now: number; running: number; last_wake: number };
  warnings: string[];
}

function bytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

function since(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min`;
}

function when(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleString() : w("server_never");
}

/** ServerSection is the service page (PROTOCOL §14): how the server is doing, and how to run it. */
function ServerSection() {
  const [r, setR] = useState<ServiceReport>();
  useEffect(() => {
    get<ServiceReport>("/v1/admin/service").then(setR, () => {});
  }, []);
  if (!r) return null;
  const b = r.backups;
  const warnings = r.warnings.filter((x) => x !== "keys_not_exported");
  return (
    <section class="settings-group server-section">
      <h2>{w("server_label")}</h2>
      <p dir="auto">{w("server_version", r.version, since(r.uptime_seconds))}</p>
      <p dir="auto">{w("server_data", r.data_dir, bytes(r.database_bytes), String(r.schema_version))}</p>
      <p dir="auto">{w(r.listen.https ? "server_listen_https" : "server_listen_http", r.listen.address)}</p>
      {r.listen.certificate_expires_at && <p dir="auto">{w("server_certificate", when(r.listen.certificate_expires_at))}</p>}
      {!b ? (
        <p>{w("server_backups_off")}</p>
      ) : (
        <>
          <p dir="auto">{w("server_backups", b.dir, String(b.kept), bytes(b.used_bytes))}</p>
          <p dir="auto">{b.last_success ? w("server_backup_last", when(b.last_success), bytes(b.last_bytes)) : w("server_backup_none")}</p>
          <p dir="auto">{w("server_backup_next", when(b.next_due))}</p>
          {b.last_error && (
            <p class="dialog-error" role="alert" dir="auto">
              {w("server_backup_failed", b.last_error)}
            </p>
          )}
          {b.write_check && b.write_check !== "ok" && (
            <p class="dialog-error" role="alert" dir="auto">
              {w("server_backup_unwritable", b.write_check)}
            </p>
          )}
        </>
      )}
      {r.keys_exported_at ? (
        <p>{w("server_keys_exported", when(r.keys_exported_at))}</p>
      ) : (
        <p class="dialog-error" role="alert">
          {w("server_keys_not_exported")}
        </p>
      )}
      {r.refresh && <p>{w("server_refresh", String(r.refresh.due_now), when(r.refresh.last_wake))}</p>}
      {warnings.length > 0 && (
        <>
          <h3>{w("server_warnings")}</h3>
          <ul>
            {warnings.map((x, i) => (
              <li key={i} class="dialog-error" dir="auto">
                {x}
              </li>
            ))}
          </ul>
        </>
      )}
      <details>
        <summary>{w("server_instructions")}</summary>
        <p dir="auto">{w("server_howto_service", r.data_dir)}</p>
        <p dir="auto">{w("server_howto_backups")}</p>
        <p dir="auto">{w("server_howto_tailscale")}</p>
        <p dir="auto">{w("server_howto_restore", r.data_dir)}</p>
      </details>
    </section>
  );
}

/** ImportSection shows the account's import and its report, also after a reload. */
function ImportSection({ id }: { id: string }) {
  const [status, setStatus] = useState<ImportStatus>();
  useEffect(() => {
    get<ImportStatus>(`/v1/import/${encodeURIComponent(id)}`).then(setStatus, () => {});
  }, [id]);
  if (!status) return null;
  return (
    <section class="settings-group">
      <h2>{w("import_label")}</h2>
      <ImportReport status={status} />
    </section>
  );
}

/**
 * Recovery says what this browser still holds for recovery after a
 * restore: changes not sent yet, and changes the server would not take.
 */
function Recovery() {
  const sync = useSync();
  const running = useValue(sync.recovery);
  const [state, setState] = useState<RecoveryState>();
  useEffect(() => {
    recoveryState(sync.session.db, sync.account).then(setState, () => {});
  }, [sync, running]);
  if (!state || (state.pending === 0 && state.problems === 0)) return null;
  return (
    <>
      {state.pending > 0 && (
        <p class="banner" role="status">
          {w("recovery_pending", state.pending)}
        </p>
      )}
      {state.problems > 0 && (
        <p class="banner" role="status">
          {w("recovery_problems", state.problems)}
        </p>
      )}
    </>
  );
}

export function Settings() {
  const sync = useSync();
  const view = useView((signal) => reads.summary(signal), []);
  const pending = useValue(sync.pending);
  const [confirmOut, setConfirmOut] = useState(false);
  const [outBusy, setOutBusy] = useState(false);
  const [outFailed, setOutFailed] = useState<string>();
  const account = sync.session.account;
  const out = () => {
    setConfirmOut(false);
    setOutBusy(true);
    setOutFailed(undefined);
    // The player's last save is made under this account, and sent if the server takes it in time.
    leavePlayer(sync)
      .then(() => sync.pushed(3000))
      .then(() => signOut())
      .then(
      () => location.assign("/"),
      (err: unknown) => {
        setOutBusy(false);
        setOutFailed(err instanceof ApiError ? `${w("sign_out_failed")} ${err.message}` : w("sign_out_failed"));
      },
    );
  };
  return (
    <section>
      <Toolbar title={t("settings_label")} />
      <section class="settings-group">
        <h2>{w("account_label")}</h2>
        <p>{w("signed_in_as", account.username, location.host)}</p>
        <button class="outlined-button" disabled={outBusy} onClick={() => (pending > 0 ? setConfirmOut(true) : out())}>
          {t("synchronization_logout")}
        </button>
        {outFailed && (
          <p class="dialog-error" role="alert" dir="auto">
            {outFailed}
          </p>
        )}
      </section>
      <Recovery />
      {!view.data ? <Loading /> : <Devices devices={view.data.installations} onChange={view.reload} />}
      {view.data?.import && <ImportSection id={view.data.import.import_id} />}
      <Password />
      <Diagnostics />
      {account.is_admin && <Accounts />}
      {account.is_admin && <ServerSection />}
      {confirmOut && (
        <Confirm
          title={t("synchronization_logout")}
          message={w("sign_out_pending")}
          confirm={w("sign_out_anyway")}
          onCancel={() => setConfirmOut(false)}
          onConfirm={out}
        />
      )}
    </section>
  );
}
