// The web actor's own test (PROTOCOL §16): the actor runs
// as a child process speaking docs/ACTOR-PROTOCOL.md, against a real server, a media
// publisher and a private feed, one test per group of actions, readings and
// faults. Every action is checked on the server through the read API, not
// only through the actor's readings, and every reading against the server.
import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { t, w } from "../../src/i18n.ts";
import { root, serverRepo } from "../support/build.ts";
import { startPublisher, type Publisher } from "../support/player.ts";
import { startFeeds, startServer, type Feeds, type RunningServer } from "../support/server.ts";

test.describe.configure({ mode: "serial" });

interface Reply {
  id: string | number | null;
  ok: boolean;
  result?: Record<string, any>;
  error?: { code: string; message: string; [k: string]: any };
}

/** Actor is the actor's child process, spoken to as the hub speaks to it: one JSON line each way. */
class Actor {
  readonly proc: ChildProcess;
  readonly #waiting = new Map<string | number | null, ((r: Reply) => void)[]>();
  #next = 1;

  constructor() {
    this.proc = spawn(process.execPath, [join(root, "e2e", "acceptance", "actor.ts")], { stdio: ["pipe", "pipe", "inherit"] });
    createInterface({ input: this.proc.stdout! }).on("line", (line) => {
      const r = JSON.parse(line) as Reply; // every stdout line must be a reply
      const ws = this.#waiting.get(r.id);
      const resolve = ws?.shift();
      if (!resolve) throw new Error(`a reply nobody asked for: ${line}`);
      if (!ws!.length) this.#waiting.delete(r.id);
      resolve(r);
    });
  }

  #expect(id: string | number | null): Promise<Reply> {
    return new Promise((resolve) => this.#waiting.set(id, [...(this.#waiting.get(id) ?? []), resolve]));
  }

  /** raw writes one line as it is; its reply has the id given. */
  raw(line: string, id: string | number | null): Promise<Reply> {
    const reply = this.#expect(id);
    this.proc.stdin!.write(`${line}\n`);
    return reply;
  }

  send(cmd: string, profile?: string, args?: Record<string, unknown>): Promise<Reply> {
    const id = `r${this.#next++}`;
    return this.raw(JSON.stringify({ id, cmd, ...(profile ? { profile } : {}), ...(args ? { args } : {}) }), id);
  }

  async ok(cmd: string, profile?: string, args?: Record<string, unknown>): Promise<Record<string, any>> {
    const r = await this.send(cmd, profile, args);
    if (!r.ok) throw new Error(`${cmd} failed: ${JSON.stringify(r.error)}`);
    return r.result!;
  }

  async fails(cmd: string, profile?: string, args?: Record<string, unknown>): Promise<NonNullable<Reply["error"]>> {
    const r = await this.send(cmd, profile, args);
    if (r.ok) throw new Error(`${cmd} succeeded: ${JSON.stringify(r.result)}`);
    expect(typeof r.error!.message).toBe("string");
    return r.error!;
  }

  async stop(): Promise<void> {
    if (this.proc.exitCode !== null) return;
    const exited = new Promise((r) => this.proc.once("exit", r));
    this.proc.stdin!.end(); // the end of input shuts the actor down
    await exited;
  }
}

/** Server reads the server's read API with its own web session: the oracle the actor's readings are checked against. */
class Server {
  readonly base: string;
  #cookie = "";
  constructor(base: string) {
    this.base = base;
  }
  async logIn(username: string, password: string): Promise<this> {
    const r = await fetch(`${this.base}/v1/auth/web`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: this.base },
      body: JSON.stringify({ username, password }),
    });
    expect(r.status).toBe(200);
    this.#cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    // The read API serves sessions bound to an installation: the oracle registers its own.
    await this.post("/v1/installations", {
      install_id: crypto.randomUUID(),
      instance_nonce: crypto.randomUUID(),
      name: oracleName,
      app_version: "0",
      capabilities: ["favorites", "history", "inbox", "queue", "statistics"],
    });
    return this;
  }
  async get<T = Record<string, any>>(path: string): Promise<T> {
    const r = await fetch(this.base + path, { headers: { Cookie: this.#cookie, Accept: "application/json" } });
    expect(r.status, path).toBe(200);
    return (await r.json()) as T;
  }
  async post<T = Record<string, any>>(path: string, body: unknown): Promise<T> {
    const r = await fetch(this.base + path, {
      method: "POST",
      headers: { Cookie: this.#cookie, "Content-Type": "application/json", Origin: this.base },
      body: JSON.stringify(body),
    });
    expect(r.status, path).toBeLessThan(300);
    return (await r.json()) as T;
  }
  episode = async (id: string) => (await this.get(`/v1/read/episodes/${encodeURIComponent(id)}`)).episode as Record<string, any>;
  ids = async (list: string) => ((await this.get(`/v1/read/${list}?limit=500`)).items as { episode_id: string }[]).map((e) => e.episode_id);
  /** browsers counts the account's browser installations (the actor's profiles), not the oracle's own. */
  browsers = async () => ((await this.get("/v1/read/summary")).installations as { revoked: boolean; name: string }[]).filter((i) => !i.revoked && i.name !== oracleName).length;
}

const oracleName = "Test oracle";
const owner = { username: "owner", password: "correct horse battery" };
const second = { username: "second", password: "another horse battery" };
const show = "Actor Show";

let server: RunningServer;
let publisher: Publisher;
let feeds: Feeds;
let actor: Actor;
let oracle: Server;
let podcast = "";
const ep: string[] = []; // the show's episodes 1 to 3

test.beforeAll(async () => {
  server = await startServer();
  publisher = await startPublisher(show, [
    // Plain HTTP plays through the relay; a strong validator makes the relay seekable.
    { title: "Actor episode 1", seconds: 300, plain: true, etag: true },
    { title: "Actor episode 2", seconds: 120, plain: true },
    { title: "Actor episode 3", seconds: 120, plain: true },
    // Only for the held backward seek: a relayed file without byte ranges, still on its relay.
    { title: "Actor episode 4", seconds: 120, plain: true },
  ]);
  feeds = await startFeeds();
  actor = new Actor();
  oracle = new Server(server.base);
});

test.afterAll(async () => {
  await actor?.stop();
  await feeds?.stop();
  await publisher?.stop();
  await server?.stop();
});

test("protocol: hello names the version; malformed, unknown and misdirected requests get structured errors", async () => {
  const hello = await actor.ok("hello", undefined, { protocol: 1 });
  expect(hello).toMatchObject({ protocol: 1, actor: "nottennapod-web-actor" });
  expect(hello.browser).toMatch(/^chromium \d+/);
  expect(hello.commands).toEqual(expect.arrayContaining(["hold", "held", "release", "crash", "close_tab", "delete_profile", "favorite", "queue", "statistics"]));
  expect(await actor.fails("hello", undefined, { protocol: 2 })).toMatchObject({ code: "protocol_mismatch", protocol: 1 });
  expect((await actor.raw("this is not JSON", null)).error).toMatchObject({ code: "bad_request" });
  expect((await actor.raw(JSON.stringify({ cmd: "hello" }), null)).error).toMatchObject({ code: "bad_request" });
  expect(await actor.fails("frobnicate")).toMatchObject({ code: "bad_request" });
  expect(await actor.fails("queue", "w1")).toMatchObject({ code: "no_profile" });
  expect(await actor.fails("open", "w1", {})).toMatchObject({ code: "bad_request" });
  expect(await actor.fails("hold", "w1", { path: "/v1/push" })).toMatchObject({ code: "no_profile" });
});

test("accounts: set up, log in, a wrong password, and one installation per profile", async () => {
  expect(await actor.ok("open", "w1", { base_url: server.base })).toEqual({ profile: "w1", state: "setup" });
  expect(await actor.fails("open", "w1", { base_url: server.base })).toMatchObject({ code: "profile_exists" });
  await actor.ok("set_up", "w1", { setup_code: server.setupCode, ...owner });
  await oracle.logIn(owner.username, owner.password);
  expect(await actor.ok("open", "w2", { base_url: server.base })).toMatchObject({ state: "sign_in" });
  const wrong = await actor.fails("log_in", "w2", { username: owner.username, password: "not the password" });
  expect(wrong.code).toBe("ui_error");
  expect(await actor.ok("log_in", "w2", owner)).toEqual({ username: owner.username, already: false });
  expect(await actor.ok("log_in", "w2", owner)).toEqual({ username: owner.username, already: true });
  await expect.poll(() => oracle.browsers()).toBe(2);
  expect(await actor.ok("notice", "w1")).toEqual({ unreachable: false, banners: [], snackbars: [] });
});

test("subscriptions: subscribe, a private feed's login, an existing subscription, and unsubscribe", async () => {
  const sub = await actor.ok("subscribe", "w1", { feed_url: publisher.feedURL });
  expect(sub).toMatchObject({ title: show, facts: [{ type: "podcast.subscribe", outcome: "applied" }] });
  podcast = sub.podcast_id;
  const items = (await oracle.get(`/v1/read/podcasts/${encodeURIComponent(podcast)}/episodes?limit=10`)).items as { episode_id: string; title: string }[];
  for (const n of [1, 2, 3]) ep.push(items.find((e) => e.title === `Actor episode ${n}`)!.episode_id);
  expect(await actor.ok("subscribe", "w1", { feed_url: publisher.feedURL })).toMatchObject({ podcast_id: podcast, title: show, already: true });

  const privateURL = feeds.url.replace("feed.xml", "private.xml");
  expect(await actor.fails("subscribe", "w1", { feed_url: privateURL })).toMatchObject({ code: "needs_login" });
  const priv = await actor.ok("subscribe", "w1", { feed_url: privateURL, username: "alice", password: "s3cret" });
  expect(priv).toMatchObject({ title: "Private Show", facts: [{ outcome: "applied" }] });
  const login = async () => (await oracle.get(`/v1/read/podcasts/${encodeURIComponent(priv.podcast_id)}`)).podcast.credentials;
  expect(await login()).toEqual({ set: true, username: "alice" });
  expect(await actor.ok("podcast", "w1", { podcast: "Private Show" })).toEqual({ podcast_id: priv.podcast_id, title: "Private Show", authentication: "alice" });
  // The podcast's Authentication setting: a new password, the saved one kept, a changed username without
  // its password refused by the dialog, and no username removing the login.
  expect(await actor.ok("set_feed_login", "w1", { podcast: "Private Show", username: "alice", password: "changed" })).toMatchObject({
    changed: true,
    facts: [{ type: "podcast.set_credentials", outcome: "applied" }],
  });
  expect(await actor.ok("set_feed_login", "w1", { podcast: priv.podcast_id, username: "alice", password: "" })).toEqual({ changed: false });
  expect(await actor.fails("set_feed_login", "w1", { podcast: "Private Show", username: "bob", password: "" })).toMatchObject({ code: "ui_error" });
  expect(await login()).toEqual({ set: true, username: "alice" });
  expect(await actor.ok("set_feed_login", "w1", { podcast: "Private Show", username: "", password: "" })).toMatchObject({ changed: true, facts: [{ outcome: "applied" }] });
  expect(await login()).toEqual({ set: false });
  expect(await actor.ok("podcast", "w1", { podcast: "Private Show", expect: { authentication: null } })).toBeTruthy();

  const subs = await actor.ok("subscriptions", "w1");
  expect(subs.podcasts.map((p: { title: string }) => p.title).sort()).toEqual([show, "Private Show"]);
  expect(await actor.ok("unsubscribe", "w1", { podcast: "Private Show" })).toMatchObject({ facts: [{ type: "podcast.unsubscribe", outcome: "applied" }] });
  expect(((await oracle.get("/v1/read/subscriptions?limit=500")).items as { display_title: string }[]).map((p) => p.display_title)).toEqual([show]);
  expect(await actor.ok("subscriptions", "w1", { expect: { podcasts: [{ podcast_id: podcast, title: show }] } })).toBeTruthy();
});

test("subscribe names the podcast it subscribed, also when another podcast has the same title", async () => {
  const twins = [await startPublisher("Twin Show", [{ title: "Twin episode A", seconds: 60 }]), await startPublisher("Twin Show", [{ title: "Twin episode B", seconds: 60 }])];
  try {
    const ids: string[] = [];
    for (const [i, twin] of twins.entries()) {
      const sub = await actor.ok("subscribe", "w1", { feed_url: twin.feedURL });
      expect(sub).toMatchObject({ title: "Twin Show", facts: [{ type: "podcast.subscribe", outcome: "applied" }] });
      ids.push(sub.podcast_id);
      // The server's own view: the podcast refreshed from this feed, with this feed's episode.
      const view = (await oracle.get(`/v1/read/podcasts/${encodeURIComponent(sub.podcast_id)}`)).podcast;
      expect(view.records.identity.value.refresh_url).toBe(twin.feedURL);
      const titles = ((await oracle.get(`/v1/read/podcasts/${encodeURIComponent(sub.podcast_id)}/episodes?limit=10`)).items as { title: string }[]).map((e) => e.title);
      expect(titles).toEqual([`Twin episode ${"AB"[i]}`]);
    }
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) await actor.ok("unsubscribe", "w1", { podcast: id });
  } finally {
    for (const twin of twins) await twin.stop();
  }
});

test("episodes: favorite, mark played, and the queue's add, move, remove and clear, on the server and in the readings", async () => {
  // By title, as the hub may name it; then by ID.
  expect(await actor.ok("favorite", "w1", { title: "Actor episode 1" })).toMatchObject({ changed: true, facts: [{ type: "favorite.set", outcome: "applied" }] });
  expect((await oracle.episode(ep[0]!)).favorite).toBe(true);
  expect(await actor.ok("favorite", "w1", { episode: ep[0] })).toEqual({ changed: false });
  expect((await actor.ok("favorites", "w1")).episodes).toMatchObject([{ episode_id: ep[0], title: "Actor episode 1", favorite: true }]);

  await actor.ok("mark_played", "w1", { episode: ep[1] });
  expect((await oracle.episode(ep[1]!)).play_state).toBe("played");
  expect(await actor.ok("episode", "w1", { episode: ep[1] })).toMatchObject({ episode_id: ep[1], play_state: "played", favorite: false, in_queue: false });
  expect(await actor.ok("episode", "w1", { episode: ep[0] })).toMatchObject({ play_state: "unplayed", favorite: true });

  for (const id of ep) await actor.ok("queue_add", "w1", { episode: id });
  expect(await oracle.ids("queue")).toEqual(ep);
  const queue = await actor.ok("queue", "w1");
  expect(queue.episodes.map((e: { episode_id: string }) => e.episode_id)).toEqual(ep);
  expect(queue.counters).toEqual({ queue: 3, inbox: 0 });
  expect(queue.toolbar_info).toBe("3 episodes");
  expect(await actor.ok("queue_add", "w1", { episode: ep[0] })).toEqual({ changed: false });

  await actor.ok("queue_move", "w1", { episode: ep[2], to: "top" });
  expect(await oracle.ids("queue")).toEqual([ep[2], ep[0], ep[1]]);
  await actor.ok("queue_move", "w1", { episode: ep[2], to: "bottom" });
  expect(await oracle.ids("queue")).toEqual([ep[0], ep[1], ep[2]]);
  await actor.ok("queue_remove", "w1", { episode: ep[0] });
  expect(await oracle.ids("queue")).toEqual([ep[1], ep[2]]);
  expect(await actor.ok("queue", "w1", { expect: { episodes: [{ episode_id: ep[1] }, { episode_id: ep[2] }] } })).toBeTruthy();
  await actor.ok("queue_clear", "w1");
  expect(await oracle.ids("queue")).toEqual([]);
  expect(await actor.ok("queue", "w1", { expect: { episodes: [], counters: { queue: 0 } } })).toBeTruthy();
  expect(await actor.ok("queue_clear", "w1")).toEqual({ changed: false });
  // A reading that never matches says so, with what it read last.
  const never = await actor.fails("queue", "w1", { expect: { episodes: [{ episode_id: "e1:none" }] }, timeout_ms: 1_500 });
  expect(never).toMatchObject({ code: "timeout", last: { episodes: [] } });
});

test("playback through the relay: play, seek and pause, on the server and in the player, episode, History and Statistics; then clear history and reset statistics", async () => {
  const playing = await actor.ok("play", "w1", { episode: ep[0], require_relay: true });
  expect(playing).toMatchObject({ shown: true, title: "Actor episode 1", state: "playing", source: "relay", offset_ms: 0 });
  // The seek is the audio's: the element at 60 s and playing on (a relay with byte ranges seeks in place).
  const sought = await actor.ok("seek", "w1", { position_ms: 60_000 });
  expect(sought).toMatchObject({ state: "playing", source: "relay", offset_ms: 0 });
  expect(sought.transport_ms, "arrived (60 s less at most 0.25 s) and played on at least 0.5 s").toBeGreaterThanOrEqual(60_250);
  expect(sought.transport_ms).toBeLessThan(63_000);
  const paused = await actor.ok("pause", "w1");
  expect(paused).toMatchObject({ state: "paused" });
  await actor.ok("settle", "w1");
  const s = await oracle.episode(ep[0]!);
  expect(Math.abs(s.position - paused.transport_ms)).toBeLessThan(1_500);
  expect(s.in_queue, "playing an episode adds it to the queue").toBe(true);
  expect(s.history).toBeGreaterThan(0);
  const row = await actor.ok("episode", "w1", { episode: ep[0] });
  expect(row).toMatchObject({ in_queue: true, progress_shown: true, duration_ms: 300_000 });
  expect(row.position_ms).toBe(Math.floor(s.position / 1000) * 1000);
  expect((await actor.ok("history", "w1")).episodes.map((e: { episode_id: string }) => e.episode_id)).toEqual([ep[0]]);

  const played = (await oracle.get("/v1/read/statistics")).played_ms as number;
  expect(played, "the forward seek counts as listening").toBeGreaterThanOrEqual(60_000);
  const stats = await actor.ok("statistics", "w1");
  expect(stats.total_ms).toBe(Math.floor(played / 60_000) * 60_000);
  expect(stats.podcasts).toMatchObject([{ podcast_id: podcast, title: show, played_ms: Math.floor(played / 60_000) * 60_000 }]);
  expect(stats.months.length).toBe(1);

  // A relayed file without byte ranges (no ETag): Chromium cannot seek in it, so the seek is a converted
  // stream that starts at the target; the server then has the position.
  await actor.ok("play", "w1", { episode: ep[1], require_relay: true });
  const converted = await actor.ok("seek", "w1", { position_ms: 30_000 });
  expect(converted).toMatchObject({ state: "playing", source: "converted", offset_ms: 30_000 });
  expect(converted.transport_ms).toBeGreaterThanOrEqual(30_250);
  expect(converted.transport_ms).toBeLessThan(33_000);
  const stopped = await actor.ok("pause", "w1");
  await actor.ok("settle", "w1");
  expect(Math.abs((await oracle.episode(ep[1]!)).position - stopped.transport_ms)).toBeLessThan(1_500);
  // A seek whose stream never comes (its descriptor held) is not a seek: the audio is not there, whatever the
  // screen shows. Another relayed episode, so the seek must ask the server for its converted stream.
  expect(await actor.ok("play", "w1", { episode: ep[2] })).toMatchObject({ source: "relay" });
  const h = (await actor.ok("hold", "w1", { path: "/v1/media/*/play", method: "POST" })).hold;
  const notThere = await actor.fails("seek", "w1", { position_ms: 90_000, timeout_ms: 5_000 });
  expect(notThere).toMatchObject({ code: "timeout", waiting_for: "the audio to reach 90000 ms", target_ms: 90_000 });
  expect(notThere.transport.position_ms).toBeLessThan(80_000);
  expect((await actor.ok("held", "w1", { hold: h })).method).toBe("POST");
  await actor.ok("release", "w1", { hold: h }); // the stream comes: the audio then reaches the target
  await expect.poll(async () => (await actor.ok("player", "w1")).transport_ms, { timeout: 30_000 }).toBeGreaterThanOrEqual(90_000);
  await actor.ok("pause", "w1");
  // A nearby backward seek whose stream never comes is not a seek either, though the audio is past the target
  // (10 s back to 1 s, the descriptor held).
  const ep4 = ((await oracle.get(`/v1/read/podcasts/${encodeURIComponent(podcast)}/episodes?limit=10`)).items as { episode_id: string; title: string }[]).find(
    (e) => e.title === "Actor episode 4",
  )!.episode_id;
  expect(await actor.ok("play", "w1", { episode: ep4 })).toMatchObject({ source: "relay" });
  await expect.poll(async () => (await actor.ok("player", "w1")).transport_ms, { timeout: 30_000 }).toBeGreaterThanOrEqual(10_000);
  const back = (await actor.ok("hold", "w1", { path: "/v1/media/*/play", method: "POST" })).hold;
  const notBack = await actor.fails("seek", "w1", { position_ms: 1_000, timeout_ms: 5_000 });
  expect(notBack).toMatchObject({ code: "timeout", waiting_for: "the audio to reach 1000 ms", target_ms: 1_000 });
  expect(notBack.transport.position_ms).toBeGreaterThan(9_000);
  await actor.ok("release", "w1", { hold: back });
  await expect.poll(async () => (await actor.ok("player", "w1")).transport_ms, { timeout: 30_000 }).toBeLessThan(9_000);
  await actor.ok("pause", "w1");

  await actor.ok("clear_history", "w1");
  expect(await oracle.ids("history")).toEqual([]);
  expect(await actor.ok("history", "w1", { expect: { episodes: [] } })).toBeTruthy();
  expect(await actor.ok("clear_history", "w1")).toEqual({ changed: false });
  await actor.ok("reset_statistics", "w1");
  expect((await oracle.get("/v1/read/statistics")).played_ms).toBe(0);
  expect(await actor.ok("statistics", "w1", { expect: { total_ms: 0 } })).toBeTruthy();
});

test("import: an Android backup into an empty account, its Inbox, and that account's diagnostics as the administrator", async () => {
  const created = await oracle.post<{ account: { account_id: string } }>("/v1/admin/accounts", second);
  await actor.ok("open", "w3", { base_url: server.base });
  await actor.ok("log_in", "w3", second);
  const file = join(serverRepo, "internal", "importer", "androiddb", "testdata", "android-3.12.1", "emulator-parity-library.db");
  const imported = await actor.ok("import", "w3", { file });
  expect(imported).toMatchObject({ state: "published", text: "The AntennaPod backup imported.", imported: { queue: 9, inbox: 1 } });
  const reader = await new Server(server.base).logIn(second.username, second.password);
  expect((await reader.get("/v1/read/summary")).counters).toEqual({ queue: 9, inbox: 1 });
  expect(await actor.ok("import_result", "w3")).toEqual(imported);

  const inbox = await actor.ok("inbox", "w3");
  expect(inbox.episodes).toHaveLength(1);
  expect(inbox.episodes[0]).toMatchObject({ play_state: "new" });
  expect(inbox.counters).toEqual({ queue: 9, inbox: 1 });
  await actor.ok("inbox_remove", "w3", { episode: inbox.episodes[0].episode_id });
  expect((await reader.get("/v1/read/summary")).counters.inbox).toBe(0);
  expect(await actor.ok("inbox", "w3", { expect: { episodes: [], counters: { inbox: 0 } } })).toBeTruthy();
  expect(await actor.ok("inbox_remove", "w3", { all: true })).toEqual({ changed: false });

  const diagnostics = await actor.ok("diagnostics", "w1", { account: second.username });
  expect(diagnostics.account_id).toBe(created.account.account_id);
  expect(diagnostics.devices.length).toBeGreaterThanOrEqual(1);
  // Another account's diagnostics are the administrator's only.
  const ownerAccount = (await oracle.get("/v1/read/summary")).account_id as string;
  expect(await actor.fails("diagnostics", "w3", { account: ownerAccount })).toMatchObject({ code: "api_error", status: 403 });
});

test("import: an upload the server refuses reads as an error with the screen's text", async () => {
  // The owner's account already has a library, so the server refuses to reserve an import into it.
  const dir = mkdtempSync(join(tmpdir(), "ntp-actor-"));
  try {
    const file = join(dir, "subscriptions.opml");
    writeFileSync(file, `<?xml version="1.0"?><opml version="2.0"><head><title>Subscriptions</title></head><body><outline type="rss" text="Show" xmlUrl="${feeds.url}"/></body></opml>`);
    const refused = {
      state: "error",
      text: `${t("import_error_label")}: This account already has a library, so an import would overwrite or mix it. Import into a new, empty account instead.`,
    };
    expect(await actor.ok("import", "w1", { file })).toEqual(refused);
    expect(await actor.ok("import_result", "w1")).toEqual(refused);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lists longer than the screen holds: the Inbox read whole and in order, again on the same screen, and an episode deep in its podcast", async () => {
  // More than the 400 rows a list holds at once: paging on lets go of the rows furthest above.
  const count = 601;
  let published = 1;
  const day = 86_400_000;
  const rss = () =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>Long Show</title><link>https://example.com/</link>${Array.from(
      { length: published },
      (_, i) => `<item><title>Long episode ${i}</title><guid>long-${i}</guid><pubDate>${new Date(Date.UTC(2012, 0, 1) + i * day).toUTCString()}</pubDate>
<enclosure url="https://media.example/long-${i}.mp3" length="1000" type="audio/mpeg"/></item>`,
    ).join("")}</channel></rss>`;
  const long = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/rss+xml" });
    res.end(rss());
  });
  await new Promise<void>((r) => long.listen(0, "127.0.0.1", r));
  try {
    const third = { username: "third", password: "a third horse battery" };
    await oracle.post("/v1/admin/accounts", third);
    await actor.ok("open", "w4", { base_url: server.base });
    await actor.ok("log_in", "w4", third);
    const sub = await actor.ok("subscribe", "w4", { feed_url: `http://127.0.0.1:${(long.address() as AddressInfo).port}/long.xml` });
    const reader = await new Server(server.base).logIn(third.username, third.password);
    // The feed publishes the rest; the server's refresh files them in the Inbox.
    published = count;
    await reader.post("/v1/refresh", { podcast_id: sub.podcast_id });
    await expect.poll(async () => (await reader.get("/v1/read/summary")).counters.inbox, { timeout: 120_000 }).toBeGreaterThan(400);
    const all = async (path: string) => {
      const ids: string[] = [];
      let token = "";
      do {
        const page = await reader.get(`${path}?limit=100${token ? `&page_token=${encodeURIComponent(token)}` : ""}`);
        ids.push(...(page.items as { episode_id: string }[]).map((e) => e.episode_id));
        token = page.next_page_token ?? "";
      } while (token);
      return ids;
    };
    const inbox = await all("/v1/read/inbox");
    const counters = (await reader.get("/v1/read/summary")).counters;
    expect(inbox).toHaveLength(counters.inbox);

    const read = await actor.ok("inbox", "w4");
    expect(read.episodes.map((e: { episode_id: string }) => e.episode_id)).toEqual(inbox);
    expect(read.counters).toEqual(counters);
    // Read again on the screen as the first reading left it: paged to its end.
    expect((await actor.ok("inbox", "w4")).episodes.map((e: { episode_id: string }) => e.episode_id)).toEqual(inbox);

    // The podcast's oldest episode is its last row, past the rows its screen holds at once.
    const episodes = await all(`/v1/read/podcasts/${encodeURIComponent(sub.podcast_id)}/episodes`);
    expect(episodes).toHaveLength(count);
    expect(await actor.ok("episode", "w4", { episode: episodes.at(-1) })).toMatchObject({ episode_id: episodes.at(-1), title: "Long episode 0" });
  } finally {
    await new Promise<void>((r) => long.close(() => r()));
  }
});

test("faults: a push held while its tab closes, while its renderer crashes, lost on its way, and its answer lost", async () => {
  const favorite = async (id: string) => (await oracle.episode(id)).favorite as boolean;
  // A held push, then the tab closed: a new tab sends the journaled change.
  const h1 = (await actor.ok("hold", "w1", { path: "/v1/push", fact_type: "favorite.set" })).hold;
  const f1 = await actor.ok("favorite", "w1", { episode: ep[1], wait: "journaled" });
  const held = await actor.ok("held", "w1", { hold: h1 });
  expect(held).toMatchObject({ method: "POST", path: "/v1/push" });
  expect(held.facts).toContainEqual({ op_id: f1.op_ids[0], type: "favorite.set" });
  expect(await actor.ok("close_tab", "w1")).toEqual({ tab: "closed" });
  expect(await actor.fails("queue", "w1")).toMatchObject({ code: "no_tab" });
  expect(["gone", "continued"]).toContain((await actor.ok("release", "w1", { hold: h1 })).state);
  expect(await actor.ok("open_tab", "w1")).toEqual({ state: "signed_in" });
  await actor.ok("settle", "w1");
  expect(await favorite(ep[1]!)).toBe(true);

  // A held push, then the renderer crashed.
  const h2 = (await actor.ok("hold", "w1", { path: "/v1/push", fact_type: "favorite.set" })).hold;
  await actor.ok("favorite", "w1", { episode: ep[2], wait: "journaled" });
  await actor.ok("held", "w1", { hold: h2 });
  expect(await actor.ok("crash", "w1")).toEqual({ tab: "crashed" });
  expect(await actor.fails("favorites", "w1")).toMatchObject({ code: "no_tab" });
  await actor.ok("release", "w1", { hold: h2 });
  await actor.ok("open_tab", "w1", { path: "/favorites" });
  await actor.ok("settle", "w1");
  expect(await favorite(ep[2]!)).toBe(true);

  // A push lost on its way: the browser sends it again.
  const h3 = (await actor.ok("hold", "w1", { path: "/v1/push", fact_type: "favorite.set" })).hold;
  await actor.ok("favorite", "w1", { episode: ep[2], on: false, wait: "journaled" });
  await actor.ok("held", "w1", { hold: h3 });
  expect(await actor.ok("release", "w1", { hold: h3, mode: "abort" })).toEqual({ hold: h3, state: "aborted" });
  await actor.ok("settle", "w1", { timeout_ms: 60_000 });
  expect(await favorite(ep[2]!)).toBe(false);

  // A push the server took, whose answer was lost: sent again, it is a duplicate, applied once.
  const h4 = (await actor.ok("hold", "w1", { path: "/v1/push", fact_type: "favorite.set" })).hold;
  const f4 = await actor.ok("favorite", "w1", { episode: ep[0], on: false, wait: "journaled" });
  await actor.ok("held", "w1", { hold: h4 });
  expect(await actor.ok("release", "w1", { hold: h4, mode: "drop_answer" })).toEqual({ hold: h4, state: "answer_dropped", server_status: 200 });
  expect(await favorite(ep[0]!)).toBe(false);
  await actor.ok("settle", "w1", { timeout_ms: 60_000 });
  expect((await actor.ok("favorites", "w1", { expect: { episodes: [{ episode_id: ep[1] }] } })).episodes).toHaveLength(1);
  expect(f4.op_ids).toHaveLength(1);

  // A hold nothing matched is cancelled by its release; a hold is per profile.
  const h5 = (await actor.ok("hold", "w1", { path: "/v1/import/*/chunks/*", method: "PUT" })).hold;
  expect(await actor.ok("profiles")).toMatchObject({ profiles: expect.arrayContaining([expect.objectContaining({ profile: "w1", holds: [{ hold: h5, path: "/v1/import/*/chunks/*", state: "waiting" }] })]) });
  expect(await actor.fails("held", "w1", { hold: h5, timeout_ms: 500 })).toMatchObject({ code: "timeout" });
  expect(await actor.ok("release", "w1", { hold: h5 })).toEqual({ hold: h5, state: "cancelled" });
  expect(await actor.fails("release", "w2", { hold: h5 })).toMatchObject({ code: "not_found" });
});

test("a command's deadline bounds its requests: a held API request ends it with timeout, and the next command is not held up", async () => {
  const noReply = (ms: number) => new Promise<"no reply">((r) => setTimeout(() => r("no reply"), ms));
  const h = (await actor.ok("hold", "w1", { path: "/v1/diagnostics" })).hold;
  const started = Date.now();
  const timedOut = actor.send("diagnostics", "w1", { timeout_ms: 1_000 });
  await actor.ok("held", "w1", { hold: h });
  const next = actor.send("notice", "w1"); // queued behind it
  const reply = await Promise.race([timedOut, noReply(10_000)]);
  expect(reply, "the command answers by its deadline, without the request's release").not.toBe("no reply");
  expect(reply).toMatchObject({ ok: false, error: { code: "timeout", waiting_for: "/v1/diagnostics" } });
  expect(Date.now() - started).toBeLessThan(5_000);
  const queued = await Promise.race([next, noReply(5_000)]);
  expect(queued, "the next command is not held up").toMatchObject({ ok: true, result: { unreachable: false } });
  // The page gave the request up: releasing it now changes nothing, and no late answer comes.
  expect(["gone", "continued"]).toContain((await actor.ok("release", "w1", { hold: h })).state);
  expect((await actor.ok("diagnostics", "w1")).account_id).toBeTruthy();
});

test("a deleted profile is gone with its browser data; opening it again is a new installation", async () => {
  const before = await oracle.browsers();
  expect(await actor.ok("delete_profile", "w2")).toEqual({ deleted: "w2" });
  expect(await actor.fails("queue", "w2")).toMatchObject({ code: "no_profile" });
  expect(await actor.ok("open", "w2", { base_url: server.base })).toMatchObject({ state: "sign_in" });
  await actor.ok("log_in", "w2", owner);
  await expect.poll(() => oracle.browsers()).toBe(before + 1);
  const saved = join(root, ".work", "acceptance-results", "w2-profile.json");
  expect(await actor.ok("save_profile", "w2", { path: saved })).toEqual({ path: saved });
});

test("the offline notice: shown while the server is down, carried by a failure, and gone when it is back", async () => {
  await server.halt();
  try {
    // A screen that cannot load says so; the failure carries what the app shows.
    const failed = await actor.fails("history", "w1", { timeout_ms: 5_000 });
    expect(failed).toMatchObject({ code: "timeout", notice: { unreachable: true } });
    expect(await actor.ok("notice", "w1", { expect: { unreachable: true } })).toMatchObject({ banners: [{ role: "alert", text: w("server_unreachable") }] });
  } finally {
    await server.resume();
  }
  expect(await actor.ok("notice", "w1", { expect: { unreachable: false }, timeout_ms: 60_000 })).toMatchObject({ banners: [] });
  // A page load the server does not answer is `unreachable`; once it is back, the app loads again.
  await server.halt();
  try {
    expect(await actor.fails("reload", "w1")).toMatchObject({ code: "unreachable" });
  } finally {
    await server.resume();
  }
  expect(await actor.ok("reload", "w1")).toEqual({ state: "signed_in" });
  expect((await actor.ok("favorites", "w1")).episodes.map((e: { episode_id: string }) => e.episode_id)).toEqual([ep[1]]);
});
