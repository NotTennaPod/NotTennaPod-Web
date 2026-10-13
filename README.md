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

- `npm run strings` converts NotTennaPod-iOS's `Localizable.strings` and `.stringsdict` (Android's English strings) into `src/generated/strings.ts`. It reads `../NotTennaPod-iOS/App/Resources/en.lproj/Localizable.strings`; set `NTP_IOS_STRINGS` to use another `Localizable.strings` file.
- `node scripts/icons.mjs` converts Android AntennaPod's vector drawables into `src/generated/icons.ts`. It reads them with git from the NotTennaPod-Android checkout at `../NotTennaPod-Android`, which must have the tag `3.12.1`; set `NTP_ANDROID` to use another checkout.

The generated files are committed, so the NotTennaPod-iOS and NotTennaPod-Android checkouts are needed only to regenerate wording and icons.

## Testing

- `npm run check`: type check, unit tests (`node --test`) and build.
- `npm run journeys`, `npm run player`, `npm run layout`: Playwright suites in Chromium, Firefox and WebKit against a real server, which they build from the server checkout (`NTP_SERVER`, default `../NotTennaPod-Server`). They also read the server checkout's fixtures and contract vectors. Install the Playwright browsers once with `npx playwright install` before running them.
- The player suite runs the browsers serially so cold media conversion has its own execution slot. Run it separately from heavy builds and race checks; its startup budgets and concurrent-use scenarios stay in place.
- To run the suites on a release candidate instead, give its binary: `NTP_SERVER_BINARY=/path/to/nottennapod-server npm run journeys`. It is checked and run as it is, never rebuilt; the app is still served from this checkout's `dist/`, so check out the candidate's web commit.
- The unit tests check the server checkout's shared contract vectors (canonical JSON, content hashes, cursors); without `NTP_SERVER` and without `../NotTennaPod-Server` they are skipped and say so.
- Test data: `test/vectors/queue_*.json` are unchanged copies of NotTennaPod-Server's `contract/vectors/queue_*.json`, so the queue tests run without a server checkout; the shownotes and media fixtures in `test/fixtures/` are written for these tests.

## The web actor

`e2e/acceptance/actor.ts` drives the web client for the integration acceptance (NotTennaPod-Server's `docs/PROTOCOL.md` §16): it speaks JSON lines on stdin and stdout, and works the real app in Chromium, one browser profile per installation. Its interface is [docs/ACTOR-PROTOCOL.md](docs/ACTOR-PROTOCOL.md). `npm run acceptance` runs its own test against a real server.

## Layout

- `src/api`: requests to the server's API and its read views.
- `src/journal`: the durable pending-write journal in IndexedDB and the pusher.
- `src/app`, `src/ui`, `src/screens`: the app.
- `test`: unit tests (`node --test`); `e2e`: Playwright journeys against a real server.

## Licence

GNU GPL v3 or later, like AntennaPod. Icons are AntennaPod's.
