// The tests' server follows the real server's rules where the sync tests
// depend on them (NotTennaPod-Server internal/api: authn, signOut;
// internal/storage: FinishSupersession).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeServer } from "./fakeServer.ts";

const ask = async (s: FakeServer, path: string, body: Record<string, unknown> = {}) => (await s.answer(path, body, () => ({}))).status;

test("the first use of a successor's credential revokes every predecessor up the chain of unfinished handoffs", async () => {
  const s = new FakeServer("account", "a", "nonce");
  const a = s.jar!;
  assert.equal(await ask(s, "/v1/installations/successor", { install_id: "b", instance_nonce: "nonce" }), 200);
  const b = s.jar!;
  // b hands off to c before b's credential is used for anything else.
  assert.equal(await ask(s, "/v1/installations/successor", { install_id: "c", instance_nonce: "nonce" }), 200);
  assert.equal(await ask(s, "/v1/session"), 200, "c's first use");
  assert.equal(s.credentials.get(b)!.revoked, true, "b's credential");
  assert.equal(s.credentials.get(a)!.revoked, true, "a's credential, two links up");
});

test("a superseded installation's session may sign out: its credential is deleted and the cookie cleared", async () => {
  const s = new FakeServer("account", "a", "nonce");
  const a = s.jar!;
  assert.equal(await ask(s, "/v1/installations/successor", { install_id: "b", instance_nonce: "nonce" }), 200);
  s.jar = a; // the browser still holds the predecessor's cookie (a late answer gave it back)
  assert.equal(await ask(s, "/v1/push"), 409, "other requests are refused as superseded");
  assert.equal(await ask(s, "/v1/auth/web/sign-out"), 200);
  assert.equal(s.credentials.get(a)!.revoked, true);
  assert.equal(s.jar, null);
});
