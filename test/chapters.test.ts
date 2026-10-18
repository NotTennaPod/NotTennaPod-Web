// Chapters files (podcast:chapters) as AntennaPod 3.12.1 reads and merges
// them: PodcastIndexChapterParser (startTime in whole seconds, title, url,
// img, the file's order, every chapter kept), ChapterMerger with the feed's
// chapters, and the player's read of the file through the server, once per
// episode, a failure being no chapters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { chapterFile, episodeChapters, mergeChapters, podcastIndexChapters, useChapters } from "../src/player/chapters.ts";
import type { Chapter, EpisodeInfo } from "../src/player/engine.ts";

const ch = (start: number, title: string, link: string | null = null, image: string | null = null): Chapter => ({ start, title, link, image });

test("a chapters file: startTime in seconds, title, url and img; missing fields empty", () => {
  const file = {
    version: "1.2.0",
    chapters: [
      { startTime: 0, title: "Intro", url: "https://example.com/a", img: "https://example.com/a.jpg" },
      { startTime: 90.75, title: "Fraction" }, // org.json's optInt truncates
      { startTime: " 120 ", title: "Text start" }, // a numeric string counts
      { title: "No start" }, // optInt's default
      { startTime: 300 }, // optString's default: ""
      { startTime: "soon", title: null, url: "", img: 7 }, // not a number: 0; JSON null is "null"; values as text
    ],
  };
  assert.deepEqual(podcastIndexChapters(file), [
    ch(0, "Intro", "https://example.com/a", "https://example.com/a.jpg"),
    ch(90_000, "Fraction"),
    ch(120_000, "Text start"),
    ch(0, "No start"),
    ch(300_000, ""),
    ch(0, "null", null, "7"),
  ]);
});

test("a chapters file keeps every chapter in the file's order: toc false is listed, nothing is sorted (as AntennaPod 3.12.1)", () => {
  const file = {
    chapters: [
      { startTime: 0, title: "Intro" },
      { startTime: 30, title: "Artwork only", toc: false, img: "https://example.com/b.jpg" },
      { startTime: 600, title: "Late" },
      { startTime: 120, title: "Early" },
    ],
  };
  assert.deepEqual(
    podcastIndexChapters(file)!.map((c) => [c.start, c.title]),
    [
      [0, "Intro"],
      [30_000, "Artwork only"],
      [600_000, "Late"],
      [120_000, "Early"],
    ],
  );
  assert.deepEqual(podcastIndexChapters({ chapters: [] }), []);
});

test("a body that is not a chapters file has no chapters", () => {
  for (const body of [{}, { chapters: {} }, { chapters: "x" }, [{ startTime: 0 }], "chapters", null, 3, { chapters: [{ startTime: 0, title: "A" }, 5] }, { chapters: [null] }]) {
    assert.equal(podcastIndexChapters(body), null, JSON.stringify(body));
  }
});

/** withFetch answers the page's requests with fn for the length of run. */
async function withFetch(fn: (url: string) => Response, run: () => Promise<void>): Promise<string[]> {
  const saved = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (u: string | URL | Request) => {
    urls.push(String(u));
    return fn(String(u));
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = saved;
  }
  return urls;
}

test("the file is read through the server once per episode; bad JSON, a refusal or no answer is no chapters, and a failure is read again", async () => {
  const good = JSON.stringify({ chapters: [{ startTime: 0, title: "One" }, { startTime: 60, title: "Two" }] });
  const urls = await withFetch(
    (url) => {
      if (url.includes("good")) return new Response(good, { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.includes("bad")) return new Response("{ chapters: [", { status: 200 });
      return new Response(JSON.stringify({ error: "media_unavailable", message: "x" }), { status: 502 });
    },
    async () => {
      assert.deepEqual(await chapterFile("ep good"), [ch(0, "One"), ch(60_000, "Two")]);
      assert.deepEqual(await chapterFile("ep good"), [ch(0, "One"), ch(60_000, "Two")]); // kept: not read again
      assert.equal(await chapterFile("ep bad"), null);
      assert.equal(await chapterFile("ep refused"), null);
      assert.equal(await chapterFile("ep refused"), null); // a failure is not kept: read again
      assert.deepEqual(await chapterFile("ep good", true), [ch(0, "One"), ch(60_000, "Two")]); // Refresh reads again
    },
  );
  assert.deepEqual(urls, ["/v1/media/ep%20good/chapters", "/v1/media/ep%20bad/chapters", "/v1/media/ep%20refused/chapters", "/v1/media/ep%20refused/chapters", "/v1/media/ep%20good/chapters"]);
  let calls = 0;
  const unreachable = () => {
    calls++;
    return Promise.reject(new TypeError("Failed to fetch"));
  };
  assert.equal(await chapterFile("offline", false, unreachable), null);
  assert.equal(await chapterFile("offline", false, unreachable), null);
  assert.equal(calls, 2);
});

test("merging: no list gives the other; the longer list wins, whichever source it is", () => {
  const feed = [ch(0, "Feed A"), ch(60_000, "Feed B")];
  const file = [ch(0, "File A"), ch(30_000, "File B"), ch(60_000, "File C")];
  assert.equal(mergeChapters(null, null), null);
  assert.equal(mergeChapters(feed, null), feed);
  assert.equal(mergeChapters(null, file), file);
  assert.equal(mergeChapters(feed, file), file);
  assert.equal(mergeChapters(file, feed), file);
  assert.deepEqual(mergeChapters(feed, []), feed); // an empty file loses to the feed's chapters
});

test("merging lists of one length: the file's chapters, taking the feed's title, link and image where they have none", () => {
  const feed = [ch(0, "Feed A", "https://example.com/a", "https://example.com/a.jpg"), ch(60_000, "Feed B", "https://example.com/b")];
  const file = [ch(0, "", null, "https://example.com/file.jpg"), ch(60_900, "File B")];
  const before = structuredClone(file);
  assert.deepEqual(mergeChapters(feed, file), [
    ch(0, "Feed A", "https://example.com/a", "https://example.com/file.jpg"),
    ch(60_900, "File B", "https://example.com/b"),
  ]);
  assert.deepEqual(file, before, "the read file is not changed");
});

test("merging lists of one length whose starts differ by more than a second: the one with more titles, links and images wins", () => {
  const feed = [ch(0, "A", "https://example.com/a"), ch(60_000, "B", "https://example.com/b")];
  assert.deepEqual(mergeChapters(feed, [ch(0, "A"), ch(61_001, "B")]), feed);
  // A tie goes to the file, with what it took before the starts parted.
  const file = [ch(0, "", "https://example.com/x", "https://example.com/x.jpg"), ch(90_000, "Late", "https://example.com/y", "https://example.com/y.jpg")];
  const feedTitles = [ch(0, "One", "https://example.com/1", "https://example.com/1.jpg"), ch(60_000, "Two", "https://example.com/2", "https://example.com/2.jpg")];
  assert.deepEqual(mergeChapters(feedTitles, file), [ch(0, "One", "https://example.com/x", "https://example.com/x.jpg"), file[1]]);
});

test("an episode's chapters: the feed's alone, the file's alone, or both merged", () => {
  const file = [ch(0, "File A"), ch(60_000, "File B")];
  assert.deepEqual(episodeChapters(undefined, null), []);
  assert.deepEqual(episodeChapters([], file), file);
  assert.deepEqual(episodeChapters([ch(0, "Feed")], null), [ch(0, "Feed")]);
  assert.deepEqual(episodeChapters([ch(0, "Feed")], file), file);
  assert.deepEqual(episodeChapters([ch(0, "Feed")], []), [ch(0, "Feed")]);
});

test("a read that is not a chapters file is read again; an older read's answer never evicts a newer Refresh", async () => {
  let reads = 0;
  const invalid = () => {
    reads++;
    return Promise.resolve({ chapters: "invalid" });
  };
  assert.equal(await chapterFile("invalid", false, invalid), null);
  assert.equal(await chapterFile("invalid", false, invalid), null);
  assert.equal(reads, 2, "a null parse is not kept");
  assert.deepEqual(await chapterFile("invalid", false, async () => ({ chapters: [{ startTime: 0, title: "Fixed" }] })), [ch(0, "Fixed")]);
  // The first read answers nothing usable only after a Refresh read the file well.
  let answerOld!: (v: unknown) => void;
  const old = chapterFile("raced", false, () => new Promise((r) => (answerOld = r)));
  const fresh = await chapterFile("raced", true, async () => ({ chapters: [{ startTime: 0, title: "New" }] }));
  answerOld({ chapters: 1 });
  assert.equal(await old, null);
  let later = 0;
  assert.deepEqual(await chapterFile("raced", false, async () => (later++, {})), fresh);
  assert.equal(later, 0, "the Refresh's chapters stay kept");
});

/** A page with the player's chapters hook, and a server whose chapter answers wait until let go. */
async function withHook(run: (t: {
  show: (e: EpisodeInfo, open: boolean) => Promise<void>;
  unmount: () => Promise<void>;
  hook: () => ReturnType<typeof useChapters>;
  pending: { url: string; answer: (r: Response) => void }[];
  settle: () => Promise<void>;
}) => Promise<void>): Promise<void> {
  const win = new Window();
  const saved = globalThis.fetch;
  Object.assign(globalThis, { window: win, document: win.document });
  const pending: { url: string; answer: (r: Response) => void }[] = [];
  globalThis.fetch = ((u: string | URL | Request) => new Promise<Response>((answer) => pending.push({ url: String(u), answer }))) as typeof fetch;
  const { h, render } = await import("preact");
  const { act } = await import("preact/test-utils");
  const root = document.createElement("div");
  document.body.append(root);
  let current!: ReturnType<typeof useChapters>;
  function Probe({ e, open }: { e: EpisodeInfo; open: boolean }) {
    current = useChapters(e, true, open);
    return null;
  }
  const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));
  try {
    await run({
      show: async (e, open) => {
        await act(async () => render(h(Probe, { e, open }), root));
        await settle();
      },
      unmount: async () => {
        await act(async () => render(null, root));
        await settle();
      },
      hook: () => current,
      pending,
      settle,
    });
    render(null, root);
  } finally {
    globalThis.fetch = saved;
    await win.happyDOM.close();
  }
}

const episode = (id: string): EpisodeInfo => ({ episode_id: id, podcast_id: "p", title: id, podcast: "Show", image: "", description: null, chapters: [], chapter_file: true });
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const titles = (hook: ReturnType<typeof useChapters>) => hook.chapters.map((c) => c.title);

test("opening the player reads a chapters file again after a failed read, and never on a render", async () => {
  await withHook(async ({ show, hook, pending, settle }) => {
    const e = episode("reopened");
    await show(e, false);
    assert.equal(pending.length, 1);
    pending[0]!.answer(answer({ error: "media_unavailable", message: "x" }, 502));
    await settle();
    assert.deepEqual(titles(hook()), []);
    await show({ ...e }, false); // a render of the same episode (a new position) reads nothing
    assert.equal(pending.length, 1);
    await show(e, true); // the player screen opens
    assert.equal(pending.length, 2, "the failed read is tried again");
    pending[1]!.answer(answer({ chapters: [{ startTime: 0, title: "One" }, { startTime: 60, title: "Two" }] }));
    await settle();
    assert.deepEqual(titles(hook()), ["One", "Two"]);
    await show(e, false);
    await show(e, true);
    assert.equal(pending.length, 2, "a file read well is not read again");
    assert.deepEqual(titles(hook()), ["One", "Two"]);
  });
});

test("a Refresh that answers after the episode changed leaves the new episode's chapters alone", async () => {
  await withHook(async ({ show, hook, pending, settle }) => {
    await show(episode("A"), true);
    pending[0]!.answer(answer({ chapters: [{ startTime: 0, title: "A" }, { startTime: 60, title: "A second" }] }));
    await settle();
    assert.deepEqual(titles(hook()), ["A", "A second"]);
    const refreshed = hook().refresh!(); // A's Refresh, answered late
    await settle();
    assert.equal(pending.length, 2);
    await show(episode("B"), true);
    assert.equal(pending.length, 3);
    pending[2]!.answer(answer({ chapters: [{ startTime: 0, title: "B" }, { startTime: 60, title: "B second" }] }));
    await settle();
    assert.deepEqual(titles(hook()), ["B", "B second"]);
    pending[1]!.answer(answer({ chapters: [{ startTime: 0, title: "A new" }] }));
    assert.equal(await refreshed, null, "the late Refresh is no answer for the dialog");
    await settle();
    assert.deepEqual(titles(hook()), ["B", "B second"]);
  });
});

// The chapters list acts on Refresh's answer only when it is a list (Player.tsx ChaptersDialog):
// an empty one closes it with "No chapters"; null leaves it as it is.
test("a Refresh that answers after a switch to an episode without a chapters file is no answer: the new episode's list stays", async () => {
  await withHook(async ({ show, hook, pending, settle }) => {
    await show(episode("C"), true);
    pending[0]!.answer(answer({ chapters: [{ startTime: 0, title: "C" }] }));
    await settle();
    const refreshed = hook().refresh!(); // C's Refresh, answered late and empty
    await settle();
    assert.equal(pending.length, 2);
    const d = { ...episode("D"), chapter_file: false, chapters: [ch(0, "D feed"), ch(60_000, "D feed second")] };
    await show(d, true);
    assert.equal(pending.length, 2, "an episode without a chapters file reads none");
    assert.deepEqual(titles(hook()), ["D feed", "D feed second"]);
    pending[1]!.answer(answer({ chapters: [] }));
    assert.equal(await refreshed, null, "D's list is not closed, and no notice is shown");
    await settle();
    assert.deepEqual(titles(hook()), ["D feed", "D feed second"]);
  });
});

test("a Refresh outstanding when the player goes away is no answer", async () => {
  await withHook(async ({ show, hook, pending, settle, unmount }) => {
    await show(episode("E"), true);
    pending[0]!.answer(answer({ chapters: [{ startTime: 0, title: "E" }] }));
    await settle();
    const refreshed = hook().refresh!();
    await settle();
    await unmount();
    pending[1]!.answer(answer({ chapters: [] }));
    assert.equal(await refreshed, null);
  });
});
