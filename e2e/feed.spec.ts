// The player's MediaSource feed of converted streams in real browsers, against
// the real server: the player's media code
// (src/player/media.ts) runs in a page of the server, asking for converted
// streams, with a short read-ahead window so its bounds show in seconds.
// - During a sustained pause the transfer stops at the window: nothing
//   more is received and the server's stream is not completed; playing on
//   continues the conversion where the content ends, across joins, at speed.
// - A transfer that stays open and silent is ended as a stall, and the
//   player reloads at its position: playing on if it was playing, staying
//   paused if it was paused.
// Firefox's MediaSource does not take the server's stream: it plays converted
// streams itself, and these tests do not apply there.
import { expect, test, type Page } from "@playwright/test";
import { buildSync } from "esbuild";
import { join } from "node:path";
import { root } from "./support/build.ts";
import { startServer, type RunningServer } from "./support/server.ts";
import { startPublisher, type Publisher } from "./support/player.ts";

test.describe.configure({ mode: "serial" });

let server: RunningServer;
let publisher: Publisher;
let page: Page;
let episode = "";
const bundle = buildSync({ entryPoints: [join(root, "src", "player", "media.ts")], bundle: true, write: false, format: "iife", globalName: "PlayerMedia" }).outputFiles[0]!.text;
const streams: { url: string; finished?: number; failed?: string }[] = [];

test.beforeAll(async ({ browser }) => {
  server = await startServer();
  publisher = await startPublisher("Feed Show", [{ title: "Feed episode", seconds: 1800, plain: true }]);
  page = await (await browser.newContext()).newPage();
  page.on("request", (r) => r.url().includes("/v1/media/s/") && !r.url().includes("/status") && streams.push({ url: new URL(r.url()).pathname + new URL(r.url()).search }));
  page.on("requestfinished", async (r) => {
    const s = streams.findLast((x) => r.url().endsWith(x.url));
    if (s) s.finished = (await r.sizes()).responseBodySize;
  });
  page.on("requestfailed", (r) => {
    const s = streams.findLast((x) => r.url().endsWith(x.url));
    if (s) s.failed = r.failure()?.errorText ?? "failed";
  });
  await page.goto(server.base);
  await page.getByLabel("Setup code").fill(server.setupCode);
  await page.getByLabel("Username").fill("feed");
  await page.getByLabel("Password").fill("feed account password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator("nav.drawer")).toBeVisible();
  await page.goto(server.base + "/add");
  await page.getByLabel("Add podcast by RSS address").fill(publisher.feedURL);
  await page.getByRole("button", { name: "Episodes preview" }).click();
  await page.getByRole("button", { name: "Subscribe", exact: true }).click();
  await expect
    .poll(async () => (episode = await page.evaluate(async () => ((await (await fetch("/v1/read/episodes?limit=5")).json()).items ?? [])[0]?.episode_id ?? "")), { timeout: 70_000 })
    .not.toBe("");
  // The player's media code, served from the page's own origin (the app's policy allows only that).
  await page.route("**/feed-test/media.js", (r) => r.fulfill({ contentType: "text/javascript", body: bundle }));
  await page.addScriptTag({ url: server.base + "/feed-test/media.js" });
});

test.afterAll(async () => {
  await page?.context().close();
  await publisher?.stop();
  await server?.stop();
});

test.beforeEach(async ({ browserName }) => {
  test.skip(browserName === "firefox", "Firefox plays converted streams itself: no MediaSource feed");
  streams.length = 0;
});

/** start makes the player's media for the episode's converted stream from `at`, with the feed's options (in seconds), and plays it. */
async function start(p: Page, at: number, feed: Record<string, unknown>, rate = 1, fetchMode: "real" | "silent-after-prefix" = "real") {
  await p.evaluate(
    async ({ id, at, feed, rate, fetchMode }) => {
      const w = window as unknown as Record<string, any>;
      w.player?.unload();
      w.calls = { error: 0, ended: 0, paused: 0, describes: 0, waiting: 0 };
      let fetches = 0;
      const fetchFor = async (url: string, init: RequestInit): Promise<Response> => {
        const res = await fetch(url, init);
        if (fetchMode !== "silent-after-prefix" || fetches++ > 0) return res;
        // The first transfer sends about ten seconds, then stays open and silent.
        let sent = 0;
        const reader = res.body!.getReader();
        const body = new ReadableStream<Uint8Array>({
          async pull(c) {
            if (sent > 160_000) return new Promise<void>(() => {}); // open, never another byte
            const { value, done } = await reader.read();
            if (done) return c.close();
            sent += value.length;
            c.enqueue(value);
          },
          cancel() {
            void reader.cancel();
          },
        });
        return new Response(body, { status: res.status, headers: res.headers });
      };
      const sources = {
        capabilities: async () => ["audio/aac"],
        profiles: async () => [{ name: "aac", mime: "audio/aac" }],
        describe: async (episode: string, body: Record<string, unknown>) => {
          w.calls.describes++;
          const r = await fetch(`/v1/media/${encodeURIComponent(episode)}/play`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, force: "compat" }) });
          return (w.descriptor = await r.json());
        },
        status: async (url: string) => (await fetch(`${url}/status`)).json(),
        wording: (e: { message: string }) => e.message,
      };
      const m = new w.PlayerMedia.AudioMedia(rate, sources, { feed: { ...feed, fetch: fetchFor } });
      m.listen({ paused: () => w.calls.paused++, ended: () => w.calls.ended++, time() {}, error: () => w.calls.error++ });
      m.el.addEventListener("waiting", () => w.calls.waiting++);
      w.player = m;
      await m.load(`episode:${id}`, at);
      await m.play();
    },
    { id: episode, at, feed, rate, fetchMode },
  );
}

const state = (p: Page) =>
  p.evaluate(() => {
    const w = window as unknown as Record<string, any>;
    const m = w.player;
    const b = m.el.buffered;
    return {
      position: m.position as number,
      time: m.el.currentTime as number,
      paused: m.el.paused as boolean,
      ranges: Array.from({ length: b.length }, (_, i) => [b.start(i), b.end(i)]) as [number, number][],
      src: m.el.src as string,
      calls: { ...w.calls } as { error: number; ended: number; paused: number; describes: number; waiting: number },
    };
  });

const token = () => streams[0]!.url.split("?")[0]!;

test("a sustained pause stops the transfer at the window, and playing on continues the conversion where it ends, at speed", async () => {
  test.setTimeout(240_000);
  // A 60 s window, continued when 30 s remain ahead; from 1:00 of a 30-minute episode.
  await start(page, 60_000, { aheadS: 60, resumeS: 30 }, 3);
  await expect.poll(async () => (await state(page)).time, { timeout: 30_000 }).toBeGreaterThan(1);
  await page.evaluate(() => (window as unknown as Record<string, any>).player.pause());
  // The window fills and its transfer stops (possibly before the pause, playback then went on a little).
  await expect.poll(() => streams[0]?.failed ?? (streams[0]?.finished !== undefined ? "finished" : ""), { timeout: 30_000 }).not.toBe("");
  expect(streams[0]!.finished, "the transfer was stopped, not received whole").toBeUndefined();
  const before = await state(page);
  const ahead = before.ranges.at(-1)![1] - before.time;
  expect(ahead, "about the window held ahead").toBeGreaterThan(50);
  expect(ahead).toBeLessThan(75);
  // During a sustained pause nothing more comes.
  await page.waitForTimeout(20_000); // an absence, observed over a sustained pause
  const after = await state(page);
  expect(streams.length, "no new transfer while paused").toBe(1);
  expect(after.ranges.at(-1)![1]).toBeCloseTo(before.ranges.at(-1)![1], 3);
  const status = await page.evaluate(async (t) => (await (await fetch(`${t}/status`)).json()).state as string, token());
  expect(status, "the server never sent the rest").not.toBe("complete");
  // Playing on at 3x: as the window drains, the conversion continues where the content ends, more than once.
  await page.evaluate(() => (window as unknown as Record<string, any>).player.play());
  const t0 = Date.now();
  const m0 = (await state(page)).time;
  await expect.poll(() => streams.filter((s) => s.url.includes("start_ms=")).length, { timeout: 120_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => (await state(page)).time, { timeout: 60_000 }).toBeGreaterThan(m0 + 75);
  const s = await state(page);
  const continued = streams.filter((x) => x.url.includes("start_ms=")).map((x) => Number(new URL(x.url, "http://x").searchParams.get("start_ms")));
  expect(continued[0], "the first continuation starts where the first transfer's content ended").toBeGreaterThan(60_000 + 59_000);
  expect(s.ranges.length, "joined without a gap").toBe(1);
  expect(s.calls, "no stall, error or end at the joins").toMatchObject({ error: 0, ended: 0 });
  expect((s.time - m0) / ((Date.now() - t0) / 1000), "at its speed through the joins").toBeGreaterThan(2.7);
  await page.evaluate(() => (window as unknown as Record<string, any>).player.unload());
});

test("a transfer left open and silent is a stall: the player reloads at its position and plays on", async () => {
  test.setTimeout(120_000);
  await start(page, 300_000, { stallMs: 3_000 }, 1, "silent-after-prefix");
  // About ten seconds arrive, then nothing: playback reaches the silence and waits; the stall bound ends it.
  await expect.poll(async () => (await state(page)).calls.describes, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
  const stalledAt = await state(page);
  await expect.poll(async () => (await state(page)).position, { timeout: 30_000 }).toBeGreaterThan(stalledAt.position + 2_000);
  const s = await state(page);
  expect(s.paused).toBe(false);
  expect(s.calls.error, "recovered, not reported").toBe(0);
  // The reload continues from where the stall left playback, not from the start or beyond.
  const reload = streams.at(-1)!;
  expect(reload.url.includes("start_ms") || (await page.evaluate(() => (window as unknown as Record<string, any>).descriptor.offset_ms as number)) > 300_000).toBe(true);
  expect(s.position).toBeGreaterThan(300_000);
  expect(s.position).toBeLessThan(stalledAt.position + 30_000);
  await page.evaluate(() => (window as unknown as Record<string, any>).player.unload());
});

test("a stall while paused reloads at the position and stays paused", async () => {
  test.setTimeout(120_000);
  await start(page, 300_000, { stallMs: 3_000 }, 1, "silent-after-prefix");
  await expect.poll(async () => (await state(page)).time, { timeout: 30_000 }).toBeGreaterThan(1);
  await page.evaluate(() => (window as unknown as Record<string, any>).player.pause());
  const at = (await state(page)).position;
  await expect.poll(async () => (await state(page)).calls.describes, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => (await state(page)).src).toMatch(/^blob:/);
  const s = await state(page);
  expect([s.paused, s.calls.error]).toEqual([true, 0]);
  expect(Math.abs(s.position - at)).toBeLessThan(1_000);
  await page.evaluate(() => (window as unknown as Record<string, any>).player.unload());
});
