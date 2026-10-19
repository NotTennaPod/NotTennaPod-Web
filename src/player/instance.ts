// The tab's player: the engine with the <audio> element, the read API, the
// profile's other tabs (BroadcastChannel) and the sync loop, which pushes
// what the player journals and tells it when views change.
import { useEffect, useState } from "preact/hooks";
import { t, w, type StringKey } from "../i18n.ts";
import { reads } from "../api/views.ts";
import { wholeQueue } from "../app/queueOps.ts";
import type { Sync } from "../app/sync.ts";
import { Rereader, type ReaderDeps } from "../app/heads.ts";
import { readSetting, writeSetting } from "../ui/settings.ts";
import { Player, type Channel, type Message, type PlayerState } from "./engine.ts";
import { AudioMedia, directFailures, mediaSession, type Descriptor, type MediaStatus, type Sources } from "./media.ts";
import { ApiError, get, post } from "../api/http.ts";
import { exportPending, listeningFrontier } from "./store.ts";
import { uuid } from "../util/random.ts";

const players = new WeakMap<Sync, Player>();
const medias = new WeakMap<Sync, AudioMedia>();

/** tabID names this browser tab across reloads (sessionStorage), so a reloaded tab knows its own lease. */
function tabID(): string {
  try {
    let id = sessionStorage.getItem("nottennapod-tab");
    if (!id) {
      id = uuid();
      sessionStorage.setItem("nottennapod-tab", id);
    }
    return id;
  } catch {
    return uuid();
  }
}

/** newTabID gives a duplicated tab its own ID (a duplicate copies sessionStorage). */
function newTabID(): string {
  const id = uuid();
  try {
    sessionStorage.setItem("nottennapod-tab", id);
  } catch {
    /* private mode: the ID lasts this page load */
  }
  return id;
}

// Every page answers for its tab ID, so a duplicated tab finds that its copied ID is in use.
const tabs = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("nottennapod-tabs");
const pageNonce = uuid();
let myTab: string | undefined;
tabs?.addEventListener("message", (e: MessageEvent) => {
  const m = e.data as { type: string; tab: string; from: string };
  if (m.type === "probe" && m.tab === myTab && m.from !== pageNonce) tabs.postMessage({ type: "taken", tab: m.tab, to: m.from });
});

function tabInUse(tab: string): Promise<boolean> {
  if (!tabs) return Promise.resolve(false);
  return new Promise((resolve) => {
    const h = (e: MessageEvent) => {
      const m = e.data as { type: string; tab: string; to: string };
      if (m.type === "taken" && m.tab === tab && m.to === pageNonce) done(true);
    };
    const done = (v: boolean) => {
      tabs.removeEventListener("message", h);
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => done(false), 250);
    tabs.addEventListener("message", h);
    tabs.postMessage({ type: "probe", tab, from: pageNonce });
  });
}

// Android's words for the relay's error labels (PROTOCOL §13).
const labels: Record<string, StringKey> = {
  unauthorized: "download_error_unauthorized",
  forbidden: "download_error_forbidden",
  not_found: "download_error_not_found",
  io: "download_error_connection_error",
  time_limit: "download_error_connection_error",
  refused_destination: "download_error_unknown_host",
  http_status: "download_error_http_data_error",
  too_many_redirects: "download_error_http_data_error",
  wrong_size: "download_error_wrong_size",
  playback: "playback_error_generic",
};

/** sources are the relay's calls (PROTOCOL §13). */
/** mediaTypes is the server's media types, asked once a page load (a failure is asked again). */
let mediaTypes: Promise<{ capabilities: string[]; profiles?: { name: string; mime: string }[] }> | null = null;
function types() {
  mediaTypes ??= get<{ capabilities: string[]; profiles?: { name: string; mime: string }[] }>("/v1/media/types").catch((e: unknown) => {
    mediaTypes = null;
    throw e;
  });
  return mediaTypes;
}

const sources: Sources = {
  capabilities: async () => (await types()).capabilities,
  profiles: async () => (await types()).profiles ?? [],
  describe: (episodeId, body) => post<Descriptor>(`/v1/media/${encodeURIComponent(episodeId)}/play`, body),
  status: async (url) => {
    try {
      return await get<MediaStatus>(`${url}/status`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  wording: (e) => (labels[e.label] ? t(labels[e.label]!) : e.message),
  // Any answer of the app's own server, even an error, means this device is connected.
  reachable: () => fetch("/healthz", { cache: "no-store", signal: AbortSignal.timeout(10_000) }).then(
    () => true,
    () => false,
  ),
};

function channel(account: string): Channel {
  if (typeof BroadcastChannel === "undefined") return { post() {}, listen: () => () => {} };
  const bc = new BroadcastChannel(`nottennapod-player:${account}`);
  return {
    post: (m: Message) => bc.postMessage(m),
    listen(fn) {
      const h = (e: MessageEvent) => fn(e.data as Message);
      bc.addEventListener("message", h);
      return () => bc.removeEventListener("message", h);
    },
  };
}

/** storage is the browser's localStorage, or null where it is refused (some private modes). */
function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** startPlayer creates the tab's player and loads the current episode paused (PROTOCOL §12). */
export function startPlayer(sync: Sync): Player {
  const existing = players.get(sync);
  if (existing) return existing;
  const media = new AudioMedia(Number(readSetting("playback_speed", "1")) || 1, sources, { failures: directFailures(storage(), sync.account) });
  media.prepare(); // the media types, before the first play needs them
  media.el.volume = volumeSetting();
  medias.set(sync, media);
  const player = new Player({
    db: sync.session.db,
    account: sync.account,
    page: sync.session.author.author_id,
    tab: (myTab = tabID()),
    tabInUse,
    newTab: () => (myTab = newTabID()),
    media,
    // The queue the player places a play's queue add in counts this tab's own earlier changes.
    reads: { episode: (id) => reads.episode(id), queue: async () => (await sync.pushed(), wholeQueue()), summary: () => reads.summary() },
    channel: channel(sync.account),
    appended: (n) => sync.journaled(n),
    notify: (text) => sync.notify(text),
    needsRelay: w("needs_relay"),
    unreachable: w("server_unreachable"),
    lastInQueue: w("no_following_in_queue"),
    storageFailed: w("storage_failed"),
    relay: true, // every episode with media plays: directly, relayed or converted, as the server decides
  });
  players.set(sync, player);
  const session = mediaSession({
    play: () => void player.play(),
    pause: () => void player.pause(),
    rewind: () => void player.rewind(),
    fastForward: () => void player.fastForward(),
    skip: () => void player.skip(),
    seek: (ms) => void player.seek(ms),
  });
  let lastPosition = 0;
  player.subscribe(() => {
    const s = player.state;
    session.show(s.mode === "here" ? s.episode : null, s.playing);
    if (s.mode === "here" && Math.abs(s.position - lastPosition) >= 1000) {
      lastPosition = s.position;
      session.position(s.position, s.duration, s.rate);
    }
  });
  followHeads(sync, player);
  // The speed is a profile setting: another tab's change applies here too.
  window.addEventListener("storage", (e) => {
    if (e.key === `nottennapod:${sync.account}:playback_speed` && e.newValue) player.setRate(Number(e.newValue) || 1);
  });
  window.addEventListener("pagehide", (e) => player.pageHidden(e.persisted));
  // Hidden (switched away from, or about to close): the playing position is journaled, and the push
  // the page sends if it then goes away is prepared from the journal, while the page can still do both.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void player.hidden().then(() => sync.prepare());
  });
  void player.boot();
  return player;
}

/**
 * followHeads re-reads the current episode once per newer head the tab learns
 * (only when newer than the view the player holds) and on every revalidation;
 * a read that fails is tried again with the views' backoff (2, 4 … 60 s) until
 * one succeeds; a hidden tab's player reads only while it plays, and once when
 * the tab shows again if it skipped one. The player's controls never wait for
 * these reads (they run beside its chain).
 */
export function followHeads(
  sync: Pick<Sync, "known" | "revalidate" | "visible">,
  player: Pick<Player, "refresh" | "state" | "viewHead"> & { readonly refreshFailed?: boolean; subscribe?: Player["subscribe"] },
  timers: Pick<ReaderDeps, "setTimeout" | "clearTimeout"> = {},
): () => void {
  const reader = new Rereader({
    known: () => sync.known.get(),
    shown: () => player.viewHead,
    visible: () => sync.visible.get() || player.state.playing,
    read: async () => {
      await player.refresh();
      if (player.refreshFailed) throw new Error("player: the episode could not be read");
      return player.viewHead;
    },
    failed: () => true,
    ...timers,
  });
  const offs = [
    sync.known.subscribe(() => reader.known()),
    sync.revalidate.subscribe(() => reader.revalidate()),
    sync.visible.subscribe(() => reader.visible()),
    ...(player.subscribe ? [player.subscribe(() => reader.visible())] : []),
  ];
  return () => {
    reader.stop();
    offs.forEach((off) => off());
  };
}

/**
 * leavePlayer pauses this tab's playback and waits for its last save (at most
 * 3 s) before an account transition: a logout, another tab's sign-in or
 * sign-out, or a refused session.
 */
export async function leavePlayer(sync: Sync | undefined): Promise<void> {
  const player = sync && players.get(sync);
  if (!player) return;
  await Promise.race([player.leave().catch(() => {}), new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
}

export function stopPlayer(sync: Sync): void {
  players.get(sync)?.dispose();
  players.delete(sync);
  medias.delete(sync);
}

const volumeStep = 0.1;

function volumeSetting(): number {
  const v = Number(readSetting("volume", "1"));
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

/**
 * changeVolume is the volume keys (Android's MainActivity: +/W, -/S, M): a
 * step up or down, or mute on and off, kept in this browser. It answers the
 * volume in percent, 0 when muted, or null without a player.
 */
export function changeVolume(sync: Sync, change: "up" | "down" | "mute"): number | null {
  const el = medias.get(sync)?.el;
  if (!el) return null;
  if (change === "mute") el.muted = !el.muted;
  else {
    el.muted = false;
    el.volume = Math.round(Math.min(1, Math.max(0, el.volume + (change === "up" ? volumeStep : -volumeStep))) * 10) / 10;
    writeSetting("volume", String(el.volume));
  }
  return el.muted ? 0 : Math.round(el.volume * 100);
}

export function playerOf(sync: Sync): Player | undefined {
  return players.get(sync);
}

/**
 * exportBeforeCut exports every unexported save of the account and returns
 * the listening facts a history removal, history clear or statistics reset
 * must depend on (PROTOCOL §12). Call it before fetching the frontier.
 */
export async function exportBeforeCut(sync: Sync): Promise<string[]> {
  const player = players.get(sync);
  if (player) return player.beforeCut();
  const made = await exportPending(sync.session.db, sync.account, sync.session.author.author_id, Date.now());
  if (made.length) sync.journaled(made.length);
  return [...new Set([...made, ...(await listeningFrontier(sync.session.db, sync.account))])];
}

/** usePlayer follows the tab's player state. */
export function usePlayer(sync: Sync): [Player | undefined, PlayerState | undefined] {
  const player = players.get(sync);
  const [state, setState] = useState(player?.state);
  useEffect(() => {
    if (!player) return;
    setState(player.state);
    return player.subscribe(() => setState(player.state));
  }, [player]);
  return [player, state];
}

/** playLabel is the episode menu's playback action as Android names it: Pause while it plays here, else Stream. */
export function playLabel(sync: Sync, episodeId: string): "pause_label" | "stream_label" {
  const s = players.get(sync)?.state;
  return s && s.mode === "here" && s.playing && s.episode?.episode_id === episodeId ? "pause_label" : "stream_label";
}

