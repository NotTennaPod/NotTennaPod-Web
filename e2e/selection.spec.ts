// Multi select across pages and screens: Select all keeps covering the rows loaded
// later, and leaving the list ends its action mode; Undo of a removal of a
// power user's whole queue puts it back as it was, and Undo split into several
// facts gives what one restore gives on the server.
import "fake-indexeddb/auto"; // the journals of the devices of the Undo differential
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { startServer } from "./support/server.ts";
import { notNow } from "./support/offer.ts";
import * as act from "../src/app/actions.ts";
import { addToQueue, restoreAt, savedIndexes } from "../src/app/queueOps.ts";
import type { EpisodeRow, ListPage, Summary } from "../src/api/views.ts";
import { openDB } from "../src/journal/db.ts";
import { append, appendAll, installation, newAuthor, updateInstallation, type FactBody } from "../src/journal/journal.ts";
import { pushAll, type PushResponse } from "../src/journal/pusher.ts";

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
    await notNow(page);
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


test("Undo of a multi-select removal of a queue of 9,000 episodes puts every episode back in its place, on the server and after a reload", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Undo's facts are the same in every engine (test/bulkSize.test.ts)");
  // Three podcasts of 3,000 episodes each, with titles, GUIDs and media addresses of an ordinary length.
  const perPodcast = 3000;
  const names = ["A", "B", "C"];
  const count = perPodcast * names.length;
  const day = 86_400_000;
  const feed = createServer((req, res) => {
    const name = req.url!.slice(1);
    const items = Array.from({ length: perPodcast }, (_, i) =>
      `<item><title>Show ${name} episode ${i}: a conversation about the week's news, with listener questions</title><guid>https://show-${name}.example/episodes/${i}/0b789767-6617-4824-b6e6</guid>` +
      `<pubDate>${new Date(Date.UTC(2010, 0, 1) + i * day).toUTCString()}</pubDate><enclosure url="https://media.show-${name}.example/audio/episode-${i}-a-conversation-about-the-weeks-news.mp3" length="1000" type="audio/mpeg"/></item>`,
    ).join("");
    res.writeHead(200, { "Content-Type": "application/rss+xml" });
    res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Show ${name}</title><link>https://example.com/</link>${items}</channel></rss>`);
  });
  await new Promise<void>((r) => feed.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(feed.address() as AddressInfo).port}`;
  const server = await startServer();
  /** queue is the server's queue: its episodes in order, and the position each was last placed with. */
  const queue = () =>
    page.evaluate(async () => {
      const ids: string[] = [];
      const positions: string[] = [];
      let token = "";
      do {
        const p = await (await fetch(`/v1/read/queue?limit=500${token ? `&page_token=${encodeURIComponent(token)}` : ""}`)).json();
        for (const x of p.items as { episode_id: string; records: { queue_position?: { value: { position_id: string } } } }[]) {
          ids.push(x.episode_id);
          positions.push(x.records.queue_position?.value.position_id ?? "");
        }
        token = p.next_page_token ?? "";
      } while (token);
      return { ids, positions };
    });
  const order = async () => (await queue()).ids;
  const mode = page.locator(".toolbar.action-mode");
  /** selectAll starts multi select on the list's first row and selects every row of the list. */
  const selectAll = async (n: number) => {
    await page.locator("li.episode").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Multi select", exact: true }).click();
    await mode.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Select all", exact: true }).click();
    await expect(mode.locator("h1")).toHaveText(`${n}/${n} selected`);
  };
  try {
    await page.goto(server.base);
    await page.getByLabel("Setup code").fill(server.setupCode);
    await page.getByLabel("Username").fill("owner");
    await page.getByLabel("Password").fill("correct horse battery");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.locator("nav.drawer")).toBeVisible();
    await notNow(page);
    const ids: string[] = [];
    for (const name of names) {
      await page.goto(server.base + "/add");
      await page.getByLabel("Add podcast by RSS address").fill(`${base}/${name}`);
      await page.getByRole("button", { name: "Episodes preview" }).click();
      await expect(page.getByRole("heading", { name: `Show ${name}` })).toBeVisible({ timeout: 120_000 });
      await page.getByRole("button", { name: "Subscribe", exact: true }).click();
      let id = "";
      await expect
        .poll(async () => (id = (await page.evaluate(async () => (await fetch("/v1/read/subscriptions")).json()).catch(() => ({}))).items?.find((x: { podcast_id: string }) => !ids.includes(x.podcast_id))?.podcast_id ?? ""), { timeout: 60_000 })
        .toBeTruthy();
      ids.push(id);
      // The app moves on to the podcast once subscribed; a request cut by that navigation is sent again.
      await expect(async () => {
        const status = await page.evaluate(async (id) => {
          const r = await fetch("/v1/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ podcast_id: id }) });
          return r.status;
        }, id);
        expect(status).toBeLessThan(300);
      }).toPass({ timeout: 60_000 });
      await expect
        .poll(async () => page.evaluate(async (id) => (await (await fetch(`/v1/read/podcasts/${encodeURIComponent(id)}/episodes`)).json()).total, id).catch(() => 0), { timeout: 300_000 })
        .toBe(perPodcast);
      // The podcast's episodes go to the end of the queue, in the list's order.
      await page.goto(`${server.base}/podcast/${id}`);
      await selectAll(perPodcast);
      await page.getByRole("button", { name: "Add to queue", exact: true }).click();
      await expect.poll(async () => (await order()).length, { timeout: 300_000, intervals: [2000] }).toBe(ids.length * perPodcast);
    }
    const { ids: before, positions: placed } = await queue();
    expect(before).toHaveLength(count);
    const first = await page.evaluate(async () => (await (await fetch("/v1/read/queue?limit=1")).json()).items[0].title as string);
    await page.goto(server.base + "/queue");
    await selectAll(count);
    await page.getByRole("button", { name: "Remove from queue", exact: true }).click();
    // A person undoes it at once, while the removal is still being sent: once
    // the server has the removal, every episode is placed again, in its place.
    await page.locator(".snackbar").getByRole("button", { name: "Undo" }).click({ timeout: 120_000 });
    const old = new Set(placed);
    await expect
      .poll(async () => (await queue()).positions.filter((p) => p && !old.has(p)).length, { timeout: 300_000, intervals: [2000] })
      .toBe(count);
    expect(await order()).toEqual(before);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.reload();
    await expect(page.locator("li.episode .episode-title").first()).toHaveText(first);
    expect(await order()).toEqual(before);
  } finally {
    await new Promise<void>((r) => feed.close(() => r()));
    await server.stop();
  }
});

test("Undo split into several facts gives the queue one restore gives, when another device queued some of them again first (on the server)", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "no browser: the facts the web journals, and the server's queue");
  const labels = ["P", "R1", "R2", "R3", "R4", "R5", "R6", "T"];
  const feed = createServer((_req, res) => {
    const items = labels.map((l, i) => `<item><title>${l}</title><guid>differential-${l}</guid><pubDate>${new Date(Date.UTC(2020, 0, 1 + i)).toUTCString()}</pubDate>` +
      `<enclosure url="https://media.example/differential-${l}.mp3" length="1000" type="audio/mpeg"/></item>`).join("");
    res.writeHead(200, { "Content-Type": "application/rss+xml" });
    res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Differential</title><link>https://example.com/</link>${items}</channel></rss>`);
  });
  await new Promise<void>((r) => feed.listen(0, "127.0.0.1", r));
  const feedURL = `http://127.0.0.1:${(feed.address() as AddressInfo).port}/feed.xml`;

  /** A device: a web session with its own installation, journal and author, as the app keeps them. */
  async function device(base: string, signIn: (http: APIRequestContext) => Promise<unknown>) {
    const http = await request.newContext({ baseURL: base, extraHTTPHeaders: { Origin: base } });
    const call = async <T>(method: "get" | "post", path: string, data?: unknown): Promise<T> => {
      const r = await http[method](path, data === undefined ? {} : { data });
      if (!r.ok()) throw new Error(`${method} ${path}: ${r.status()} ${await r.text()}`);
      return (await r.json()) as T;
    };
    await signIn(http);
    const account = (await call<{ account: { account_id: string } }>("get", "/v1/session")).account.account_id;
    const db = await openDB(indexedDB, `differential-${crypto.randomUUID()}`);
    const inst = await installation(db, account);
    await call("post", "/v1/installations", { install_id: inst.install_id, instance_nonce: inst.instance_nonce, name: "Device", app_version: "0.1.0", capabilities: ["queue"] });
    await updateInstallation(db, account, (r) => (r.registered = true));
    const author = await newAuthor(db, account);
    /** shown is a view's head: the cursor pushes name. */
    const shown = <T extends { head: { cursor: string } }>(v: T) => updateInstallation(db, account, (r) => (r.cursor = v.head.cursor)).then(() => v);
    const push = async () => {
      const out = await pushAll(db, account, (body) => call<PushResponse>("post", "/v1/push", body));
      expect(out.stopped).toBeNull();
      expect(out.remaining).toBe(0);
    };
    return {
      call,
      queue: async () => (await shown(await call<ListPage<EpisodeRow>>("get", "/v1/read/queue?limit=500"))).items,
      policy: async () => (await shown(await call<Summary>("get", "/v1/read/summary"))).policies.queue,
      /** act journals the facts together, as the app does, and sends them. */
      act: async (bodies: FactBody[]) => {
        await appendAll(db, account, author.author_id, bodies);
        await push();
      },
      subscribe: async () => {
        await shown(await call<Summary>("get", "/v1/read/summary"));
        await append(db, account, author.author_id, act.subscribe(feedURL));
        await push();
      },
      stop: () => http.dispose(),
    };
  }

  /**
   * undo removes R1–R6 on one device and undoes it from the queue it saw
   * then, after another device queued `again` first: as one restore, or
   * split into a fact per episode. It answers the server's queue.
   */
  async function undo(again: string[], split: boolean): Promise<string[]> {
    const server = await startServer();
    try {
      const a = await device(server.base, (http) => http.post("/v1/setup", { data: { username: "owner", password: "correct horse battery", setup_code: server.setupCode } }));
      const b = await device(server.base, (http) => http.post("/v1/auth/web", { data: { username: "owner", password: "correct horse battery" } }));
      await a.subscribe();
      let podcast = "";
      await expect.poll(async () => (podcast = (await a.call<ListPage<{ podcast_id: string }>>("get", "/v1/read/subscriptions")).items[0]?.podcast_id ?? "")).toBeTruthy();
      await a.call("post", "/v1/refresh", { podcast_id: podcast });
      const episodes = async (d: typeof a) => {
        const rows = (await d.call<ListPage<EpisodeRow>>("get", `/v1/read/podcasts/${encodeURIComponent(podcast)}/episodes?limit=500`)).items;
        return (ls: string[]) => ls.map((l) => rows.find((e) => e.title === l)!);
      };
      await expect.poll(async () => (await a.call<ListPage<EpisodeRow>>("get", `/v1/read/podcasts/${encodeURIComponent(podcast)}/episodes`)).total, { timeout: 60_000 }).toBe(labels.length);
      const names = async (d: typeof a) => (await d.queue()).map((e) => e.title ?? "");
      await a.act([addToQueue((await episodes(a))(labels), await a.queue(), await a.policy())!]);
      expect(await names(a)).toEqual(labels);
      // A removes R1–R6 and sees the queue without them.
      const removed = (await episodes(a))(labels.slice(1, -1));
      const saved = savedIndexes(removed, await a.queue());
      await a.act([act.queueRemove(removed)]);
      const seen = await a.queue();
      expect(seen.map((e) => e.title)).toEqual(["P", "T"]);
      // B, having seen the removal, queues some of them again (at the end), before A's Undo arrives.
      await b.act([addToQueue((await episodes(b))(again), await b.queue(), await b.policy())!]);
      const sent = Date.now();
      await expect.poll(() => Date.now()).toBeGreaterThan(sent); // A's Undo comes later, in the server's order too
      const bodies = restoreAt(saved, seen, split ? 1 : undefined);
      expect(bodies).toHaveLength(split ? removed.length : 1);
      await a.act(bodies);
      const out = await names(a);
      await a.stop();
      await b.stop();
      return out;
    } finally {
      await server.stop();
    }
  }

  try {
    // B queues a member again: one restore leaves it where B put it and puts the rest back.
    const one = await undo(["R3"], false);
    expect(one).toEqual(["P", "R1", "R2", "R4", "R5", "R6", "T", "R3"]);
    expect(await undo(["R3"], true)).toEqual(one);
    // B queues the start of the run again, as a batch.
    const batch = await undo(["R1", "R2", "R3"], false);
    expect(batch).toEqual(["P", "R4", "R5", "R6", "T", "R1", "R2", "R3"]);
    expect(await undo(["R1", "R2", "R3"], true)).toEqual(batch);
  } finally {
    await new Promise<void>((r) => feed.close(() => r()));
  }
});
