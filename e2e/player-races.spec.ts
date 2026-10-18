// The player's races in real browsers: the built app against a real NotTennaPod-Server, with WAV
// and ALAC episodes from the fixture publisher. A seek made while paused survives a reload; after
// Clear queue nothing removed plays next; Pause while a compatibility seek waits for its stream
// stays paused; the previous episode's late end status never ends the next one.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { startServer, type RunningServer } from "./support/server.ts";
import { notNow } from "./support/offer.ts";
import { startPublisher, type Publisher, type FixtureEpisode } from "./support/player.ts";

test.describe.configure({ mode: "serial" });

const show = "Races Show";
const fixture: FixtureEpisode[] = [
  { title: "Long episode", seconds: 600 },
  { title: "Next episode", seconds: 180 },
  { title: "Short relayed episode", seconds: 6, plain: true },
  { title: "ALAC episode", seconds: 90, format: "m4a-alac", plain: true },
];

let server: RunningServer;
let publisher: Publisher;
let context: BrowserContext;
let page: Page;
const ids: string[] = [];

test.beforeAll(async ({ browser }) => {
  server = await startServer();
  publisher = await startPublisher(show, fixture);
  context = await browser.newContext({ ignoreHTTPSErrors: true });
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
  await publisher?.stop();
  await server?.stop();
});

async function read<T = Record<string, any>>(p: Page, path: string): Promise<T> {
  return p.evaluate(async (u) => (await fetch(u, { cache: "no-store" })).json(), path) as Promise<T>;
}

async function episode(p: Page, n: number) {
  return (await read(p, `/v1/read/episodes/${encodeURIComponent(ids[n - 1]!)}`)).episode;
}

async function settled(p: Page): Promise<void> {
  await expect
    .poll(
      () =>
        p.evaluate(async () => {
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

async function audio(p: Page): Promise<{ t: number; paused: boolean; ready: number; src: string }> {
  return p.evaluate(() => {
    const a = document.querySelector("audio")!;
    return { t: Math.round(a.currentTime * 1000), paused: a.paused, ready: a.readyState, src: a.currentSrc || a.src };
  });
}

async function reaches(p: Page, ms: number, timeout = 30_000): Promise<void> {
  await expect.poll(async () => (await audio(p)).t, { timeout }).toBeGreaterThanOrEqual(ms);
}

async function go(p: Page, path: string): Promise<void> {
  await p.evaluate((u) => {
    history.pushState(null, "", u);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

const bar = (p: Page) => p.locator(".player-bar");
const playing = (p: Page) => expect(bar(p).getByRole("button", { name: "Pause" })).toBeVisible();
const paused = (p: Page) => expect(bar(p).getByRole("button", { name: "Play", exact: true })).toBeVisible();

async function stream(p: Page, n: number): Promise<void> {
  await go(p, `/episode/${encodeURIComponent(ids[n - 1]!)}`);
  await expect(p.getByRole("heading", { name: fixture[n - 1]!.title })).toBeVisible();
  await p.locator(".episode-buttons").getByRole("button", { name: "Stream" }).click();
  await playing(p);
  await expect(bar(p).locator(".player-bar-title")).toHaveText(fixture[n - 1]!.title);
}

async function openPlayer(p: Page) {
  await bar(p).locator(".player-bar-open").click();
  const d = p.getByRole("dialog", { name: /episode/ });
  await expect(d).toBeVisible();
  return d;
}

test("set up and subscribe", async () => {
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
  await expect(page.getByRole("heading", { name: show })).toBeVisible();
  await page.getByRole("button", { name: "Subscribe" }).click();
  await expect
    .poll(async () => (await read<{ items: { title: string }[] }>(page, "/v1/read/episodes?limit=100")).items.map((e) => e.title), { timeout: 60_000 })
    .toContain("ALAC episode");
  const items = (await read<{ items: { title: string; episode_id: string }[] }>(page, "/v1/read/episodes?limit=100")).items;
  for (const f of fixture) ids.push(items.find((e) => e.title === f.title)!.episode_id);
});

test("a seek made while paused survives a reload", async () => {
  await stream(page, 1);
  await reaches(page, 1000);
  await bar(page).getByRole("button", { name: "Pause" }).click();
  await paused(page);
  const d = await openPlayer(page);
  await d.getByRole("slider", { name: "Position" }).fill("120000");
  await expect.poll(async () => (await audio(page)).t).toBe(120000);
  await page.keyboard.press("Escape");
  await settled(page);
  await page.reload();
  await paused(page);
  await expect.poll(async () => (await audio(page)).ready).toBeGreaterThan(0);
  expect((await audio(page)).t).toBe(120000);
  await bar(page).getByRole("button", { name: "Play", exact: true }).click();
  await playing(page);
  await reaches(page, 121_000);
  await bar(page).getByRole("button", { name: "Pause" }).click();
  await paused(page);
  await settled(page);
  const e = await episode(page, 1);
  expect(e.position).toBeGreaterThanOrEqual(119_000);
  expect(e.records.played_time?.value.played_ms ?? 0, "the seek is not listening").toBeLessThan(10_000);
});

test("after Clear queue, Skip starts no removed episode", async () => {
  // The queue is [Long episode, Next episode] (the previous test queued the first), and the player has read it.
  await stream(page, 2);
  await stream(page, 1);
  await settled(page);
  const queue = (await read<{ items: { episode_id: string }[] }>(page, "/v1/read/queue")).items.map((e) => e.episode_id);
  expect(queue.indexOf(ids[1]!)).toBeGreaterThan(queue.indexOf(ids[0]!));
  expect(queue.indexOf(ids[0]!)).toBeGreaterThanOrEqual(0);
  await go(page, "/queue");
  await page.locator(".toolbar").getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Clear queue", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect.poll(async () => (await read(page, "/v1/read/queue")).total).toBe(0);
  await bar(page).getByRole("button", { name: "Skip episode", exact: true }).click();
  await expect(bar(page)).toHaveCount(0);
  await expect.poll(async () => (await audio(page)).paused).toBe(true);
  await settled(page);
  expect((await read(page, "/v1/read/queue")).total, "nothing was added back").toBe(0);
});

test("Pause while a compatibility seek waits for its stream stays paused", async () => {
  const caps = await page.evaluate(() => document.createElement("audio").canPlayType('audio/mp4; codecs="alac"'));
  test.skip(caps !== "", "this engine plays ALAC itself");
  await stream(page, 4);
  await reaches(page, 1000);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let intercepted = false;
  await page.route("**/v1/media/s/*?start_ms=*", async (r) => {
    intercepted = true;
    await gate;
    await r.continue();
  });
  try {
    const d = await openPlayer(page);
    await d.getByRole("slider", { name: "Position" }).fill("60000");
    await expect.poll(() => intercepted).toBe(true);
    await d.getByRole("button", { name: "Pause" }).click();
    await paused(page);
    release();
    // The new stream can play: had the reload started it, it would be playing by now.
    await expect.poll(async () => (await audio(page)).ready, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
    expect((await audio(page)).paused, "the late stream does not resume paused audio").toBe(true);
    await paused(page);
    await expect(page.locator(".snackbar, [role=status]").filter({ hasText: /error|interrupted/i })).toHaveCount(0);
    await d.getByRole("button", { name: "Play", exact: true }).click();
    await playing(page);
    await expect.poll(async () => (await audio(page)).t, { timeout: 30_000 }).toBeGreaterThan(500);
    await d.getByRole("button", { name: "Pause" }).click();
    await page.keyboard.press("Escape");
  } finally {
    release();
    await page.unroute("**/v1/media/s/*?start_ms=*");
  }
});

test("the previous episode's late end status never ends the next one", async () => {
  await stream(page, 3);
  await reaches(page, 1000);
  await settled(page);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = false;
  await page.route("**/v1/media/s/*/status", async (r) => {
    const response = await r.fetch();
    held = true;
    await gate;
    await r.fulfill({ response });
  });
  try {
    await expect.poll(() => held, { timeout: 20_000 }).toBe(true); // the six-second relay ended; its status waits
    await stream(page, 2);
    await reaches(page, 500);
    await settled(page);
    const delivered = page.waitForResponse("**/v1/media/s/*/status");
    release();
    await delivered;
    const t = (await audio(page)).t;
    await reaches(page, t + 2000); // episode 2 plays on after the late status
    await expect(bar(page).locator(".player-bar-title")).toHaveText("Next episode");
    await playing(page);
    await bar(page).getByRole("button", { name: "Pause" }).click();
    await settled(page);
    const e = await episode(page, 2);
    expect(e.play_state).not.toBe("played");
    expect(e.records.played_time?.value.played_ms ?? 0).toBeLessThan(60_000);
  } finally {
    release();
    await page.unroute("**/v1/media/s/*/status");
  }
});
