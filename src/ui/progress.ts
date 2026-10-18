// Actions whose preparation reads the server (PROTOCOL §12): the screen shows progress until
// the action is journaled, and a failure says so. Nothing says an action is done before its
// entry commits.
import { ApiError, Unreachable } from "../api/http.ts";
import { FactTooLarge } from "../journal/journal.ts";
import { web } from "../webStrings.ts";

type Listener = () => void;

let working = 0;
const listeners = new Set<Listener>();
let report: (text: string) => void = () => {};

export function workingCount(): number {
  return working;
}

export function onWorking(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** workingValue follows how many actions are preparing (for useValue). */
export const workingValue = { get: workingCount, subscribe: onWorking };

/** reportFailuresTo names who shows a failed action's message (the shell's snackbar). */
export function reportFailuresTo(fn: (text: string) => void): void {
  report = fn;
}

export function failureText(e: unknown): string {
  if (e instanceof Unreachable) return web.server_unreachable;
  if (e instanceof FactTooLarge) return web.too_large_change;
  if (e instanceof ApiError || e instanceof Error) return e.message;
  return String(e);
}

function changed(by: number): void {
  working += by;
  for (const l of [...listeners]) l();
}

/** track shows progress while an action prepares and journals, and reports its failure. */
export async function track(p: void | Promise<void>): Promise<void> {
  if (!p) return;
  changed(1);
  try {
    await p;
  } catch (e) {
    report(failureText(e));
  } finally {
    changed(-1);
  }
}
