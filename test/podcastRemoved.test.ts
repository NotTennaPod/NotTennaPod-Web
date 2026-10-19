// A podcast removed on another device while its page is open here: once the
// server answers that it no longer has the podcast (404 not_found), the page
// stops showing it as the library's (PROTOCOL §12: views read published
// records only; a screen shows the view of its head).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import "./tsxHooks.ts";
import { settle, testSync, head } from "./viewSync.ts";

test("an open podcast page whose podcast another device removed no longer shows it", async () => {
  const win = new Window({ url: "http://localhost/" });
  try {
    await probe(win);
  } finally {
    await win.happyDOM.close();
  }
});

async function probe(win: Window) {
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    HTMLElement: win.HTMLElement,
    DOMParser: win.DOMParser,
    localStorage: win.localStorage,
    location: win.location,
  });
  const id = "p1:" + "b".repeat(64);
  let removed = false;
  let seq = 1;
  let gone = 0; // the rereads answered 404
  globalThis.fetch = (async (path: string) => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (removed) {
      gone++;
      return json(404, { error: "not_found", message: "Not found." });
    }
    if (path.startsWith(`/v1/read/podcasts/${encodeURIComponent(id)}/episodes`)) {
      return json(200, { head: head(seq), view: { counters: {} }, total: 0, items: [], next_page_token: null });
    }
    if (path.startsWith(`/v1/read/podcasts/${encodeURIComponent(id)}`)) {
      return json(200, {
        head: head(seq),
        counters: {},
        podcast: { podcast_id: id, title: "Removed show", display_title: "Removed show", image_url: "", state: "subscribed", keep_updated: true, credentials: false, records: {}, generation_id: "g1:" + "a".repeat(64) },
      });
    }
    return json(404, { error: "not_found", message: "Not found." });
  }) as unknown as typeof fetch;

  const { h, render } = await import("preact");
  const { act } = await import("preact/test-utils");
  const { Podcast } = await import("../src/screens/Podcast.tsx");
  const { SyncContext } = await import("../src/app/context.ts");
  const sync = await testSync();
  const root = document.createElement("div");
  document.body.append(root);
  await act(async () => render(h(SyncContext.Provider, { value: sync as never }, h(Podcast, { id })), root));
  await act(() => settle(60));
  assert.match(root.textContent ?? "", /Removed show/, "the podcast is shown");

  // Another device unsubscribes: the server's head moves on, and the podcast is gone from the library.
  removed = true;
  seq = 2;
  await act(async () => sync.known.set({ log_id: head(2).log_id, epoch: 1, seq: 2 }));
  await act(() => settle(60));
  assert.ok(gone > 0, "the page read the podcast again");
  assert.doesNotMatch(root.textContent ?? "", /Removed show/, "the removed podcast is still shown as the library's, with its settings and actions");
}

test("a 404 clears only a screen of one podcast or episode; other screens keep what they show", async () => {
  const win = new Window({ url: "http://localhost/" });
  Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement });
  try {
    const { h, render } = await import("preact");
    const { act } = await import("preact/test-utils");
    const { useView } = await import("../src/app/useView.ts");
    const { SyncContext } = await import("../src/app/context.ts");
    const { ApiError } = await import("../src/api/http.ts");
    for (const entity of [true, false]) {
      let seq = 1;
      let gone = false;
      const shown: (string | undefined)[] = [];
      function Probe() {
        const v = useView(async () => {
          if (gone) throw new ApiError(404, "not_found", "Not found.");
          return { head: head(seq), title: "Shown" };
        }, [], { entity });
        shown.push(v.data?.title);
        return null;
      }
      const sync = await testSync();
      const root = document.createElement("div");
      await act(async () => render(h(SyncContext.Provider, { value: sync as never }, h(Probe, null)), root));
      await act(() => settle(60));
      assert.equal(shown.at(-1), "Shown");
      gone = true;
      seq = 2;
      await act(async () => sync.known.set({ log_id: head(2).log_id, epoch: 1, seq: 2 }));
      await act(() => settle(60));
      assert.equal(shown.at(-1), entity ? undefined : "Shown", entity ? "the entity is no longer shown" : "a list or summary keeps what it shows");
      await act(async () => render(null, root));
    }
  } finally {
    await win.happyDOM.close();
  }
});
