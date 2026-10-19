// The player engine against IndexedDB (fake-indexeddb), a fake audio
// element, a fake read API and a fake clock: sessions, Android's accounting,
// exports, completion, passive loading, adoption, tabs, and recovery when a
// page is killed at each step (PROTOCOL §12).
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EpisodeRow, Summary } from "../src/api/views.ts";
import { openDB, type Fact } from "../src/journal/db.ts";
import { acknowledge, append, entries, installation, lineages, newAuthor, retire, retireLineage, updateInstallation } from "../src/journal/journal.ts";
import { between, keyString, uuidValue, type QueueKey } from "../src/queue/keys.ts";
import { Player, type Channel, type EpisodeView, type Media, type MediaListener, type Message, type PlayerDeps } from "../src/player/engine.ts";
import { exportPending, getLease, inPlayer, listeningFrontier, sessionsOf, sessionsOfEpisode, updateLease } from "../src/player/store.ts";
import { addToQueue, loadedHere } from "../src/app/queueOps.ts";
import { retainedEntries, takeSuccessor } from "../src/journal/successor.ts";

const gen = "g1:" + "a".repeat(64);
const podcast = "p1:" + "b".repeat(64);
const minute = 60_000;

class FakeMedia implements Media {
  url: string | null = null;
  position = 0;
  duration = 0;
  paused = true;
  ended = false;
  rate = 1;
  failPlay = false;
  durations = new Map<string, number>();
  #l: MediaListener | undefined;
  listen(l: MediaListener) {
    this.#l = l;
  }
  /** waiting is the element waiting for this device's connection (true), and no longer (false): the position holds meanwhile. */
  #waiting = false;
  waiting(on: boolean) {
    this.#waiting = on;
    this.#l?.waiting?.(on);
  }
  async load(url: string, position: number) {
    if (this.url !== url) {
      this.url = url;
      this.duration = this.durations.get(url) ?? 10 * minute;
    }
    this.position = position;
    this.ended = false;
  }
  async play() {
    if (this.failPlay) throw new Error("NotSupportedError");
    this.paused = false;
    this.ended = false;
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    setTimeout(() => this.#l?.paused());
  }
  seek(p: number) {
    this.position = p;
    this.ended = false;
  }
  unload() {
    this.url = null;
    this.paused = true;
  }
  /** advance plays ms of wall time at the rate. */
  advance(ms: number) {
    if (this.paused || this.#waiting) return;
    this.position += ms * this.rate;
    if (this.position >= this.duration) {
      this.position = this.duration;
      this.paused = true;
      this.ended = true;
      this.#l?.paused();
      this.#l?.ended();
    } else this.#l?.time();
  }
  /** externalPause is the browser or the system pausing (headphones out, another app). */
  externalPause() {
    this.paused = true;
    this.#l?.paused();
  }
}

class Hub {
  channels = new Set<FakeChannel>();
}

class FakeChannel implements Channel {
  connected = true;
  #fns = new Set<(m: Message) => void>();
  readonly #hub: Hub;
  constructor(hub: Hub) {
    this.#hub = hub;
    hub.channels.add(this);
  }
  post(m: Message) {
    if (!this.connected) return;
    for (const c of this.#hub.channels) if (c !== this && c.connected) setTimeout(() => c.#fns.forEach((f) => f(m)));
  }
  listen(fn: (m: Message) => void) {
    this.#fns.add(fn);
    return () => this.#fns.delete(fn);
  }
}

let dbn = 0;

/** World is one browser profile and the server's views. */
class World {
  clock = 1_800_000_000_000;
  name = `player-${++dbn}`;
  account = crypto.randomUUID();
  hub = new Hub();
  views = new Map<string, EpisodeView>();
  queue: string[] = [];
  policy = { enqueue_location: "back", keep_sorted: false, sort_order: "date_new_old" };
  head = { cursor: "c", log_id: "log-1", epoch: 1, seq: 1 };
  offline = false;
  db!: IDBDatabase;

  async init() {
    this.db = await openDB(indexedDB, this.name);
    await installation(this.db, this.account);
    await updateInstallation(this.db, this.account, (r) => {
      r.registered = true;
    });
    return this;
  }

  episode(n: number, o: { duration?: number; queued?: boolean; url?: string; position?: number; claim?: string } = {}): EpisodeRow {
    const id = `e1:${String(n).padStart(64, "0")}`;
    const url = o.url ?? `https://media.test/${n}.wav`;
    const records: EpisodeRow["records"] = {
      identity: { value: { podcast_id: podcast, occurrence: { k: "rss-guid", v: `g${n}`, guid: `g${n}`, enclosure_url: url } }, provenance: [] },
    };
    if (o.claim) records.position = { value: { generation_id: gen, position: o.position ?? 0, claim_id: o.claim }, provenance: [o.claim] };
    const row: EpisodeRow = {
      episode_id: id, podcast_id: podcast, title: `Episode ${n}`, pub_date: n * 1000, link: null, image_url: "", has_media: true,
      duration_ms: o.duration ?? 10 * minute, size: 0, play_state: "unplayed", position: o.position ?? 0, favorite: false,
      in_queue: false, history: null, last_played: 0, placeholder: false,
      podcast: { title: "Show", display_title: "Show", image_url: "", state: "subscribed", generation_id: gen },
      records, metadata: { media: { url }, description: `Notes ${n}` },
    };
    this.views.set(id, { head: this.head, episode: row, podcast: { podcast_id: podcast, title: "Show", display_title: "Show", image_url: "", state: "subscribed", keep_updated: true, credentials: false, records: {}, generation_id: gen } });
    if (o.queued) this.enqueue(id);
    return row;
  }

  enqueue(id: string) {
    this.queue.push(id);
    this.#rekey();
  }

  #rekey() {
    let low: QueueKey | null = null;
    for (const id of this.queue) {
      const v = this.views.get(id)!;
      const k = between(low, null, uuidValue(crypto.randomUUID()));
      v.episode.in_queue = true;
      v.episode.records.queue_position = { value: { key: keyString(k), position_id: crypto.randomUUID() }, provenance: [] };
      low = k;
    }
  }

  reads = {
    episode: async (id: string): Promise<EpisodeView> => {
      if (this.offline) throw new Error("unreachable");
      const v = this.views.get(id);
      if (!v) throw new Error("no episode");
      return structuredClone({ ...v, head: this.head });
    },
    queue: async (): Promise<EpisodeRow[]> => {
      if (this.offline) throw new Error("unreachable");
      return this.queue.map((id) => structuredClone(this.views.get(id)!.episode));
    },
    summary: async (): Promise<Summary> => ({ policies: { queue: this.policy, new_episodes_action: "inbox" } }) as unknown as Summary,
  };

  /** page opens a page load: its own author; tab names the browser tab (a reload keeps it). */
  /** liveTabs are the tab IDs of the open pages: a duplicated tab finds its copied ID in use. */
  liveTabs = new Set<string>();

  async page(tab: string = crypto.randomUUID(), media = new FakeMedia(), deps: Partial<PlayerDeps> = {}) {
    const db = await openDB(indexedDB, this.name); // a tab has its own connection
    const author = await newAuthor(db, this.account);
    const channel = new FakeChannel(this.hub);
    const notices: string[] = [];
    let mine = tab;
    const player = new Player({
      db, account: this.account, page: author.author_id, tab, media, reads: this.reads, channel, now: () => this.clock,
      timers: false, handoffMs: 300, notify: (t) => notices.push(t), needsRelay: "needs relay", unreachable: "unreachable", lastInQueue: "last",
      storageFailed: "storage failed",
      tabInUse: async (t) => this.liveTabs.has(t),
      newTab: () => (mine = crypto.randomUUID()),
      ...deps,
    });
    await player.boot();
    this.liveTabs.add(mine);
    const dispose = player.dispose.bind(player);
    player.dispose = () => {
      this.liveTabs.delete(mine); // a reloaded tab's old page is gone
      dispose();
    };
    return { player, media, channel, tab: mine, author: author.author_id, notices, db };
  }

  /** listen plays for ms of wall time in one-second steps, as the page's timers would. */
  async listen(p: { player: Player; media: FakeMedia }, ms: number, renew = true) {
    for (let t = 0; t < ms; t += 1000) {
      this.clock += 1000;
      p.media.advance(1000);
      p.player.tick();
      if (renew && t % 2000 === 1000) void p.player.leaseTick(); // the page's lease renewal
      await p.player.idle();
    }
    await p.player.idle();
  }

  async facts(): Promise<Fact[]> {
    return (await entries(this.db, this.account)).map((e) => e.fact);
  }

  /** acknowledgeAll gives every journal entry a receipt at the current head (the server applied them). */
  async acknowledgeAll() {
    const all = await entries(this.db, this.account);
    this.head = { ...this.head, seq: this.head.seq + 1 };
    const epoch = this.head.epoch;
    await acknowledge(
      this.db,
      this.account,
      all.filter((e) => !e.receipt).map((e) => ({
        install_seq: e.install_seq,
        receipt: { op_id: e.op_id, content_hash: "h", outcome: "applied", normalized_time: 0, epoch, seq: this.head.seq, index: 0, key_id: "k", mac: "m" },
      })),
      { log_id: this.head.log_id, epoch },
    );
  }

  /**
   * write is the server applying another device's write of an episode's
   * position (a start, a checkpoint, a completion): its claim, a new
   * provenance node, the device's listening time, and the head moving on.
   */
  write(id: string, o: { claim: string; position: number; lastPlayed?: number; generation?: string }) {
    const v = this.views.get(id)!;
    this.head = { ...this.head, seq: this.head.seq + 1 };
    v.episode.position = o.position;
    v.episode.last_played = o.lastPlayed ?? this.clock;
    v.episode.records.position = { value: { generation_id: o.generation ?? gen, position: o.position, claim_id: o.claim }, provenance: [o.claim, crypto.randomUUID()].sort() };
  }

  /**
   * restore is the server restored from a backup (a new epoch of its log), or
   * replaced by another log; shown says a view of it was shown, so the
   * profile moved to it and retired the lineage it left (Sync.shown).
   */
  async restore(o: { log?: string; shown?: boolean } = {}) {
    const old = this.head;
    this.head = o.log ? { cursor: "c", log_id: o.log, epoch: 1, seq: 1 } : { ...old, epoch: old.epoch + 1 };
    if (o.shown === false) return;
    await updateInstallation(this.db, this.account, (r) => {
      r.lineage ??= { log_id: old.log_id, epoch: old.epoch };
      retireLineage(r, this.head);
    });
  }
}

const of = (facts: Fact[], type: string) => facts.filter((f) => f.type === type);
const p = (f: Fact) => f.payload as Record<string, any>;

/** played sums each session's contribution at its greatest ordinal (PROTOCOL §8). */
function played(facts: Fact[]): number {
  const latest = new Map<string, { ordinal: number; c: number }>();
  for (const f of facts) {
    if (f.type !== "session.checkpoint" && f.type !== "session.end") continue;
    const x = p(f);
    const cur = latest.get(x.session_id);
    if (!cur || x.ordinal > cur.ordinal) latest.set(x.session_id, { ordinal: x.ordinal, c: x.contribution });
  }
  return [...latest.values()].reduce((s, v) => s + v.c, 0);
}

/** wellFormed checks that ordinals run 1, 2, … per session, saves are exported once, and only a session's author appends. */
function wellFormed(facts: Fact[]) {
  const sessions = new Map<string, { author: string; ordinals: number[]; saves: number[] }>();
  for (const f of facts) {
    const x = p(f);
    if (f.type === "session.start") sessions.set(x.session_id, { author: f.author_id, ordinals: [], saves: [] });
    if (f.type === "session.checkpoint" || f.type === "session.end") {
      const s = sessions.get(x.session_id)!;
      assert.equal(f.author_id, s.author, "only the session's author appends");
      s.ordinals.push(x.ordinal);
      if (x.save.first) s.saves.push(x.save.index);
    }
    if (f.type === "session.finalize") assert.equal(f.author_id, sessions.get(x.session_id)!.author);
  }
  for (const s of sessions.values()) {
    assert.deepEqual(s.ordinals, s.ordinals.map((_, i) => i + 1), "ordinals from 1 without gaps");
    assert.deepEqual(s.saves, [...new Set(s.saves)].sort((a, b) => a - b), "each save exported once, in order");
  }
}

test("play, pause and resume are one session; Android's contribution; a checkpoint a minute and at pause", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const a = await w.page();
  const t0 = w.clock;
  await a.player.play(e);
  let facts = await w.facts();
  assert.equal(facts.length, 1);
  const start = p(facts[0]!);
  assert.equal(facts[0]!.type, "session.start");
  assert.equal(start.start_position, 0);
  assert.equal(start.activity, true);
  assert.equal(start.duration, 10 * minute);
  assert.equal(start.queue_bundle, undefined, "a queued episode needs no queue add");
  assert.match(start.baseline, /^[0-9a-f-]{36}$/);
  await w.listen(a, 59_000);
  assert.equal(of(await w.facts(), "session.checkpoint").length, 0, "no export within the first minute");
  await w.listen(a, 6_000);
  facts = await w.facts();
  const cps = of(facts, "session.checkpoint");
  assert.equal(cps.length, 1);
  assert.equal(p(cps[0]!).ordinal, 1);
  assert.equal(p(cps[0]!).activity, true);
  assert.ok(Math.abs(p(cps[0]!).contribution - 60_000) <= 1000, `contribution ${p(cps[0]!).contribution}`);
  assert.equal(p(cps[0]!).save.passive, false);
  assert.ok(p(cps[0]!).save.first, "the first export covers the save at start");
  assert.equal(cps[0]!.client_time, t0 + 60_000, "a checkpoint carries its save's time");
  await w.listen(a, 10_000);
  await a.player.pause();
  facts = await w.facts();
  const pause = of(facts, "session.checkpoint").at(-1)!;
  assert.equal(p(pause).ordinal, 2);
  assert.equal(p(pause).position, 75_000);
  assert.equal(p(pause).contribution, 75_000);
  w.clock += 30_000;
  await a.player.play();
  await w.listen(a, 20_000);
  await a.player.pause();
  facts = await w.facts();
  assert.equal(of(facts, "session.start").length, 1, "resume keeps the session");
  const last = p(of(facts, "session.checkpoint").at(-1)!);
  assert.equal(last.position, 75_000 - 800 + 20_000, "resume rewinds 0.8 s as Android does");
  assert.equal(last.contribution, last.position);
  wellFormed(facts);
});

test("speed is not counted; forward seeks count; a rewind below the start freezes the contribution", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true, position: 100_000 });
  const a = await w.page();
  await a.player.play(e);
  assert.equal(p((await w.facts())[0]!).start_position, 100_000);
  a.player.setRate(2);
  await w.listen(a, 10_000); // 20 s of media
  await a.player.seek(200_000);
  await w.listen(a, 5_000); // 210 s
  await a.player.pause();
  let cp = p(of(await w.facts(), "session.checkpoint").at(-1)!);
  assert.equal(cp.position, 210_000);
  assert.equal(cp.contribution, 110_000);
  await a.player.seek(50_000);
  await a.player.play();
  await w.listen(a, 5_000);
  await a.player.pause();
  cp = p(of(await w.facts(), "session.checkpoint").at(-1)!);
  assert.ok(cp.position < 100_000);
  assert.equal(cp.contribution, 110_000, "below the start the contribution keeps its value");
  wellFormed(await w.facts());
});

test("natural end completes, and continuous playback starts the next queue item", async () => {
  const w = await new World().init();
  const e1 = w.episode(1, { queued: true, duration: 2 * minute });
  w.episode(2, { queued: true });
  const a = await w.page();
  a.media.durations.set("https://media.test/1.wav", 2 * minute);
  await a.player.play(e1);
  await a.player.seek(110_000);
  await w.listen(a, 12_000);
  const facts = await w.facts();
  const end = of(facts, "session.end")[0]!;
  assert.deepEqual(
    { reason: p(end).reason, completed: p(end).completed, history: p(end).history, remove: p(end).remove_from_queue, activity: p(end).activity, position: p(end).position, threshold: p(end).threshold_ms },
    { reason: "ended", completed: true, history: true, remove: false, activity: true, position: 120_000, threshold: 30_000 },
  );
  const starts = of(facts, "session.start");
  assert.equal(starts.length, 2);
  assert.equal(p(starts[1]!).episode.episode_id, w.queue[1]);
  assert.equal(a.player.state.playing, true);
  assert.equal(a.player.state.episode?.title, "Episode 2");
  wellFormed(facts);
});

test("skip within 30 s of the end completes; outside it never does and keeps the episode queued", async () => {
  const w = await new World().init();
  const e1 = w.episode(1, { queued: true });
  w.episode(2, { queued: true });
  w.episode(3, { queued: true });
  const a = await w.page();
  await a.player.play(e1);
  await a.player.seek(10 * minute - 20_000);
  await w.listen(a, 2_000);
  await a.player.skip();
  await w.listen(a, 3_000);
  await a.player.skip();
  const ends = of(await w.facts(), "session.end");
  assert.deepEqual(ends.map((f) => [p(f).reason, p(f).completed, p(f).remove_from_queue, p(f).history]), [
    ["skipped", true, false, true],
    ["skipped", false, false, true],
  ]);
  assert.equal(a.player.state.episode?.title, "Episode 3");
  await a.player.skip();
  assert.equal(a.player.state.mode, "none", "the last episode in the queue clears the player");
  assert.deepEqual(a.notices, ["last"]);
  wellFormed(await w.facts());
});

test("switching while playing ends the session; switching away from a paused episode finalizes it lazily", async () => {
  const w = await new World().init();
  const e1 = w.episode(1, { queued: true });
  const e2 = w.episode(2, { queued: true });
  const e3 = w.episode(3, { queued: true });
  const a = await w.page();
  await a.player.play(e1);
  await w.listen(a, 7_000);
  await a.player.play(e2);
  let facts = await w.facts();
  const end = of(facts, "session.end")[0]!;
  assert.deepEqual([p(end).reason, p(end).completed, p(end).history, p(end).activity, p(end).position], ["switched", false, true, true, 7_000]);
  await a.player.seek(10 * minute - 10_000);
  await w.listen(a, 2_000);
  await a.player.pause();
  await a.player.play(e3);
  facts = await w.facts();
  const fin = of(facts, "session.finalize")[0]!;
  const s2 = of(facts, "session.start")[1]!;
  assert.equal(p(fin).session_id, p(s2).session_id);
  assert.equal(p(fin).completed, true, "paused within the threshold: completed when another episode starts");
  assert.equal(p(fin).claim_id, s2.op_id);
  assert.equal(p(fin).ordinal, Math.max(...of(facts, "session.checkpoint").filter((f) => p(f).session_id === p(s2).session_id).map((f) => p(f).ordinal)));
  assert.equal(p(fin).history, true);
  wellFormed(facts);
});

test("playing an unqueued episode carries the queue add at the account's enqueue location", async () => {
  const w = await new World().init();
  w.episode(1, { queued: true });
  w.episode(2, { queued: true });
  const e3 = w.episode(3);
  const a = await w.page();
  await a.player.play(e3);
  const start = (await w.facts())[0]!;
  const b = p(start).queue_bundle;
  assert.ok(b && typeof b.key === "string" && typeof b.position_id === "string");
  assert.deepEqual(Object.keys(b).sort(), ["key", "place", "position_id"], "moves are not part of a placement");
  assert.deepEqual(b.place, { kind: "end" }, "back: the end (PROTOCOL §7.6)");
  assert.deepEqual(start.targets.map((t) => t.id), [e3.episode_id], "the place's anchor is context, never a target");
  // After the current episode: the one playing is not queued, so the front scan (start).
  w.policy.enqueue_location = "after_current";
  const e4 = w.episode(4);
  await a.player.play(e4);
  const next = (await w.facts()).filter((f) => f.type === "session.start").at(-1)!;
  assert.deepEqual(p(next).queue_bundle.place, { kind: "start" });
});

test("after current follows this tab's loaded episode only: a tab showing another tab's playback adds at the front", async () => {
  const w = await new World().init();
  w.policy.enqueue_location = "after_current";
  const first = w.episode(1, { queued: true });
  const playing = w.episode(2, { queued: true });
  const add = w.episode(3);
  const a = await w.page();
  await a.player.play(playing);
  const b = await w.page();
  // Tab B shows A's playback (its state names the episode) but has nothing loaded.
  assert.deepEqual([b.player.state.mode, b.player.state.episode?.episode_id, b.media.url], ["elsewhere", playing.episode_id, null]);
  const queue = await w.reads.queue();
  assert.deepEqual(queue.map((e) => e.episode_id), [first.episode_id, playing.episode_id]);
  const inB = addToQueue([add], queue, w.policy, loadedHere(b.player.state))!.payload as { place: unknown };
  assert.deepEqual(inB.place, { kind: "start" }, "the front scan: [X, A, B]");
  const inA = addToQueue([add], queue, w.policy, loadedHere(a.player.state))!.payload as { place: { kind: string; after?: { episode_id: string } } };
  assert.deepEqual([inA.place.kind, inA.place.after?.episode_id], ["after", playing.episode_id], "the tab playing it: after it");
  a.player.dispose();
  b.player.dispose();
});

test("an episode the browser cannot play directly says so and writes nothing", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true, url: "http://insecure.test/1.mp3" });
  const a = await w.page();
  await a.player.play(e);
  assert.equal((await w.facts()).length, 0);
  assert.equal(a.player.state.error, "needs relay");
  assert.deepEqual(a.notices, ["needs relay"]);
  const f = w.episode(2, { queued: true });
  a.media.failPlay = true;
  await a.player.play(f);
  assert.equal((await w.facts()).length, 0, "a media error before playback writes nothing");
});

test("while the media waits for the connection the player shows it buffering, still playing and with no error, also across Pause and Play", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const a = await w.page();
  await a.player.play(e);
  await w.listen(a, 3_000);
  a.media.waiting(true);
  assert.deepEqual([a.player.state.busy, a.player.state.playing, a.player.state.error], [true, true, null]);
  await a.player.pause();
  a.media.waiting(false); // Pause ended the wait
  assert.equal(a.player.state.busy, false);
  const resumed = a.player.play();
  a.media.waiting(true); // Play waits again
  await resumed;
  assert.deepEqual([a.player.state.busy, a.player.state.playing], [true, true], "a play under way does not hide the wait");
  a.media.waiting(false);
  assert.equal(a.player.state.busy, false);
});

test("an hour of waiting for the connection at one position writes no saves; listening on saves again", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const a = await w.page();
  await a.player.play(e);
  await w.listen(a, 7_000);
  a.media.waiting(true);
  await w.listen(a, 5_000); // the position last saved, if the last save was before it, is saved once
  const [before] = await sessionsOfEpisode(a.db, w.account, e.episode_id);
  const facts = (await w.facts()).length;
  await w.listen(a, 60 * minute);
  const [after] = await sessionsOfEpisode(a.db, w.account, e.episode_id);
  assert.equal(after!.saves, before!.saves, "no saves while waiting at the same position");
  assert.equal((await w.facts()).length, facts, "no checkpoints");
  assert.equal(after!.last.position, before!.last.position);
  a.media.waiting(false);
  await w.listen(a, 6_000);
  const [later] = await sessionsOfEpisode(a.db, w.account, e.episode_id);
  assert.ok(later!.saves > after!.saves, "listening on saves again");
  assert.ok(later!.last.position > after!.last.position);
});

test("a reload restores the episode paused without a fact, exports what was left passively, and resumes the same session", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const tab = crypto.randomUUID();
  const a = await w.page(tab);
  await a.player.play(e);
  await w.listen(a, 30_000); // saves at 5 s steps, no export yet
  a.player.dispose(); // the page is reloaded mid-playback
  w.clock += 4_000;
  const before = (await w.facts()).length;
  const b = await w.page(tab);
  let facts = await w.facts();
  assert.equal(facts.length, before + 1);
  const restart = facts.at(-1)!;
  assert.equal(restart.type, "session.checkpoint");
  assert.equal(p(restart).save.passive, true);
  assert.equal(p(restart).position, 30_000);
  assert.equal(restart.author_id, a.author, "exported under the session's author");
  assert.equal(b.player.state.mode, "here");
  assert.equal(b.player.state.playing, false);
  assert.equal(b.player.state.position, 30_000);
  await b.player.play();
  await w.listen(b, 70_000);
  await b.player.pause();
  facts = await w.facts();
  assert.equal(of(facts, "session.start").length, 1, "the tab's open session resumes after a reload");
  const cps = of(facts, "session.checkpoint");
  const after = cps.filter((f) => p(f).save.baseline !== p(of(facts, "session.start")[0]!).baseline);
  assert.ok(after.length >= 1);
  assert.equal(p(after[0]!).save.passive, false);
  assert.equal(after[0]!.author_id, a.author);
  // A reload restarts Android's baseline after the 0.8 s rewind, so those 0.8 s count again.
  assert.equal(p(cps.at(-1)!).contribution, p(cps.at(-1)!).position + 800, "the contribution continues across the reload");
  wellFormed(facts);
});

test("killed after a save, before its export, during the final save: nothing lost, nothing counted twice", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const a = await w.page();
  await a.player.play(e);
  await w.listen(a, 65_000); // one export at 60 s, then a save at 65 s not exported
  a.player.dispose();
  // During the final save: the page dies before the pause's transaction commits.
  a.media.externalPause();
  const b = await w.page(); // another tab, after the lease lapsed
  w.clock += 11_000;
  let facts = await w.facts();
  assert.equal(p(of(facts, "session.checkpoint").at(-1)!).position, 65_000, "the last durable save is exported once");
  assert.equal(played(facts), 65_000);
  // The new tab plays on: a new session, and the old one is not counted again.
  await b.player.play();
  await w.listen(b, 10_000);
  await b.player.pause();
  facts = await w.facts();
  assert.equal(of(facts, "session.start").length, 2, "another tab starts its own session");
  assert.equal(p(of(facts, "session.start")[1]!).start_position, 65_000 - 800);
  assert.equal(played(facts), 65_000 + 10_000);
  // A third page load exports nothing more.
  const n = facts.length;
  await w.page();
  assert.equal((await w.facts()).length, n);
  wellFormed(await w.facts());
});

test("a live handoff: the owner pauses with a final save, the new tab starts its own session at that position", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const a = await w.page();
  const b = await w.page();
  await a.player.play(e);
  await w.listen(a, 12_000);
  await a.player.idle();
  await b.player.leaseTick();
  assert.equal(b.player.state.mode, "elsewhere");
  assert.equal(b.player.state.episode?.title, "Episode 1");
  await b.player.moveHere();
  await a.player.idle();
  const facts = await w.facts();
  assert.equal(a.player.state.playing, false);
  assert.equal(a.player.state.mode, "elsewhere");
  const final = of(facts, "session.checkpoint").find((f) => f.author_id === a.author)!;
  assert.equal(p(final).position, 12_000);
  const starts = of(facts, "session.start");
  assert.equal(starts.length, 2);
  assert.equal(starts[1]!.author_id, b.author);
  assert.equal(p(starts[1]!).start_position, 12_000, "the owner's final position (no time passed, so no rewind)");
  assert.equal(p(starts[1]!).observed_claim, undefined, "the server had not seen a claim yet");
  assert.equal(b.player.state.playing, true);
  await a.player.leaseTick();
  assert.equal(a.player.state.mode, "elsewhere");
  wellFormed(facts);
});

test("a handoff to a dead owner waits, then exports its saves and takes over", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const a = await w.page();
  const b = await w.page();
  await a.player.play(e);
  await w.listen(a, 22_000);
  a.channel.connected = false; // frozen: it never answers
  a.player.dispose();
  const t0 = Date.now();
  await b.player.moveHere();
  assert.ok(Date.now() - t0 >= 250, "waited for the owner");
  const facts = await w.facts();
  const passive = of(facts, "session.checkpoint").find((f) => f.author_id === a.author)!;
  assert.equal(p(passive).save.passive, true);
  assert.equal(p(passive).position, 20_000);
  assert.equal(b.player.state.playing, true);
  wellFormed(facts);
});

test("a tab that finds it lost the lease pauses itself with a final save", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const a = await w.page();
  await a.player.play(e);
  await w.listen(a, 8_000);
  const c = await w.page();
  c.channel.connected = false; // the handoff message never arrives
  a.channel.connected = false;
  await c.player.moveHere();
  await a.player.leaseTick();
  assert.equal(a.media.paused, true, "its own audio paused");
  assert.equal(a.player.state.mode, "elsewhere"); // it now shows the new owner's player
  const mine = of(await w.facts(), "session.checkpoint").filter((f) => f.author_id === a.author);
  assert.equal(p(mine.at(-1)!).save.passive, false, "its own final save, made by itself");
  assert.ok(p(mine.at(-1)!).position >= 8_000);
  wellFormed(await w.facts());
});

test("listening is never refused because of the lease: a tab without it still saves and exports", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const a = await w.page();
  await a.player.play(e);
  await w.listen(a, 5_000);
  // Another tab takes the lease while a's renewal stalls; a's audio plays on until its next renewal.
  const c = await w.page();
  a.channel.connected = false;
  c.channel.connected = false;
  await c.player.moveHere();
  await w.listen(a, 60_000, false); // a's renewal stalls; its audio plays on
  let mine = of(await w.facts(), "session.checkpoint").filter((f) => f.author_id === a.author);
  assert.ok(mine.length >= 1 && p(mine.at(-1)!).position >= 60_000, "a's saves still export");
  await a.player.leaseTick();
  mine = of(await w.facts(), "session.checkpoint").filter((f) => f.author_id === a.author);
  assert.equal(p(mine.at(-1)!).position, 65_000, "then it pauses with a final save");
  assert.equal(a.media.paused, true, "its own audio paused");
  const facts = await w.facts();
  assert.equal(played(facts), 65_000, "a's listening all counts (c has not exported yet)");
  wellFormed(facts);
});

test("paused adoption: a newer position from another device seals the session without activity; resume starts a new one", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const a = await w.page();
  await a.player.play(e);
  await w.listen(a, 20_000);
  await a.player.pause();
  await w.acknowledgeAll();
  const phone = crypto.randomUUID();
  const v = w.views.get(e.episode_id)!;
  v.episode.position = 300_000;
  v.episode.last_played = w.clock - 10_000;
  v.episode.records.position = { value: { generation_id: gen, position: 300_000, claim_id: phone }, provenance: [phone] };
  await a.player.refresh();
  let facts = await w.facts();
  const seal = of(facts, "session.end")[0]!;
  assert.deepEqual([p(seal).reason, p(seal).activity, p(seal).history, p(seal).completed, p(seal).position], ["superseded", false, false, false, 20_000]);
  assert.equal(p(seal).save.first, undefined, "the seal covers no new save");
  assert.ok(seal.dependencies.includes(phone));
  assert.equal(a.player.state.position, 300_000);
  w.clock += 5_000;
  await a.player.play();
  facts = await w.facts();
  const starts = of(facts, "session.start");
  assert.equal(starts.length, 2);
  assert.equal(p(starts[1]!).start_position, 300_000 - 800);
  assert.equal(p(starts[1]!).observed_claim, phone);
  wellFormed(facts);
});

test("an older remote position never moves the player while our own claim is unsent", async () => {
  const w = await new World().init();
  const other = crypto.randomUUID();
  const e = w.episode(1, { queued: true, position: 50_000, claim: other });
  const a = await w.page();
  await a.player.play(e);
  await w.listen(a, 10_000);
  await a.player.pause();
  await a.player.refresh(); // the view still shows the other claim: ours is not pushed yet
  assert.equal(of(await w.facts(), "session.end").length, 0);
  assert.equal(a.player.state.position, 60_000);
});

test("before a cut, every unexported save of the account is exported under its own author", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const a = await w.page();
  await a.player.play(e);
  await w.listen(a, 17_000);
  const b = await w.page();
  const deps = await b.player.beforeCut();
  const facts = await w.facts();
  const cp = of(facts, "session.checkpoint").at(-1)!;
  assert.equal(cp.author_id, a.author);
  assert.equal(p(cp).position, 15_000);
  assert.ok(deps.includes(cp.op_id), "the cut depends on the export");
  // The owner's next export does not repeat it.
  await w.listen(a, 60_000);
  wellFormed(await w.facts());
});

test("a paused reloaded player that another tab resumes is finalized when the profile switches episodes", async () => {
  const w = await new World().init();
  const e1 = w.episode(1, { queued: true });
  const e2 = w.episode(2, { queued: true });
  const a = await w.page();
  await a.player.play(e1);
  await a.player.seek(10 * minute - 25_000);
  await w.listen(a, 3_000);
  await a.player.pause();
  a.player.dispose();
  w.clock += 11_000;
  const b = await w.page(); // a new tab: passive loading, no fact
  const n = (await w.facts()).length;
  assert.equal(b.player.state.mode, "here");
  await b.player.play(e2);
  const facts = await w.facts();
  const fin = of(facts.slice(n), "session.finalize")[0]!;
  assert.equal(fin.author_id, a.author);
  assert.equal(p(fin).completed, true);
  assert.equal(of(facts.slice(n), "session.start").length, 1);
  wellFormed(facts);
  const lease = await getLease(w.db, w.account);
  assert.equal(lease.current?.episode_id, e2.episode_id);
  assert.equal((await sessionsOf(w.db, w.account)).length, 2);
});

test("when the playing tab closes, another tab exports its last saves once its lease lapses", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const a = await w.page();
  const b = await w.page();
  await a.player.play(e);
  await w.listen(a, 22_000);
  await b.player.leaseTick();
  assert.equal(b.player.state.mode, "elsewhere");
  a.player.dispose(); // the tab is closed while playing
  w.clock += 11_000;
  await b.player.leaseTick();
  const cp = of(await w.facts(), "session.checkpoint").at(-1)!;
  assert.equal(cp.author_id, a.author);
  assert.equal(p(cp).position, 20_000);
  assert.equal(p(cp).save.passive, true);
  assert.equal(b.player.state.mode, "here");
  assert.equal(b.player.state.position, 20_000);
  wellFormed(await w.facts());
});

test("a page that goes for good lets go of its media after its last save has the position; a page kept to come back to keeps it", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const kept = await w.page();
  await kept.player.play(e);
  await w.listen(kept, 7_000);
  kept.player.pageHidden(true);
  await kept.player.idle();
  assert.equal(kept.media.url, "https://media.test/1.wav", "a page kept to come back to keeps its media");
  await kept.player.pause();
  kept.player.dispose();
  const a = await w.page();
  await a.player.play();
  await w.listen(a, 3_000);
  const unload = a.media.unload.bind(a.media);
  a.media.unload = () => {
    unload();
    a.media.position = 0; // as the element: no source, no time
  };
  a.player.pageHidden(false);
  await a.player.idle();
  assert.equal(a.media.url, null, "the page let go of its media");
  // The first page's paused session stays open too (only its own page load appends to it), so the
  // place is read from this page's own session.
  const mine = (await sessionsOf(w.db, w.account)).filter((s) => s.author_id === a.author && !s.sealed && !s.closed);
  assert.equal(mine.length, 1, "the page has one open session");
  const last = mine[0]!.last;
  assert.ok(last.position >= 9_000, `the last save has the position: ${last.position}`);
});

test("a hidden page journals its playing position for its departure, without a push, and plays on", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  let appended = 0; // the facts the player handed to the tab's sync to push
  const a = await w.page(undefined, undefined, { appended: (n) => (appended += n) });
  await a.player.play(e);
  await w.listen(a, 7_000);
  const before = appended;
  await a.player.hidden();
  const last = of(await w.facts(), "session.checkpoint").at(-1);
  assert.equal(last && p(last).position, 7_000, "the position is in the journal");
  assert.equal(appended, before, "no push for it: the page's departure sends it");
  assert.equal(a.player.state.playing, true, "playback goes on in the background");
  wellFormed(await w.facts());
});

test("a background tab closed while its push is unanswered sends its newest checkpoint", async () => {
  // The tab's sync (sync.ts) with the real engine: the player's exports reach it as instance.ts passes them.
  // No other tabs here: the tab's channels to them are left out.
  const saved = (globalThis as Record<string, unknown>).BroadcastChannel;
  (globalThis as Record<string, unknown>).BroadcastChannel = undefined;
  const { Sync } = await import("../src/app/sync.ts");
  (globalThis as Record<string, unknown>).BroadcastChannel = saved;
  const realFetch = globalThis.fetch;
  // The server: the tab's ordinary pushes are never answered (a stalled connection); its keepalive pushes are kept.
  const cursor = Buffer.from(JSON.stringify({ digest: "0".repeat(64), epoch: 1, log_id: "6a1f0e2c-1111-4222-8333-944455556666", seq: 1 })).toString("base64url");
  const held: (() => void)[] = [];
  let answering = false; // after the test: the server answers, so the tab's push loop finishes
  const keepalive: { fact: Fact }[][] = [];
  globalThis.fetch = (async (_path: string, init: { body: string; keepalive?: boolean }) => {
    const body = JSON.parse(init.body) as { operations: { install_seq: number; fact: Fact }[] };
    const answer = () =>
      new Response(
        JSON.stringify({
          head: cursor,
          install_watermark: Math.max(0, ...body.operations.map((o) => o.install_seq)),
          results: body.operations.map((o) => ({
            install_seq: o.install_seq,
            status: "accepted",
            receipt: { op_id: o.fact.op_id, content_hash: "h", outcome: "applied", normalized_time: 0, epoch: 1, seq: 2, index: 0, key_id: "k", mac: "m" },
          })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    if (init.keepalive) {
      keepalive.push(body.operations);
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }); // its answer is not read
    }
    if (answering) return answer();
    return new Promise<Response>((resolve) => held.push(() => resolve(answer())));
  }) as unknown as typeof fetch;
  let sync: InstanceType<typeof Sync> | undefined;
  const w = await new World().init();
  try {
    await updateInstallation(w.db, w.account, (r) => (r.cursor = cursor));
    const author = await newAuthor(w.db, w.account);
    const session = { db: w.db, account: { account_id: w.account, namespace: "n", username: "u", is_admin: false }, author, installation: await installation(w.db, w.account) };
    (globalThis as Record<string, unknown>).BroadcastChannel = undefined;
    sync = new Sync(session as never, { pushDeadline: () => 3_600_000 });
    (globalThis as Record<string, unknown>).BroadcastChannel = saved;
    const e = w.episode(1, { queued: true });
    const a = await w.page(undefined, undefined, { appended: (n) => sync!.journaled(n) });
    await a.player.play(e);
    await w.listen(a, 20_000);
    // Hidden at 20 s: the position is journaled and the departure's push prepared (instance.ts).
    await a.player.hidden();
    await sync.prepare();
    // It plays on in the background to 80 s; its minute checkpoint is journaled and its push hangs.
    await w.listen(a, 60_000);
    const checkpoints = (facts: Fact[]) => of(facts, "session.checkpoint").map((f) => p(f).position);
    assert.deepEqual(checkpoints(await w.facts()), [20_000, 80_000], "both checkpoints are journaled");
    assert.ok(held.length > 0, "the ordinary push is under way, unanswered");
    // The tab is closed: its keepalive push has the 80 s checkpoint.
    let sent: number[] = [];
    for (let i = 0; i < 200 && !sent.includes(80_000); i++) {
      sync.leaving();
      sent = checkpoints((keepalive.at(-1) ?? []).map((o) => o.fact));
      await new Promise((r) => setImmediate(r));
    }
    assert.deepEqual(sent, [20_000, 80_000], "the departure sends the newest checkpoint journaled");
    await a.player.pause();
  } finally {
    answering = true;
    for (const r of held.splice(0)) r();
    // Until the journal is all acknowledged: a push left to run then has nothing to send.
    for (let i = 0; i < 2000 && (await entries(w.db, w.account)).some((x) => !x.receipt); i++) await new Promise((r) => setTimeout(r, 1));
    globalThis.fetch = realFetch;
  }
});

test("continuous playback into an episode the browser cannot play shows that episode with the relay message", async () => {
  const w = await new World().init();
  const e1 = w.episode(1, { queued: true, duration: minute });
  w.episode(2, { queued: true, url: "http://insecure.test/2.mp3" });
  const a = await w.page();
  a.media.durations.set("https://media.test/1.wav", minute);
  await a.player.play(e1);
  await a.player.seek(55_000);
  await w.listen(a, 6_000);
  assert.equal(of(await w.facts(), "session.end").length, 1);
  assert.equal(a.player.state.episode?.title, "Episode 2");
  assert.equal(a.player.state.error, "needs relay");
  assert.equal(of(await w.facts(), "session.start").length, 1);
});

// ---- leases, claims, tabs and the journal

test("a tab that lost the lease never moves the new owner's current episode", async () => {
  const w = await new World().init();
  const e1 = w.episode(1, { queued: true });
  const e2 = w.episode(2, { queued: true });
  const a = await w.page();
  await a.player.play(e1);
  await w.listen(a, 8_000);
  const b = await w.page();
  a.channel.connected = false;
  b.channel.connected = false;
  await b.player.play(e2);
  await a.player.leaseTick(); // a finds it lost the lease and makes its final save
  assert.equal((await getLease(w.db, w.account)).current?.episode_id, e2.episode_id);
  assert.equal(a.media.paused, true);
});

test("an intentional seek after another device's newer claim takes over with a new session", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const a = await w.page();
  await a.player.play(e);
  await w.listen(a, 10_000);
  await w.acknowledgeAll();
  const remote = crypto.randomUUID();
  const v = w.views.get(e.episode_id)!;
  v.episode.position = 300_000;
  v.episode.records.position = { value: { position: 300_000, claim_id: remote }, provenance: [remote] };
  await a.player.refresh(); // playing: remembered, the audio is not moved
  assert.ok(a.media.position < 20_000);
  await a.player.seek(120_000);
  await w.listen(a, 5_000);
  await a.player.pause();
  const facts = await w.facts();
  const starts = of(facts, "session.start");
  assert.equal(starts.length, 2);
  assert.equal(p(starts[1]!).start_position, 120_000);
  assert.equal(p(starts[1]!).observed_claim, remote);
  const ended = of(facts, "session.end").find((f) => p(f).session_id === p(starts[0]!).session_id)!;
  assert.equal(p(ended).reason, "superseded");
  wellFormed(facts);
});

test("a stalled read never holds Pause, the 5 s saves or a lost lease", async () => {
  const w = await new World().init();
  const e1 = w.episode(1, { queued: true });
  const e2 = w.episode(2, { queued: true });
  const a = await w.page();
  await a.player.play(e1);
  await w.listen(a, 5_000);
  const orig = w.reads.episode;
  let entered!: () => void;
  const entering = new Promise<void>((r) => (entered = r));
  let unblock!: () => void;
  const blocked = new Promise<void>((r) => (unblock = r));
  w.reads.episode = async (id) => {
    if (id === e2.episode_id) {
      entered();
      await blocked;
    }
    return orig(id);
  };
  const switching = a.player.play(e2);
  await entering;
  w.clock += 5_000;
  a.media.advance(5_000);
  a.player.tick(); // a save while the switch waits
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const saved = (await sessionsOf(w.db, w.account))[0]!.last.position;
  assert.ok(saved >= 10_000, `the save ran (${saved})`);
  await updateLease(w.db, w.account, (l) => {
    l.fence++;
    l.page = "new-owner";
    l.tab = "new-tab";
  });
  const renew = a.player.leaseTick();
  const pause = a.player.pause();
  assert.equal(a.media.paused, true, "Pause stops the audio at once");
  unblock();
  await switching;
  await renew;
  await pause;
});

test("a journal that cannot be written stops playback and says so", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const a = await w.page();
  const add = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function (value: unknown, ...args: [IDBValidKey?]) {
    if (this.name === "journal") throw new DOMException("quota", "QuotaExceededError");
    return add.call(this, value, ...args);
  };
  try {
    await a.player.play(e);
  } finally {
    IDBObjectStore.prototype.add = add;
  }
  assert.equal(a.media.paused, true);
  assert.equal(a.player.state.error, "storage failed");
  assert.ok(a.notices.includes("storage failed"));
});

test("a duplicated tab takes its own tab ID and starts its own session", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const a = await w.page("duplicated-tab");
  await a.player.play(e);
  await w.listen(a, 10_000);
  const b = await w.page("duplicated-tab");
  assert.notEqual(b.tab, "duplicated-tab");
  await b.player.play();
  w.clock += 1_000;
  a.media.advance(1_000);
  b.media.advance(1_000);
  await a.player.leaseTick();
  await b.player.pause();
  const facts = await w.facts();
  assert.equal(of(facts, "session.start").length, 2);
  wellFormed(facts);
});

test("replaying an episode whose completion is not shown yet starts from the beginning", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const a = await w.page();
  await a.player.play(e);
  await a.player.seek(590_000);
  await a.player.skip(); // within 30 s of the end: completed
  await a.player.play(e);
  const starts = of(await w.facts(), "session.start");
  assert.equal(p(starts.at(-1)!).start_position, 0);
});

test("a cut names the listening just exported even if another tab retired it meanwhile", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const a = await w.page();
  await a.player.play(e);
  await w.listen(a, 15_000);
  const made = await exportPending(w.db, w.account, "cut-page", w.clock);
  await w.acknowledgeAll();
  await retire(w.db, w.account, w.head);
  const deps = await listeningFrontier(w.db, w.account);
  assert.ok(made.length > 0 && made.every((op) => deps.includes(op)));
});

test("a predecessor's late receipt is kept as recovery evidence", async () => {
  const w = await new World().init();
  const author = await newAuthor(w.db, w.account);
  const e = await append(w.db, w.account, author.author_id, { type: "history.clear", targets: [], payload: {} });
  await takeSuccessor(w.db, w.account, async () => {}, { from: (await installation(w.db, w.account)).install_id, freshNonce: false, device: { name: "test", app_version: "0", capabilities: [] } });
  const receipt = { op_id: e.op_id, content_hash: "h", outcome: "applied" as const, normalized_time: w.clock, epoch: 1, seq: 2, index: 0, key_id: "k", mac: "m" };
  await acknowledge(w.db, w.account, [{ install_seq: e.install_seq, receipt }], { log_id: "old", epoch: 1 }, e.install_id);
  const retained = await retainedEntries(w.db, w.account);
  assert.equal(retained.length, 1);
  assert.equal(retained[0]!.install_id, e.install_id);
  assert.equal((await entries(w.db, w.account)).filter((x) => x.receipt).length, 0, "the successor's slot is not acknowledged");
});

// ---- switches, takeovers and account transitions

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test("Pause during a pending switch stays paused, and the old episode's save never moves the current episode back", async () => {
  const w = await new World().init();
  const e1 = w.episode(1, { queued: true });
  const e2 = w.episode(2, { queued: true });
  const a = await w.page();
  await a.player.play(e1);
  await w.listen(a, 12_000);
  const orig = w.reads.episode;
  const entered = deferred<void>();
  const gate = deferred<void>();
  w.reads.episode = async (id) => {
    if (id === e2.episode_id) {
      entered.resolve();
      await gate.promise;
    }
    return orig(id);
  };
  const switching = a.player.play(e2);
  await entered.promise;
  const pausing = a.player.pause();
  assert.equal(a.media.paused, true);
  gate.resolve();
  await switching;
  await pausing;
  await a.player.idle();
  assert.equal(a.media.paused, true, "Pause survives the pending switch");
  assert.equal((await getLease(w.db, w.account)).current?.episode_id, e2.episode_id);
  wellFormed(await w.facts());
});

test("Pause while a refresh finds a newer claim keeps the final seconds of listening", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const a = await w.page();
  await a.player.play(e);
  await w.listen(a, 12_000);
  await w.acknowledgeAll();
  const remote = crypto.randomUUID();
  const v = w.views.get(e.episode_id)!;
  v.episode.position = 300_000;
  v.episode.records.position = { value: { position: 300_000, claim_id: remote }, provenance: [remote] };
  const orig = w.reads.episode;
  const entered = deferred<void>();
  const gate = deferred<void>();
  w.reads.episode = async (id) => {
    entered.resolve();
    await gate.promise;
    return orig(id);
  };
  const refresh = a.player.refresh();
  await entered.promise;
  const pause = a.player.pause();
  gate.resolve();
  await refresh;
  await pause;
  assert.equal(played(await w.facts()), 12_000);
});

test("a takeover seek records every second: the old session up to the seek, the new one from it", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const a = await w.page();
  await a.player.play(e);
  await w.listen(a, 10_000);
  await w.acknowledgeAll();
  const remote = crypto.randomUUID();
  const v = w.views.get(e.episode_id)!;
  v.episode.position = 300_000;
  v.episode.records.position = { value: { position: 300_000, claim_id: remote }, provenance: [remote] };
  await a.player.refresh();
  const orig = w.reads.episode;
  w.reads.episode = async (id) => {
    await new Promise((r) => setTimeout(r, 50)); // a slow server never holds the seek
    return orig(id);
  };
  await a.player.seek(120_000);
  assert.equal(a.media.position, 120_000, "the seek happens at once");
  await w.listen(a, 10_000);
  await a.player.pause();
  const facts = await w.facts();
  assert.equal(played(facts), 20_000);
  assert.deepEqual(of(facts, "session.start").map((f) => p(f).start_position), [0, 120_000]);
  wellFormed(facts);
});

test("fast-forward and rewind are intentional seeks and take over too", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const a = await w.page();
  await a.player.play(e);
  await w.listen(a, 10_000);
  await w.acknowledgeAll();
  const remote = crypto.randomUUID();
  const v = w.views.get(e.episode_id)!;
  v.episode.position = 300_000;
  v.episode.records.position = { value: { position: 300_000, claim_id: remote }, provenance: [remote] };
  await a.player.refresh();
  await a.player.fastForward();
  await a.player.pause();
  const starts = of(await w.facts(), "session.start");
  assert.equal(starts.length, 2);
  assert.equal(p(starts[1]!).observed_claim, remote);
});

test("an account transition stops playback and saves at once, even with a refresh waiting on the network", async () => {
  const w = await new World().init();
  const ep = w.episode(1);
  const tab = await w.page();
  await tab.player.play(ep);
  await tab.player.seek(80_000);
  tab.player.setRate(1.75);
  let started!: () => void;
  let release!: () => void;
  const begun = new Promise<void>((r) => (started = r));
  const gate = new Promise<void>((r) => (release = r));
  const read = w.reads.episode;
  w.reads.episode = async (id) => {
    started();
    await gate;
    return read(id);
  };
  const refreshing = tab.player.refresh();
  await begun;
  // The refresh holds the player's queue on its read; leaving does not wait for it.
  await tab.player.leave();
  assert.equal(tab.media.paused, true, "playback stops without waiting for the read");
  const saved = (await sessionsOf(w.db, w.account))[0]!;
  assert.ok(saved.last && saved.last.position >= 80_000, `the last save is the seek's position: ${JSON.stringify(saved.last)}`);
  release();
  await refreshing;
  tab.player.dispose();
  w.db.close();
  tab.db.close();
});

// ---- races between ends, pauses, the queue and seeks

test("an end that arrives behind a switch never ends the episode switched to", async () => {
  const w = await new World().init();
  const e1 = w.episode(1, { queued: true, duration: 2 * minute });
  const e2 = w.episode(2, { queued: true, duration: 3 * minute });
  const a = await w.page();
  a.media.durations.set("https://media.test/1.wav", 2 * minute);
  a.media.durations.set("https://media.test/2.wav", 3 * minute);
  await a.player.play(e1);
  await a.player.seek(2 * minute - 1_000);
  await w.listen(a, 0);
  const orig = w.reads.episode;
  const entered = deferred<void>();
  const gate = deferred<void>();
  w.reads.episode = async (id) => {
    if (id === e2.episode_id) {
      entered.resolve();
      await gate.promise;
    }
    return orig(id);
  };
  const switching = a.player.play(e2);
  await entered.promise;
  a.media.advance(1_000); // episode 1 runs out while the switch waits for the server
  gate.resolve();
  await switching;
  await a.player.idle();
  const facts = await w.facts();
  const second = of(facts, "session.start").find((f) => p(f).episode.episode_id === e2.episode_id)!;
  assert.deepEqual(of(facts, "session.end").filter((f) => p(f).session_id === p(second).session_id).map((f) => p(f).reason), [], "episode 2 plays on");
  assert.equal(a.player.state.episode?.title, "Episode 2");
  assert.equal(a.player.state.playing, true);
  assert.equal(played(facts), 2 * minute, "episode 1's listening only, none of episode 2's duration");
  wellFormed(facts);
});

test("Pause while the audio is starting keeps it paused, with no error", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const media = new FakeMedia();
  const entered = deferred<void>();
  const release = deferred<void>();
  const play = media.play.bind(media);
  media.play = async () => {
    entered.resolve();
    await release.promise;
    await play();
  };
  const a = await w.page("a", media);
  const playing = a.player.play(e);
  await entered.promise;
  const pausing = a.player.pause();
  release.resolve();
  await Promise.all([playing, pausing]);
  await a.player.idle();
  assert.equal(media.paused, true, "the start Pause cancelled does not begin the audio");
  assert.equal(a.player.state.playing, false);
  assert.deepEqual([a.player.state.error, a.notices], [null, []]);
  // Playing again starts as usual.
  await a.player.play();
  assert.equal(media.paused, false);
  assert.equal(a.player.state.playing, true);
  await w.listen(a, 5_000);
  await a.player.pause();
  wellFormed(await w.facts());
});

test("a queue read without the episode is the queue: after Clear queue nothing follows; unreadable, the last read stands", async () => {
  const w = await new World().init();
  const e1 = w.episode(1, { queued: true, duration: 2 * minute });
  w.episode(2, { queued: true });
  const a = await w.page();
  a.media.durations.set("https://media.test/1.wav", 2 * minute);
  await a.player.play(e1);
  await w.listen(a, 2_000); // the queue is read for continuous playback
  w.queue = []; // Clear queue, from this browser or another device
  await a.player.skip();
  assert.equal(a.player.state.mode, "none", "the cleared queue has no next episode");
  assert.deepEqual(a.notices, ["last"]);
  assert.equal(of(await w.facts(), "session.start").length, 1, "the removed episode never starts");

  // A natural end after the queue was cleared: the same.
  const b = await new World().init();
  const f1 = b.episode(1, { queued: true, duration: 2 * minute });
  b.episode(2, { queued: true });
  const pb = await b.page();
  pb.media.durations.set("https://media.test/1.wav", 2 * minute);
  await pb.player.play(f1);
  await b.listen(pb, 2_000);
  b.queue = [];
  await pb.player.seek(2 * minute - 1_000);
  await b.listen(pb, 2_000);
  assert.equal(pb.player.state.mode, "none");
  assert.equal(of(await b.facts(), "session.start").length, 1);

  // When the queue cannot be read, the last read stands.
  const c = await new World().init();
  const g1 = c.episode(1, { queued: true });
  c.episode(2, { queued: true });
  const pc = await c.page();
  await pc.player.play(g1);
  await c.listen(pc, 2_000);
  c.reads.queue = async () => {
    throw new Error("unreachable");
  };
  await pc.player.skip();
  assert.equal(pc.player.state.episode?.title, "Episode 2");
});

test("an episode whose play added it to the queue is followed by the next one while the add is unsent", async () => {
  const w = await new World().init();
  w.policy.enqueue_location = "front";
  w.episode(1, { queued: true });
  w.episode(2, { queued: true });
  const e3 = w.episode(3);
  const a = await w.page();
  await a.player.play(e3); // its session.start carries the add, at the front; the server has not received it
  await w.listen(a, 2_000);
  await a.player.skip();
  assert.equal(a.player.state.episode?.title, "Episode 1");
  // Once the server has the add, its queue read is the queue: without the episode, nothing follows.
  const b = await new World().init();
  b.policy.enqueue_location = "front";
  b.episode(1, { queued: true });
  const f2 = b.episode(2);
  const pb = await b.page();
  await pb.player.play(f2);
  await b.acknowledgeAll(); // applied; then removed from the queue (the read does not have it)
  await pb.player.skip();
  assert.equal(pb.player.state.mode, "none");
});

test("a seek made while paused survives a reload, and resuming counts no listening for it", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const a = await w.page("tab");
  await a.player.play(e);
  await w.listen(a, 10_000);
  await a.player.pause();
  const before = (await w.facts()).length;
  await a.player.seek(120_000);
  await a.player.idle();
  assert.equal((await w.facts()).length, before, "a paused seek is no fact");
  a.player.pageHidden();
  a.player.dispose(); // reload
  w.clock += 10_000;
  const b = await w.page("tab");
  assert.equal(b.player.state.position, 120_000, "restored at the seek");
  await b.player.play();
  await w.listen(b, 5_000);
  await b.player.pause();
  const facts = await w.facts();
  assert.equal(of(facts, "session.start").length, 1, "the same session resumes");
  const last = p(of(facts, "session.checkpoint").at(-1)!);
  assert.equal(last.position, 120_000 - 800 + 5_000);
  assert.equal(played(facts), 15_000, "only what was listened to");
  wellFormed(facts);
});

test("a seek made while paused is where the episode resumes after another one, and decides its completion", async () => {
  const w = await new World().init();
  const e1 = w.episode(1, { queued: true });
  const e2 = w.episode(2, { queued: true });
  const e3 = w.episode(3, { queued: true });
  const a = await w.page();
  await a.player.play(e1);
  await w.listen(a, 10_000);
  await a.player.pause();
  await a.player.seek(120_000);
  await a.player.play(e2); // switching away finalizes episode 1 lazily
  await w.listen(a, 3_000);
  await a.player.play(e1);
  let facts = await w.facts();
  const starts = of(facts, "session.start").filter((f) => p(f).episode.episode_id === e1.episode_id);
  assert.equal(starts.length, 2);
  assert.equal(p(starts[1]!).start_position, 120_000 - 800, "episode 1 resumes where it was sought to");
  const fin = of(facts, "session.finalize").find((f) => p(f).session_id === p(starts[0]!).session_id)!;
  assert.equal(p(fin).completed, false);
  // Sought within the threshold while paused, then left: completed, as Android decides from the saved position.
  await w.listen(a, 2_000);
  await a.player.pause();
  await a.player.seek(10 * minute - 10_000);
  await a.player.play(e3);
  facts = await w.facts();
  const fin2 = of(facts, "session.finalize").find((f) => p(f).session_id === p(starts[1]!).session_id)!;
  assert.equal(p(fin2).completed, true);
  assert.equal(played(facts), 10_000 + 3_000 + 2_000, "no listening for the seeks");
  wellFormed(facts);
});

test("an add acknowledged while the queue is being read is no removal; a clear after it still is", async () => {
  for (const after of ["kept", "cleared"] as const) {
    const w = await new World().init();
    w.policy.enqueue_location = "front";
    const e1 = w.episode(1, { queued: true });
    const e3 = w.episode(3);
    const a = await w.page();
    await a.player.play(e3); // its session.start carries the add, at the front; unsent
    await w.listen(a, 2_000);
    const read = w.reads.queue;
    let crossing = true;
    w.reads.queue = async () => {
      const snapshot = await read(); // the server's queue before it applies the add
      if (crossing) {
        crossing = false;
        await w.acknowledgeAll(); // the add's acknowledgement arrives before the snapshot does
        w.queue = [];
        if (after === "kept") {
          w.enqueue(e3.episode_id);
          w.enqueue(e1.episode_id);
        }
      }
      return snapshot;
    };
    await a.player.skip();
    if (after === "kept") assert.equal(a.player.state.episode?.title, "Episode 1", "continuous playback goes on");
    else assert.equal(a.player.state.mode, "none", "the queue cleared after the add is the queue");
    a.player.dispose();
  }
});

test("a paused seek in a tab that does not hold the player stays in that tab", async () => {
  const w = await new World().init();
  const e1 = w.episode(1, { queued: true });
  const e2 = w.episode(2, { queued: true });
  const a = await w.page("tab-a");
  await a.player.play(e1);
  await w.listen(a, 10_000);
  await a.player.pause();
  w.clock += 11_000; // tab A froze: its lease lapsed
  const b = await w.page("tab-b"); // tab B restores the episode, paused
  assert.equal(b.player.state.mode, "here");
  await a.player.leaseTick(); // A is back and renews before B notices
  await b.player.seek(10 * minute - 10_000);
  await b.player.idle();
  assert.equal(b.player.state.position, 10 * minute - 10_000, "B's own player moves");
  assert.equal((await getLease(w.db, w.account)).current?.position, 10_000, "the profile's current episode does not");
  assert.deepEqual((await sessionsOf(w.db, w.account)).map((s) => s.resume), [undefined], "nor A's session");
  await a.player.play(e2); // A leaves episode 1 where A paused it
  const fin = of(await w.facts(), "session.finalize")[0]!;
  assert.equal(p(fin).completed, false, "B's seek never decides A's completion");
  wellFormed(await w.facts());
});

test("a paused seek left behind by a switch survives acknowledgement, retirement and a reload", async () => {
  const w = await new World().init();
  const e1 = w.episode(1, { queued: true });
  const e2 = w.episode(2, { queued: true });
  const a = await w.page("tab");
  await a.player.play(e1);
  await w.listen(a, 10_000);
  await a.player.pause();
  await a.player.seek(120_000);
  await a.player.play(e2); // episode 1 is left, finalized lazily, with the seek not yet carried by any save
  await w.listen(a, 3_000);
  // The server applies everything, a view shows it, and the journal retires it.
  const start1 = of(await w.facts(), "session.start")[0]!;
  await w.acknowledgeAll();
  const v1 = w.views.get(e1.episode_id)!;
  v1.episode.position = 10_000;
  v1.episode.records.position = { value: { generation_id: gen, position: 10_000, claim_id: start1.op_id }, provenance: [start1.op_id] };
  await retire(w.db, w.account, w.head);
  a.player.dispose(); // reload while episode 2 is current
  w.clock += 5_000;
  const b = await w.page("tab");
  await b.player.play(e1);
  let facts = (await entries(w.db, w.account)).map((e) => e.fact);
  const restart = of(facts, "session.start").find((f) => p(f).episode.episode_id === e1.episode_id)!;
  assert.equal(p(restart).start_position, 120_000 - 800, "episode 1 resumes where it was sought to");
  // Carried by that start, it is no longer kept once its session's facts are retired.
  await w.listen(b, 2_000);
  await b.player.pause();
  await w.acknowledgeAll();
  await retire(w.db, w.account, w.head);
  b.player.dispose();
  const c = await w.page("tab");
  assert.ok(!(await sessionsOf(w.db, w.account)).some((s) => s.session_id === p(start1).session_id), "the old session is pruned");
  c.player.dispose();
});

test("a kept paused seek gives way to another device's newer position, and is then pruned", async () => {
  const w = await new World().init();
  const e1 = w.episode(1, { queued: true });
  const e2 = w.episode(2, { queued: true });
  const a = await w.page("tab");
  await a.player.play(e1);
  await w.listen(a, 10_000);
  await a.player.pause();
  await a.player.seek(120_000);
  await a.player.play(e2);
  await w.listen(a, 3_000);
  const start1 = of(await w.facts(), "session.start")[0]!;
  await w.acknowledgeAll();
  await retire(w.db, w.account, w.head);
  // A phone played episode 1 since: its claim is the server's.
  const phone = crypto.randomUUID();
  const v1 = w.views.get(e1.episode_id)!;
  v1.episode.position = 300_000;
  v1.episode.records.position = { value: { generation_id: gen, position: 300_000, claim_id: phone }, provenance: [phone] };
  a.player.dispose();
  const b = await w.page("tab");
  await b.player.play(e1);
  const restart = of((await entries(w.db, w.account)).map((e) => e.fact), "session.start").find((f) => p(f).episode.episode_id === e1.episode_id && f.op_id !== start1.op_id)!;
  assert.equal(p(restart).start_position, 300_000, "the phone's newer position wins");
  assert.equal(p(restart).observed_claim, phone);
  await b.player.pause();
  await w.acknowledgeAll();
  await retire(w.db, w.account, w.head);
  b.player.dispose();
  const c = await w.page("tab");
  assert.ok(!(await sessionsOf(w.db, w.account)).some((s) => s.session_id === p(start1).session_id), "the superseded seek is not kept");
  c.player.dispose();
});

// ---- the newest position (PROTOCOL §8.6): the record's version, READY and restores

/** paused plays an episode for a while and pauses, with everything acknowledged: another device's write is then newer. */
async function pausedAfterListening(w: World, tab?: string) {
  const e = w.episode(1, { queued: true });
  const a = await w.page(tab);
  await a.player.play(e);
  await w.listen(a, 20_000);
  await a.player.pause();
  await w.acknowledgeAll();
  return { e, a };
}

const superseded = (facts: Fact[]) => of(facts, "session.end").filter((f) => p(f).reason === "superseded");

test("a paused player follows another device's claim moving on, and Play starts where that device paused", async () => {
  const w = await new World().init();
  const { e, a } = await pausedAfterListening(w);
  const phone = crypto.randomUUID();
  w.clock += 60_000;
  w.write(e.episode_id, { claim: phone, position: 300_000 });
  await a.player.refresh();
  assert.equal(a.player.state.position, 300_000);
  // The phone plays on and pauses under the same claim: its checkpoint moves the record.
  w.clock += 120_000;
  w.write(e.episode_id, { claim: phone, position: 420_000 });
  await a.player.refresh();
  assert.equal(a.player.state.position, 420_000, "the same claim moving on is adopted");
  assert.equal(a.media.position, 420_000);
  assert.equal(superseded(await w.facts()).length, 1, "the session was sealed once, at the first adoption");
  w.clock += 1_000;
  await a.player.play();
  const start = of(await w.facts(), "session.start").at(-1)!;
  assert.equal(p(start).start_position, 420_000 - 800);
  assert.equal(p(start).observed_claim, phone);
  wellFormed(await w.facts());
});

test("a completion under the same claim, back to the position held before, is adopted over a seek made here", async () => {
  const w = await new World().init();
  const { e, a } = await pausedAfterListening(w);
  const phone = crypto.randomUUID();
  w.clock += 60_000;
  w.write(e.episode_id, { claim: phone, position: 0 }); // the phone starts it from the beginning
  await a.player.refresh();
  assert.equal(a.player.state.position, 0);
  await a.player.seek(120_000);
  // The phone listens to the end; none of its checkpoints reach this page, its completion puts the position back to 0.
  w.clock += 600_000;
  w.write(e.episode_id, { claim: phone, position: 0 });
  w.views.get(e.episode_id)!.episode.play_state = "played";
  await a.player.refresh();
  assert.equal(a.player.state.position, 0);
  w.clock += 1_000;
  await a.player.play();
  const start = of(await w.facts(), "session.start").at(-1)!;
  assert.deepEqual([p(start).start_position, p(start).observed_claim], [0, phone]);
});

test("a seek made here while paused stands while the record is unchanged, also after a reload", async () => {
  const w = await new World().init();
  const { e, a } = await pausedAfterListening(w, "tab");
  const phone = crypto.randomUUID();
  w.clock += 60_000;
  w.write(e.episode_id, { claim: phone, position: 300_000 });
  await a.player.refresh();
  await a.player.seek(120_000);
  await a.player.refresh();
  assert.equal(a.player.state.position, 120_000);
  a.player.dispose();
  w.clock += 5_000;
  const b = await w.page("tab");
  await b.player.refresh();
  assert.equal(b.player.state.position, 120_000, "the record the page decided against is kept with the profile");
  w.clock += 1_000;
  await b.player.play();
  const start = of(await w.facts(), "session.start").at(-1)!;
  assert.deepEqual([p(start).start_position, p(start).observed_claim], [120_000 - 800, phone]);
  assert.equal(superseded(await w.facts()).length, 1);
});

/** preparing gives a page media whose load runs during() once, as another device's write landing while the media prepares. */
function preparing(during: () => void): FakeMedia {
  const media = new FakeMedia();
  const load = media.load.bind(media);
  let once = true;
  media.load = async (url, position) => {
    await load(url, position);
    if (once) during();
    once = false;
  };
  return media;
}

test("a newer claim read while the media prepares is where Play starts (READY)", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true, position: 100_000, claim: crypto.randomUUID() });
  const phone = crypto.randomUUID();
  let a!: Awaited<ReturnType<World["page"]>>;
  a = await w.page("a", preparing(() => {
    w.write(e.episode_id, { claim: phone, position: 300_000 });
    void a.player.refresh(); // the event stream announces it
  }));
  await a.player.play(e);
  const start = of(await w.facts(), "session.start")[0]!;
  assert.deepEqual([p(start).start_position, p(start).observed_claim], [300_000, phone]);
  assert.equal(a.media.position, 300_000);
});

test("the same claim moving on while the media prepares is where Play starts (READY)", async () => {
  const w = await new World().init();
  const other = crypto.randomUUID();
  const e = w.episode(1, { queued: true, position: 100_000, claim: other });
  let a!: Awaited<ReturnType<World["page"]>>;
  a = await w.page("a", preparing(() => {
    w.write(e.episode_id, { claim: other, position: 300_000 });
    void a.player.refresh(); // the event stream announces it
  }));
  await a.player.play(e);
  const start = of(await w.facts(), "session.start")[0]!;
  assert.deepEqual([p(start).start_position, p(start).observed_claim], [300_000, other]);
});

test("Pause while the media prepares: READY adopts and starts nothing; the next refresh adopts", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true, position: 100_000, claim: crypto.randomUUID() });
  const phone = crypto.randomUUID();
  let a!: Awaited<ReturnType<World["page"]>>;
  a = await w.page("a", preparing(() => {
    w.write(e.episode_id, { claim: phone, position: 300_000 });
    void a.player.pause();
  }));
  await a.player.play(e);
  await a.player.idle();
  assert.equal(of(await w.facts(), "session.start").length, 0);
  assert.equal(a.player.state.position, 100_000, "READY decided nothing after Pause");
  await a.player.refresh();
  assert.equal(a.player.state.position, 300_000, "a paused player adopts");
  assert.equal(a.media.paused, true);
});

test("our own claim the server has not had yet wins over an older record when an episode is played again", async () => {
  const w = await new World().init();
  const other = crypto.randomUUID();
  const e1 = w.episode(1, { queued: true, position: 50_000, claim: other });
  const e2 = w.episode(2, { queued: true });
  const a = await w.page();
  await a.player.play(e1);
  await w.listen(a, 10_000);
  await a.player.pause();
  await a.player.play(e2);
  await w.listen(a, 3_000);
  w.clock += 1_000;
  await a.player.play(e1); // the view still shows the other claim: ours is unsent
  const facts = await w.facts();
  const again = of(facts, "session.start").filter((f) => p(f).episode.episode_id === e1.episode_id)[1]!;
  assert.equal(p(again).start_position, 60_000 - 800);
  assert.equal(superseded(facts).length, 0);
});

test("our own claim kept on a load that could not start is decided again once the server has it", async () => {
  const w = await new World().init();
  const e1 = w.episode(1, { queued: true });
  const e2 = w.episode(2, { queued: true });
  const a = await w.page();
  await a.player.play(e1); // P, unsent
  await w.listen(a, 10_000);
  await a.player.pause();
  await a.player.play(e2);
  await w.listen(a, 3_000);
  await a.player.pause();
  // Another device plays episode 1 after P; this load keeps P's position while P is unsent, and cannot start.
  const phone = crypto.randomUUID();
  w.clock += 30_000;
  w.write(e1.episode_id, { claim: phone, position: 300_000 });
  a.media.failPlay = true;
  await a.player.play(e1);
  assert.equal(a.player.state.position, 10_000);
  a.media.failPlay = false;
  await w.acknowledgeAll(); // P is in: the phone's claim is later
  await a.player.refresh();
  assert.equal(a.player.state.position, 300_000, "the record seen while P was pending was never taken as decided");
});

test("a reset made elsewhere while our start was unsent is adopted once the server has our start; if ours wins, the player stays", async () => {
  for (const variant of ["theirs", "theirs, after a reload", "ours"] as const) {
    const w = await new World().init();
    const e = w.episode(1, { queued: true });
    let a = await w.page("tab");
    await a.player.play(e); // P, unsent
    await w.listen(a, 10_000);
    await a.player.pause();
    await a.player.seek(120_000);
    const own = of(await w.facts(), "session.start")[0]!;
    // Another device resets the episode (claim c, later than P): the record shows c while P is unsent.
    const c = crypto.randomUUID();
    w.write(e.episode_id, { claim: c, position: 0 });
    await a.player.refresh();
    assert.equal(a.player.state.position, 120_000, variant);
    assert.equal(superseded(await w.facts()).length, 0, variant);
    if (variant === "theirs, after a reload") {
      a.player.dispose();
      a = await w.page("tab");
      assert.equal(a.player.state.position, 120_000, variant);
    }
    await w.acknowledgeAll(); // P reaches the server in a later unit
    if (variant === "ours") w.write(e.episode_id, { claim: own.op_id, position: 10_000 }); // P ordered last: the record is ours
    await a.player.refresh();
    if (variant === "ours") {
      assert.equal(a.player.state.position, 120_000, variant);
      assert.equal(superseded(await w.facts()).length, 0, variant);
      continue;
    }
    assert.equal(a.player.state.position, 0, variant);
    assert.equal(superseded(await w.facts()).length, 1, variant);
    w.clock += 1_000;
    await a.player.play();
    const start = of(await w.facts(), "session.start").at(-1)!;
    assert.deepEqual([p(start).start_position, p(start).observed_claim], [0, c], variant);
    wellFormed(await w.facts());
  }
});

test("a restore that shows an older record never moves a paused player, also after a reload; Play starts where it stood", async () => {
  const w = await new World().init();
  const first = await pausedAfterListening(w, "tab");
  const e = first.e;
  let a = first.a;
  const c1 = crypto.randomUUID();
  const c2 = crypto.randomUUID();
  w.clock += 60_000;
  w.write(e.episode_id, { claim: c1, position: 300_000 });
  const c1Played = w.clock;
  await a.player.refresh();
  w.clock += 60_000;
  w.write(e.episode_id, { claim: c2, position: 400_000 });
  await a.player.refresh();
  assert.equal(a.player.state.position, 400_000);
  await retire(w.db, w.account, w.head); // views showed everything the browser sent
  const seals = superseded(await w.facts()).length;
  // The server is restored from a backup in which c1 is the latest write: an older record.
  await w.restore();
  w.write(e.episode_id, { claim: c1, position: 300_000, lastPlayed: c1Played });
  await a.player.refresh();
  await a.player.refresh();
  assert.equal(a.player.state.position, 400_000);
  a.player.dispose();
  a = await w.page("tab");
  await a.player.refresh();
  assert.equal(a.player.state.position, 400_000, "the restored record was taken as the baseline, not adopted");
  assert.equal(superseded(await w.facts()).length, seals);
  w.clock += 1_000;
  await a.player.play();
  const start = of(await w.facts(), "session.start").at(-1)!;
  // From where it stood, rewound as Android does after more than a minute; observing the record it saw.
  assert.deepEqual([p(start).start_position, p(start).observed_claim], [400_000 - 3_000, c1]);
});

test("after a restore, a claim never seen moves the player only with listening newer than all it knew", async () => {
  const w = await new World().init();
  const { e, a } = await pausedAfterListening(w);
  w.clock += 60_000;
  w.write(e.episode_id, { claim: crypto.randomUUID(), position: 300_000 });
  const known = w.clock;
  await a.player.refresh();
  await retire(w.db, w.account, w.head);
  await w.restore();
  w.write(e.episode_id, { claim: crypto.randomUUID(), position: 100_000, lastPlayed: known - 1 });
  await a.player.refresh();
  assert.equal(a.player.state.position, 300_000, "older listening: a baseline only");
  await w.restore();
  const later = crypto.randomUUID();
  w.clock += 60_000;
  w.write(e.episode_id, { claim: later, position: 500_000 });
  await a.player.refresh();
  assert.equal(a.player.state.position, 500_000, "newer listening: adopted");
});

test("restores showing ever older listening never move the player: what it knew does not go down", async () => {
  const w = await new World().init();
  const { e, a } = await pausedAfterListening(w);
  const t0 = w.clock;
  w.write(e.episode_id, { claim: crypto.randomUUID(), position: 300_000, lastPlayed: t0 + 500_000 });
  await a.player.refresh();
  assert.equal(a.player.state.position, 300_000);
  await retire(w.db, w.account, w.head);
  await w.restore();
  w.write(e.episode_id, { claim: crypto.randomUUID(), position: 100_000, lastPlayed: t0 + 300_000 });
  await a.player.refresh();
  await w.restore();
  w.write(e.episode_id, { claim: crypto.randomUUID(), position: 200_000, lastPlayed: t0 + 400_000 });
  await a.player.refresh();
  assert.equal(a.player.state.position, 300_000);
  assert.equal((await getLease(w.db, w.account)).current?.listened, t0 + 500_000);
});

test("listening a restored server shows while our own claim is pending is adopted once that claim is in, also after a reload", async () => {
  for (const reload of [false, true]) {
    const w = await new World().init();
    const e = w.episode(1, { queued: true, position: 50_000, claim: crypto.randomUUID() });
    let a = await w.page("tab");
    await a.player.play(e); // P, unsent
    await w.listen(a, 10_000);
    await a.player.pause();
    // The server is restored; there another device played the episode to its end after this browser paused: its claim c, at 0.
    await w.restore();
    const c = crypto.randomUUID();
    w.clock += 60_000;
    w.write(e.episode_id, { claim: c, position: 0 });
    await a.player.refresh(); // P is pending: nothing is decided
    assert.equal(a.player.state.position, 60_000);
    if (reload) {
      a.player.dispose();
      a = await w.page("tab");
      assert.equal(a.player.state.position, 60_000);
    }
    await w.acknowledgeAll(); // P reaches the restored server; c, later, still owns the record
    await a.player.refresh();
    assert.equal(a.player.state.position, 0, `adopted${reload ? " after a reload" : ""}`);
    assert.equal(superseded(await w.facts()).length, 1);
    w.clock += 1_000;
    await a.player.play();
    const start = of(await w.facts(), "session.start").at(-1)!;
    assert.deepEqual([p(start).start_position, p(start).observed_claim], [0, c]);
    wellFormed(await w.facts());
  }
});

test("a late view of the lineage the profile left is never used", async () => {
  const w = await new World().init();
  const { e, a } = await pausedAfterListening(w);
  await retire(w.db, w.account, w.head);
  const left = w.head;
  await w.restore();
  const late = crypto.randomUUID();
  w.clock += 60_000;
  w.write(e.episode_id, { claim: late, position: 300_000 });
  const view = structuredClone(w.views.get(e.episode_id)!);
  const read = w.reads.episode;
  w.reads.episode = async () => ({ ...view, head: { ...left, seq: left.seq + 50 } }); // answered by the server before its restore
  await a.player.refresh();
  assert.equal(a.player.state.position, 20_000);
  assert.equal(superseded(await w.facts()).length, 0);
  w.reads.episode = read;
  await a.player.refresh(); // the same write, read from the restored server
  assert.equal(a.player.state.position, 300_000);
});

test("a restored epoch's view wins over the old epoch's, whatever their seq", async () => {
  const w = await new World().init();
  w.head = { ...w.head, seq: 1000 };
  const e = w.episode(1, { queued: true, position: 100_000, claim: crypto.randomUUID() });
  const phone = crypto.randomUUID();
  // The server is restored while the media prepares (no view of it shown yet), at a smaller seq; a device listened since.
  let a!: Awaited<ReturnType<World["page"]>>;
  a = await w.page("a", preparing(() => {
    void w.restore({ shown: false });
    w.head = { ...w.head, seq: 100 };
    w.write(e.episode_id, { claim: phone, position: 300_000 });
    void a.player.refresh(); // the event stream announces the change
  }));
  await a.player.play(e);
  const start = of(await w.facts(), "session.start")[0]!;
  assert.deepEqual([p(start).start_position, p(start).observed_claim], [300_000, phone]);
  assert.deepEqual((await lineages(w.db, w.account)).lineage, null);
});

test("a row saved before the record's version was kept: its first view moves the player only on newer listening, later writes always", async () => {
  for (const newer of [false, true]) {
    const w = await new World().init();
    const { e, a } = await pausedAfterListening(w, "tab");
    const paused = w.clock;
    const phone = crypto.randomUUID();
    w.write(e.episode_id, { claim: phone, position: 300_000, lastPlayed: paused - 5_000 }); // ordered after ours, listened before our pause
    await a.player.refresh();
    assert.equal(a.player.state.position, 300_000);
    await a.player.seek(120_000); // a seek made here while paused
    a.player.dispose();
    await updateLease(w.db, w.account, (l) => {
      delete l.current!.observed;
      delete l.current!.listened;
    });
    w.clock += 60_000;
    if (newer) w.write(e.episode_id, { claim: phone, position: 420_000 }); // the phone played on while the page was closed
    const b = await w.page("tab");
    await b.player.refresh();
    if (newer) {
      assert.equal(b.player.state.position, 420_000, "newer listening is adopted at once");
      continue;
    }
    assert.equal(b.player.state.position, 120_000, "no newer listening: the record becomes the baseline, and the seek stands");
    assert.equal(superseded(await w.facts()).length, 1);
    w.write(e.episode_id, { claim: phone, position: 420_000 });
    await b.player.refresh();
    assert.equal(b.player.state.position, 420_000, "then the claim moving on is followed");
    w.clock += 1_000;
    await b.player.play();
    const start = of(await w.facts(), "session.start").at(-1)!;
    assert.deepEqual([p(start).start_position, p(start).observed_claim], [420_000 - 800, phone]);
  }
});

test("another generation's record is not ordered against the old one: only newer listening moves the player", async () => {
  const w = await new World().init();
  const { e, a } = await pausedAfterListening(w);
  w.clock += 60_000;
  w.write(e.episode_id, { claim: crypto.randomUUID(), position: 300_000 });
  await a.player.refresh();
  // The podcast was subscribed again: a new generation, whose record an older listening wrote.
  const gen2 = "g1:" + "c".repeat(64);
  w.views.get(e.episode_id)!.episode.podcast.generation_id = gen2;
  const d = crypto.randomUUID();
  w.write(e.episode_id, { claim: d, position: 50_000, generation: gen2, lastPlayed: w.clock - 30_000 });
  await a.player.refresh();
  assert.equal(a.player.state.position, 300_000);
  w.clock += 60_000;
  w.write(e.episode_id, { claim: d, position: 80_000, generation: gen2 });
  await a.player.refresh();
  assert.equal(a.player.state.position, 80_000, "within the new generation, a new write is newer");
});

// ---- controls never wait for background reads

/** soon fails unless p settles within ms of real time: a control that waits behind a stalled read fails it. */
async function soon<T>(p: Promise<T>, what: string, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} waited for the read`)), ms)));
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** stall holds the next n episode reads (each answered with the server's state when it was asked) until released. */
function stall(w: World, n = 1) {
  const read = w.reads.episode;
  const entered = deferred<void>();
  const gate = deferred<void>();
  let calls = 0;
  let held = 0;
  w.reads.episode = async (id) => {
    calls++;
    if (held >= n) return read(id);
    held++;
    const answer = await read(id);
    entered.resolve();
    await gate.promise;
    return answer;
  };
  return { entered: entered.promise, release: () => gate.resolve(), calls: () => calls, restore: () => (w.reads.episode = read) };
}

test("Play, the seeks, Pause and a cut's export act at once while a refresh read is stalled", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const a = await w.page();
  await a.player.play(e);
  await w.listen(a, 10_000);
  await a.player.pause();
  const s = stall(w);
  const refreshing = a.player.refresh();
  await s.entered;
  await soon(a.player.play(), "Play");
  assert.equal(a.media.paused, false);
  await soon(a.player.seek(120_000), "Seek");
  assert.equal(a.media.position, 120_000);
  await soon(a.player.rewind(), "Rewind");
  assert.equal(a.media.position, 110_000);
  await soon(a.player.fastForward(), "Fast-forward");
  assert.equal(a.media.position, 140_000);
  w.clock += 5_000;
  a.media.advance(5_000);
  const deps = await soon(a.player.beforeCut(), "the export before Mark played");
  assert.ok(deps.includes(of(await w.facts(), "session.checkpoint").at(-1)!.op_id), "the cut depends on the fresh export");
  await soon(a.player.pause(), "Pause");
  assert.equal(a.media.paused, true);
  s.release();
  await refreshing;
  wellFormed(await w.facts());
});

test("Pause resolves at once when nothing plays, even behind a transition waiting on the network", async () => {
  const w = await new World().init();
  const e1 = w.episode(1, { queued: true });
  const e2 = w.episode(2, { queued: true });
  const a = await w.page();
  await a.player.play(e1);
  await a.player.pause();
  const s = stall(w);
  const switching = a.player.play(e2);
  await s.entered;
  await soon(a.player.pause(), "Pause with nothing playing");
  s.release();
  await switching;
  await a.player.idle();
  assert.equal(a.media.paused, true);
});

test("bursts of refreshes make one read in flight, then one more", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const a = await w.page();
  await a.player.play(e);
  await a.player.pause();
  const s = stall(w);
  const all = [a.player.refresh()];
  await s.entered;
  for (let i = 0; i < 5; i++) all.push(a.player.refresh());
  assert.equal(s.calls(), 1, "one read in flight");
  s.release();
  await Promise.all(all);
  assert.equal(s.calls(), 2, "then one more for the changes since");
});

test("a refresh read answered from an older head than the view the player holds is dropped", async () => {
  const w = await new World().init();
  const { e, a } = await pausedAfterListening(w);
  w.clock += 60_000;
  w.write(e.episode_id, { claim: crypto.randomUUID(), position: 200_000 });
  await a.player.refresh();
  w.write(e.episode_id, { claim: crypto.randomUUID(), position: 300_000 });
  const older = structuredClone({ ...w.views.get(e.episode_id)!, head: w.head });
  w.write(e.episode_id, { claim: crypto.randomUUID(), position: 100_000 });
  // A start reads the newest view and adopts it; the audio cannot start, so the player stays paused there.
  a.media.failPlay = true;
  await a.player.play();
  assert.equal(a.player.state.position, 100_000);
  a.media.failPlay = false;
  const read = w.reads.episode;
  w.reads.episode = async () => structuredClone(older); // answered late, from before the newest write
  await a.player.refresh();
  w.reads.episode = read;
  assert.equal(a.player.state.position, 100_000, "the older record never moves the player back");
});

test("a refresh read begun before a seek made while paused is not applied over it: the episode is read again", async () => {
  const w = await new World().init();
  const { e, a } = await pausedAfterListening(w);
  w.clock += 60_000;
  const phone = crypto.randomUUID();
  w.write(e.episode_id, { claim: phone, position: 300_000 });
  const s = stall(w, 2);
  const refreshing = a.player.refresh();
  await s.entered;
  await a.player.seek(120_000);
  s.release();
  // The first answer arrives after the seek: it is read again rather than applied over the seek.
  await until(() => s.calls() === 2, "the second read");
  assert.equal(a.player.state.position, 120_000, "the answer read before the seek did not move it");
  await refreshing;
  // The second read is decided as any: the phone's write is newer than what the player decided against.
  assert.equal(a.player.state.position, 300_000);
});

test("a refresh answer of the lineage the profile has left since its read began is discarded", async () => {
  const w = await new World().init();
  const { e, a } = await pausedAfterListening(w);
  await retire(w.db, w.account, w.head);
  w.clock += 60_000;
  w.write(e.episode_id, { claim: crypto.randomUUID(), position: 300_000 });
  const s = stall(w);
  const refreshing = a.player.refresh();
  await s.entered;
  await w.restore(); // a view of the restored server is shown meanwhile
  s.release();
  await refreshing;
  assert.equal(a.player.state.position, 20_000);
  assert.equal(superseded(await w.facts()).length, 0);
  await a.player.play(); // nothing newer is known: the paused session resumes where it was
  assert.ok(a.media.position <= 20_000 && a.media.position >= 17_000, `${a.media.position}`);
  await a.player.pause();
});

test("a refresh read that completes while a start prepares its media is used at READY, even when the start cannot read", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true, position: 100_000, claim: crypto.randomUUID() });
  const phone = crypto.randomUUID();
  let a!: Awaited<ReturnType<World["page"]>>;
  const media = new FakeMedia();
  const load = media.load.bind(media);
  media.load = async (url, position) => {
    await load(url, position);
    w.write(e.episode_id, { claim: phone, position: 300_000 });
    void a.player.refresh(); // its application waits behind this start
    await until(() => a.player.unappliedRead?.seq === w.head.seq, "the refresh answer"); // the answer is in
    w.offline = true; // the start's own read fails
  };
  a = await w.page("a", media);
  await a.player.play(e);
  w.offline = false;
  const start = of(await w.facts(), "session.start")[0]!;
  assert.deepEqual([p(start).start_position, p(start).observed_claim], [300_000, phone]);
  await a.player.idle();
  assert.equal(a.media.position, 300_000, "the late application never moves the playing audio");
});

test("a refresh read across a lost and regained lease is not applied over what happened since", async () => {
  const w = await new World().init();
  const { e, a } = await pausedAfterListening(w);
  w.clock += 60_000;
  w.write(e.episode_id, { claim: crypto.randomUUID(), position: 300_000 });
  const s = stall(w);
  const refreshing = a.player.refresh();
  await s.entered;
  // Another tab takes the player, plays from the phone's position and pauses; this tab takes it back.
  const b = await w.page();
  await b.player.moveHere();
  await a.player.leaseTick(); // this tab finds the player taken
  assert.equal(a.player.state.mode, "elsewhere");
  await w.listen(b, 5_000);
  await b.player.pause();
  await a.player.moveHere();
  await b.player.idle();
  const at = a.media.position;
  s.release();
  await refreshing;
  await a.player.idle();
  assert.equal(a.player.state.playing, true);
  assert.equal(a.media.position, at, "the old answer moved nothing");
  assert.ok(at >= 300_000 + 4_000, `it plays on from where the other tab paused (${at})`);
  await a.player.pause();
  wellFormed(await w.facts());
});

// ---- seeks chosen while paused, READY after the queue, fenced first reads, sessions read by episode

/** until waits for a condition, turn by turn, and fails if it never holds. */
async function until(check: () => boolean | Promise<boolean>, what = "the condition"): Promise<void> {
  for (let i = 0; i < 2_000; i++) {
    if (await check()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`${what} never held`);
}

test("a seek made while paused after another device's position was known is where Play starts, also after a reload", async () => {
  for (const variant of ["seek", "seek, then a reload", "no seek"] as const) {
    const w = await new World().init();
    const e = w.episode(1, { queued: true });
    let a = await w.page("tab");
    await a.player.play(e);
    await w.listen(a, 10_000);
    await w.acknowledgeAll();
    const phone = crypto.randomUUID();
    w.write(e.episode_id, { claim: phone, position: 300_000 });
    await a.player.refresh(); // known while playing: the audio is not moved
    await a.player.pause();
    if (variant !== "no seek") await a.player.seek(120_000); // chosen after the phone's position was known
    if (variant === "seek, then a reload") {
      a.player.dispose();
      a = await w.page("tab");
      assert.equal(a.player.state.position, 120_000, variant);
    }
    w.clock += 1_000;
    await a.player.play();
    if (variant === "no seek") {
      // Pause, then Play with nothing chosen since: the phone's newer position is where it starts.
      assert.equal(a.media.position, 300_000 - 800, variant);
      continue;
    }
    assert.ok(a.media.position <= 120_000 && a.media.position >= 117_000, `${variant}: ${a.media.position}`);
    await w.listen(a, 5_000);
    await a.player.pause();
    const facts = await w.facts();
    if (variant === "seek") {
      // Play claims the chosen position over the phone's, which it observed.
      const start = of(facts, "session.start").at(-1)!;
      assert.deepEqual([p(start).start_position, p(start).observed_claim], [120_000 - 800, phone], variant);
    }
    assert.ok(p(of(facts, "session.checkpoint").at(-1)!).position >= 120_000, variant);
    wellFormed(facts);
  }
});

test("a refresh answer that arrives while a start waits for the queue is used at READY", async () => {
  const w = await new World().init();
  w.episode(1, { queued: true });
  const e = w.episode(3, { position: 100_000, claim: crypto.randomUUID() }); // not queued: its play adds it
  const a = await w.page();
  const queue = w.reads.queue;
  const asked = deferred<void>();
  const gate = deferred<void>();
  w.reads.queue = async () => {
    asked.resolve();
    await gate.promise;
    return queue();
  };
  const playing = a.player.play(e);
  await asked.promise; // both episode reads are done; the queue is slow
  const phone = crypto.randomUUID();
  w.write(e.episode_id, { claim: phone, position: 300_000 });
  void a.player.refresh(); // its application waits behind the start
  await until(() => a.player.unappliedRead?.seq === w.head.seq, "the refresh answer");
  gate.resolve();
  await playing;
  const start = of(await w.facts(), "session.start")[0]!;
  assert.deepEqual([p(start).start_position, p(start).observed_claim], [300_000, phone]);
  assert.ok(p(start).queue_bundle, "it is still added to the queue");
  assert.ok(start.dependencies.includes(phone), "it depends on the record it observed");
});

test("an initial read answered before the server's restore never chooses where a new play starts", async () => {
  const w = await new World().init();
  await updateInstallation(w.db, w.account, (r) => (r.lineage = { log_id: w.head.log_id, epoch: w.head.epoch }));
  const e = w.episode(1, { queued: true, position: 100_000, claim: crypto.randomUUID() });
  w.views.get(e.episode_id)!.episode.last_played = w.clock - 1_000;
  const a = await w.page();
  const read = w.reads.episode;
  const asked = deferred<void>();
  const gate = deferred<void>();
  let first = true;
  w.reads.episode = async (id) => {
    if (!first) return read(id);
    first = false;
    const old = await read(id); // answered from before the restore
    asked.resolve();
    await gate.promise;
    return old;
  };
  const playing = a.player.play(e);
  await asked.promise;
  // The server is restored (epoch 2, accepted; epoch 1 retired): there the episode stands at 5:00 under another claim, listened a second earlier.
  await w.restore();
  const restored = crypto.randomUUID();
  w.write(e.episode_id, { claim: restored, position: 300_000, lastPlayed: w.clock - 2_000 });
  gate.resolve();
  await playing;
  const start = of(await w.facts(), "session.start")[0]!;
  assert.deepEqual([p(start).start_position, p(start).observed_claim], [300_000 - 800, restored]);
});

test("a start never falls back to a view of the lineage the profile left: it records nothing and says so", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true, position: 100_000, claim: crypto.randomUUID() });
  const a = await w.page();
  const left = w.head;
  await w.restore(); // epoch 2 is the profile's; every answer below is still epoch 1's
  w.reads.episode = async (id) => structuredClone({ ...w.views.get(id)!, head: left });
  await a.player.play(e);
  assert.equal(of(await w.facts(), "session.start").length, 0, "no claim built on a view the gate dropped");
  assert.deepEqual(a.notices, ["unreachable"]);
});

test("deciding on an episode's record reads that episode's sessions only, however long the profile's history", async () => {
  const w = await new World().init();
  const { e, a } = await pausedAfterListening(w);
  w.clock += 60_000;
  w.write(e.episode_id, { claim: crypto.randomUUID(), position: 300_000 });
  await a.player.refresh();
  let rows = 0;
  const count = (r: IDBRequest, n: (v: unknown) => number) => r.addEventListener("success", () => (rows += n(r.result)));
  const storeGetAll = IDBObjectStore.prototype.getAll;
  const storeGet = IDBObjectStore.prototype.get;
  const indexGetAll = IDBIndex.prototype.getAll;
  IDBObjectStore.prototype.getAll = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["getAll"]>) {
    const r = storeGetAll.apply(this, args);
    if (this.name === "sessions") count(r, (v) => (v as unknown[]).length);
    return r;
  };
  IDBObjectStore.prototype.get = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["get"]>) {
    const r = storeGet.apply(this, args);
    if (this.name === "sessions") count(r, (v) => (v ? 1 : 0));
    return r;
  };
  IDBIndex.prototype.getAll = function (this: IDBIndex, ...args: Parameters<IDBIndex["getAll"]>) {
    const r = indexGetAll.apply(this, args);
    if (this.objectStore.name === "sessions") count(r, (v) => (v as unknown[]).length);
    return r;
  };
  const measure = async (step: () => Promise<unknown>) => {
    rows = 0;
    await step();
    return rows;
  };
  let moves = 0;
  const steps = async () => [
    await measure(() => a.player.refresh()), // an unchanged record
    await measure(async () => {
      w.write(e.episode_id, { claim: crypto.randomUUID(), position: 200_000 + 1_000 * ++moves });
      await a.player.refresh(); // a changed one, adopted
    }),
  ];
  try {
    const before = await steps();
    // Years of listening to other episodes in this profile.
    const [template] = await sessionsOf(w.db, w.account);
    await inPlayer(w.db, async (t) => {
      for (let i = 0; i < 5_000; i++) {
        const other = `e1:${String(1_000 + i).padStart(64, "0")}`;
        await new Promise((r) => (t.objectStore("sessions").put({ ...template!, session_id: crypto.randomUUID(), episode: { ...template!.episode, episode_id: other }, sealed: "switched", closed: true }).onsuccess = r));
      }
    });
    const after = await steps();
    assert.deepEqual(after, before, "the same rows, with 5,000 unrelated sessions");
    w.clock += 1_000;
    const ready = await measure(() => a.player.play());
    assert.ok(ready <= 6, `READY reads this episode's sessions only (${ready} rows)`);
  } finally {
    IDBObjectStore.prototype.getAll = storeGetAll;
    IDBObjectStore.prototype.get = storeGet;
    IDBIndex.prototype.getAll = indexGetAll;
  }
});

test("a profile saved before the episode index keeps its sessions: the upgrade indexes them", async () => {
  // The database as the previous version left it: the sessions store without its episode index.
  const name = `player-upgrade-${++dbn}`;
  const account = crypto.randomUUID();
  const old: IDBDatabase = await new Promise((resolve, reject) => {
    const q = indexedDB.open(name, 2);
    q.onupgradeneeded = () => {
      const db = q.result;
      db.createObjectStore("installations", { keyPath: "account_id" });
      db.createObjectStore("authors", { keyPath: "author_id" }).createIndex("account", "account_id");
      db.createObjectStore("journal", { keyPath: ["account_id", "install_seq"] }).createIndex("op", ["account_id", "op_id"]);
      db.createObjectStore("sessions", { keyPath: ["account_id", "session_id"] });
      db.createObjectStore("leases", { keyPath: "account_id" });
      db.createObjectStore("retained", { keyPath: ["account_id", "install_id", "install_seq"] });
    };
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => reject(q.error);
  });
  const episode = (n: number) => ({ episode_id: `e1:${String(n).padStart(64, "0")}`, podcast_id: podcast, generation_id: gen, occurrence: {} });
  await new Promise<void>((resolve) => {
    const t = old.transaction("sessions", "readwrite");
    for (const n of [1, 1, 2]) t.objectStore("sessions").put({ account_id: account, session_id: crypto.randomUUID(), episode: episode(n) });
    t.oncomplete = () => resolve();
  });
  old.close();
  const db = await openDB(indexedDB, name);
  assert.equal((await sessionsOfEpisode(db, account, episode(1).episode_id)).length, 2);
  assert.equal((await sessionsOfEpisode(db, account, episode(2).episode_id)).length, 1);
  assert.equal((await sessionsOf(db, account)).length, 3, "nothing lost");
  db.close();
});

// ---- starting an episode: one read of it, the queue add's reads beside the media, READY's bounded wait

/** gated gives a page media whose load waits until released; loading resolves when a load begins. */
function gated() {
  const media = new FakeMedia();
  const load = media.load.bind(media);
  const loading = deferred<void>();
  const gate = deferred<void>();
  let held = true;
  media.load = async (url, position) => {
    if (held) {
      held = false;
      loading.resolve();
      await gate.promise;
    }
    await load(url, position);
  };
  return { media, loading: loading.promise, release: () => gate.resolve() };
}

/** logged records the reads a page's player asks for, in order, with the media's starts. */
function logged(w: World, media: FakeMedia): string[] {
  const log: string[] = [];
  const { episode, queue, summary } = w.reads;
  w.reads.episode = (id) => (log.push(`episode ${id.slice(-1)}`), episode(id));
  w.reads.queue = () => (log.push("queue"), queue());
  w.reads.summary = () => (log.push("summary"), summary());
  const play = media.play.bind(media);
  media.play = () => (log.push("play"), play());
  return log;
}

test("a new unqueued episode starts after one read of it, with the queue and summary read while its media prepares; a queued one reads neither", async () => {
  const w = await new World().init();
  w.episode(9, { queued: true });
  const e1 = w.episode(1);
  const e2 = w.episode(2, { queued: true });
  const g = gated();
  const a = await w.page("a", g.media);
  const log = logged(w, g.media);
  const playing = a.player.play(e1);
  await g.loading;
  await until(() => log.includes("queue") && log.includes("summary"), "the queue add's reads, while the media prepares");
  assert.deepEqual(log, ["episode 1", "queue", "summary"]);
  g.release();
  await playing;
  assert.deepEqual(log, ["episode 1", "queue", "summary", "play"], "no second read of the episode before it plays");
  const start = of(await w.facts(), "session.start")[0]!;
  assert.ok(p(start).queue_bundle, "playing it adds it to the queue");
  await a.player.idle();
  // A queued episode has no queue add: neither read is asked before it plays.
  log.length = 0;
  await a.player.play(e2);
  assert.deepEqual(log.slice(0, log.indexOf("play") + 1), ["episode 2", "play"]);
  assert.equal(of(await w.facts(), "session.start").length, 2);
});

test("a change announced while the media prepares is waited for at READY: an answer that comes within the bound is where Play starts", async () => {
  const w = await new World().init();
  const e = w.episode(1, { queued: true, position: 100_000, claim: crypto.randomUUID() });
  const phone = crypto.randomUUID();
  const g = gated();
  const a = await w.page("a", g.media, { readyWaitMs: 60_000 });
  const playing = a.player.play(e);
  await g.loading;
  w.write(e.episode_id, { claim: phone, position: 300_000 });
  const s = stall(w);
  void a.player.refresh(); // the event stream announces the phone's write; its read is slow
  await s.entered;
  g.release();
  await until(() => g.media.url !== null, "the media prepared");
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); // READY is waiting for the refresh's read
  assert.equal(of(await w.facts(), "session.start").length, 0, "READY waits for the announced change");
  s.release();
  await playing;
  const start = of(await w.facts(), "session.start")[0]!;
  assert.deepEqual([p(start).start_position, p(start).observed_claim], [300_000, phone]);
  assert.equal(s.calls(), 1, "READY waited for the refresh's own read, and asked none");
  await a.player.idle();
});

test("a stalled read of an announced change holds READY at most its bound: Play starts from the view it holds", async () => {
  const w = await new World().init();
  const held = crypto.randomUUID();
  const e = w.episode(1, { queued: true, position: 100_000, claim: held });
  let a!: Awaited<ReturnType<World["page"]>>;
  let s!: ReturnType<typeof stall>;
  a = await w.page("a", preparing(() => {
    w.write(e.episode_id, { claim: crypto.randomUUID(), position: 300_000 });
    s = stall(w, 2);
    void a.player.refresh();
  }), { readyWaitMs: 200 });
  const began = Date.now();
  await soon(a.player.play(e), "Play with the read stalled", 5_000);
  assert.ok(Date.now() - began >= 150, "READY waited for the read");
  const start = of(await w.facts(), "session.start")[0]!;
  assert.deepEqual([p(start).start_position, p(start).observed_claim], [100_000, held], "the view it held");
  assert.equal(a.media.paused, false);
  s.release();
  await a.player.idle();
  assert.equal(a.media.position, 100_000, "the late answer never moves the playing audio");
});

test("a read of an announced change that fails does not hold READY: Play starts from the view it holds", async () => {
  const w = await new World().init();
  const held = crypto.randomUUID();
  const e = w.episode(1, { queued: true, position: 100_000, claim: held });
  let a!: Awaited<ReturnType<World["page"]>>;
  a = await w.page("a", preparing(() => {
    w.offline = true; // the refresh's read and READY's own both fail
    void a.player.refresh();
  }), { readyWaitMs: 60_000 });
  await soon(a.player.play(e), "Play after the read failed", 5_000);
  w.offline = false;
  const start = of(await w.facts(), "session.start")[0]!;
  assert.deepEqual([p(start).start_position, p(start).observed_claim], [100_000, held]);
  await a.player.idle();
});

test("READY never takes or waits for a read of the episode played before: it reads the new one", async () => {
  const w = await new World().init();
  const e1 = w.episode(1, { queued: true });
  const e2 = w.episode(2, { queued: true, position: 100_000, claim: crypto.randomUUID() });
  const phone = crypto.randomUUID();
  const a = await w.page("a", new FakeMedia(), { readyWaitMs: 60_000 });
  await a.player.play(e1);
  await w.listen(a, 5_000);
  await a.player.pause();
  // Episode 2 is played. While its read is answered, a change is announced (the phone's write of
  // episode 2): the background refresh still reads episode 1, the current one, and that read stalls.
  const read = w.reads.episode;
  const switching = deferred<void>();
  const answered = deferred<void>();
  const stalled = deferred<void>();
  const gate = deferred<void>();
  w.reads.episode = async (id) => {
    const answer = await read(id);
    if (id === e2.episode_id) {
      w.reads.episode = async (id2) => {
        const later = await read(id2);
        if (id2 === e1.episode_id) {
          stalled.resolve();
          await gate.promise;
        }
        return later;
      };
      switching.resolve();
      await answered.promise;
    }
    return answer;
  };
  const playing = a.player.play(e2);
  await switching.promise;
  w.write(e2.episode_id, { claim: phone, position: 300_000 });
  const refreshing = a.player.refresh();
  await stalled.promise; // episode 1's read, asked after the announcement
  answered.resolve();
  await soon(playing, "Play while episode 1's read is stalled", 5_000);
  const start = of(await w.facts(), "session.start").at(-1)!;
  assert.equal(p(start).episode.episode_id, e2.episode_id);
  assert.deepEqual([p(start).start_position, p(start).observed_claim], [300_000, phone]);
  gate.resolve();
  await refreshing;
  await a.player.idle();
  assert.equal(a.player.state.episode?.episode_id, e2.episode_id);
  assert.ok(a.media.position >= 300_000, "episode 1's answer moved nothing");
  await a.player.pause();
  wellFormed(await w.facts());
});

test("a change READY could not wait for is still read after the start", async () => {
  const w = await new World().init();
  const e1 = w.episode(1, { queued: true });
  const held = crypto.randomUUID();
  const e2 = w.episode(2, { queued: true, position: 100_000, claim: held });
  const phone = crypto.randomUUID();
  const a = await w.page("a", new FakeMedia(), { readyWaitMs: 100 });
  await a.player.play(e1);
  await w.listen(a, 5_000);
  await a.player.pause();
  // Episode 2 is played. While its read is answered, the phone's write of it is announced, and the
  // background refresh reads episode 1, still the current one; READY's own read of episode 2 is slow.
  const read = w.reads.episode;
  const answered = deferred<void>();
  const switching = deferred<void>();
  const slow = deferred<void>();
  let reads2 = 0;
  w.reads.episode = async (id) => {
    const answer = await read(id);
    if (id === e2.episode_id && ++reads2 === 1) {
      switching.resolve();
      await answered.promise;
    } else if (id === e2.episode_id && reads2 === 2) await slow.promise;
    return answer;
  };
  const playing = a.player.play(e2);
  await switching.promise;
  w.write(e2.episode_id, { claim: phone, position: 300_000 });
  void a.player.refresh();
  await until(() => a.player.unappliedRead !== null, "the refresh's answer, of episode 1");
  answered.resolve();
  await soon(playing, "Play while READY's read is slow", 5_000);
  const start = of(await w.facts(), "session.start").at(-1)!;
  assert.deepEqual([p(start).start_position, p(start).observed_claim], [100_000, held], "it started from the view it held");
  await a.player.idle();
  // The answer READY could not wait for is not lost: the episode is read again once it plays (whose
  // answer sync never applies to the playing audio, but keeps for an intentional seek).
  assert.equal(reads2, 3, "the switch's read, READY's own, and one more after the start");
  assert.equal(a.media.position, 100_000);
  slow.resolve();
  await a.player.pause();
  wellFormed(await w.facts());
});

test("a background read of the episode that fails is tried again with backoff until the player shows the newest head", async () => {
  // The tab's heads and visibility, and the player following them (instance.ts), on the real engine.
  const saved = (globalThis as Record<string, unknown>).BroadcastChannel;
  (globalThis as Record<string, unknown>).BroadcastChannel = undefined;
  const { followHeads } = await import("../src/player/instance.ts");
  const { Value } = await import("../src/util/value.ts");
  (globalThis as Record<string, unknown>).BroadcastChannel = saved;
  const w = await new World().init();
  const e = w.episode(1, { queued: true });
  const a = await w.page();
  await a.player.play(e);
  await w.listen(a, 10_000);
  await a.player.pause();
  await w.acknowledgeAll();
  await a.player.refresh();
  assert.deepEqual(a.player.viewHead?.seq, w.head.seq);
  // Another device moves the position: the head moves on twice.
  w.write(e.episode_id, { claim: crypto.randomUUID(), position: 300_000, lastPlayed: w.clock - 10_000 });
  w.write(e.episode_id, { claim: crypto.randomUUID(), position: 400_000, lastPlayed: w.clock - 5_000 });
  // The first read of the episode fails (a dropped connection); later ones answer.
  let reads = 0;
  const episode = w.reads.episode;
  w.reads.episode = async (id: string) => {
    if (++reads === 1) throw new Error("unreachable");
    return episode(id);
  };
  const timers: { fn: () => void; ms: number }[] = [];
  const sync = { known: new Value<{ log_id: string; epoch: number; seq: number } | null>(null), revalidate: new Value(0), visible: new Value(true) };
  const off = followHeads(sync as never, a.player, { setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout: () => {} });
  sync.known.set({ log_id: w.head.log_id, epoch: w.head.epoch, seq: w.head.seq });
  for (let i = 0; i < 50 && !timers.length; i++) await new Promise((r) => setImmediate(r));
  await a.player.idle();
  assert.equal(reads, 1);
  assert.deepEqual(timers.map((t) => t.ms), [2000], "tried again after 2 s");
  timers[0]!.fn();
  for (let i = 0; i < 50 && a.player.viewHead?.seq !== w.head.seq; i++) await new Promise((r) => setImmediate(r));
  await a.player.idle();
  assert.equal(reads, 2);
  assert.equal(a.player.viewHead?.seq, w.head.seq, "the newest head");
  assert.equal(a.player.state.position, 400_000, "the paused player shows the other device's position");
  assert.equal(timers.length, 1, "no more tries once it succeeded");
  off();
  w.reads.episode = episode;
});
