// Android's hardware keyboard shortcuts in the browser (MainActivity.onKeyUp;
// T and B in the lists): which key does what, and which keys stay with the
// browser or a field.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

test("keys map to Android's actions, except in fields, with modifiers, or Space on a control", async () => {
  const win = new Window();
  try {
    Object.assign(globalThis, { Element: win.Element });
    const { keyAction } = await import("../src/app/keys.ts");
    const doc = win.document;
    doc.body.innerHTML = '<input id="f"><textarea id="t"></textarea><button id="b">x</button><div id="d" role="menuitem">y</div><p id="p">z</p>';
    const el = (id: string) => doc.getElementById(id) as unknown as Element;
    const press = (key: string, target: Element | null = el("p"), mods: Partial<KeyboardEvent> = {}, screen = "home") =>
      keyAction({ key, ctrlKey: false, altKey: false, metaKey: false, target, ...mods }, screen);
    const expected: [string, string | null][] = [
      ["p", "toggle"], ["P", "toggle"], [" ", "toggle"],
      ["j", "rewind"], ["a", "rewind"], [",", "rewind"],
      ["k", "fast_forward"], ["d", "fast_forward"], [".", "fast_forward"],
      ["+", "volume_up"], ["w", "volume_up"], ["-", "volume_down"], ["s", "volume_down"], ["m", "mute"],
      ["Enter", null], ["x", null], ["ArrowLeft", null],
    ];
    for (const [key, action] of expected) assert.equal(press(key), action, key);
    assert.equal(press("p", null), "toggle", "focus nowhere");
    assert.equal(press("p", el("f")), null, "typing in a field");
    assert.equal(press("k", el("t")), null, "typing in a text area");
    assert.equal(press("p", el("b")), "toggle", "a letter on a button is the app's");
    assert.equal(press(" ", el("b")), null, "Space on a button is the button's");
    assert.equal(press(" ", el("d")), null, "Space on a menu item is the menu's");
    assert.equal(press("p", el("p"), { ctrlKey: true }), null, "Ctrl");
    assert.equal(press("p", el("p"), { metaKey: true }), null, "Command");
    assert.equal(press("p", el("p"), { altKey: true }), null, "Alt");
    for (const screen of ["queue", "inbox", "episodes", "history", "favorites", "podcast"]) {
      assert.equal(press("t", el("p"), {}, screen), "top", screen);
      assert.equal(press("b", el("p"), {}, screen), "bottom", screen);
    }
    assert.equal(press("t", el("p"), {}, "settings"), null, "T only scrolls a list");
    assert.equal(press("b", el("p"), {}, "home"), null, "B only scrolls a list");
  } finally {
    await win.happyDOM.close();
  }
});
