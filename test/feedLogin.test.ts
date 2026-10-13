// Where a podcast's new login is approved for (Android's feed settings,
// Authentication): the origin whose 401 asks for it, the feed address's own
// when the feed answers without asking, and nothing at all when the preview
// fails, so the saved login and its origins stay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../src/api/http.ts";
import type { Preview } from "../src/api/views.ts";
import { askingOrigin, originOf } from "../src/app/feedLogin.ts";

const feed = "https://feeds.example/show.xml";
const answer = (p: Preview) => async () => p;

test("a 401 names the origin the login is for, also after a redirect to another host", async () => {
  assert.equal(await askingOrigin(feed, answer({ url: feed, error: { label: "unauthorized", origin: "https://cdn.example:443" } })), "https://cdn.example:443");
});

test("a feed that answers without asking takes the login at its own origin", async () => {
  const preview: Preview = { url: feed, feed: { title: "Show", author: null, description: null, language: null, link: null, image_url: null, type: "rss", item_count: 0, items: [] } };
  assert.equal(await askingOrigin(feed, answer(preview)), "https://feeds.example:443");
});

test("a preview that fails records nothing: it says why, in Android's words", async () => {
  const cases: [Preview | Error, string][] = [
    [{ url: feed, error: { label: "http_status", code: 503 } }, "HTTP data error"],
    [{ url: feed, error: { label: "io" } }, "Connection error"],
    [{ url: feed, error: { label: "parser_exception" } }, "The podcast host's server sent a broken podcast feed."],
    [{ url: feed, error: { label: "something_new" } }, "Unknown error"],
    [{ url: feed, error: { label: "unauthorized" } }, "Authentication error."], // a 401 without its origin
    [{ url: feed, links: [{ url: "https://feeds.example/other.xml", title: "Other" }] }, "The podcast host's server sent a website, not a podcast."],
    [new ApiError(503, "server_busy", "The server is busy."), "The server is busy."],
    [new TypeError("Failed to fetch"), "Connection error"],
  ];
  for (const [reply, words] of cases) {
    const preview = async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    };
    await assert.rejects(askingOrigin(feed, preview), (e: Error) => {
      assert.ok(e.message.startsWith("The username and password were not saved: "), e.message);
      assert.ok(e.message.includes(words), `${e.message} / ${words}`);
      return true;
    });
  }
});

test("origins are written as the server writes them: scheme://host:port, the port explicit", () => {
  assert.equal(originOf("http://Example.COM/feed"), "http://example.com:80");
  assert.equal(originOf("https://example.com:8443/feed"), "https://example.com:8443");
  assert.equal(originOf("ftp://example.com/feed"), null);
  assert.equal(originOf("not an address"), null);
});
