// Show-note fixtures, read by test/shownotes.test.ts and e2e/shownotes.spec.ts.
//
// A fixture file holds cases. A case starts with a line "#### name". Lines
// right after it that start with "@" set options:
//   @duration ms                 the media's duration (omit for an episode without media)
//   @timecodes ms=text ms=text   the seek buttons in order, or "none"
//   @depth-capped                markup deeper than browsers build: only the
//                                safety checks run, as reparsing may move
//                                content and deep content may not render
// The input follows, up to a line "==== expect" (then the exact output) or
// the next case. Without an expected output only the invariants are checked.
// Blank lines at the end of an input or output are dropped. Text before the
// first case is a comment. The app's origin is appOrigin.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const appOrigin = "https://nottennapod.test";

export interface Timecode {
  ms: number;
  text: string;
}

export interface Case {
  file: string;
  name: string;
  input: string;
  durationMs?: number;
  timecodes?: Timecode[];
  depthCapped?: boolean;
  expect?: string;
}

export const fixturesDir = import.meta.dirname;

export function loadCases(file?: string): Case[] {
  const files = file ? [file] : readdirSync(fixturesDir).filter((f) => f.endsWith(".html")).sort();
  return files.flatMap((f) => parse(f, readFileSync(join(fixturesDir, f), "utf8")));
}

function parse(file: string, text: string): Case[] {
  const cases: Case[] = [];
  let c: Case | null = null;
  let input: string[] = [];
  let expect: string[] | null = null;
  let options = false;
  const finish = () => {
    if (!c) return;
    // Blank lines between cases belong to neither.
    while (input.at(-1) === "") input.pop();
    while (expect?.at(-1) === "") expect.pop();
    c.input = input.join("\n");
    if (expect) c.expect = expect.join("\n");
    cases.push(c);
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("#### ")) {
      finish();
      c = { file, name: line.slice(5).trim(), input: "" };
      input = [];
      expect = null;
      options = true;
      continue;
    }
    if (!c) continue;
    if (options && line.startsWith("@")) {
      const [key, ...rest] = line.slice(1).split(" ");
      if (key === "duration") c.durationMs = Number(rest[0]);
      else if (key === "timecodes") c.timecodes = rest[0] === "none" ? [] : rest.map(timecode);
      else if (key === "depth-capped") c.depthCapped = true;
      else throw new Error(`${file}: unknown option @${key}`);
      continue;
    }
    options = false;
    if (line === "==== expect" && !expect) expect = [];
    else (expect ?? input).push(line);
  }
  finish();
  if (cases.length === 0) throw new Error(`${file}: no cases`);
  const names = new Set<string>();
  for (const k of cases) {
    if (names.has(k.name)) throw new Error(`${file}: two cases named ${k.name}`);
    names.add(k.name);
  }
  return cases;
}

function timecode(s: string): Timecode {
  const at = s.indexOf("=");
  return { ms: Number(s.slice(0, at)), text: s.slice(at + 1) };
}
