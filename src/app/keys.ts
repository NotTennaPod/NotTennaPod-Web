// Android's hardware keyboard shortcuts (MainActivity.onKeyUp, and T and B in
// the episode lists, the podcast's list and the queue), with Space for play and
// pause as Android's video player has it. Keys typed into a field are the
// field's; keys with Ctrl, Alt or Command are the browser's.

/** KeyAction is what a key does in the app. */
export type KeyAction = "toggle" | "rewind" | "fast_forward" | "volume_up" | "volume_down" | "mute" | "top" | "bottom";

const actions: Record<string, KeyAction> = {
  p: "toggle",
  " ": "toggle",
  j: "rewind",
  a: "rewind",
  ",": "rewind",
  k: "fast_forward",
  d: "fast_forward",
  ".": "fast_forward",
  "+": "volume_up",
  w: "volume_up",
  "-": "volume_down",
  s: "volume_down",
  m: "mute",
  t: "top",
  b: "bottom",
};

/** The screens whose list T and B scroll (Android's episode lists, the podcast's list and the queue). */
export const listScreens = new Set(["queue", "inbox", "episodes", "history", "favorites", "podcast"]);

/** interactive is an element that takes Space itself (a button, a link, a menu item). */
function interactive(el: Element): boolean {
  return el.closest("button, a[href], summary, [role=button], [role=menuitem], [role=slider], [role=checkbox], [role=tab]") !== null;
}

/** typing is focus in a field, where every key is the field's. */
function typing(el: Element): boolean {
  return el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']") !== null;
}

/** keyAction is the app's action for a key press, or null when the key is not the app's. */
export function keyAction(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "target">, screen: string): KeyAction | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  const target = e.target instanceof Element ? e.target : null;
  if (target && typing(target)) return null;
  const action = actions[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (!action) return null;
  if (e.key === " " && target && interactive(target)) return null;
  if ((action === "top" || action === "bottom") && !listScreens.has(screen)) return null;
  return action;
}
