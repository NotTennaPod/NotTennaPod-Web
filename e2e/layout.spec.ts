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
  long?.close();
  unbroken?.close();
  failing?.close();
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

// A podcast whose last refresh failed: subscribed while its feed worked, then refreshed while its address
// served a website. Its title, address and technical details have no space, so the details dialog must cut
// the one and wrap the others.
let failing: Server | undefined;
let failingBroken = false;
let failingURL = "";
const failingPodcast = "APodcastWhoseFeedBrokeAndWhoseTitleHasNoSpaceSoItCannotWrapAnywhereAtAll";
const failingWebsite = "TheWebsiteThatTookTheFeedsPlaceHasATitleWithoutASingleSpaceInIt";

async function subscribeFailing(page: Page): Promise<string> {
  if (!failing) {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>${failingPodcast}</title><link>https://example.com/</link>
<item><title>Failing episode</title><guid>failing-1</guid><pubDate>${new Date(Date.UTC(2026, 8, 1)).toUTCString()}</pubDate>
<enclosure url="https://media.example/failing.mp3" length="1000" type="audio/mpeg"/></item></channel></rss>`;
    failing = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": failingBroken ? "text/html" : "application/rss+xml" });
      res.end(failingBroken ? `<html><head><title>${failingWebsite}</title></head><body></body></html>` : rss);
    });
    await new Promise<void>((r) => failing!.listen(0, "127.0.0.1", r));
    failingURL = `http://127.0.0.1:${(failing.address() as AddressInfo).port}/a-feed-address-that-broke-and-is-far-too-long-for-a-narrow-window-to-show-on-one-line.xml`;
  }
  const find = () =>
    page.evaluate(async (title) => {
      const subs = (await (await fetch("/v1/read/subscriptions?limit=500")).json()).items as { podcast_id: string; display_title: string; records: { refresh_status?: { value: { error: unknown } } } }[];
      const p = subs.find((x) => x.display_title === title);
      if (!p) return null;
      const total = (await (await fetch(`/v1/read/podcasts/${encodeURIComponent(p.podcast_id)}/episodes?limit=5`)).json()).total as number;
      return { id: p.podcast_id, total, failed: !!p.records.refresh_status?.value.error };
    }, failingPodcast);
  if (!(await find())) {
    failingBroken = false;
    await page.goto(server.base + "/add");
    await page.getByLabel("Add podcast by RSS address").fill(failingURL);
    await page.getByRole("button", { name: "Episodes preview" }).click();
    const subscribe = page.locator(".preview").getByRole("button", { name: "Subscribe", exact: true });
    await expect(subscribe).toBeVisible({ timeout: 60_000 });
    await subscribe.click();
    await expect(page).toHaveURL(/\/subscriptions$/);
  }
  let found: { id: string; total: number; failed: boolean } | null = null;
  await expect.poll(async () => (found = await find())?.total ?? 0, { timeout: 70_000 }).toBe(1);
  if (!found!.failed) {
    failingBroken = true;
    await page.evaluate(async (id) => {
      await fetch("/v1/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ podcast_id: id }) });
    }, found!.id);
    await expect.poll(async () => (await find())?.failed, { timeout: 70_000 }).toBe(true);
  }
  return found!.id;
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

for (const dir of ["ltr", "rtl"] as const) {
  test.describe(dir, () => {
    test.use({ locale: dir === "rtl" ? "ar" : "en-US" });
    test("a feed error's icon, notice and details at 360, 800 and 1280px", async ({ page, browserName }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await signIn(page);
      const id = await subscribeFailing(page);
      const near = (a: number, b: number) => Math.abs(a - b) <= 1.5;
      const found: string[] = [];
      for (const width of [360, 800, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        // Android's errorIcon: 24 px, 8 px in from the cover's bottom and end edges.
        await page.goto(server.base + "/subscriptions");
        const tile = page.locator(".subscription-grid li").filter({ hasText: failingPodcast });
        await tile.scrollIntoViewIfNeeded();
        await expect(tile.locator(".subscription-error svg")).toBeVisible();
        const cover = (await tile.locator(".subscription-cover .cover").boundingBox())!;
        const icon = (await tile.locator(".subscription-error svg").boundingBox())!;
        const end = dir === "ltr" ? cover.x + cover.width - (icon.x + icon.width) : icon.x - cover.x;
        if (!near(icon.width, 24) || !near(cover.y + cover.height - (icon.y + icon.height), 8) || !near(end, 8)) {
          found.push(`${width}: the error icon is ${icon.width}px, ${cover.y + cover.height - (icon.y + icon.height)}px from the cover's bottom and ${end}px from its end`);
        }
        for (const p of await problems(page)) found.push(`${width} subscriptions: ${p}`);
        await page.screenshot({ path: join(root, ".work", "layout-shots", browserName, `${dir}-${width}-feed-error-tile.png`) });
        // The notice: 16 px in from the sides of the screen, its text from the start.
        await page.goto(`${server.base}/podcast/${encodeURIComponent(id)}`);
        const notice = page.locator(".refresh-failed");
        await expect(notice).toBeVisible();
        const geometry = await notice.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const content = el.parentElement!.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(el);
          const text = range.getBoundingClientRect();
          return { start: box.left - content.left, end: content.right - box.right, textLeft: text.left - box.left, textRight: box.right - text.right };
        });
        const textStart = dir === "ltr" ? geometry.textLeft : geometry.textRight;
        if (!near(geometry.start, 16) || !near(geometry.end, 16) || !near(textStart, 18)) found.push(`${width}: the notice is at ${JSON.stringify(geometry)}`);
        for (const p of await problems(page)) found.push(`${width} podcast: ${p}`);
        await page.screenshot({ path: join(root, ".work", "layout-shots", browserName, `${dir}-${width}-feed-error.png`) });
        // The details: inside the window, the address wrapped, the title cut to one line, Copy to clipboard at the start.
        await notice.click();
        const dialog = page.getByRole("dialog", { name: "Details" });
        await expect(dialog).toBeVisible();
        const d = (await dialog.boundingBox())!;
        if (d.x < 0 || d.x + d.width > width + 1) found.push(`${width}: the dialog spans ${d.x}..${d.x + d.width}px`);
        const overflowing = await dialog.evaluate((el) =>
          [...el.querySelectorAll("dd:not(.details-single-line), button")].filter((x) => x.scrollWidth > x.clientWidth + 1).map((x) => x.textContent!.slice(0, 30)),
        );
        for (const o of overflowing) found.push(`${width}: "${o}" is wider than the dialog`);
        const title = dialog.locator(".details-single-line");
        const titleLines = await title.evaluate((el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
        if (Math.round(titleLines) !== 1) found.push(`${width}: the podcast's name takes ${titleLines} lines`);
        await expect(dialog.getByRole("button", { name: failingURL })).toBeVisible();
        await expect(dialog.getByRole("button", { name: `Website title: "${failingWebsite}"` })).toBeVisible();
        const copy = (await dialog.getByRole("button", { name: "Copy to clipboard", exact: true }).boundingBox())!;
        const ok = (await dialog.getByRole("button", { name: "OK", exact: true }).boundingBox())!;
        if (dir === "ltr" ? copy.x > ok.x : copy.x < ok.x) found.push(`${width}: Copy to clipboard is not at the dialog's start`);
        await page.screenshot({ path: join(root, ".work", "layout-shots", browserName, `${dir}-${width}-feed-error-details.png`) });
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        // Settings' Diagnostics list the failure by the podcast's name, wrapped within the page.
        await page.goto(server.base + "/settings");
        await expect(page.locator(".diagnostics li").filter({ hasText: failingPodcast })).toBeVisible();
        for (const p of await problems(page)) found.push(`${width} settings: ${p}`);
        await page.screenshot({ path: join(root, ".work", "layout-shots", browserName, `${dir}-${width}-feed-error-settings.png`) });
      }
      // The drawer's row, in a wide window: the icon between the title and the counter, inside the row.
      await page.setViewportSize({ width: 1280, height: 800 });
      const row = page.locator(".nav-subscriptions a").filter({ hasText: failingPodcast });
      const rowBox = (await row.boundingBox())!;
      const label = (await row.locator(".nav-label").boundingBox())!;
      const mark = (await row.getByRole("img", { name: "Last refresh failed. Tap to view details." }).boundingBox())!;
      const between = dir === "ltr" ? mark.x >= label.x + label.width && mark.x + mark.width <= rowBox.x + rowBox.width : mark.x + mark.width <= label.x && mark.x >= rowBox.x;
      if (!between) found.push(`the drawer's error icon is at ${mark.x}, its title at ${label.x}..${label.x + label.width}`);
      expect(found).toEqual([]);
    });
  });
}

for (const dir of ["ltr", "rtl"] as const) {
  test.describe(dir, () => {
    test.use({ locale: dir === "rtl" ? "ar" : "en-US" });
    test("the import rows are Android's rows at 360 and 1280px", async ({ page, browserName }) => {
      await signIn(page);
      const found: string[] = [];
      for (const width of [360, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(server.base + "/add");
        for (const label of ["Import podcast list (OPML)", "Database import"]) {
          const row = page.locator(".import").locator("button, label").filter({ hasText: label });
          await expect(row).toBeVisible();
          // AddPodcastTextView: a row, the download icon 16 px in from the start and 8 px before the text,
          // the text centred on the row, at least 48 px tall, as wide as the section.
          const g = await row.evaluate((el) => {
            const box = el.getBoundingClientRect();
            const section = el.closest(".import")!.getBoundingClientRect();
            const icon = el.querySelector("svg")?.getBoundingClientRect() ?? new DOMRect(box.left, box.top, 0, 0);
            const range = document.createRange();
            range.selectNodeContents(el);
            for (const t of [...el.childNodes]) if (t.nodeType === Node.TEXT_NODE && t.textContent!.trim()) range.selectNode(t);
            const text = (el.querySelector("span") ?? range).getBoundingClientRect();
            return { direction: getComputedStyle(el).flexDirection, box, section, icon, text, label: el.textContent };
          });
          const rtl = dir === "rtl";
          const iconStart = rtl ? g.box.right - g.icon.right : g.icon.left - g.box.left;
          const gap = rtl ? g.icon.left - g.text.right : g.text.left - g.icon.right;
          const centre = (r: { top: number; height: number }) => r.top + r.height / 2;
          const issues = [
            g.direction !== "row" && `it is a ${g.direction}`,
            Math.abs(iconStart - 16) > 1.5 && `its icon is ${iconStart}px from its start`,
            g.icon.width !== 24 && `its icon is ${g.icon.width}px`,
            Math.abs(gap - 8) > 1.5 && `its text is ${gap}px from its icon`,
            Math.abs(centre(g.text) - centre(g.box)) > 2 && `its text is ${centre(g.text) - centre(g.box)}px off its centre`,
            g.box.height < 48 && `it is ${g.box.height}px tall`,
            (Math.abs(g.box.left - g.section.left) > 1 || Math.abs(g.box.right - g.section.right) > 1) && "it is not as wide as its section",
          ].filter(Boolean);
          for (const i of issues) found.push(`${width} "${g.label}": ${i}`);
        }
        for (const p of await problems(page)) found.push(`${width}: ${p}`);
        await page.locator(".import").scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(root, ".work", "layout-shots", browserName, `${dir}-${width}-import-rows.png`) });
      }
      expect(found).toEqual([]);
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

// Save recovery key: Settings' warning and action, then each state of the dialog (the server's answers
// stubbed: form, message, working, requested, confirming, a failed confirmation, an expired download),
// at 360 and 1280px: inside the window, nothing wider than the dialog, no button over another,
// the main action at the end and Download again at the start; Escape closes it, focus goes back to the
// button, and nothing typed is kept.
for (const dir of ["ltr", "rtl"] as const) {
  test.describe(dir, () => {
    test.use({ locale: dir === "rtl" ? "ar" : "en-US", timezoneId: "UTC" });
    test("the recovery key: Settings and each state of its dialog at 360 and 1280px", async ({ page, browserName }) => {
      await signIn(page);
      const found: string[] = [];
      const shot = (name: string) => join(root, ".work", "layout-shots", browserName, `${dir}-${name}.png`);
      for (const width of [360, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(server.base + "/settings");
        const section = page.locator(".server-section");
        const open = section.getByRole("button", { name: "Save recovery key" });
        await expect(section.getByText(/^This server has no saved recovery key\./)).toBeVisible();
        await open.scrollIntoViewIfNeeded();
        for (const p of await problems(page)) found.push(`${width} settings: ${p}`);
        await section.screenshot({ path: shot(`${width}-recovery-key-settings`), mask: [section.locator("p").filter({ hasText: /^(Data folder|Daily backups in)/ })] });
        const d = page.getByRole("dialog", { name: "Save recovery key" });
        const check = async (state: string) => {
          for (const p of await problems(page)) found.push(`${width} ${state}: ${p}`);
          const box = (await d.boundingBox())!;
          if (box.x < -1 || box.x + box.width > width + 1 || box.y < -1 || box.y + box.height > 801) found.push(`${width} ${state}: the dialog spans ${box.x}..${box.x + box.width}px`);
          found.push(
            ...(await d.evaluate((el, s) => {
              const out: string[] = [];
              const outer = el.getBoundingClientRect();
              for (const x of el.querySelectorAll("p, label, input, button")) {
                const r = x.getBoundingClientRect();
                if (r.width === 0) continue;
                if (x.scrollWidth > x.clientWidth + 1 && x.tagName !== "INPUT") out.push(`${s}: "${x.textContent!.slice(0, 30)}" is wider than itself`);
                if (r.left < outer.left - 1 || r.right > outer.right + 1) out.push(`${s}: "${(x.textContent || x.getAttribute("name"))!.slice(0, 30)}" is outside the dialog`);
              }
              const buttons = [...el.querySelectorAll(".dialog-buttons button")].map((b) => ({ b: b.getBoundingClientRect(), t: b.textContent! }));
              for (let i = 0; i < buttons.length; i++)
                for (let j = i + 1; j < buttons.length; j++) {
                  const a = buttons[i]!.b, c = buttons[j]!.b;
                  if (Math.min(a.right, c.right) - Math.max(a.left, c.left) > 1 && Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top) > 1) out.push(`${s}: "${buttons[i]!.t}" overlaps "${buttons[j]!.t}"`);
                }
              return out;
            }, `${width} ${state}`)),
          );
          await page.screenshot({ path: shot(`${width}-recovery-key-${state}`) });
          await d.screenshot({ path: shot(`${width}-recovery-key-${state}-dialog`) });
        };
        /** atEdge: the button reaches the buttons' start or end edge (left or right by direction), also when they wrap. */
        const atEdge = (name: string, edge: "start" | "end") =>
          d.evaluate(
            (el, [name, left]) => {
              const bs = [...el.querySelectorAll(".dialog-buttons button")].map((b) => ({ t: b.textContent!.trim(), r: b.getBoundingClientRect() }));
              const me = bs.find((b) => b.t === name)!.r;
              return bs.every((b) => (left ? me.left <= b.r.left + 1 : me.right >= b.r.right - 1));
            },
            [name, (edge === "start") === (dir === "ltr")] as const,
          );
        // Opened from the keyboard; Escape closes it and focus goes back to the button.
        await open.focus();
        await page.keyboard.press("Enter");
        await expect(d).toBeVisible();
        await check("form");
        await d.getByLabel("Your password").fill("typed and dropped");
        await page.keyboard.press("Escape");
        await expect(d).toHaveCount(0);
        await expect(open).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(d.getByLabel("Your password")).toHaveValue("");
        if (!(await atEdge("Download", "end"))) found.push(`${width}: Download is not at the end`);
        await d.getByLabel("Your password").fill("correct horse battery");
        await d.getByLabel("Passphrase for the file").fill("too short");
        await d.getByLabel("Passphrase again").fill("too short");
        await d.getByRole("button", { name: "Download", exact: true }).click();
        await expect(d.getByRole("alert")).toBeVisible();
        await check("message");
        // Working: the server's answer is held, then given.
        let answer!: () => void;
        const held = new Promise<void>((r) => (answer = r));
        await page.route("**/v1/admin/keys", async (r) => {
          await held;
          await r.fulfill({ json: { export_id: "00000000-0000-4000-8000-000000000001", bundle: '{"format":"nottennapod-keys"}\n', created_at: Date.UTC(2026, 9, 14) } });
        });
        await d.getByLabel("Passphrase for the file").fill("a long enough passphrase");
        await d.getByLabel("Passphrase again").fill("a long enough passphrase");
        await d.getByRole("button", { name: "Download", exact: true }).click();
        await expect(d.locator("progress")).toBeVisible();
        await expect(d.getByRole("button", { name: "Cancel" })).toBeEnabled();
        await check("working");
        const downloaded = page.waitForEvent("download");
        answer();
        expect((await downloaded).suggestedFilename()).toBe("nottennapod-recovery-key-20261014.json");
        await expect(d.getByRole("button", { name: "I have saved the file" })).toBeVisible();
        await check("requested");
        if (!(await atEdge("Download again", "start"))) found.push(`${width}: Download again is not at the start`);
        if (!(await atEdge("I have saved the file", "end"))) found.push(`${width}: I have saved the file is not at the end`);
        // Confirming: the answer is held; then it never comes.
        let fail!: () => void;
        const failing = new Promise<void>((r) => (fail = r));
        await page.route("**/v1/admin/keys/*/saved", async (r) => {
          await failing;
          await r.abort();
        });
        await d.getByRole("button", { name: "I have saved the file" }).click();
        await expect(d.locator("progress")).toBeVisible();
        await expect(d.getByRole("button", { name: "Cancel" })).toBeEnabled();
        await check("confirming");
        fail();
        await expect(d.getByRole("alert")).toHaveText("Cannot reach the server. Try again.");
        await check("requested-error");
        // The download expired: back to the form, which says so.
        await page.unroute("**/v1/admin/keys/*/saved");
        await page.route("**/v1/admin/keys/*/saved", (r) => r.fulfill({ status: 404, json: { error: "not_found", message: "Not found." } }));
        await d.getByRole("button", { name: "I have saved the file" }).click();
        await expect(d.getByRole("alert")).toHaveText("This download has expired. Save the recovery key again.");
        await expect(d.getByLabel("Your password")).toHaveValue("");
        await check("expired");
        await page.keyboard.press("Escape");
        await expect(d).toHaveCount(0);
        await expect(open).toBeFocused();
        await expect(section.getByText(/^This server has no saved recovery key\./)).toBeVisible();
        await page.unroute("**/v1/admin/keys");
        await page.unroute("**/v1/admin/keys/*/saved");
      }
      expect(found).toEqual([]);
    });
  });
}

// The Server section's backups: the lines for the copies never deleted automatically (large counts and
// sizes, stubbed), Back up now while it runs, what it made (a long file name) and a refusal for space, at
// 360 and 1280px: nothing wider than the window, no control outside it.
for (const dir of ["ltr", "rtl"] as const) {
  test.describe(dir, () => {
    test.use({ locale: dir === "rtl" ? "ar" : "en-US" });
    test("the Server section's backups and Back up now at 360 and 1280px", async ({ page, browserName }) => {
      await signIn(page);
      await page.route("**/v1/admin/service", async (route) => {
        const res = await route.fetch();
        const report = await res.json();
        report.manual_backups = { count: 128, bytes: 214_748_364_800 };
        report.pre_restore = { count: 12, bytes: 9_663_676_416 };
        await route.fulfill({ response: res, json: report });
      });
      const found: string[] = [];
      const shot = (name: string) => join(root, ".work", "layout-shots", browserName, `${dir}-${name}.png`);
      for (const width of [360, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(server.base + "/settings");
        const section = page.locator(".server-section");
        const now = section.locator(".server-backup-now");
        await expect(section.getByText(/^Backups taken by hand: 128 \(200\.0 GB\)\./)).toBeVisible();
        await expect(section.getByText(/^Databases kept by restores: 12 \(9\.0 GB\)/)).toBeVisible();
        const check = async (state: string) => {
          await now.scrollIntoViewIfNeeded();
          for (const p of await problems(page)) found.push(`${width} ${state}: ${p}`);
          found.push(
            ...(await section.evaluate((el, s) => {
              const out: string[] = [];
              const outer = el.getBoundingClientRect();
              for (const x of el.querySelectorAll("p, button, progress")) {
                const r = x.getBoundingClientRect();
                if (r.width === 0) continue;
                if (r.left < outer.left - 1 || r.right > outer.right + 1) out.push(`${s}: "${(x.textContent ?? "").slice(0, 30)}" is outside the section`);
                if (x.scrollWidth > x.clientWidth + 1) out.push(`${s}: "${(x.textContent ?? "").slice(0, 30)}" is wider than itself`);
              }
              return out;
            }, `${width} ${state}`)),
          );
          await section.screenshot({ path: shot(`${width}-server-backups-${state}`) });
        };
        await check("lines");
        // Running: held, then a backup with a long name.
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        await page.route("**/v1/admin/backup", async (r) => {
          await held;
          await r.fulfill({ json: { file: "nottennapod-20261014-031500-999.db.gz", size: 912_345_678, taken_at: Date.UTC(2026, 9, 14) } });
        });
        await now.getByRole("button", { name: "Back up now" }).click();
        await expect(now.getByRole("button", { name: "Back up now" })).toBeDisabled();
        await check("running");
        release();
        await expect(now.getByRole("status")).toHaveText("Backed up: nottennapod-20261014-031500-999.db.gz (870.1 MB).");
        await check("made");
        await page.unroute("**/v1/admin/backup");
        await page.route("**/v1/admin/backup", (r) =>
          r.fulfill({
            status: 507,
            json: {
              error: "insufficient_space",
              message: "The backup was not made: not enough free space to compress the backup: 1100 MB free, 2148 MB kept free. Older backups are kept.",
            },
          }),
        );
        await now.getByRole("button", { name: "Back up now" }).click();
        await expect(now.getByRole("alert")).toContainText("not enough free space");
        await check("refused");
        await page.unroute("**/v1/admin/backup");
      }
      expect(found).toEqual([]);
    });
  });
}

// The import's progress (PROTOCOL §11.5), each state as the server would report it (stubbed), at 360, 800 and
// 1280 px, left-to-right and right-to-left: nothing outside the window, a file name without a space wraps, the
// progress bar and the actions within the section; the Cancel dialog's buttons apart; Settings' section too.
for (const dir of ["ltr", "rtl"] as const) {
  test.describe(dir, () => {
    test.use({ locale: dir === "rtl" ? "ar" : "en-US" });
    test("the import's progress: each state at 360, 800 and 1280px", async ({ page, browserName }) => {
      await signIn(page);
      const MiB = 1 << 20;
      const file = Buffer.alloc(7 * MiB, 0x20);
      const fingerprint = createHash("sha256").update(file).digest("hex");
      const name = "AFileNameWithoutASingleSpaceThatIsLongerThanANarrowWindowCanShow-subscriptions.opml";
      const im = (status: string, extra: Record<string, unknown> = {}) => ({
        import_id: "layout-import", kind: "opml", fingerprint, size: file.length, file_name: name, status, created_at: 1, updated_at: 1, ...extra,
      });
      const result = { imported: { podcasts: 412, episodes: 0, queue: 0, favorites: 0, history: 0, inbox: 0 }, skipped: [], ambiguous: [], merged: [] };
      const refresh = (r: Record<string, unknown>) => ({ ...im("published"), refresh: { until: 1, ...r } });
      const states: [string, Record<string, unknown>, Record<string, unknown>, RegExp][] = [
        ["interrupted", im("uploading"), { ...im("uploading"), received: { chunks: [[0, 3 * MiB]], bytes: 3 * MiB } }, /was interrupted/],
        ["importing", im("processing"), { ...im("processing"), processing: { phase: "importing", done: 37, total: 412 } }, /Importing… 37 of 412 podcasts/],
        ["importing-unknown", im("processing"), { ...im("processing"), processing: null }, /^Importing…$/],
        ["refreshing", im("published", { result }), refresh({ status: "running", total: 412, attempted: 120, succeeded: 118, failed: 2 }), /Refreshing podcasts… 120 of 412/],
        ["refreshed-failed", im("published", { result }), refresh({ status: "done", total: 412, attempted: 412, succeeded: 405, failed: 7 }), /could not be refreshed/],
        ["refresh-expired", im("published", { result }), refresh({ status: "expired", total: 412, attempted: 300, succeeded: 298, failed: 2 }), /will be refreshed later/],
        ["refresh-unavailable", im("published", { result }), refresh({ status: "unavailable" }), /can.t be shown here/],
        ["failed", im("failed", { reason: "invalid_file: the file is not an AntennaPod database backup" }), im("failed"), /could not be imported/],
      ];
      const found: string[] = [];
      const shot = (n: string) => join(root, ".work", "layout-shots", browserName, `${dir}-${n}.png`);
      const check = async (what: string, width: number) => {
        for (const p of await problems(page)) found.push(`${what} ${width}: ${p}`);
        found.push(
          ...(await page.locator(".import").evaluate((section, label) => {
            const out: string[] = [];
            const s = section.getBoundingClientRect();
            for (const el of section.querySelectorAll(".import-progress p, .import-progress progress, .import-actions button, .import-report p")) {
              const r = el.getBoundingClientRect();
              if (r.width === 0) continue;
              if (r.left < s.left - 1 || r.right > s.right + 1) out.push(`${label}: "${(el.textContent ?? el.tagName).slice(0, 30)}" is outside its section`);
              if (el.scrollWidth > el.clientWidth + 1 && el.tagName !== "PROGRESS") out.push(`${label}: "${el.textContent!.slice(0, 30)}" is cut`);
            }
            return out;
          }, `${what} ${width}`)),
        );
      };
      for (const [state, cur, progress, text] of states) {
        await page.route(/\/v1\/import$/, (r) => (r.request().method() === "GET" ? r.fulfill({ json: { import: cur } }) : r.fallback()));
        await page.route(/\/v1\/import\/[^/]+\/progress$/, (r) => r.fulfill({ json: progress }));
        await page.route(/\/v1\/import\/layout-import$/, (r) => r.fulfill({ json: cur }));
        for (const width of [360, 800, 1280]) {
          await page.setViewportSize({ width, height: 800 });
          await page.goto(server.base + "/add");
          await expect(page.locator(".import").getByText(text).first()).toBeVisible();
          await page.locator(".import").scrollIntoViewIfNeeded();
          await check(state, width);
          await page.screenshot({ path: shot(`${width}-import-${state}`), fullPage: true });
        }
        await page.unrouteAll({ behavior: "ignoreErrors" });
      }
      // Sending the file (a chunk held), the Cancel dialog, and Settings' section, at 360 and 1280.
      await page.route(/\/v1\/import$/, (r) =>
        r.request().method() === "GET" ? r.fulfill({ json: { import: null } }) : r.fulfill({ status: 201, json: im("uploading") }),
      );
      await page.route(/\/v1\/import\/[^/]+\/progress$/, (r) => r.fulfill({ json: { ...im("uploading"), received: { chunks: [], bytes: 0 } } }));
      await page.route(/\/chunks\/0$/, (r) => r.fulfill({ json: {} }));
      await page.route(/\/chunks\/1$/, () => {}); // held
      await page.goto(server.base + "/add");
      await page.locator("input[type=file][accept^='.opml']").setInputFiles({ name, mimeType: "text/x-opml", buffer: file });
      await expect(page.locator(".import-progress")).toContainText("Uploading… 3.0 MB of 7.0 MB");
      for (const width of [360, 800, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await page.locator(".import").scrollIntoViewIfNeeded();
        await check("uploading", width);
        await page.screenshot({ path: shot(`${width}-import-uploading`), fullPage: true });
      }
      for (const width of [360, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await page.getByRole("button", { name: "Cancel upload" }).click();
        const d = page.getByRole("dialog", { name: "Cancel upload" });
        await expect(d).toBeVisible();
        for (const p of await problems(page)) found.push(`cancel dialog ${width}: ${p}`);
        const [keep, cancel] = [await d.getByRole("button", { name: "Keep the upload" }).boundingBox(), await d.getByRole("button", { name: "Cancel upload" }).boundingBox()];
        if (!keep || !cancel || (Math.min(keep.x + keep.width, cancel.x + cancel.width) - Math.max(keep.x, cancel.x) > 1 && Math.min(keep.y + keep.height, cancel.y + cancel.height) - Math.max(keep.y, cancel.y) > 1)) {
          found.push(`cancel dialog ${width}: its buttons overlap`);
        }
        await page.screenshot({ path: shot(`${width}-import-cancel-dialog`) });
        await d.getByRole("button", { name: "Keep the upload" }).click();
        await expect(d).toHaveCount(0);
      }
      // Settings shows the same job.
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.locator("nav.drawer").getByRole("link", { name: "Settings" }).click();
      for (const width of [360, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        const section = page.locator(".settings-group").filter({ has: page.getByRole("heading", { name: "Import" }) });
        await expect(section.getByText(/Uploading…/)).toBeVisible();
        for (const p of await problems(page)) found.push(`settings ${width}: ${p}`);
        await section.scrollIntoViewIfNeeded();
        await page.screenshot({ path: shot(`${width}-import-settings`) });
      }
      await page.unrouteAll({ behavior: "ignoreErrors" });
      expect(found).toEqual([]);
    });
  });
}

// The import report of an AntennaPod backup (PROTOCOL §11.5), stubbed, at 360 and 1280 px, left-to-right and
// right-to-left: its lists open, and what stays on the device the backup came from (podcast settings, with a title
// without a space, and the episodes kept from automatic download) inside the section, nothing cut.
for (const dir of ["ltr", "rtl"] as const) {
  test.describe(dir, () => {
    test.use({ locale: dir === "rtl" ? "ar" : "en-US" });
    test("the import report: what is not carried at 360 and 1280px", async ({ page, browserName }) => {
      await signIn(page);
      const settings = ["custom_title", "tags", "playback_speed", "skip_silence", "skip_intro", "skip_ending", "volume_adaptation",
        "episode_notification", "auto_delete", "auto_download", "auto_download_filter", "episode_list_filter", "sort_order"];
      const result = {
        imported: { podcasts: 70, episodes: 26271, queue: 13, favorites: 0, history: 31, inbox: 0 },
        skipped: [{ reason: "local_folder", title: "Local Folder", source_feed_id: 4 }],
        ambiguous: [],
        merged: [{ kind: "podcast", title: "Merged Show", source_feed_ids: [5, 6] }],
        not_carried: {
          podcasts: [
            { title: unbrokenPodcast, url: "https://feeds.example/unbroken.xml", source_feed_id: 2, settings },
            { title: "A podcast with a playback speed", url: "https://feeds.example/a.xml", source_feed_id: 3, settings: ["playback_speed"] },
            // Two feeds with one title are told apart by their addresses.
            { title: "A podcast with a playback speed", url: `https://feeds.example/${"b".repeat(90)}.xml`, source_feed_id: 7, settings: ["tags"] },
          ],
          episode_auto_download_off: 36,
        },
      };
      const cur = { import_id: "layout-report", kind: "android_db", fingerprint: "0".repeat(64), size: 1000, file_name: "AntennaPodBackup.db",
        status: "published", created_at: 1, updated_at: 1, result };
      await page.route(/\/v1\/import$/, (r) => (r.request().method() === "GET" ? r.fulfill({ json: { import: cur } }) : r.fallback()));
      await page.route(/\/v1\/import\/[^/]+\/progress$/, (r) =>
        r.fulfill({ json: { ...cur, result: undefined, refresh: { status: "done", total: 70, attempted: 70, succeeded: 70, failed: 0, until: 1 } } }),
      );
      await page.route(/\/v1\/import\/layout-report$/, (r) => r.fulfill({ json: cur }));
      const found: string[] = [];
      const shot = (n: string) => join(root, ".work", "layout-shots", browserName, `${dir}-${n}.png`);
      for (const width of [360, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(server.base + "/add");
        const report = page.locator(".import-report");
        const summary = report.getByText("Podcast settings not imported (3)");
        await expect(summary).toBeVisible();
        await summary.click();
        await expect(report.getByText("Custom title, Tags, Playback speed", { exact: false })).toBeVisible();
        await expect(report.getByText("https://feeds.example/a.xml", { exact: false })).toBeVisible();
        await expect(report.getByText(/didn't download automatically: 36\./)).toBeVisible();
        await report.scrollIntoViewIfNeeded();
        for (const p of await problems(page)) found.push(`${width}: ${p}`);
        found.push(
          ...(await page.locator(".import").evaluate((section, label) => {
            const out: string[] = [];
            const s = section.getBoundingClientRect();
            for (const el of section.querySelectorAll(".import-report p, .import-report summary, .import-report li")) {
              const r = el.getBoundingClientRect();
              if (r.width === 0) continue;
              if (r.left < s.left - 1 || r.right > s.right + 1) out.push(`${label}: "${(el.textContent ?? "").slice(0, 30)}" is outside its section`);
              if (el.scrollWidth > el.clientWidth + 1) out.push(`${label}: "${(el.textContent ?? "").slice(0, 30)}" is cut`);
            }
            return out;
          }, String(width))),
        );
        await page.screenshot({ path: shot(`${width}-import-not-carried`), fullPage: true });
      }
      await page.unrouteAll({ behavior: "ignoreErrors" });
      expect(found).toEqual([]);
    });
  });
}

// Refresh (Android's refresh_item) on every screen that has it, at 360 and 1280 px, left-to-right and
// right-to-left: the item where Android's menu has it (menus are ordered by category, so Refresh, a container item,
// follows the uncategorized ones: after Sort and Clear queue on Queue, after Sort on Inbox and Episodes, last on
// Subscriptions; first on Home and Favorites; after Sort on a podcast's screen), the menu inside the window, no two
// toolbar buttons with one name, and the progress of a refresh (stubbed, held) at the list's top, under the
// toolbar, inside the window.
for (const dir of ["ltr", "rtl"] as const) {
  test.describe(dir, () => {
    test.use({ locale: dir === "rtl" ? "ar" : "en-US" });
    test("Refresh and its progress at 360 and 1280px", async ({ page, browserName }) => {
      await signIn(page);
      const pending = (id: string, seq: number) => ({
        podcast_id: id, last_attempt: null, last_success: null, error: null, next_attempt: 1, in_progress: true,
        request_seq: seq, done_seq: 0, running: false, merged_into: null,
      });
      await page.route(/\/v1\/refresh(\?.*)?$/, (r) =>
        r.request().method() === "POST"
          ? r.fulfill({ status: 202, json: { podcasts: [pending("p1:" + "a".repeat(64), 1), pending("p1:" + "b".repeat(64), 1)] } })
          : r.fulfill({ json: { podcasts: [pending("p1:" + "a".repeat(64), 1), pending("p1:" + "b".repeat(64), 1)] } }),
      );
      const withRefresh: [string, string, number][] = [
        ["home", "/", 0], ["queue", "/queue", 2], ["inbox", "/inbox", 1], ["episodes", "/episodes", 1],
        ["favorites", "/favorites", 0], ["subscriptions", "/subscriptions", -1], ["podcast", podcastPath, 1],
      ];
      const found: string[] = [];
      const shot = (n: string) => join(root, ".work", "layout-shots", browserName, `${dir}-${n}.png`);
      for (const width of [360, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        for (const [name, path, at] of withRefresh) {
          await page.goto(server.base + path);
          await expect(page.locator(".toolbar h1")).toBeVisible();
          const names = await page.locator(".toolbar button").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label")));
          if (new Set(names).size !== names.length) found.push(`${name} ${width}: toolbar buttons share a name: ${names.join(", ")}`);
          await page.locator(".toolbar").getByRole("button", { name: "More" }).click();
          const items = page.getByRole("menu").getByRole("menuitem");
          await expect(at < 0 ? items.last() : items.nth(at)).toHaveText("Refresh");
          for (const p of await problems(page)) found.push(`${name} ${width} menu: ${p}`);
          const menu = (await page.getByRole("menu").boundingBox())!;
          if (menu.x < -1 || menu.x + menu.width > width + 1) found.push(`${name} ${width}: the menu spans ${menu.x}..${menu.x + menu.width}px`);
          await page.screenshot({ path: shot(`${width}-refresh-menu-${name}`) });
          await (at < 0 ? items.last() : items.nth(at)).click();
          const bar = page.getByRole("status").filter({ hasText: "Refreshing podcasts… 0 of 2" });
          await expect(bar).toBeVisible();
          const toolbar = (await page.locator(".toolbar").boundingBox())!;
          const b = (await bar.boundingBox())!;
          if (b.y < toolbar.y + toolbar.height - 1) found.push(`${name} ${width}: the progress is under the toolbar`);
          if (b.x < -1 || b.x + b.width > width + 1) found.push(`${name} ${width}: the progress spans ${b.x}..${b.x + b.width}px`);
          const p = await bar.locator("progress").evaluate((el) => ({ max: (el as HTMLProgressElement).max, value: (el as HTMLProgressElement).value, label: el.getAttribute("aria-label") }));
          if (p.max !== 2 || p.value !== 0 || p.label !== "Refreshing podcasts… 0 of 2") found.push(`${name} ${width}: the progress is ${JSON.stringify(p)}`);
          for (const x of await problems(page)) found.push(`${name} ${width}: ${x}`);
          await page.screenshot({ path: shot(`${width}-refreshing-${name}`) });
        }
      }
      await page.unrouteAll({ behavior: "ignoreErrors" });
      expect(found).toEqual([]);
    });
  });
}

// Subscriptions' Sort is Android's: an item of the overflow menu opening its single-choice dialog (FeedSortDialog),
// not a second overflow button; picking an order applies it and closes the dialog, at 360 and 1280 px.
for (const dir of ["ltr", "rtl"] as const) {
  test.describe(dir, () => {
    test.use({ locale: dir === "rtl" ? "ar" : "en-US" });
    test("Subscriptions: Sort in the overflow menu opens a single-choice dialog", async ({ page, browserName }) => {
      await signIn(page);
      const found: string[] = [];
      for (const width of [360, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(server.base + "/subscriptions");
        await expect(page.locator(".toolbar").getByRole("button")).toHaveCount(2); // Filter and More (the drawer button is outside the toolbar)
        await expect(page.locator(".toolbar").getByRole("button", { name: "More" })).toHaveCount(1);
        await page.locator(".toolbar").getByRole("button", { name: "More" }).click();
        await page.getByRole("menuitem", { name: "Sort", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Sort" });
        await expect(dialog.getByRole("radio")).toHaveCount(4);
        for (const p of await problems(page)) found.push(`${width}: ${p}`);
        await page.screenshot({ path: join(root, ".work", "layout-shots", browserName, `${dir}-${width}-subscriptions-sort.png`) });
        const pick = width === 360 ? "Sort alphabetically" : "Sort by counter";
        await dialog.getByRole("radio", { name: pick }).click(); // picking applies and closes (check() would wait to see it checked)
        await expect(dialog).toHaveCount(0);
        await page.locator(".toolbar").getByRole("button", { name: "More" }).click();
        await page.getByRole("menuitem", { name: "Sort", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "Sort" }).getByRole("radio", { name: pick })).toBeChecked();
        await page.getByRole("dialog", { name: "Sort" }).getByRole("button", { name: "Cancel" }).click();
        await expect(page.getByRole("dialog", { name: "Sort" })).toHaveCount(0);
        // The current choice closes the dialog too (Android's dismisses on any choice), and keeps the order.
        await page.locator(".toolbar").getByRole("button", { name: "More" }).click();
        await page.getByRole("menuitem", { name: "Sort", exact: true }).click();
        await page.getByRole("dialog", { name: "Sort" }).getByRole("radio", { name: pick }).click();
        await expect(page.getByRole("dialog", { name: "Sort" })).toHaveCount(0);
        await page.locator(".toolbar").getByRole("button", { name: "More" }).click();
        await page.getByRole("menuitem", { name: "Sort", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "Sort" }).getByRole("radio", { name: pick })).toBeChecked();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog", { name: "Sort" })).toHaveCount(0);
      }
      expect(found).toEqual([]);
    });
  });
}

// A long list read again around the screen (PROTOCOL §12): the spacer that stands for the rows above,
// Load previous page just above the first row, the rows on screen kept in place, nothing outside the
// window, at 360 and 1280 px.
let long: Server | undefined;
let longURL = "";
const longTitle = "Long layout show";

async function subscribeLong(page: Page): Promise<string> {
  if (!long) {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>${longTitle}</title><link>https://example.com/</link>${Array.from(
      { length: 600 },
      (_, i) => `<item><title>Long layout episode ${i}</title><guid>long-layout-${i}</guid><pubDate>${new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toUTCString()}</pubDate>
<enclosure url="https://media.example/long-layout-${i}.mp3" length="1000" type="audio/mpeg"/></item>`,
    ).join("")}</channel></rss>`;
    long = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/rss+xml" });
      res.end(rss);
    });
    await new Promise<void>((r) => long!.listen(0, "127.0.0.1", r));
    longURL = `http://127.0.0.1:${(long.address() as AddressInfo).port}/long.xml`;
  }
  const find = () =>
    page.evaluate(async (title) => {
      const subs = (await (await fetch("/v1/read/subscriptions?limit=500")).json()).items as { podcast_id: string; display_title: string }[];
      const p = subs.find((x) => x.display_title === title);
      if (!p) return null;
      return { id: p.podcast_id, total: (await (await fetch(`/v1/read/podcasts/${encodeURIComponent(p.podcast_id)}/episodes?limit=1`)).json()).total as number };
    }, longTitle).catch(() => null);
  if (!(await find())) {
    await page.goto(server.base + "/add");
    await page.getByLabel("Add podcast by RSS address").fill(longURL);
    await page.getByRole("button", { name: "Episodes preview" }).click();
    const subscribe = page.locator(".preview").getByRole("button", { name: "Subscribe", exact: true });
    const open = page.locator(".preview").getByRole("button", { name: "Open podcast", exact: true });
    await expect(subscribe.or(open)).toBeVisible({ timeout: 60_000 });
    if (await subscribe.count()) {
      await subscribe.click();
      await expect(page).toHaveURL(/\/subscriptions$/);
    }
  }
  let found: { id: string; total: number } | null = null;
  await expect.poll(async () => (found = await find())?.total ?? 0, { timeout: 120_000 }).toBe(600);
  return found!.id;
}

for (const dir of ["ltr", "rtl"] as const) {
  test.describe(dir, () => {
    test.use({ locale: dir === "rtl" ? "ar" : "en-US" });
    test("a list window: the rows above, Load previous page and the rows kept at 360 and 1280px", async ({ page, browserName }) => {
      await signIn(page);
      const id = await subscribeLong(page);
      const found: string[] = [];
      const shot = (n: string) => join(root, ".work", "layout-shots", browserName, `${dir}-${n}.png`);
      const topOf = (row: string) => page.evaluate((row) => document.querySelector(`li[data-id="${CSS.escape(row)}"]`)?.getBoundingClientRect().top ?? null, row);
      for (const width of [360, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`${server.base}/podcast/${encodeURIComponent(id)}`);
        await expect(page.locator("li.episode")).toHaveCount(100, { timeout: 30_000 });
        // Load more until row 350 is held. The server's own work (the imported library's feeds being
        // refreshed) moves the head now and then; each time the list is read again around the screen, so
        // the rows held are a window, not a count to reach: load on until the row is there.
        const row350 = page.locator("li.episode").filter({ has: page.locator(".episode-title", { hasText: /^Long layout episode 249$/ }) });
        await expect(async () => {
          if (!(await row350.count())) await page.locator(".load-more").last().click();
          expect(await row350.count()).toBe(1);
        }).toPass({ timeout: 60_000 });
        const anchor = (await row350.getAttribute("data-id"))!;
        const at = await page.evaluate((row) => {
          const el = document.querySelector(`li[data-id="${CSS.escape(row)}"]`)!;
          el.scrollIntoView({ block: "center" });
          return el.getBoundingClientRect().top;
        }, anchor);
        // The window regains focus: the list is read again around the screen.
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(page.locator(".list-spacer")).toBeAttached({ timeout: 15_000 });
        await expect.poll(() => page.locator("li.episode").count()).toBeLessThanOrEqual(200);
        const moved = Math.abs((await topOf(anchor))! - at);
        if (moved > 1) found.push(`${width}: the rows on screen moved ${moved}px`);
        for (const p of await problems(page)) found.push(`${width} window: ${p}`);
        await page.screenshot({ path: shot(`${width}-list-window`) });
        // Scrolled up to the first row: the end of the spacer and Load previous page (its read held, to see them).
        const held: (() => Promise<void>)[] = [];
        const tokens = (u: URL) => u.pathname.endsWith("/episodes") && u.searchParams.has("page_token");
        let holding = true;
        await page.route(tokens, (r) => void (holding ? held.push(() => r.continue()) : r.continue()));
        await page.evaluate(() => {
          const b = document.querySelector(".list-spacer + .load-more")!;
          window.scrollBy(0, b.getBoundingClientRect().top - 300);
        });
        const button = page.getByRole("button", { name: "Load previous page" });
        await expect(button).toBeInViewport();
        const b = (await button.boundingBox())!;
        const first = (await page.locator("li.episode").first().boundingBox())!;
        if (b.x < -1 || b.x + b.width > width + 1) found.push(`${width}: Load previous page spans ${b.x}..${b.x + b.width}px`);
        if (b.y + b.height > first.y + 1) found.push(`${width}: Load previous page overlaps the first row`);
        for (const p of await problems(page)) found.push(`${width} above: ${p}`);
        await page.screenshot({ path: shot(`${width}-list-window-above`) });
        const firstId = await page.locator("li.episode").first().getAttribute("data-id");
        await expect.poll(() => held.length).toBeGreaterThan(0);
        holding = false;
        for (const go of held.splice(0)) await go();
        await expect.poll(() => page.locator("li.episode").first().getAttribute("data-id")).not.toBe(firstId);
        await page.unroute(tokens);
        // The rows below: a spacer stands for them, and End reaches the last row with one read. (A
        // re-read for the server's own changes may have brought the window to the end of the list:
        // then no row is below it, and nothing stands for them.)
        const below = page.locator(".list-spacer-below");
        const last = page.locator(".episode-title", { hasText: /^Long layout episode 0$/ });
        await expect.poll(async () => (await below.count()) + (await last.count()), { timeout: 15_000 }).toBeGreaterThan(0);
        if (!(await last.count())) await expect(below).toBeAttached();
        if (await below.count()) {
          const sb = (await below.boundingBox())!;
          if (sb.x < -1 || sb.x + sb.width > width + 1) found.push(`${width}: the spacer below spans ${sb.x}..${sb.x + sb.width}px`);
        }
        await page.keyboard.press("End");
        await expect(page.locator(".episode-title", { hasText: /^Long layout episode 0$/ })).toBeInViewport({ timeout: 15_000 });
        await expect(below).toHaveCount(0);
        for (const p of await problems(page)) found.push(`${width} end: ${p}`);
        await page.screenshot({ path: shot(`${width}-list-window-end`) });
      }
      expect(found).toEqual([]);
    });
  });
}
