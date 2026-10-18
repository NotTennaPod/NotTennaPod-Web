// The player journeys' publisher: a feed over plain HTTP (the server fetches
// it from this machine with --dev-allow-loopback-feeds) whose enclosures are
// WAV files served over HTTPS with a certificate made for the run. Direct
// playback needs HTTPS publisher URLs; the browsers accept the certificate
// through Playwright's ignoreHTTPSErrors, so the app needs no test-only mode.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHTTPS } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wav } from "../../test/fixtures/media/wav.ts";

export interface FixtureEpisode {
  title: string;
  seconds: number;
  /** Podlove simple chapters: start as hh:mm:ss and title. */
  chapters?: [string, string][];
  /** A Podcast Index chapters file (podcast:chapters), served over plain HTTP as the publisher's JSON. */
  chapterFile?: unknown;
  /** The file's format: WAV (default), or one made by ffmpeg that some engines cannot play (PROTOCOL §13). */
  format?: "wav" | "m4a-alac" | "ogg-vorbis" | "mp4-opus";
  /** plain serves the file over plain HTTP, which the browser never plays directly (the relay does). */
  plain?: boolean;
  /** etag gives the file a strong validator, so the server's relay serves byte ranges (seekable) rather than the whole file. */
  etag?: boolean;
  /** delayMs answers every request for the file this much later, the server's and the browser's alike: a publisher behind slow redirects and a slow host. */
  delayMs?: number;
}

const formats = {
  wav: { ext: "wav", type: "audio/wav", codec: null },
  "m4a-alac": { ext: "m4a", type: "audio/mp4", codec: ["-c:a", "alac"] },
  // ffmpeg's own Vorbis encoder (libvorbis may be absent): stereo only, marked experimental.
  "ogg-vorbis": { ext: "ogg", type: "audio/ogg", codec: ["-ac", "2", "-c:a", "vorbis", "-strict", "-2"] },
  // Opus in MP4, which WebKit does not play (ffmpeg's own Opus encoder: stereo, 48 kHz, experimental).
  "mp4-opus": { ext: "mp4", type: "audio/mp4", codec: ["-ac", "2", "-ar", "48000", "-c:a", "opus", "-strict", "-2"] },
} as const;

/** encode makes a tone of the given length in a format ffmpeg writes (a different pitch every 10 s). */
function encode(seconds: number, format: "m4a-alac" | "ogg-vorbis" | "mp4-opus"): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "ntp-media-"));
  try {
    const out = join(dir, `a.${formats[format].ext}`);
    const expr = `sin(2*PI*(300+50*floor(t/10))*t)*0.3`;
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `aevalsrc=${expr}:s=22050:d=${seconds}`, ...formats[format].codec, out]);
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface Publisher {
  feedURL: string;
  mediaOrigin: string;
  /** requests counts media requests per file, to see what the browser fetched. */
  requests: Map<string, number>;
  /** agents lists each media request's path and User-Agent, to tell the server's requests from the browser's. */
  agents: { path: string; agent: string }[];
  /** certificate is the HTTPS origin's certificate (PEM), for a server told to trust it. */
  certificate: string;
  stop: () => Promise<void>;
}

function chapters(e: FixtureEpisode): string {
  if (!e.chapters) return "";
  return `<psc:chapters version="1.2">${e.chapters.map(([start, title]) => `<psc:chapter start="${start}" title="${title}"/>`).join("")}</psc:chapters>`;
}

function certificate(): { key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), "ntp-cert-"));
  try {
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1",
        "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
      { stdio: "ignore" },
    );
    return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** serveRange answers a media request with HTTP ranges, as publishers' servers do (Safari needs them). */
function serveRange(req: IncomingMessage, res: ServerResponse, body: Uint8Array, type = "audio/wav", etag?: string): void {
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "no-store");
  if (etag) res.setHeader("ETag", etag);
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (!m) {
    res.writeHead(200, { "Content-Length": body.length });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }
  let start = m[1] ? Number(m[1]) : body.length - Number(m[2]);
  let end = m[1] && m[2] ? Number(m[2]) : body.length - 1;
  start = Math.max(0, start);
  end = Math.min(end, body.length - 1);
  if (start > end) {
    res.writeHead(416, { "Content-Range": `bytes */${body.length}` }).end();
    return;
  }
  res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${body.length}`, "Content-Length": end - start + 1 });
  res.end(req.method === "HEAD" ? undefined : body.subarray(start, end + 1));
}

export async function startPublisher(show: string, episodes: FixtureEpisode[]): Promise<Publisher> {
  const files = new Map<string, { body: Uint8Array; type: string; etag?: string; delayMs?: number }>();
  episodes.forEach((e, i) => {
    const f = e.format ?? "wav";
    const body = f === "wav" ? wav(e.seconds) : encode(e.seconds, f);
    files.set(`/media/episode-${i + 1}.${formats[f].ext}`, {
      body,
      type: formats[f].type,
      ...(e.etag ? { etag: `"episode-${i + 1}-${body.length}"` } : {}),
      ...(e.delayMs ? { delayMs: e.delayMs } : {}),
    });
  });
  const pathOf = (e: FixtureEpisode, n: number) => `/media/episode-${n}.${formats[e.format ?? "wav"].ext}`;
  const requests = new Map<string, number>();
  const agents: { path: string; agent: string }[] = [];
  const serveMedia = (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "https://x").pathname;
    const file = files.get(path);
    requests.set(path, (requests.get(path) ?? 0) + 1);
    agents.push({ path, agent: req.headers["user-agent"] ?? "" });
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    if (!file.delayMs) serveRange(req, res, file.body, file.type, file.etag);
    else {
      const timer = setTimeout(() => serveRange(req, res, file.body, file.type, file.etag), file.delayMs);
      res.on("close", () => clearTimeout(timer)); // a request given up meanwhile is not answered
    }
  };
  const cert = certificate();
  const media = createHTTPS(cert, serveMedia);
  await new Promise<void>((r) => media.listen(0, "127.0.0.1", r));
  const mediaOrigin = `https://127.0.0.1:${(media.address() as AddressInfo).port}`;
  // The feed's server also serves the plain-HTTP episodes.
  let rss = "";
  const chapterFiles = new Map<string, string>();
  episodes.forEach((e, i) => e.chapterFile !== undefined && chapterFiles.set(`/chapters/episode-${i + 1}.json`, JSON.stringify(e.chapterFile)));
  const feed: Server = createServer((req, res) => {
    if (req.url?.startsWith("/feed.xml")) {
      res.writeHead(200, { "Content-Type": "application/rss+xml; charset=utf-8" });
      res.end(rss);
    } else if (req.url?.startsWith("/media/")) serveMedia(req, res);
    else if (chapterFiles.has(req.url ?? "")) {
      res.writeHead(200, { "Content-Type": "application/json+chapters" });
      res.end(chapterFiles.get(req.url ?? ""));
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => feed.listen(0, "127.0.0.1", r));
  const plainOrigin = `http://127.0.0.1:${(feed.address() as AddressInfo).port}`;
  const feedURL = `${plainOrigin}/feed.xml`;
  const items = episodes
    .map((e, i) => {
      const n = i + 1;
      const date = new Date(Date.UTC(2026, 8, n, 12)).toUTCString();
      const notes = `<p>Notes for ${e.title}. Jump to 00:01:00.</p>`;
      const path = pathOf(e, n);
      const file = files.get(path)!;
      return `<item><title>${e.title}</title><guid isPermaLink="false">player-${n}</guid><pubDate>${date}</pubDate>
<itunes:duration>${e.seconds}</itunes:duration>
<enclosure url="${e.plain ? plainOrigin : mediaOrigin}${path}" length="${file.body.length}" type="${file.type}"/>
<description><![CDATA[${notes}]]></description>${chapters(e)}${e.chapterFile !== undefined ? `<podcast:chapters url="${plainOrigin}/chapters/episode-${n}.json" type="application/json+chapters"/>` : ""}</item>`;
    })
    .join("\n");
  rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:psc="http://podlove.org/simple-chapters" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>${show}</title><link>https://example.com/</link>
<description>Player journeys</description>
${items}
</channel></rss>`;
  return {
    feedURL,
    mediaOrigin,
    requests,
    agents,
    certificate: cert.cert.toString("utf8"),
    stop: async () => {
      media.closeAllConnections();
      feed.closeAllConnections();
      await Promise.all([new Promise((r) => media.close(r)), new Promise((r) => feed.close(r))]);
    },
  };
}
