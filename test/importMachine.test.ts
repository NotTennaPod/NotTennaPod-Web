// The import's state machine (PROTOCOL §11.5): lost answers are adopted,
// never failures; every 409 adopts the server's state; chunk layouts in both
// directions; an old server (9ee1e1d: no progress route, no cancel); progress
// not known against zero; backoff; terminal states release the rows and the
// unload prompt; a wrong file leaves the reservation untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, Unreachable, Unreadable } from "../src/api/http.ts";
import {
  advance, backoff, busy, chooseCheck, chunkSize, failure, guarded, hashed, layout, mount, mountReceived, parseCurrent, parseImport, parseProgress,
  type ImportRow, type JobState, type Outcome, type Progress,
} from "../src/app/importMachine.ts";
import { progressLine } from "../src/ui/importText.ts";

const MiB = 1 << 20;
const size = 7 * MiB; // three chunks: 3, 3 and 1 MiB
const row = (status: ImportRow["status"], extra: Partial<ImportRow> = {}): ImportRow => ({
  import_id: "i1", kind: "android_db", fingerprint: "f".repeat(64), size, file_name: "AntennaPodBackup.db", status, ...extra,
});
const ok = <T,>(value: T): Outcome<T> => ({ ok: true, value });
const lost: Outcome<never> = { ok: false, kind: "ambiguous" };
const refused = (status: number, code: string, message = "refused"): Outcome<never> => ({ ok: false, kind: "refused", status, code, message });
const progress = (status: ImportRow["status"], extra: Partial<Progress> = {}): Progress => ({ ...row(status), ...extra });
const uploading = (missing: number[], extra: Partial<JobState & { k: "uploading" }> = {}): JobState =>
  ({ k: "uploading", im: row("uploading"), sent: 0, missing, legacy: false, ...extra }) as JobState;
const finishing: JobState = { k: "finishing", im: row("uploading"), legacy: false, repaired: false };

test("a lost reservation is asked again (the same fingerprint returns the same import), then adopted in any state", () => {
  const s: JobState = { k: "reserving", file: { name: "a.db", size, kind: "android_db" }, fingerprint: "f".repeat(64) };
  const again = advance(s, { c: "reserve" }, lost);
  assert.deepEqual(again.next, { c: "reserve" });
  assert.equal(again.waiting, true);
  assert.equal(again.state.k, "reserving");
  assert.equal(advance(s, { c: "reserve" }, ok(row("uploading"))).next.c, "received");
  assert.equal(advance(s, { c: "reserve" }, ok(row("processing"))).state.k, "processing");
  const pub = advance(s, { c: "reserve" }, ok(row("published")));
  assert.equal(pub.state.k, "published");
  assert.equal(pub.next.c, "report");
});

test("a lost chunk is sent again; a lost finish is asked again and its state adopted; a lost cancel is asked again", () => {
  const put = advance(uploading([1, 2]), { c: "put", n: 1 }, lost, 2);
  assert.deepEqual(put.next, { c: "put", n: 1 });
  assert.equal(put.after, 4000);
  const fin = advance(finishing, { c: "finish" }, lost);
  assert.deepEqual(fin.next, { c: "finish" });
  assert.equal(advance(finishing, { c: "finish" }, ok(row("processing"))).state.k, "processing");
  assert.equal(advance(finishing, { c: "finish" }, ok(row("published"))).state.k, "published");
  const cancel = advance(uploading([1]), { c: "cancel", restart: false }, lost);
  assert.deepEqual(cancel.next, { c: "cancel", restart: false });
  assert.equal(cancel.waiting, true);
  // Never a failure.
  for (const st of [put, fin, cancel]) assert.notEqual(st.state.k, "failed");
});

test("every ambiguous answer is classified as lost: no answer, a server error, too many requests, a success that could not be read", () => {
  assert.deepEqual(failure(new Unreachable("down")), { ok: false, kind: "ambiguous" });
  assert.deepEqual(failure(new Unreadable("cut")), { ok: false, kind: "ambiguous" });
  assert.deepEqual(failure(new ApiError(503, "server_busy", "busy", 7)), { ok: false, kind: "ambiguous", retryAfter: 7 });
  assert.deepEqual(failure(new ApiError(429, "rate_limited", "slow", 30)), { ok: false, kind: "ambiguous", retryAfter: 30 });
  assert.deepEqual(failure(new ApiError(401, "unauthorized", "no")), { ok: false, kind: "auth" });
  assert.deepEqual(failure(new DOMException("The account changed.", "AbortError")), { ok: false, kind: "auth" });
  assert.equal((failure(new ApiError(409, "import_exists", "x")) as { kind: string }).kind, "refused");
  // A cut-off success is not an import: it is a lost answer.
  assert.equal(parseImport({}), undefined);
  assert.equal(parseImport({ import_id: "i1", status: "uploading" }), undefined);
  assert.equal(parseProgress({ ...row("uploading") }), undefined, "an upload's progress without its chunks");
  assert.equal(parseProgress({ ...row("processing") }), undefined, "processing without its (possibly null) step");
  assert.deepEqual(parseProgress({ ...row("processing"), processing: null })?.processing, null);
  assert.equal(parseCurrent({}), undefined);
  assert.deepEqual(parseCurrent({ import: null }), { import: null });
});

test("each 409: another import is shown, a chunk or a cancel refused re-reads and adopts the state; nothing is reserved again", () => {
  const s: JobState = { k: "reserving", file: { name: "a.db", size, kind: "android_db" }, fingerprint: "f".repeat(64) };
  assert.equal(advance(s, { c: "reserve" }, refused(409, "import_exists")).next.c, "current");
  const other = advance(s, { c: "current" }, ok({ import: row("uploading", { file_name: "Other.db", import_id: "i2" }) }));
  assert.equal(other.state.k, "interrupted", "another file's upload is shown, never continued with this file");
  assert.deepEqual(other.notice, { n: "other_import", file: "Other.db" });
  assert.equal(other.next.c, "stop");
  // A chunk refused: another tab finished, or the upload was cancelled.
  const put = advance(uploading([1]), { c: "put", n: 1 }, refused(409, "import_not_uploading"));
  assert.deepEqual(put.next, { c: "get" });
  assert.equal(advance(uploading([1]), { c: "get" }, ok(row("processing"))).state.k, "processing");
  assert.equal(advance(uploading([1]), { c: "get" }, ok(row("published"))).state.k, "published");
  const cancelled = advance(uploading([1]), { c: "get" }, ok(row("failed", { reason: "cancelled" })));
  assert.deepEqual([cancelled.state.k, cancelled.notice], ["idle", { n: "cancelled" }]);
  // A cancel refused (Finish won in another tab): the state is read and adopted; no new reservation.
  const c = advance(uploading([1]), { c: "cancel", restart: true }, refused(409, "import_not_uploading"));
  assert.deepEqual(c.next, { c: "get" });
  const after = advance(uploading([1]), { c: "get" }, ok(row("processing")));
  assert.equal(after.state.k, "processing");
  assert.notEqual(after.next.c, "reserve");
});

test("chunk layouts: this client's 3 MiB chunks continue with the missing ones only; 4 MiB, 1 MiB and stale extra chunks cannot", () => {
  assert.deepEqual(layout(size, []), [0, 1, 2]);
  assert.deepEqual(layout(size, [[0, 3 * MiB], [2, MiB]]), [1]);
  assert.deepEqual(layout(size, [[0, 3 * MiB], [1, 3 * MiB], [2, MiB]]), []);
  assert.equal(layout(size, [[0, 4 * MiB]]), undefined, "begun with larger chunks");
  assert.equal(layout(size, [[0, MiB], [1, MiB]]), undefined, "begun with smaller chunks");
  assert.equal(layout(size, [[0, 3 * MiB], [5, MiB]]), undefined, "a stale index beyond this layout");
  assert.equal(layout(size, [[2, 3 * MiB]]), undefined, "a last chunk of the wrong length");
  // From an answer: only the missing chunks are sent; a mismatch offers starting again.
  const go = advance(uploading([]), { c: "received" }, ok(progress("uploading", { received: { chunks: [[0, chunkSize]], bytes: chunkSize } })));
  assert.deepEqual(go.next, { c: "put", n: 1 });
  assert.equal((go.state as JobState & { k: "uploading" }).sent, chunkSize);
  const mm = advance(uploading([]), { c: "received" }, ok(progress("uploading", { received: { chunks: [[0, 4 * MiB]], bytes: 4 * MiB } })));
  assert.deepEqual([mm.state.k, (mm.state as { why?: string }).why, mm.next.c], ["mismatch", "layout", "stop"]);
});

test("a finish that does not match: missing chunks are sent once; all there means a damaged chunk, offered as starting again, never another finish", () => {
  const recheck = advance(finishing, { c: "finish" }, refused(400, "invalid_request"));
  assert.deepEqual(recheck.next, { c: "received" });
  const all = ok(progress("uploading", { received: { chunks: [[0, chunkSize], [1, chunkSize], [2, MiB]], bytes: size } }));
  const damaged = advance(recheck.state, { c: "received" }, all);
  assert.deepEqual([damaged.state.k, (damaged.state as { why?: string }).why, damaged.next.c], ["mismatch", "damaged", "stop"]);
  // Missing ones are sent, then one more finish; a second mismatch is damage.
  const some = advance(recheck.state, { c: "received" }, ok(progress("uploading", { received: { chunks: [[0, chunkSize]], bytes: chunkSize } })));
  assert.deepEqual(some.next, { c: "put", n: 1 });
  let st = advance(some.state, { c: "put", n: 1 }, ok({}));
  st = advance(st.state, { c: "put", n: 2 }, ok({}));
  assert.deepEqual([st.state.k, st.next.c], ["finishing", "finish"]);
  const again = advance(st.state, { c: "finish" }, refused(400, "invalid_request"));
  assert.deepEqual([again.state.k, (again.state as { why?: string }).why], ["mismatch", "damaged"]);
});

test("an old server (9ee1e1d): no progress route, so every chunk is sent, processing is polled on the import, and there is no cancel", () => {
  const probe = advance(uploading([]), { c: "received" }, refused(404, "not_found"));
  assert.deepEqual(probe.next, { c: "get", probe: true });
  const all = advance(uploading([]), { c: "get", probe: true }, ok(row("uploading")));
  assert.deepEqual(all.next, { c: "put", n: 0 });
  assert.deepEqual((all.state as JobState & { k: "uploading" }).missing, [0, 1, 2]);
  assert.equal((all.state as JobState & { k: "uploading" }).legacy, true);
  // A legacy finish that does not match is final (no layout to check).
  const fin = advance({ k: "finishing", im: row("uploading"), legacy: true, repaired: false }, { c: "finish" }, refused(400, "invalid_request", "send again"));
  assert.deepEqual([fin.state.k, fin.notice], ["interrupted", { n: "error", message: "send again" }]);
  // Processing: the import is polled, its step never known; publication brings its report at once.
  const proc: JobState = { k: "processing", im: row("processing"), phase: null, legacy: true };
  const p = advance(proc, { c: "progress" }, ok(row("processing")));
  assert.deepEqual([p.state.k, (p.state as { phase: unknown }).phase, p.after], ["processing", null, 1000]);
  const pub = advance(proc, { c: "progress" }, ok(row("published", { result: {} })));
  assert.deepEqual([pub.state.k, pub.next.c], ["published", "stop"]);
  // At mount: an interrupted upload on an old server has no Cancel (legacy).
  const m = mount(row("uploading"));
  assert.equal(m.state.k, "interrupted");
  const r = mountReceived(m.state as JobState & { k: "interrupted" }, refused(404, "not_found"));
  assert.deepEqual(r.next, { c: "get", probe: true });
  const legacy = advance(m.state, { c: "get", probe: true }, ok(row("uploading")));
  assert.deepEqual([legacy.state.k, (legacy.state as { legacy: boolean }).legacy, legacy.next.c], ["interrupted", true, "stop"]);
  // A cancel the old server does not know keeps the upload interrupted.
  const c = advance({ k: "interrupted", im: row("uploading"), legacy: true }, { c: "cancel", restart: false }, refused(404, "not_found"));
  assert.equal(c.state.k, "interrupted");
});

test("progress not known is not zero; the refresh is followed every 3 s until done, expired or unavailable", () => {
  const proc: JobState = { k: "processing", im: row("processing"), phase: null, legacy: false };
  assert.equal(progressLine(proc)?.text, "Importing…");
  assert.equal(progressLine({ ...proc, phase: { phase: "importing", done: 0, total: 16 } } as JobState)?.text, "Importing… 0 of 16 podcasts");
  assert.equal(progressLine({ ...proc, phase: { phase: "reading", done: 0, total: 0 } } as JobState)?.text, "Importing…");
  const step = advance(proc, { c: "progress" }, ok(progress("processing", { processing: { phase: "importing", done: 3, total: 16 } })));
  assert.deepEqual([step.after, (step.state as { phase: unknown }).phase], [1000, { phase: "importing", done: 3, total: 16 }]);
  const pub = advance(proc, { c: "progress" }, ok(progress("published", { refresh: { status: "running", total: 16, attempted: 2, succeeded: 2, failed: 0, until: 1 } })));
  assert.deepEqual([pub.state.k, pub.next.c], ["published", "report"]);
  const rep = advance(pub.state, { c: "report" }, ok(row("published", { result: { imported: {} } })));
  assert.deepEqual([rep.next.c, rep.after], ["progress", 3000]);
  assert.equal(progressLine(rep.state)?.text, "Refreshing podcasts… 2 of 16");
  const running = advance(rep.state, { c: "progress" }, ok(progress("published", { refresh: { status: "running", total: 16, attempted: 9, until: 1 } })));
  assert.deepEqual([running.next.c, running.after], ["progress", 3000]);
  for (const [refresh, text] of [
    [{ status: "done", total: 16, attempted: 16, succeeded: 14, failed: 2, until: 1 }, "Refreshed 14 of 16 podcasts; 2 could not be refreshed."],
    [{ status: "done", total: 16, attempted: 16, succeeded: 16, failed: 0, until: 1 }, undefined],
    [{ status: "expired", total: 16, attempted: 12, succeeded: 11, failed: 1, until: 1 }, "11 of 16 podcasts refreshed; the others will be refreshed later."],
    [{ status: "unavailable", until: 1 }, "How the refresh of the imported podcasts is going can't be shown here. They are refreshed as usual."],
  ] as const) {
    const end = advance(rep.state, { c: "progress" }, ok(progress("published", { refresh: refresh as Progress["refresh"] })));
    assert.equal(end.next.c, "stop", refresh.status);
    assert.equal(progressLine(end.state)?.text, text);
  }
});

test("backoff: 1 s doubling to 30 s, never below Retry-After", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoff(n)), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(backoff(1, 12), 12000);
  assert.equal(backoff(6, 5), 30000);
  const s = advance({ k: "processing", im: row("processing"), phase: null, legacy: false }, { c: "progress" }, { ok: false, kind: "ambiguous", retryAfter: 9 }, 0);
  assert.deepEqual([s.after, s.waiting, s.next.c], [9000, true, "progress"]);
});

test("terminal and waiting-for-the-person states release the rows and the unload prompt", () => {
  const on: JobState[] = [
    { k: "hashing", file: { name: "a", size, kind: "opml" }, read: 0 },
    { k: "reserving", file: { name: "a", size, kind: "opml" }, fingerprint: "f" },
    uploading([1]),
    finishing,
  ];
  for (const s of on) assert.deepEqual([guarded(s), busy(s)], [true, true], s.k);
  const off: JobState[] = [
    { k: "idle" },
    { k: "processing", im: row("processing"), phase: null, legacy: false },
    { k: "published", im: row("published"), legacy: false },
    { k: "failed", im: row("failed", { reason: "invalid_file: x" }) },
    { k: "interrupted", im: row("uploading"), legacy: false },
    { k: "mismatch", im: row("uploading"), why: "layout" },
    { k: "gone" },
  ];
  for (const s of off) assert.deepEqual([guarded(s), busy(s)], [false, false], s.k);
  // An error while sending leaves the upload continuable, the prompt off.
  const err = advance(uploading([1]), { c: "put", n: 1 }, refused(507, "insufficient_space", "no room"));
  assert.deepEqual([err.state.k, guarded(err.state), err.notice], ["interrupted", false, { n: "error", message: "no room" }]);
  const gone = advance({ k: "processing", im: row("processing"), phase: null, legacy: false }, { c: "progress" }, refused(404, "not_found"));
  assert.deepEqual(gone.next, { c: "get", probe: true });
  assert.equal(advance({ k: "processing", im: row("processing"), phase: null, legacy: false }, { c: "get", probe: true }, refused(404, "not_found")).state.k, "gone");
  assert.equal(advance({ k: "processing", im: row("processing"), phase: null, legacy: false }, { c: "progress" }, ok(row("failed", { reason: "x" }))).state.k, "failed");
});

test("a wrong file leaves the upload untouched: another size at once, another fingerprint after reading, before any request", () => {
  const s: JobState = { k: "interrupted", im: row("uploading"), legacy: false };
  assert.deepEqual(chooseCheck(s, { name: "x.db", size: size + 1, kind: "android_db" }), { n: "wrong_file", expected: "AntennaPodBackup.db" });
  assert.deepEqual(chooseCheck(s, { name: "x.opml", size, kind: "opml" }), { n: "wrong_file", expected: "AntennaPodBackup.db" });
  assert.equal(chooseCheck(s, { name: "same.db", size, kind: "android_db" }), undefined);
  assert.deepEqual(chooseCheck({ k: "idle" }, { name: "huge.db", size: 3 * 2 ** 30, kind: "android_db" }), { n: "error", message: "too_large" });
  const hashing: JobState & { k: "hashing" } = { k: "hashing", file: { name: "same.db", size, kind: "android_db" }, read: size, resume: { im: row("uploading"), legacy: false } };
  const wrong = hashed(hashing, "0".repeat(64));
  assert.deepEqual([wrong.state.k, wrong.next.c, wrong.notice], ["interrupted", "stop", { n: "wrong_file", expected: "AntennaPodBackup.db" }]);
  assert.equal((wrong.state as { im: ImportRow }).im.import_id, "i1");
  const right = hashed(hashing, "f".repeat(64));
  assert.deepEqual([right.state.k, right.next.c], ["uploading", "received"]);
  assert.deepEqual(hashed({ ...hashing, resume: undefined }, "a".repeat(64)).next, { c: "reserve" });
});

test("a session that ended, or another account, detaches the job without a word", () => {
  const s = advance(uploading([1]), { c: "put", n: 1 }, { ok: false, kind: "auth" });
  assert.equal(s.detach, true);
  assert.equal(s.next.c, "stop");
});

test("Start again: once the cancel is confirmed the same file is reserving, rows disabled and leaving guarded, through lost answers", () => {
  const mismatch: JobState = { k: "mismatch", im: row("uploading", { kind: "opml", file_name: "subscriptions.opml" }), why: "layout" };
  const cancelled = advance(mismatch, { c: "cancel", restart: true }, ok(row("failed", { reason: "cancelled", kind: "opml", file_name: "subscriptions.opml" })));
  assert.deepEqual(cancelled.state, { k: "reserving", file: { name: "subscriptions.opml", size, kind: "opml" }, fingerprint: "f".repeat(64) });
  assert.deepEqual(cancelled.next, { c: "reserve" });
  assert.deepEqual([busy(cancelled.state), guarded(cancelled.state)], [true, true]);
  // Its answer lost: asked again, still reserving.
  const lostOnce = advance(cancelled.state, { c: "reserve" }, lost);
  assert.deepEqual([lostOnce.state.k, lostOnce.next.c, lostOnce.waiting, busy(lostOnce.state), guarded(lostOnce.state)], ["reserving", "reserve", true, true, true]);
  // Answered: the new import is sent from its first chunk.
  const fresh = advance(lostOnce.state, { c: "reserve" }, ok(row("uploading", { import_id: "i2" })));
  assert.deepEqual([fresh.state.k, fresh.next.c], ["uploading", "received"]);
  // A plain Cancel still ends idle.
  assert.equal(advance(mismatch, { c: "cancel", restart: false }, ok(row("failed", { reason: "cancelled" }))).state.k, "idle");
});

test("answers whose parts are malformed are not taken: the step, the refresh and the report are checked whole", () => {
  const p = (extra: Record<string, unknown>) => parseProgress({ ...row("processing"), ...extra });
  assert.ok(p({ processing: null }));
  assert.ok(p({ processing: { phase: "importing", done: 3, total: 16 } }));
  assert.equal(p({ processing: { phase: "importing", done: "3", total: 16 } }), undefined);
  assert.equal(p({ processing: { phase: "dreaming", done: 3, total: 16 } }), undefined);
  assert.equal(p({ processing: {} }), undefined);
  const r = (refresh: Record<string, unknown>) => parseProgress({ ...row("published"), refresh });
  assert.ok(r({ status: "running", total: 2, attempted: 1, succeeded: 1, failed: 0, until: 1 }));
  assert.ok(r({ status: "unavailable", until: 1 }));
  assert.equal(r({ status: "running", until: 1 }), undefined, "counts missing");
  assert.equal(r({ status: "starting", until: 1 }), undefined, "an unknown status");
  assert.equal(r({ status: "done", total: 2, attempted: 2, succeeded: 2, failed: 0 }), undefined, "no end");
  const result = { imported: { podcasts: 1, episodes: 2, queue: 0, favorites: 0, history: 0, inbox: 0 }, skipped: [], ambiguous: null, merged: [{ title: "x" }] };
  assert.ok(parseImport(row("published", { result })));
  assert.equal(parseImport(row("published", { result: { imported: { podcasts: 1 } } })), undefined);
  assert.equal(parseImport(row("published", { result: { ...result, skipped: [{}] } })), undefined);
  assert.equal(parseImport(row("published", { result: "cut" })), undefined);
  // What is not carried: absent on an older server's report; checked whole when present.
  const nc = { podcasts: [{ title: "x", source_feed_id: 2, settings: ["playback_speed"] }], episode_auto_download_off: 3 };
  assert.ok(parseImport(row("published", { result: { ...result, not_carried: nc } })));
  assert.equal(parseImport(row("published", { result: { ...result, not_carried: { ...nc, episode_auto_download_off: -1 } } })), undefined);
  assert.equal(parseImport(row("published", { result: { ...result, not_carried: { ...nc, podcasts: [{ title: "x", settings: [1] }] } } })), undefined);
  assert.equal(parseImport(row("published", { result: { ...result, not_carried: { ...nc, podcasts: [{ title: "x", url: 1, settings: [] }] } } })), undefined);
  assert.equal(parseProgress({ ...row("uploading"), received: { chunks: [[0, -1]], bytes: 0 } }), undefined);
});
