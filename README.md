# NotTennaPod-Web

The browser client of NotTennaPod: Android AntennaPod's screens, wording and icons in a browser, synced through NotTennaPod-Server. It is not affiliated with AntennaPod.

**AntennaPod version.** The target is AntennaPod's latest tagged release. The current code is built around AntennaPod 3.12.1 and is updated as new releases come out; version numbers in the code, tests and test data record what each part was built and checked against.

The server serves the built app itself (one binary), so a browser opens the server's address and signs in.

The sync protocol is NotTennaPod-Server's `docs/PROTOCOL.md`; comments here cite its sections as `PROTOCOL §N`.

## Building

Node 24 or later (from https://nodejs.org/ or `brew install node`). Dependencies are pinned in `package-lock.json`. Clone NotTennaPod-Server next to this checkout (as `../NotTennaPod-Server`): the install step and the Playwright suites use it, and the unit tests read its contract vectors.

```sh
npm ci
npm run check                # type check, unit tests, build
npm run install-into-server  # copy dist/ into ../NotTennaPod-Server/internal/webui/dist
```

`NTP_SERVER=/path/to/NotTennaPod-Server npm run install-into-server` installs into another server checkout. Then rebuild the server (`make build` there) to embed the app. The installed files are ignored in the server checkout, so it stays clean.

Wording and icons are generated, never retyped:

- `npm run strings` converts NotTennaPod-iOS's `Localizable.strings` and `.stringsdict` (Android's English strings) into `src/generated/strings.ts`. It reads `../NotTennaPod-iOS/App/Resources/en.lproj/Localizable.strings` and the `.stringsdict` beside it; set `NTP_IOS_STRINGS` to use another `Localizable.strings` file, and `NTP_IOS_PLURALS` another `.stringsdict`.
- `node scripts/icons.mjs` converts Android AntennaPod's vector drawables into `src/generated/icons.ts`. It reads them with git from the NotTennaPod-Android checkout at `../NotTennaPod-Android`, which must have the tag `3.12.1`; set `NTP_ANDROID` to use another checkout.

The generated files are committed, so the NotTennaPod-iOS and NotTennaPod-Android checkouts are needed only to regenerate wording and icons. Wording Android has no string for, because it describes the browser or the server, is kept apart in `src/webStrings.ts`, written in Android's style.

## Testing

- `npm run check`: type check, unit tests (`node --test`) and build. The unit tests include a power user's library: a list action over 100,000 episodes is journaled together and sent as facts the server accepts, and a displayed list re-read at a newer head costs one request of at most 200 rows, however far it was scrolled.
- `npm run journeys`, `npm run player`, `npm run layout`: Playwright suites in Chromium, Firefox and WebKit against a real server, which they build from the server checkout (`NTP_SERVER`, default `../NotTennaPod-Server`). They also read the server checkout's fixtures and contract vectors. Install the Playwright browsers once with `npx playwright install` before running them. A test has no overall time limit; each wait has its own.
  - The journeys: setup, sign-in, an Android backup import and the everyday actions, each checked on the server; multi select; recovery after a server restore; a session renewal whose answer arrives after logging out and in again; Save recovery key; the library import with its progress, reloads and interruptions; Refresh with its progress; and lists that update in place on a podcast of 5,000 episodes.
  - The player: playback checked on the server through the read API, its races, starting an episode from a slow publisher, the MediaSource feed of converted streams, and chapters from a Podcast Index chapters file with the position bar's chapter marks.
  - The layout: every screen at 360, 800 and 1280 px, left-to-right and right-to-left, and keyboard-only use. Screenshots go to `.work/layout-shots` for checking by eye.
- The suites that run a server (the journeys, player and layout suites and the web actor's test) build it with Go 1.26 or later (`go` on `PATH`), unless `NTP_SERVER_BINARY` gives a built server. The player suite and the web actor's test make their HTTPS publisher's certificate with `openssl`, whose `req` must take `-addext` (OpenSSL 1.1.1 or later). The player suite also needs ffmpeg and ffprobe on `PATH`: ffmpeg makes its ALAC, Vorbis and Opus episodes, and the server converts with both (ffmpeg 6 or later, with the `aac` and `libopus` encoders). NotTennaPod-Server's README (Development, and Browser media) says more about both.
- `npx playwright test shownotes`: show notes in the three browsers, every fixture rendered under the server's Content Security Policy by a small Node server; it needs no server checkout.
- The player suite runs the browsers serially so cold media conversion has its own execution slot. Run it separately from heavy builds and race checks, which compete with its deadlines for playback to start and its scenarios of several tabs at once.
- To run the suites on a release candidate instead, give its binary: `NTP_SERVER_BINARY=/path/to/nottennapod-server npm run journeys`. It is checked and run as it is, never rebuilt; the app is still served from this checkout's `dist/`, so check out the candidate's web commit.
- The unit tests check the server checkout's shared contract vectors (canonical JSON, content hashes, cursors); without `NTP_SERVER` and without `../NotTennaPod-Server` they are skipped and say so.
- Test data: `test/vectors/queue_*.json` are unchanged copies of NotTennaPod-Server's `contract/vectors/queue_*.json`, so the queue tests run without a server checkout; the shownotes and media fixtures in `test/fixtures/` are written for these tests.

## The web actor

`e2e/acceptance/actor.ts` drives the web client for the integration acceptance (NotTennaPod-Server's `docs/PROTOCOL.md` §16): it speaks JSON lines on stdin and stdout, and works the real app in Chromium, one browser profile per installation. Its interface is [docs/ACTOR-PROTOCOL.md](docs/ACTOR-PROTOCOL.md). `npm run acceptance` runs its own test against a real server.

## Layout

- `src/api`: requests to the server's API and its read views.
- `src/journal`: the durable pending-write journal in IndexedDB, the pusher, and recovery after a server restore.
- `src/app`: the tab's sync loop, re-reading displayed views once per newer head, actions, Refresh progress and the library import job.
- `src/ui`, `src/screens`: the shell, the shared components (paged lists, multi select, dialogs) and the screens.
- `src/player`: the player: sessions, saves and the fenced lease in IndexedDB, and the `<audio>` element with the server's relay and converted streams.
- `src/queue`: queue keys and the keep-sorted order, as the server computes them.
- `src/shownotes`: show notes, sanitized and cleaned as Android cleans them.
- `src/generated`: the generated wording and icons.
- `test`: unit tests (`node --test`); `e2e`: Playwright suites against a real server; `e2e/acceptance`: the web actor.

## Licence

GNU GPL v3 or later, like AntennaPod. Icons are AntennaPod's.
