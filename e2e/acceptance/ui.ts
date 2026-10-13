// The web actor's work in the app (docs/ACTOR-PROTOCOL.md): every action is what a
// person does on a screen, through the locators the journeys use, and every
// reading is what a screen shows. The read API is used only to find the
// screen an episode or podcast is on, and for an account's diagnostics as an
// administrator, which no screen shows.
import type { Locator, Page } from "@playwright/test";
import { t, w } from "../../src/i18n.ts";
import { ActorError, Deadline, hms, minutes, until } from "./support.ts";

export interface Receipt {
  outcome: string;
  reason?: string;
}

/** Net is what the actor saw of a profile's pushes: the facts sent and the receipts returned. */
export interface Net {
  pushed: { op_id: string; type: string }[];
  receipts: Map<string, Receipt>;
  /** subscribed is each pushed podcast.subscribe's feed address, by op ID. */
  subscribed: Map<string, string>;
  /** descriptors are the server's play descriptors, by their media path (/v1/media/s/{token}). */
  descriptors: Map<string, { mode: string; offset_ms: number }>;
  /** stream is the last media stream asked for (path and query), which a MediaSource-fed element plays. */
  stream: string | null;
}

/** Tab is one command's hold on a profile's tab. */
export interface Tab {
  page: Page;
  base: string;
  d: Deadline;
  net: Net;
}

export type Wait = "journaled" | "settled";

const episodePath = (id: string) => `/episode/${encodeURIComponent(id)}`;
const podcastPath = (id: string) => `/podcast/${encodeURIComponent(id)}`;
const exact = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const css = (s: string) => JSON.stringify(s); // a quoted CSS attribute value

// ---- the app's state and navigation

export type AppState = "signed_in" | "sign_in" | "setup" | "unreachable";

/** appState waits until the tab shows the app: logged in, the sign-in or setup form, or the boot's "cannot reach" notice. */
export async function appState(tab: Tab): Promise<AppState> {
  const p = tab.page;
  return until(tab.d, "the app to load", async () => {
    if (await p.locator("nav.drawer").count()) return "signed_in" as const;
    if (await p.getByRole("heading", { name: w("setup_title") }).count()) return "setup" as const;
    if (await p.getByRole("heading", { name: w("sign_in_title") }).count()) return "sign_in" as const;
    if (!(await p.locator(".shell").count()) && (await p.locator(".banner", { hasText: w("server_unreachable") }).count())) return "unreachable" as const;
    return undefined;
  });
}

/**
 * go opens a path the way the app's links do (in-app navigation, so a
 * playing episode keeps playing); a tab without the app loads it first.
 */
export async function go(tab: Tab, path: string): Promise<void> {
  const p = tab.page;
  if (!(await p.locator(".shell").count())) {
    await p.goto(tab.base + path, { timeout: tab.d.left() });
    const state = await appState(tab);
    if (state !== "signed_in") throw new ActorError("signed_out", `This profile is not logged in (the tab shows ${state.replace("_", " ")}).`);
    return;
  }
  await p.evaluate((u) => {
    if (location.pathname + location.search === u) return;
    history.pushState(null, "", u);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

/** screen opens a top-level screen and waits until it shows its toolbar title. */
async function screen(tab: Tab, path: string, title: string): Promise<void> {
  await go(tab, path);
  await tab.page.locator(".toolbar h1", { hasText: exact(title) }).waitFor({ timeout: tab.d.left() });
}

/** toolbarMenu opens the screen's overflow menu and picks an item; a disabled item is reported as such. */
async function toolbarMenu(tab: Tab, item: string): Promise<"done" | "disabled"> {
  await tab.page.locator(".toolbar").getByRole("button", { name: t("overflow_more"), exact: true }).click({ timeout: tab.d.left() });
  const entry = tab.page.getByRole("menu").getByRole("menuitem", { name: item, exact: true });
  await entry.waitFor({ timeout: tab.d.left() });
  if (await entry.isDisabled()) {
    await tab.page.keyboard.press("Escape");
    return "disabled";
  }
  await entry.click({ timeout: tab.d.left() });
  return "done";
}

/** confirm presses a confirmation dialog's button and waits for the dialog to close (the action is then journaled). */
async function confirm(tab: Tab, button = t("confirm_label")): Promise<void> {
  const dialog = tab.page.locator("dialog.dialog[open]");
  await dialog.getByRole("button", { name: button, exact: true }).click({ timeout: tab.d.left() });
  await until(tab.d, "the dialog to close", async () => {
    const error = dialog.locator(".dialog-error");
    if (await error.count()) throw new ActorError("ui_error", (await error.first().innerText()).trim());
    return (await dialog.count()) === 0;
  });
}

// ---- the journal: which facts an action wrote, and their receipts

interface JournalEntry {
  op_id: string;
  type: string;
  receipt: Receipt | null;
  waiting: boolean;
  retained: boolean;
}

/**
 * journal lists the profile's journaled facts (IndexedDB), without creating
 * the app's database where it has none. IndexedDB can block (an upgrade in
 * another tab): the read is bounded by the command's deadline.
 */
export async function journal(tab: Tab): Promise<JournalEntry[]> {
  const out = await tab.page.evaluate(async (ms) => {
    const late = new Promise<"late">((r) => setTimeout(() => r("late"), ms));
    return Promise.race([late, readJournal()]);
    async function readJournal() {
      if (!(await indexedDB.databases()).some((x) => x.name === "nottennapod")) return [];
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const q = indexedDB.open("nottennapod");
        q.onupgradeneeded = () => q.transaction?.abort();
        q.onsuccess = () => resolve(q.result);
        q.onerror = () => reject(q.error);
      });
      db.onversionchange = () => db.close();
      type Stored = { op_id: string; fact?: { type?: string }; receipt?: { outcome: string; reason?: string } | null; waiting?: unknown };
      const read = (store: string) =>
        new Promise<Stored[]>((resolve, reject) => {
          if (!db.objectStoreNames.contains(store)) return resolve([]);
          const q = db.transaction(store).objectStore(store).getAll();
          q.onsuccess = () => resolve(q.result as Stored[]);
          q.onerror = () => reject(q.error);
        });
      const row = (retained: boolean) => (e: Stored) => ({
        op_id: e.op_id,
        type: e.fact?.type ?? "",
        receipt: e.receipt ? { outcome: e.receipt.outcome, ...(e.receipt.reason ? { reason: e.receipt.reason } : {}) } : null,
        waiting: !!e.waiting,
        retained,
      });
      try {
        return [...(await read("journal")).map(row(false)), ...(await read("retained")).map(row(true))];
      } finally {
        db.close();
      }
    }
  }, tab.d.left());
  if (out === "late") throw new ActorError("timeout", `Timed out after ${tab.d.ms} ms reading this profile's journal.`, { waiting_for: "the profile's journal" });
  return out;
}

/** settle waits until every journaled fact has the server's receipt (what the journeys call settled). */
export async function settle(tab: Tab): Promise<{ facts: number }> {
  let pending: JournalEntry[] = [];
  await until(
    tab.d,
    "every journaled change to reach the server",
    async () => {
      const all = await journal(tab);
      pending = all.filter((e) => !e.retained && !e.receipt);
      return pending.length === 0;
    },
    () => ({ pending: pending.map((e) => ({ op_id: e.op_id, type: e.type, waiting: e.waiting })) }),
  );
  return { facts: (await journal(tab)).filter((e) => !e.retained).length };
}

export interface Acted {
  op_ids: string[];
  facts: { op_id: string; type: string; outcome?: string; reason?: string }[];
}

/**
 * act runs a person's action and waits for the fact it writes (one of
 * types): journaled, or also acknowledged by the server with its outcome.
 */
async function act(tab: Tab, types: string[], wait: Wait, run: () => Promise<void>): Promise<Acted> {
  const before = new Set((await journal(tab)).map((e) => e.op_id));
  const sent = tab.net.pushed.length;
  await run();
  const fresh = await until(tab.d, `the action's ${types.join(" or ")} fact in this profile's journal`, async () => {
    const seen = new Map<string, string>();
    for (const e of await journal(tab)) if (!before.has(e.op_id) && types.includes(e.type)) seen.set(e.op_id, e.type);
    for (const e of tab.net.pushed.slice(sent)) if (!before.has(e.op_id) && types.includes(e.type)) seen.set(e.op_id, e.type);
    return seen.size ? seen : undefined;
  });
  const facts = [...fresh].map(([op_id, type]) => ({ op_id, type }));
  if (wait === "journaled") return { op_ids: [...fresh.keys()], facts };
  const receipts = await until(tab.d, "the server's receipt for the action", async () => {
    const byOp = new Map((await journal(tab)).map((e) => [e.op_id, e.receipt]));
    const out = new Map<string, Receipt>();
    for (const op of fresh.keys()) {
      const r = byOp.get(op) ?? tab.net.receipts.get(op);
      if (!r) return undefined;
      out.set(op, r);
    }
    return out;
  });
  return { op_ids: [...fresh.keys()], facts: facts.map((f) => ({ ...f, ...receipts.get(f.op_id) })) };
}

// ---- finding episodes and podcasts (the read API, through this profile's session)

/**
 * api reads the API with the profile's session. The request and its body are
 * bounded by the command's deadline (aborted in the page), so a request that
 * never answers ends the command with timeout, and nothing of it outlives the
 * command.
 */
async function api<T>(tab: Tab, path: string): Promise<T> {
  const what = path.split("?")[0]!;
  const out = await tab.page.evaluate(
    async ({ p, ms }) => {
      const signal = AbortSignal.timeout(ms);
      try {
        const r = await fetch(p, { cache: "no-store", headers: { Accept: "application/json" }, signal });
        const text = await r.text(); // the body too: the signal aborts its read
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          /* not JSON: its status says what happened */
        }
        return { status: r.status, body, late: false, failure: "" };
      } catch (e) {
        return { status: 0, body: {} as Record<string, unknown>, late: signal.aborted, failure: String(e) };
      }
    },
    { p: path, ms: tab.d.left() },
  );
  if (out.late) throw new ActorError("timeout", `Timed out after ${tab.d.ms} ms waiting for ${what}.`, { waiting_for: what });
  if (out.status === 0) throw new ActorError("unreachable", `${what}: ${out.failure}`);
  const { status, body } = out;
  if (status !== 200) {
    throw new ActorError(status === 404 ? "not_found" : "api_error", `${path.split("?")[0]}: ${String(body.message ?? `HTTP ${status}`)}`, { status, error: body.error });
  }
  return body as T;
}

export interface EpisodeRef {
  episode_id: string;
  title: string;
  podcast_id: string;
}

interface ApiEpisode {
  episode_id: string;
  title: string | null;
  podcast_id: string;
  podcast: { display_title: string };
}

/** episodeRef finds an episode by its ID (`episode`), or by its title (`title`, with `podcast` for a podcast's title when titles repeat). */
export async function episodeRef(tab: Tab, args: Record<string, unknown>): Promise<EpisodeRef> {
  const ref = (e: ApiEpisode): EpisodeRef => ({ episode_id: e.episode_id, title: e.title ?? "", podcast_id: e.podcast_id });
  if (typeof args.episode === "string") {
    return ref((await api<{ episode: ApiEpisode }>(tab, `/v1/read/episodes/${encodeURIComponent(args.episode)}`)).episode);
  }
  if (typeof args.title !== "string") throw new ActorError("bad_request", "Name the episode: `episode` (its ID) or `title`.");
  const found: ApiEpisode[] = [];
  let token: string | null = null;
  do {
    const q = new URLSearchParams({ filter: "include_subscribed,include_archived,include_not_subscribed", limit: "500" });
    if (token) q.set("page_token", token);
    const page: { items: ApiEpisode[]; next_page_token: string | null } = await api(tab, `/v1/read/episodes?${q}`);
    for (const e of page.items) if (e.title === args.title && (typeof args.podcast !== "string" || e.podcast.display_title === args.podcast)) found.push(e);
    token = page.next_page_token;
  } while (token);
  if (found.length === 0) throw new ActorError("not_found", `No episode is titled ${JSON.stringify(args.title)}.`);
  if (found.length > 1) throw new ActorError("ambiguous", `${found.length} episodes are titled ${JSON.stringify(args.title)}; name the podcast or the episode's ID.`);
  return ref(found[0]!);
}

export interface PodcastRef {
  podcast_id: string;
  title: string;
  state: string;
}

/** podcastRef finds a podcast by its ID (`podcast` starting p1:) or by its title (`podcast`), subscribed or archived. */
export async function podcastRef(tab: Tab, args: Record<string, unknown>): Promise<PodcastRef> {
  const name = args.podcast;
  if (typeof name !== "string") throw new ActorError("bad_request", "Name the podcast: `podcast` (its ID or its title).");
  type P = { podcast_id: string; display_title: string; state: string };
  const ref = (p: P): PodcastRef => ({ podcast_id: p.podcast_id, title: p.display_title, state: p.state });
  if (name.startsWith("p1:")) return ref((await api<{ podcast: P }>(tab, `/v1/read/podcasts/${encodeURIComponent(name)}`)).podcast);
  const found: P[] = [];
  for (const state of ["subscribed", "archived"]) {
    const page = await api<{ items: P[] }>(tab, `/v1/read/subscriptions?limit=500&state=${state}`);
    found.push(...page.items.filter((p) => p.display_title === name));
  }
  if (found.length === 0) throw new ActorError("not_found", `No subscription is titled ${JSON.stringify(name)}.`);
  if (found.length > 1) throw new ActorError("ambiguous", `${found.length} subscriptions are titled ${JSON.stringify(name)}; name its ID.`);
  return ref(found[0]!);
}

// ---- episode rows, as the lists show them

export interface Row {
  episode_id: string | null;
  title: string;
  /** new (the Inbox icon), played (the row is shown played) or unplayed. */
  play_state: "new" | "unplayed" | "played";
  in_queue: boolean;
  favorite: boolean;
  /** The position the row's progress shows, in whole seconds; 0 when the row shows no progress. */
  position_ms: number;
  progress_shown: boolean;
  duration_ms: number | null;
  date: string;
  /** The row's button says Pause: this tab plays the episode. */
  playing_here: boolean;
}

const rowsOf = (scope: string) => `${scope} ul.episode-list > li.episode`;

async function rows(page: Page, scope = ".content"): Promise<Row[]> {
  const raw = await page.evaluate(
    (selector) =>
      [...document.querySelectorAll(selector)].map((li) => ({
        href: li.querySelector("a.episode-main")?.getAttribute("href") ?? "",
        title: li.querySelector(".episode-title")?.textContent ?? "",
        icons: [...li.querySelectorAll(".episode-status [role=img]")].map((x) => x.getAttribute("aria-label") ?? ""),
        played: li.classList.contains("played"),
        progress: [...li.querySelectorAll(".episode-progress > span")].map((x) => x.textContent ?? ""),
        status: [...li.querySelectorAll(".episode-status > span")].map((x) => x.textContent ?? ""),
        button: li.querySelector(".item-button")?.getAttribute("aria-label") ?? null,
      })),
    rowsOf(scope),
  );
  return raw.map((r) => {
    const fresh = r.icons.includes(t("inbox_label"));
    return {
      episode_id: r.href.startsWith("/episode/") ? decodeURIComponent(r.href.slice("/episode/".length)) : null,
      title: r.title,
      play_state: fresh ? "new" : r.played ? "played" : "unplayed",
      in_queue: r.icons.includes(t("in_queue_label")),
      favorite: r.icons.includes(t("favorite_episodes_label")),
      position_ms: r.progress.length ? (hms(r.progress[0]) ?? 0) : 0,
      progress_shown: r.progress.length > 0,
      duration_ms: r.progress.length ? hms(r.progress[1]) : hms(r.status[1]),
      date: r.status[0] ?? "",
      playing_here: r.button === t("pause_label"),
    };
  });
}

/** loadAll presses "Load next page" until the list has every page. */
async function loadAll(tab: Tab, itemSelector: string): Promise<void> {
  const more = tab.page.locator(".content button.load-more");
  const items = tab.page.locator(itemSelector);
  while (await more.count()) {
    const n = await items.count();
    await more
      .first()
      .click({ timeout: Math.min(2_000, tab.d.left()) })
      .catch(() => {}); // the list may load it by itself as it scrolls into view
    await until(tab.d, "the list's next page", async () => (await more.count()) === 0 || (await items.count()) > n);
  }
}

/** rowOf finds an episode's row in the screen's list, loading pages until it is there. */
async function rowOf(tab: Tab, id: string, where: string): Promise<Locator> {
  const row = tab.page.locator(rowsOf(".content")).filter({ has: tab.page.locator(`a.episode-main[href=${css(episodePath(id))}]`) });
  await until(tab.d, `the episode's row in ${where}`, async () => {
    if (await row.count()) return true;
    const more = tab.page.locator(".content button.load-more");
    if (await more.count()) await more.first().click({ timeout: Math.min(2_000, tab.d.left()) }).catch(() => {});
    return false;
  });
  return row.first();
}

async function rowMenu(tab: Tab, row: Locator, item: string): Promise<void> {
  await row.getByRole("button", { name: t("overflow_more"), exact: true }).click({ timeout: tab.d.left() });
  await tab.page.getByRole("menu").getByRole("menuitem", { name: item, exact: true }).click({ timeout: tab.d.left() });
}

const lists = {
  queue: { path: "/queue", title: () => t("queue_label") },
  inbox: { path: "/inbox", title: () => t("inbox_label") },
  favorites: { path: "/favorites", title: () => t("favorite_episodes_label") },
  history: { path: "/history", title: () => t("playback_history_label") },
} as const;

export type ListName = keyof typeof lists;

async function listScreen(tab: Tab, which: ListName): Promise<void> {
  await screen(tab, lists[which].path, lists[which].title());
  await tab.page.locator(".content ul.episode-list, .content .empty").first().waitFor({ timeout: tab.d.left() });
}

/**
 * episodeScreen opens an episode's screen afresh, as a person coming to it
 * from elsewhere: a screen already showing it is left first, so its menu is
 * built from what the server says now, not from before this tab's last change.
 */
async function episodeScreen(tab: Tab, id: string): Promise<void> {
  const p = tab.page;
  const path = episodePath(id);
  if (await p.evaluate((u) => location.pathname === u, path)) {
    await go(tab, "/");
    await p.locator("section[data-episode-id]").waitFor({ state: "detached", timeout: tab.d.left() });
  }
  await go(tab, path);
  await p.locator(`section[data-episode-id=${css(id)}] .episode-header h2`).waitFor({ timeout: tab.d.left() });
}

async function podcastScreen(tab: Tab, id: string): Promise<void> {
  await go(tab, podcastPath(id));
  await tab.page.locator(`section[data-podcast-id=${css(id)}]`).waitFor({ timeout: tab.d.left() });
}

/** episodeMenu picks `wanted` in the episode screen's menu; if it offers `done` instead, the episode is already so. */
async function episodeMenu(tab: Tab, id: string, wanted: string, done: string): Promise<boolean> {
  await episodeScreen(tab, id);
  await tab.page.locator(".toolbar").getByRole("button", { name: t("overflow_more"), exact: true }).click({ timeout: tab.d.left() });
  const menu = tab.page.getByRole("menu");
  await menu.getByRole("menuitem").first().waitFor({ timeout: tab.d.left() });
  const labels = (await menu.getByRole("menuitem").allInnerTexts()).map((s) => s.trim());
  if (labels.includes(wanted)) {
    await menu.getByRole("menuitem", { name: wanted, exact: true }).click({ timeout: tab.d.left() });
    return true;
  }
  await tab.page.keyboard.press("Escape");
  if (labels.includes(done)) return false;
  throw new ActorError("not_in_ui", `The episode's menu offers no "${wanted}" (it offers ${labels.join(", ")}).`);
}

// ---- actions

export async function setUp(tab: Tab, a: { setup_code: string; username: string; password: string }): Promise<{ username: string }> {
  await tab.page.goto(tab.base + "/", { timeout: tab.d.left() });
  const state = await appState(tab);
  if (state !== "setup") throw new ActorError("not_in_ui", `The server is not waiting for its setup (the tab shows ${state.replace("_", " ")}).`);
  const p = tab.page;
  await p.getByLabel(w("setup_code_label")).fill(a.setup_code, { timeout: tab.d.left() });
  await p.getByLabel(t("username_label")).fill(a.username, { timeout: tab.d.left() });
  await p.getByLabel(t("password_label"), { exact: true }).fill(a.password, { timeout: tab.d.left() });
  await p.getByRole("button", { name: w("setup_button") }).click({ timeout: tab.d.left() });
  await signedIn(tab);
  return { username: a.username };
}

export async function logIn(tab: Tab, a: { username: string; password: string }): Promise<{ username: string; already: boolean }> {
  const p = tab.page;
  if (!(await p.locator(".shell").count())) await p.goto(tab.base + "/", { timeout: tab.d.left() });
  const state = await appState(tab);
  if (state === "signed_in") {
    const who = await api<{ account: { username: string } }>(tab, "/v1/session");
    if (who.account.username !== a.username) throw new ActorError("signed_in_as_other", `This profile is logged in as ${who.account.username}.`);
    return { username: a.username, already: true };
  }
  if (state !== "sign_in") throw new ActorError("not_in_ui", `The tab shows ${state.replace("_", " ")}, not the sign-in form.`);
  await p.getByLabel(t("username_label")).fill(a.username, { timeout: tab.d.left() });
  await p.getByLabel(t("password_label"), { exact: true }).fill(a.password, { timeout: tab.d.left() });
  await p.getByRole("button", { name: t("synchronization_login_butLabel"), exact: true }).click({ timeout: tab.d.left() });
  await signedIn(tab);
  return { username: a.username, already: false };
}

/** signedIn waits for the app's drawer, or reports the sign-in form's error. */
async function signedIn(tab: Tab): Promise<void> {
  const p = tab.page;
  await until(tab.d, "the app after logging in", async () => {
    if (await p.locator("nav.drawer").count()) return true;
    const error = p.locator(".sign-in [role=alert]");
    if ((await error.count()) && (await p.locator(".sign-in button.filled-button:not([disabled])").count())) {
      throw new ActorError("ui_error", (await error.innerText()).trim());
    }
    return false;
  });
}

export async function subscribe(
  tab: Tab,
  a: { feed_url: string; username?: string; password?: string; wait: Wait | "shown" },
): Promise<Partial<Acted> & { podcast_id?: string; title: string; already?: boolean }> {
  const p = tab.page;
  await screen(tab, "/add", t("add_feed_label"));
  await p.getByLabel(t("add_podcast_by_url")).fill(a.feed_url, { timeout: tab.d.left() });
  await p.getByRole("button", { name: t("preview_episodes"), exact: true }).click({ timeout: tab.d.left() });
  const heading = p.locator(".preview .podcast-header h2");
  const login = p.locator("form").filter({ has: p.getByLabel(t("password_label"), { exact: true }) });
  const failed = p.locator(".content > section > p.error[role=alert]");
  const first = await until(tab.d, "the feed's preview", async () =>
    (await heading.count()) ? ("preview" as const) : (await login.count()) ? ("login" as const) : (await failed.count()) ? ("error" as const) : undefined,
  );
  if (first === "error") throw new ActorError("ui_error", (await failed.innerText()).trim());
  if (first === "login") {
    if (a.username === undefined || a.password === undefined) throw new ActorError("needs_login", "The feed asks for a username and password.");
    await login.getByLabel(t("username_label")).fill(a.username, { timeout: tab.d.left() });
    await login.getByLabel(t("password_label"), { exact: true }).fill(a.password, { timeout: tab.d.left() });
    await login.getByRole("button", { name: t("confirm_label"), exact: true }).click({ timeout: tab.d.left() });
    await until(tab.d, "the feed's preview after its login", async () => {
      const alert = login.getByRole("alert");
      if (await alert.count()) throw new ActorError("ui_error", (await alert.innerText()).trim());
      if (await failed.count()) throw new ActorError("ui_error", (await failed.innerText()).trim());
      return (await heading.count()) > 0;
    });
  }
  const title = (await heading.innerText()).trim();
  const open = p.locator(".preview").getByRole("button", { name: t("open_podcast"), exact: true });
  if (await open.count()) {
    // The account has a podcast at this address: its screen, with Subscribe if it is not subscribed.
    await open.click({ timeout: tab.d.left() });
    const screenOf = p.locator("section[data-podcast-id]");
    await screenOf.waitFor({ timeout: tab.d.left() });
    const podcast_id = (await screenOf.getAttribute("data-podcast-id")) ?? "";
    const subscribeHere = screenOf.locator(".podcast-header").getByRole("button", { name: t("subscribe_label"), exact: true });
    if (!(await subscribeHere.count())) return { podcast_id, title, already: true };
    const acted = await act(tab, ["podcast.subscribe"], a.wait === "journaled" ? "journaled" : "settled", () => subscribeHere.click({ timeout: tab.d.left() }));
    return { ...acted, podcast_id, title };
  }
  const acted = await act(tab, ["podcast.subscribe"], a.wait === "journaled" ? "journaled" : "settled", async () => {
    await p.locator(".preview").getByRole("button", { name: t("subscribe_label"), exact: true }).click({ timeout: tab.d.left() });
  });
  if (a.wait === "journaled") return { ...acted, title };
  const subscribed = acted.facts.find((f) => f.type === "podcast.subscribe")!;
  if (subscribed.outcome !== "applied") return { ...acted, title }; // refused: no podcast of its own
  const podcast_id = await subscribedBy(tab, subscribed.op_id, tab.net.subscribed.get(subscribed.op_id));
  if (a.wait !== "shown") return { ...acted, title, podcast_id };
  // The server's first fetch fills the podcast in: its own tile then has the feed's title.
  await until(tab.d, "the podcast in Subscriptions", async () => (await p.locator(".toolbar h1", { hasText: exact(t("subscriptions_label")) }).count()) > 0);
  const tile = p.locator(`.subscription-grid a.subscription-tile[href=${css(podcastPath(podcast_id))}]`);
  await until(tab.d, "the podcast's tile with the feed's title", async () => (await tile.count()) > 0 && (await tile.locator(".subscription-title").innerText()).trim() === title);
  return { ...acted, title, podcast_id };
}

/**
 * subscribedBy is the podcast a subscribe fact subscribed, never one found by
 * its title, which another podcast may share: the podcast whose records the
 * fact determines (a podcast it created has it in its identity's
 * provenance), else, for a subscribe that joined an existing podcast, the
 * one podcast refreshed from the address the fact submitted.
 */
async function subscribedBy(tab: Tab, opId: string, feedURL: string | undefined): Promise<string> {
  type Row = { podcast_id: string; records: Record<string, { value?: Record<string, unknown>; provenance?: string[] } | undefined> };
  const addresses = (r: Row) => {
    const id = r.records.identity?.value as { refresh_url?: string; aliases?: { url?: string }[] } | undefined;
    return [id?.refresh_url, ...(id?.aliases ?? []).map((a) => a.url)];
  };
  return until(tab.d, "the podcast the subscribe made", async () => {
    const rows: Row[] = [];
    for (const state of ["subscribed", "archived"]) rows.push(...(await api<{ items: Row[] }>(tab, `/v1/read/subscriptions?limit=500&state=${state}`)).items);
    const made = rows.find((r) => Object.values(r.records).some((rec) => rec?.provenance?.includes(opId)));
    if (made) return made.podcast_id;
    const at = feedURL ? rows.filter((r) => addresses(r).includes(feedURL)) : [];
    return at.length === 1 ? at[0]!.podcast_id : undefined;
  });
}

export async function favorite(tab: Tab, e: EpisodeRef, on: boolean, wait: Wait): Promise<Partial<Acted> & { changed: boolean }> {
  const add = t("add_to_favorite_label");
  const remove = t("remove_from_favorite_label");
  return once(tab, ["favorite.set"], wait, () => episodeMenu(tab, e.episode_id, on ? add : remove, on ? remove : add));
}

export async function markPlayed(tab: Tab, e: EpisodeRef, played: boolean, wait: Wait): Promise<Partial<Acted> & { changed: boolean }> {
  const played_ = t("mark_as_played_label");
  const unplayed = t("mark_as_unplayed_label");
  return once(tab, [played ? "episode.mark_played" : "episode.mark_unplayed"], wait, () =>
    episodeMenu(tab, e.episode_id, played ? played_ : unplayed, played ? unplayed : played_),
  );
}

export async function queueAdd(tab: Tab, e: EpisodeRef, wait: Wait): Promise<Partial<Acted> & { changed: boolean }> {
  return once(tab, ["queue.add"], wait, () => episodeMenu(tab, e.episode_id, t("add_to_queue_label"), t("remove_from_queue_label")));
}

/** once runs an action that may find the episode already so: then nothing is journaled. */
async function once(tab: Tab, types: string[], wait: Wait, run: () => Promise<boolean>): Promise<Partial<Acted> & { changed: boolean }> {
  let changed = false;
  try {
    const acted = await act(tab, types, wait, async () => {
      changed = await run();
      if (!changed) throw new Unchanged();
    });
    return { ...acted, changed: true };
  } catch (e) {
    if (e instanceof Unchanged) return { changed: false };
    throw e;
  }
}

class Unchanged extends Error {}

export async function queueMove(tab: Tab, e: EpisodeRef, to: "top" | "bottom", wait: Wait): Promise<Acted> {
  await listScreen(tab, "queue");
  const row = await rowOf(tab, e.episode_id, "the queue");
  return act(tab, ["queue.move"], wait, () => rowMenu(tab, row, to === "top" ? t("move_to_top_label") : t("move_to_bottom_label")));
}

export async function queueRemove(tab: Tab, e: EpisodeRef, wait: Wait): Promise<Acted> {
  await listScreen(tab, "queue");
  const row = await rowOf(tab, e.episode_id, "the queue");
  return act(tab, ["queue.remove"], wait, () => rowMenu(tab, row, t("remove_from_queue_label")));
}

export async function queueClear(tab: Tab, wait: Wait): Promise<Partial<Acted> & { changed: boolean }> {
  await listScreen(tab, "queue");
  if (!(await tab.page.locator(rowsOf(".content")).count())) return { changed: false };
  const acted = await act(tab, ["queue.clear"], wait, async () => {
    if ((await toolbarMenu(tab, t("clear_queue_label"))) === "disabled") throw new ActorError("not_in_ui", "Clear queue is disabled.");
    await confirm(tab);
  });
  return { ...acted, changed: true };
}

export async function inboxRemove(tab: Tab, e: EpisodeRef | null, wait: Wait): Promise<Partial<Acted> & { changed: boolean }> {
  await listScreen(tab, "inbox");
  if (!e) {
    if (!(await tab.page.locator(rowsOf(".content")).count())) return { changed: false };
    const acted = await act(tab, ["inbox.dismiss_all"], wait, async () => {
      if ((await toolbarMenu(tab, t("remove_all_inbox_label"))) === "disabled") throw new ActorError("not_in_ui", "Remove all from inbox is disabled.");
      await confirm(tab);
    });
    return { ...acted, changed: true };
  }
  const row = await rowOf(tab, e.episode_id, "the Inbox");
  return { ...(await act(tab, ["inbox.dismiss"], wait, () => rowMenu(tab, row, t("remove_inbox_label")))), changed: true };
}

export async function unsubscribe(tab: Tab, podcast: PodcastRef, wait: Wait): Promise<Acted> {
  await podcastScreen(tab, podcast.podcast_id);
  const item = podcast.state === "archived" ? t("remove_restore_feed_label") : t("remove_archive_feed_label");
  return act(tab, ["podcast.unsubscribe"], wait, async () => {
    await toolbarMenu(tab, item);
    const dialog = tab.page.locator("dialog.dialog[open]");
    // Android asks once more: Unsubscribe, then Unsubscribe again.
    await dialog.getByRole("button", { name: t("remove_feed_label"), exact: true }).click({ timeout: tab.d.left() });
    await dialog.locator("button.danger", { hasText: exact(t("remove_feed_label")) }).click({ timeout: tab.d.left() });
    await until(tab.d, "the podcast to be unsubscribed", async () => {
      const error = dialog.locator(".dialog-error");
      if (await error.count()) throw new ActorError("ui_error", (await error.first().innerText()).trim());
      return (await dialog.count()) === 0;
    });
  });
}

/** shownLogin is the username the podcast screen says its login has ("✓" for one without a username), or null for none. */
async function shownLogin(tab: Tab): Promise<string | null> {
  const prefix = `${t("authentication_label")}: `;
  const line = tab.page.locator(".podcast-header p.secondary", { hasText: new RegExp(`^${prefix}`) });
  return (await line.count()) ? (await line.first().innerText()).trim().slice(prefix.length) : null;
}

/**
 * setFeedLogin is the podcast's Authentication setting (Android's feed
 * settings): the username and password, then Confirm. As the dialog does, an
 * empty password with the shown username keeps the saved login, and no
 * username removes it; then nothing may be journaled.
 */
export async function setFeedLogin(tab: Tab, podcast: PodcastRef, a: { username: string; password: string; wait: Wait }): Promise<Partial<Acted> & { changed: boolean }> {
  await podcastScreen(tab, podcast.podcast_id);
  const known = await shownLogin(tab);
  const changes = a.username === "" ? known !== null : !(known === a.username && a.password === "");
  const run = async () => {
    if ((await toolbarMenu(tab, t("authentication_label"))) === "disabled") throw new ActorError("not_in_ui", "Authentication is disabled.");
    const dialog = tab.page.getByRole("dialog", { name: t("authentication_label"), exact: true });
    await dialog.getByLabel(t("username_label"), { exact: true }).fill(a.username, { timeout: tab.d.left() });
    await dialog.getByLabel(t("password_label"), { exact: true }).fill(a.password, { timeout: tab.d.left() });
    await dialog.getByRole("button", { name: t("confirm_label"), exact: true }).click({ timeout: tab.d.left() });
    // A refusal is reported after Cancel, as a person gives up: the screen is left as it was.
    const refuse = async (message: string): Promise<never> => {
      await dialog.getByRole("button", { name: t("cancel_label"), exact: true }).click({ timeout: tab.d.left() });
      throw new ActorError("ui_error", message);
    };
    await until(tab.d, "the Authentication dialog to close", async () => {
      const error = dialog.locator(".dialog-error");
      if (await error.count()) await refuse((await error.first().innerText()).trim());
      if ((await dialog.locator("input:invalid").count()) && !(await dialog.locator("progress").count())) {
        await refuse("The dialog asks for the password: a changed username needs its password.");
      }
      return (await dialog.count()) === 0;
    });
    return changes;
  };
  return once(tab, ["podcast.set_credentials"], a.wait, run);
}

export interface PodcastReading {
  podcast_id: string;
  title: string;
  /** The username the screen shows for the podcast's login ("✓" for one without a username), or null for none. */
  authentication: string | null;
}

export async function readPodcast(tab: Tab, podcast: PodcastRef): Promise<PodcastReading> {
  await podcastScreen(tab, podcast.podcast_id);
  return {
    podcast_id: podcast.podcast_id,
    title: (await tab.page.locator(".toolbar h1").innerText()).trim(),
    authentication: await shownLogin(tab),
  };
}

export async function clearHistory(tab: Tab, wait: Wait): Promise<Partial<Acted> & { changed: boolean }> {
  await listScreen(tab, "history");
  if (!(await tab.page.locator(rowsOf(".content")).count())) return { changed: false };
  const acted = await act(tab, ["history.clear"], wait, async () => {
    if ((await toolbarMenu(tab, t("clear_history_label"))) === "disabled") throw new ActorError("not_in_ui", "Clear history is disabled.");
    await confirm(tab);
  });
  return { ...acted, changed: true };
}

export async function resetStatistics(tab: Tab, wait: Wait): Promise<Acted> {
  await statisticsScreen(tab);
  return act(tab, ["statistics.reset"], wait, async () => {
    await toolbarMenu(tab, t("statistics_reset_data"));
    await confirm(tab);
  });
}

// ---- playback

const bar = (p: Page) => p.locator(".player-bar");

async function audio(p: Page): Promise<{ ms: number; paused: boolean; ready: number; seeking: boolean; src: string } | null> {
  return p.evaluate(() => {
    const a = document.querySelector("audio");
    return a ? { ms: Math.round(a.currentTime * 1000), paused: a.paused, ready: a.readyState, seeking: a.seeking, src: a.currentSrc || a.src } : null;
  });
}

/** Transport is where the audio is on the episode's timeline, from the element and the server's descriptor of its source. */
interface Transport {
  /** The element's position on the episode's timeline: its stream's start (a converted stream starts at a seek) plus its time. */
  position_ms: number;
  /** Where the element's stream starts on the episode's timeline: 0, or a converted stream's start. */
  offset_ms: number;
  source: "relay" | "converted" | "direct" | "none";
  paused: boolean;
  seeking: boolean;
  ready: number;
  /** The source's descriptor is known (an episode's source the actor saw the server describe). */
  described: boolean;
}

/**
 * transport reads where the audio is. A relayed or converted source is
 * described by the server (POST /v1/media/{episode}/play): a converted
 * stream's start is its descriptor's offset, or the start_ms its address
 * names after a seek within it.
 */
async function transport(tab: Tab): Promise<Transport | null> {
  const a = await audio(tab.page);
  if (!a) return null;
  if (!a.src) return { position_ms: a.ms, offset_ms: 0, source: "none", paused: a.paused, seeking: a.seeking, ready: a.ready, described: true };
  // A converted stream fed through a MediaSource plays from a blob: address: its stream is the one last asked for.
  const fed = a.src.startsWith("blob:");
  if (fed && !tab.net.stream) return { position_ms: a.ms, offset_ms: 0, source: "converted", paused: a.paused, seeking: a.seeking, ready: a.ready, described: false };
  const u = new URL(fed ? tab.net.stream! : a.src, tab.base);
  const relayed = u.origin === new URL(tab.base).origin && u.pathname.startsWith("/v1/media/s/");
  const d = relayed ? tab.net.descriptors.get(u.pathname) : undefined;
  const converted = d?.mode === "compat";
  const start = u.searchParams.get("start_ms");
  const offset = converted ? (start !== null ? Number(start) : d.offset_ms) : 0;
  return {
    position_ms: offset + a.ms,
    offset_ms: offset,
    source: !relayed ? "direct" : converted ? "converted" : "relay",
    paused: a.paused,
    seeking: a.seeking,
    ready: a.ready,
    described: !relayed || !!d,
  };
}

export interface PlayerReading {
  shown: boolean;
  title?: string;
  subtitle?: string;
  state?: "playing" | "paused" | "elsewhere";
  /** The elapsed time the bar shows (whole seconds), on the episode's timeline. */
  elapsed_ms?: number | null;
  /** The audio element's own time (a converted stream's time starts at 0 at its start). */
  audio_ms?: number | null;
  /** Where the audio is on the episode's timeline: the stream's start plus the element's time. */
  transport_ms?: number | null;
  /** Where the element's stream starts on the episode's timeline (a converted stream starts at a seek). */
  offset_ms?: number | null;
  source?: "relay" | "converted" | "direct" | "none";
}

export async function readPlayer(tab: Tab): Promise<PlayerReading> {
  const p = tab.page;
  if (!(await bar(p).count())) return { shown: false };
  const b = bar(p);
  const state = (await b.getByRole("button", { name: w("play_here"), exact: true }).count())
    ? "elsewhere"
    : (await b.getByRole("button", { name: t("pause_label"), exact: true }).count())
      ? "playing"
      : "paused";
  const elapsed = b.locator(".player-bar-position .player-elapsed");
  const a = await audio(p);
  const tr = await transport(tab);
  return {
    shown: true,
    title: (await b.locator(".player-bar-title").innerText()).trim(),
    subtitle: (await b.locator(".player-bar-subtitle").innerText()).trim(),
    state,
    elapsed_ms: (await elapsed.count()) ? hms(await elapsed.innerText()) : null,
    audio_ms: a?.ms ?? null,
    transport_ms: tr?.position_ms ?? null,
    offset_ms: tr?.offset_ms ?? null,
    source: tr?.source ?? "none",
  };
}

export async function play(tab: Tab, e: EpisodeRef): Promise<PlayerReading> {
  const p = tab.page;
  await episodeScreen(tab, e.episode_id);
  const buttons = p.locator(".episode-buttons");
  if (!(await buttons.getByRole("button", { name: t("pause_label"), exact: true }).count())) {
    await buttons.getByRole("button", { name: t("stream_label"), exact: true }).click({ timeout: tab.d.left() });
  }
  await bar(p).locator(".player-bar-title", { hasText: exact(e.title) }).waitFor({ timeout: tab.d.left() });
  await bar(p).getByRole("button", { name: t("pause_label"), exact: true }).waitFor({ timeout: tab.d.left() });
  // Playing means the audio runs: the media has loaded and the element is not paused.
  await until(tab.d, "the audio to play", async () => {
    const a = await audio(p);
    return !!a && !a.paused && a.ready >= 3;
  });
  return readPlayer(tab);
}

async function here(tab: Tab): Promise<void> {
  const r = await readPlayer(tab);
  if (!r.shown) throw new ActorError("not_playing", "Nothing is loaded in the player.");
  if (r.state === "elsewhere") throw new ActorError("not_here", "Another tab of this profile holds the player.");
}

export async function pause(tab: Tab): Promise<PlayerReading> {
  await here(tab);
  const b = bar(tab.page);
  const pauseButton = b.getByRole("button", { name: t("pause_label"), exact: true });
  if (await pauseButton.count()) await pauseButton.click({ timeout: tab.d.left() });
  await b.getByRole("button", { name: t("play_label"), exact: true }).waitFor({ timeout: tab.d.left() });
  await until(tab.d, "the audio to stop", async () => (await audio(tab.page))?.paused ?? true);
  return readPlayer(tab);
}

/** Generation is which source the element plays and how often it has sought: what a seek must change. */
interface Generation {
  src: string;
  stream: string | null;
  seeked: number;
}

/** generation reads the element's source, the stream last asked for (a MediaSource-fed element's), and its seeked count. */
async function generation(tab: Tab): Promise<Generation | null> {
  const g = await tab.page.evaluate(() => {
    const a = document.querySelector("audio") as (HTMLAudioElement & { ntpSeeked?: number }) | null;
    if (!a) return null;
    if (a.ntpSeeked === undefined) {
      a.ntpSeeked = 0;
      a.addEventListener("seeked", () => a.ntpSeeked!++);
    }
    return { src: a.currentSrc || a.src, seeked: a.ntpSeeked };
  });
  return g && { ...g, stream: tab.net.stream };
}

/**
 * seek moves the player screen's position bar. It succeeds only when the
 * audio itself is there, not when the screen shows it: after the seek, the
 * element has sought or plays a new source (a new generation), has finished
 * seeking, holds data, and is at the target, within -0.25 s to +1.5 s on the
 * episode's timeline (a converted stream must start at the target). While
 * playing, the audio must then go on at least 0.5 s from where it arrived.
 */
export async function seek(tab: Tab, positionMs: number): Promise<PlayerReading> {
  await here(tab);
  const p = tab.page;
  const wasPlaying = (await readPlayer(tab)).state === "playing";
  const before = await generation(tab);
  const title = (await bar(p).locator(".player-bar-title").innerText()).trim();
  await bar(p).locator(".player-bar-open").click({ timeout: tab.d.left() });
  const screenDialog = p.getByRole("dialog", { name: title, exact: true });
  await screenDialog.waitFor({ timeout: tab.d.left() });
  const slider = screenDialog.getByRole("slider", { name: w("position_bar"), exact: true });
  const max = Number(await slider.getAttribute("max", { timeout: tab.d.left() })) || Number.POSITIVE_INFINITY;
  const target = Math.min(Math.max(0, Math.round(positionMs)), max); // the player keeps a seek within the episode
  await slider.fill(String(target), { timeout: tab.d.left() });
  let last: Transport | null = null;
  let arrived: number | null = null;
  const lastSeen = () => ({ target_ms: target, transport: last, arrived_ms: arrived });
  try {
    await until(
      tab.d,
      `the audio to reach ${target} ms`,
      async () => {
        last = await transport(tab);
        const now = await generation(tab);
        if (!last || !now || !before || !last.described || last.seeking || last.ready < HAVE_CURRENT_DATA) return false;
        // Only what the seek did counts: the element sought, or plays another source, since it began.
        if (now.src === before.src && now.stream === before.stream && now.seeked === before.seeked) return false;
        if (last.source === "converted" && Math.abs(last.offset_ms - target) > 1_000) return false; // an earlier stream
        if (last.position_ms < target - 250 || last.position_ms > target + 1_500) return false;
        arrived = last.position_ms;
        return true;
      },
      lastSeen,
    );
    if (wasPlaying) {
      await until(tab.d, `the audio to play on from ${target} ms`, async () => {
        last = await transport(tab);
        return !!last && !last.paused && last.position_ms >= arrived! + 500 && last.position_ms <= arrived! + 15_000;
      }, lastSeen);
    }
  } finally {
    // The player screen closes as a person closes it (Escape), also after a failure, so the next command finds the bar.
    if (await screenDialog.count()) await p.keyboard.press("Escape");
  }
  await screenDialog.waitFor({ state: "detached", timeout: tab.d.left() });
  return readPlayer(tab);
}

/** HTMLMediaElement.HAVE_CURRENT_DATA: the element has the data at its position. */
const HAVE_CURRENT_DATA = 2;

// ---- import

export interface ImportReading {
  state: "published" | "failed" | "running" | "error";
  text: string;
  imported?: { podcasts: number; episodes: number; queue: number; favorites: number; history: number; inbox: number };
  skipped?: number;
  merged?: number;
  ambiguous?: number;
}

/** importFile chooses a file in Add podcast's import, and waits for the import's result unless wait is "started". */
export async function importFile(tab: Tab, a: { file: string; kind: "opml" | "android_db"; wait: "result" | "started" }): Promise<ImportReading> {
  const p = tab.page;
  await screen(tab, "/add", t("add_feed_label"));
  const input = p.locator(`.import input[type=file][accept^=${css(a.kind === "opml" ? ".opml" : ".db")}]`);
  await input.setInputFiles(a.file, { timeout: tab.d.left() });
  if (a.wait === "started") {
    await until(tab.d, "the import to start", async () => (await p.locator(".import [role=status]").count()) > 0);
    return importReading(tab);
  }
  return importResult(tab);
}

/** importResult waits for the account's import to finish: on Add podcast if the tab is there, else in Settings. */
export async function importResult(tab: Tab): Promise<ImportReading> {
  if (!(await tab.page.locator(".import").count())) {
    await screen(tab, "/settings", t("settings_label"));
  }
  // A published import is finished once its report shows what it imported.
  let last: ImportReading | undefined;
  return until(
    tab.d,
    "the import's result",
    async () => {
      last = await importReading(tab);
      return last.state === "running" || (last.state === "published" && !last.imported) ? undefined : last;
    },
    async () => ({ last, report: await tab.page.locator(".import-report").allInnerTexts() }),
  );
}

async function importReading(tab: Tab): Promise<ImportReading> {
  const p = tab.page;
  const error = p.locator(".import > p[role=status]", { hasText: new RegExp(`^${t("import_error_label")}:`) });
  if (await error.count()) return { state: "error", text: (await error.innerText()).trim() };
  const report = p.locator(".import-report");
  if (!(await report.count())) return { state: "running", text: (await p.locator(".import > p[role=status]").allInnerTexts()).join(" ").trim() };
  const lines = (await report.locator(":scope > p").allInnerTexts()).map((s) => s.trim());
  const text = lines[0] ?? "";
  const kinds = [w("import_kind_opml"), w("import_kind_android_db")];
  const state = kinds.some((k) => text === w("import_status_published", k))
    ? "published"
    : kinds.some((k) => text.startsWith(w("import_status_failed", k, "")))
      ? "failed"
      : "running";
  const out: ImportReading = { state, text };
  const counts = new RegExp(`^${w("import_imported", "§", "§", "§", "§", "§", "§").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/§/g, "(\\d+)")}$`).exec(lines[1] ?? "");
  if (counts) {
    const [podcasts, episodes, queue, favorites, history, inbox] = counts.slice(1).map(Number) as [number, number, number, number, number, number];
    out.imported = { podcasts, episodes, queue, favorites, history, inbox };
  }
  for (const [key, label] of [["skipped", w("import_skipped")], ["merged", w("import_merged")], ["ambiguous", w("import_ambiguous")]] as const) {
    const summary = report.locator("summary", { hasText: new RegExp(`^${label} \\(\\d+\\)$`) });
    out[key] = (await summary.count()) ? Number(/\((\d+)\)$/.exec((await summary.innerText()).trim())?.[1] ?? 0) : 0;
  }
  return out;
}

// ---- readings

export async function readEpisode(tab: Tab, e: EpisodeRef): Promise<Row> {
  await podcastScreen(tab, e.podcast_id);
  await rowOf(tab, e.episode_id, "its podcast's screen");
  const row = (await rows(tab.page)).find((r) => r.episode_id === e.episode_id);
  if (!row) throw new ActorError("not_found", "The episode's row went away while it was read.");
  return row;
}

export interface ListReading {
  episodes: Row[];
  /** The drawer's counters. */
  counters: { queue: number; inbox: number };
  /** The toolbar's count, where the screen shows one (the queue's "3 episodes"). */
  toolbar_info: string | null;
}

export async function readList(tab: Tab, which: ListName): Promise<ListReading> {
  await listScreen(tab, which);
  await loadAll(tab, rowsOf(".content"));
  const info = tab.page.locator(".toolbar .toolbar-info");
  return {
    episodes: await rows(tab.page),
    counters: await counters(tab.page),
    toolbar_info: (await info.count()) ? (await info.innerText()).trim() : null,
  };
}

async function counters(page: Page): Promise<{ queue: number; inbox: number }> {
  return page.evaluate(() => {
    const n = (href: string) => Number(document.querySelector(`nav.drawer a.nav-item[href="${href}"] .nav-count`)?.textContent ?? 0);
    return { queue: n("/queue"), inbox: n("/inbox") };
  });
}

export async function readSubscriptions(tab: Tab): Promise<{ podcasts: { podcast_id: string; title: string; counter: number }[] }> {
  await screen(tab, "/subscriptions", t("subscriptions_label"));
  // While it loads, the screen shows an empty grid; loaded, it shows tiles or its empty state.
  await tab.page.locator(".content .subscription-grid > li, .content .empty").first().waitFor({ timeout: tab.d.left() });
  await loadAll(tab, ".subscription-grid > li");
  const podcasts = await tab.page.evaluate(() =>
    [...document.querySelectorAll(".subscription-grid > li > a.subscription-tile")].map((a) => ({
      podcast_id: decodeURIComponent((a.getAttribute("href") ?? "").slice("/podcast/".length)),
      title: a.querySelector(".subscription-title")?.textContent ?? "",
      counter: Number(a.querySelector(".subscription-count")?.textContent ?? 0),
    })),
  );
  return { podcasts };
}

async function statisticsScreen(tab: Tab): Promise<void> {
  await screen(tab, "/statistics", t("statistics_label"));
  await tab.page.locator(".statistics-total").waitFor({ timeout: tab.d.left() });
}

export interface StatisticsReading {
  /** The total played time shown, in whole minutes. */
  total_ms: number | null;
  total_text: string;
  podcasts: { podcast_id: string; title: string; played_ms: number | null; text: string }[];
  months: { month: string; played_ms: number | null; text: string }[];
}

export async function readStatistics(tab: Tab): Promise<StatisticsReading> {
  const p = tab.page;
  await statisticsScreen(tab);
  const totalText = (await p.locator(".statistics-total strong").innerText()).trim();
  const podcasts = (
    await p.evaluate(() =>
      [...document.querySelectorAll(".statistics-list > li > a")].map((a) => ({
        podcast_id: decodeURIComponent((a.getAttribute("href") ?? "").slice("/podcast/".length)),
        title: a.querySelector(".statistics-title")?.textContent ?? "",
        text: (a.querySelector(".statistics-value")?.textContent ?? "").trim(),
      })),
    )
  ).map((r) => ({ ...r, played_ms: minutes(r.text) }));
  await p.getByRole("tab", { name: t("years_statistics_label"), exact: true }).click({ timeout: tab.d.left() });
  await p.locator(".years-list").waitFor({ state: "attached", timeout: tab.d.left() });
  const months = (
    await p.evaluate(() =>
      [...document.querySelectorAll(".years-list > li")].map((li) => {
        const spans = li.querySelectorAll(":scope > span");
        return { month: (spans[0]?.textContent ?? "").trim(), text: (spans[2]?.textContent ?? "").trim() };
      }),
    )
  ).map((m) => ({ ...m, played_ms: minutes(m.text) }));
  await p.getByRole("tab", { name: t("subscriptions_label"), exact: true }).click({ timeout: tab.d.left() });
  return { total_ms: minutes(totalText), total_text: totalText, podcasts, months };
}

export interface NoticeReading {
  /** The app says it cannot reach the server. */
  unreachable: boolean;
  /** Every banner shown (unreachable, refused, paused, waiting, recovery), with its role. */
  banners: { role: string; text: string }[];
  snackbars: string[];
}

export async function readNotice(page: Page): Promise<NoticeReading> {
  return page.evaluate((unreachable) => {
    const banners = [...document.querySelectorAll(".banner")].map((b) => ({ role: b.getAttribute("role") ?? "", text: (b.textContent ?? "").trim() }));
    const snackbars = [...document.querySelectorAll(".snackbar > span")].map((s) => (s.textContent ?? "").trim());
    return { unreachable: banners.some((b) => b.text === unreachable), banners, snackbars };
  }, w("server_unreachable"));
}

/**
 * readDiagnostics is an account's diagnostics as the server gives them to
 * this profile's session (an administrator may name any account, by its ID
 * or username): the web client shows only the account's own, in Settings.
 */
export async function readDiagnostics(tab: Tab, a: { account?: string; fact?: string }): Promise<Record<string, unknown>> {
  const q = new URLSearchParams();
  if (a.account) {
    let id = a.account;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      const list = await api<{ accounts: { account_id: string; username: string }[] | null }>(tab, "/v1/admin/accounts");
      const found = (list.accounts ?? []).find((x) => x.username === a.account);
      if (!found) throw new ActorError("not_found", `No account is named ${JSON.stringify(a.account)}.`);
      id = found.account_id;
    }
    q.set("account", id);
  }
  if (a.fact) q.set("fact", a.fact);
  return api(tab, `/v1/diagnostics${q.size ? `?${q}` : ""}`);
}
