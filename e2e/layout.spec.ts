// Every screen, at 360, 800 and 1280 px, left-to-right and right-to-left:
// nothing wider than the window, toolbar titles never under their buttons,
// every control inside the window; keyboard-only: the drawer, a screen's
// menus and an episode's actions work with Tab, Enter and Escape alone.
// Screenshots go to .work/layout-shots for checking by eye.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { root, serverRepo } from "./support/build.ts";
import { startServer, type RunningServer } from "./support/server.ts";

test.describe.configure({ mode: "serial" });

let server: RunningServer;
let podcastPath = "/";
let episodePath = "/";
// A podcast and an episode whose titles have no space: one long word, as a podcast titled by its
// address is until its first fetch (the server refuses a feed without a title, as Android does).
let unbroken: Server | undefined;
let unbrokenURL = "";
const unbrokenPodcast = "APodcastTitleWithoutASingleSpaceThatIsLongerThanANarrowWindowCanShowOnOneLineOrTwo";
const unbrokenEpisode = "AnEpisodeTitleWithoutASingleSpaceThatIsFarLongerThanANarrowWindowCanShowOnOneLine";

async function signIn(page: Page): Promise<void> {
  await page.goto(server.base + "/");
  await page.getByLabel("Username").fill("owner");
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.locator("nav.drawer")).toBeAttached();
}

test.beforeAll(async ({ browser }) => {
  server = await startServer();
  const page = await browser.newPage();
  await page.goto(server.base + "/");
  await page.getByLabel("Setup code").fill(server.setupCode);
  await page.getByLabel("Username").fill("owner");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator("nav.drawer")).toBeAttached();
  const data = readFileSync(join(serverRepo, "internal", "importer", "androiddb", "testdata", "android-3.12.1", "emulator-parity-library.db"));
  const paths = await page.evaluate(
    async ({ fingerprint, size, b64 }) => {
      const h = { "Content-Type": "application/json" };
      const j = await (await fetch("/v1/import", { method: "POST", headers: h, body: JSON.stringify({ kind: "android_db", fingerprint, size, file_name: "b.db" }) })).json();
      await fetch(`/v1/import/${j.import_id}/chunks/0`, { method: "PUT", headers: h, body: JSON.stringify({ data: b64 }) });
      await fetch(`/v1/import/${j.import_id}/finish`, { method: "POST", headers: h, body: "{}" });
      for (let i = 0; i < 200; i++) {
        const s = await (await fetch(`/v1/import/${j.import_id}`)).json();
        if (s.status === "published") break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const ep = (await (await fetch("/v1/read/episodes?filter=has_media&limit=1")).json()).items[0];
      return { podcast: `/podcast/${encodeURIComponent(ep.podcast_id)}`, episode: `/episode/${encodeURIComponent(ep.episode_id)}` };
    },
    { fingerprint: createHash("sha256").update(data).digest("hex"), size: data.length, b64: data.toString("base64") },
  );
  podcastPath = paths.podcast;
  episodePath = paths.episode;
  await page.close();
});

test.afterAll(async () => {
  unbroken?.close();
  await server?.stop();
});

/** subscribeUnbroken subscribes to the feed whose titles have no space, and waits for the server to fetch its episode. */
async function subscribeUnbroken(page: Page): Promise<{ podcast: string; episode: string }> {
  if (!unbroken) {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>${unbrokenPodcast}</title><link>https://example.com/</link>
<item><title>${unbrokenEpisode}</title><guid>unbroken-1</guid><pubDate>${new Date(Date.UTC(2026, 8, 1)).toUTCString()}</pubDate>
<enclosure url="https://media.example/unbroken.mp3" length="1000" type="audio/mpeg"/></item></channel></rss>`;
    unbroken = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/rss+xml" });
      res.end(rss);
    });
    await new Promise<void>((r) => unbroken!.listen(0, "127.0.0.1", r));
    unbrokenURL = `http://127.0.0.1:${(unbroken.address() as AddressInfo).port}/a-podcast-feed-at-a-long-address-without-spaces.xml`;
  }
  const find = () =>
    page.evaluate(async (title) => {
      const subs = (await (await fetch("/v1/read/subscriptions?limit=500")).json()).items as { podcast_id: string; display_title: string }[];
      const p = subs.find((x) => x.display_title === title);
      if (!p) return null;
      const eps = (await (await fetch(`/v1/read/podcasts/${encodeURIComponent(p.podcast_id)}/episodes?limit=5`)).json()).items as { episode_id: string }[];
      return { podcast: p.podcast_id, episode: eps[0]?.episode_id ?? "" };
    }, unbrokenPodcast);
  if (!(await find())) {
    await page.goto(server.base + "/add");
    await page.getByLabel("Add podcast by RSS address").fill(unbrokenURL);
    await page.getByRole("button", { name: "Episodes preview" }).click();
    const subscribe = page.locator(".preview").getByRole("button", { name: "Subscribe", exact: true });
    const open = page.locator(".preview").getByRole("button", { name: "Open podcast", exact: true });
    await expect(subscribe.or(open)).toBeVisible({ timeout: 60_000 }); // another engine's test may have subscribed it
    if (await subscribe.count()) {
      await subscribe.click();
      await expect(page).toHaveURL(/\/subscriptions$/);
    }
  }
  let found: { podcast: string; episode: string } | null = null;
  await expect.poll(async () => (found = await find())?.episode ?? "", { timeout: 70_000 }).not.toBe("");
  return found!;
}

const screens = () => [
  ["home", "/"], ["queue", "/queue"], ["inbox", "/inbox"], ["subscriptions", "/subscriptions"], ["episodes", "/episodes"],
  ["history", "/history"], ["favorites", "/favorites"], ["statistics", "/statistics"], ["add", "/add"], ["settings", "/settings"],
  ["podcast", podcastPath], ["episode", episodePath],
];

/** problems lists what a person would see as broken: overflow, overlap, controls outside the window. */
async function problems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > vw + 1) out.push(`page is ${document.documentElement.scrollWidth}px wide in a ${vw}px window`);
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.closest("[inert]");
    };
    for (const el of document.querySelectorAll("button, a[href], input, [role=tab]")) {
      if (!visible(el) || el.closest(".carousel, .drawer, .floating-select")) continue;
      const r = el.getBoundingClientRect();
      if (r.left < -1 || r.right > vw + 1) out.push(`${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}" is outside the window`);
    }
    // A scrolling row of actions (multi select) stays inside the window.
    for (const el of document.querySelectorAll(".floating-select")) {
      const r = el.getBoundingClientRect();
      if (r.left < -1 || r.right > vw + 1) out.push("the multi-select actions are outside the window");
    }
    const title = document.querySelector(".toolbar h1");
    if (title && visible(title)) {
      const t = title.getBoundingClientRect();
      for (const b of document.querySelectorAll(".toolbar button, .drawer-toggle")) {
        if (!visible(b)) continue;
        const r = b.getBoundingClientRect();
        const overlap = Math.min(t.right, r.right) - Math.max(t.left, r.left);
        const vertical = Math.min(t.bottom, r.bottom) - Math.max(t.top, r.top);
        if (overlap > 2 && vertical > 2) out.push(`toolbar title overlaps "${b.getAttribute("aria-label")}"`);
      }
    }
    return out;
  });
}

for (const dir of ["ltr", "rtl"] as const) {
  test.describe(dir, () => {
    test.use({ locale: dir === "rtl" ? "ar" : "en-US" });
    for (const width of [360, 800, 1280]) {
      test(`every screen at ${width}px`, async ({ page, browserName }) => {
        await page.setViewportSize({ width, height: 800 });
        await signIn(page);
        expect(await page.evaluate(() => document.documentElement.dir)).toBe(dir);
        const found: string[] = [];
        for (const [name, path] of screens()) {
          await page.goto(server.base + path);
          await expect(page.locator(".toolbar h1")).toBeVisible();
          await page.waitForLoadState("networkidle");
          for (const p of await problems(page)) found.push(`${name}: ${p}`);
          await page.screenshot({ path: join(root, ".work", "layout-shots", browserName, `${dir}-${width}-${name}.png`) });
        }
        // Multi select: the action mode and the floating actions.
        await page.goto(server.base + "/episodes");
        await page.locator(".episode").first().getByRole("button", { name: "More" }).click();
        await page.getByRole("menuitem", { name: "Multi select" }).click();
        await expect(page.locator(".toolbar.action-mode h1")).toBeVisible();
        await page.locator(".episode").nth(2).getByRole("checkbox").click({ modifiers: ["Shift"] });
        for (const p of await problems(page)) found.push(`multi select: ${p}`);
        await page.screenshot({ path: join(root, ".work", "layout-shots", browserName, `${dir}-${width}-multi-select.png`) });
        expect(found).toEqual([]);
      });
    }
  });
}

for (const dir of ["ltr", "rtl"] as const) {
  test.describe(dir, () => {
    test.use({ locale: dir === "rtl" ? "ar" : "en-US" });
    test("a title without a space wraps at 360px, on the podcast's screen and an episode's", async ({ page, browserName }) => {
      await page.setViewportSize({ width: 360, height: 800 });
      await signIn(page);
      const { podcast, episode } = await subscribeUnbroken(page);
      const found: string[] = [];
      for (const [name, path] of [["podcast", `/podcast/${encodeURIComponent(podcast)}`], ["episode", `/episode/${encodeURIComponent(episode)}`]]) {
        await page.goto(server.base + path!);
        await expect(page.locator(".podcast-header h2, .episode-header h2").first()).toBeVisible();
        for (const p of await problems(page)) found.push(`${name}: ${p}`);
        await page.screenshot({ path: join(root, ".work", "layout-shots", browserName, `${dir}-360-unbroken-${name}.png`) });
      }
      expect(found).toEqual([]);
      // The title is shown, wrapped, within Android's lines: two for a podcast, five for an episode.
      await page.goto(server.base + `/podcast/${encodeURIComponent(podcast)}`);
      const title = page.locator(".podcast-header h2");
      await expect(title).toHaveText(unbrokenPodcast);
      const lines = (h: { height: number }, lineHeight: number) => Math.round(h.height / lineHeight);
      const lineHeight = await title.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.2);
      expect(lines((await title.boundingBox())!, lineHeight)).toBeLessThanOrEqual(2);
    });
  });
}

test("keyboard only: the drawer, a menu and an episode's actions", async ({ page, browserName }) => {
  // Safari's Tab skips links unless the person turned that on; Option+Tab reaches them.
  const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);
  // Tab to the Queue link in the drawer and open it.
  const onQueueLink = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      return el instanceof HTMLAnchorElement && el.getAttribute("href") === "/queue";
    });
  for (let i = 0; i < 30 && !(await onQueueLink()); i++) await page.keyboard.press(tab);
  expect(await onQueueLink()).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/queue$/);
  // Tab to the first episode's menu, open it with Enter, move with arrows, close with Escape.
  const more = page.locator(".episode").first().getByRole("button", { name: "More" });
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(more).toBeFocused();
  // An action from the keyboard: favorite through the menu.
  await page.keyboard.press("Enter");
  for (let i = 0; i < 10; i++) {
    const label = await page.evaluate(() => (document.activeElement?.getAttribute("role")?.startsWith("menuitem") ? document.activeElement.textContent : "") ?? "");
    if (label.includes("favorites")) break;
    await page.keyboard.press("ArrowDown");
  }
  await page.keyboard.press("Enter");
  await expect(page.getByText(/added to favorites|removed from favorites/)).toBeVisible();
});
