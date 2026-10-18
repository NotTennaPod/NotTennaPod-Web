// Refresh (Android's refresh_item) with progress that tells the truth
// (NotTennaPod-Server PROTOCOL §9.6), against a real server and a publisher
// this test controls: a podcast's Refresh while its publisher is slow keeps
// the progress until the server has fetched it, and ends it although nothing
// changed (no event arrives); Refresh on Subscriptions refreshes every
// podcast, counts them as they are done, and the new episode one of them
// published appears.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startServer, type RunningServer } from "./support/server.ts";
import { notNow } from "./support/offer.ts";

test.describe.configure({ mode: "serial" });

let server: RunningServer;
let context: BrowserContext;
let page: Page;

/** A publisher of two feeds: Slow Show, whose answers can be held, and Busy Show, which can publish a new episode. */
let publisher: Server;
let base = "";
let held: (() => void)[] = [];
let holding = false;
const requests: string[] = [];
let busyEpisodes = 3;

const rss = (title: string, prefix: string, n: number) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>https://example.com/</link>${Array.from(
    { length: n },
    (_, i) => `<item><title>${title} episode ${i + 1}</title><guid>${prefix}-${i + 1}</guid>
<pubDate>${new Date(Date.UTC(2026, 8, i + 1)).toUTCString()}</pubDate>
<enclosure url="https://media.example/${prefix}-${i + 1}.mp3" length="1000" type="audio/mpeg"/></item>`,
  ).join("")}</channel></rss>`;

test.beforeAll(async ({ browser }) => {
  publisher = createServer((req, res) => {
    requests.push(req.url ?? "");
    const answer = () => {
      res.writeHead(200, { "Content-Type": "application/rss+xml" });
      res.end(req.url?.startsWith("/slow.xml") ? rss("Slow Show", "slow", 3) : rss("Busy Show", "busy", busyEpisodes));
    };
    if (holding && req.url?.startsWith("/slow.xml")) held.push(answer);
    else answer();
  });
  await new Promise<void>((r) => publisher.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(publisher.address() as AddressInfo).port}`;
  server = await startServer();
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto(server.base + "/");
  await page.getByLabel("Setup code").fill(server.setupCode);
  await page.getByLabel("Username").fill("owner");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator("nav.drawer")).toBeVisible({ timeout: 30_000 }); // account setup can take a while on a busy machine
  await notNow(page);
});

test.afterAll(async () => {
  release();
  await context?.close();
  await server?.stop();
  await new Promise((r) => publisher?.close(r));
});

function release(): void {
  holding = false;
  for (const answer of held.splice(0)) answer();
}

async function read<T>(path: string): Promise<T> {
  return page.evaluate(async (p) => (await fetch(p)).json(), path) as Promise<T>;
}

/** subscribe subscribes from the address, waits for the server's first fetch, and is the podcast's ID. */
async function subscribe(url: string, title: string): Promise<string> {
  await page.goto(server.base + "/add");
  await page.getByLabel("Add podcast by RSS address").fill(url);
  await page.getByRole("button", { name: "Episodes preview" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.getByRole("button", { name: "Subscribe", exact: true }).click();
  let id = "";
  await expect
    .poll(async () => (id = (await read<{ items: { podcast_id: string; display_title: string }[] }>("/v1/read/subscriptions?limit=50")).items.find((p) => p.display_title === title)?.podcast_id ?? ""), { timeout: 60_000 })
    .not.toBe("");
  await expect.poll(async () => (await read<{ total: number }>(`/v1/read/podcasts/${encodeURIComponent(id)}/episodes`)).total, { timeout: 60_000 }).toBeGreaterThan(0);
  return id;
}

const slowRequests = () => requests.filter((r) => r.startsWith("/slow.xml")).length;

test("Refresh a podcast whose publisher is slow: the progress stays until the server has fetched it, and ends though nothing changed", async () => {
  const id = await subscribe(base + "/slow.xml", "Slow Show");
  const head = (await read<{ head: { seq: number } }>("/v1/read/summary")).head.seq;
  await page.goto(`${server.base}/podcast/${encodeURIComponent(id)}`);
  await expect(page.locator(".toolbar h1")).toHaveText("Slow Show");
  holding = true;
  const before = slowRequests();
  await page.locator(".toolbar").getByRole("button", { name: "More" }).click();
  // Android's feedlist menu: Sort, then Refresh.
  await expect(page.getByRole("menu").getByRole("menuitem").nth(1)).toHaveText("Refresh");
  await page.getByRole("menuitem", { name: "Refresh", exact: true }).click();
  const progress = page.locator(".refreshing[role=status]");
  await expect(progress).toHaveText("Refreshing podcasts…");
  await expect(progress).toBeVisible();
  // The server's fetch has reached the publisher, which does not answer yet: the progress stays.
  await expect.poll(slowRequests, { timeout: 30_000 }).toBeGreaterThan(before);
  await expect(progress).toBeVisible();
  // Leaving the screen keeps it: Android's spinner shows on every list while podcasts refresh.
  await page.locator("nav.drawer").getByRole("link", { name: "Episodes", exact: true }).click();
  await expect(page.locator(".toolbar h1")).toHaveText("Episodes");
  await expect(progress).toBeVisible();
  release();
  // The feed is unchanged: nothing is committed and no event arrives, yet the progress ends.
  await expect(progress).toHaveCount(0, { timeout: 30_000 });
  expect((await read<{ head: { seq: number } }>("/v1/read/summary")).head.seq).toBe(head);
});

test("Refresh on Subscriptions refreshes every podcast, counts them as they are done, and the new episode appears", async () => {
  // On another host: the server fetches one feed per host at a time, and Slow Show's host is busy.
  await subscribe(base.replace("127.0.0.1", "localhost") + "/busy.xml", "Busy Show");
  await page.goto(server.base + "/subscriptions");
  await expect(page.locator(".toolbar h1")).toHaveText("Subscriptions");
  busyEpisodes = 4; // the publisher releases an episode
  holding = true;
  await page.locator(".toolbar").getByRole("button", { name: "More" }).click();
  // Android's subscriptions menu ends with Refresh (a container item, after the uncategorized ones).
  await expect(page.getByRole("menu").getByRole("menuitem").last()).toHaveText("Refresh");
  await page.getByRole("menuitem", { name: "Refresh", exact: true }).click();
  const progress = page.locator(".refreshing[role=status]");
  await expect(progress).toHaveText(/Refreshing podcasts… [01] of 2/);
  // Busy Show is done; Slow Show's publisher has not answered.
  await expect(progress).toHaveText("Refreshing podcasts… 1 of 2", { timeout: 30_000 });
  await page.locator("nav.drawer").getByRole("link", { name: "Episodes", exact: true }).click();
  await expect(page.locator(".episode").filter({ hasText: "Busy Show episode 4" })).toBeVisible({ timeout: 30_000 });
  await expect(progress).toHaveText("Refreshing podcasts… 1 of 2");
  release();
  await expect(progress).toHaveCount(0, { timeout: 30_000 });
});
