// The player's journeys (PROTOCOL §12) in one account per browser,
// against a real NotTennaPod-Server, with WAV episodes from an HTTPS
// publisher: play, pause and resume as one session; seeking, skip intervals
// and speed; completion at the end and continuous playback; skip within and
// outside 30 s; paused adoption of a phone's position; passive loading after
// a reload; two tabs with a handoff; playback in a background tab; a narrow
// right-to-left window. Every listening effect is checked on the server
// through the read API (position, played time, last played, history).
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { startServer, type RunningServer } from "./support/server.ts";
import { notNow } from "./support/offer.ts";
import { startPublisher, type Publisher, type FixtureEpisode } from "./support/player.ts";

test.describe.configure({ mode: "serial" });

const user = "listener";
const password = "correct horse battery";
const show = "Player Show";
const fixture: FixtureEpisode[] = [
  { title: "Player episode 1", seconds: 600, chapters: [["00:00:00", "Intro"], ["00:02:00", "Interview"], ["00:05:00", "Outro"]] },
  { title: "Player episode 2", seconds: 120 },
  { title: "Player episode 3", seconds: 90 },
  { title: "Player episode 4", seconds: 180 },
  // PROTOCOL §13: plain HTTP (the relay), and formats some engines cannot play (the compatibility path).
  { title: "Relayed episode", seconds: 120, plain: true },
  // Plain HTTP too: the server fetches what it converts, and refuses the fixture's self-signed certificate.
  { title: "ALAC episode", seconds: 90, format: "m4a-alac", plain: true },
  { title: "Vorbis episode", seconds: 90, format: "ogg-vorbis", plain: true },
  { title: "Opus episode", seconds: 90, format: "mp4-opus", plain: true },
  // 30 minutes over plain HTTP without ETag: the relay serves it whole, and a seek in Chromium converts it.
  { title: "Long relayed episode", seconds: 1800, plain: true },
];

let server: RunningServer;
let publisher: Publisher;
let context: BrowserContext;
let page: Page;
let page2: Page;
const ids: string[] = [];
const streams: string[] = [];

test.beforeAll(async ({ browser }) => {
  server = await startServer();
  publisher = await startPublisher(show, fixture);
  context = await browser.newContext({ ignoreHTTPSErrors: true });
  // The server's media streams asked for, by the element or by the player's MediaSource feed.
  context.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/v1/media/s/") && !u.pathname.endsWith("/status")) streams.push(u.pathname + u.search);
  });
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
  await publisher?.stop();
  await server?.stop();
});

async function read<T = Record<string, any>>(p: Page, path: string): Promise<T> {
  return p.evaluate(async (u) => (await fetch(u, { cache: "no-store" })).json(), path) as Promise<T>;
}

interface Listening {
  position: number;
  played: number;
  lastPlayed: number;
  history: number | null;
  playState: string;
  inQueue: boolean;
  claim: string | null;
}

async function listening(p: Page, n: number): Promise<Listening> {
  const e = (await read(p, `/v1/read/episodes/${encodeURIComponent(ids[n - 1]!)}`)).episode;
  return {
    position: e.position,
    played: e.records.played_time?.value.played_ms ?? 0,
    lastPlayed: e.last_played,
    history: e.history,
    playState: e.play_state,
    inQueue: e.in_queue,
    claim: e.records.position?.value.claim_id ?? null,
  };
}

/** settled waits until the profile's journal has pushed everything. */
async function settled(p: Page): Promise<void> {
  await expect
    .poll(
      () =>
        p.evaluate(async () => {
          const db: IDBDatabase = await new Promise((r) => {
            const q = indexedDB.open("nottennapod");
            q.onsuccess = () => r(q.result);
          });
          const all: { receipt: unknown }[] = await new Promise((r) => {
            const q = db.transaction("journal").objectStore("journal").getAll();
            q.onsuccess = () => r(q.result);
          });
          db.close();
          return all.filter((e) => !e.receipt).length;
        }),
      { timeout: 20_000 },
    )
    .toBe(0);
}

/** sessions lists the profile's session journal (IndexedDB). */
async function sessions(p: Page): Promise<{ session_id: string; episode_id: string; author_id: string; sealed: string | null; closed: boolean }[]> {
  return p.evaluate(async () => {
    const db: IDBDatabase = await new Promise((r) => {
      const q = indexedDB.open("nottennapod");
      q.onsuccess = () => r(q.result);
    });
    const all: { session_id: string; episode: { episode_id: string }; author_id: string; sealed: string | null; closed: boolean }[] = await new Promise((r) => {
      const q = db.transaction("sessions").objectStore("sessions").getAll();
      q.onsuccess = () => r(q.result);
    });
    db.close();
    return all.map((s) => ({ session_id: s.session_id, episode_id: s.episode.episode_id, author_id: s.author_id, sealed: s.sealed, closed: s.closed }));
  });
}

async function audio(p: Page): Promise<{ t: number; paused: boolean; rate: number }> {
  return p.evaluate(() => {
    const a = document.querySelector("audio")!;
    return { t: Math.round(a.currentTime * 1000), paused: a.paused, rate: a.playbackRate };
  });
}

/**
 * playedRate is how many seconds of media play in a second, measured in the
 * page: each sample pairs the media time with the page's monotonic clock at
 * the same timeupdate, so nothing of the test runner or its round trips is
 * in the window. The window opens after a second and a half of media, past
 * the engine's start-up (WebKit's media clock catches up during it). A window
 * that waiting, a stall, a pause or a seek interrupted is measured again.
 */
async function playedRate(p: Page, mediaMs: number): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const m = await p.evaluate(async (span) => {
      const a = document.querySelector("audio")!;
      let interrupted = false;
      const interrupt = () => (interrupted = true);
      const events = ["waiting", "stalled", "pause", "seeking", "emptied"];
      for (const ev of events) a.addEventListener(ev, interrupt);
      const update = () =>
        new Promise<{ media: number; at: number }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("the media time stopped")), 10_000);
          a.addEventListener("timeupdate", () => {
            clearTimeout(timer);
            resolve({ media: a.currentTime * 1000, at: performance.now() });
          }, { once: true });
        });
      try {
        const start = await update();
        let first = start;
        while (!interrupted && first.media - start.media < 1_500) first = await update();
        let last = first;
        while (!interrupted && last.media - first.media < span) last = await update();
        return { media: last.media - first.media, wall: last.at - first.at, interrupted };
      } finally {
        for (const ev of events) a.removeEventListener(ev, interrupt);
      }
    }, mediaMs);
    if (!m.interrupted) return m.media / m.wall;
  }
  throw new Error("playback was interrupted in every measurement");
}

async function reaches(p: Page, ms: number, timeout = 30_000): Promise<void> {
  await expect.poll(async () => (await audio(p)).t, { timeout }).toBeGreaterThanOrEqual(ms);
}

/** go navigates inside the app, so the player keeps playing. */
async function go(p: Page, path: string): Promise<void> {
  await p.evaluate((u) => {
    history.pushState(null, "", u);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

const bar = (p: Page) => p.locator(".player-bar");
const playing = (p: Page) => expect(bar(p).getByRole("button", { name: "Pause" })).toBeVisible();
const paused = (p: Page) => expect(bar(p).getByRole("button", { name: "Play", exact: true })).toBeVisible();

async function stream(p: Page, n: number, via: "button" | "menu" = "button"): Promise<void> {
  await go(p, `/episode/${encodeURIComponent(ids[n - 1]!)}`);
  await expect(p.getByRole("heading", { name: fixture[n - 1]!.title })).toBeVisible();
  if (via === "button") {
    await p.locator(".episode-buttons").getByRole("button", { name: "Stream" }).click();
  } else {
    await p.locator(".toolbar").getByRole("button", { name: "More" }).click();
    await p.getByRole("menuitem", { name: "Stream" }).click();
  }
  await playing(p);
  await expect(bar(p).locator(".player-bar-title")).toHaveText(fixture[n - 1]!.title);
}

async function openPlayer(p: Page) {
  await bar(p).locator(".player-bar-open").click();
  const d = p.getByRole("dialog", { name: /episode/ });
  await expect(d).toBeVisible();
  return d;
}

const near = (a: number, b: number, tolerance: number) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(tolerance);

test("set up and subscribe to a show with HTTPS episodes", async () => {
  await page.goto(server.base + "/");
  await page.getByLabel("Setup code").fill(server.setupCode);
  await page.getByLabel("Username").fill(user);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator("nav.drawer")).toBeVisible();
  await notNow(page);
  await expect(bar(page)).toHaveCount(0);
  await page.goto(server.base + "/add");
  await page.getByLabel("Add podcast by RSS address").fill(publisher.feedURL);
  await page.getByRole("button", { name: "Episodes preview" }).click();
  await expect(page.getByRole("heading", { name: show })).toBeVisible();
  await page.getByRole("button", { name: "Subscribe" }).click();
  await expect
    .poll(async () => (await read<{ items: { title: string }[] }>(page, "/v1/read/episodes?limit=100")).items.map((e) => e.title), { timeout: 60_000 })
    .toContain("Player episode 4");
  const items = (await read<{ items: { title: string; episode_id: string }[] }>(page, "/v1/read/episodes?limit=100")).items;
  for (const f of fixture) ids.push(items.find((e) => e.title === f.title)!.episode_id);
});

test("play, pause and resume are one session; the server has the position, played time, last played and history", async () => {
  await stream(page, 1);
  await reaches(page, 7_000);
  if (await page.evaluate(() => "mediaSession" in navigator)) {
    expect(await page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe("Player episode 1");
  }
  await bar(page).getByRole("button", { name: "Pause" }).click();
  await paused(page);
  const at = (await audio(page)).t;
  await settled(page);
  let s = await listening(page, 1);
  expect(s.inQueue, "playing an unqueued episode adds it to the queue").toBe(true);
  near(s.position, at, 600);
  near(s.played, s.position, 50);
  expect(s.lastPlayed).toBeGreaterThan(0);
  expect(s.history).toBeGreaterThan(0);
  await bar(page).getByRole("button", { name: "Play", exact: true }).click();
  await playing(page);
  await reaches(page, at + 3_000);
  await bar(page).getByRole("button", { name: "Pause" }).click();
  await paused(page);
  await settled(page);
  const before = s;
  s = await listening(page, 1);
  expect(s.position).toBeGreaterThan(before.position + 2_000);
  near(s.played, s.position, 50);
  expect((await sessions(page)).filter((x) => x.episode_id === ids[0]).length, "pause and resume keep the session").toBe(1);
  // The row's action button (Android's ItemActionButton) plays and pauses the same session.
  await go(page, "/queue");
  const row = page.locator(".episode", { hasText: fixture[0]!.title });
  await row.getByRole("button", { name: "Stream" }).click();
  await playing(page);
  await row.getByRole("button", { name: "Pause" }).click();
  await paused(page);
  await settled(page);
  expect((await sessions(page)).filter((x) => x.episode_id === ids[0]).length, "the row's button resumes the session").toBe(1);
});

test("seeking, the skip intervals and the speed; speed is not counted as listening", async () => {
  const d = await openPlayer(page);
  await d.getByRole("slider", { name: "Position" }).fill("60000");
  await expect.poll(async () => (await audio(page)).t).toBe(60_000);
  await expect(d.locator(".player-elapsed")).toHaveText("00:01:00");
  await d.getByRole("button", { name: "Fast-forward" }).click();
  await expect.poll(async () => (await audio(page)).t).toBe(90_000);
  await d.getByRole("button", { name: "Rewind" }).click();
  await expect.poll(async () => (await audio(page)).t).toBe(80_000);
  await d.getByRole("button", { name: "Playback speed" }).click();
  await page.getByRole("button", { name: "1.50", exact: true }).click();
  await expect(page.locator(".speed-dialog")).toHaveCount(0);
  await expect(d.getByRole("button", { name: "Playback speed" })).toContainText("1.50");
  expect((await audio(page)).rate).toBe(1.5);
  await d.getByRole("button", { name: "Play", exact: true }).click();
  await expect(d.getByRole("button", { name: "Pause" })).toBeVisible();
  const rate = await playedRate(page, 9_000);
  expect(rate, "1.5× plays 1.5 seconds of media a second").toBeGreaterThan(1.455);
  expect(rate).toBeLessThan(1.545);
  await d.getByRole("button", { name: "Pause" }).click();
  const a1 = (await audio(page)).t;
  await settled(page);
  const s = await listening(page, 1);
  near(s.position, a1, 600);
  near(s.played, s.position, 50); // forward media displacement from the start: the seek counts, the speed does not
  // The keyboard: Escape closes the player and focus returns to the bar.
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);
  await expect(bar(page).locator(".player-bar-open")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Player episode 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
});

test("chapters: previous and next chapter, and the list plays a chapter", async () => {
  const d = await openPlayer(page);
  await d.getByRole("slider", { name: "Position" }).fill("150000");
  await expect.poll(async () => (await audio(page)).t).toBe(150_000);
  await d.getByRole("button", { name: "Next chapter" }).click();
  await expect.poll(async () => (await audio(page)).t).toBe(300_000);
  await expect(d.getByRole("button", { name: "Next chapter" })).toBeHidden(); // the last chapter
  // More than 10 s into a chapter, Previous goes to its start; within 10 s, to the one before.
  await d.getByRole("slider", { name: "Position" }).fill("320000");
  await d.getByRole("button", { name: "Previous chapter" }).click();
  await expect.poll(async () => (await audio(page)).t).toBe(300_000);
  await d.getByRole("button", { name: "Previous chapter" }).click();
  await expect.poll(async () => (await audio(page)).t).toBe(120_000);
  await d.getByRole("button", { name: "Chapters" }).click();
  const list = page.getByRole("dialog", { name: "Chapters" });
  await expect(list.locator(".chapter")).toHaveCount(3);
  await expect(list.locator(".chapter.current .chapter-title")).toHaveText("Interview");
  await list.locator(".chapter", { hasText: "Intro" }).getByRole("button", { name: "Play chapter" }).click();
  await playing(page);
  expect((await audio(page)).t).toBeLessThan(5_000);
  await list.getByRole("button", { name: "Close" }).click();
  await d.getByRole("button", { name: "Pause" }).click();
  await paused(page);
  await settled(page);
  await page.keyboard.press("Escape");
});

test("an episode completes at its end, and the next queue item starts", async () => {
  await stream(page, 3); // switches from episode 1, paused: finalized lazily, not completed
  await go(page, `/episode/${encodeURIComponent(ids[3]!)}`);
  await page.locator(".toolbar").getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Add to queue" }).click();
  await expect.poll(async () => (await listening(page, 4)).inQueue).toBe(true);
  const d = await openPlayer(page);
  // Close to the end, so a busy machine's slow audio clock still reaches it in time.
  await d.getByRole("slider", { name: "Position" }).fill("88000");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(bar(page).locator(".player-bar-title")).toHaveText("Player episode 4", { timeout: 30_000 });
  await playing(page);
  await settled(page);
  const s3 = await listening(page, 3);
  expect([s3.playState, s3.position, s3.inQueue]).toEqual(["played", 0, false]);
  expect(s3.history).toBeGreaterThan(0);
  const s1 = await listening(page, 1);
  expect([s1.playState, s1.inQueue]).toEqual(["unplayed", true]);
});

test("skip within 30 s of the end completes; outside it the episode stays unplayed and queued", async () => {
  const d = await openPlayer(page);
  await d.getByRole("slider", { name: "Position" }).fill("160000");
  await d.getByRole("button", { name: "Skip episode" }).click();
  await expect(bar(page)).toHaveCount(0); // the last episode in the queue
  await expect(page.getByText("This was the last episode in the queue")).toBeVisible();
  await settled(page);
  const s4 = await listening(page, 4);
  expect([s4.playState, s4.position, s4.inQueue]).toEqual(["played", 0, false]);
  await stream(page, 2, "menu");
  await reaches(page, 3_000);
  const d2 = await openPlayer(page);
  await d2.getByRole("button", { name: "Skip episode" }).click();
  await expect(bar(page)).toHaveCount(0);
  await settled(page);
  const s2 = await listening(page, 2);
  expect(s2.playState).toBe("unplayed");
  expect(s2.inQueue, "Keep skipped episodes").toBe(true);
  expect(s2.history).toBeGreaterThan(0);
  expect(s2.position).toBeGreaterThan(2_000);
});

test("a paused player adopts a phone's newer position; resuming starts a new session there", async () => {
  await stream(page, 1);
  await reaches(page, (await audio(page)).t + 2_000);
  await bar(page).getByRole("button", { name: "Pause" }).click();
  await paused(page);
  await settled(page);
  const mine = (await listening(page, 1)).claim;
  // A phone plays the episode from 3:20, after everything the browser did.
  const phone = await page.evaluate(
    async ({ user, password, id }) => {
      const json = (r: Response) => r.json();
      const install = crypto.randomUUID();
      const signIn = await fetch("/v1/auth/device", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user, password, install_id: install, instance_nonce: crypto.randomUUID(),
          device: { name: "Phone", platform: "android", app_version: "1", capabilities: ["favorites", "history", "inbox", "queue", "statistics"] } }),
      }).then(json);
      const auth = { Authorization: `Bearer ${signIn.token}`, "Content-Type": "application/json" };
      const ep = await fetch(`/v1/read/episodes/${encodeURIComponent(id)}`).then(json);
      const { frontier } = await fetch(`/v1/read/frontier?cursor=${encodeURIComponent(ep.head.cursor)}`).then(json);
      const e = ep.episode;
      const ref = { episode_id: e.episode_id, podcast_id: e.podcast_id, generation_id: e.podcast.generation_id, occurrence: e.records.identity.value.occurrence };
      const fact = { op_id: crypto.randomUUID(), author_id: crypto.randomUUID(), author_seq: 1, dependencies: frontier, type: "session.start", type_version: 1,
        client_time: Date.now(), targets: [{ entity: "episode", id: e.episode_id, generation: ref.generation_id }],
        payload: { episode: ref, session_id: crypto.randomUUID(), start_position: 200_000, activity: true } };
      const res = await fetch("/v1/push", { method: "POST", headers: auth,
        body: JSON.stringify({ cursor: ep.head.cursor, install_id: install, acked_install_seq: 0, operations: [{ install_seq: 1, fact }] }) }).then(json);
      return { status: res.results?.[0]?.status ?? JSON.stringify(res), op: fact.op_id };
    },
    { user, password, id: ids[0]! },
  );
  expect(phone.status).toBe("accepted");
  expect(phone.op).not.toBe(mine);
  // The event arrives; the paused player moves to 3:20 and seals its session (no listening activity).
  await expect.poll(async () => (await audio(page)).t, { timeout: 20_000 }).toBe(200_000);
  await expect.poll(async () => (await sessions(page)).filter((s) => s.episode_id === ids[0] && s.sealed === "superseded").length).toBe(1);
  const before = await listening(page, 1);
  await bar(page).getByRole("button", { name: "Play", exact: true }).click();
  await playing(page);
  await reaches(page, 203_000);
  await bar(page).getByRole("button", { name: "Pause" }).click();
  await settled(page);
  const s = await listening(page, 1);
  expect(s.claim, "resuming is a new claim").not.toBe(phone.op);
  expect(s.position).toBeGreaterThan(200_000);
  // The adopted jump is not listening: played time grows only by what was heard after it.
  near(s.played - before.played, s.position - (200_000 - 800), 600);
});

/** Device is another device of the account (a phone) writing through the sync API: its token, installation and author chain. */
interface Device {
  token: string;
  install: string;
  author: string;
  seq: number;
  last: string | null;
}

async function signInDevice(p: Page): Promise<Device> {
  return p.evaluate(
    async ({ user, password }) => {
      const install = crypto.randomUUID();
      const res = await fetch("/v1/auth/device", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user, password, install_id: install, instance_nonce: crypto.randomUUID(),
          device: { name: "Phone", platform: "android", app_version: "1", capabilities: ["favorites", "history", "inbox", "queue", "statistics"] } }),
      }).then((r) => r.json());
      return { token: res.token as string, install, author: crypto.randomUUID(), seq: 0, last: null };
    },
    { user, password },
  );
}

/** devicePushes pushes the device's next fact on episode n, depending on what it read and on its own previous fact. */
async function devicePushes(p: Page, d: Device, n: number, type: string, payload: Record<string, unknown>): Promise<{ device: Device; status: string; op: string }> {
  return p.evaluate(
    async ({ d, id, type, payload }) => {
      const json = (r: Response) => r.json();
      const ep = await fetch(`/v1/read/episodes/${encodeURIComponent(id)}`).then(json);
      const { frontier } = await fetch(`/v1/read/frontier?cursor=${encodeURIComponent(ep.head.cursor)}`).then(json);
      const e = ep.episode;
      const ref = { episode_id: e.episode_id, podcast_id: e.podcast_id, generation_id: e.podcast.generation_id, occurrence: e.records.identity.value.occurrence };
      const fact: Record<string, unknown> = {
        op_id: crypto.randomUUID(), author_id: d.author, author_seq: d.seq + 1,
        dependencies: [...new Set([...frontier, ...(d.last ? [d.last] : [])])].sort(), type, type_version: 1, client_time: Date.now(),
        targets: [{ entity: "episode", id: e.episode_id, generation: ref.generation_id }], payload: { episode: ref, ...payload },
      };
      if (d.last) fact.previous_op_id = d.last;
      const res = await fetch("/v1/push", {
        method: "POST",
        headers: { Authorization: `Bearer ${d.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ cursor: ep.head.cursor, install_id: d.install, acked_install_seq: d.seq, operations: [{ install_seq: d.seq + 1, fact }] }),
      }).then(json);
      const op = fact.op_id as string;
      return { status: (res.results?.[0]?.status as string) ?? JSON.stringify(res), op, device: { ...d, seq: d.seq + 1, last: op } };
    },
    { d, id: ids[n - 1]!, type, payload },
  );
}

test("a paused player follows a phone that plays on and pauses, without the phone playing again", async () => {
  await settled(page);
  // The phone plays the episode from 4:10: the paused browser follows it.
  let phone = await signInDevice(page);
  const session = crypto.randomUUID();
  const start = await devicePushes(page, phone, 1, "session.start", { session_id: session, start_position: 250_000, activity: true });
  expect(start.status).toBe("accepted");
  phone = start.device;
  await expect.poll(async () => (await audio(page)).t, { timeout: 20_000 }).toBe(250_000);
  // The phone pauses at 4:40 (its pause checkpoint, under the same claim): the browser shows that, with no new play on the phone.
  const pause = await devicePushes(page, phone, 1, "session.checkpoint", { session_id: session, ordinal: 1, position: 280_000, contribution: 30_000, activity: true });
  expect(pause.status).toBe("accepted");
  const server = await listening(page, 1);
  expect([server.position, server.claim]).toEqual([280_000, start.op]);
  await expect.poll(async () => (await audio(page)).t, { timeout: 20_000 }).toBe(280_000);
  await expect(bar(page).getByRole("button", { name: "Play", exact: true })).toBeVisible();
  // Play here starts from there.
  await bar(page).getByRole("button", { name: "Play", exact: true }).click();
  await playing(page);
  await reaches(page, 281_000);
  await bar(page).getByRole("button", { name: "Pause" }).click();
  await paused(page);
  await settled(page);
  const s = await listening(page, 1);
  expect(s.claim, "playing here is a new claim").not.toBe(start.op);
  expect(s.position).toBeGreaterThan(280_000);
});

test("a reload loads the episode paused without writing anything, and play resumes the session", async () => {
  await settled(page);
  const before = await listening(page, 1);
  const known = new Set((await sessions(page)).map((x) => x.session_id));
  const open = (await sessions(page)).filter((x) => x.episode_id === ids[0] && !x.sealed && !x.closed).map((x) => x.session_id);
  expect(open.length).toBe(1);
  // The publisher's file as the reloaded page asks for it (from its document's start).
  const ranges: string[] = [];
  let reloaded = false;
  page.once("framenavigated", () => (reloaded = true));
  const asked = (r: { url(): string; headers(): Record<string, string> }) => {
    if (reloaded && new URL(r.url()).pathname === "/media/episode-1.wav") ranges.push(r.headers()["range"] ?? "");
  };
  page.on("request", asked);
  await page.reload();
  await expect(bar(page).locator(".player-bar-title")).toHaveText("Player episode 1");
  await paused(page);
  // At the saved position, within what anyone could hear: the element reports
  // its time a millisecond on from the one the pause saved in some engines.
  await expect.poll(async () => Math.abs((await audio(page)).t - before.position)).toBeLessThanOrEqual(100);
  // The page fetches the file from its start: a page given the previous page's
  // download (Firefox) asks mid-file first, which Firefox may refuse from
  // another site as a page's first media request, and the publisher's URL fails.
  expect(ranges[0], `the first request of the file: ${ranges.join(", ")}`).toMatch(/^(bytes=0-\d*)?$/);
  page.off("request", asked);
  await page.waitForTimeout(1500); // a passive load writes nothing, even later
  await settled(page);
  const after = await listening(page, 1);
  expect(after).toEqual(before);
  const d = await openPlayer(page);
  await expect(d.getByRole("button", { name: "Playback speed" })).toContainText("1.50");
  await d.getByRole("button", { name: "Play", exact: true }).click();
  await reaches(page, before.position + 2_000);
  await d.getByRole("button", { name: "Pause" }).click();
  await page.keyboard.press("Escape");
  await settled(page);
  // Finished sessions whose facts the server showed are pruned at a page load; the open one resumed.
  const now = await sessions(page);
  expect(now.filter((x) => !known.has(x.session_id)), "no new session").toEqual([]);
  expect(now.filter((x) => x.episode_id === ids[0] && !x.sealed && !x.closed).map((x) => x.session_id), "the tab's open session resumed").toEqual(open);
  expect((await listening(page, 1)).position).toBeGreaterThan(before.position + 1_000);
});

test("Play, Pause and a seek act at once while a background read of the episode is slow", async () => {
  await settled(page);
  // The server answers this episode's reads only when released: a slow connection, a busy server.
  const path = `/v1/read/episodes/${encodeURIComponent(ids[0]!)}`;
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let held = 0;
  const episodeRead = (u: URL) => u.pathname === path;
  await page.route(
    episodeRead,
    async (route) => {
      held++;
      await released;
      await route.continue().catch(() => {}); // the page may have given up on it
    },
  );
  try {
    // Coming back to the window re-reads what is shown: the player's background read of its episode waits.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => held).toBeGreaterThan(0);
    const at = (await audio(page)).t;
    await bar(page).getByRole("button", { name: "Play", exact: true }).click();
    await expect(bar(page).getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 2_000 });
    await reaches(page, at + 1_000, 5_000);
    await bar(page).getByRole("button", { name: "Pause" }).click();
    await expect(bar(page).getByRole("button", { name: "Play", exact: true })).toBeVisible({ timeout: 2_000 });
    const d = await openPlayer(page);
    await d.getByRole("slider", { name: "Position" }).fill("150000");
    await expect.poll(async () => (await audio(page)).t, { timeout: 2_000 }).toBe(150_000);
    await page.keyboard.press("Escape");
  } finally {
    release();
    await page.unroute(episodeRead);
  }
  await settled(page);
  expect((await sessions(page)).filter((x) => x.episode_id === ids[0] && !x.sealed && !x.closed).length, "the same session played on").toBe(1);
});

test("two tabs: the other shows Playing in another tab, and moving playback hands over with a final save", async () => {
  await bar(page).getByRole("button", { name: "Play", exact: true }).click();
  await playing(page);
  page2 = await context.newPage();
  await page2.goto(server.base + "/queue");
  await expect(bar(page2)).toContainText("Playing in another tab");
  await expect(bar(page2).locator(".player-bar-title")).toHaveText("Player episode 1");
  await reaches(page, (await audio(page)).t + 2_000);
  const authors = new Set((await sessions(page)).map((s) => s.author_id));
  await bar(page2).getByRole("button", { name: "Play here" }).click();
  await playing(page2);
  await expect(bar(page)).toContainText("Playing in another tab");
  const left = await audio(page);
  expect(left.paused).toBe(true);
  await settled(page2);
  const s = await listening(page2, 1);
  expect(s.position, "the first tab's final save landed").toBeGreaterThanOrEqual(left.t - 1_000);
  const mine = (await sessions(page2)).filter((x) => !authors.has(x.author_id));
  expect(mine.length, "the new tab plays its own session").toBe(1);
});

test("playback continues in a background tab, with checkpoints while it plays", async () => {
  const other = await context.newPage();
  await other.goto(server.base + "/statistics");
  await other.bringToFront();
  await settled(page2);
  // Headless pages stay visible; tell the playing tab it is hidden, as a browser would. It journals
  // its position for its departure, which the next checkpoint's push carries.
  await page2.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const start = await listening(other, 1);
  const a0 = (await audio(page2)).t;
  // A checkpoint is exported at most once a minute while playing: wait for one to land.
  await expect.poll(async () => (await listening(other, 1)).position, { timeout: 120_000, intervals: [2_000] }).toBeGreaterThan(start.position + 30_000);
  const now = await audio(page2);
  expect(now.paused).toBe(false);
  expect(now.t - a0).toBeGreaterThan(60_000);
  const s = await listening(other, 1);
  expect(s.played - start.played).toBeGreaterThan(30_000);
  await expect(bar(other)).toContainText("Playing in another tab");
  await bar(page2).getByRole("button", { name: "Pause" }).click();
  await other.close();
});

test("the player in a narrow right-to-left window: nothing clipped, the position bar stays left to right", async () => {
  await page2.setViewportSize({ width: 360, height: 740 });
  await page2.evaluate(() => (document.documentElement.dir = "rtl"));
  await expect(bar(page2)).toBeVisible();
  const barBox = (await bar(page2).boundingBox())!;
  expect(barBox.x).toBeGreaterThanOrEqual(0);
  expect(barBox.x + barBox.width).toBeLessThanOrEqual(360);
  const d = await openPlayer(page2);
  const names = ["Playback speed", "Rewind", "Play", "Fast-forward", "Skip episode"];
  const boxes = [];
  for (const name of names) {
    const b = (await d.getByRole("button", { name, exact: true }).boundingBox())!;
    expect(b.x, name).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width, name).toBeLessThanOrEqual(360);
    expect(b.y + b.height, name).toBeLessThanOrEqual(740);
    boxes.push(b);
  }
  for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.x, "Android's order, left to right").toBeGreaterThanOrEqual(boxes[i - 1]!.x + boxes[i - 1]!.width - 1);
  expect(await d.locator(".player-controls").evaluate((el) => getComputedStyle(el).direction)).toBe("ltr");
  await d.getByRole("button", { name: "Back", exact: true }).click(); // fails if anything covers it
  await expect(d).toHaveCount(0);
});

// PROTOCOL §13: the relay and the compatibility path (last: the conversion journey plays its episode to the end).
const src = (p: Page) => p.evaluate(() => document.querySelector("audio")!.src);
/** streamed says whether the server's media stream was asked for (a path, or a start such as "start_ms=60000"), since `from`. */
const streamed = (part: string, from = 0) => streams.slice(from).some((s) => s.includes(part));
const browserNameOf = (p: Page) => p.context().browser()!.browserType().name();
/** fedBy is how a converted stream reaches the element: a MediaSource (a blob: source), or the element itself. */
const fedBy = async (p: Page) => ((await src(p)).startsWith("blob:") ? "mediasource" : "element");

test("an episode over plain HTTP plays through the server's relay", async () => {
  await stream(page, 5);
  await expect.poll(() => src(page)).toContain("/v1/media/s/");
  await reaches(page, 3_000);
  await bar(page).getByRole("button", { name: "Pause" }).click();
  await paused(page);
  await settled(page);
  expect((await listening(page, 5)).position).toBeGreaterThanOrEqual(2_500);
  expect(publisher.requests.get("/media/episode-5.wav") ?? 0, "the server fetched the file").toBeGreaterThan(0);
});

test("a seek in a relayed file the relay cannot serve in ranges (a publisher without ETag) lands where asked, also after a reload", async () => {
  // The fixture's plain-HTTP files have no ETag: the relay serves them whole, with Accept-Ranges: none.
  await stream(page, 5);
  await expect.poll(() => src(page)).toContain("/v1/media/s/");
  await reaches(page, 2_000);
  const d = await openPlayer(page);
  const elapsed = async () => {
    const text = await d.locator(".player-elapsed").innerText();
    const [h, m, sec] = text.split(":").map(Number);
    return ((h! * 60 + m!) * 60 + sec!) * 1000;
  };
  await d.getByRole("slider", { name: "Position" }).fill("60000");
  // The player shows the target and plays on from there: never from 0 while claiming it, never back at 0.
  await expect(d.locator(".player-elapsed")).toHaveText(/^00:01:0\d$/, { timeout: 30_000 });
  await expect.poll(elapsed, { timeout: 30_000 }).toBeGreaterThanOrEqual(62_000);
  expect(await elapsed()).toBeLessThan(80_000);
  await d.getByRole("button", { name: "Pause" }).click();
  await paused(page);
  await settled(page);
  const saved = (await listening(page, 5)).position;
  expect(saved).toBeGreaterThanOrEqual(62_000);
  expect(saved).toBeLessThan(80_000);
  await page.keyboard.press("Escape");
  // A reload loads the episode paused at its position; Play resumes there.
  await page.reload();
  await expect(bar(page).locator(".player-bar-title")).toHaveText("Relayed episode");
  await paused(page);
  const d2 = await openPlayer(page);
  await expect(d2.locator(".player-elapsed")).toHaveText(new RegExp(`^00:01:${String(Math.floor(saved / 1000) - 60).padStart(2, "0")}$`));
  // At the speed chosen earlier (1.50): WebKit does not start a stream of unknown length faster than 1×.
  await expect(d2.getByRole("button", { name: "Playback speed" })).toContainText("1.50");
  await d2.getByRole("button", { name: "Play", exact: true }).click();
  await playing(page);
  const resumed = async () => {
    const [h, m, sec] = (await d2.locator(".player-elapsed").innerText()).split(":").map(Number);
    return ((h! * 60 + m!) * 60 + sec!) * 1000;
  };
  await expect.poll(resumed, { timeout: 30_000 }).toBeGreaterThanOrEqual(saved + 2_000);
  const from = await resumed();
  const t0 = Date.now();
  await expect.poll(resumed, { timeout: 30_000, intervals: [100] }).toBeGreaterThanOrEqual(from + 12_000);
  expect(12_000 / (Date.now() - t0), "1.5× plays faster than 1×").toBeGreaterThan(1.2);
  expect(await resumed()).toBeLessThan(saved + 45_000);
  await d2.getByRole("button", { name: "Pause" }).click();
  await paused(page);
  await settled(page);
  expect((await listening(page, 5)).position).toBeGreaterThanOrEqual(saved + 1_000);
  await page.keyboard.press("Escape");
});

/** converted is a fixture episode this engine cannot play, so the server converts it: ALAC, Vorbis, or Opus in MP4 (WebKit). */
async function converted(p: Page): Promise<number> {
  const caps = await p.evaluate(() => {
    const a = document.createElement("audio");
    return { alac: a.canPlayType('audio/mp4; codecs="alac"'), vorbis: a.canPlayType('audio/ogg; codecs="vorbis"'), opus: a.canPlayType('audio/mp4; codecs="opus"') };
  });
  return caps.alac === "" ? 6 : caps.vorbis === "" ? 7 : caps.opus === "" ? 8 : 0;
}

test("a format this browser cannot play is converted, on the episode's timeline", async () => {
  const n = await converted(page);
  test.skip(n === 0, "this engine plays all three formats");
  const from = streams.length;
  await stream(page, n);
  await expect.poll(() => streamed("/v1/media/s/", from)).toBe(true);
  await reaches(page, 2_000);
  // A seek starts the conversion again at the target; positions stay on the episode's timeline.
  const d = await openPlayer(page);
  await d.getByRole("slider", { name: "Position" }).fill("60000");
  await expect.poll(() => streamed("start_ms=60000", from)).toBe(true);
  await expect.poll(async () => (await audio(page)).t, { timeout: 30_000 }).toBeGreaterThanOrEqual(1_000);
  await expect(d.locator(".player-elapsed")).toHaveText(/^00:01:0\d$/);
  await d.getByRole("button", { name: "Pause" }).click();
  await paused(page);
  await settled(page);
  const s = await listening(page, n);
  expect(s.position).toBeGreaterThanOrEqual(60_000);
  expect(s.position).toBeLessThan(75_000);
  await page.keyboard.press("Escape");
});

test("a converted stream plays at the chosen speed, within a few percent", async () => {
  // WebKit plays a stream of unknown length still arriving at 1x, whatever its speed:
  // the player feeds converted streams through Media Source Extensions where the browser takes them.
  const n = await converted(page);
  test.skip(n === 0, "this engine plays all three formats");
  const from = streams.length;
  await stream(page, n); // resumes where the test before paused, at about 1:01
  await expect.poll(() => streamed("/v1/media/s/", from)).toBe(true);
  // Where the browser's MediaSource takes the stream (Chromium, WebKit), it is fed through it; Firefox plays it itself.
  expect(await fedBy(page)).toBe(browserNameOf(page) === "firefox" ? "element" : "mediasource");
  const d = await openPlayer(page);
  try {
    await expect(d.getByRole("button", { name: "Playback speed" })).toContainText("1.50");
    // From 0:10, so the episode (1:30) does not end during the measurement.
    const at = streams.length;
    await d.getByRole("slider", { name: "Position" }).fill("10000");
    await expect.poll(() => streamed("start_ms=10000", at)).toBe(true);
    await expect.poll(async () => (await audio(page)).t, { timeout: 30_000 }).toBeGreaterThanOrEqual(500);
    // Media time against wall time, both measured in the page.
    const ratio = await page.evaluate(async () => {
      const a = document.querySelector("audio")!;
      const t0 = performance.now(), m0 = a.currentTime;
      await new Promise((r) => setTimeout(r, 8_000));
      return (a.currentTime - m0) / ((performance.now() - t0) / 1000);
    });
    expect(ratio, "1.5x plays 1.5 seconds of media a second").toBeGreaterThan(1.455);
    expect(ratio).toBeLessThan(1.545);
  } finally {
    await leavePlayer(page);
  }
});

/** leavePlayer pauses and closes the player screen, also after a failure, so the next test finds the bar. */
async function leavePlayer(p: Page): Promise<void> {
  if (await p.getByRole("dialog", { name: /episode/ }).count()) await p.keyboard.press("Escape");
  const pause = bar(p).getByRole("button", { name: "Pause" });
  // An episode that ended meanwhile leaves nothing to pause.
  if (await pause.count()) await pause.click({ timeout: 5_000 }).catch(() => {});
}

test("a converted stream played to its end completes only when the server says so", async () => {
  // WebKit never ends a stream of unknown length; it plays to the end and stays there.
  const n = await converted(page);
  test.skip(n === 0, "this engine plays all three formats");
  // Playing it, whatever the test before left (paused, or playing where it failed).
  await go(page, `/episode/${encodeURIComponent(ids[n - 1]!)}`);
  const streamButton = page.locator(".episode-buttons").getByRole("button", { name: "Stream" });
  if (await streamButton.count()) await streamButton.click();
  await playing(page);
  const d = await openPlayer(page);
  try {
    await d.getByRole("slider", { name: "Position" }).fill("84000");
    await expect.poll(() => streamed("start_ms=84000")).toBe(true);
    await expect.poll(async () => (await listening(page, n)).playState, { timeout: 45_000 }).toBe("played");
  } finally {
    if (await d.count()) await page.keyboard.press("Escape");
  }
});

test("a long converted stream fed through a MediaSource is read at most about ten minutes ahead, not whole", async () => {
  await stream(page, 9);
  const d = await openPlayer(page);
  try {
    const at = streams.length;
    await d.getByRole("slider", { name: "Position" }).fill("600000");
    // Chromium cannot seek in the relayed file: a converted stream starts at 10:00, fed through its MediaSource.
    // Firefox plays the conversion itself, WebKit seeks in the file itself: no feed to bound there.
    // (A first converted stream starts at its descriptor's offset: its address names no start.)
    await expect.poll(async () => streams.length > at || (await audio(page)).t >= 600_000, { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await fedBy(page)) === "mediasource" || (await audio(page)).t > 0, { timeout: 30_000 }).toBe(true);
    const viaMediaSource = (await fedBy(page)) === "mediasource";
    test.skip(!viaMediaSource, "this engine plays the long episode without a MediaSource");
    const ahead = () =>
      page.evaluate(() => {
        const a = document.querySelector("audio")!;
        return a.buffered.length ? a.buffered.end(a.buffered.length - 1) - a.currentTime : 0;
      });
    // The server converts far faster than real time: the feed reads until it holds ten minutes ahead...
    await expect.poll(ahead, { timeout: 90_000 }).toBeGreaterThanOrEqual(590);
    // ...and stops there: the stream, twenty minutes long, is not read to its end.
    const token = streams.at(-1)!.split("?")[0]!;
    const status = await page.evaluate(async (t) => (await (await fetch(`${t}/status`)).json()) as { state: string }, token);
    expect(status.state, "the server still has the rest to send").toBe("streaming");
    expect(await ahead()).toBeLessThan(690);
  } finally {
    await leavePlayer(page);
  }
});

test("Android's keyboard shortcuts: P and Space play and pause, J and K skip, the volume keys, and T and B scroll a list", async () => {
  await stream(page, 1);
  await reaches(page, 1_000);
  const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await blur();
  await page.keyboard.press("p");
  await paused(page);
  const t0 = (await audio(page)).t;
  await page.keyboard.press("k");
  await expect.poll(async () => (await audio(page)).t).toBeGreaterThanOrEqual(t0 + 29_000);
  const t1 = (await audio(page)).t;
  await page.keyboard.press("j");
  await expect.poll(async () => (await audio(page)).t).toBeLessThanOrEqual(t1 - 9_000);
  await page.keyboard.press(" ");
  await playing(page);
  await page.keyboard.press(" ");
  await paused(page);
  // Space on a button is the button's: here it opens the player screen, and does not toggle.
  await bar(page).locator(".player-bar-open").focus();
  await page.keyboard.press(" ");
  await expect(page.getByRole("dialog", { name: /episode/ })).toBeVisible();
  await paused(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: /episode/ })).toHaveCount(0);
  await blur();
  // The volume keys change this browser's player volume and say so.
  await page.keyboard.press("m");
  await expect(page.locator(".snackbar", { hasText: "Muted" })).toBeVisible();
  expect(await page.evaluate(() => document.querySelector("audio")!.muted)).toBe(true);
  await page.keyboard.press("s");
  await expect(page.locator(".snackbar", { hasText: "Volume 90%" })).toBeVisible();
  await expect(page.locator(".snackbar", { hasText: "Muted" })).toHaveCount(0);
  expect(await page.evaluate(() => [document.querySelector("audio")!.muted, document.querySelector("audio")!.volume])).toEqual([false, 0.9]);
  await page.keyboard.press("w");
  await expect(page.locator(".snackbar", { hasText: "Volume 100%" })).toBeVisible();
  // A wide window's bar carries the player's controls: fast-forward from the bar itself.
  const t2 = (await audio(page)).t;
  await bar(page).getByRole("button", { name: "Fast-forward" }).click();
  await expect.poll(async () => (await audio(page)).t).toBeGreaterThanOrEqual(t2 + 29_000);
  await expect(bar(page).getByRole("slider", { name: "Position" })).toBeVisible();
  await page.screenshot({ path: ".work/player-bar-wide.png" });
  // Speed presets: add the current speed, remove it with Delete, add it again and remove it with a right-click
  // (Android's long press).
  const pd = await openPlayer(page);
  await pd.getByRole("button", { name: "Playback speed" }).click();
  const speed = page.locator(".speed-dialog");
  await speed.getByRole("button", { name: "Increase speed" }).click();
  const added = (await speed.getByRole("button", { name: /^Add preset / }).getAttribute("aria-label"))!.replace("Add preset ", "");
  const preset = speed.locator(".speed-presets").getByRole("button", { name: added, exact: true });
  await expect(preset).toHaveCount(0);
  await speed.getByRole("button", { name: /^Add preset / }).click();
  await expect(preset).toHaveCount(1);
  await preset.focus();
  await page.keyboard.press("Delete");
  await expect(preset).toHaveCount(0);
  await speed.getByRole("button", { name: /^Add preset / }).click();
  await preset.click({ button: "right" });
  await expect(preset).toHaveCount(0);
  await speed.locator(".speed-presets").getByRole("button", { name: "1.50", exact: true }).click();
  await expect(speed).toHaveCount(0);
  await page.keyboard.press("Escape");
  // T and B scroll a list to its top and bottom.
  await page.setViewportSize({ width: 1280, height: 320 });
  try {
    await go(page, "/episodes");
    await expect(page.locator(".episode-title", { hasText: "Player episode 1" })).toBeVisible();
    await blur();
    await page.keyboard.press("b");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await page.keyboard.press("t");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
  }
});

test("a logout in another tab first saves where this tab was playing", async () => {
  await stream(page, 1);
  await settled(page);
  if (!page2 || page2.isClosed()) page2 = await context.newPage();
  await page2.goto(server.base + "/settings");
  await settled(page2);
  // A seek far ahead, then the logout before the next periodic save.
  const d = await openPlayer(page);
  await d.getByRole("slider", { name: "Position" }).fill("400000");
  await reaches(page, 400_000);
  await page.keyboard.press("Escape");
  const before = (await audio(page)).t;
  await page2.getByRole("button", { name: "Logout" }).click();
  await expect(page.getByRole("heading", { name: "Log in to NotTennaPod" })).toBeVisible();
  await page.getByLabel("Username").fill(user);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(bar(page).locator(".player-bar-title")).toHaveText("Player episode 1");
  await paused(page);
  await settled(page);
  expect((await listening(page, 1)).position, "the position at the logout was saved").toBeGreaterThanOrEqual(before - 500);
  expect((await audio(page)).t).toBeGreaterThanOrEqual(before - 500);
});
