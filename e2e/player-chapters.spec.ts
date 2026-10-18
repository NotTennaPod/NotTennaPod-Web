// An episode whose chapters are in a Podcast Index chapters file
// (podcast:chapters), read through the server (PROTOCOL §13): the player
// shows the Chapters button, the list has the file's chapters, and the
// position bar is split at each chapter's start (ChapterSeekBar); dragging it
// raises the chapter under the thumb and shows its title and time above.
import { expect, test, type Page } from "@playwright/test";
import { startServer, type RunningServer } from "./support/server.ts";
import { notNow } from "./support/offer.ts";
import { startPublisher, type Publisher } from "./support/player.ts";

test.describe.configure({ mode: "serial" });

const title = "Chapter file episode";
const file = {
  version: "1.2.0",
  chapters: [
    { startTime: 0, title: "Opening" },
    { startTime: 60, title: "Middle part", url: "https://example.com/middle" },
    { startTime: 180, title: "Closing" },
  ],
};

let server: RunningServer;
let publisher: Publisher;
let page: Page;

test.beforeAll(async ({ browser }) => {
  server = await startServer();
  publisher = await startPublisher("Chapters Show", [{ title, seconds: 300, chapterFile: file }]);
  page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
});

test.afterAll(async () => {
  await page?.context().close();
  await publisher?.stop();
  await server?.stop();
});

const bar = () => page.locator(".player-bar");
const audioTime = () => page.evaluate(() => Math.round(document.querySelector("audio")!.currentTime * 1000));

test("a chapters file gives the Chapters button, the list and the position bar's chapter marks", async () => {
  await page.goto(server.base + "/");
  await page.getByLabel("Setup code").fill(server.setupCode);
  await page.getByLabel("Username").fill("chapters");
  await page.getByLabel("Password").fill("chapters account password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator("nav.drawer")).toBeVisible();
  await notNow(page);
  await page.goto(server.base + "/add");
  await page.getByLabel("Add podcast by RSS address").fill(publisher.feedURL);
  await page.getByRole("button", { name: "Episodes preview" }).click();
  await page.getByRole("button", { name: "Subscribe", exact: true }).click();
  let id = "";
  await expect
    .poll(async () => (id = await page.evaluate(async () => ((await (await fetch("/v1/read/episodes?limit=5")).json()).items ?? [])[0]?.episode_id ?? "")), { timeout: 70_000 })
    .not.toBe("");
  await page.evaluate((u) => {
    history.pushState(null, "", u);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `/episode/${encodeURIComponent(id)}`);
  await page.locator(".episode-buttons").getByRole("button", { name: "Stream" }).click();
  await expect(bar().getByRole("button", { name: "Pause" })).toBeVisible();
  await bar().locator(".player-bar-open").click();
  const d = page.getByRole("dialog", { name: title });
  await d.getByRole("button", { name: "Pause" }).click();
  await expect(bar().getByRole("button", { name: "Play", exact: true })).toBeVisible();

  // The list is the file's chapters.
  await d.getByRole("button", { name: "Chapters" }).click();
  const list = page.getByRole("dialog", { name: "Chapters" });
  await expect(list.locator(".chapter-title")).toHaveText(["Opening", "Middle part", "Closing"]);
  await expect(list.getByRole("link", { name: "https://example.com/middle" })).toBeVisible();
  await expect(list.getByRole("button", { name: "Refresh" })).toBeVisible(); // ChaptersFragment's, for a chapters file
  await list.getByRole("button", { name: "Close" }).click();

  // The position bar: a segment before the first chapter (empty here), then one per chapter, split at 20 % and 60 %.
  const seek = d.locator(".seek-bar");
  const segments = seek.locator(".seek-layer").first().locator("span");
  await expect(segments).toHaveCount(4);
  const track = (await seek.locator(".seek-track").boundingBox())!;
  const boxes = await segments.evaluateAll((spans) => spans.map((s) => s.getBoundingClientRect()).map((r) => ({ left: r.left, right: r.right, width: r.width })));
  expect(boxes[0]!.width).toBe(0);
  for (const [i, at] of [[2, 0.2], [3, 0.6]] as const) {
    expect(Math.abs(boxes[i]!.left - (track.x + at * track.width))).toBeLessThan(1);
    expect(boxes[i]!.left - boxes[i - 1]!.right, "a visible divider before each chapter").toBeGreaterThanOrEqual(1.5);
  }
  // The wide window's bar has the same marks.
  await expect(bar().locator(".seek-bar .seek-layer").first().locator("span")).toHaveCount(4);

  // Dragging to 70 %: the last chapter is raised, its title and the time show above, and the drop seeks there.
  const slider = d.getByRole("slider", { name: "Position" });
  const box = (await slider.boundingBox())!;
  const y = box.y + box.height / 2;
  // Pressed on the track away from the thumb (a press on the thumb drags it with the press's offset).
  await page.mouse.move(track.x + 0.5 * track.width, y);
  await page.mouse.down();
  await page.mouse.move(track.x + 0.7 * track.width, y, { steps: 5 });
  await expect(seek).toHaveClass(/raised/);
  await expect(segments.nth(3)).toHaveClass("current");
  await expect(seek.locator(".seek-card")).toHaveText(/^Closing\s*00:03:(29|30|31)$/);
  await expect(slider).toHaveAttribute("aria-valuetext", /, Closing$/);
  await page.mouse.up();
  await expect(seek.locator(".seek-card")).toHaveCount(0);
  await expect(seek).not.toHaveClass(/raised/);
  await expect.poll(audioTime).toBeGreaterThan(208_000);
  expect(await audioTime()).toBeLessThan(212_000);
  await expect(d.locator(".player-elapsed")).toHaveText(/^00:03:(29|30|31)$/);
});
