// Show notes in real browsers (PROTOCOL §12, scenario 40). The
// ShowNotes component, bundled by esbuild, renders every fixture on a page
// served with the server's CSP by a small Node server. The browser sees the
// page at https://nottennapod.test (Playwright routes that origin to the
// server), so same-origin URLs in the fixtures are the app's own, over https.
// Every request is recorded: none may go to the app's origin beyond the page
// itself, no script may run (a canary, CSP violation reports and dialogs are
// watched) and no form may submit. Requests elsewhere get a 1x1 PNG.
import { test, expect, type BrowserContext, type Page, type Request } from "@playwright/test";
import * as esbuild from "esbuild";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { appOrigin, loadCases, type Timecode } from "../test/fixtures/shownotes/cases.ts";

const csp =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; " +
  "media-src 'self' https: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const pagePaths = new Set(["/", "/shownotes.js", "/shownotes.css"]);
const appHost = new URL(appOrigin).hostname;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const pageHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/shownotes.css">
<title>Show notes</title>
</head>
<body>
<div id="root"></div>
<script type="module" src="/shownotes.js"></script>
</body>
</html>
`;

// The rules styles.css needs for show notes (Android's shownotes-style.css).
const css = `.shownotes { overflow-wrap: break-word; }
.shownotes img { display: block; margin: 10px auto; max-width: 100%; height: auto; }
.shownotes a { font-style: normal; font-weight: normal; }
.shownotes button[data-timecode] { font: inherit; color: #669900; background: none; border: 0; padding: 0; text-decoration: underline; cursor: pointer; }
.shownotes-empty { text-align: center; }
`;

// The bundle's entry: the real component and sanitizer, and the watchers.
const harness = `
import { h, render } from "preact";
import { ShowNotes } from "./src/shownotes/ShowNotes.tsx";
import { sanitize } from "./src/shownotes/sanitize.ts";
const t = { violations: [], submits: [], seeks: [] };
document.addEventListener("securitypolicyviolation", (e) => t.violations.push(e.effectiveDirective + " " + e.blockedURI));
document.addEventListener("submit", (e) => { t.submits.push(String(e.target.action)); e.preventDefault(); }, true);
t.show = (html, durationMs) => render(h(ShowNotes, { html, durationMs, onSeek: (ms) => t.seeks.push(ms) }), document.getElementById("root"));
t.sanitize = (html, durationMs) => sanitize(html, { origin: location.origin, durationMs });
window.__test = t;
`;

interface Harness {
  violations: string[];
  submits: string[];
  seeks: number[];
  show(html: string, durationMs?: number): void;
  sanitize(html: string, durationMs?: number): string;
}

declare global {
  interface Window {
    __test: Harness;
    __canary?: unknown;
  }
}

let server: Server;
let serverURL = "";

test.beforeAll(async () => {
  const built = await esbuild.build({
    stdin: { contents: harness, resolveDir: join(import.meta.dirname, ".."), sourcefile: "harness.js", loader: "js" },
    bundle: true,
    format: "esm",
    target: ["es2022", "safari17", "firefox128", "chrome120"],
    jsx: "automatic",
    jsxImportSource: "preact",
    write: false,
    logLevel: "warning",
  });
  const files = new Map<string, [string, string]>([
    ["/", [pageHTML, "text/html; charset=utf-8"]],
    ["/shownotes.js", [built.outputFiles[0]!.text, "text/javascript; charset=utf-8"]],
    ["/shownotes.css", [css, "text/css; charset=utf-8"]],
  ]);
  server = createServer((req, res) => {
    const file = files.get(new URL(req.url ?? "/", "http://x").pathname);
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    if (!file || req.method !== "GET") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": file[1] }).end(file[0]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Recorder {
  requests: Request[];
  dialogs: string[];
}

async function open(p: Page, context: BrowserContext): Promise<Recorder> {
  const rec: Recorder = { requests: [], dialogs: [] };
  context.on("request", (r) => rec.requests.push(r));
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === appOrigin) {
      const response = await route.fetch({ url: serverURL + url.pathname + url.search });
      await route.fulfill({ response });
    } else {
      await route.fulfill({ status: 200, contentType: "image/png", body: png });
    }
  });
  p.on("dialog", (d) => {
    rec.dialogs.push(d.message());
    void d.dismiss();
  });
  await p.goto(`${appOrigin}/`);
  await p.waitForFunction(() => window.__test !== undefined);
  return rec;
}

/** settle waits until every image has loaded or failed, then two frames and a task. */
async function settle(p: Page): Promise<void> {
  await p.waitForFunction(() => Array.from(document.images).every((i) => i.complete));
  await p.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r)))));
}

const tags = new Set([
  "p", "br", "b", "strong", "i", "em", "u", "s", "blockquote", "ul", "ol", "li",
  "h1", "h2", "h3", "h4", "h5", "h6", "a", "img", "hr", "pre", "code", "span", "div",
]);

/** allowedURL is the test's own statement of the URL rules. */
function allowedURL(value: string, kind: "link" | "image"): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.href !== value || u.username !== "" || u.password !== "") return false;
  if (u.protocol === "mailto:") return kind === "link";
  return u.protocol === "https:" && u.hostname.replace(/\.$/, "") !== appHost;
}

interface Shown {
  tag: string;
  ns: string | null;
  attrs: [string, string, string | null][];
}

function checkElement(e: Shown): void {
  const where = `<${e.tag} ${e.attrs.map((a) => `${a[0]}="${a[1]}"`).join(" ")}>`;
  expect(e.ns, where).toBe("http://www.w3.org/1999/xhtml");
  const attrs = new Map(e.attrs.map(([name, value, ns]) => {
    expect(ns, where).toBeNull();
    return [name, value];
  }));
  if (e.tag === "button") {
    expect([...attrs.keys()], where).toEqual(["type", "data-timecode"]);
    expect(attrs.get("type"), where).toBe("button");
    expect(attrs.get("data-timecode"), where).toMatch(/^\d+$/);
    return;
  }
  expect(tags.has(e.tag), where).toBe(true);
  if (e.tag === "a") {
    if (attrs.has("href")) {
      expect(allowedURL(attrs.get("href")!, "link"), where).toBe(true);
      expect([...attrs.keys()], where).toEqual(["href", "target", "rel"]);
      expect(attrs.get("target"), where).toBe("_blank");
      expect(attrs.get("rel"), where).toBe("noopener noreferrer");
    } else {
      expect(attrs.size, where).toBe(0);
    }
  } else if (e.tag === "img") {
    expect(allowedURL(attrs.get("src") ?? "", "image"), where).toBe(true);
    expect(attrs.get("referrerpolicy"), where).toBe("no-referrer");
    for (const name of attrs.keys()) expect(["src", "alt", "width", "height", "referrerpolicy"], where).toContain(name);
  } else {
    expect(attrs.size, where).toBe(0);
  }
}

// Chromium checks DOMPurify's own parse of the notes, in an inert document,
// against the page's CSP and reports style and base it meets there; nothing is
// applied. So the notes are first sanitized alone to learn those reports, and
// rendering them must add none.
const parseReports = new Set(["style-src-attr", "style-src-elem", "base-uri"]);

for (const c of loadCases()) {
  test(`${c.file}: ${c.name}`, async ({ page: p, context }) => {
    const rec = await open(p, context);
    const head = await p.evaluate(() => document.head.innerHTML);
    const args = [c.input, c.durationMs ?? null] as const;
    await p.evaluate(([html, d]) => void window.__test.sanitize(html, d ?? undefined), args);
    await settle(p);
    const parsing = (await p.evaluate(() => window.__test.violations.splice(0))).sort();
    for (const v of parsing) expect(parseReports.has(v.split(" ")[0]!), `parsing reported ${v}`).toBe(true);

    await p.evaluate(([html, d]) => window.__test.show(html, d ?? undefined), args);
    await settle(p);
    const shown = await p.evaluate((d) => {
      const box = document.querySelector("#root > .shownotes")!;
      const html = box.innerHTML;
      const copy = document.createElement("div");
      copy.innerHTML = html;
      return {
        html,
        dir: box.getAttribute("dir"),
        elements: Array.from(box.querySelectorAll("*")).map((e) => ({
          tag: e.localName,
          ns: e.namespaceURI,
          attrs: Array.from(e.attributes).map((a) => [a.name, a.value, a.namespaceURI] as [string, string, string | null]),
        })),
        reparsed: copy.innerHTML,
        again: window.__test.sanitize(html, d ?? undefined),
        head: document.head.innerHTML,
        outside: Array.from(document.body.children).map((e) => e.localName + (e.id ? `#${e.id}` : "")),
      };
    }, c.durationMs ?? null);
    await settle(p);
    // The render parses the notes again; the output, sanitized again above, holds nothing to report.
    const reports = (await p.evaluate(() => window.__test.violations.splice(0))).sort();
    expect(reports, "rendering reached the CSP").toEqual(parsing);

    if (c.expect !== undefined) expect(shown.html).toBe(c.expect);
    expect(shown.dir).toBe("auto");
    for (const e of shown.elements) checkElement(e);
    expect(shown.head).toBe(head);
    expect(shown.outside).toEqual(["div#root", "script"]);
    if (!c.depthCapped) {
      expect(shown.reparsed, "the output parses back to itself").toBe(shown.html);
      expect(shown.again, "sanitizing the output again changes nothing").toBe(shown.html);

      // Click every timecode: each seeks, nothing navigates or loads.
      const buttons = p.locator(".shownotes button[data-timecode]");
      const found: Timecode[] = await buttons.evaluateAll((bs) =>
        bs.map((b) => ({ ms: Number(b.getAttribute("data-timecode")), text: b.textContent ?? "" })),
      );
      if (c.timecodes) expect(found).toEqual(c.timecodes);
      const before = rec.requests.length;
      for (const b of await buttons.all()) await b.click();
      expect(await p.evaluate(() => window.__test.seeks)).toEqual(found.map((f) => f.ms));
      expect(rec.requests.length).toBe(before);
      expect(p.url()).toBe(`${appOrigin}/`);
      await settle(p);
      expect(await p.evaluate(() => window.__test.violations), "clicking reached the CSP").toEqual([]);
    }

    await checkWalls(p, rec);
  });
}

async function checkWalls(p: Page, rec: Recorder): Promise<void> {
  expect(await p.evaluate(() => window.__canary), "no script ran").toBeUndefined();
  expect(await p.evaluate(() => window.__test.submits), "no form submitted").toEqual([]);
  expect(rec.dialogs, "no dialog opened").toEqual([]);
  const own = rec.requests.map((r) => new URL(r.url())).filter((u) => u.origin === appOrigin && !pagePaths.has(u.pathname));
  expect(own.map((u) => u.href), "no request to the app beyond the page").toEqual([]);
  for (const r of rec.requests) {
    expect(r.method(), r.url()).toBe("GET");
    const u = new URL(r.url());
    if (u.origin === appOrigin) continue;
    expect(u.protocol, r.url()).toBe("https:");
    expect(r.resourceType(), r.url()).toBe("image");
    expect(await r.headerValue("referer"), `${r.url()} is sent without a referrer`).toBeNull();
  }
}

test("timecodes seek from the keyboard", async ({ page: p, context }) => {
  await open(p, context);
  await p.evaluate(() => window.__test.show("<p>0:00 Intro, 12:34 Interview</p>", 3_600_000));
  const buttons = p.locator(".shownotes button[data-timecode]");
  await buttons.nth(1).focus();
  await p.keyboard.press("Enter");
  await buttons.nth(0).focus();
  await p.keyboard.press("Space");
  expect(await p.evaluate(() => window.__test.seeks)).toEqual([754_000, 0]);
});

test("no show notes says so", async ({ page: p, context }) => {
  await open(p, context);
  await p.evaluate(() => window.__test.show(""));
  await expect(p.locator(".shownotes")).toHaveText("This episode has no shownotes.");
  // Android shows the label only for empty notes; blank ones are shown as they are.
  await p.evaluate(() => window.__test.show("  \n "));
  await expect(p.locator(".shownotes")).not.toHaveClass(/shownotes-empty/);
  expect(await p.locator(".shownotes").evaluate((e) => e.innerHTML)).toBe("  <br> ");
});

// The watchers must see what the sanitizer exists to stop, or a pass means nothing.
test("the watchers see a request to the app, a blocked handler, a dialog and a submit", async ({ page: p, context }) => {
  const rec = await open(p, context);
  await p.evaluate(() => {
    document.getElementById("root")!.innerHTML =
      '<img src="/v1/read/summary"><img src="https://images.example/a.png" onload="window.__canary=1">';
  });
  await settle(p);
  await expect.poll(() => rec.requests.map((r) => r.url())).toContain(`${appOrigin}/v1/read/summary`);
  await expect.poll(() => p.evaluate(() => window.__test.violations.length)).toBeGreaterThan(0);
  expect(await p.evaluate(() => window.__canary)).toBeUndefined();
  await p.evaluate(() => alert("dialog"));
  expect(rec.dialogs).toEqual(["dialog"]);
  await p.evaluate(() => {
    const form = document.createElement("form");
    form.action = "/v1/sync/push";
    form.method = "post";
    document.body.append(form);
    form.requestSubmit();
  });
  expect(await p.evaluate(() => window.__test.submits)).toEqual([`${appOrigin}/v1/sync/push`]);
});
