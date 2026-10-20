// A web session's answers that arrive late (PROTOCOL §5.4, §16 row 6a), with
// the browser's own cookie jar: the browser reaches the server through a small
// proxy that can hold one answer after the server has sent it, so its
// Set-Cookie reaches the browser after newer ones.
import { expect, test, type Page } from "@playwright/test";
import { createServer, request as forward, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startServer } from "./support/server.ts";
import { notNow } from "./support/offer.ts";

const user = "owner";
const password = "correct horse battery";
/** A session cookie: one per session (ntp_s_ and 16 hex digits of its hash), or an earlier server's ntp_session. */
const sessionCookie = /^ntp_(session|s_[0-9a-f]{16})$/;

interface Proxy {
  base: string;
  /** held resolves with the headers of the answer held (a request with the header X-Test-Late), once the server has sent it. */
  held: Promise<IncomingHttpHeaders>;
  /** release lets the held answer go on to the browser. */
  release: () => void;
  stop: () => Promise<void>;
}

/** startProxy passes every request to the server unchanged (its Host too), and holds the one answer asked to arrive late. */
async function startProxy(target: string): Promise<Proxy> {
  const to = new URL(target);
  let gotHeld!: (h: IncomingHttpHeaders) => void;
  const held = new Promise<IncomingHttpHeaders>((r) => (gotHeld = r));
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const server: Server = createServer((req, res) => {
    const late = req.headers["x-test-late"] === "1";
    const up = forward({ host: to.hostname, port: to.port, method: req.method, path: req.url, headers: req.headers }, (answer) => {
      const headers: string[] = [];
      for (let i = 0; i < answer.rawHeaders.length; i += 2) {
        if (!/^(connection|keep-alive)$/i.test(answer.rawHeaders[i]!)) headers.push(answer.rawHeaders[i]!, answer.rawHeaders[i + 1]!);
      }
      if (!late) {
        res.writeHead(answer.statusCode ?? 502, headers);
        answer.pipe(res);
        return;
      }
      const body: Buffer[] = [];
      answer.on("data", (d: Buffer) => body.push(d));
      answer.on("end", () => {
        gotHeld(answer.headers);
        void released.then(() => {
          res.writeHead(answer.statusCode ?? 502, headers);
          res.end(Buffer.concat(body));
        });
      });
    });
    up.on("error", () => res.destroy());
    req.pipe(up);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    held,
    release,
    stop: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

async function logIn(page: Page): Promise<void> {
  await page.getByLabel("Username").fill(user);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.locator("nav.drawer")).toBeVisible();
}

test("a session renewal whose answer arrives after logging out and in again keeps the browser logged in and syncing", async ({ browser }) => {
  const server = await startServer();
  const proxy = await startProxy(server.base);
  const feed = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/rss+xml" });
    const items = [1, 2].map((i) => `<item><title>Session episode ${i}</title><guid>session-${i}</guid></item>`).join("");
    res.end(`<rss version="2.0"><channel><title>Session Show</title>${items}</channel></rss>`);
  });
  await new Promise<void>((r) => feed.listen(0, "127.0.0.1", r));
  const feedURL = `http://127.0.0.1:${(feed.address() as AddressInfo).port}/feed`;
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const sessions = async () => (await context.cookies(proxy.base)).filter((c) => sessionCookie.test(c.name));
    await page.goto(proxy.base);
    await page.getByLabel("Setup code").fill(server.setupCode);
    await page.getByLabel("Username").fill(user);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.locator("nav.drawer")).toBeVisible();
    await notNow(page);
    const [first] = await sessions();
    expect(first, "the browser holds its session").toBeTruthy();

    // The session was last renewed over an hour ago: its next use renews it.
    await page.goto("about:blank");
    await server.halt();
    const db = new DatabaseSync(join(server.dataDir, "nottennapod.db"));
    try {
      db.prepare("UPDATE auth_tokens SET last_used_at = last_used_at - ? WHERE kind = 'web'").run(2 * 3_600_000);
    } finally {
      db.close();
    }
    await server.resume();

    // A request renews the session; its answer is held on the way to the browser.
    const other = await context.newPage();
    await other.goto(proxy.base + "/healthz");
    await other.evaluate(() => {
      (window as unknown as { late: Promise<number> }).late = fetch("/v1/session", { headers: { "X-Test-Late": "1" } }).then((r) => r.status);
    });
    const renewal = await proxy.held;
    expect(String(renewal["set-cookie"] ?? ""), "the held answer renews the session").toContain(`=${first!.value};`);

    // Meanwhile the person logs out and in again.
    await page.goto(proxy.base + "/settings");
    await expect(page.locator("nav.drawer")).toBeVisible();
    await page.getByRole("button", { name: "Logout" }).click();
    await expect(page.getByRole("heading", { name: "Log in to NotTennaPod" })).toBeVisible();
    await logIn(page);
    const signedIn = await sessions();
    expect(signedIn.map((c) => c.value), "a new session").not.toContain(first!.value);

    // The renewal's answer arrives now, and gives the browser the ended session
    // back. The app is left first, so no request of its own uses the cookies
    // before they are looked at.
    const refused: string[] = [];
    page.on("response", (r) => r.status() === 401 && refused.push(new URL(r.url()).pathname));
    await page.goto("about:blank");
    proxy.release();
    expect(await other.evaluate(() => (window as unknown as { late: Promise<number> }).late)).toBe(200);
    expect((await sessions()).map((c) => c.value), "the late answer reached the browser's cookies").toContain(first!.value);

    // The app is still logged in, and a change syncs.
    await page.goto(proxy.base + "/");
    await expect(page.locator("nav.drawer")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Log in to NotTennaPod" })).toHaveCount(0);
    await page.goto(proxy.base + "/add");
    await page.getByLabel("Add podcast by RSS address").fill(feedURL);
    await page.getByRole("button", { name: "Episodes preview" }).click();
    await expect(page.getByRole("heading", { name: "Session Show" })).toBeVisible();
    await page.getByRole("button", { name: "Subscribe", exact: true }).click();
    await expect
      .poll(async () => (await page.evaluate(async () => (await fetch("/v1/read/subscriptions")).json())).items?.map((p: { display_title: string }) => p.display_title) ?? [], {
        timeout: 60_000,
      })
      .toContain("Session Show");
    await page.reload();
    await expect(page.locator("nav.drawer")).toBeVisible();
    expect(refused, "no request was refused as signed out").toEqual([]);
    // The ended session's cookie is gone; the new one stays.
    expect((await sessions()).map((c) => c.value)).toEqual(signedIn.map((c) => c.value));
  } finally {
    await context.close();
    feed.close();
    await proxy.stop();
    await server.stop();
  }
});
