// Closing the only tab while it plays (PROTOCOL §12): the page cannot wait for
// anything once it goes, so when it is hidden the player journals where it is
// and the departure's push is prepared from the journal; closing the tab then
// sends it with keepalive. The server has the position the tab was playing at,
// with no other tab of the profile open to send it.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { startServer, type RunningServer } from "./support/server.ts";
import { notNow } from "./support/offer.ts";
import { startPublisher, type Publisher } from "./support/player.ts";

const show = "Close Show";

let server: RunningServer;
let publisher: Publisher;
let context: BrowserContext;

test.beforeAll(async ({ browser }) => {
  server = await startServer();
  publisher = await startPublisher(show, [{ title: "Close episode", seconds: 600 }]);
  context = await browser.newContext({ ignoreHTTPSErrors: true });
});

test.afterAll(async () => {
  await context?.close();
  await publisher?.stop();
  await server?.stop();
});

async function read<T = Record<string, any>>(p: Page, path: string): Promise<T> {
  return p.evaluate(async (u) => (await fetch(u, { cache: "no-store" })).json(), path) as Promise<T>;
}

/** unsent counts the journal's entries without a receipt. */
function unsent(p: Page): Promise<number> {
  return p.evaluate(async () => {
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
  });
}

const bar = (p: Page) => p.locator(".player-bar");

test("closing the only tab while it plays sends where it was playing", async () => {
  const page = await context.newPage();
  await page.goto(server.base + "/");
  await page.getByLabel("Setup code").fill(server.setupCode);
  await page.getByLabel("Username").fill("listener");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator("nav.drawer")).toBeVisible();
  await notNow(page);
  await page.goto(server.base + "/add");
  await page.getByLabel("Add podcast by RSS address").fill(publisher.feedURL);
  await page.getByRole("button", { name: "Episodes preview" }).click();
  await page.getByRole("button", { name: "Subscribe" }).click();
  let id = "";
  await expect
    .poll(async () => (id = (await read<{ items: { title: string; episode_id: string }[] }>(page, "/v1/read/episodes?limit=10")).items.find((e) => e.title === "Close episode")?.episode_id ?? ""), { timeout: 60_000 })
    .not.toBe("");
  await page.evaluate((u) => {
    history.pushState(null, "", u);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `/episode/${encodeURIComponent(id)}`);
  await page.locator(".episode-buttons").getByRole("button", { name: "Stream" }).click();
  await expect(bar(page).getByRole("button", { name: "Pause" })).toBeVisible();
  // Everything so far has reached the server; then it plays on for a while, with no checkpoint yet (one a minute).
  await expect.poll(() => unsent(page), { timeout: 20_000 }).toBe(0);
  await expect.poll(() => page.evaluate(() => document.querySelector("audio")!.currentTime), { timeout: 30_000 }).toBeGreaterThan(20);
  const before = (await read(page, `/v1/read/episodes/${encodeURIComponent(id)}`)).episode.position as number;
  // Hidden, as when the person switches away (headless pages stay visible): the position is journaled, not pushed.
  const at = await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    return Math.round(document.querySelector("audio")!.currentTime * 1000);
  });
  await expect.poll(() => unsent(page), { timeout: 10_000 }).toBeGreaterThan(0);
  expect(before, "the server does not have it yet").toBeLessThan(at - 10_000);
  // The tab is closed: the browser runs pagehide and nothing after it.
  await page.close({ runBeforeUnload: true });
  // Another page of the server, not the app (it opens no player that could send the journal): the read API only.
  const reader = await context.newPage();
  await reader.goto(server.base + "/healthz");
  await expect
    .poll(async () => (await read(reader, `/v1/read/episodes/${encodeURIComponent(id)}`)).episode.position as number, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(at - 1_000);
  await reader.close();
});
