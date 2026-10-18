// A podcast's failed refresh in Android's words (DownloadErrorLabel and
// DownloadLogDetailsDialog), from the refresh_status record the read views
// already carry, and Android's error icon as it is drawn.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PodcastRow, Records } from "../src/api/views.ts";
import { clipboardText, failure, fileURL, statusText, technicalText, tileName } from "../src/ui/feedStatus.ts";
import { icons } from "../src/generated/icons.ts";

const row = (records: Records): Pick<PodcastRow, "records" | "display_title"> => ({ display_title: "Show", records });
const failing = (error: unknown) => row({ refresh_status: { value: { last_attempt: 1, last_success: 0, error, next_attempt: 2 }, provenance: [] } });

test("a podcast without a status, or whose last refresh worked, has no failure", () => {
  assert.equal(failure(row({})), null);
  assert.equal(failure(failing(null)), null);
  assert.equal(failure(row({ refresh_status: { value: {}, provenance: [] } })), null);
});

test("a failed refresh is its label, HTTP status and detail; an empty detail is none", () => {
  assert.deepEqual(failure(failing({ label: "http_status", code: 503 })), { label: "http_status", code: 503 });
  assert.deepEqual(failure(failing({ label: "parser_exception", detail: "Feed has no title" })), { label: "parser_exception", detail: "Feed has no title" });
  assert.deepEqual(failure(failing({ label: "io", detail: "" })), { label: "io" });
  assert.deepEqual(failure(failing({ label: 7 })), { label: "" }); // a label the client cannot read is still a failure
});

test("each server label reads as Android's DownloadErrorLabel for the error it stands for", () => {
  const cases: [string, string][] = [
    ["unauthorized", "Authentication error. Make sure that username and password are correct."],
    ["forbidden", "The podcast host's server refuses to respond."],
    ["not_found", "The podcast host's server does not know where to find the file. It may have been deleted."],
    ["http_status", "HTTP data error"],
    ["io", "IO error"],
    ["too_many_redirects", "IO error"],
    ["time_limit", "Connection error"],
    ["refused_destination", "Cannot find the server. Check if the address is typed correctly and if you have a working network connection."],
    [
      "parser_exception",
      "The podcast host's server sent a broken podcast feed. We recommend checking with a podcast validator such as castfeedvalidator.com and contacting the podcast creator to let them know.",
    ],
    ["unsupported_type", "Unsupported feed type"],
    ["unsupported_type_html", "The podcast host's server sent a website, not a podcast."],
    ["size_limit", "Unknown error"],
    ["something_new", "Unknown error"],
    ["", "Unknown error"],
    ["toString", "Unknown error"],
  ];
  for (const [label, words] of cases) assert.equal(statusText({ label }), words, label);
});

test("a host that is not found reads as Android's unknown host; other I/O failures as its I/O error", () => {
  assert.equal(statusText({ label: "io", detail: "host not found" }), "Cannot find the server. Check if the address is typed correctly and if you have a working network connection.");
  assert.equal(statusText({ label: "io", detail: "connection refused" }), "IO error");
});

test("the technical details are the server's detail, else the HTTP status as Android's, else nothing", () => {
  assert.equal(technicalText({ label: "parser_exception", detail: "Item has no title" }), "Item has no title");
  assert.equal(technicalText({ label: "http_status", code: 503 }), "503");
  assert.equal(technicalText({ label: "http_status", code: 304, detail: "not modified without a matching stored response" }), "not modified without a matching stored response");
  assert.equal(technicalText({ label: "not_found" }), "");
});

test("the File URL is the podcast's refresh address from its identity record, else its first alias, else Android's unknown", () => {
  const url = "https://feeds.example/a-very-long-path/without/any/spaces/feed.xml";
  const identity = (value: Record<string, unknown>) => row({ identity: { value, provenance: ["n1"] } });
  assert.equal(fileURL(identity({ aliases: [{ url: "https://old.example/feed", normalized: "old.example/feed" }], refresh_url: url })), url);
  assert.equal(fileURL(identity({ aliases: [{ url: "https://old.example/feed", normalized: "old.example/feed" }], refresh_url: "" })), "https://old.example/feed");
  assert.equal(fileURL(identity({ aliases: [] })), "unknown");
  assert.equal(fileURL(row({})), "unknown");
});

test("Copy to clipboard copies Android's text; no technical details are null there", () => {
  const url = "https://feeds.example/feed.xml";
  assert.equal(
    clipboardText({ label: "http_status", code: 503 }, url),
    "Status: \nHTTP data error \n\nTechnical details: \n503 \n\nFile URL: \nhttps://feeds.example/feed.xml",
  );
  assert.equal(clipboardText({ label: "forbidden" }, url), "Status: \nThe podcast host's server refuses to respond. \n\nTechnical details: \nnull \n\nFile URL: \nhttps://feeds.example/feed.xml");
});

test("a failing podcast's tile is named with Android's notice; a healthy one by its title", () => {
  assert.equal(tileName(failing({ label: "io" })), "Show, Last refresh failed. Tap to view details.");
  assert.equal(tileName(failing(null)), "Show");
});

test("Android's error icon is a red mark on a disc of the window's background, not one solid colour", () => {
  const [disc, mark] = icons.error.paths;
  assert.equal(disc?.fill, "var(--background)");
  assert.equal(mark?.fill, "#CF1800");
  // Every other icon still follows the text colour or its own fixed colours.
  assert.ok(Object.entries(icons).every(([name, icon]) => name === "error" || icon.paths.every((p) => !p.fill.startsWith("var("))));
});
