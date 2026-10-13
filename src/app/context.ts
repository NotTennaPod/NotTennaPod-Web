import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { Sync } from "./sync.ts";

export const SyncContext = createContext<Sync | undefined>(undefined);

export function useSync(): Sync {
  const s = useContext(SyncContext);
  if (!s) throw new Error("no sync context");
  return s;
}
