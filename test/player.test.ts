// The player engine against IndexedDB (fake-indexeddb), a fake audio
// element, a fake read API and a fake clock: sessions, Android's accounting,
// exports, completion, passive loading, adoption, tabs, and recovery when a
// page is killed at each step (PROTOCOL §12).
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EpisodeRow, Summary } from "../src/api/views.ts";
import { openDB, type Fact } from "../src/journal/db.ts";
import { acknowledge, append, entries, installation, newAuthor, retire, updateInstallation } from "../src/journal/journal.ts";
import { between, keyString, uuidValue, type QueueKey } from "../src/queue/keys.ts";
import { Player, type Channel, type EpisodeView, type Media, type Message } from "../src/player/engine.ts";
import { exportPending, getLease, listeningFrontier, sessionsOf, updateLease } from "../src/player/store.ts";
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
  #l: { paused(): void; ended(): void; time(): void; error(): void } | undefined;
  listen(l: { paused(): void; ended(): void; time(): void; error(): void }) {
    this.#l = l;
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
    if (this.paused) return;
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

  async page(tab: string = crypto.randomUUID(), media = new FakeMedia()) {
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
    await acknowledge(
      this.db,
      this.account,
      all.filter((e) => !e.receipt).map((e) => ({
        install_seq: e.install_seq,
        receipt: { op_id: e.op_id, content_hash: "h", outcome: "applied", normalized_time: 0, epoch: 1, seq: this.head.seq, index: 0, key_id: "k", mac: "m" },
      })),
      { log_id: this.head.log_id, epoch: 1 },
    );
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
  await takeSuccessor(w.db, w.account, async () => {}, { freshNonce: false, device: { name: "test", app_version: "0", capabilities: [] } });
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
