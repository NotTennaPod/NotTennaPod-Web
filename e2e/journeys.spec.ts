// The web client's journeys (PROTOCOL §12), in one account per browser: set up and log
// in; import an Android backup into the empty account; favorite; remove from
// the Inbox and Undo; queue add, move and remove; history remove, Undo and
// clear; statistics reset; subscribe from an address; and a phone's change
// arriving by event. Every action is checked on the server through the read
// API, not only on screen.
import { expect, test, type Page, type BrowserContext, type Response as Answer } from "@playwright/test";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serverRepo } from "./support/build.ts";
import { startFeeds, startServer, type Feeds, type RunningServer } from "./support/server.ts";
import { notNow } from "./support/offer.ts";

test.describe.configure({ mode: "serial" });

let server: RunningServer;
let feeds: Feeds;
let context: BrowserContext;
let page: Page;

const user = "owner";
const password = "correct horse battery";

test.beforeAll(async ({ browser }) => {
  server = await startServer();
  feeds = await startFeeds();
  context = await browser.newContext();
  context.on("response", (r) => void watchPush(r));
  page = await context.newPage();
});

/** pushed are the facts the browser pushed, with the outcome of their receipts (by the push's responses). */
const pushed: { op_id: string; type: string; payload: Record<string, unknown>; outcome?: string; reason?: string }[] = [];

async function watchPush(r: Answer): Promise<void> {
  if (!r.url().endsWith("/v1/push") || r.request().method() !== "POST") return;
  const operations = ((r.request().postDataJSON() as { operations?: { fact?: { op_id: string; type: string; payload: Record<string, unknown> } }[] } | null)?.operations ?? []);
  const facts = new Map(operations.flatMap((o) => (o.fact ? [[o.fact.op_id, { ...o.fact }] as const] : [])));
  const body = (await r.json().catch(() => null)) as { results?: { receipt?: { op_id: string; outcome: string; reason?: string } }[] } | null;
  for (const x of body?.results ?? []) {
    const f = x.receipt && facts.get(x.receipt.op_id);
    if (f) pushed.push({ op_id: f.op_id, type: f.type, payload: f.payload, outcome: x.receipt!.outcome, reason: x.receipt!.reason });
  }
}

/** queueRefusals are the queue changes (and play starts, which may add to the queue) the server rejected. */
const queueRefusals = () => pushed.filter((f) => (f.type.startsWith("queue.") || f.type === "session.start") && f.outcome === "rejected").map((f) => `${f.type}: ${f.reason}`);

test.afterAll(async () => {
  await context?.close();
  await feeds?.stop();
  await server?.stop();
});

/** read calls the read API from the page (its session cookie). */
async function read<T = Record<string, unknown>>(path: string): Promise<T> {
  return page.evaluate(async (p) => (await fetch(p)).json(), path) as Promise<T>;
}

async function episodes(path: string): Promise<{ episode_id: string; title: string; favorite: boolean; in_queue: boolean; play_state: string; history: number | null }[]> {
  return (await read<{ items: never[] }>(path)).items;
}

/** settled waits until the browser's journal has pushed everything. */
async function settled(): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const db: IDBDatabase = await new Promise((r) => {
            const q = indexedDB.open("nottennapod");
            q.onsuccess = () => r(q.result);
          });
          const all: { receipt: unknown }[] = await new Promise((r) => {
            const q = db.transaction("journal").objectStore("journal").getAll();
            q.onsuccess = () => r(q.result);
          });
          db.close();
          return all.filter((e) => !e.receipt).length;
        }),
      { timeout: 20_000 },
    )
    .toBe(0);
}

async function menu(row: ReturnType<Page["locator"]>, item: string): Promise<void> {
  await row.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

test("set up, log out and log in", async () => {
  await page.goto(server.base + "/");
  await page.getByLabel("Setup code").fill(server.setupCode);
  await page.getByLabel("Username").fill(user);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator("nav.drawer")).toBeVisible();
  await notNow(page);
  await page.goto(server.base + "/settings");
  // A logout the server does not confirm keeps the session, and says so.
  for (const answer of [{ status: 503, body: "" }, { status: 503, body: '{"error":"server_busy","message":"Try again."}' }]) {
    await page.route("**/v1/auth/web/sign-out", (r) => r.fulfill({ status: answer.status, contentType: "application/json", body: answer.body }));
    await page.getByRole("button", { name: "Logout" }).click();
    await expect(page.getByText(/^Could not log out\. You are still logged in\./)).toBeVisible();
    await page.unroute("**/v1/auth/web/sign-out");
    expect(await page.evaluate(async () => (await fetch("/v1/session")).status)).toBe(200);
    await expect(page.locator("nav.drawer")).toBeVisible();
  }
  await page.getByRole("button", { name: "Logout" }).click();
  await expect(page.getByRole("heading", { name: "Log in to NotTennaPod" })).toBeVisible();
  await page.getByLabel("Username").fill(user);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.locator("nav.drawer")).toBeVisible();
});

test("the import rows are reached with Tab, and Enter opens each one's file chooser", async ({ browserName }) => {
  // Safari's Tab skips buttons unless the person turned that on; Option+Tab reaches them.
  const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
  await page.goto(server.base + "/add");
  await page.getByLabel("Add podcast by RSS address").focus();
  for (const [name, accept] of [["Import podcast list (OPML)", /^\.opml/], ["Database import", /^\.db/]] as const) {
    const row = page.getByRole("button", { name, exact: true });
    await expect(row).toBeVisible();
    for (let i = 0; i < 10 && !(await row.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press(tab);
    await expect(row).toBeFocused();
    const chooser = page.waitForEvent("filechooser");
    await page.keyboard.press("Enter");
    expect(await (await chooser).element().getAttribute("accept")).toMatch(accept);
  }
});

test("an import whose file cannot be read says so; a path that does not decode is not found", async () => {
  await page.goto(server.base + "/add");
  // A file the browser cannot read (a disconnected drive, say) ends the import with its error.
  await page.evaluate(() => {
    const w = window as unknown as { realArrayBuffer?: typeof Blob.prototype.arrayBuffer };
    w.realArrayBuffer = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = () => Promise.reject(new DOMException("The file could not be read.", "NotReadableError"));
  });
  await page.locator("input[type=file][accept^='.db']").setInputFiles({ name: "Unreadable.db", mimeType: "application/octet-stream", buffer: Buffer.from("SQLite format 3\0") });
  await expect(page.getByRole("status")).toHaveText("Import error: The file could not be read.");
  await page.evaluate(() => {
    const w = window as unknown as { realArrayBuffer?: typeof Blob.prototype.arrayBuffer };
    Blob.prototype.arrayBuffer = w.realArrayBuffer!;
  });
  await page.goto(server.base + "/episode/%FF");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(page.locator("nav.drawer")).toBeVisible();
});

test("import an Android backup into the empty account", async () => {
  await page.goto(server.base + "/add");
  const file = join(serverRepo, "internal", "importer", "androiddb", "testdata", "android-3.12.1", "emulator-parity-library.db");
  await page.locator("input[type=file][accept^='.db']").setInputFiles({ name: "AntennaPodBackup.db", mimeType: "application/octet-stream", buffer: readFileSync(file) });
  await expect(page.getByText("The AntennaPod backup imported.")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/^Imported \d+ podcasts and \d+ episodes: 9 in the queue/)).toBeVisible();
  // The podcasts whose settings stay on the device the backup came from (seven in this library) are listed.
  await page.getByText("Podcast settings not imported (7)").click();
  // Four of its feeds share a title: each is told apart by its address.
  await expect(page.getByText(/^Automatic download lab \(https?:\/\/\S+\): Include in auto downloads, Episode filter$/)).toHaveCount(4);
  const summary = await read<{ counters: { queue: number; inbox: number } }>("/v1/read/summary");
  expect(summary.counters).toEqual({ queue: 9, inbox: 1 });
  await page.goto(server.base + "/queue");
  await expect(page.locator(".episode")).toHaveCount(9);
  // Settings shows the account's import and its report after a reload.
  await page.goto(server.base + "/settings");
  await expect(page.getByText("The AntennaPod backup imported.")).toBeVisible();
});

test("favorite an episode", async () => {
  await page.goto(server.base + "/episodes");
  const row = page.locator(".episode").first();
  const title = await row.locator(".episode-title").innerText();
  await menu(row, "Add to favorites");
  await expect.poll(async () => (await episodes("/v1/read/favorites")).map((e) => e.title)).toContain(title);
  await page.goto(server.base + "/favorites");
  await expect(page.locator(".episode-title", { hasText: title })).toBeVisible();
  expect((await episodes("/v1/read/favorites")).map((e) => e.title)).toContain(title);
  // A right-click opens the row's menu at the pointer (Android's long-press menu).
  const fav = page.locator(".episode", { hasText: title });
  const box = (await fav.locator(".episode-title").boundingBox())!;
  await fav.locator(".episode-title").click({ button: "right" });
  const list = page.getByRole("menu");
  await expect(list).toBeVisible();
  const at = (await list.boundingBox())!;
  expect(Math.abs(at.x - (box.x + box.width / 2)), "opens at the pointer").toBeLessThan(box.width / 2 + 220);
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await fav.locator(".episode-title").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove from favorites" }).click();
  await expect.poll(async () => (await episodes("/v1/read/favorites")).map((e) => e.title)).not.toContain(title);
  // Favorite it again for the journeys that follow.
  await page.goto(server.base + "/episodes");
  await menu(page.locator(".episode", { hasText: title }).first(), "Add to favorites");
  await expect.poll(async () => (await episodes("/v1/read/favorites")).map((e) => e.title)).toContain(title);
});

test("remove from the Inbox, then Undo", async () => {
  await page.goto(server.base + "/inbox");
  await menu(page.locator(".episode").first(), "Remove from inbox");
  await expect(page.getByText("No episodes in the inbox")).toBeVisible();
  const inbox = async () => (await read<{ counters: { inbox: number } }>("/v1/read/summary")).counters.inbox;
  await expect.poll(inbox).toBe(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".episode")).toHaveCount(1);
  await expect.poll(inbox).toBe(1);
});

test("queue: add at the back, move to the top, remove and Undo", async () => {
  const unqueued = (await episodes("/v1/read/episodes?filter=not_queued,has_media&limit=1"))[0]!;
  const queueIds = async () => (await episodes("/v1/read/queue")).map((e) => e.episode_id);
  await page.goto(server.base + `/episode/${encodeURIComponent(unqueued.episode_id)}`);
  await page.locator(".toolbar").getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Add to queue" }).click();
  await expect.poll(async () => (await queueIds()).at(-1)).toBe(unqueued.episode_id);
  await page.goto(server.base + "/queue");
  await expect(page.locator(".episode")).toHaveCount(10);
  await menu(page.locator(".episode").last(), "Move to top");
  await expect.poll(async () => (await queueIds())[0]).toBe(unqueued.episode_id);
  await page.reload();
  await expect(page.locator(".episode").first().locator(".episode-title")).toHaveText(unqueued.title);
  await menu(page.locator(".episode").first(), "Remove from queue");
  await expect.poll(queueIds).not.toContain(unqueued.episode_id);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await queueIds())[0]).toBe(unqueued.episode_id);
  await settled();
  expect(queueRefusals()).toEqual([]);
});

test("multi select: from a row's menu, Shift-click for a range, an action on the selection, and the queue's moves", async () => {
  const queueIds = async () => (await episodes("/v1/read/queue")).map((e) => e.episode_id);
  await page.goto(server.base + "/queue");
  const rows = page.locator(".episode");
  await expect(rows).toHaveCount(10);
  const before = await queueIds();
  // "Multi select" in a row's menu starts selecting with that row.
  await menu(rows.nth(0), "Multi select");
  const bar = page.locator(".toolbar.action-mode");
  await expect(bar.getByRole("heading")).toHaveText("1/10 selected");
  await expect(page.getByRole("toolbar", { name: "Multi select" })).toBeVisible();
  // Shift-click selects the range from the last row clicked; a click selects and deselects.
  await rows.nth(2).getByRole("checkbox").click({ modifiers: ["Shift"] });
  await expect(bar.getByRole("heading")).toHaveText("3/10 selected");
  await expect(rows.nth(1)).toHaveClass(/selected/);
  await rows.nth(5).getByRole("checkbox").click();
  await expect(bar.getByRole("heading")).toHaveText("4/10 selected");
  await rows.nth(5).getByRole("checkbox").click();
  await expect(bar.getByRole("heading")).toHaveText("3/10 selected");
  await page.screenshot({ path: ".work/multi-select.png" });
  // The queue's actions: no Add to queue; Move to top hidden for the top block, Move to bottom shown.
  const actions = page.getByRole("toolbar", { name: "Multi select" });
  await expect(actions.getByRole("button", { name: "Add to queue" })).toHaveCount(0);
  await expect(actions.getByRole("button", { name: "Move to top" })).toHaveCount(0);
  await actions.getByRole("button", { name: "Move to bottom" }).click();
  await expect(bar).toHaveCount(0);
  await expect.poll(queueIds).toEqual([...before.slice(3), ...before.slice(0, 3)]);
  // Select all, then Deselect all keeps the mode; Escape ends it.
  await menu(rows.nth(0), "Multi select");
  await bar.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Select all", exact: true }).click();
  await expect(bar.getByRole("heading")).toHaveText("10/10 selected");
  await bar.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Deselect all" }).click();
  await expect(bar.getByRole("heading")).toHaveText("0/10 selected");
  await actions.getByRole("button").first().click();
  await expect(page.locator(".snackbar", { hasText: "No items selected" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bar).toHaveCount(0);
  await expect(page.locator(".toolbar h1")).toHaveText("Queue");
  // In another list: favorite a range, checked on the server; the selection ends.
  await page.goto(server.base + "/episodes");
  const target = (await episodes("/v1/read/episodes?limit=3")).map((e) => e.title);
  await menu(page.locator(".episode").nth(0), "Multi select");
  await page.locator(".episode").nth(2).getByRole("checkbox").click({ modifiers: ["Shift"] });
  const add = actions.getByRole("button", { name: "Add to favorites" });
  if (await add.count()) {
    await add.click();
    await expect.poll(async () => (await episodes("/v1/read/favorites")).map((e) => e.title)).toEqual(expect.arrayContaining(target));
  } else {
    await actions.getByRole("button", { name: "Remove from favorites" }).click();
    await expect.poll(async () => (await episodes("/v1/read/favorites")).map((e) => e.title).filter((x) => target.includes(x))).toEqual([]);
  }
  await expect(page.locator(".toolbar.action-mode")).toHaveCount(0);
  await settled();
  expect(queueRefusals()).toEqual([]);
});

test("queue: the sort dialog sorts on the server, Keep sorted places an add at its sorted place, and Random keeps the order drawn", async () => {
  const queue = async () => (await episodes("/v1/read/queue")).map((e) => ({ id: e.episode_id, title: e.title }));
  // The canonical title order (Unicode simple lowercase, per code point), on titles the queue shows.
  const fold = (t: string) => [...t].map((c) => c.toLowerCase().codePointAt(0)!);
  const byTitle = (a: string, b: string) => {
    const x = fold(a), y = fold(b);
    for (let i = 0; i < x.length && i < y.length; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
    return x.length - y.length;
  };
  const sorted = (titles: string[], dir: 1 | -1) => titles.every((t, i) => i === 0 || dir * byTitle(titles[i - 1]!, t) <= 0);
  const sortDialog = async () => {
    await page.locator(".toolbar").getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Sort" }).click();
    return page.getByRole("dialog", { name: "Sort" });
  };
  await page.goto(server.base + "/queue");
  await expect(page.locator(".episode")).toHaveCount(10);
  let dialog = await sortDialog();
  await dialog.getByRole("button", { name: "Episode title" }).click(); // A→Z
  await expect.poll(async () => sorted((await queue()).map((e) => e.title), 1)).toBe(true);
  await dialog.getByRole("button", { name: "Episode title" }).click(); // Z→A
  await expect.poll(async () => sorted((await queue()).map((e) => e.title), -1)).toBe(true);
  // Keep sorted: the policy, and a sort that changes nothing (sent all the same).
  const before = await queue();
  await dialog.getByRole("checkbox", { name: "Keep sorted" }).check();
  await expect.poll(async () => (await read<{ policies: { queue: { keep_sorted: boolean; sort_order: string } } }>("/v1/read/summary")).policies.queue)
    .toEqual(expect.objectContaining({ keep_sorted: true, sort_order: "episode_title_z_a" }));
  await dialog.getByRole("button", { name: "Close" }).click();
  await settled();
  expect(await queue()).toEqual(before);
  // An add lands at its sorted place, wherever the enqueue location put it first.
  const unqueued = (await episodes("/v1/read/episodes?filter=not_queued,has_media&limit=1"))[0]!;
  await page.goto(server.base + `/episode/${encodeURIComponent(unqueued.episode_id)}`);
  await page.locator(".toolbar").getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Add to queue" }).click();
  await expect.poll(async () => (await queue()).map((e) => e.id)).toContain(unqueued.episode_id);
  expect(sorted((await queue()).map((e) => e.title), -1)).toBe(true);
  // Random turns Keep sorted off; the server keeps the order this browser drew.
  await page.goto(server.base + "/queue");
  await expect(page.locator(".episode")).toHaveCount(11);
  dialog = await sortDialog();
  await dialog.getByRole("button", { name: "Random" }).click();
  await expect(dialog.getByRole("checkbox", { name: "Keep sorted" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Close" }).click();
  await settled();
  const random = pushed.filter((f) => f.type === "queue.reorder" && (f.payload.sort as { sort_order?: string } | undefined)?.sort_order === "random").at(-1);
  const drawn = (random?.payload.sort as { permutation: { episode_id: string }[] }).permutation.map((r) => r.episode_id);
  await expect.poll(async () => (await queue()).map((e) => e.id)).toEqual(drawn);
  expect((await read<{ policies: { queue: { keep_sorted: boolean } } }>("/v1/read/summary")).policies.queue.keep_sorted).toBe(false);
  expect(queueRefusals()).toEqual([]);
});

test("history: remove, Undo, then clear", async () => {
  await page.goto(server.base + "/history");
  const before = await episodes("/v1/read/history");
  expect(before.length).toBeGreaterThan(1);
  const first = page.locator(".episode").first();
  const title = await first.locator(".episode-title").innerText();
  await menu(first, "Remove from history");
  await expect.poll(async () => (await episodes("/v1/read/history")).map((e) => e.title)).not.toContain(title);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await episodes("/v1/read/history")).length).toBe(before.length);
  await page.reload();
  await page.locator(".toolbar").getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Clear history" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("No history")).toBeVisible();
  await expect.poll(async () => (await episodes("/v1/read/history")).length).toBe(0);
});

test("statistics reset", async () => {
  const before = await read<{ played_ms: number }>("/v1/read/statistics");
  expect(before.played_ms).toBeGreaterThan(0);
  await page.goto(server.base + "/statistics");
  await page.locator(".toolbar").getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Reset statistics data" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(async () => (await read<{ played_ms: number }>("/v1/read/statistics")).played_ms).toBe(0);
});

test("subscribe from an address", async () => {
  await page.goto(server.base + "/add");
  await page.getByLabel("Add podcast by RSS address").fill(feeds.url);
  await page.getByRole("button", { name: "Episodes preview" }).click();
  await expect(page.getByRole("heading", { name: "Journey Show" })).toBeVisible();
  await expect(page.getByText("Journey episode 3")).toBeVisible();
  await page.getByRole("button", { name: "Subscribe" }).click();
  // The server's first fetch fills the podcast in.
  await expect
    .poll(async () => (await read<{ items: { display_title: string }[] }>("/v1/read/subscriptions?limit=500")).items.map((p) => p.display_title), {
      timeout: 60_000,
    })
    .toContain("Journey Show");
  await page.goto(server.base + "/subscriptions");
  await page.locator(".subscription-grid").getByRole("link", { name: "Journey Show" }).click();
  await expect(page.locator(".episode-title", { hasText: "Journey episode 1" })).toBeVisible({ timeout: 30_000 });
});

test("a podcast unsubscribed here is added again from its address, and opens fresh", async () => {
  const id = (await subscription("Journey Show"))!.podcast_id;
  // A favorite of the podcast as it was, which a re-add does not bring back.
  await page.goto(`${server.base}/podcast/${encodeURIComponent(id)}`);
  await menu(page.locator(".episode", { hasText: "Journey episode 1" }), "Add to favorites");
  await expect.poll(async () => (await episodes("/v1/read/favorites")).map((e) => e.title)).toContain("Journey episode 1");
  // Unsubscribe through Android's dialog (asked once more).
  await page.locator(".toolbar").getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Unsubscribe / archive" }).click();
  const remove = page.getByRole("dialog", { name: "Unsubscribe / archive" });
  await remove.getByRole("button", { name: "Unsubscribe" }).click();
  await remove.getByRole("button", { name: "Unsubscribe" }).click();
  await expect.poll(async () => (await subscription("Journey Show"))?.podcast_id ?? "").toBe("");
  // The same address again: the preview offers Subscribe, not a podcast that cannot open.
  await page.goto(server.base + "/add");
  await page.getByLabel("Add podcast by RSS address").fill(feeds.url);
  await page.getByRole("button", { name: "Episodes preview" }).click();
  await expect(page.getByRole("heading", { name: "Journey Show" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open podcast" })).toHaveCount(0);
  await page.getByRole("button", { name: "Subscribe", exact: true }).click();
  // The same podcast, fresh: it opens with its episodes, and the old favorite stays gone.
  await expect.poll(async () => (await subscription("Journey Show"))?.podcast_id ?? "", { timeout: 60_000 }).toBe(id);
  await settled();
  const resubscribe = pushed.filter((f) => f.type === "podcast.subscribe" && f.payload.observed).at(-1);
  expect(resubscribe?.outcome).toBe("applied");
  await page.goto(`${server.base}/podcast/${encodeURIComponent(id)}`);
  await expect(page.locator(".toolbar h1")).toHaveText("Journey Show");
  await expect(page.locator(".episode-title", { hasText: "Journey episode 1" })).toBeVisible({ timeout: 30_000 });
  expect((await episodes("/v1/read/favorites")).map((e) => e.title)).not.toContain("Journey episode 1");
});

test("a private feed's login longer than the server keeps is refused before anything is saved; a refused push says so", async () => {
  await page.goto(server.base + "/add");
  await page.getByLabel("Add podcast by RSS address").fill(feeds.url.replace("feed.xml", "private.xml"));
  await page.getByRole("button", { name: "Episodes preview" }).click();
  const login = page.locator("form").filter({ has: page.getByLabel("Password") });
  await login.getByLabel("Username").fill("alice");
  // 2,049 characters, but 4,098 bytes in UTF-8: more than the server's 4,096.
  await login.getByLabel("Password").fill("é".repeat(2049));
  const previews: string[] = [];
  page.on("request", (r) => r.url().endsWith("/v1/read/preview") && previews.push(r.postData() ?? ""));
  await login.getByRole("button", { name: "Confirm" }).click();
  await expect(login.getByRole("alert")).toHaveText("The username or the password is too long.");
  expect(previews).toEqual([]);
  await login.getByLabel("Password").fill("s3cret");
  await login.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("heading", { name: "Private Show" })).toBeVisible();
  await expect(login.getByRole("alert")).toHaveCount(0);

  // A push the server refuses as invalid is shown, kept, and sent again once the server takes it.
  await page.route("**/v1/push", (r) =>
    r.fulfill({ status: 400, contentType: "application/json", body: '{"error":"invalid_request","message":"A secret\'s username and password are at most 4096 bytes each."}' }),
  );
  await page.goto(server.base + "/episodes");
  const target = (await episodes("/v1/read/episodes?filter=not_favorite,include_subscribed&limit=1"))[0]!;
  await menu(page.locator(".episode").filter({ has: page.locator(".episode-title", { hasText: target.title }) }).first(), "Add to favorites");
  await expect(page.getByRole("alert").filter({ hasText: "The server refused this browser's changes" })).toHaveText(
    "The server refused this browser's changes: A secret's username and password are at most 4096 bytes each. They are kept, and sent again later.",
  );
  await page.unroute("**/v1/push");
  await expect(page.getByRole("alert").filter({ hasText: "The server refused this browser's changes" })).toHaveCount(0, { timeout: 70_000 });
});

test("a private feed's login changed in its settings (Android's Authentication) is saved, and the server fetches with it", async () => {
  // The facts this tab pushes, by op ID: what each step journaled.
  const pushed = new Map<string, string>();
  const onPush = (r: { url(): string; postDataJSON(): unknown }) => {
    if (!r.url().endsWith("/v1/push")) return;
    for (const o of (r.postDataJSON() as { operations?: { fact: { op_id: string; type: string } }[] }).operations ?? []) pushed.set(o.fact.op_id, o.fact.type);
  };
  page.on("request", onPush);
  const changes = async () => {
    await settled();
    return [...pushed.values()].filter((type) => type === "podcast.set_credentials").length;
  };
  try {
    // Subscribe to the private feed with its login.
    await page.goto(server.base + "/add");
    await page.getByLabel("Add podcast by RSS address").fill(feeds.url.replace("feed.xml", "private.xml"));
    await page.getByRole("button", { name: "Episodes preview" }).click();
    const login = page.locator("form").filter({ has: page.getByLabel("Password") });
    await login.getByLabel("Username").fill("alice");
    await login.getByLabel("Password").fill("s3cret");
    await login.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("heading", { name: "Private Show" })).toBeVisible();
    await page.getByRole("button", { name: "Subscribe", exact: true }).click();
    let id = "";
    await expect
      .poll(async () => (id = (await read<{ items: { podcast_id: string; display_title: string }[] }>("/v1/read/subscriptions?limit=500")).items.find((p) => p.display_title === "Private Show")?.podcast_id ?? ""), {
        timeout: 70_000,
      })
      .not.toBe("");
    const credentials = async () => (await read<{ podcast: { credentials: unknown } }>(`/v1/read/podcasts/${encodeURIComponent(id)}`)).podcast.credentials;
    expect(await credentials()).toEqual({ set: true, username: "alice" });
    await page.goto(`${server.base}/podcast/${encodeURIComponent(id)}`);
    await expect(page.getByText("Authentication: alice")).toBeVisible();
    // The publisher changes the password.
    feeds.setPrivateLogin("alice", "n3w secret");

    // The podcast's settings: Authentication, with the username; the browser is never given the password.
    const open = async () => {
      await page.locator(".toolbar").getByRole("button", { name: "More" }).click();
      await page.getByRole("menuitem", { name: "Authentication", exact: true }).click();
      const d = page.getByRole("dialog", { name: "Authentication" });
      await expect(d).toBeVisible();
      return d;
    };
    let d = await open();
    await expect(d.getByLabel("Username")).toHaveValue("alice");
    await expect(d.getByLabel("Password", { exact: true })).toHaveValue("");
    await d.getByRole("button", { name: "Cancel" }).click();
    await expect(d).toHaveCount(0);
    // Confirm without a new password keeps the saved login: nothing changes.
    d = await open();
    await d.getByRole("button", { name: "Confirm" }).click();
    await expect(d).toHaveCount(0);
    expect(await changes()).toBe(0);
    // A changed username needs its password.
    d = await open();
    await d.getByLabel("Username").fill("bob");
    await d.getByRole("button", { name: "Confirm" }).click();
    await expect(d).toBeVisible();
    await expect(d.locator("input[name=password]:invalid")).toHaveCount(1);
    expect(await changes()).toBe(0);
    // The new password, while the feed is down: the dialog cannot tell where the login belongs, so it
    // says so, records nothing (the saved login and its origin stay) and keeps what was typed for another try.
    await d.getByLabel("Username").fill("alice");
    const password = d.getByLabel("Password", { exact: true });
    await password.fill("n3w secret");
    feeds.failNext();
    await d.getByRole("button", { name: "Confirm" }).click();
    await expect(d.getByRole("alert")).toHaveText("The username and password were not saved: HTTP data error");
    await expect(d).toBeVisible();
    await expect(password).toHaveValue("n3w secret");
    expect(await changes()).toBe(0);
    expect(await credentials()).toEqual({ set: true, username: "alice" });
    // Shown and hidden again with Android's eye button, then Confirm again, the feed back.
    await expect(password).toHaveAttribute("type", "password");
    await d.getByRole("button", { name: "Show password" }).click();
    await expect(d.getByRole("button", { name: "Show password" })).toHaveAttribute("aria-pressed", "true");
    await expect(password).toHaveAttribute("type", "text");
    await expect(password).toHaveValue("n3w secret");
    await d.getByRole("button", { name: "Show password" }).click();
    await expect(password).toHaveAttribute("type", "password");
    await d.getByRole("button", { name: "Confirm" }).click();
    await expect(d).toHaveCount(0);
    expect(await changes()).toBe(1);
    expect(await credentials()).toEqual({ set: true, username: "alice" });
    // The server refreshes the podcast with the new login, as Android refreshes after a change.
    await expect.poll(() => feeds.logins.includes("alice:n3w secret"), { timeout: 70_000 }).toBe(true);

    // No username is no login (Android): the podcast's credentials are removed.
    d = await open();
    await d.getByLabel("Username").fill("");
    await d.getByRole("button", { name: "Confirm" }).click();
    await expect(d).toHaveCount(0);
    expect(await changes()).toBe(2);
    expect(await credentials()).toEqual({ set: false });
    await expect(page.getByText(/^Authentication:/)).toHaveCount(0);
  } finally {
    page.off("request", onPush);
  }
});

test("a phone's change arrives by event", async () => {
  await page.goto(server.base + "/favorites");
  const target = (await episodes("/v1/read/episodes?filter=not_favorite,include_subscribed&limit=1"))[0]!;
  await expect(page.locator(".episode-title", { hasText: target.title })).toHaveCount(0);
  // A phone signs in and favorites the episode.
  const phone = await page.evaluate(
    async ({ user, password, id }) => {
      const json = (r: Response) => r.json();
      const install = crypto.randomUUID();
      const signIn = await fetch("/v1/auth/device", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user, password, install_id: install, instance_nonce: crypto.randomUUID(),
          device: { name: "Phone", platform: "ios", app_version: "1", capabilities: ["favorites"] } }),
      }).then(json);
      const auth = { Authorization: `Bearer ${signIn.token}`, "Content-Type": "application/json" };
      const ep = await fetch(`/v1/read/episodes/${encodeURIComponent(id)}`).then(json);
      const e = ep.episode;
      const ref = { episode_id: e.episode_id, podcast_id: e.podcast_id, generation_id: e.podcast.generation_id, occurrence: e.records.identity.value.occurrence };
      const cursor = ep.head.cursor;
      const fact = { op_id: crypto.randomUUID(), author_id: crypto.randomUUID(), author_seq: 1, dependencies: [], type: "favorite.set", type_version: 1,
        client_time: Date.now(), targets: [{ entity: "episode", id: e.episode_id, generation: ref.generation_id }], payload: { episode: ref, on: true } };
      const res = await fetch("/v1/push", { method: "POST", headers: auth,
        body: JSON.stringify({ cursor, install_id: install, acked_install_seq: 0, operations: [{ install_seq: 1, fact }] }) }).then(json);
      return res.results?.[0]?.status ?? JSON.stringify(res);
    },
    { user, password, id: target.episode_id },
  );
  expect(phone).toBe("accepted");
  // The open Favorites screen shows it without a reload (the event stream).
  await expect(page.locator(".episode-title", { hasText: target.title })).toBeVisible({ timeout: 15_000 });
});

test("on a plain-HTTP origin (no crypto.randomUUID or crypto.subtle) the app and its player start and actions save", async () => {
  const p = await context.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.addInitScript(() => {
    // What a browser offers an insecure context.
    Object.defineProperty(crypto, "randomUUID", { value: undefined });
    Object.defineProperty(crypto, "subtle", { value: undefined });
  });
  await p.goto(server.base + "/episodes");
  await expect(p.locator(".nav-item[href='/queue']")).toBeVisible();
  const row = p.locator(".episode").first();
  const title = await row.locator(".episode-title").innerText();
  await row.getByRole("button", { name: "More" }).click();
  const item = p.getByRole("menuitem", { name: /favorites/i });
  const adding = (await item.innerText()).toLowerCase().includes("add");
  await item.click();
  await expect
    .poll(async () => (await episodes("/v1/read/episodes?limit=500")).find((e) => e.title === title)?.favorite)
    .toBe(adding);
  expect(errors, errors.join("\n")).toEqual([]);
  await p.close();
});

test("the administrator's Server section shows the backups, the keys and how to run the server", async () => {
  await page.goto(server.base + "/settings");
  const section = page.locator(".server-section");
  await expect(section.getByRole("heading", { name: "Server" })).toBeVisible();
  await expect(section.getByText(/^Daily backups in .+: \d+ kept/)).toBeVisible();
  await expect(section.getByText(/^This server has no saved recovery key\./)).toBeVisible();
  await section.getByText("Instructions").click();
  await expect(section.getByText(/tailscale serve --bg http:\/\/127\.0\.0\.1:8080/)).toBeVisible();
});

test("Server section: Back up now makes a compressed backup, and the copies never deleted automatically are listed", async () => {
  await page.goto(server.base + "/settings");
  const section = page.locator(".server-section");
  const now = section.locator(".server-backup-now");
  const backUp = now.getByRole("button", { name: "Back up now" });
  await expect(backUp).toBeEnabled();
  await expect(section.getByText(/^Backups taken by hand/)).toHaveCount(0);
  await expect(section.getByText(/^Databases kept by restores/)).toHaveCount(0);
  // Too little free space: the server's own words, and nothing made.
  const refusal = "The backup was not made: not enough free space for a backup: 900 MB free, 1100 MB needed. Older backups are kept.";
  await page.route("**/v1/admin/backup", (r) => r.fulfill({ status: 507, json: { error: "insufficient_space", message: refusal } }));
  await backUp.click();
  await expect(now.getByRole("alert")).toHaveText(refusal);
  await page.unroute("**/v1/admin/backup");
  // Another backup running.
  await page.route("**/v1/admin/backup", (r) =>
    r.fulfill({ status: 409, json: { error: "backup_running", message: "A backup is already running; try again when it has finished." } }),
  );
  await backUp.click();
  await expect(now.getByRole("alert")).toHaveText("A backup is already running; try again when it has finished.");
  await page.unroute("**/v1/admin/backup");
  // A real backup, held on its way to the server: the button waits, then says what was made.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/v1/admin/backup", async (r) => {
    await held;
    await r.continue();
  });
  await backUp.click();
  await expect(backUp).toBeDisabled();
  await expect(now.getByRole("alert")).toHaveCount(0);
  release();
  const made = now.getByRole("status").filter({ hasText: /^Backed up: nottennapod-\d{8}-\d{6}-\d+\.db\.gz \(\d+(\.\d)? [KMG]B\)\.$/ });
  await expect(made).toBeVisible();
  await expect(backUp).toBeEnabled();
  await page.unroute("**/v1/admin/backup");
  const file = (await made.textContent())!.match(/nottennapod-\S+\.db\.gz/)![0];
  expect(readdirSync(join(server.dataDir, "backups"))).toContain(file);
  await expect(section.getByText(/^Backups taken by hand: 1 \(\d+(\.\d)? [KMG]B\)\. They are never deleted automatically\.$/)).toBeVisible();
  // A database a restore kept in the data folder.
  const kept = join(server.dataDir, "nottennapod.db.pre-restore-20261001-000000");
  writeFileSync(kept, Buffer.alloc(3 << 20));
  try {
    await page.reload();
    await expect(
      section.getByText(
        "Databases kept by restores: 1 (3.0 MB), in the data folder. They are never deleted automatically; delete them yourself when you no longer need them.",
      ),
    ).toBeVisible();
    await expect(section.getByText(/^Backups taken by hand: 1 /)).toBeVisible();
  } finally {
    rmSync(kept, { force: true });
  }
});

test("subscriptions: a tile's right-click menu, multi select, Keep updated for several, then archive and restore", async () => {
  type Sub = { podcast_id: string; display_title: string; state: string; records: { policy?: { value: { keep_updated?: boolean } } } };
  const subs = async (state: string) => (await read<{ items: Sub[] }>(`/v1/read/subscriptions?limit=500&state=${state}&order=alphabetical`)).items;
  await page.goto(server.base + "/subscriptions");
  const tiles = page.locator(".subscription-grid li");
  await expect(tiles.first()).toBeVisible();
  const n = await tiles.count();
  expect(n).toBeGreaterThan(2);
  // The first two podcasts by id: the backup has several podcasts of one name, as Android shows them.
  const id = async (i: number) => decodeURIComponent((await tiles.nth(i).getByRole("link").getAttribute("href"))!.replace(/^.*\/podcast\//, ""));
  const ids = [await id(0), await id(1)];
  // A tile's menu (Android's long press; a right-click here).
  await tiles.nth(0).click({ button: "right" });
  const menuList = page.getByRole("menu");
  await expect(menuList.getByRole("menuitem")).toHaveText(["Remove all from inbox", "Unsubscribe / archive", "Multi select"]);
  await page.getByRole("menuitem", { name: "Multi select" }).click();
  const bar = page.locator(".toolbar.action-mode");
  await expect(bar.getByRole("heading")).toHaveText(`1/${n} selected`);
  await tiles.nth(1).getByRole("checkbox").click({ modifiers: ["Shift"] });
  await expect(bar.getByRole("heading")).toHaveText(`2/${n} selected`);
  const actions = page.getByRole("toolbar", { name: "Multi select" });
  await expect(actions.getByRole("button")).toHaveText(["Remove all from inbox", "Unsubscribe / archive", "Keep updated"]);
  // Keep updated, off for both (Android's switch dialog).
  await actions.getByRole("button", { name: "Keep updated" }).click();
  const dialog = page.getByRole("dialog", { name: "Kept updated" });
  await expect(dialog.getByRole("switch")).not.toBeChecked();
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(bar).toHaveCount(0);
  await expect
    .poll(async () => (await subs("subscribed")).filter((p) => ids.includes(p.podcast_id)).map((p) => p.records.policy?.value.keep_updated))
    .toEqual([false, false]);
  // Archive both through Android's remove dialog, then restore them from the archive.
  await tiles.nth(0).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Multi select" }).click();
  await tiles.nth(1).getByRole("checkbox").click();
  await actions.getByRole("button", { name: "Unsubscribe / archive" }).click();
  const remove = page.getByRole("dialog", { name: "Unsubscribe / archive" });
  await expect(remove.getByText("2 subscriptions")).toBeVisible();
  await remove.getByRole("button", { name: "Archive" }).click();
  await expect.poll(async () => (await subs("archived")).map((p) => p.podcast_id).sort()).toEqual([...ids].sort());
  await page.goto(server.base + "/subscriptions");
  await page.locator(".toolbar").getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await tiles.nth(0).click({ button: "right" });
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Unsubscribe / restore", "Multi select"]);
  await page.getByRole("menuitem", { name: "Multi select" }).click();
  await page.locator(".toolbar.action-mode").getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Select all", exact: true }).click();
  await actions.getByRole("button", { name: "Unsubscribe / restore" }).click();
  await page.getByRole("dialog", { name: "Unsubscribe / archive" }).getByRole("button", { name: "Restore" }).click();
  await expect.poll(async () => (await subs("archived")).length).toBe(0);
  // Keep updated back on, for the journeys that follow.
  await page.goto(server.base + "/subscriptions");
  await page.locator(".toolbar").getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Subscriptions" }).click();
  await tiles.nth(0).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Multi select" }).click();
  await page.locator(".toolbar.action-mode").getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Select all", exact: true }).click();
  await actions.getByRole("button", { name: "Keep updated" }).click();
  await page.getByRole("dialog", { name: "Kept updated" }).getByRole("switch").check();
  await page.getByRole("dialog", { name: "Kept updated" }).getByRole("button", { name: "Confirm" }).click();
  await expect.poll(async () => (await subs("subscribed")).every((p) => p.records.policy?.value.keep_updated)).toBe(true);
  await settled();
});

test("an account disabled while its page is open leaves that page signed out, without reconnecting over and over", async ({ browser }) => {
  const created = await page.evaluate(async () => {
    const r = await fetch("/v1/admin/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "second", password: "another horse battery" }) });
    return (await r.json()) as { account: { account_id: string } };
  });
  const other = await browser.newContext();
  try {
    const p2 = await other.newPage();
    await p2.goto(server.base);
    await p2.getByLabel("Username").fill("second");
    await p2.getByLabel("Password").fill("another horse battery");
    await p2.getByRole("button", { name: "Log in" }).click();
    await expect(p2.locator("nav.drawer")).toBeVisible();
    let streams = 0;
    p2.on("request", (r) => r.url().endsWith("/v1/events") && streams++);
    // The administrator disables the account: its event stream is closed, and its session refused (403).
    const disabled = await page.evaluate(
      async (id) => (await fetch(`/v1/admin/accounts/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: "disabled" }) })).status,
      created.account.account_id,
    );
    expect(disabled).toBe(200);
    await expect(p2.getByRole("heading", { name: "Log in to NotTennaPod" })).toBeVisible({ timeout: 20_000 });
    expect(streams, "the stream is not reopened again and again").toBeLessThanOrEqual(1);
  } finally {
    await other.close();
  }
});

// The feed-error journeys: Breakable Show, a feed the publisher breaks and mends. The account holds other
// podcasts, some of whose feeds fail too, so every check is of Breakable Show's own tile, row and screen.
const notice = "Last refresh failed. Tap to view details.";
const brokenStatus =
  "The podcast host's server sent a broken podcast feed. We recommend checking with a podcast validator such as castfeedvalidator.com and contacting the podcast creator to let them know.";
type FeedRow = { podcast_id: string; display_title: string; records: { refresh_status?: { value: { error: { label: string } | null } } } };
const subscription = async (title: string) => (await read<{ items: FeedRow[] }>("/v1/read/subscriptions?limit=500")).items.find((p) => p.display_title === title);
const refreshError = async (title: string) => (await subscription(title))?.records.refresh_status?.value.error?.label ?? "";
const refreshPodcast = (id: string) =>
  page.evaluate(async (id) => (await fetch("/v1/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ podcast_id: id }) })).status, id);

/** subscribeTo subscribes to a fixture feed (once) and waits for the server's first fetch; it is the podcast's ID. */
async function subscribeTo(url: string, title: string): Promise<string> {
  if (!(await subscription(title))) {
    await page.goto(server.base + "/add");
    await page.getByLabel("Add podcast by RSS address").fill(url);
    await page.getByRole("button", { name: "Episodes preview" }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await page.getByRole("button", { name: "Subscribe", exact: true }).click();
  }
  let id = "";
  await expect.poll(async () => (id = (await subscription(title))?.podcast_id ?? ""), { timeout: 60_000 }).not.toBe("");
  await expect
    .poll(async () => (await read<{ total: number }>(`/v1/read/podcasts/${encodeURIComponent(id)}/episodes`)).total, { timeout: 60_000 })
    .toBe(3);
  return id;
}

/** breakFeed has the publisher break Breakable Show's feed, and waits for the server's refresh to fail. */
async function breakFeed(): Promise<string> {
  feeds.breakable.setBroken(false);
  const id = await subscribeTo(feeds.breakable.url, "Breakable Show");
  feeds.breakable.setBroken(true);
  expect(await refreshPodcast(id)).toBe(202);
  await expect.poll(() => refreshError("Breakable Show"), { timeout: 60_000 }).toBe("parser_exception");
  return id;
}

/** mendFeed has the publisher fix it, and waits for the server's refresh to work. */
async function mendFeed(id: string): Promise<void> {
  feeds.breakable.setBroken(false);
  expect(await refreshPodcast(id)).toBe(202);
  await expect.poll(() => refreshError("Breakable Show"), { timeout: 60_000 }).toBe("");
}

test("a podcast whose feed fails shows Android's error icon, notice and details, and they go when it works again", async ({ browserName }) => {
  // Subscribed while the feed works, then the publisher breaks it and the next refresh fails.
  feeds.breakable.setBroken(false);
  const id = await subscribeTo(feeds.breakable.url, "Breakable Show");
  expect(await refreshError("Breakable Show")).toBe("");
  await breakFeed();

  // The Subscriptions tile: Android's error icon at the cover's bottom-end, red on the window's colour, and the
  // tile named with the notice for screen readers.
  await page.goto(server.base + "/subscriptions");
  const tile = page.locator(".subscription-grid").getByRole("link", { name: `Breakable Show, ${notice}`, exact: true });
  await expect(tile).toBeVisible();
  const icon = tile.locator(".subscription-error svg");
  await expect(icon).toBeVisible();
  const fills = await icon.locator("path").evaluateAll((ps) => ps.map((p) => getComputedStyle(p).fill));
  expect(fills[1]).toBe("rgb(207, 24, 0)");
  expect(fills[0]).not.toBe(fills[1]);
  await expect(tile.locator(".subscription-error")).toHaveCount(1);
  // The drawer's row: the icon before the counter, named.
  const drawerRow = page.locator(".nav-subscriptions a").filter({ hasText: "Breakable Show" });
  await expect(drawerRow.getByRole("img", { name: notice, exact: true })).toBeVisible();

  // The podcast's notice opens Android's details: the podcast, the status in Android's words, no technical
  // details for this failure, and the feed's address.
  await tile.click();
  const button = page.getByRole("button", { name: notice, exact: true });
  await expect(button).toBeVisible();
  await button.click();
  const dialog = page.getByRole("dialog", { name: "Details" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("dt")).toHaveText(["Podcast", "Status", "Technical details", "File URL"]);
  await expect(dialog.locator("dd")).toHaveText(["Breakable Show", brokenStatus, "", feeds.breakable.url]);
  await expect(dialog.getByRole("button")).toHaveText([feeds.breakable.url, "Copy to clipboard", "OK"]);
  // OK closes it and gives the keyboard back to the notice; Escape closes it too.
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "OK", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
  // Copy to clipboard copies Android's text and closes the dialog.
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.base });
  await button.click();
  await dialog.getByRole("button", { name: "Copy to clipboard" }).click();
  await expect(dialog).toHaveCount(0);
  if (browserName === "chromium") expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(copiedDetails());
  await expect(page.locator(".snackbar").filter({ hasText: "Copied to clipboard" }).first()).toBeVisible();

  // The publisher fixes the feed: the next refresh works, and the notice and icons go, without a reload.
  await mendFeed(id);
  await expect(button).toHaveCount(0, { timeout: 60_000 });
  await expect(drawerRow.getByRole("img", { name: notice })).toHaveCount(0);
  await page.goto(server.base + "/subscriptions");
  const healthyTile = page.locator(".subscription-grid").getByRole("link", { name: "Breakable Show", exact: true });
  await expect(healthyTile).toBeVisible();
  await expect(healthyTile.locator(".subscription-error")).toHaveCount(0);
});

/** copiedDetails is what Copy to clipboard copies for Breakable Show's broken feed (Android's text). */
const copiedDetails = () => `Status: \n${brokenStatus} \n\nTechnical details: \nnull \n\nFile URL: \n${feeds.breakable.url}`;

test("when a feed fails, its details never show on another podcast after Back and Forward", async () => {
  const healthy = await subscribeTo(feeds.url, "Journey Show");
  const failing = await breakFeed();
  try {
    await page.goto(`${server.base}/podcast/${encodeURIComponent(healthy)}`);
    await expect(page.locator(".toolbar h1")).toHaveText("Journey Show");
    // The failing podcast through the drawer (the same screen, another podcast), and its details.
    await page.locator(".nav-subscriptions a").filter({ hasText: "Breakable Show" }).click();
    await expect(page.locator(".toolbar h1")).toHaveText("Breakable Show");
    await page.getByRole("button", { name: notice, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Details" });
    await expect(dialog.locator("dd")).toHaveText(["Breakable Show", brokenStatus, "", feeds.breakable.url]);
    // Back: the healthy podcast, with no details at all (its screen shows with any dialog it keeps).
    await page.goBack();
    await expect(page.locator(".toolbar h1")).toHaveText("Journey Show");
    await expect(page.locator("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: notice })).toHaveCount(0);
    await expect(page.getByText(brokenStatus)).toHaveCount(0);
    // Forward: the failing podcast again, its details closed until asked for, then its own.
    await page.goForward();
    await expect(page.locator(".toolbar h1")).toHaveText("Breakable Show");
    await expect(page.getByRole("button", { name: notice, exact: true })).toBeVisible();
    await expect(page.locator("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: notice, exact: true }).click();
    await expect(dialog.locator("dd")).toHaveText(["Breakable Show", brokenStatus, "", feeds.breakable.url]);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  } finally {
    await mendFeed(failing);
  }
});

test("when a feed fails, its details are copied even if the browser refuses or lacks the clipboard API", async ({ browserName }) => {
  const id = await breakFeed();
  const chromium = browserName === "chromium";
  if (chromium) await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.base });
  const clipboard = () => page.evaluate(() => (window as unknown as { realClipboard: Clipboard }).realClipboard.readText());
  try {
    await page.goto(`${server.base}/podcast/${encodeURIComponent(id)}`);
    const button = page.getByRole("button", { name: notice, exact: true });
    const dialog = page.getByRole("dialog", { name: "Details" });
    const failed = dialog.getByRole("alert");
    await expect(button).toBeVisible();
    // What each copy command copied (the selection it copies), each snackbar shown, and the clipboard API as it was.
    await page.evaluate(() => {
      const w = window as unknown as { copies: string[]; notices: string[]; realClipboard: Clipboard };
      w.copies = [];
      w.notices = [];
      w.realClipboard = navigator.clipboard;
      new MutationObserver((changes) => {
        for (const c of changes) for (const n of c.addedNodes) if (n instanceof HTMLElement && n.matches(".snackbar")) w.notices.push(n.innerText);
      }).observe(document.querySelector(".snackbars")!, { childList: true });
      document.addEventListener(
        "copy",
        () => {
          const el = document.activeElement as HTMLTextAreaElement | null;
          w.copies.push(el?.tagName === "TEXTAREA" ? el.value.slice(el.selectionStart, el.selectionEnd) : String(getSelection()));
        },
        true,
      );
    });
    const copies = () => page.evaluate(() => (window as unknown as { copies: string[] }).copies);
    const notices = () => page.evaluate(() => (window as unknown as { notices: string[] }).notices);
    const sentinel = async () => {
      if (chromium) await page.evaluate(() => Clipboard.prototype.writeText.call((window as unknown as { realClipboard: Clipboard }).realClipboard, "sentinel"));
      await page.evaluate(() => {
        const w = window as unknown as { copies: string[]; notices: string[] };
        w.copies = [];
        w.notices = [];
      });
    };
    /** copied checks a copy that worked: what was copied, on the clipboard where the browser lets it be read, and said. */
    const copied = async (text: string) => {
      await expect.poll(copies).toEqual([text]);
      if (chromium) expect(await clipboard()).toBe(text);
      await expect.poll(notices).toEqual(["Copied to clipboard"]);
    };

    // The browser refuses the clipboard API (a permission refused, later), then has none at all (a plain-HTTP
    // origin): the dialog stays until the copy is over, and copies a selection of the text instead.
    await page.evaluate(() => {
      navigator.clipboard.writeText = () => new Promise((_, reject) => setTimeout(() => reject(new DOMException("Write permission denied.", "NotAllowedError")), 50));
    });
    for (const how of ["refused", "missing"] as const) {
      if (how === "missing") await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }));
      await sentinel();
      await button.click();
      await dialog.getByRole("button", { name: "Copy to clipboard" }).click();
      await copied(copiedDetails());
      await expect(dialog).toHaveCount(0);
      // One value alone, from the keyboard: copied, and the keyboard stays on it.
      await sentinel();
      await button.click();
      const address = dialog.getByRole("button", { name: feeds.breakable.url });
      await address.focus();
      await page.keyboard.press("Enter");
      await copied(feeds.breakable.url);
      await expect(address).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    }
    // A browser that lets nothing be copied at all: the dialog says so and stays, and never says it copied.
    await page.evaluate(() => (document.execCommand = () => false));
    await sentinel();
    await button.click();
    await dialog.getByRole("button", { name: "Copy to clipboard" }).click();
    await expect(failed).toHaveText("Could not copy to the clipboard.");
    await expect(dialog).toBeVisible();
    expect(await notices()).toEqual([]);
    if (chromium) expect(await clipboard()).toBe("sentinel");
    await dialog.getByRole("button", { name: "OK", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await page.reload();
    await mendFeed(id);
  }
});
