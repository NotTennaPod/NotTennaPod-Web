// Starting an episode (PROTOCOL §12, §13) with a slow publisher: every request
// for its files is answered late, the server's and the browser's alike, and
// the server trusts the publisher's certificate, so its descriptor could pin
// and probe the file as it does a real publisher's. A new unqueued episode
// starts after one read of the episode, then the descriptor beside the queue
// and summary reads, then the media; the server answers direct without
// fetching anything. A publisher URL the browser cannot play falls back to the
// relay, and the browser remembers it: after a reload and a server restart it
// asks for the relay at once and never tries that URL again.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page, type Request } from "@playwright/test";
import { startServer, type RunningServer } from "./support/server.ts";
import { notNow } from "./support/offer.ts";
import { startPublisher, type Publisher, type FixtureEpisode } from "./support/player.ts";

test.describe.configure({ mode: "serial" });

const show = "Slow Show";
const slowMs = 1_500;
const fixture: FixtureEpisode[] = [
  { title: "Slow episode 1", seconds: 120, delayMs: slowMs },
  { title: "Blocked episode", seconds: 120, etag: true },
];

let server: RunningServer;
let publisher: Publisher;
let certDir: string;
let context: BrowserContext;
let page: Page;
const ids: string[] = [];

test.beforeAll(async ({ browser }) => {
  publisher = await startPublisher(show, fixture);
  certDir = mkdtempSync(join(tmpdir(), "ntp-trust-"));
  const cert = join(certDir, "publisher.pem");
  writeFileSync(cert, publisher.certificate);
  // The server trusts the publisher's certificate (on macOS the override needs the GODEBUG setting).
  server = await startServer({ env: { SSL_CERT_FILE: cert, GODEBUG: "x509sslcertoverrideplatform=1" } });
  context = await browser.newContext({ ignoreHTTPSErrors: true });
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
  await publisher?.stop();
  await server?.stop();
  if (certDir) rmSync(certDir, { recursive: true, force: true });
});

async function read<T = Record<string, any>>(p: Page, path: string): Promise<T> {
  return p.evaluate(async (u) => (await fetch(u, { cache: "no-store" })).json(), path) as Promise<T>;
}

/** go navigates inside the app, so the player keeps playing. */
async function go(p: Page, path: string): Promise<void> {
  await p.evaluate((u) => {
    history.pushState(null, "", u);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

const bar = (p: Page) => p.locator(".player-bar");
const playing = (p: Page) => expect(bar(p).getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 60_000 });
const paused = (p: Page) => expect(bar(p).getByRole("button", { name: "Play", exact: true })).toBeVisible();

/** settled waits until the profile's journal has pushed everything. */
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

/** Logged is a request the page made, with its start and end on the browser's clock (ms since the epoch). */
interface Logged {
  method: string;
  path: string;
  start: number;
  end: number;
  body: Record<string, unknown> | null;
}

/** log records the page's API requests as they finish. */
function log(p: Page): Logged[] {
  const out: Logged[] = [];
  const done = (r: Request) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith("/v1/")) return;
    const t = r.timing();
    let body: Record<string, unknown> | null = null;
    try {
      body = r.method() === "POST" ? (r.postDataJSON() as Record<string, unknown>) : null;
    } catch {
      /* not JSON */
    }
    out.push({ method: r.method(), path: u.pathname, start: t.startTime, end: t.responseEnd >= 0 ? t.startTime + t.responseEnd : Number.POSITIVE_INFINITY, body });
  };
  p.on("requestfinished", done);
  p.on("requestfailed", done);
  return out;
}

test("set up and subscribe to a show whose publisher is slow", async () => {
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
    .toContain("Blocked episode");
  const items = (await read<{ items: { title: string; episode_id: string }[] }>(page, "/v1/read/episodes?limit=100")).items;
  for (const f of fixture) ids.push(items.find((e) => e.title === f.title)!.episode_id);
});

/**
 * Called is a call the app made, on the page's clock: when it asked, and when
 * the answer came (Infinity: not yet). asked and answered order the calls'
 * starts and answers among each other, which the clock cannot do within its
 * resolution (Firefox's is a millisecond).
 */
interface Called {
  method: string;
  path: string;
  start: number;
  end: number;
  asked: number;
  answered: number;
}

/** calls records the app's fetch calls in the page, from its next load on: what it asked and when, as the app sees it. */
async function recordCalls(p: Page): Promise<void> {
  await p.addInitScript(() => {
    const w = window as unknown as { calls: Called[] };
    w.calls = [];
    let order = 0;
    const now = () => performance.timeOrigin + performance.now();
    const original = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      const call = { method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(), path: url.pathname, start: now(), end: Number.POSITIVE_INFINITY, asked: order++, answered: Number.POSITIVE_INFINITY };
      w.calls.push(call);
      try {
        return await original(input, init);
      } finally {
        call.end = now();
        call.answered = order++;
      }
    };
  });
}

test("start an episode: one read of it, then the descriptor beside the queue and summary reads; nothing waits on the slow publisher's server side", async () => {
  // A fresh page load, as a person opening the app and playing an episode.
  await recordCalls(page);
  // The event stream is open before the click: its opening re-reads what is shown, which is not the start's.
  const events = page.waitForResponse((r) => new URL(r.url()).pathname === "/v1/events");
  await page.goto(server.base + "/");
  await expect(page.locator("nav.drawer")).toBeVisible();
  await events;
  const id = ids[0]!;
  await go(page, `/episode/${encodeURIComponent(id)}`);
  await expect(page.getByRole("heading", { name: fixture[0]!.title })).toBeVisible();
  const requests = log(page);
  const fromServer = publisher.agents.length;
  // The click and the element's first "playing", on the page's clock.
  await page.evaluate(() => {
    const w = window as unknown as { clickAt?: number; playingAt?: number };
    const now = () => performance.timeOrigin + performance.now();
    document.addEventListener("click", () => (w.clickAt ??= now()), { capture: true });
    document.querySelector("audio")!.addEventListener("playing", () => (w.playingAt ??= now()));
  });
  await page.locator(".episode-buttons").getByRole("button", { name: "Stream" }).click();
  await playing(page);
  await expect.poll(() => page.evaluate(() => (window as unknown as { playingAt?: number }).playingAt ?? 0)).toBeGreaterThan(0);
  const { clickAt, playingAt, calls } = await page.evaluate(() => {
    const w = window as unknown as { clickAt: number; playingAt: number; calls: Called[] };
    return { clickAt: w.clickAt, playingAt: w.playingAt, calls: w.calls };
  });
  const started = Math.round(playingAt - clickAt);
  console.log(`started in ${started} ms with a publisher that answers in ${slowMs} ms (${test.info().project.name})`);
  test.info().annotations.push({ type: "start", description: `${started} ms` });
  await bar(page).getByRole("button", { name: "Pause" }).click();
  await paused(page);
  await settled(page);

  const before = calls.filter((r) => r.start >= clickAt && r.start < playingAt);
  console.log(before.map((r) => `${r.method} ${r.path.replace(/e1%3A[0-9a-f]+/, "{id}")} +${Math.round(r.start - clickAt)}..+${Math.round(r.end - clickAt)}`).join("\n"));
  const episodeReads = before.filter((r) => r.method === "GET" && r.path === `/v1/read/episodes/${encodeURIComponent(id)}`);
  expect(episodeReads.length, "one read of the episode before it plays").toBe(1);
  expect(before.filter((r) => r.path === "/v1/media/types"), "the media types were asked at startup, not at play time").toEqual([]);
  const describe = before.filter((r) => r.method === "POST" && r.path === `/v1/media/${encodeURIComponent(id)}/play`);
  const queue = before.filter((r) => r.method === "GET" && r.path === "/v1/read/queue");
  const summary = before.filter((r) => r.method === "GET" && r.path === "/v1/read/summary");
  expect([describe.length, queue.length, summary.length], "one descriptor, one queue read and one summary read").toEqual([1, 1, 1]);
  const stage = [describe[0]!, queue[0]!, summary[0]!];
  // The second stage: all three asked before any of them was answered, after the episode's read.
  expect(Math.max(...stage.map((r) => r.asked)), "the descriptor, queue and summary reads overlap").toBeLessThan(Math.min(...stage.map((r) => r.answered)));
  expect(episodeReads[0]!.answered, "after the episode's read").toBeLessThan(Math.min(...stage.map((r) => r.asked)));
  const sent = requests.filter((r) => r.method === "POST" && r.path === `/v1/media/${encodeURIComponent(id)}/play`);
  expect(sent.map((r) => r.body?.direct_failed ?? false), "a first play tries the publisher's URL").toEqual([false]);
  // The server answered direct without touching the publisher: only the browser fetched the file.
  const server_ = publisher.agents.slice(fromServer).filter((a) => a.path === "/media/episode-1.wav" && a.agent.startsWith("NotTennaPod-Server"));
  expect(server_, "the server fetched nothing from the publisher").toEqual([]);
  expect(publisher.requests.get("/media/episode-1.wav") ?? 0, "the browser fetched the file").toBeGreaterThan(0);
});

test("a publisher URL the browser cannot play plays through the relay, and is not tried again after a reload and a server restart", async () => {
  const id = ids[1]!;
  const blocked = `${publisher.mediaOrigin}/media/episode-2.wav`;
  let tried = 0;
  // This browser cannot fetch the publisher's URL (a blocker, a network that cannot reach it); the server can.
  await page.route(blocked, (route) => {
    tried++;
    return route.abort("failed");
  });
  const requests = log(page);
  await go(page, `/episode/${encodeURIComponent(id)}`);
  await expect(page.getByRole("heading", { name: fixture[1]!.title })).toBeVisible();
  await page.locator(".episode-buttons").getByRole("button", { name: "Stream" }).click();
  await playing(page);
  await expect.poll(() => page.evaluate(() => document.querySelector("audio")!.src)).toContain("/v1/media/s/");
  const first = requests.filter((r) => r.method === "POST" && r.path === `/v1/media/${encodeURIComponent(id)}/play`).map((r) => r.body?.direct_failed ?? false);
  expect(first, "the publisher's URL is tried once, then the relay").toEqual([false, true]);
  expect(tried).toBeGreaterThan(0);
  await bar(page).getByRole("button", { name: "Pause" }).click();
  await paused(page);
  await settled(page);

  // The server restarts (it forgets what it was told) and the page loads again.
  await server.halt();
  await server.resume();
  const triedBefore = tried;
  const from = requests.length;
  await page.reload();
  await expect(bar(page).locator(".player-bar-title")).toHaveText(fixture[1]!.title);
  await paused(page);
  await bar(page).getByRole("button", { name: "Play", exact: true }).click();
  await playing(page);
  expect(await page.evaluate(() => document.querySelector("audio")!.src), "the server's stream plays").not.toContain(publisher.mediaOrigin);
  const again = requests.slice(from).filter((r) => r.method === "POST" && r.path === `/v1/media/${encodeURIComponent(id)}/play`).map((r) => r.body?.direct_failed ?? false);
  expect(again.length, "the episode was described again").toBeGreaterThan(0);
  expect(again.every((f) => f === true), `every descriptor asks for the relay at once: ${JSON.stringify(again)}`).toBe(true);
  expect(tried, "the publisher's URL is not tried again").toBe(triedBefore);
  await bar(page).getByRole("button", { name: "Pause" }).click();
  await paused(page);
  await settled(page);
  await page.unroute(blocked);
});
