// The web actor (PROTOCOL §16): one Chromium, one browser
// context per profile (each profile is one installation of the web client),
// driven through the app's real UI. It reads one JSON request per line on
// stdin and answers each with one JSON line on stdout. docs/ACTOR-PROTOCOL.md is its
// interface; PROTOCOL_VERSION changes whenever that interface does.
//
//   node e2e/acceptance/actor.ts [--headed]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { chromium, errors, type Browser, type BrowserContext, type Page, type Request, type Route } from "@playwright/test";
import * as ui from "./ui.ts";
import { ActorError, Deadline, matches, pathMatcher, until, within } from "./support.ts";

export const PROTOCOL_VERSION = 1;

// stdout carries the protocol and nothing else.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

// ---- profiles

interface Hold {
  id: string;
  path: string;
  method?: string;
  factType?: string;
  caught?: { route: Route; request: Request; facts: { op_id: string; type: string }[] };
  state: "waiting" | "held" | "continued" | "aborted" | "answer_dropped" | "gone" | "cancelled";
  arrived: Promise<void>;
  arrive: () => void;
  unroute: () => Promise<void>;
}

interface Profile {
  name: string;
  base: string;
  context: BrowserContext;
  page: Page | null;
  tab: "open" | "closed" | "crashed";
  holds: Map<string, Hold>;
  nextHold: number;
  net: ui.Net;
  /** queue runs the profile's commands one at a time, in arrival order. */
  queue: Promise<unknown>;
}

const profiles = new Map<string, Profile>();
const opening = new Set<string>();
const headed = process.argv.includes("--headed");
const browser: Promise<Browser> = chromium.launch({ headless: !headed, args: ["--mute-audio"] });
browser.catch(() => {}); // reported by hello

/** factsOf lists the facts a push request carries (their IDs and types; never payloads or secrets). */
function factsOf(request: Request): { op_id: string; type: string }[] {
  try {
    const body = request.postDataJSON() as { operations?: { fact?: { op_id?: unknown; type?: unknown } }[] } | null;
    return (body?.operations ?? []).flatMap((o) => (typeof o.fact?.op_id === "string" ? [{ op_id: o.fact.op_id, type: String(o.fact.type ?? "") }] : []));
  } catch {
    return [];
  }
}

/** subscribedOf lists a push's podcast.subscribe facts with the feed address each submitted. */
function subscribedOf(request: Request): [string, string][] {
  try {
    const body = request.postDataJSON() as { operations?: { fact?: { op_id?: unknown; type?: unknown; payload?: { feed_url?: unknown } } }[] } | null;
    return (body?.operations ?? []).flatMap((o) =>
      o.fact?.type === "podcast.subscribe" && typeof o.fact.op_id === "string" && typeof o.fact.payload?.feed_url === "string" ? [[o.fact.op_id, o.fact.payload.feed_url] as [string, string]] : [],
    );
  } catch {
    return [];
  }
}

const isPush = (r: Request) => r.method() === "POST" && new URL(r.url()).pathname === "/v1/push";

function watchPage(p: Profile, page: Page): void {
  page.on("close", () => {
    if (p.page === page && p.tab === "open") p.tab = "closed";
  });
  page.on("crash", () => {
    if (p.page === page) p.tab = "crashed";
  });
}

async function newTab(p: Profile, path: string, d: Deadline): Promise<{ state: ui.AppState }> {
  const page = await p.context.newPage();
  p.page = page;
  p.tab = "open";
  watchPage(p, page);
  await page.goto(p.base + path, { timeout: d.left() });
  return { state: await ui.appState({ page, base: p.base, d, net: p.net }) };
}

// ---- commands

interface Ctx {
  args: Record<string, unknown>;
  d: Deadline;
  name?: string;
  profile?: Profile;
  tab?: ui.Tab;
}

interface Command {
  /** What the command needs: nothing, an open profile, or a profile with an open tab. */
  needs: "nothing" | "profile" | "tab";
  /** An immediate command runs at once, beside the profile's queued command (faults and their releases). */
  immediate?: boolean;
  timeout: number;
  run: (c: Ctx) => Promise<unknown>;
}

const str = (c: Ctx, k: string): string => {
  const v = c.args[k];
  if (typeof v !== "string" || v === "") throw new ActorError("bad_request", `\`${k}\` must be a non-empty string.`);
  return v;
};
const optStr = (c: Ctx, k: string): string | undefined => (c.args[k] === undefined ? undefined : str(c, k));
const bool = (c: Ctx, k: string, dflt: boolean): boolean => {
  const v = c.args[k];
  if (v === undefined) return dflt;
  if (typeof v !== "boolean") throw new ActorError("bad_request", `\`${k}\` must be true or false.`);
  return v;
};
function oneOf<T extends string>(c: Ctx, k: string, allowed: readonly T[], dflt: T): T {
  const v = c.args[k] ?? dflt;
  if (!allowed.includes(v as T)) throw new ActorError("bad_request", `\`${k}\` must be one of ${allowed.join(", ")}.`);
  return v as T;
}
const wait = (c: Ctx) => oneOf(c, "wait", ["settled", "journaled"] as const, "settled");
const tab = (c: Ctx) => c.tab!;
const profile = (c: Ctx) => c.profile!;

/** reading makes a reading: with `expect`, it reads again until the reading matches (or the time runs out). */
function reading(timeout: number, read: (c: Ctx) => Promise<unknown>): Command {
  return {
    needs: "tab",
    timeout,
    run: async (c) => {
      if (bool(c, "reload", false)) {
        await tab(c).page.reload({ timeout: c.d.left() });
        await ui.appState(tab(c));
      }
      if (c.args.expect === undefined) return read(c);
      const waitingFor = "the reading to match `expect`";
      let last: unknown;
      try {
        return await until(
          c.d,
          waitingFor,
          async () => {
            last = await read(c);
            return matches(last, c.args.expect) ? last : undefined;
          },
          () => ({ last }),
        );
      } catch (e) {
        // The deadline may fall inside a reading: the failure is still the expectation's, with the last reading.
        const late = e instanceof errors.TimeoutError || (e instanceof ActorError && e.code === "timeout");
        if (late && last !== undefined) throw new ActorError("timeout", `Timed out after ${c.d.ms} ms waiting for ${waitingFor}.`, { waiting_for: waitingFor, last });
        throw e;
      }
    },
  };
}

let appVersion = "unknown";
let playwrightVersion = "unknown";
try {
  appVersion = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
  const require = createRequire(import.meta.url);
  playwrightVersion = (JSON.parse(readFileSync(join(dirname(require.resolve("@playwright/test")), "package.json"), "utf8")) as { version: string }).version;
} catch {
  /* reported as unknown */
}

const commands: Record<string, Command> = {
  // ---- the actor
  hello: {
    needs: "nothing",
    immediate: true,
    timeout: 60_000,
    run: async (c) => {
      const b = await browser.catch((e: unknown) => {
        throw new ActorError("browser_failed", `Chromium did not start: ${e instanceof Error ? e.message : String(e)}`);
      });
      const theirs = c.args.protocol;
      if (theirs !== undefined && theirs !== PROTOCOL_VERSION) {
        throw new ActorError("protocol_mismatch", `This actor speaks protocol ${PROTOCOL_VERSION}, not ${String(theirs)}.`, { protocol: PROTOCOL_VERSION });
      }
      return {
        protocol: PROTOCOL_VERSION,
        actor: "nottennapod-web-actor",
        app_version: appVersion,
        playwright: playwrightVersion,
        browser: `chromium ${b.version()}`,
        commands: Object.keys(commands).sort(),
      };
    },
  },
  profiles: {
    needs: "nothing",
    immediate: true,
    timeout: 5_000,
    run: async () => ({ profiles: [...profiles.values()].map((p) => ({ profile: p.name, base_url: p.base, tab: p.tab, holds: [...p.holds.values()].map((h) => ({ hold: h.id, path: h.path, state: h.state })) })) }),
  },
  shutdown: {
    needs: "nothing",
    immediate: true,
    timeout: 30_000,
    run: async () => {
      setImmediate(() => void shutdown(0));
      return { shutting_down: true };
    },
  },

  // ---- profiles and tabs
  open: {
    needs: "nothing",
    timeout: 60_000,
    run: async (c) => {
      const name = c.name;
      if (!name) throw new ActorError("bad_request", "`profile` names the profile to open.");
      if (profiles.has(name) || opening.has(name)) throw new ActorError("profile_exists", `Profile ${name} is open.`);
      const base = str(c, "base_url").replace(/\/+$/, "");
      const size = c.args.viewport as { width?: unknown; height?: unknown } | undefined;
      const viewport = size ? { width: Number(size.width), height: Number(size.height) } : { width: 1280, height: 800 };
      if (!(viewport.width >= 240 && viewport.height >= 240)) throw new ActorError("bad_request", "`viewport` is {width, height} in pixels.");
      opening.add(name);
      try {
        const context = await (await browser).newContext({ viewport, locale: "en-US", ignoreHTTPSErrors: true });
        context.setDefaultTimeout(15_000);
        const p: Profile = { name, base, context, page: null, tab: "closed", holds: new Map(), nextHold: 1, net: { pushed: [], receipts: new Map(), subscribed: new Map(), descriptors: new Map(), stream: null }, queue: Promise.resolve() };
        context.on("request", (r) => {
          const path = new URL(r.url()).pathname;
          if (path.startsWith("/v1/media/s/") && !path.endsWith("/status") && r.resourceType() === "fetch") p.net.stream = new URL(r.url()).pathname + new URL(r.url()).search;
          if (!isPush(r)) return;
          p.net.pushed.push(...factsOf(r));
          for (const [op, url] of subscribedOf(r)) p.net.subscribed.set(op, url);
        });
        context.on("response", (res) => {
          const req = res.request();
          if (req.method() === "POST" && /^\/v1\/media\/[^/]+\/play$/.test(new URL(req.url()).pathname)) {
            // The server's descriptor of an episode's source: where a converted stream starts.
            res.json().then(
              (d: { mode?: string; url?: string | null; offset_ms?: number }) => {
                if (d.url && d.mode) p.net.descriptors.set(new URL(d.url, base).pathname, { mode: d.mode, offset_ms: d.offset_ms ?? 0 });
              },
              () => {},
            );
            return;
          }
          if (!isPush(req)) return;
          res.json().then(
            (body: { results?: { receipt?: { op_id?: string; outcome?: string; reason?: string } }[] }) => {
              for (const r of body.results ?? []) {
                if (r.receipt?.op_id && r.receipt.outcome) p.net.receipts.set(r.receipt.op_id, { outcome: r.receipt.outcome, ...(r.receipt.reason ? { reason: r.receipt.reason } : {}) });
              }
            },
            () => {},
          );
        });
        profiles.set(name, p);
        return { profile: name, ...(await newTab(p, "/", c.d)) };
      } finally {
        opening.delete(name);
      }
    },
  },
  open_tab: {
    needs: "profile",
    timeout: 60_000,
    run: async (c) => {
      const p = profile(c);
      if (p.tab === "open") throw new ActorError("tab_open", `Profile ${p.name} has an open tab.`);
      await p.page?.close().catch(() => {});
      return newTab(p, optStr(c, "path") ?? "/", c.d);
    },
  },
  reload: {
    needs: "tab",
    timeout: 60_000,
    run: async (c) => {
      await tab(c).page.reload({ timeout: c.d.left() });
      return { state: await ui.appState(tab(c)) };
    },
  },
  close_tab: {
    needs: "tab",
    immediate: true,
    timeout: 15_000,
    run: async (c) => {
      const p = profile(c);
      p.tab = "closed";
      await p.page!.close();
      return { tab: "closed" };
    },
  },
  crash: {
    needs: "tab",
    immediate: true,
    timeout: 15_000,
    run: async (c) => {
      const p = profile(c);
      const page = p.page!;
      const crashed = new Promise<void>((r) => page.once("crash", () => r()));
      const cdp = await p.context.newCDPSession(page);
      void cdp.send("Page.crash").catch(() => {}); // the renderer dies before it answers
      await within(c.d, "the renderer to crash", crashed);
      p.tab = "crashed";
      return { tab: "crashed" };
    },
  },
  delete_profile: {
    needs: "profile",
    immediate: true,
    timeout: 30_000,
    run: async (c) => {
      const p = profile(c);
      profiles.delete(p.name);
      await p.context.close();
      return { deleted: p.name };
    },
  },
  save_profile: {
    needs: "profile",
    timeout: 30_000,
    run: async (c) => {
      const path = str(c, "path");
      await profile(c).context.storageState({ path, indexedDB: true });
      return { path };
    },
  },

  // ---- faults: holding a request
  hold: {
    needs: "profile",
    timeout: 15_000,
    run: async (c) => {
      const p = profile(c);
      const path = str(c, "path");
      const match = pathMatcher(path);
      const method = optStr(c, "method")?.toUpperCase();
      const factType = optStr(c, "fact_type");
      let arrive = () => {};
      const arrived = new Promise<void>((r) => (arrive = r));
      const h: Hold = { id: `h${p.nextHold++}`, path, method, factType, state: "waiting", arrived, arrive, unroute: async () => {} };
      const url = (u: URL) => match(u.pathname);
      const handler = async (route: Route, request: Request) => {
        if (h.caught || (method && request.method() !== method) || (factType && !(isPush(request) && factsOf(request).some((f) => f.type === factType)))) {
          await route.fallback();
          return;
        }
        h.caught = { route, request, facts: isPush(request) ? factsOf(request) : [] };
        h.state = "held";
        h.arrive();
      };
      await p.context.route(url, handler);
      h.unroute = () => p.context.unroute(url, handler).catch(() => {});
      p.holds.set(h.id, h);
      return { hold: h.id };
    },
  },
  held: {
    needs: "profile",
    immediate: true,
    timeout: 30_000,
    run: async (c) => {
      const h = holdOf(c);
      await within(c.d, `a request matching ${h.path}`, h.arrived);
      const u = new URL(h.caught!.request.url());
      return { hold: h.id, method: h.caught!.request.method(), path: u.pathname, query: u.search, facts: h.caught!.facts };
    },
  },
  release: {
    needs: "profile",
    immediate: true,
    timeout: 60_000,
    run: async (c) => {
      const p = profile(c);
      const h = holdOf(c);
      const mode = oneOf(c, "mode", ["continue", "abort", "drop_answer"] as const, "continue");
      p.holds.delete(h.id);
      if (!h.caught) {
        await h.unroute();
        h.state = "cancelled";
        return { hold: h.id, state: h.state };
      }
      const route = h.caught.route;
      let status: number | undefined;
      let gone: string | undefined;
      try {
        if (mode === "continue") {
          await route.continue();
          h.state = "continued";
        } else if (mode === "abort") {
          await route.abort("failed");
          h.state = "aborted";
        } else {
          // The request reaches the server; its answer never reaches the page.
          status = (await route.fetch({ timeout: c.d.left() })).status();
          await route.abort("connectionreset");
          h.state = "answer_dropped";
        }
      } catch (e) {
        h.state = "gone"; // the tab went away with the request
        gone = firstLines(e instanceof Error ? e.message : String(e));
      } finally {
        await h.unroute();
      }
      return { hold: h.id, state: h.state, ...(status !== undefined ? { server_status: status } : {}), ...(gone ? { detail: gone } : {}) };
    },
  },

  // ---- actions
  set_up: {
    needs: "tab",
    timeout: 30_000,
    run: async (c) => ui.setUp(tab(c), { setup_code: str(c, "setup_code"), username: str(c, "username"), password: str(c, "password") }),
  },
  log_in: {
    needs: "tab",
    timeout: 30_000,
    run: async (c) => ui.logIn(tab(c), { username: str(c, "username"), password: str(c, "password") }),
  },
  subscribe: {
    needs: "tab",
    timeout: 90_000,
    run: async (c) =>
      ui.subscribe(tab(c), {
        feed_url: str(c, "feed_url"),
        username: optStr(c, "username"),
        password: optStr(c, "password"),
        wait: oneOf(c, "wait", ["shown", "settled", "journaled"] as const, "shown"),
      }),
  },
  set_feed_login: {
    needs: "tab",
    timeout: 60_000,
    run: async (c) => {
      const password = c.args.password ?? "";
      if (typeof c.args.username !== "string" || typeof password !== "string") throw new ActorError("bad_request", "`username` and `password` are strings.");
      return ui.setFeedLogin(tab(c), await ui.podcastRef(tab(c), c.args), { username: c.args.username, password, wait: wait(c) });
    },
  },
  favorite: {
    needs: "tab",
    timeout: 30_000,
    run: async (c) => ui.favorite(tab(c), await ui.episodeRef(tab(c), c.args), bool(c, "on", true), wait(c)),
  },
  mark_played: {
    needs: "tab",
    timeout: 30_000,
    run: async (c) => ui.markPlayed(tab(c), await ui.episodeRef(tab(c), c.args), bool(c, "played", true), wait(c)),
  },
  queue_add: {
    needs: "tab",
    timeout: 30_000,
    run: async (c) => ui.queueAdd(tab(c), await ui.episodeRef(tab(c), c.args), wait(c)),
  },
  queue_move: {
    needs: "tab",
    timeout: 30_000,
    run: async (c) => ui.queueMove(tab(c), await ui.episodeRef(tab(c), c.args), oneOf(c, "to", ["top", "bottom"] as const, "top"), wait(c)),
  },
  queue_remove: {
    needs: "tab",
    timeout: 30_000,
    run: async (c) => ui.queueRemove(tab(c), await ui.episodeRef(tab(c), c.args), wait(c)),
  },
  queue_clear: {
    needs: "tab",
    timeout: 30_000,
    run: async (c) => ui.queueClear(tab(c), wait(c)),
  },
  inbox_remove: {
    needs: "tab",
    timeout: 30_000,
    run: async (c) => ui.inboxRemove(tab(c), bool(c, "all", false) ? null : await ui.episodeRef(tab(c), c.args), wait(c)),
  },
  unsubscribe: {
    needs: "tab",
    timeout: 30_000,
    run: async (c) => ui.unsubscribe(tab(c), await ui.podcastRef(tab(c), c.args), wait(c)),
  },
  clear_history: {
    needs: "tab",
    timeout: 30_000,
    run: async (c) => ui.clearHistory(tab(c), wait(c)),
  },
  reset_statistics: {
    needs: "tab",
    timeout: 30_000,
    run: async (c) => ui.resetStatistics(tab(c), wait(c)),
  },
  play: {
    needs: "tab",
    timeout: 60_000,
    run: async (c) => {
      const r = await ui.play(tab(c), await ui.episodeRef(tab(c), c.args));
      if (bool(c, "require_relay", false) && r.source !== "relay" && r.source !== "converted") {
        throw new ActorError("not_relayed", `The episode plays ${r.source}, not through the server.`, { player: r });
      }
      return r;
    },
  },
  pause: { needs: "tab", timeout: 30_000, run: async (c) => ui.pause(tab(c)) },
  seek: {
    needs: "tab",
    timeout: 30_000,
    run: async (c) => {
      const ms = c.args.position_ms;
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) throw new ActorError("bad_request", "`position_ms` is a position in milliseconds.");
      return ui.seek(tab(c), ms);
    },
  },
  import: {
    needs: "tab",
    timeout: 180_000,
    run: async (c) => {
      const file = str(c, "file");
      const kind = oneOf(c, "kind", ["android_db", "opml"] as const, /\.(opml|xml)$/i.test(file) ? "opml" : "android_db");
      return ui.importFile(tab(c), { file, kind, wait: oneOf(c, "wait", ["result", "started"] as const, "result") });
    },
  },
  import_result: { needs: "tab", timeout: 180_000, run: async (c) => ui.importResult(tab(c)) },
  settle: { needs: "tab", timeout: 30_000, run: async (c) => ui.settle(tab(c)) },

  // ---- readings
  episode: reading(15_000, async (c) => ui.readEpisode(tab(c), await ui.episodeRef(tab(c), c.args))),
  queue: reading(15_000, async (c) => ui.readList(tab(c), "queue")),
  inbox: reading(15_000, async (c) => ui.readList(tab(c), "inbox")),
  favorites: reading(15_000, async (c) => ui.readList(tab(c), "favorites")),
  history: reading(15_000, async (c) => ui.readList(tab(c), "history")),
  subscriptions: reading(15_000, async (c) => ui.readSubscriptions(tab(c))),
  podcast: reading(15_000, async (c) => ui.readPodcast(tab(c), await ui.podcastRef(tab(c), c.args))),
  statistics: reading(15_000, async (c) => ui.readStatistics(tab(c))),
  notice: reading(15_000, async (c) => ui.readNotice(tab(c).page)),
  player: reading(15_000, async (c) => ui.readPlayer(tab(c))),
  diagnostics: reading(15_000, async (c) => ui.readDiagnostics(tab(c), { account: optStr(c, "account"), fact: optStr(c, "fact") })),
};

function holdOf(c: Ctx): Hold {
  const id = str(c, "hold");
  const h = profile(c).holds.get(id);
  if (!h) throw new ActorError("not_found", `Profile ${profile(c).name} has no hold ${id}.`);
  return h;
}

// ---- the protocol loop

interface Message {
  id: string | number | null;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; [k: string]: unknown };
}

function reply(m: Message): void {
  process.stdout.write(`${JSON.stringify(m)}\n`);
}

const firstLines = (s: string) => s.split("\n").slice(0, 2).join(" ").trim();

async function failure(e: unknown, p: Profile | undefined): Promise<Message["error"]> {
  let out: NonNullable<Message["error"]>;
  if (e instanceof ActorError) out = { code: e.code, message: e.message, ...e.details };
  else if (e instanceof errors.TimeoutError) out = { code: "timeout", message: firstLines(e.message) };
  else {
    const message = firstLines(e instanceof Error ? e.message : String(e));
    if (p && p.tab === "crashed") out = { code: "page_crashed", message };
    else if (/net::ERR_/.test(message)) out = { code: "unreachable", message }; // a page load the server did not answer
    else if (/has been closed|Target closed|Target crashed/i.test(message)) out = { code: p?.tab === "crashed" ? "page_crashed" : "page_closed", message };
    else out = { code: "internal", message };
  }
  // What the app says at the time of the failure, when its tab is there to ask.
  if (p?.page && p.tab === "open" && out.notice === undefined) {
    const notice = await Promise.race([ui.readNotice(p.page).catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), 2_000))]);
    if (notice && (notice.banners.length || notice.snackbars.length)) out.notice = notice;
  }
  return out;
}

/** trace logs each command's outcome and time on stderr when NTP_ACTOR_TRACE is set. */
function trace(req: Record<string, unknown>, started: number, outcome: string): void {
  if (process.env.NTP_ACTOR_TRACE) console.error(`actor: ${String(req.profile ?? "-")} ${String(req.cmd)} ${outcome} ${Date.now() - started} ms`);
}

async function handle(req: Record<string, unknown>): Promise<void> {
  const id = req.id as string | number;
  const started = Date.now();
  let p: Profile | undefined;
  try {
    const cmd = typeof req.cmd === "string" && Object.hasOwn(commands, req.cmd) ? commands[req.cmd]! : undefined;
    if (!cmd) throw new ActorError("bad_request", `Unknown command ${JSON.stringify(req.cmd)}.`);
    const args = req.args ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args)) throw new ActorError("bad_request", "`args` is an object.");
    const a = args as Record<string, unknown>;
    const timeout = a.timeout_ms ?? cmd.timeout;
    if (typeof timeout !== "number" || !(timeout > 0 && timeout <= 1_800_000)) throw new ActorError("bad_request", "`timeout_ms` is between 1 and 1,800,000.");
    const name = req.profile;
    if (name !== undefined && (typeof name !== "string" || name === "")) throw new ActorError("bad_request", "`profile` is a non-empty string.");
    if (cmd.needs !== "nothing") {
      if (!name) throw new ActorError("bad_request", "`profile` names the profile.");
      p = profiles.get(name);
      if (!p) throw new ActorError("no_profile", `No profile ${name} is open.`);
    }
    const run = async () => {
      const d = new Deadline(timeout);
      const c: Ctx = { args: a, d, name: name as string | undefined, profile: p };
      if (cmd.needs === "tab") {
        if (!p!.page || p!.tab !== "open") throw new ActorError("no_tab", `Profile ${p!.name}'s tab is ${p!.tab}; open_tab opens a new one.`);
        c.tab = { page: p!.page, base: p!.base, d, net: p!.net };
      }
      return cmd.run(c);
    };
    let result: unknown;
    if (cmd.immediate || !p) {
      result = await run();
    } else {
      const queued = p.queue.then(run);
      p.queue = queued.catch(() => {});
      result = await queued;
    }
    reply({ id, ok: true, result: result ?? {} });
    trace(req, started, "ok");
  } catch (e) {
    const error = await failure(e, p);
    reply({ id, ok: false, error });
    trace(req, started, error?.code ?? "error");
  }
}

let closing = false;
async function shutdown(code: number): Promise<void> {
  if (closing) return;
  closing = true;
  await Promise.race([browser.then((b) => b.close()).catch(() => {}), new Promise((r) => setTimeout(r, 10_000))]);
  process.exit(code);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let req: unknown;
  try {
    req = JSON.parse(line);
  } catch {
    reply({ id: null, ok: false, error: { code: "bad_request", message: "A request is one JSON object on one line." } });
    return;
  }
  if (typeof req !== "object" || req === null || Array.isArray(req)) {
    reply({ id: null, ok: false, error: { code: "bad_request", message: "A request is a JSON object." } });
    return;
  }
  const id = (req as Record<string, unknown>).id;
  if (typeof id !== "string" && typeof id !== "number") {
    reply({ id: null, ok: false, error: { code: "bad_request", message: "A request has an `id` (a string or a number) its answer repeats." } });
    return;
  }
  void handle(req as Record<string, unknown>);
});
lines.on("close", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));
process.stdout.on("error", () => void shutdown(1));
