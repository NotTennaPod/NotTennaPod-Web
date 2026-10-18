// Chapters from a Podcast Index chapters file (podcast:chapters), read
// through the server (PROTOCOL §13), and merged with the feed's chapters as
// AntennaPod 3.12.1 does: PodcastIndexChapterParser, ChapterMerger and
// ChapterUtils.loadChapters. Chapters embedded in the audio file are not read.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { currentAccount, get } from "../api/http.ts";
import type { Chapter, EpisodeInfo } from "./engine.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** javaInt is org.json's optInt: a number or a numeric string, truncated to an int; anything else is 0. */
function javaInt(v: unknown): number {
  let n = typeof v === "number" ? v : NaN;
  // Double.parseDouble's forms (a trailing f or d too); parseFloat reads them all.
  if (typeof v === "string" && /^[+-]?(NaN|Infinity|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[fFdD]?)$/.test(v.trim())) n = Number.parseFloat(v.trim());
  if (Number.isNaN(n)) return 0;
  return Math.max(-2147483648, Math.min(2147483647, Math.trunc(n)));
}

/** javaString is org.json's optString: a missing field is "", any other value its text (JSON null is "null", as on Android). */
function javaString(v: unknown): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  if (v === null || typeof v !== "object") return String(v);
  return JSON.stringify(v);
}

/**
 * podcastIndexChapters is PodcastIndexChapterParser.parse: each chapter's
 * startTime (whole seconds), title, url and img, in the file's order, every
 * chapter kept (AntennaPod 3.12.1 neither reads `toc` nor sorts). A body
 * that is not a chapters file is null.
 */
export function podcastIndexChapters(body: unknown): Chapter[] | null {
  const list = isObject(body) ? body.chapters : undefined;
  if (!Array.isArray(list)) return null;
  const chapters: Chapter[] = [];
  for (const c of list) {
    if (!isObject(c)) return null;
    chapters.push({ start: javaInt(c.startTime) * 1000, title: javaString(c.title), link: javaString(c.url) || null, image: javaString(c.img) || null });
  }
  return chapters;
}

const score = (chapters: Chapter[]) => chapters.reduce((n, c) => n + (c.title ? 1 : 0) + (c.link ? 1 : 0) + (c.image ? 1 : 0), 0);

/**
 * mergeChapters is ChapterMerger.merge: the longer list wins; lists of the
 * same length are one list, the second's chapters taking the first's title,
 * link and image where they have none, unless two starts differ by more than
 * a second: then the list with more titles, links and images wins (the
 * second on a tie, with what it took so far). null is no list.
 */
export function mergeChapters(first: Chapter[] | null, second: Chapter[] | null): Chapter[] | null {
  if (!first) return second;
  if (!second) return first;
  if (second.length !== first.length) return second.length > first.length ? second : first;
  const merged = second.map((c) => ({ ...c }));
  for (let i = 0; i < merged.length; i++) {
    const target = merged[i]!;
    const other = first[i]!;
    if (Math.abs(target.start - other.start) > 1000) return score(first) > score(merged) ? first : merged;
    if (!target.image) target.image = other.image;
    if (!target.link) target.link = other.link;
    if (!target.title) target.title = other.title;
  }
  return merged;
}

type FetchFile = (episodeId: string) => Promise<unknown>;

const fetchFile: FetchFile = (id) => get(`/v1/media/${encodeURIComponent(id)}/chapters`);

/** loaded keeps the chapters files read this page load, a few episodes' worth, and the reads in flight; a read that gave no chapters file is not kept. */
const loaded = new Map<string, Promise<Chapter[] | null>>();

/**
 * chapterFile reads the episode's chapters file once (ChapterUtils.loadChaptersFromUrl);
 * refresh reads it again (ChaptersFragment's Refresh). A read that fails, or a file
 * that is not a chapters file, is no chapters, and no error is shown, as on Android;
 * it is read again when next asked for.
 */
export function chapterFile(episodeId: string, refresh = false, read: FetchFile = fetchFile): Promise<Chapter[] | null> {
  const key = `${currentAccount() ?? ""} ${episodeId}`;
  const known = loaded.get(key);
  if (known && !refresh) return known;
  const p: Promise<Chapter[] | null> = read(episodeId)
    .then(podcastIndexChapters, () => null)
    .then((chapters) => {
      // Only this read's own entry: a newer read (a Refresh) keeps its place.
      if (chapters === null && loaded.get(key) === p) loaded.delete(key);
      return chapters;
    });
  loaded.delete(key);
  loaded.set(key, p);
  if (loaded.size > 8) loaded.delete(loaded.keys().next().value!);
  return p;
}

/** episodeChapters is ChapterUtils.loadChapters without the media file: the feed's chapters merged with the chapters file's. */
export function episodeChapters(feed: Chapter[] | undefined, file: Chapter[] | null): Chapter[] {
  return mergeChapters(feed?.length ? feed : null, file) ?? [];
}

/**
 * useChapters is the episode's chapters while the player holds it here: the
 * chapters file is read once per episode, and asked for again each time the
 * player screen opens or closes (open), so a read that failed is tried again
 * (one that succeeded, or is in flight, is not read again). refresh reads it
 * again and gives the merged chapters, or null when another episode or read
 * has taken over meanwhile. Only the newest load's answer is applied: a
 * change of episode (to one with or without a chapters file), of the player
 * screen, or of the player itself makes every load and Refresh begun before
 * it stale.
 */
export function useChapters(
  e: EpisodeInfo | null,
  active: boolean,
  open: boolean,
): { chapters: Chapter[]; refresh: (() => Promise<Chapter[] | null>) | null } {
  const [file, setFile] = useState<{ id: string; chapters: Chapter[] | null } | null>(null);
  const latest = useRef(0); // the newest load or Refresh: only its answer is applied
  const id = active && e?.chapter_file ? e.episode_id : null;
  useEffect(() => {
    if (!id) return;
    const mine = ++latest.current;
    void chapterFile(id).then((chapters) => latest.current === mine && setFile({ id, chapters }));
    return () => {
      latest.current++; // this load and any Refresh begun since are stale
    };
  }, [id, open]);
  const fromFile = file && file.id === id ? file.chapters : null;
  const chapters = useMemo(() => episodeChapters(e?.chapters, fromFile), [e?.chapters, fromFile]);
  const feed = e?.chapters;
  const refresh = id
    ? async () => {
        const mine = ++latest.current;
        const chapters = await chapterFile(id, true);
        if (latest.current !== mine) return null;
        setFile({ id, chapters });
        return episodeChapters(feed, chapters);
      }
    : null;
  return { chapters, refresh };
}
