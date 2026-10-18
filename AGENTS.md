# NotTennaPod-Web: agent instructions

## The goal

The NotTennaPod browser client. At a high level it follows AntennaPod's user experience (the same library concepts, lists, wording, icons and behaviour), adapted from mobile to the web: browser layouts, mouse and keyboard, no phone-only patterns. It syncs through NotTennaPod-Server, whose protocol is `docs/PROTOCOL.md` in the NotTennaPod-Server repository. It is online-only and has no standalone mode (PROTOCOL §1.1).

It is one of four NotTennaPod repositories, checked out side by side: NotTennaPod-Server, which embeds and serves the built app; NotTennaPod-iOS, the iOS app, whose `Localizable.strings` (Android's English strings) are the source of the generated wording; and NotTennaPod-Android, upstream AntennaPod plus test-only exporters for the Android reference results, whose vector drawables are the source of the generated icons.

The target is AntennaPod's latest tagged release. The code is currently built around AntennaPod 3.12.1; when a new release comes out, compare it with what the code was built around and update the app, its generated wording and icons, its tests and its test data. The [README](README.md) covers building, testing and the code layout, and [ACTOR-PROTOCOL](docs/ACTOR-PROTOCOL.md) the web actor for the integration acceptance.

## Rules that matter

- Nothing the person did is lost: every action is committed to the pending-write journal in IndexedDB before the app calls it done, so a reload or a closed tab loses nothing and the next page load sends what is left.
- It works in Chromium, Firefox and WebKit.
- Accessibility: every control is reachable by keyboard and named for screen readers, at narrow and wide widths and in right-to-left languages.
- Wording and icons are generated from the sources (`npm run strings`, `scripts/icons.mjs`), never retyped.
- For every difference or failing check, ask whether a person would notice. If yes, fix it; if no, don't spend effort on it.

## How to build and test

Node 24 or later. The suites that run a server also need Go 1.26 or later (or `NTP_SERVER_BINARY`); the player suite and the acceptance test need `openssl` (1.1.1 or later), and the player suite ffmpeg and ffprobe 6 or later (see the README).

```sh
npm ci
npm run check        # type check, unit tests, build
```

The Playwright suites run against a real server built from a NotTennaPod-Server checkout (`NTP_SERVER`, default `../NotTennaPod-Server`):

```sh
npm run journeys
npm run player
npm run layout
npm run acceptance   # the web actor's own test
```

## Before every push

Work happens on branches. Before pushing, make sure everything wanted is merged into `main`. Push only `main`: never another branch, `--all`, `--mirror` or tags.

Always run the privacy scan first, before every push without exception, however small. Scan everything that will be pushed (the tracked files, and the metadata of every commit being pushed) for personally identifiable information or anything else that shouldn't go to GitHub:

- personal names, usernames and email addresses; the commit author and committer must be the project identity;
- home directories and absolute local paths, machine and host names, IP addresses, device and Simulator identifiers, and Apple team IDs;
- keys, tokens, passwords, certificates and signing profiles; documented public keys, such as AntennaPod's Podcast Index pair, are the exception;
- time zones and locale: commit dates must be in UTC, and no local time-zone names, offsets or locale may appear in files, fixtures or logs;
- personal data: real podcast libraries, OPML, databases, listening history and screenshots;
- metadata hidden in binary files, such as EXIF or GPS in images and tags in audio;
- internal notes, mentions of AI tools or review process, logs, build outputs, caches and other artifacts.

Fix anything found before pushing.
