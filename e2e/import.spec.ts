// The library import's journeys (PROTOCOL §11.5), each on a fresh server with
// a new, empty account: progress while the file is read, sent, imported and
// its podcasts first refreshed ("Refreshing podcasts…"); a reload at each step;
// continuing an upload with the same file (only the missing chunks are sent);
// two tabs with the same file and with different files; Finish racing Cancel;
// a failed import after a reload; polling through an outage; the leave-page
// warning on a page of its own; another tab's logout; moving between screens;
// cancelling, then importing again.
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startServer, type RunningServer } from "./support/server.ts";
import { notNow } from "./support/offer.ts";

const MiB = 1 << 20;
const user = "owner";
const password = "correct horse battery";

/** Feeds is a feed server for the imported podcasts: each answers after a delay; those listed in failing answer 404. */
interface Feeds {
  base: string;
  failing: Set<number>;
  delay: number;
  fetched: number;
  stop: () => Promise<void>;
}

async function startFeeds(delay = 0): Promise<Feeds> {
  const feeds: Feeds = { base: "", failing: new Set(), delay, fetched: 0, stop: async () => {} };
  const server: Server = createServer((req, res) => {
    const n = Number(/feed-(\d+)\.xml/.exec(req.url ?? "")?.[1] ?? -1);
    setTimeout(() => {
      feeds.fetched++;
      if (n < 0 || feeds.failing.has(n)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/rss+xml" });
      res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Imported Show ${n}</title><link>https://example.com/</link>
<item><title>Episode ${n}</title><guid>imported-${n}</guid><enclosure url="https://media.example/${n}.mp3" length="1000" type="audio/mpeg"/></item></channel></rss>`);
    }, feeds.delay);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  feeds.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  feeds.stop = () => new Promise((r) => server.close(() => r()));
  return feeds;
}

/** opml is a podcast list of n feeds, padded with a comment to at least pad bytes (several 3 MiB chunks). */
function opml(feeds: Feeds, n: number, pad = 0): Buffer {
  let s = `<?xml version="1.0"?><opml version="2.0"><head><title>Subscriptions</title></head><body>`;
  for (let i = 0; i < n; i++) s += `<outline type="rss" text="Show ${i}" xmlUrl="${feeds.base}/feed-${i}.xml"/>`;
  s += "</body></opml>";
  if (s.length < pad) s += `<!--${"x".repeat(pad - s.length - 7)}-->`;
  return Buffer.from(s);
}

const opmlFile = (buffer: Buffer, name = "subscriptions.opml") => ({ name, mimeType: "text/x-opml", buffer });

interface World {
  server: RunningServer;
  feeds: Feeds;
  context: BrowserContext;
  page: Page;
}

let world: World | undefined;

test.afterEach(async () => {
  const w = world;
  world = undefined;
  await w?.context.close();
  await w?.feeds.stop();
  await w?.server.stop();
});

/** setUp starts a server and a feed server, creates the account and opens Add podcast. */
async function setUp(browser: import("@playwright/test").Browser, delay = 0): Promise<World> {
  const server = await startServer();
  const feeds = await startFeeds(delay);
  const context = await browser.newContext();
  const page = await context.newPage();
  world = { server, feeds, context, page };
  await page.goto(server.base + "/");
  await page.getByLabel("Setup code").fill(server.setupCode);
  await page.getByLabel("Username").fill(user);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator("nav.drawer")).toBeVisible();
  await notNow(page);
  await openAdd(page, server);
  return world;
}

async function openAdd(page: Page, server: RunningServer): Promise<void> {
  await page.goto(server.base + "/add");
  await expect(page.getByRole("button", { name: "Import podcast list (OPML)" })).toBeVisible();
}

const opmlInput = (page: Page) => page.locator("input[type=file][accept^='.opml']");
const status = (page: Page) => page.locator(".import-progress");

/** hold keeps the requests matching url waiting until released (then sent on, or failed with abort). */
async function hold(page: Page, url: string | RegExp, method = "PUT"): Promise<{ release: () => void; abort: () => void; seen: Promise<void> }> {
  let release!: () => void;
  let abort!: () => void;
  let seen!: () => void;
  const open = new Promise<"go" | "abort">((r) => {
    release = () => r("go");
    abort = () => r("abort");
  });
  const arrived = new Promise<void>((r) => (seen = r));
  await page.route(url, async (route: Route) => {
    if (route.request().method() !== method) return route.fallback();
    seen();
    if ((await open) === "abort") return route.abort().catch(() => {});
    return route.continue().catch(() => {});
  });
  return { release, abort, seen: arrived };
}

/** requests records the page's requests to the import's routes, as "METHOD path". */
function requests(page: Page): string[] {
  const out: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/v1/import")) out.push(`${r.method()} ${u.pathname}`);
  });
  return out;
}

const puts = (log: string[]) => log.filter((l) => l.startsWith("PUT ")).map((l) => l.replace(/^PUT \/v1\/import\/[^/]+\/chunks\//, ""));

/** current is the account's import as the server has it. */
async function current(page: Page): Promise<{ import_id: string; status: string; reason?: string } | null> {
  return (await page.evaluate(async () => (await (await fetch("/v1/import")).json()) as { import: never })).import;
}

/** acceptLeaving accepts the page's leave prompts (a reload while the file is sent). */
function acceptLeaving(page: Page): void {
  page.on("dialog", (d) => void d.accept().catch(() => {}));
}

test("import with progress: the file is sent, its podcasts imported with their count, and the report shown", async ({ browser }) => {
  const { page, feeds } = await setUp(browser);
  const file = opml(feeds, 400, 7 * MiB);
  const second = await hold(page, /\/chunks\/1$/);
  await opmlInput(page).setInputFiles(opmlFile(file));
  await second.seen;
  await expect(status(page)).toContainText(/^Uploading… 3\.0 MB of 7\.0 MB/);
  await expect(status(page).getByRole("progressbar")).toHaveAttribute("max", String(file.length));
  // The rows wait while the file is sent.
  await expect(page.getByRole("button", { name: "Import podcast list (OPML)" })).toBeDisabled();
  second.release();
  await expect(status(page)).toContainText(/Importing… \d+ of 400 podcasts/, { timeout: 60_000 });
  await expect(page.getByText("The podcast list imported.")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/^Imported 400 podcasts and 0 episodes/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Import podcast list (OPML)" })).toBeEnabled();
});

test("Refreshing podcasts… after the import, then how many were refreshed and which could not be", async ({ browser }) => {
  const { page, feeds } = await setUp(browser, 400);
  feeds.failing.add(3);
  await opmlInput(page).setInputFiles(opmlFile(opml(feeds, 8)));
  await expect(page.getByText("The podcast list imported.")).toBeVisible({ timeout: 60_000 });
  await expect(status(page)).toContainText(/Refreshing podcasts… [0-7] of 8/, { timeout: 30_000 });
  await expect(status(page)).toHaveText("Refreshed 7 of 8 podcasts; 1 could not be refreshed.", { timeout: 60_000 });
  // The subscriptions show the refreshed podcasts by their titles.
  await page.goto(world!.server.base + "/subscriptions");
  await expect(page.getByText("Imported Show 0", { exact: true }).first()).toBeVisible();
});

test("a reload while the file is read leaves no import; a reload after Finish follows the import to its report", async ({ browser }) => {
  const { page, feeds, server } = await setUp(browser);
  acceptLeaving(page);
  // Reading the file takes its time.
  await page.evaluate(() => {
    const real = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      return new Promise((r) => setTimeout(r, 1500)).then(() => real.call(this));
    };
  });
  await page.getByLabel("Add podcast by RSS address").click(); // the page has been used: its leave prompt counts
  await opmlInput(page).setInputFiles(opmlFile(opml(feeds, 3, 7 * MiB)));
  await expect(status(page)).toContainText(/^Reading the file… \d+%/);
  await page.reload();
  await expect(page.getByRole("button", { name: "Import podcast list (OPML)" })).toBeEnabled();
  await expect(status(page)).toHaveCount(0);
  expect(await current(page)).toBeNull();
  // After Finish: processing is followed after the reload, to the report.
  const finished = page.waitForResponse((r) => r.url().endsWith("/finish") && r.ok());
  await opmlInput(page).setInputFiles(opmlFile(opml(feeds, 3)));
  await finished;
  await page.reload();
  await expect(page.getByText("The podcast list imported.")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/^Imported 3 podcasts/)).toBeVisible();
  await page.goto(server.base + "/settings");
  await expect(page.getByText("The podcast list imported.")).toBeVisible();
});

test("reload during the upload, then continue it with the same file: only the missing chunks are sent", async ({ browser }) => {
  const { page, feeds } = await setUp(browser);
  acceptLeaving(page);
  const file = opml(feeds, 4, 8 * MiB); // three chunks
  const second = await hold(page, /\/chunks\/1$/);
  await page.getByLabel("Add podcast by RSS address").click();
  await opmlInput(page).setInputFiles(opmlFile(file));
  await second.seen;
  await page.reload();
  second.abort();
  await page.unroute(/\/chunks\/1$/);
  await expect(status(page)).toContainText("The upload of subscriptions.opml was interrupted. Choose the same file to continue it.");
  await expect(page.getByRole("button", { name: "Cancel upload" })).toBeVisible();
  // Another file is refused, the upload untouched.
  const log = requests(page);
  await opmlInput(page).setInputFiles(opmlFile(opml(feeds, 4, 8 * MiB + 1), "other.opml"));
  await expect(status(page)).toContainText("This is not subscriptions.opml, the file being uploaded. Choose that file to continue its upload.");
  expect(log).toEqual([]);
  await opmlInput(page).setInputFiles(opmlFile(file));
  await expect(page.getByText("The podcast list imported.")).toBeVisible({ timeout: 60_000 });
  expect(puts(log)).toEqual(["1", "2"]);
});

test("two tabs with the same file make one import, published once; with different files, the second is told of the other", async ({ browser }) => {
  const { page, feeds, context, server } = await setUp(browser);
  const file = opml(feeds, 3, 8 * MiB);
  const third = await hold(page, /\/chunks\/2$/);
  await opmlInput(page).setInputFiles(opmlFile(file));
  await third.seen;
  // A second tab: another file is refused with the import it would mix with.
  const other = await context.newPage();
  await openAdd(other, server);
  await expect(status(other)).toContainText("The upload of subscriptions.opml was interrupted.");
  await other.locator("input[type=file][accept^='.opml']").setInputFiles(opmlFile(opml(feeds, 2, 4 * MiB), "other.opml"));
  await expect(status(other)).toContainText("This is not subscriptions.opml, the file being uploaded.");
  // The same file continues it there, and the first tab follows when its last chunk is refused.
  await other.locator("input[type=file][accept^='.opml']").setInputFiles(opmlFile(file));
  await expect(other.getByText("The podcast list imported.")).toBeVisible({ timeout: 60_000 });
  third.release();
  await expect(page.getByText("The podcast list imported.")).toBeVisible({ timeout: 60_000 });
  const reserved = await page.evaluate(async () => (await (await fetch("/v1/import")).json()) as { import: { import_id: string; status: string } });
  expect(reserved.import.status).toBe("published");
  // A different file in a fresh tab is told this account has an import.
  const third2 = await context.newPage();
  await openAdd(third2, server);
  await third2.locator("input[type=file][accept^='.opml']").setInputFiles(opmlFile(opml(feeds, 2), "other.opml"));
  await expect(status(third2)).toContainText(
    "This account already has an import of subscriptions.opml. Only one library can be imported into an account; nothing was changed.",
  );
});

test("Finish racing Cancel, the cancel first: the upload ends in both tabs, the finish answering the cancelled import", async ({ browser }) => {
  const { page, feeds, context, server } = await setUp(browser);
  // The cancel lands first.
  const finish = await hold(page, /\/finish$/, "POST");
  await opmlInput(page).setInputFiles(opmlFile(opml(feeds, 2)));
  await finish.seen;
  const other = await context.newPage();
  await openAdd(other, server);
  await other.getByRole("button", { name: "Cancel upload" }).click();
  await expect(other.getByRole("dialog", { name: "Cancel upload" })).toContainText("Another tab or browser may still be uploading it.");
  await other.getByRole("dialog").getByRole("button", { name: "Cancel upload" }).click();
  await expect(status(other)).toHaveText("The upload was cancelled.");
  finish.release();
  await expect(status(page)).toHaveText("The upload was cancelled.");
  expect((await current(page))?.reason).toBe("cancelled");
});

test("Finish racing Cancel, the finish first: the cancel is refused and its tab follows the import; no new reservation is made", async ({ browser }) => {
  const { page, feeds, context, server } = await setUp(browser);
  const finish = await hold(page, /\/finish$/, "POST");
  await opmlInput(page).setInputFiles(opmlFile(opml(feeds, 2)));
  await finish.seen;
  const other = await context.newPage();
  await openAdd(other, server);
  const log = requests(other);
  // The other tab's cancel waits in its browser while the first tab's finish lands.
  const cancel = await hold(other, /\/cancel$/, "POST");
  await other.getByRole("button", { name: "Cancel upload" }).click();
  await other.getByRole("dialog").getByRole("button", { name: "Cancel upload" }).click();
  await cancel.seen;
  finish.release();
  await expect(page.getByText(/Importing…|The podcast list imported\./).first()).toBeVisible({ timeout: 30_000 });
  cancel.release();
  await expect(other.getByText("The podcast list imported.")).toBeVisible({ timeout: 60_000 });
  expect(log.filter((l) => l === "POST /v1/import")).toEqual([]);
  expect(log).toContain(`GET /v1/import/${(await current(page))!.import_id}`);
});

test("an import that fails says so, also after a reload, and the rows can be used again", async ({ browser }) => {
  const { page, server } = await setUp(browser);
  const failed = /^The AntennaPod backup could not be imported: invalid_file/;
  await page.locator("input[type=file][accept^='.db']").setInputFiles({ name: "AntennaPodBackup.db", mimeType: "application/octet-stream", buffer: Buffer.from("this is not a database") });
  await expect(page.getByText(failed)).toBeVisible({ timeout: 60_000 });
  await page.reload();
  await expect(page.getByText(failed)).toBeVisible();
  await expect(page.getByRole("button", { name: "Import podcast list (OPML)" })).toBeEnabled();
  await page.goto(server.base + "/settings");
  await expect(page.getByText(failed)).toBeVisible();
});

test("polling through an outage waits for the server, then carries on", async ({ browser }) => {
  const { page, feeds } = await setUp(browser, 300);
  let down = false;
  await page.route(/\/progress$/, (route) => (down ? route.abort() : route.fallback()));
  await opmlInput(page).setInputFiles(opmlFile(opml(feeds, 6)));
  await expect(page.getByText("The podcast list imported.")).toBeVisible({ timeout: 60_000 });
  down = true;
  await expect(status(page)).toContainText("Waiting for the server…", { timeout: 30_000 });
  down = false;
  await expect(page.getByText("Waiting for the server…")).toHaveCount(0, { timeout: 60_000 });
  await expect(status(page)).toHaveCount(0, { timeout: 60_000 }); // every podcast refreshed: nothing more to say
});

test("leaving while the file is sent asks first (on a page of its own): staying keeps the upload, leaving leaves it to continue later", async ({ browser }) => {
  const { context, feeds, server, page } = await setUp(browser);
  const file = opml(feeds, 3, 8 * MiB);
  const leaving = await context.newPage();
  await openAdd(leaving, server);
  const second = await hold(leaving, /\/chunks\/1$/);
  await leaving.getByLabel("Add podcast by RSS address").click(); // the page has been used: its leave prompt counts
  await leaving.locator("input[type=file][accept^='.opml']").setInputFiles(opmlFile(file));
  await second.seen;
  const asked: string[] = [];
  leaving.once("dialog", (d) => {
    asked.push(d.type());
    void d.dismiss();
  });
  await leaving.close({ runBeforeUnload: true });
  await expect.poll(() => asked).toEqual(["beforeunload"]);
  expect(leaving.isClosed()).toBe(false);
  await expect(status(leaving)).toContainText("Uploading…");
  leaving.once("dialog", (d) => {
    asked.push(d.type());
    void d.accept();
  });
  const closed = leaving.waitForEvent("close");
  await leaving.close({ runBeforeUnload: true });
  await closed;
  expect(asked).toEqual(["beforeunload", "beforeunload"]);
  // The upload continues in another page with the same file; once imported, leaving asks nothing.
  await page.reload();
  await expect(status(page)).toContainText("The upload of subscriptions.opml was interrupted.");
  await opmlInput(page).setInputFiles(opmlFile(file));
  await expect(page.getByText("The podcast list imported.")).toBeVisible({ timeout: 60_000 });
  page.on("dialog", (d) => {
    asked.push(d.type());
    void d.accept();
  });
  await page.reload();
  await expect(page.getByText("The podcast list imported.")).toBeVisible();
  expect(asked).toHaveLength(2);
});

test("another tab's logout while the file is read or sent stops the job without a prompt; the upload stays for later", async ({ browser }) => {
  const { page, feeds, context, server } = await setUp(browser);
  const asked: string[] = [];
  page.on("dialog", (d) => {
    asked.push(d.type());
    void d.dismiss();
  });
  const log = requests(page);
  const logOutElsewhere = async () => {
    const other = await context.newPage();
    await other.goto(server.base + "/settings");
    await other.getByRole("button", { name: "Logout" }).click();
    await expect(other.getByRole("heading", { name: "Log in to NotTennaPod" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Log in to NotTennaPod" })).toBeVisible({ timeout: 30_000 });
    await other.close();
  };
  const logIn = async () => {
    await page.getByLabel("Username").fill(user);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.locator("nav.drawer")).toBeVisible();
  };
  // While the file is read: nothing reaches the server.
  await page.evaluate(() => {
    const real = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      return new Promise((r) => setTimeout(r, 1500)).then(() => real.call(this));
    };
  });
  await page.getByLabel("Add podcast by RSS address").click();
  await opmlInput(page).setInputFiles(opmlFile(opml(feeds, 3, 7 * MiB)));
  await expect(status(page)).toContainText("Reading the file…");
  await logOutElsewhere();
  expect(log.filter((l) => l === "POST /v1/import")).toEqual([]);
  await logIn();
  // While it is sent: the held chunk's answer is not applied; the upload stays, resumable.
  await openAdd(page, server);
  const file = opml(feeds, 3, 8 * MiB);
  const second = await hold(page, /\/chunks\/1$/);
  await page.getByLabel("Add podcast by RSS address").click();
  await opmlInput(page).setInputFiles(opmlFile(file));
  await second.seen;
  await logOutElsewhere();
  second.release();
  expect(asked).toEqual([]);
  await logIn();
  await openAdd(page, server);
  await expect(status(page)).toContainText("The upload of subscriptions.opml was interrupted.");
  expect(puts(log).filter((n) => n === "2")).toEqual([]);
});

test("moving to another screen and back keeps the upload going; Cancel ends it, and the file imports again as a new import", async ({ browser }) => {
  const { page, feeds } = await setUp(browser);
  const file = opml(feeds, 3, 8 * MiB);
  const second = await hold(page, /\/chunks\/1$/);
  await opmlInput(page).setInputFiles(opmlFile(file));
  await second.seen;
  await page.locator("nav.drawer").getByRole("link", { name: "Queue" }).click();
  await expect(page.locator(".toolbar h1")).toHaveText("Queue");
  await page.locator("nav.drawer").getByRole("link", { name: "Add podcast" }).click();
  await expect(status(page)).toContainText("Uploading…");
  // Cancel, asked first, ends the upload; the same file is then a new import.
  await page.getByRole("button", { name: "Cancel upload" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Keep the upload" }).click();
  await expect(status(page)).toContainText("Uploading…");
  const first = (await current(page))!.import_id;
  await page.getByRole("button", { name: "Cancel upload" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel upload" }).click();
  await expect(status(page)).toHaveText("The upload was cancelled.");
  second.release();
  await page.unroute(/\/chunks\/1$/);
  await opmlInput(page).setInputFiles(opmlFile(file));
  await expect(page.getByText("The podcast list imported.")).toBeVisible({ timeout: 60_000 });
  expect((await current(page))!.import_id).not.toBe(first);
});
