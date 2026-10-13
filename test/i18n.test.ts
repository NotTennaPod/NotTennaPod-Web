import { test } from "node:test";
import assert from "node:assert/strict";
import { format, t, plural } from "../src/i18n.ts";
import { parseStrings, parseStringsdict } from "../scripts/strings.mjs";

test("formats Apple specifiers in order and by position", () => {
  assert.equal(format("%1$@ and %2$@", ["a", "b"]), "a and b");
  assert.equal(format("%2$@ has %1$d new episodes", [3, "Show"]), "Show has 3 new episodes");
  assert.equal(format("%lld episode", [1]), "1 episode");
  assert.equal(format("%@ %d%%", ["x", 5]), "x 5%");
});

test("the table holds Android's wording", () => {
  assert.equal(t("queue_label"), "Queue");
  assert.equal(t("home_continue_title"), "Continue listening");
  assert.equal(t("num_selected_label", 2, 5), "2/5 selected");
});

test("plurals follow English rules", () => {
  assert.equal(plural("num_episodes", 1), "1 episode");
  assert.equal(plural("num_episodes", 0), "0 episodes");
  assert.equal(plural("new_episode_notification_message", 1, 1, "Show"), "Show has a new episode");
  assert.equal(plural("new_episode_notification_message", 4, 4, "Show"), "Show has 4 new episodes");
});

test("parses .strings escapes and comments", () => {
  const table = parseStrings('/* c */ "a" = "x\\"y\\n";\n// line\n"b"="\\U00e9";');
  assert.deepEqual(table, { a: 'x"y\n', b: "é" });
  assert.throws(() => parseStrings('"a" = "1"; "a" = "2";'));
});

test("parses .stringsdict plural rules", () => {
  const xml = `<?xml version="1.0"?><plist><dict><key>n</key><dict><key>NSStringLocalizedFormatKey</key><string>%#@c@</string>
  <key>c</key><dict><key>NSStringFormatSpecTypeKey</key><string>NSStringPluralRuleType</string><key>one</key><string>%lld item</string>
  <key>other</key><string>%lld items &amp; more</string></dict></dict></dict></plist>`;
  assert.deepEqual(parseStringsdict(xml), { n: { one: "%d item", other: "%d items & more" } });
});
