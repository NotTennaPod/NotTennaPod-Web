// What an AntennaPod backup held that stays on each device, as the import report says it (PROTOCOL §11.5
// `not_carried`): each imported podcast with its changed settings in Android's words, and the episodes
// kept from automatic download; nothing when there is nothing, or the server is older.
import { test } from "node:test";
import assert from "node:assert/strict";
import { notCarriedText, settingName } from "../src/ui/importText.ts";

test("each setting reads as Android's podcast settings name it; one this version doesn't know reads as its name", () => {
  const all = ["custom_title", "tags", "playback_speed", "skip_silence", "skip_intro", "skip_ending", "volume_adaptation",
    "episode_notification", "auto_delete", "auto_download", "auto_download_filter", "episode_list_filter", "sort_order"];
  assert.deepEqual(all.map(settingName), ["Custom title", "Tags", "Playback speed", "Skip silence in audio", "Skip first", "Skip last",
    "Volume adaptation", "Episode notifications", "Delete after playing", "Include in auto downloads", "Episode filter", "Filter", "Sort"]);
  assert.equal(settingName("new_setting"), "new setting");
});

test("the podcasts with changed settings and the episodes kept from automatic download are listed", () => {
  const text = notCarriedText({
    podcasts: [{ title: "Show", source_feed_id: 2, settings: ["playback_speed", "skip_intro"] }, { title: "Show", source_feed_id: 5, settings: ["tags"] }],
    episode_auto_download_off: 3,
  });
  assert.deepEqual(text, {
    podcasts: [{ title: "Show", settings: "Playback speed, Skip first" }, { title: "Show", settings: "Tags" }],
    episodes: "Episodes the device the backup came from didn't download automatically: 3. That isn't imported, so they may be downloaded automatically.",
  });
  assert.deepEqual(notCarriedText({ podcasts: [], episode_auto_download_off: 1 })?.podcasts, []);
});

test("nothing is said when nothing stays behind, or an older server's report has no such part", () => {
  assert.equal(notCarriedText({ podcasts: [], episode_auto_download_off: 0 }), undefined);
  assert.equal(notCarriedText(undefined), undefined);
  assert.equal(notCarriedText(null), undefined);
});

test("podcasts with the same title are told apart by their feed's address; a unique title has none", () => {
  const text = notCarriedText({
    podcasts: [
      { title: "Show", url: "https://a.example/feed.xml", source_feed_id: 2, settings: ["tags"] },
      { title: "Show", url: "https://b.example/feed.xml", source_feed_id: 3, settings: ["sort_order"] },
      { title: "Other", url: "https://c.example/feed.xml", source_feed_id: 4, settings: ["tags"] },
    ],
    episode_auto_download_off: 0,
  });
  assert.deepEqual(text?.podcasts, [
    { title: "Show", address: "https://a.example/feed.xml", settings: "Tags" },
    { title: "Show", address: "https://b.example/feed.xml", settings: "Sort" },
    { title: "Other", settings: "Tags" },
  ]);
});
