// Starting the app in a tab (PROTOCOL §12): which account the session
// belongs to, the profile's installation for it (registered once, kept in
// IndexedDB with its nonce), and this tab load's own author (PROTOCOL §12).
import { ApiError, endGeneration, get, post, useAccount } from "../api/http.ts";
import { openDB, type AuthorRow, type InstallationRow } from "../journal/db.ts";
import { installation, newAuthor, updateInstallation } from "../journal/journal.ts";
import { takeSuccessor } from "../journal/successor.ts";
import { offerState, setOffer } from "../ui/recoveryKey.ts";

export interface Account {
  account_id: string;
  namespace: string;
  username: string;
  is_admin: boolean;
}

export interface Session {
  account: Account;
  db: IDBDatabase;
  installation: InstallationRow;
  author: AuthorRow;
}

export const capabilities = ["favorites", "history", "inbox", "queue", "statistics"];
export const appVersion = "0.1.0";

/** browserName names this browser for the account's device list (PROTOCOL §5). */
export function browserName(ua = navigator.userAgent): string {
  const os = /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  const b = /Firefox\//.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return os ? `${b} on ${os}` : b;
}

export type BootResult =
  | { kind: "signed_in"; session: Session }
  | { kind: "signed_out"; setupRequired: boolean; reason?: string }
  | { kind: "conflict" };

let dbPromise: Promise<IDBDatabase> | undefined;
export function database(): Promise<IDBDatabase> {
  dbPromise ??= openDB();
  return dbPromise;
}

/** boot finds the session's account and readies the profile's installation for it. */
export async function boot(): Promise<BootResult> {
  let who: { account: Account; install_id: string | null };
  try {
    who = await get<{ account: Account; install_id: string | null }>("/v1/session");
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      const info = await get<{ setup_required: boolean }>("/v1/info");
      return { kind: "signed_out", setupRequired: info.setup_required, reason: e.status === 403 ? e.message : undefined };
    }
    throw e;
  }
  const account = who.account;
  useAccount(account.account_id);
  const db = await database();
  let inst = await installation(db, account.account_id);
  for (let asked = 1; ; asked++) {
    if (who.install_id && who.install_id === inst.successor?.install_id) {
      // The server registered the planned successor and bound this session to
      // it, but the tab closed before renumbering (PROTOCOL §12): finish that
      // plan, or take the installation as another tab finished it.
      inst = await takeSuccessor(db, account.account_id, async () => undefined, {
        freshNonce: false,
        from: inst.install_id,
        registered: who.install_id,
        device: { name: browserName(), app_version: appVersion, capabilities },
      });
    }
    if (!who.install_id || who.install_id === inst.install_id) break;
    // An installation this profile has left: the answer was asked before
    // another tab's handoff gave the browser its successor's session. Ask again.
    if (asked === 1 && inst.predecessors.includes(who.install_id)) {
      who = await get<{ account: Account; install_id: string | null }>("/v1/session");
      inst = await installation(db, account.account_id);
      continue;
    }
    // The session belongs to another installation: a copied or cleared
    // profile. Signing in again gives this profile its own session.
    return { kind: "conflict" };
  }
  if (!who.install_id || !inst.registered) {
    try {
      await post("/v1/installations", {
        install_id: inst.install_id,
        instance_nonce: inst.instance_nonce,
        name: browserName(),
        app_version: appVersion,
        capabilities,
      });
    } catch (e) {
      if (e instanceof ApiError && e.code === "installation_conflict") return { kind: "conflict" };
      throw e;
    }
    inst = await updateInstallation(db, account.account_id, (r) => (r.registered = true));
  }
  const author = await newAuthor(db, account.account_id);
  return { kind: "signed_in", session: { account, db, installation: inst, author } };
}

/** signIn starts a web session (PROTOCOL §5). */
export async function signIn(username: string, password: string): Promise<void> {
  await post("/v1/auth/web", { username, password });
  announce("signed_in");
}

/**
 * setUp creates the first administrator with the setup code (PROTOCOL §5).
 * The recovery key is offered once afterwards: the offer is noted before
 * asking, so an answer lost on the way or a tab closed meanwhile keeps it,
 * and taken back only when the server refuses the setup.
 */
export async function setUp(username: string, password: string, code: string): Promise<void> {
  const before = offerState();
  setOffer("pending");
  try {
    await post("/v1/setup", { username, password, setup_code: code });
  } catch (e) {
    if (e instanceof ApiError) setOffer(before);
    throw e;
  }
  announce("signed_in");
}

/**
 * signOut ends the session; the journal stays until pushed or discarded
 * (PROTOCOL §12). The tabs sign out only when the server has ended the session (or
 * no longer has it); otherwise the session stands and the error is thrown.
 */
export async function signOut(): Promise<void> {
  try {
    await post("/v1/auth/web/sign-out");
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) throw e;
  }
  useAccount(undefined);
  announce("signed_out");
}

// Sign-in and sign-out tell every tab, which drop their views and reload (PROTOCOL §12).
const channel = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("nottennapod-account");

function announce(kind: "signed_in" | "signed_out"): void {
  channel?.postMessage({ kind });
}

export function onAccountTransition(fn: (kind: string) => void): () => void {
  if (!channel) return () => {};
  const h = (e: MessageEvent) => {
    endGeneration();
    fn((e.data as { kind: string }).kind);
  };
  channel.addEventListener("message", h);
  return () => channel.removeEventListener("message", h);
}
