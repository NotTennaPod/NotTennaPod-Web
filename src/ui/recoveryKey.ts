// Save recovery key (PROTOCOL §11.1): the server's keys, sealed under a
// passphrase the person chooses, saved as a file. Here: the passphrase floor
// the server applies (checked first, so the form can say what is wrong), the
// file's name, the requests, the download, and the offer made once after
// setup in this browser.
import { request, Unreachable } from "../api/http.ts";
import { w } from "../i18n.ts";

export const minPassphrase = 12;
export const maxPassphrase = 1024;

export type PassphraseProblem = "short" | "long" | "blank" | "password" | "mismatch";

/**
 * passphraseProblem is what is wrong with a passphrase, as the server
 * judges it: 12 to 1024 characters (code points), not only spaces, not the
 * password; and it must be typed the same twice. Nothing is trimmed.
 */
export function passphraseProblem(passphrase: string, again: string, password: string): PassphraseProblem | undefined {
  const n = [...passphrase].length;
  if (n < minPassphrase) return "short";
  if (n > maxPassphrase) return "long";
  if (passphrase.trim() === "") return "blank";
  if (passphrase === password) return "password";
  if (passphrase !== again) return "mismatch";
  return undefined;
}

/** recoveryKeyFileName is the file's name: the day the key was made, in UTC. */
export function recoveryKeyFileName(createdAt: number): string {
  const d = new Date(createdAt);
  const two = (n: number) => String(n).padStart(2, "0");
  return `nottennapod-recovery-key-${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}.json`;
}

export interface RecoveryKey {
  export_id: string;
  bundle: string;
  created_at: number;
}

/**
 * requestRecoveryKey asks the server for the key file; an answer without it is a failed request.
 * signal gives the request up (the dialog closed).
 */
export async function requestRecoveryKey(password: string, passphrase: string, signal?: AbortSignal): Promise<RecoveryKey> {
  const r = await request<Partial<RecoveryKey>>("POST", "/v1/admin/keys", { password, passphrase }, signal);
  if (typeof r.export_id !== "string" || typeof r.bundle !== "string" || r.bundle === "" || typeof r.created_at !== "number") {
    throw new Unreachable("The answer was incomplete.");
  }
  return { export_id: r.export_id, bundle: r.bundle, created_at: r.created_at };
}

/** confirmSaved tells the server the person saved the file: from then on the warning is gone. */
export async function confirmSaved(exportId: string, signal?: AbortSignal): Promise<void> {
  await request("POST", `/v1/admin/keys/${encodeURIComponent(exportId)}/saved`, {}, signal);
}

/** download asks the browser to save text as a file and returns its Blob URL, to revoke later. */
export function download(text: string, name: string): string {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  return url;
}

// The offer once after setup. It is written just before setup is asked for,
// so a lost answer or a closed tab keeps it, and settled after logging in:
// offered to an administrator while the server has no saved recovery key.
// "Not now" or a confirmed save ends it. Not a secret; this browser only.
const offerKey = "nottennapod.recoveryKeyOffer";

export type OfferState = "pending" | "done" | null;

/** setOffer notes the offer's state (null: none, as before any setup). */
export function setOffer(state: OfferState): void {
  try {
    if (state === null) localStorage.removeItem(offerKey);
    else localStorage.setItem(offerKey, state);
  } catch {
    /* private browsing: Settings still has the action and its warning */
  }
}

export function offerState(): OfferState {
  try {
    const v = localStorage.getItem(offerKey);
    return v === "pending" || v === "done" ? v : null;
  } catch {
    return null;
  }
}

/**
 * settleOffer decides, once logged in, whether to offer now: after a setup in
 * this browser, to an administrator, while the server has no saved recovery
 * key. A key saved meanwhile (another browser, the command) ends the offer.
 */
export function settleOffer(isAdmin: boolean, keysExportedAt: number): boolean {
  if (offerState() !== "pending" || !isAdmin) return false;
  if (keysExportedAt !== 0) {
    setOffer("done");
    return false;
  }
  return true;
}

// A confirmed save ends the offer, says so, and tells the Settings screen to
// show the new state.
const savedEvent = "nottennapod-recovery-key-saved";

export function recoveryKeySaved(sync: { notify(text: string): unknown }): void {
  setOffer("done");
  sync.notify(w("recovery_key_saved"));
  window.dispatchEvent(new Event(savedEvent));
}

export function onSaved(fn: () => void): () => void {
  window.addEventListener(savedEvent, fn);
  return () => window.removeEventListener(savedEvent, fn);
}
