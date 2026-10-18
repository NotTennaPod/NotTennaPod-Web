// Lists that update in place (PROTOCOL §12), against a real server and a
// podcast of 5,000 episodes: a phone's change re-reads only the rows around
// the screen, keeps them where they are and changes only the row it changed;
// a list whose view expired is read again around the screen; another tab's
// change reaches a shown tab with one read, and a hidden tab reads once when
// shown again; and an action on the whole list whose view expires while it
// is read saves nothing and says so.
import { expect, test, type BrowserContext, type Page, type Request } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startServer, type RunningServer } from "./support/server.ts";
import { notNow } from "./support/offer.ts";

test.describe.configure({ mode: "serial" });

const count = 5000;
const user = "owner";
const password = "correct horse battery";
let server: RunningServer;
let publisher: Server;
let context: BrowserContext;
let page: Page;
let podcastId = "";

const day = 86_400_000;
const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Long Show</title><link>https://example.com/</link>${Array.from(
  { length: count },
  (_, i) => `<item><title>Long Show episode ${i}</title><guid>long-${i}</guid><pubDate>${new Date(Date.UTC(2012, 0, 1) + i * day).toUTCString()}</pubDate>
<enclosure url="https://media.example/long-${i}.mp3" length="1000" type="audio/mpeg"/></item>`,
).join("")}</channel></rss>`;

test.beforeAll(async ({ browser }) => {
  publisher = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/rss+xml" });
    res.end(rss);
  });
  await new Promise<void>((r) => publisher.listen(0, "127.0.0.1", r));
  const feed = `http://127.0.0.1:${(publisher.address() as AddressInfo).port}/long.xml`;
  server = await startServer();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  await page.goto(server.base + "/");
  await page.getByLabel("Setup code").fill(server.setupCode);
  await page.getByLabel("Username").fill(user);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator("nav.drawer")).toBeVisible({ timeout: 30_000 });
  await notNow(page);
  await page.goto(server.base + "/add");
  await page.getByLabel("Add podcast by RSS address").fill(feed);
  await page.getByRole("button", { name: "Episodes preview" }).click();
  await expect(page.getByRole("heading", { name: "Long Show" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Subscribe", exact: true }).click();
  await expect
    .poll(async () => (podcastId = (await page.evaluate(async () => (await fetch("/v1/read/subscriptions")).json()).catch(() => ({}))).items?.[0]?.podcast_id ?? ""), { timeout: 60_000 })
    .toBeTruthy();
  // The app moves on to the podcast once subscribed; a request cut by that navigation is sent again.
  await expect(async () => {
    const status = await page.evaluate(async (id) => {
      const r = await fetch("/v1/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ podcast_id: id }) });
      return r.status;
    }, podcastId);
    expect(status).toBeLessThan(300);
  }).toPass({ timeout: 60_000 });
  await expect
    .poll(async () => page.evaluate(async (id) => (await (await fetch(`/v1/read/podcasts/${encodeURIComponent(id)}/episodes`)).json()).total, podcastId).catch(() => 0), { timeout: 180_000 })
    .toBe(count);
});

test.afterAll(async () => {
  await context?.close();
  await server?.stop();
  await new Promise<void>((r) => (publisher ? publisher.close(() => r()) : r()));
});

/** phoneFavorite is a phone's change: it signs in and favorites the episode. */
async function phoneFavorite(id: string): Promise<void> {
  const status = await page.evaluate(
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
      const fact = { op_id: crypto.randomUUID(), author_id: crypto.randomUUID(), author_seq: 1, dependencies: [], type: "favorite.set", type_version: 1,
        client_time: Date.now(), targets: [{ entity: "episode", id: e.episode_id, generation: ref.generation_id }], payload: { episode: ref, on: true } };
      const res = await fetch("/v1/push", { method: "POST", headers: auth,
        body: JSON.stringify({ cursor: ep.head.cursor, install_id: install, acked_install_seq: 0, operations: [{ install_seq: 1, fact }] }) }).then(json);
      return res.results?.[0]?.status ?? JSON.stringify(res);
    },
    { user, password, id },
  );
  expect(status).toBe("accepted");
}

/** expireViews makes 65 other list views, so the server lets the account's least recently read ones go (PROTOCOL §12: 64 per account). */
async function expireViews(p: Page): Promise<void> {
  await p.evaluate(async () => {
    const groups = [["played", "unplayed"], ["paused", "not_paused"], ["is_favorite", "not_favorite"], ["has_media", "no_media"], ["queued", "not_queued"]];
    let filters = [""];
    for (const g of groups) filters = filters.flatMap((f) => [f, ...g.map((x) => (f ? `${f},${x}` : x))]);
    for (const f of filters.filter(Boolean).slice(0, 65)) await fetch(`/v1/read/episodes?limit=1&filter=${f}`);
  });
}

/** listReads records the requests for the podcast's episode list. */
function listReads(p: Page): { urls: string[]; off: () => void } {
  const urls: string[] = [];
  const on = (r: Request) => {
    if (r.url().includes(`/v1/read/podcasts/${encodeURIComponent(podcastId)}/episodes`)) urls.push(r.url());
  };
  p.on("request", on);
  return { urls, off: () => p.off("request", on) };
}

/** titleAt is the title of the list's row i: rows are newest first, so row i is "Long Show episode <count - 1 - i>". */
const titleAt = (i: number) => `Long Show episode ${count - 1 - i}`;

/**
 * loadRows scrolls the podcast's list down until n rows are loaded. The list
 * holds at most 400 of them: past that, the rows furthest above give way to
 * the spacer.
 */
async function loadRows(p: Page, n: number): Promise<void> {
  await p.goto(`${server.base}/podcast/${podcastId}`);
  await expect(p.locator("li.episode")).toHaveCount(100, { timeout: 30_000 });
  for (let k = 200; k <= n; k += 100) {
    await p.locator(".load-more").last().scrollIntoViewIfNeeded();
    await expect(p.locator("li.episode").last().locator(".episode-title")).toHaveText(titleAt(k - 1), { timeout: 30_000 });
    expect(await p.locator("li.episode").count()).toBe(Math.min(k, 400));
  }
}

/** center puts a row in the middle of the screen. */
async function center(p: Page, id: string): Promise<number> {
  return p.evaluate((id) => {
    const el = document.querySelector(`li[data-id="${CSS.escape(id)}"]`)!;
    el.scrollIntoView({ block: "center" });
    return el.getBoundingClientRect().top;
  }, id);
}

const topOf = (p: Page, id: string) => p.evaluate((id) => document.querySelector(`li[data-id="${CSS.escape(id)}"]`)?.getBoundingClientRect().top ?? null, id);
/** idAt is the ID of the list's row i, held now. */
const idAt = (p: Page, i: number) =>
  p.evaluate((title) => [...document.querySelectorAll("li.episode")].find((li) => li.querySelector(".episode-title")?.textContent === title)!.getAttribute("data-id")!, titleAt(i));

test("window: a phone's change re-reads only the rows around the screen, keeps them in place and changes only its row", async () => {
  await loadRows(page, 1000);
  const anchor = await idAt(page, 950);
  const target = await idAt(page, 952);
  const at = await center(page, anchor);
  await expect.poll(() => page.locator("li.episode").count()).toBe(400);
  // Which rows' contents change, and which rows are the same elements afterwards.
  await page.evaluate(() => {
    const ul = document.querySelector("ul.episode-list")!;
    const changed = new Set<string>();
    (window as unknown as { changed: Set<string> }).changed = changed;
    for (const li of ul.children) (li as unknown as { kept: boolean }).kept = true;
    new MutationObserver((ms) => {
      for (const m of ms) {
        const el = m.target instanceof Element ? m.target : m.target.parentElement;
        const li = el?.closest("li[data-id]") as HTMLElement | null;
        if (li) changed.add(li.dataset.id!);
      }
    }).observe(ul, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  const reads = listReads(page);
  await phoneFavorite(target);
  await expect(page.locator(`li[data-id="${target}"] .episode-status [aria-label="Favorites"]`)).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => reads.urls.length).toBe(1);
  const url = new URL(reads.urls[0]!);
  expect(url.searchParams.get("anchor"), "a window around the first row on screen").toBeTruthy();
  expect(Number(url.searchParams.get("limit"))).toBeLessThanOrEqual(200);
  expect(await page.locator("li.episode").count()).toBeLessThanOrEqual(200);
  expect(Math.abs((await topOf(page, anchor))! - at), "the rows on screen stay where they were").toBeLessThanOrEqual(1);
  const onScreen = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("li[data-id]")] as (HTMLElement & { kept?: boolean })[];
    return rows.filter((r) => r.getBoundingClientRect().bottom > 0 && r.getBoundingClientRect().top < innerHeight).map((r) => ({ id: r.dataset.id!, kept: !!r.kept }));
  });
  expect(onScreen.length).toBeGreaterThan(5);
  expect(onScreen.filter((r) => !r.kept), "the rows on screen are the same elements").toEqual([]);
  expect(await page.evaluate(() => [...(window as unknown as { changed: Set<string> }).changed]), "only the changed row changed").toEqual([target]);
  // Scrolling up into the rows above loads them: first the page before the window, by the token the server gave.
  reads.urls.length = 0;
  const first = (await page.locator("li.episode").first().getAttribute("data-id"))!;
  await page.evaluate(() => {
    const spacer = document.querySelector(".list-spacer")!;
    window.scrollBy(0, spacer.getBoundingClientRect().bottom - 300);
  });
  await expect.poll(() => page.evaluate((id) => document.querySelector("li.episode")?.getAttribute("data-id") !== id, first)).toBe(true);
  expect(reads.urls.length).toBeGreaterThan(0);
  expect(new URL(reads.urls[0]!).searchParams.has("page_token"), "the page before the window, from the same view").toBe(true);
  expect(reads.urls.every((u) => Number(new URL(u).searchParams.get("limit")) <= 200), "at most 200 rows a read").toBe(true);
  // The top of the list.
  await page.keyboard.press("Home");
  await expect(page.locator("li.episode").first().locator(".episode-title")).toHaveText(`Long Show episode ${count - 1}`, { timeout: 15_000 });
  await expect(page.locator(".list-spacer")).toHaveCount(0);
  reads.off();
});

test("scrolling while a re-read is in flight keeps the row on screen in place, and pages nothing by itself", async () => {
  await loadRows(page, 1000);
  const planned = await idAt(page, 650);
  await center(page, planned);
  // The re-read around row 650 is held at the network while the person scrolls on to row 950.
  const held: (() => Promise<void>)[] = [];
  let holding = true;
  const windows = (u: URL) => u.pathname.endsWith("/episodes") && u.searchParams.has("anchor");
  await page.route(windows, (r) => void (holding ? held.push(() => r.continue()) : r.continue()));
  const reads = listReads(page);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => held.length).toBe(1);
  const there = await idAt(page, 950);
  const at = await center(page, there);
  holding = false;
  for (const go of held.splice(0)) await go();
  await expect.poll(() => page.locator("li.episode").count(), { timeout: 15_000 }).toBeLessThanOrEqual(200);
  await page.waitForLoadState("networkidle");
  expect(Math.abs((await topOf(page, there))! - at), "the row on screen stays where it is").toBeLessThanOrEqual(1);
  expect(await page.locator("li.episode").count()).toBeLessThanOrEqual(200);
  expect(reads.urls.filter((u) => new URL(u).searchParams.has("page_token")), "no page read by itself").toEqual([]);
  expect(new URL(reads.urls.at(-1)!).searchParams.get("anchor"), "the window where the screen is").not.toBe(planned);
  await page.unroute(windows);
  reads.off();
});

test("a jump far up a list read again deep down reads the window where the screen is: the rows at that place, in at most two reads", async () => {
  await loadRows(page, 1000);
  await center(page, await idAt(page, 950));
  // A revalidation reads the list again around row 950: the rows above become the spacer.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".list-spacer")).toBeAttached({ timeout: 15_000 });
  await expect.poll(() => page.locator("li.episode").count()).toBeLessThanOrEqual(200);
  await page.waitForLoadState("networkidle");
  // Rows are newest first: row i is "Long Show episode <count - 1 - i>".
  const indexOf = (title: string) => count - 1 - Number(title.replace("Long Show episode ", ""));
  const lo = indexOf(await page.locator("li.episode .episode-title").first().innerText());
  expect(lo).toBeGreaterThan(800);
  const reads = listReads(page);
  // The scrollbar dragged up to about row 300.
  await page.evaluate(({ lo, to }) => {
    const spacer = document.querySelector(".list-spacer")!;
    const r = spacer.getBoundingClientRect();
    window.scrollTo(0, scrollY + r.top + (r.height / lo) * to + 1);
  }, { lo, to: 300 });
  const firstOnScreen = () =>
    page.evaluate(() => {
      const li = [...document.querySelectorAll("li.episode")].find((x) => x.getBoundingClientRect().bottom > 0 && x.getBoundingClientRect().top < innerHeight);
      return li?.querySelector(".episode-title")?.textContent ?? "";
    });
  await expect.poll(async () => indexOf(await firstOnScreen()), { timeout: 15_000 }).toBeLessThan(400);
  await page.waitForLoadState("networkidle");
  const at = indexOf(await firstOnScreen());
  expect(Math.abs(at - 300), `the rows at that place (row ${at})`).toBeLessThanOrEqual(3);
  expect(reads.urls.length, reads.urls.join("\n")).toBeLessThanOrEqual(2);
  expect(new URL(reads.urls[0]!).searchParams.get("anchor_index"), "a read at the screen's index").toBe("300");
  reads.off();
});

test("after a re-read in the middle, End still reaches the end of the list, with one read for its last rows", async () => {
  await loadRows(page, 1000);
  await center(page, await idAt(page, 650));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".list-spacer-below")).toBeAttached({ timeout: 15_000 });
  await expect.poll(() => page.locator("li.episode").count()).toBeLessThanOrEqual(200);
  await page.waitForLoadState("networkidle");
  const reads = listReads(page);
  await page.keyboard.press("End");
  // Rows are newest first: the last row is the first episode.
  await expect(page.locator(".episode-title", { hasText: /^Long Show episode 0$/ })).toBeInViewport({ timeout: 20_000 });
  await page.waitForLoadState("networkidle");
  expect(reads.urls.length, reads.urls.join("\n")).toBeLessThanOrEqual(3);
  expect(reads.urls.some((u) => new URL(u).searchParams.has("anchor_index")), "a read at the screen's index").toBe(true);
  expect(reads.urls.filter((u) => new URL(u).searchParams.has("page_token")), "no Load more toward the end").toEqual([]);
  await expect(page.locator(".list-spacer-below")).toHaveCount(0);
  reads.off();
});

test("an expired view is read again around the screen, without losing the place", async () => {
  await loadRows(page, 400);
  const anchor = await idAt(page, 350);
  const at = await center(page, anchor);
  await expireViews(page);
  const reads = listReads(page);
  const statuses: number[] = [];
  page.on("response", (r) => {
    if (r.url().includes(`/v1/read/podcasts/${encodeURIComponent(podcastId)}/episodes`)) statuses.push(r.status());
  });
  // Load more (pressed, so the screen stays where it is) meets the expired view.
  await page.evaluate(() => (document.querySelector("ul.episode-list ~ .load-more") as HTMLButtonElement).click());
  await expect.poll(() => reads.urls.length).toBe(2);
  expect(new URL(reads.urls[0]!).searchParams.has("page_token")).toBe(true);
  await expect.poll(() => statuses[0]).toBe(410);
  expect(new URL(reads.urls[1]!).searchParams.get("anchor"), "read again around the screen").toBeTruthy();
  await expect.poll(() => page.locator("li.episode").count()).toBeLessThanOrEqual(200);
  expect(Math.abs((await topOf(page, anchor))! - at)).toBeLessThanOrEqual(1);
  reads.off();
});

test("two tabs: a change reaches the shown tab with one read and its drawer's counter; a hidden tab reads once when shown", async () => {
  const b = await context.newPage();
  try {
    await b.goto(`${server.base}/favorites`);
    await expect(b.locator(".toolbar h1")).toHaveText("Favorites", { timeout: 30_000 });
    await b.waitForLoadState("networkidle");
    let favoritesReads = 0;
    b.on("request", (r) => {
      if (r.url().includes("/v1/read/favorites")) favoritesReads++;
    });
    const queueBadge = b.locator("nav.drawer a.nav-item", { hasText: "Queue" }).locator(".nav-count");
    await expect(queueBadge).toHaveCount(0);
    await page.goto(`${server.base}/podcast/${podcastId}`);
    const rows = page.locator("li.episode");
    await expect(rows).toHaveCount(100, { timeout: 30_000 });
    const titleOf = async (i: number) => (await rows.nth(i).locator(".episode-title").innerText()).trim();
    // Tab A adds an episode to the queue: tab B's screen reads once, and its drawer counts it.
    await rows.nth(10).getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Add to queue" }).click();
    await expect(queueBadge).toHaveText("1", { timeout: 15_000 });
    await expect.poll(() => favoritesReads).toBe(1);
    // Tab B is hidden: three changes, no reads.
    await b.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      // A stream of its own tells the test when the server's events have reached this tab.
      const w = window as unknown as { heads: number[] };
      w.heads = [];
      new EventSource("/v1/events").addEventListener("changed", (e) => w.heads.push(JSON.parse((e as MessageEvent).data).seq));
    });
    const head = async () => (await page.evaluate(async () => (await (await fetch("/v1/read/favorites")).json()) as { total: number; head: { seq: number } }));
    const before = (await head()).total;
    const titles: string[] = [];
    for (let i = 20; i < 23; i++) {
      titles.push(await titleOf(i));
      await rows.nth(i).getByRole("button", { name: "More" }).click();
      await page.getByRole("menuitem", { name: "Add to favorites" }).click();
    }
    await expect.poll(async () => (await head()).total, { timeout: 15_000 }).toBe(before + 3);
    const seq = (await head()).head.seq;
    await expect.poll(() => b.evaluate(() => Math.max(0, ...(window as unknown as { heads: number[] }).heads)), { timeout: 15_000 }).toBeGreaterThanOrEqual(seq);
    expect(favoritesReads, "a hidden tab reads nothing").toBe(1);
    // Shown again: one read, with every change.
    await b.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    for (const t of titles) await expect(b.locator(".episode-title", { hasText: t })).toBeVisible({ timeout: 15_000 });
    expect(favoritesReads).toBe(2);
  } finally {
    await b.close();
  }
});

test("bulk expired: Mark played on the whole list stops with the server's message when the list expires, and saves nothing", async () => {
  await page.goto(`${server.base}/podcast/${podcastId}`);
  await expect(page.locator("li.episode")).toHaveCount(100, { timeout: 30_000 });
  const pushed: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/v1/push") && r.method() === "POST") {
      for (const o of (r.postDataJSON() as { operations?: { fact?: { type: string } }[] }).operations ?? []) if (o.fact) pushed.push(o.fact.type);
    }
  });
  await page.locator("li.episode").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Multi select", exact: true }).click();
  const mode = page.locator(".toolbar.action-mode");
  await mode.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Select all", exact: true }).click();
  await expect(mode.locator("h1")).toHaveText(`${count}/${count} selected`);
  await page.getByRole("button", { name: "Mark as played", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expireViews(page);
  const reads = listReads(page);
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(".snackbar", { hasText: "This list changed; load it again." })).toBeVisible({ timeout: 15_000 });
  // The list reloads, and nothing was saved.
  await expect.poll(() => reads.urls.some((u) => !new URL(u).searchParams.has("page_token")), { timeout: 15_000 }).toBe(true);
  expect(pushed.filter((t) => t.startsWith("episode.mark")), "nothing marked").toEqual([]);
  expect(await page.evaluate(async (id) => (await (await fetch(`/v1/read/podcasts/${id}/episodes?filter=played`)).json()).total, podcastId)).toBe(0);
  reads.off();
});
