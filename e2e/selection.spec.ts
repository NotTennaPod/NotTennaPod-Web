// Multi select across pages and screens: Select all keeps covering the rows loaded
// later, and leaving the list ends its action mode.
import { expect, test, type Page } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { startServer } from "./support/server.ts";

const favorites = (page: Page, id: string) =>
  page.evaluate(async (id) => (await (await fetch(`/v1/read/podcasts/${id}/episodes?limit=500`)).json()).items.filter((x: { favorite: boolean }) => x.favorite).length, id);

test("Select all covers the rows loaded later, and leaving the list ends its action mode", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "the selection logic is the same in every engine");
  const server = await startServer();
  const feed = createServer((req, res) => {
    const name = req.url!.slice(1);
    res.writeHead(200, { "Content-Type": "application/rss+xml" });
    const items = Array.from({ length: 105 }, (_, i) => `<item><title>${name} episode ${i}</title><guid>${name}-${i}</guid></item>`).join("");
    res.end(`<rss version="2.0"><channel><title>Show ${name}</title>${items}</channel></rss>`);
  });
  await new Promise<void>((r) => feed.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(feed.address() as AddressInfo).port}`;
  try {
    await page.goto(server.base);
    await page.getByLabel("Setup code").fill(server.setupCode);
    await page.getByLabel("Username").fill("owner");
    await page.getByLabel("Password").fill("correct horse battery");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.locator("nav.drawer")).toBeVisible();
    const ids: string[] = [];
    for (const name of ["A", "B"]) {
      await page.goto(server.base + "/add");
      await page.getByLabel("Add podcast by RSS address").fill(`${base}/${name}`);
      await page.getByRole("button", { name: "Episodes preview" }).click();
      await expect(page.getByRole("heading", { name: `Show ${name}` })).toBeVisible();
      await page.getByRole("button", { name: "Subscribe", exact: true }).click();
      let id = "";
      await expect
        .poll(async () => (id = (await page.evaluate(async () => (await fetch("/v1/read/subscriptions")).json())).items?.find((x: { podcast_id: string }) => !ids.includes(x.podcast_id))?.podcast_id))
        .toBeTruthy();
      ids.push(id);
      await page.evaluate(async (id) => {
        await fetch("/v1/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ podcast_id: id }) });
      }, id);
      await expect
        .poll(async () => page.evaluate(async (id) => (await (await fetch(`/v1/read/podcasts/${id}/episodes`)).json()).total, id), { timeout: 60_000 })
        .toBe(105);
    }
    // Select all with 100 of 105 loaded, then the last page loads: all 105 stay selected.
    await page.goto(`${server.base}/podcast/${ids[0]}`);
    await expect(page.locator("li.episode")).toHaveCount(100);
    await page.locator("li.episode").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Multi select", exact: true }).click();
    const mode = page.locator(".toolbar.action-mode");
    await mode.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Select all", exact: true }).click();
    await expect(mode.locator("h1")).toHaveText("105/105 selected");
    await page.locator(".load-more").scrollIntoViewIfNeeded();
    await expect(page.locator("li.episode")).toHaveCount(105);
    await expect(mode.locator("h1")).toHaveText("105/105 selected");
    await expect(page.locator("li.episode").last()).toHaveClass(/selected/);
    await page.getByRole("button", { name: "Add to favorites", exact: true }).click();
    await expect.poll(() => favorites(page, ids[0]!), { timeout: 30_000 }).toBe(105);
    // Selecting in A, then opening B, leaves B with its own toolbar and plain rows.
    await page.goto(`${server.base}/podcast/${ids[0]}`);
    await page.locator("li.episode").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Multi select", exact: true }).click();
    await expect(mode).toBeVisible();
    await page.locator("nav.drawer a").filter({ hasText: "Show B" }).click();
    await expect(page.locator(".toolbar h1")).toHaveText("Show B");
    await expect(mode).toHaveCount(0);
    await expect(page.locator("li.episode .episode-main").first()).toHaveJSProperty("tagName", "A");
    expect(await favorites(page, ids[1]!)).toBe(0);
  } finally {
    await new Promise<void>((r) => feed.close(() => r()));
    await server.stop();
  }
});
