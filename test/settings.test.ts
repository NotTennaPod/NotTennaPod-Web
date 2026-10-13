// Browser preferences per screen: a screen that stays mounted while its subject
// changes (one podcast's page to another's) shows, and asks the server with,
// the new subject's setting from its first render.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

test("navigating from one podcast to another uses the other's saved sort from the first render", async () => {
  const win = new Window();
  Object.assign(globalThis, { window: win, document: win.document, localStorage: win.localStorage, HTMLElement: win.HTMLElement });
  try {
    const { h, render } = await import("preact");
    const { act } = await import("preact/test-utils");
    const { useLocalSetting } = await import("../src/ui/settings.ts");
    localStorage.setItem("nottennapod:-:podcast_sort:A", "date_new_old");
    localStorage.setItem("nottennapod:-:podcast_sort:B", "date_old_new");
    const rendered: string[] = [];
    let set!: (v: string) => void;
    // As Podcast does: the setting's name follows the id, and the episode request is made with what the render returns.
    function Screen({ id }: { id: string }) {
      const [sort, setSort] = useLocalSetting(`podcast_sort:${id}`, "date_new_old");
      set = setSort;
      rendered.push(`${id}:${sort}`);
      return h("div", null, sort);
    }
    const root = document.createElement("div");
    document.body.append(root);
    await act(async () => render(h(Screen, { id: "A" }), root));
    await act(async () => render(h(Screen, { id: "B" }), root));
    assert.equal(root.textContent, "date_old_new");
    assert.deepEqual(rendered, ["A:date_new_old", "B:date_old_new"], "B never renders with A's order");
    // A change is saved under the podcast shown, and each podcast keeps its own.
    await act(async () => set("title_a_z"));
    await act(async () => render(h(Screen, { id: "A" }), root));
    assert.equal(root.textContent, "date_new_old");
    await act(async () => render(h(Screen, { id: "B" }), root));
    assert.equal(root.textContent, "title_a_z");
    assert.equal(localStorage.getItem("nottennapod:-:podcast_sort:B"), "title_a_z");
    assert.equal(localStorage.getItem("nottennapod:-:podcast_sort:A"), "date_new_old");
    render(null, root);
  } finally {
    await win.happyDOM.close();
  }
});
