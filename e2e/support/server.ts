// A NotTennaPod-Server for one test worker: a fresh data directory, the app
// from dist/, feeds allowed from this machine; and a small feed server.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { root, serverBinary } from "./build.ts";

export interface RunningServer {
  base: string;
  setupCode: string;
  dataDir: string;
  stop: () => Promise<void>;
  /** halt stops the server and keeps its data, for the CLI (a restore) and resume. */
  halt: () => Promise<void>;
  resume: () => Promise<void>;
  /** cli runs the server binary's command line, such as keys export or restore. */
  cli: (args: string[]) => string;
}

/** env adds to the server's environment: a journey's server that trusts the fixture publisher's certificate (SSL_CERT_FILE). */
export async function startServer(opts: { env?: Record<string, string> } = {}): Promise<RunningServer> {
  const dir = mkdtempSync(join(tmpdir(), "ntp-e2e-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  let proc: ChildProcess | undefined;
  const launch = async () => {
    const p = spawn(
      serverBinary,
      ["--listen", `127.0.0.1:${port}`, "--data-dir", join(dir, "data"), "--web-dir", join(root, "dist"), "--dev-allow-loopback-feeds",
        "--refresh-interval", "24h"],
      { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, ...opts.env } },
    );
    proc = p;
    let log = "";
    p.stderr?.on("data", (d) => (log += String(d)));
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/healthz`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server did not start: ${log}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const halt = async () => {
    const p = proc;
    proc = undefined;
    if (!p || p.exitCode !== null) return;
    p.kill("SIGTERM");
    await new Promise((r) => p.once("exit", r));
  };
  await launch();
  const setupCode = readFileSync(join(dir, "data", "setup-code"), "utf8").trim();
  return {
    base,
    setupCode,
    dataDir: join(dir, "data"),
    halt,
    resume: launch,
    cli: (args) => execFileSync(serverBinary, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    stop: async () => {
      await halt();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Feeds {
  /** url is the public feed's address; the private feed is private.xml beside it. */
  url: string;
  /** setPrivateLogin changes the one login the private feed accepts (alice, s3cret at first), as a publisher changes it. */
  setPrivateLogin: (username: string, password: string) => void;
  /** logins lists the logins sent for the private feed, in order ("user:password"; none: ""). */
  logins: string[];
  /** failNext makes the private feed's next request fail with 503, as a publisher's outage does. */
  failNext: () => void;
  /** breakable is a feed (Breakable Show) that answers malformed XML while broken, as a publisher's broken feed does. */
  breakable: { url: string; setBroken: (broken: boolean) => void };
  stop: () => Promise<void>;
}

export async function startFeeds(): Promise<Feeds> {
  const items = [1, 2, 3]
    .map(
      (i) => `<item><title>Journey episode ${i}</title><guid>journey-${i}</guid>
<pubDate>${new Date(Date.UTC(2026, 8, i)).toUTCString()}</pubDate>
<enclosure url="https://media.example/journey-${i}.mp3" length="1000" type="audio/mpeg"/><description>Notes ${i}</description></item>`,
    )
    .join("\n");
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Journey Show</title><link>https://example.com/</link>${items}</channel></rss>`;
  let login = "alice:s3cret";
  let failing = false;
  let broken = false;
  const logins: string[] = [];
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith("/feed.xml")) {
      res.writeHead(200, { "Content-Type": "application/rss+xml" });
      res.end(rss);
    } else if (req.url?.startsWith("/breakable.xml")) {
      res.writeHead(200, { "Content-Type": "application/rss+xml" });
      res.end(broken ? "<rss version=\"2.0\"><channel><title>Breakable Show</title><item>" : rss.replace("<title>Journey Show</title>", "<title>Breakable Show</title>").replaceAll("journey-", "breakable-"));
    } else if (req.url?.startsWith("/private.xml")) {
      // A private feed: Basic authentication with its current login.
      const sent = req.headers.authorization?.startsWith("Basic ") ? Buffer.from(req.headers.authorization.slice(6), "base64").toString("utf8") : "";
      logins.push(sent);
      if (failing) {
        failing = false;
        res.writeHead(503).end();
      } else if (sent === login) {
        res.writeHead(200, { "Content-Type": "application/rss+xml" });
        res.end(rss.replace("<title>Journey Show</title>", "<title>Private Show</title>"));
      } else {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="private"' });
        res.end();
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/feed.xml`,
    setPrivateLogin: (username, password) => {
      login = `${username}:${password}`;
    },
    logins,
    failNext: () => {
      failing = true;
    },
    breakable: {
      url: `http://127.0.0.1:${port}/breakable.xml`,
      setBroken: (b) => {
        broken = b;
      },
    },
    stop: () => new Promise((r) => server.close(() => r())),
  };
}
