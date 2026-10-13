// Browser preferences: what Android keeps as device settings (list sort
// orders and filters, Home's sections), kept per account in this browser.
import { useState } from "preact/hooks";
import { currentAccount } from "../api/http.ts";

function storageKey(name: string): string {
  return `nottennapod:${currentAccount() ?? "-"}:${name}`;
}

export function readSetting(name: string, fallback: string): string {
  try {
    return localStorage.getItem(storageKey(name)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeSetting(name: string, value: string): void {
  try {
    localStorage.setItem(storageKey(name), value);
  } catch {
    /* private browsing: kept for this page only */
  }
}

/**
 * useLocalSetting is a setting kept in this browser. Its value follows its
 * name: a screen that stays mounted while the name changes (one podcast's
 * page to another's) has the new name's value from its first render.
 */
export function useLocalSetting(name: string, fallback: string): [string, (v: string) => void] {
  const [held, setHeld] = useState(() => ({ name, value: readSetting(name, fallback) }));
  const value = held.name === name ? held.value : readSetting(name, fallback);
  return [
    value,
    (next: string) => {
      setHeld({ name, value: next });
      writeSetting(name, next); // private browsing: kept for this page only
    },
  ];
}
