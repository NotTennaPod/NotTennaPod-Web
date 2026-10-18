// The read API's views (NotTennaPod-Server PROTOCOL §12), typed.
import { get, post, type Query } from "./http.ts";

export interface Head {
  cursor: string;
  log_id: string;
  epoch: number;
  seq: number;
}

export interface RecordValue {
  value: Record<string, unknown>;
  provenance: string[];
}

export type Records = Record<string, RecordValue | undefined>;

export interface Counters {
  queue: number;
  inbox: number;
}

export type PlayState = "new" | "unplayed" | "played";

export interface EpisodeRow {
  episode_id: string;
  podcast_id: string;
  title: string | null;
  pub_date: number;
  link: string | null;
  image_url: string;
  has_media: boolean;
  duration_ms: number | null;
  size: number | null;
  play_state: PlayState;
  position: number;
  favorite: boolean;
  in_queue: boolean;
  history: number | null;
  last_played: number;
  placeholder: boolean;
  podcast: { title: string | null; display_title: string; image_url: string; state: PodcastState; generation_id?: string };
  records: Records;
  metadata?: Record<string, unknown>; // the episode view only: the whole record, show notes included
}

export type PodcastState = "subscribed" | "archived" | "not_subscribed";

export interface PodcastRow {
  podcast_id: string;
  title: string | null;
  display_title: string; // the title, else the feed's address
  generation_id?: string;
  image_url: string;
  state: PodcastState;
  keep_updated: boolean;
  credentials: boolean | { set: boolean; username?: string | null };
  records: Records;
  counter?: number;
  statistics?: StatisticsRow;
}

export interface StatisticsRow {
  played_ms: number;
  played_marked_ms: number;
  episodes_started: number;
  episodes_started_marked: number;
  episodes: number;
  total_ms: number;
  oldest_date: number | null;
  podcast?: { podcast_id: string; title: string | null; display_title: string; image_url: string; state: PodcastState };
}

export interface ListPage<T> {
  head: Head;
  view: { counters: Counters };
  total: number;
  items: T[];
  next_page_token: string | null;
  /** A window's (a first request with an anchor): the index of its first item, the page before it, and the view's first page. */
  offset?: number;
  prev_page_token?: string | null;
  start_page_token?: string;
}

export interface Installation {
  install_id: string;
  name: string;
  platform: string;
  app_version: string;
  capabilities: string[];
  created_at: number;
  last_seen_at: number;
  revoked: boolean;
  superseded: boolean;
  current: boolean;
}

export interface Summary {
  head: Head;
  counters: Counters;
  account_id: string;
  policies: {
    new_episodes_action: "inbox" | "queue" | "nothing";
    queue: { enqueue_location: string; keep_sorted: boolean; sort_order: string };
  };
  records: Records;
  installations: Installation[];
  import: { import_id: string; status: string; kind: string } | null;
}

export interface Home {
  head: Head;
  counters: Counters;
  continue: EpisodeRow[];
  new: EpisodeRow[];
  new_count: number;
  surprise: EpisodeRow[];
  classics: PodcastRow[];
}

export interface Statistics {
  head: Head;
  counters: Counters;
  podcasts: StatisticsRow[];
  months: { year: number; month: number; played_ms: number }[];
  played_ms: number;
  oldest_date: number;
}

export interface Preview {
  url?: string;
  podcast_id?: string;
  observed?: { podcast_id: string; generation_id: string; state: string }; // the account removed the podcast: what a re-subscribe observes
  error?: { label: string; code?: number; detail?: string; origin?: string };
  links?: { url: string; title: string }[];
  feed?: {
    title: string | null;
    author: string | null;
    description: string | null;
    language: string | null;
    link: string | null;
    image_url: string | null;
    type: string;
    item_count: number;
    items: {
      title: string | null;
      pub_date: number | null;
      description: string | null;
      image_url: string | null;
      link: string | null;
      media: { duration_ms: number; size: number; mime_type: string | null } | null;
    }[];
  };
}

export const reads = {
  summary: (signal?: AbortSignal) => get<Summary>("/v1/read/summary", undefined, signal),
  home: (q: Query, signal?: AbortSignal) => get<Home>("/v1/read/home", q, signal),
  subscriptions: (q: Query, signal?: AbortSignal) => get<ListPage<PodcastRow>>("/v1/read/subscriptions", q, signal),
  episodes: (q: Query, signal?: AbortSignal) => get<ListPage<EpisodeRow>>("/v1/read/episodes", q, signal),
  podcastEpisodes: (id: string, q: Query, signal?: AbortSignal) =>
    get<ListPage<EpisodeRow>>(`/v1/read/podcasts/${encodeURIComponent(id)}/episodes`, q, signal),
  podcast: (id: string, signal?: AbortSignal) =>
    get<{ head: Head; counters: Counters; podcast: PodcastRow }>(`/v1/read/podcasts/${encodeURIComponent(id)}`, undefined, signal),
  episode: (id: string, signal?: AbortSignal) =>
    get<{ head: Head; counters: Counters; episode: EpisodeRow; podcast: PodcastRow }>(
      `/v1/read/episodes/${encodeURIComponent(id)}`,
      undefined,
      signal,
    ),
  queue: (q: Query, signal?: AbortSignal) => get<ListPage<EpisodeRow>>("/v1/read/queue", q, signal),
  inbox: (q: Query, signal?: AbortSignal) => get<ListPage<EpisodeRow>>("/v1/read/inbox", q, signal),
  favorites: (q: Query, signal?: AbortSignal) => get<ListPage<EpisodeRow>>("/v1/read/favorites", q, signal),
  history: (q: Query, signal?: AbortSignal) => get<ListPage<EpisodeRow>>("/v1/read/history", q, signal),
  statistics: (q: Query, signal?: AbortSignal) => get<Statistics>("/v1/read/statistics", q, signal),
  frontier: (cursor: string) => get<{ cursor: string; frontier: string[] }>("/v1/read/frontier", { cursor }),
  preview: (body: { url: string; username?: string; password?: string }) => post<Preview>("/v1/read/preview", body),
};

/** headAtLeast reports whether a is at or after b (same lineage), so a screen never goes back (PROTOCOL §12). */
export function headAtLeast(a: Head, b: Head | undefined): boolean {
  if (!b) return true;
  if (a.log_id !== b.log_id || a.epoch !== b.epoch) return true; // a new lineage replaces the old
  return a.seq >= b.seq;
}
