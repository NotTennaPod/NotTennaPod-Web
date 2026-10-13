// Show-note rules in Node. happy-dom 20.14.5 cannot host DOMPurify: its
// NodeIterator does not follow DOM removal, so DOMPurify's walk stops at the
// first removed node (always <body>, the walk root) and the rest of the tree
// is never sanitized. So DOMPurify itself, and the fixtures through it, run
// only in real browsers (e2e/shownotes.spec.ts). Here: the URL rules,
// Android's line-break, link and timecode rules on happy-dom's DOM, and that
// sanitize fails closed where DOMPurify does not work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import {
  addTimecodes,
  allowedAttributes,
  allowedTags,
  externalLink,
  linkify,
  purifyConfig,
  safeURL,
  sanitize,
  withLineBreaks,
} from "../src/shownotes/sanitize.ts";
import { appOrigin, loadCases } from "./fixtures/shownotes/cases.ts";

const win = new Window({ url: `${appOrigin}/` });

function body(html: string): Element {
  const doc = new win.DOMParser().parseFromString(`<!doctype html><body>${html}`, "text/html");
  return doc.body as unknown as Element;
}

function timecodes(root: Element): { ms: number; text: string }[] {
  return Array.from(root.querySelectorAll("button[data-timecode]")).map((b) => ({
    ms: Number(b.getAttribute("data-timecode")),
    text: b.textContent ?? "",
  }));
}

test("the allowlist is the documented one and cannot be widened", () => {
  assert.deepEqual(
    [...allowedTags].sort(),
    ["a", "b", "blockquote", "br", "code", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre", "s", "span", "strong", "u", "ul"],
  );
  assert.deepEqual([...allowedAttributes.get("a")!], ["href"]);
  assert.deepEqual([...allowedAttributes.get("img")!], ["src", "alt", "width", "height"]);
  assert.equal(allowedAttributes.get("p"), undefined);
  assert.deepEqual(purifyConfig.ALLOWED_NAMESPACES, ["http://www.w3.org/1999/xhtml"]);
  assert.equal(purifyConfig.ALLOW_DATA_ATTR, false);
  assert.equal(purifyConfig.ALLOW_ARIA_ATTR, false);
  assert.equal(purifyConfig.ALLOW_UNKNOWN_PROTOCOLS, false);
  assert.ok(Object.isFrozen(purifyConfig));
  assert.throws(() => (purifyConfig.ALLOWED_TAGS as string[]).push("script"));
});

test("only absolute https URLs to another host, without credentials, are kept", () => {
  const kept: [string, string][] = [
    ["https://example.com/a?b=1&c=2#d", "https://example.com/a?b=1&c=2#d"],
    ["  https://example.com  ", "https://example.com/"],
    ["HTTPS://Example.COM:443/x", "https://example.com/x"],
    ["https://example.com/a b", "https://example.com/a%20b"],
    ["https:\\\\example.com\\feed", "https://example.com/feed"],
    ["https://nottennapod.test.example/", "https://nottennapod.test.example/"],
  ];
  for (const [value, url] of kept) {
    assert.equal(safeURL(value, "link", appOrigin), url, value);
    assert.equal(safeURL(value, "image", appOrigin), url, value);
  }
  assert.equal(safeURL("mailto:host@example.com", "link", appOrigin), "mailto:host@example.com");
  assert.equal(safeURL("mailto:host@example.com", "image", appOrigin), null);

  const dropped = [
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)",
    "java\nscript:alert(1)", "\u0001javascript:alert(1)", "�javascript:alert(1)", "javascript://%0Aalert(1)",
    "data:text/html,<script>alert(1)</script>", "data:image/png;base64,iVBORw0KGgo=", "vbscript:msgbox(1)",
    "http://example.com/", "ftp://example.com/", "file:///etc/passwd", "blob:https://example.com/x", "tel:+1",
    "https://user:pass@example.com/", "https://user@example.com/", "https://:pass@example.com/",
    "https://example.com@evil.example/", "/v1/read/summary", "v1/read", "./x", "../x", "?q", "#top", "",
    "//example.com/x", "//nottennapod.test/v1", "https:example.com/x", "https:/v1/read",
    "https://nottennapod.test/v1/read/summary", "https://NOTTENNAPOD.test:443/v1", "https://nottennapod.test./v1",
    "https://nottennapod.test:8443/v1", "https://%6Eottennapod%2Etest/v1", "https://ｎｏｔｔｅｎｎａｐｏｄ.ｔｅｓｔ/v1",
  ];
  for (const value of dropped) {
    assert.equal(safeURL(value, "link", appOrigin), null, JSON.stringify(value));
    assert.equal(safeURL(value, "image", appOrigin), null, JSON.stringify(value));
  }
});

test("the app's host is refused on any port and over plain HTTP origins", () => {
  assert.equal(safeURL("https://100.64.1.2/x.png", "image", "http://100.64.1.2:8080"), null);
  assert.equal(safeURL("https://[::1]/x", "link", "http://[0:0::1]:8080"), null);
  assert.equal(safeURL("https://2130706433/x", "link", "http://127.0.0.1:8080"), null);
  assert.equal(safeURL("https://images.example/x.png", "image", "http://100.64.1.2:8080"), "https://images.example/x.png");
});

test("notes without br or p keep their line breaks, as Android's cleaner does", () => {
  assert.equal(withLineBreaks("one\ntwo"), "one<br />two");
  assert.equal(withLineBreaks("<b>one</b>\n<i>two</i>"), "<b>one</b><br /><i>two</i>");
  assert.equal(withLineBreaks("one<br>two\nthree"), "one<br>two\nthree");
  assert.equal(withLineBreaks("one<br/>two\nthree"), "one<br/>two\nthree");
  assert.equal(withLineBreaks("one<br  />two\nthree"), "one<br  />two\nthree");
  assert.equal(withLineBreaks("<p>one</p>\n<p>two</p>"), "<p>one</p>\n<p>two</p>");
  // Android looks for these exact strings.
  assert.equal(withLineBreaks("<BR>one\ntwo"), "<BR>one<br />two");
  assert.equal(withLineBreaks('<p class="x">one</p>\ntwo'), '<p class="x">one</p><br />two');
});

test("timecode fixtures, through Android's rules on happy-dom", () => {
  for (const c of loadCases("timecodes.html")) {
    // happy-dom parses "<10:11>" as an element; browsers and jsoup parse it as text.
    if (c.name === "timecode in angle brackets") continue;
    const root = body(withLineBreaks(c.input));
    linkify(root, appOrigin);
    addTimecodes(root, c.durationMs);
    assert.deepEqual(timecodes(root), c.timecodes, c.name);
    // Existing links get target and rel from DOMPurify's hook, which only the browsers run.
    if (c.expect !== undefined && !/<a\s/i.test(c.input)) assert.equal(root.innerHTML, c.expect, c.name);
  }
});

test("a timecode inside a link is lifted out of it, keeping its formatting", () => {
  const root = body('<p><a href="https://example.com/"><b>Part 1:23:45 end</b></a></p>');
  addTimecodes(root);
  assert.equal(
    root.innerHTML,
    '<p><a href="https://example.com/"><b>Part </b></a><b><button type="button" data-timecode="5025000">1:23:45</button></b>' +
      '<a href="https://example.com/"><b> end</b></a></p>',
  );
  const whole = body('<a href="https://example.com/"><i>12:34</i></a> after');
  addTimecodes(whole);
  assert.equal(whole.innerHTML, '<i><button type="button" data-timecode="45240000">12:34</button></i> after');
});

function links(text: string): string[] {
  const root = body(text);
  linkify(root, appOrigin);
  return Array.from(root.querySelectorAll("a")).map((a) => `${a.textContent} -> ${a.getAttribute("href")}`);
}

// Android's PlainTextLinksConverterTest, with http: links left as text.
test("plain-text URLs become links as Android's PlainTextLinksConverter makes them", () => {
  assert.deepEqual(links("text  https://url.to/link"), ["https://url.to/link -> https://url.to/link"]);
  assert.deepEqual(links("artist here:  www.example.com"), ["www.example.com -> https://www.example.com/"]);
  assert.deepEqual(links("text'https://url.to/link and=https://t.me/link"), [
    "https://url.to/link -> https://url.to/link",
    "https://t.me/link -> https://t.me/link",
  ]);
  assert.deepEqual(links("text https://t.me/link#mark?param1=1&amp;param2=true;param3=true after-text"), [
    "https://t.me/link#mark?param1=1&param2=true;param3=true -> https://t.me/link#mark?param1=1&param2=true;param3=true",
  ]);
  assert.deepEqual(links("text https://www.ietf.org/rfc/rfc3986.txt"), [
    "https://www.ietf.org/rfc/rfc3986.txt -> https://www.ietf.org/rfc/rfc3986.txt",
  ]);
  assert.deepEqual(links("text https://www.example.org/valid/-~.,$/url/"), [
    "https://www.example.org/valid/-~.,$/url/ -> https://www.example.org/valid/-~.,$/url/",
  ]);
  assert.deepEqual(links("text https://archive.org/web/*/http://www.example.com/"), [
    "https://archive.org/web/*/http://www.example.com/ -> https://archive.org/web/*/http://www.example.com/",
  ]);
  assert.deepEqual(links("text http://www.example.com/index.php?bar[]=1&amp;bar[]=2"), []);
  for (const text of [
    "Sign up now (https://example.com/abc)",
    "Sign up now (https://example.com/abc)! please",
    "To read on, visit https://example.com.",
    "Visit https://example.com/wiki_(url+rules)",
    "plain text",
    "\"Text With...Dots Works\"",
    "Log in at https://user:pass@example.com/feed",
    "https://nottennapod.test/v1/read/summary",
  ]) {
    assert.deepEqual(links(text), [], text);
  }
  for (const end of ".,;:?!)([]-_~#@$*+") assert.deepEqual(links(`https://example.com/abc${end}`), [], end);
  assert.deepEqual(links("(https://example.com/abc) and https://example.com/abc"), ["https://example.com/abc -> https://example.com/abc"]);
  assert.deepEqual(links('you can find it on <a href="https://xy.org">our new website https://xy.org</a>'), [
    "our new website https://xy.org -> https://xy.org",
  ]);
});

// The test that matters here is the property: sanitize never hands back
// markup outside the allowlist, even on a DOM DOMPurify cannot walk.
test("sanitize fails closed where DOMPurify cannot sanitize", () => {
  const g = globalThis as { window?: unknown };
  g.window = win;
  try {
    const payload = '<p>x</p><script>window.__canary=1</script><img src=x onerror="window.__canary=1"><a href="javascript:alert(1)">y</a>';
    let out: string | null = null;
    try {
      out = sanitize(payload, { origin: appOrigin });
    } catch (err) {
      assert.match(String(err), /shownotes: the sanitizer left/);
    }
    if (out !== null) assert.doesNotMatch(out, /<script|onerror|javascript:|<img/i);
  } finally {
    delete g.window;
  }
});

test("a feed's website and chapter links open only as http or https, without credentials, off the app's host", () => {
  const ok: [string, string][] = [
    ["https://example.com/ep", "https://example.com/ep"],
    ["http://example.com/ep", "http://example.com/ep"],
    ["HTTPS://Example.com", "https://example.com/"],
  ];
  for (const [value, url] of ok) assert.equal(externalLink(value, appOrigin), url, value);
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,x",
    "mailto:a@example.com",
    "https://user:pw@example.com/",
    "//example.com/",
    "/settings",
    "https:example.com",
    "https://[",
    appOrigin + "/settings",
    "",
  ]) {
    assert.equal(externalLink(value, appOrigin), null, value);
  }
});
