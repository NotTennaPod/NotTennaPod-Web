// Paged lists: a page answers only for the first page it continues; an answer
// for a replaced view never changes the rows shown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { settle, testSync } from "./viewSync.ts";

test("an obsolete page's answer leaves the newer view's rows alone", async () => {
  const win = new Window();
  try {
    await probe(win);
  } finally {
    await win.happyDOM.close();
  }
});

async function probe(win: Window) {
  Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement });
  const { h, render } = await import("preact");
  const { act } = await import("preact/test-utils");
  const { usePaged } = await import("../src/ui/paged.ts");
  const { SyncContext } = await import("../src/app/context.ts");

  let generation = 1;
  let list!: ReturnType<typeof usePaged<string>>;
  const delayed = new Map<string, (x: unknown) => void>();
  const load = async (q: { page_token?: string }) =>
    q.page_token
      ? new Promise<never>((r) => delayed.set(q.page_token!, r as (x: unknown) => void))
      : { head: { log_id: "log", epoch: 1, seq: generation, cursor: String(generation) }, items: [`page${generation}-first`], next_page_token: `p${generation}`, total: 200 };
  const sync = await testSync();
  function Probe() {
    list = usePaged<string>(load as never, []);
    return h("div", null, list.items?.join(","));
  }
  const root = document.createElement("div");
  document.body.append(root);
  await act(async () => render(h(SyncContext.Provider, { value: sync as never }, h(Probe, null)), root));
  await act(() => settle());
  let old!: Promise<void>;
  await act(async () => {
    old = list.loadMore();
  });
  generation = 2;
  await act(async () => list.reload());
  await act(() => settle());
  let newer!: Promise<void>;
  await act(async () => {
    newer = list.loadMore();
  });
  await act(async () => {
    delayed.get("p2")!({ items: ["page2-more"], next_page_token: null });
    await newer;
  });
  assert.equal(root.textContent, "page2-first,page2-more");
  await act(async () => {
    delayed.get("p1")!({ items: ["page1-more"], next_page_token: null });
    await old;
  });
  assert.equal(root.textContent, "page2-first,page2-more");
}
