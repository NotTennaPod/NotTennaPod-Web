# The web actor's protocol, version 1

The web actor (`e2e/acceptance/actor.ts`) lets the integration acceptance hub use the web client as a person would: it drives the real app in Chromium, through the same screens, menus and wording the journeys use. One actor runs one Chromium. Each **profile** is one browser context: its own cookies and IndexedDB, so once logged in it is one installation of the web client.

The hub checks the version with `hello` before anything else. Any change to a command, an argument, a result or an error code changes `PROTOCOL_VERSION` in `actor.ts` and this file together.

## Running it

From a web checkout with its dependencies (`npm ci`) and Playwright's Chromium (`npx playwright install chromium`):

```sh
node e2e/acceptance/actor.ts            # headless
node e2e/acceptance/actor.ts --headed   # a visible window, for debugging
```

- Requests come on stdin, answers go to stdout, one JSON object per line. stdout carries nothing else; diagnostics go to stderr.
- `NTP_ACTOR_TRACE=1` logs every command's outcome and duration on stderr.
- The actor exits when stdin ends, on SIGTERM or SIGINT, or after `shutdown`. It closes Chromium first.
- Audio is muted (`--mute-audio`); playback still runs and its time advances.

## Requests and answers

```json
{"id": 7, "cmd": "favorite", "profile": "w1", "args": {"episode": "e1:…", "wait": "settled"}}
{"id": 7, "ok": true, "result": {"changed": true, "op_ids": ["…"], "facts": [{"op_id": "…", "type": "favorite.set", "outcome": "applied"}]}}
{"id": 8, "ok": false, "error": {"code": "timeout", "message": "Timed out after 30000 ms waiting for …", "waiting_for": "…"}}
```

- `id` is a string or a number; the answer repeats it. A line that is not a JSON object with an `id` is answered with `"id": null` and `bad_request`.
- `profile` names the profile; commands about a profile need it.
- `args` holds the command's arguments; every command takes `timeout_ms` (1 to 1,800,000) to override its default.
- Every answer is either `ok: true` with a `result` object, or `ok: false` with an `error` object. An error has a `code` (below), a `message` for people, and sometimes more members. When the profile's tab is open, an error also carries `notice`: what the app's banners and snackbars say at the time (see the `notice` reading).

**Order.** A profile's commands run one at a time, in the order they arrive. Commands marked *immediate* run at once, beside a command still running for that profile: `hello`, `profiles`, `shutdown`, `close_tab`, `crash`, `delete_profile`, `held` and `release`. A command still running when its tab closes or crashes fails with `page_closed` or `page_crashed`. Different profiles run in parallel.

**Waits.** Every wait is for a condition: an element, a state of the app, a journal entry, a receipt. Nothing waits for a fixed time. Each command has a deadline (its default, or `timeout_ms`); every wait inside it uses what is left, the actor's own API lookups and journal reads included (a lookup is aborted in the page at the deadline). Running out is the error `timeout`, with `waiting_for` naming the condition. Nothing a command started outlives its answer, so the profile's next command never waits for it.

## Naming episodes and podcasts

- An episode is named by `episode` (its ID, `e1:…` or `e0:…`) or by `title` (its exact title), with `podcast` (the podcast's title) when titles repeat across podcasts. A title that matches no episode is `not_found`; one that matches several is `ambiguous`.
- A podcast is named by `podcast`: its ID (`p1:…`) or its exact title, among subscribed and archived podcasts.
- The actor finds the screen an episode or podcast is on through the read API, with the profile's own session. The action itself, and every reading, uses the screens.

## Commands

Defaults in brackets. Results that read the player are a *player reading* (see `player`).

### The actor

| Command | Arguments | Result |
| --- | --- | --- |
| `hello` (immediate) | `protocol` (optional: the version the hub speaks; another one is `protocol_mismatch`) | `{protocol, actor: "nottennapod-web-actor", app_version, playwright, browser, commands}` |
| `profiles` (immediate) | — | `{profiles: [{profile, base_url, tab, holds: [{hold, path, state}]}]}` |
| `shutdown` (immediate) | — | `{shutting_down: true}`, then the actor exits |

### Profiles and tabs

| Command | Arguments | Result |
| --- | --- | --- |
| `open` | `base_url`; `viewport` [`{width: 1280, height: 800}`] | A new profile with one tab on `base_url`: `{profile, state}`, `state` being `setup`, `sign_in`, `signed_in` or `unreachable` (the app's own "cannot reach the server" page). An open profile of that name is `profile_exists`. |
| `open_tab` | `path` [`/`] | A new tab in a profile whose tab was closed or crashed (as a person reopens the app): `{state}`. With a tab open: `tab_open`. |
| `reload` | — | The tab reloads: `{state}`. |
| `close_tab` (immediate) | — | The tab closes, as a person closes it: `{tab: "closed"}`. The profile keeps its data. |
| `crash` (immediate) | — | The tab's renderer crashes (CDP `Page.crash`): `{tab: "crashed"}`. The profile keeps its data. |
| `delete_profile` (immediate) | — | The profile and all its browser data (cookies, IndexedDB) are gone: `{deleted}`. `open` with the same name is a new installation. |
| `save_profile` | `path` | Writes the profile's cookies, local storage and IndexedDB as JSON (Playwright's storage state), for a failed run's artifacts: `{path}`. |

A profile's other commands need an open tab; otherwise they fail with `no_tab`.

### Faults: holding a request

| Command | Arguments | Result |
| --- | --- | --- |
| `hold` | `path`: a URL path, where `*` is one segment and `**` any number (`/v1/push`, `/v1/import/*/chunks/*`); `method` (optional); `fact_type` (optional: hold only a push carrying a fact of this type, such as `favorite.set`) | `{hold}`. The next request of the profile (any tab) that matches is held: it reaches neither the server nor, later, the page. Later matching requests pass. |
| `held` (immediate) | `hold` | Waits until the hold has a request: `{hold, method, path, query, facts}`. `facts` lists a push's facts as `{op_id, type}` (never payloads or secrets). |
| `release` (immediate) | `hold`; `mode` [`continue`]: `continue` sends the request on; `abort` fails it as a lost request (the server never sees it); `drop_answer` sends it to the server and fails it before the answer reaches the page | `{hold, state}`, `state` being `continued`, `aborted`, `answer_dropped` (with `server_status`), `cancelled` (nothing was held yet; the hold ends) or `gone` (the tab went away with the request; `detail` says what Playwright reported). |

### Actions

Actions are made on the screens, as a person makes them. Actions that write a change take `wait` [`settled`]: `journaled` returns once the app has journaled the change (the browser's durable record); `settled` also waits for the server's receipt. Their result names the facts written: `{op_ids, facts: [{op_id, type, outcome?, reason?}]}`, `outcome` and `reason` being the receipt's (`applied`, `superseded`, `not_applied`, `rejected`). Actions that find the state already as asked journal nothing and return `{changed: false}`; otherwise `changed: true`.

| Command | Arguments | What a person does | Result |
| --- | --- | --- | --- |
| `set_up` | `setup_code`, `username`, `password` | The first setup form | `{username}` |
| `log_in` | `username`, `password` | The sign-in form. A profile already logged in as that user answers `already: true`; as another user, `signed_in_as_other`. A refusal is `ui_error` with the form's message. | `{username, already}` |
| `subscribe` | `feed_url`; `username`, `password` (for a feed that asks); `wait` [`shown`]: `shown` also waits for the podcast's own tile to show the feed's title in Subscriptions (the server's first fetch) | Add podcast: the address, Episodes preview, the login form if the feed asks, Subscribe. A feed that asks without a login given is `needs_login`; a preview error is `ui_error`. A feed the account already has opens its podcast: `already: true` if it is subscribed or archived, else its Subscribe. | `{title, podcast_id?, op_ids, facts}`. `podcast_id` (with `settled` and `shown`) is the podcast this subscribe made, from its own fact: the podcast whose records the fact determines, else the one refreshed from the address it submitted; never one found by title. |
| `set_feed_login` | `podcast`, `username`, `password` [""] | The podcast's menu: Authentication (Android's feed settings), the username and password, Confirm. As the dialog does: an empty password with the username already shown keeps the saved login (`changed: false`); no username removes the login; a changed username without a password is refused by the dialog (`ui_error`, after Cancel). | `{changed, …facts}` |
| `favorite` | episode; `on` [true] | The episode's menu: Add to / Remove from favorites | `{changed, …facts}` |
| `mark_played` | episode; `played` [true] | The episode's menu: Mark as played / Mark as unplayed | `{changed, …facts}` |
| `queue_add` | episode | The episode's menu: Add to queue | `{changed, …facts}` |
| `queue_move` | episode; `to`: `top` or `bottom` [`top`] | Queue: the row's menu, Move to top / Move to bottom | facts |
| `queue_remove` | episode | Queue: the row's menu, Remove from queue | facts |
| `queue_clear` | — | Queue: More, Clear queue, Confirm | `{changed, …facts}` |
| `inbox_remove` | episode, or `all: true` | Inbox: the row's menu, Remove from inbox; or More, Remove all from inbox, Confirm | `{changed, …facts}` |
| `play` | episode; `require_relay` [false]: fail with `not_relayed` unless the audio comes through the server (relayed or converted) | The episode's screen: Stream. Waits until the audio plays. | player reading |
| `pause` | — | The player bar: Pause. Waits until the audio stops. | player reading |
| `seek` | `position_ms` | The player screen's position bar. Succeeds only when the audio is there, not when the screen shows it: after the seek the element has sought, or plays a new source (a new transport generation), has finished seeking, holds data, and is at the target on the episode's timeline (from 0.25 s before it to 1.5 s after), a converted stream starting at the target; while playing, the audio must then go on at least 0.5 s from where it arrived. Otherwise `timeout`, with `target_ms` and the last `transport` seen. The player screen is closed again either way. | player reading |
| `unsubscribe` | `podcast` | The podcast's menu: Unsubscribe / archive, Unsubscribe, Unsubscribe | facts |
| `clear_history` | — | History: More, Clear history, Confirm | `{changed, …facts}` |
| `reset_statistics` | — | Statistics: More, Reset statistics data, Confirm | facts |
| `import` | `file` (a path the actor can read); `kind`: `android_db` or `opml` [by the file's extension]; `wait` [`result`]: `started` returns once the upload has begun | Add podcast: Database import, or Import podcast list (OPML) | an import reading |
| `import_result` | — | Waits for the account's import to finish, on Add podcast, else in Settings (where it shows after a reload) | an import reading |
| `settle` | — | — | Waits until every journaled change has the server's receipt (what the journeys call settled): `{facts}` |

An import reading is `{state, text, imported?, skipped?, merged?, ambiguous?}`: `state` is `published`, `failed`, `running` or `error` (the browser could not upload; `text` is the screen's "Import error: …"), `text` the screen's status line, `imported` the report's counts `{podcasts, episodes, queue, favorites, history, inbox}`, and the others the counts of the report's lists.

### Readings

Readings report what the screens show. A reading opens its screen the way the app's links do (playback goes on); a tab already on that screen is read as it is, live. Every reading takes:
- `expect`: read again until the reading matches, or time out with `timeout` and `last` (the last reading). Objects match member by member (other members are ignored), arrays element by element with the same length, other values by equality.
- `reload` [false]: reload the tab first, as a person presses Reload.

| Reading | Arguments | Result |
| --- | --- | --- |
| `episode` | episode | The episode's row on its podcast's screen: `{episode_id, title, play_state, in_queue, favorite, position_ms, progress_shown, duration_ms, date, playing_here}`. `play_state` is `new` (the Inbox icon), `played` (the row shown played) or `unplayed`; `position_ms` is the position the row's progress shows, in whole seconds, and 0 when it shows none. |
| `queue`, `inbox`, `favorites`, `history` | — | `{episodes: [row…], counters: {queue, inbox}, toolbar_info}`: the screen's rows in its order, every page loaded, the drawer's counters, and the toolbar's count where the screen has one ("3 episodes"). |
| `subscriptions` | — | `{podcasts: [{podcast_id, title, counter}]}`: the Subscriptions grid. |
| `podcast` | `podcast` | `{podcast_id, title, authentication}`: the podcast's screen; `authentication` is the username it shows for the podcast's login ("✓" for a login without a username), or null for none. |
| `statistics` | — | `{total_ms, total_text, podcasts: [{podcast_id, title, played_ms, text}], months: [{month, played_ms, text}]}`: the Subscriptions tab and the Years tab. Times are what the screen shows, in whole minutes. |
| `notice` | — | `{unreachable, banners: [{role, text}], snackbars}`: `unreachable` is the app's "Cannot reach the NotTennaPod server. Retrying…"; `banners` every banner shown (unreachable, a refused change, pushes paused, waiting for a restore, recovery); `snackbars` the messages at the bottom. |
| `player` | — | A player reading: `{shown, title, subtitle, state, elapsed_ms, audio_ms, transport_ms, offset_ms, source}`. `state` is `playing`, `paused` or `elsewhere` ("Playing in another tab"); `elapsed_ms` the bar's elapsed time (whole seconds, on the episode's timeline, as the screen shows it); `audio_ms` the audio element's own time; `transport_ms` where the audio is on the episode's timeline (`offset_ms` plus the element's time); `offset_ms` where the element's stream starts (0, or a converted stream's start, from the server's descriptor or the start its address names); `source` `relay` (the server's relay), `converted` (the server's compatibility path), `direct` or `none`. Nothing in the player: `{shown: false}`. |
| `diagnostics` | `account` (optional: an account's ID or username); `fact` (optional: an op ID) | The server's diagnostics for the account, as given to this profile's session (an administrator may name any account). The web client shows only the account's own diagnostics, in Settings, so this reading uses the API. A session that may not see them gets `api_error` with `status: 403`. |

## Error codes

| Code | Meaning |
| --- | --- |
| `bad_request` | The request is malformed: not JSON, no `id`, an unknown command, a missing or wrong argument. |
| `protocol_mismatch` | `hello` named another protocol version; `protocol` is this actor's. |
| `browser_failed` | Chromium did not start. |
| `no_profile`, `profile_exists` | No profile of that name is open; one is. |
| `no_tab`, `tab_open` | The profile's tab is closed or crashed (`open_tab` opens one); a tab is open. |
| `page_closed`, `page_crashed` | The tab closed or crashed while the command ran. |
| `unreachable` | Loading a page (`open`, `open_tab`, `reload`, or a screen in a tab without the app) got no answer from the server, and the tab shows the browser's error page; or an API lookup failed without an answer. |
| `timeout` | A wait ran out: `waiting_for` names it; readings with `expect` add `last`. |
| `not_found`, `ambiguous` | No episode, podcast, account, hold or row matches; more than one does. |
| `not_in_ui` | The screen offers no way to do this (`message` says what it offers). |
| `ui_error` | The app showed an error for the action; `message` is its text. |
| `needs_login` | The feed asks for a username and password, and none were given. |
| `signed_out`, `signed_in_as_other` | The profile is not logged in; it is logged in as another user. |
| `not_playing`, `not_here`, `not_relayed` | Nothing is in the player; another tab holds it; the audio does not come through the relay. |
| `api_error` | The read API refused a lookup (`status` and `error` are the server's). |
| `internal` | Anything else: a fault in the actor. |
