// Recovery after a server restore (PROTOCOL §6.11, §12): a change the server
// acknowledged after its last backup, and this browser still holds with its
// receipt, is uploaded to the restored server with that receipt, and the
// change is back. One no request can carry stays here, listed in Diagnostics.
import { expect, test, type Page } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer, type RunningServer } from "./support/server.ts";
import { notNow } from "./support/offer.ts";

const user = "owner";
const password = "correct horse battery";

async function logIn(page: Page): Promise<void> {
  await page.getByLabel("Username").fill(user);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.locator("nav.drawer")).toBeVisible();
}

/** acknowledged counts the journal's entries the server has acknowledged. */
const acknowledged = (page: Page) =>
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
    return all.filter((e) => e.receipt).length;
  });

test("a change acknowledged after the backup comes back after a restore, with its receipt", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "the recovery logic is the same in every engine");
  const server = await startServer();
  const feed = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/rss+xml" });
    const items = [1, 2, 3].map((i) => `<item><title>Restored episode ${i}</title><guid>restored-${i}</guid></item>`).join("");
    res.end(`<rss version="2.0"><channel><title>Restored Show</title>${items}</channel></rss>`);
  });
  await new Promise<void>((r) => feed.listen(0, "127.0.0.1", r));
  const feedURL = `http://127.0.0.1:${(feed.address() as AddressInfo).port}/feed`;
  try {
    await page.goto(server.base);
    await page.getByLabel("Setup code").fill(server.setupCode);
    await page.getByLabel("Username").fill(user);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.locator("nav.drawer")).toBeVisible();
    await notNow(page);
    await page.goto(server.base + "/add");
    await page.getByLabel("Add podcast by RSS address").fill(feedURL);
    await page.getByRole("button", { name: "Episodes preview" }).click();
    await expect(page.getByRole("heading", { name: "Restored Show" })).toBeVisible();
    await page.getByRole("button", { name: "Subscribe", exact: true }).click();
    await expect(page).toHaveURL(/\/subscriptions$/);
    let podcast = "";
    await expect
      .poll(async () => (podcast = (await page.evaluate(async () => (await fetch("/v1/read/subscriptions")).json())).items?.[0]?.podcast_id ?? ""), { timeout: 60_000 })
      .toBeTruthy();
    await expect
      .poll(async () => (await page.evaluate(async (id) => (await fetch(`/v1/read/podcasts/${id}/episodes?limit=10`)).json(), podcast)).items?.length ?? 0, { timeout: 70_000 })
      .toBe(3);
    await page.goto(`${server.base}/podcast/${encodeURIComponent(podcast)}`);
    await expect(page.locator(".episode-title", { hasText: "Restored episode 1" })).toBeVisible();

    // The backup holds the subscription; what follows is after it.
    const backup = await page.evaluate(async () => (await (await fetch("/v1/admin/backup", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as { file: string });
    expect(backup.file).toBeTruthy();

    // A favorite the server acknowledges, while no view shows the head that holds it,
    // so the browser keeps it with its receipt.
    const before = await acknowledged(page);
    await page.route("**/v1/read/**", (r) => r.abort());
    const row = page.locator(".episode").filter({ hasText: "Restored episode 1" });
    await row.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Add to favorites" }).click();
    await expect.poll(() => acknowledged(page), { timeout: 20_000 }).toBeGreaterThan(before);

    // The server is restored from the backup, as its owner would do it.
    await restoreFrom(server, backup.file);
    await page.unroute("**/v1/read/**");

    const recovery: string[] = [];
    page.on("request", (r) => /\/v1\/(sync\/recovery\/|snapshot)/.test(r.url()) && recovery.push(new URL(r.url()).pathname));
    await page.goto(server.base + "/favorites");
    await expect(page.getByRole("heading", { name: "Log in to NotTennaPod" })).toBeVisible();
    // The first successor request is lost on its way, and the page is reloaded:
    // the planned handoff is finished by the next load.
    let lost = false;
    await page.route("**/v1/installations/successor", (r) => (lost ? r.continue() : ((lost = true), r.abort())));
    await logIn(page);
    await expect.poll(() => lost).toBe(true);
    await page.reload();
    await expect(page.locator("nav.drawer")).toBeVisible();
    // The browser opens a recovery, uploads the favorite with its receipt, and finishes.
    await expect
      .poll(async () => (await page.evaluate(async () => {
          // A read racing the successor handoff can meet the superseded installation (409): not yet.
          const r = await fetch("/v1/read/favorites");
          return r.ok ? (await r.json()).items.map((e: { title: string }) => e.title) : [];
        })) as string[], {
        timeout: 30_000,
      })
      .toEqual(["Restored episode 1"]);
    // The finish follows the upload that made the favorite visible.
    await expect
      .poll(async () => (await page.evaluate(async () => (await (await fetch("/v1/diagnostics")).json()) as { recoveries?: { complete: boolean; counts: { joined: number } }[] })).recoveries?.[0])
      .toMatchObject({ complete: true, counts: { joined: 1 } });
    expect(recovery).toEqual(expect.arrayContaining(["/v1/snapshot", "/v1/sync/recovery/inventory", "/v1/sync/recovery/upload", "/v1/sync/recovery/finish"]));
    await page.goto(server.base + "/settings");
    await expect(page.locator("nav.drawer")).toBeVisible();
    await expect(page.getByText(/^This browser keeps/)).toHaveCount(0);
  } finally {
    feed.close();
    await server.stop();
  }
});

/** restoreFrom restores the server from a backup, as its owner would do it. */
async function restoreFrom(server: RunningServer, backup: string): Promise<void> {
  await server.halt();
  const pass = join(server.dataDir, "..", "pass");
  writeFileSync(pass, "test-only backup passphrase", { mode: 0o600 });
  const keys = join(server.dataDir, "..", "keys.json");
  server.cli(["keys", "export", "--data-dir", server.dataDir, "--out", keys, "--passphrase-file", pass]);
  server.cli(["restore", "--data-dir", server.dataDir, "--from", join(server.dataDir, "backups", backup), "--keys", keys, "--passphrase-file", pass]);
  await server.resume();
}

test("a change no upload request can carry back stays in this browser, and Diagnostics lists it", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "the recovery logic is the same in every engine");
  const server = await startServer();
  const feed = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/rss+xml" });
    const items = [1, 2].map((i) => `<item><title>Kept episode ${i}</title><guid>kept-${i}</guid><enclosure url="https://media.example/${i}.mp3" type="audio/mpeg" length="1000"/></item>`).join("");
    res.end(`<rss version="2.0"><channel><title>Kept Show</title>${items}</channel></rss>`);
  });
  await new Promise<void>((r) => feed.listen(0, "127.0.0.1", r));
  const feedURL = `http://127.0.0.1:${(feed.address() as AddressInfo).port}/feed`;
  try {
    await page.goto(server.base);
    await page.getByLabel("Setup code").fill(server.setupCode);
    await page.getByLabel("Username").fill(user);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.locator("nav.drawer")).toBeVisible();
    await notNow(page);
    await page.goto(server.base + "/add");
    await page.getByLabel("Add podcast by RSS address").fill(feedURL);
    await page.getByRole("button", { name: "Episodes preview" }).click();
    await page.getByRole("button", { name: "Subscribe", exact: true }).click();
    await expect(page).toHaveURL(/\/subscriptions$/);
    let podcast = "";
    await expect
      .poll(async () => (podcast = (await page.evaluate(async () => (await fetch("/v1/read/subscriptions")).json())).items?.[0]?.podcast_id ?? ""), { timeout: 60_000 })
      .toBeTruthy();
    await expect
      .poll(async () => (await page.evaluate(async (id) => (await fetch(`/v1/read/podcasts/${id}/episodes?limit=10`)).json(), podcast)).items?.length ?? 0, { timeout: 70_000 })
      .toBe(2);
    await page.goto(`${server.base}/podcast/${encodeURIComponent(podcast)}`);
    const backup = await page.evaluate(async () => (await (await fetch("/v1/admin/backup", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as { file: string });

    // An add to the queue the server acknowledges after the backup, kept with its receipt: no view
    // shows it, since reads fail from its acknowledgement on (the add itself reads the queue first).
    const before = await acknowledged(page);
    let blockReads = false;
    await page.route("**/v1/read/**", (r) => (blockReads ? r.abort() : r.continue()));
    await page.route("**/v1/push", async (r) => {
      const response = await r.fetch();
      if ((r.request().postDataJSON() as { operations?: { fact?: { type: string } }[] }).operations?.some((o) => o.fact?.type === "queue.add")) blockReads = true;
      await r.fulfill({ response });
    });
    await page.locator(".episode").filter({ hasText: "Kept episode 1" }).getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Add to queue" }).click();
    await expect.poll(() => acknowledged(page), { timeout: 20_000 }).toBeGreaterThan(before);
    // Its receipt's sort values are made larger than any request can carry (a queue far longer than a test can build).
    await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((r) => {
        const q = indexedDB.open("nottennapod");
        q.onsuccess = () => r(q.result);
      });
      await new Promise<void>((resolve, reject) => {
        const t = db.transaction("journal", "readwrite");
        const store = t.objectStore("journal");
        const q = store.getAll();
        q.onsuccess = () => {
          for (const e of q.result) {
            if (e.fact.type === "queue.add" && e.receipt) {
              e.receipt.sort_values = [{ values: { title: "x".repeat(5 << 20) } }];
              store.put(e);
            }
          }
        };
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
      db.close();
    });

    await restoreFrom(server, backup.file);
    await page.unroute("**/v1/read/**");
    await page.unroute("**/v1/push");
    const uploads: string[] = [];
    page.on("request", (r) => r.url().endsWith("/v1/sync/recovery/upload") && uploads.push(r.url()));
    await page.goto(server.base + "/settings");
    await logIn(page);
    // The recovery finishes incomplete without sending it; the browser keeps it, and says which it is.
    await expect
      .poll(async () => (await page.evaluate(async () => (await (await fetch("/v1/diagnostics")).json()) as { recoveries?: { complete: boolean }[] })).recoveries?.[0]?.complete, { timeout: 30_000 })
      .toBe(false);
    expect(uploads).toEqual([]);
    await page.goto(server.base + "/settings");
    await expect(page.getByText(/^This browser keeps 1 changes the restored server could not take back/)).toBeVisible();
    const diagnostics = page.locator("section.settings-group").filter({ has: page.getByRole("heading", { name: "Diagnostics", exact: true }) });
    await expect(diagnostics.locator("li.recovery-problem")).toHaveText([/^queue\.add: too_large \(.+\)$/]);
    await expect(diagnostics.locator(".secondary")).toHaveCount(0);
  } finally {
    feed.close();
    await server.stop();
  }
});
