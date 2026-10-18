// The import's job against a small in-memory server, through the real request
// helper (src/api/http.ts): successes cut off part-way (truncated 200 and 201
// bodies) are reconciled, never failures; a lost or refused cancel never
// reserves again; a resumed upload sends only its missing chunks; a wrong file
// sends nothing; a stale sign-in's answer is dropped; an old server gets every
// chunk; another chunking is started again only when asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { endGeneration, request, requestStrict, Unreadable, useAccount } from "../src/api/http.ts";
import * as job from "../src/app/importJob.ts";
import { busy, guarded, type ImportRow, type JobState } from "../src/app/importMachine.ts";

const MiB = 1 << 20;

interface Held {
  row: ImportRow;
  chunks: Map<number, Buffer>;
  polls: number;
}

type Override = (path: string, init: RequestInit, effect: () => Response) => Response | Promise<Response | undefined> | undefined;

/** FakeServer answers the import routes as PROTOCOL §11.5 does (legacy: as 9ee1e1d, without progress and cancel). */
class FakeServer {
  imports: Held[] = [];
  log: string[] = [];
  legacy = false;
  overrides: Override[] = [];
  private next = 1;

  live(): Held | undefined {
    return this.imports.find((h) => h.row.status !== "failed");
  }

  json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  error(status: number, code: string): Response {
    return this.json(status, { error: code, message: code });
  }

  rowOf(h: Held, withResult: boolean): Record<string, unknown> {
    const { result, ...rest } = h.row;
    return withResult && h.row.status === "published" ? { ...rest, result } : rest;
  }

  /** hold makes an upload the account has, with chunks already sent. */
  hold(data: Buffer, name: string, chunks: [number, number, number][] = []): Held {
    const h: Held = {
      row: { import_id: `i${this.next++}`, kind: "android_db", fingerprint: createHash("sha256").update(data).digest("hex"), size: data.length, file_name: name, status: "uploading" },
      chunks: new Map(chunks.map(([n, from, to]) => [n, data.subarray(from, to)])),
      polls: 0,
    };
    this.imports.push(h);
    return h;
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const path = String(input);
    const method = init.method ?? "GET";
    this.log.push(`${method} ${path}`);
    const effect = () => this.route(method, path, init);
    for (const o of this.overrides) {
      const r = await o(`${method} ${path}`, init, effect);
      if (r) {
        this.overrides.splice(this.overrides.indexOf(o), 1);
        return r;
      }
    }
    return effect();
  };

  route(method: string, path: string, init: RequestInit): Response {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (method === "POST" && path === "/v1/import") {
      const live = this.live();
      if (live) return live.row.fingerprint === body.fingerprint ? this.json(200, this.rowOf(live, true)) : this.error(409, "import_exists");
      const h: Held = { row: { import_id: `i${this.next++}`, kind: body.kind, fingerprint: body.fingerprint, size: body.size, file_name: body.file_name, status: "uploading" }, chunks: new Map(), polls: 0 };
      this.imports.push(h);
      return this.json(201, this.rowOf(h, false));
    }
    if (path === "/v1/import") {
      const cur = this.live() ?? this.imports.at(-1);
      return this.json(200, { import: cur ? this.rowOf(cur, true) : null });
    }
    const m = /^\/v1\/import\/([^/]+)(?:\/(progress|cancel|finish|chunks\/(\d+)))?$/.exec(path);
    const h = m && this.imports.find((x) => x.row.import_id === m[1]);
    if (!m || (this.legacy && (m[2] === "progress" || m[2] === "cancel"))) return this.error(404, "not_found");
    if (!h) return this.error(404, "not_found");
    const what = m[2] ?? "";
    if (what === "" && method === "GET") {
      this.poll(h);
      return this.json(200, this.rowOf(h, true));
    }
    if (what === "progress") {
      this.poll(h);
      const p: Record<string, unknown> = this.rowOf(h, false);
      if (h.row.status === "uploading") {
        const chunks = [...h.chunks].sort((a, b) => a[0] - b[0]).map(([n, b]) => [n, b.length]);
        p.received = { chunks, bytes: chunks.reduce((s, c) => s + c[1]!, 0) };
      }
      if (h.row.status === "processing") p.processing = h.polls > 1 ? { phase: "importing", done: 1, total: 2 } : null;
      if (h.row.status === "published") p.refresh = { status: "done", total: 2, attempted: 2, succeeded: 2, failed: 0, until: 1 };
      return this.json(200, p);
    }
    if (m[3] !== undefined && method === "PUT") {
      if (h.row.status !== "uploading") return this.error(409, "import_not_uploading");
      h.chunks.set(Number(m[3]), Buffer.from(body.data, "base64"));
      return this.json(200, {});
    }
    if (what === "finish") {
      if (h.row.status === "uploading") {
        const all = Buffer.concat([...h.chunks].sort((a, b) => a[0] - b[0]).map(([, b]) => b));
        if (all.length !== h.row.size || createHash("sha256").update(all).digest("hex") !== h.row.fingerprint) return this.error(400, "invalid_request");
        h.row.status = "processing";
      }
      return this.json(200, this.rowOf(h, false));
    }
    if (what === "cancel") {
      if (h.row.status === "uploading") {
        h.row = { ...h.row, status: "failed", reason: "cancelled" };
        h.chunks.clear();
      } else if (h.row.status !== "failed") return this.error(409, "import_not_uploading");
      return this.json(200, this.rowOf(h, false));
    }
    return this.error(404, "not_found");
  }

  /** poll moves a processing import on: published at its third poll. */
  poll(h: Held): void {
    if (h.row.status !== "processing") return;
    if (++h.polls >= 3) h.row = { ...h.row, status: "published", result: { imported: { podcasts: 2, episodes: 5, queue: 0, favorites: 0, history: 0, inbox: 0 }, skipped: [], ambiguous: [], merged: [] } };
  }

  count(prefix: string): number {
    return this.log.filter((l) => l.startsWith(prefix)).length;
  }
}

let server = new FakeServer();
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => server.fetch(input, init)) as typeof fetch;
job.hooks.sleep = () => new Promise((r) => setImmediate(r));

/** states records every state the job showed. */
let states: string[] = [];
job.subscribe(() => states.push(job.snapshot().state.k));

function fresh(): FakeServer {
  job.detach();
  server = new FakeServer();
  states = [];
  return server;
}

async function until(what: string, ok: (s: JobState) => boolean, ms = 20_000): Promise<JobState> {
  const end = Date.now() + ms;
  for (;;) {
    const s = job.snapshot().state;
    if (ok(s)) return s;
    if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify({ ...s, im: undefined })} (${server.log.join(", ")})`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

const published = (s: JobState) => s.k === "published" && !!(s.im as ImportRow).result;

function fileOf(size: number, seed = 1): { data: Buffer; file: File } {
  const data = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4096) data[i] = (i / 4096 + seed) % 251;
  return { data, file: new File([data], "AntennaPodBackup.db") };
}

/** truncated is a success whose JSON body ends part-way. */
const truncated = (status: number) => new Response('{"import_id":"i1","sta', { status, headers: { "Content-Type": "application/json" } });

/** broken is a success whose body stream fails part-way, as a dropped connection does. */
const broken = (status: number) =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"import_id":'));
        c.error(new TypeError("network connection lost"));
      },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );

test("the real request helper: a cut-off 200 or 201 is Unreadable for the import's requests (strict), {} for the others as before", async () => {
  fresh();
  for (const status of [200, 201]) {
    for (const make of [truncated, broken]) {
      server.overrides.push(() => make(status));
      await assert.rejects(requestStrict("POST", "/v1/import", {}), Unreadable, `${status} ${make.name}`);
      server.overrides.push(() => make(status));
      assert.deepEqual(await request("POST", "/v1/import", {}), {});
    }
  }
});

test("a reservation whose 201 was cut off is asked again and adopted: one import, never a failure", async () => {
  fresh();
  server.overrides.push((req, _init, effect) => (req === "POST /v1/import" ? (effect(), truncated(201)) : undefined));
  job.choose(fileOf(7 * MiB).file, "android_db");
  await until("published", published);
  assert.equal(server.imports.length, 1);
  assert.equal(server.log.filter((l) => l === "POST /v1/import").length, 2);
  assert.equal(server.count("PUT "), 3);
  assert.ok(!states.includes("failed"), states.join());
});

test("a finish whose 200 broke off is asked again and its state adopted; a cut-off progress answer is asked again", async () => {
  fresh();
  server.overrides.push((req, _init, effect) => (req.endsWith("/finish") ? (effect(), broken(200)) : undefined));
  server.overrides.push((req, _init, effect) => (req.endsWith("/progress") && server.imports[0]?.row.status === "processing" ? (effect(), truncated(200)) : undefined));
  job.choose(fileOf(4 * MiB).file, "android_db");
  await until("published", published);
  assert.equal(server.count("POST /v1/import/i1/finish"), 2);
  assert.ok(!states.includes("failed"), states.join());
});

test("an interrupted upload continues with the same file: only its missing chunks are sent", async () => {
  const s = fresh();
  const { data, file } = fileOf(7 * MiB);
  s.hold(data, "AntennaPodBackup.db", [[0, 0, 3 * MiB]]);
  job.attach();
  await until("interrupted", (st) => st.k === "interrupted");
  job.choose(file, "android_db");
  await until("published", published);
  assert.deepEqual(s.log.filter((l) => l.startsWith("PUT ")), ["PUT /v1/import/i1/chunks/1", "PUT /v1/import/i1/chunks/2"]);
});

test("a wrong file sends nothing and leaves the upload as it was: another size at once, other bytes after reading", async () => {
  const s = fresh();
  const { data } = fileOf(4 * MiB);
  s.hold(data, "AntennaPodBackup.db", [[0, 0, 3 * MiB]]);
  job.attach();
  await until("interrupted", (st) => st.k === "interrupted");
  const before = s.log.length;
  job.choose(fileOf(4 * MiB + 1).file, "android_db");
  assert.deepEqual(job.snapshot().notice, { n: "wrong_file", expected: "AntennaPodBackup.db" });
  job.choose(fileOf(4 * MiB, 7).file, "android_db");
  await until("refused after reading", (st) => st.k === "interrupted" && job.snapshot().notice?.n === "wrong_file");
  assert.equal(s.log.length, before);
  assert.equal(s.imports[0]!.row.status, "uploading");
  assert.equal(s.imports[0]!.chunks.size, 1);
});

test("a cancel whose answer was lost is asked again; one refused because the upload finished adopts that state; neither reserves again", async () => {
  let s = fresh();
  const { data } = fileOf(4 * MiB);
  s.hold(data, "AntennaPodBackup.db", [[0, 0, 3 * MiB]]);
  job.attach();
  await until("interrupted", (st) => st.k === "interrupted");
  s.overrides.push((req, _init, effect) => (req.endsWith("/cancel") ? (effect(), new Response("", { status: 503 })) : undefined));
  job.cancel();
  await until("cancelled", (st) => st.k === "idle" && job.snapshot().notice?.n === "cancelled");
  assert.equal(s.count("POST /v1/import/i1/cancel"), 2);
  assert.equal(s.log.filter((l) => l === "POST /v1/import").length, 0);
  // Finish won in another tab: the cancel is refused, the import's state read and followed.
  s = fresh();
  const h = s.hold(data, "AntennaPodBackup.db", [[0, 0, 3 * MiB], [1, 3 * MiB, 4 * MiB]]);
  job.attach();
  await until("interrupted", (st) => st.k === "interrupted");
  s.overrides.push((req) => {
    if (!req.endsWith("/cancel")) return undefined;
    h.row = { ...h.row, status: "processing" };
    return s.error(409, "import_not_uploading");
  });
  job.cancel();
  await until("published", published);
  assert.ok(s.log.includes("GET /v1/import/i1"));
  assert.equal(s.log.filter((l) => l === "POST /v1/import").length, 0);
});

test("an answer arriving after another sign-in is dropped: the job stops, nothing more is sent", async () => {
  const s = fresh();
  useAccount("account-a");
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  s.overrides.push(async (req, _init, effect) => {
    if (req !== "POST /v1/import") return undefined;
    const r = effect();
    await held;
    return r;
  });
  job.choose(fileOf(4 * MiB).file, "android_db");
  await until("reserving", (st) => st.k === "reserving");
  await new Promise((r) => setTimeout(r, 20));
  endGeneration(); // another tab signed out and in
  release();
  await until("detached", (st) => st.k === "idle");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.count("PUT "), 0);
  assert.equal(s.count("GET /v1/import/i1"), 0);
  useAccount(undefined);
});

test("an old server (no progress route, no cancel): every chunk is sent again, and processing is followed on the import", async () => {
  const s = fresh();
  s.legacy = true;
  const { data, file } = fileOf(7 * MiB);
  s.hold(data, "AntennaPodBackup.db", [[0, 0, 3 * MiB]]);
  job.attach();
  const st = await until("interrupted", (x) => x.k === "interrupted" && x.legacy);
  assert.equal(st.k, "interrupted");
  job.choose(file, "android_db");
  await until("published", published);
  assert.deepEqual(s.log.filter((l) => l.startsWith("PUT ")), ["PUT /v1/import/i1/chunks/0", "PUT /v1/import/i1/chunks/1", "PUT /v1/import/i1/chunks/2"]);
  assert.ok(s.count("GET /v1/import/i1") >= 3, s.log.join());
});

test("an upload begun with other chunks is not continued; Start again cancels it and uploads the file as a new import", async () => {
  const s = fresh();
  const { data, file } = fileOf(7 * MiB);
  s.hold(data, "AntennaPodBackup.db", [[0, 0, 4 * MiB]]);
  job.attach();
  await until("interrupted", (x) => x.k === "interrupted");
  job.choose(file, "android_db");
  await until("mismatch", (x) => x.k === "mismatch" && x.why === "layout");
  assert.equal(s.count("PUT "), 0);
  assert.ok(job.canRestart());
  job.cancel(true);
  await until("published", published);
  assert.equal(s.imports.length, 2);
  assert.equal(s.imports[0]!.row.reason, "cancelled");
  assert.deepEqual(s.log.filter((l) => l.startsWith("PUT ")), ["PUT /v1/import/i2/chunks/0", "PUT /v1/import/i2/chunks/1", "PUT /v1/import/i2/chunks/2"]);
});

test("a damaged chunk (every chunk there, the file not matching) offers starting again after one check, never another finish", async () => {
  const s = fresh();
  const { data, file } = fileOf(4 * MiB);
  const damaged = Buffer.from(data);
  damaged[5] = damaged[5]! ^ 0xff;
  s.hold(data, "AntennaPodBackup.db");
  s.imports[0]!.chunks.set(0, damaged.subarray(0, 3 * MiB));
  s.imports[0]!.chunks.set(1, damaged.subarray(3 * MiB));
  job.attach();
  await until("interrupted", (x) => x.k === "interrupted");
  job.choose(file, "android_db");
  await until("damaged", (x) => x.k === "mismatch" && x.why === "damaged");
  assert.equal(s.count("POST /v1/import/i1/finish"), 1);
  assert.equal(s.count("PUT "), 0);
});

test("a job waiting to ask again stops when another sign-in happens meanwhile: nothing is sent under the new sign-in", async () => {
  const s = fresh();
  useAccount("account-a");
  const sleep = job.hooks.sleep;
  let wake!: () => void;
  const paused = new Promise<void>((r) => (wake = r));
  let waiting = false;
  job.hooks.sleep = (ms, signal) => (ms > 0 ? ((waiting = true), paused) : sleep(ms, signal));
  try {
    s.overrides.push((req) => (req.includes("/chunks/0") ? new Response("", { status: 503 }) : undefined));
    job.choose(fileOf(4 * MiB).file, "android_db");
    await until("waiting", () => waiting && job.snapshot().waiting);
    const sent = s.count("PUT ");
    endGeneration(); // another tab signed out and in
    wake();
    await until("detached", (st) => st.k === "idle");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(s.count("PUT "), sent);
  } finally {
    job.hooks.sleep = sleep;
    useAccount(undefined);
  }
});

test("Start again, its replacement reservation held and then lost: the same file stays reserving, rows disabled and leaving guarded, until it is sent", async (t) => {
  const s = fresh();
  const { data, file } = fileOf(7 * MiB);
  s.hold(data, "AntennaPodBackup.db", [[0, 0, 4 * MiB]]);
  job.attach();
  await until("interrupted", (x) => x.k === "interrupted");
  job.choose(file, "android_db");
  await until("mismatch", (x) => x.k === "mismatch");
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let reserves = 0;
  s.overrides.push(async (req) => {
    if (req !== "POST /v1/import") return undefined;
    reserves++;
    await held;
    return new Response("", { status: 503 }); // the answer is lost; the server reserved nothing
  });
  // The pause before asking again is held too, to see the state while it waits.
  const sleep = job.hooks.sleep;
  let wake!: () => void;
  const paused = new Promise<void>((r) => (wake = r));
  job.hooks.sleep = (ms, signal) => (ms > 0 ? paused : sleep(ms, signal));
  t.after(() => {
    job.hooks.sleep = sleep;
  });
  job.cancel(true);
  await until("cancel confirmed, reserving", () => reserves === 1);
  const during = job.snapshot().state;
  assert.equal(s.imports[0]!.row.reason, "cancelled");
  assert.deepEqual([during.k, busy(during), guarded(during)], ["reserving", true, true]);
  assert.deepEqual((during as JobState & { k: "reserving" }).file, { name: "AntennaPodBackup.db", size: data.length, kind: "android_db" });
  release();
  await until("waiting to ask again", (x) => x.k === "reserving" && job.snapshot().waiting);
  const waiting = job.snapshot().state;
  assert.deepEqual([busy(waiting), guarded(waiting)], [true, true]);
  wake();
  await until("published", published);
  assert.equal(s.imports.length, 2);
  assert.deepEqual(s.log.filter((l) => l.startsWith("PUT ")), ["PUT /v1/import/i2/chunks/0", "PUT /v1/import/i2/chunks/1", "PUT /v1/import/i2/chunks/2"]);
});
