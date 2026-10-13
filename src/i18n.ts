// The app's wording: Android AntennaPod 3.12.1's English strings, as
// NotTennaPod-iOS ships them (src/generated/strings.ts). Formats use the
// Apple specifiers the table holds: %@ and %d, positional (%1$@) or not.
import { strings, plurals, type StringKey, type PluralKey } from "./generated/strings.ts";
import { web, type WebKey } from "./webStrings.ts";

export type { StringKey, PluralKey };

/** format fills a format string's specifiers with args, in order or by position. */
export function format(text: string, args: readonly (string | number)[]): string {
  let next = 0;
  return text.replace(/%(?:(\d+)\$)?(l{0,2}d|@|%)/g, (_, pos: string | undefined, spec: string) => {
    if (spec === "%") return "%";
    const i = pos ? Number(pos) - 1 : next++;
    const v = args[i];
    if (v === undefined) return "";
    return spec === "@" ? String(v) : String(Math.trunc(Number(v)));
  });
}

/** t is a string of the table, formatted. */
export function t(key: StringKey, ...args: (string | number)[]): string {
  return format(strings[key], args);
}

const rules = new Intl.PluralRules("en");

/** plural is a plural string for count; count is the first argument unless args say otherwise. */
export function plural(key: PluralKey, count: number, ...args: (string | number)[]): string {
  const forms = plurals[key];
  const form = (forms[rules.select(count)] ?? forms.other) as string;
  return format(form, args.length ? args : [count]);
}

/** w is a browser-only string (src/webStrings.ts), formatted. */
export function w(key: WebKey, ...args: (string | number)[]): string {
  return format(web[key], args);
}
