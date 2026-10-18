// Save recovery key: the passphrase floor the server applies, the file's name,
// and the offer once after setup, noted before setup is asked for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { offerState, passphraseProblem, recoveryKeyFileName, setOffer, settleOffer } from "../src/ui/recoveryKey.ts";

test("the passphrase floor counts characters, never trims, and keeps the password out", () => {
  const ok = "correct horse battery staple";
  assert.equal(passphraseProblem(ok, ok, "a password"), undefined);
  assert.equal(passphraseProblem("eleven char", "eleven char", "pw"), "short");
  // 11 characters of three bytes each are still 11 characters; 12 are enough.
  assert.equal(passphraseProblem("€".repeat(11), "€".repeat(11), "pw"), "short");
  assert.equal(passphraseProblem("€".repeat(12), "€".repeat(12), "pw"), undefined);
  // An emoji is one character, as the server counts code points.
  assert.equal(passphraseProblem("🎧".repeat(12), "🎧".repeat(12), "pw"), undefined);
  assert.equal(passphraseProblem("🎧".repeat(11), "🎧".repeat(11), "pw"), "short");
  assert.equal(passphraseProblem("x".repeat(1025), "x".repeat(1025), "pw"), "long");
  assert.equal(passphraseProblem(" ".repeat(12), " ".repeat(12), "pw"), "blank");
  assert.equal(passphraseProblem("　".repeat(12), "　".repeat(12), "pw"), "blank");
  assert.equal(passphraseProblem("the same password", "the same password", "the same password"), "password");
  assert.equal(passphraseProblem(ok, ok + " ", "pw"), "mismatch");
  // Spaces around it are part of it.
  assert.equal(passphraseProblem("  spaced passphrase  ", "  spaced passphrase  ", "pw"), undefined);
});

test("the file is named for the day the key was made, in UTC", () => {
  assert.equal(recoveryKeyFileName(Date.UTC(2026, 9, 14, 23, 59, 59)), "nottennapod-recovery-key-20261014.json");
  assert.equal(recoveryKeyFileName(Date.UTC(2026, 0, 2, 0, 0, 0)), "nottennapod-recovery-key-20260102.json");
});

test("the offer is made after a setup in this browser, to an administrator, while no key is saved", async () => {
  const win = new Window();
  Object.assign(globalThis, { localStorage: win.localStorage });
  try {
    assert.equal(offerState(), null);
    assert.equal(settleOffer(true, 0), false, "an ordinary login, no setup here");
    setOffer("pending");
    assert.equal(settleOffer(false, 0), false, "not to a non-administrator");
    assert.equal(offerState(), "pending", "kept for the administrator");
    assert.equal(settleOffer(true, 0), true);
    assert.equal(offerState(), "pending", "a reload before it is answered offers again");
    setOffer("done");
    assert.equal(settleOffer(true, 0), false, "Not now ends it");
    setOffer("pending");
    assert.equal(settleOffer(true, 1_760_000_000_000), false, "a key saved meanwhile ends it");
    assert.equal(offerState(), "done");
    setOffer(null);
    assert.equal(offerState(), null);
  } finally {
    Reflect.deleteProperty(globalThis, "localStorage");
    await win.happyDOM.close();
  }
});

test("setup notes the offer before asking, keeps it when the answer is lost, and takes it back when refused", async () => {
  const win = new Window({ url: "http://nottennapod.test/" });
  const realFetch = globalThis.fetch;
  const channel = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel");
  Object.assign(globalThis, { localStorage: win.localStorage });
  // The tabs' sign-in channel would keep the test running; no other tab listens here.
  Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined, configurable: true, writable: true });
  const { setUp } = await import("../src/app/boot.ts");
  const answers: (() => Promise<Response>)[] = [];
  let pendingWhenAsked: string | null = null;
  globalThis.fetch = (async () => {
    pendingWhenAsked = offerState();
    return answers.shift()!();
  }) as typeof fetch;
  try {
    // The answer never arrives (the connection dropped, or the tab closed): the offer stays.
    answers.push(() => Promise.reject(new TypeError("network")));
    await assert.rejects(setUp("owner", "a long password", "CODE"));
    assert.equal(pendingWhenAsked, "pending", "noted before the request");
    assert.equal(offerState(), "pending");
    // A refusal (a wrong code) takes it back to what it was.
    setOffer(null);
    answers.push(async () => new Response('{"error":"forbidden","message":"The setup code is incorrect."}', { status: 403 }));
    await assert.rejects(setUp("owner", "a long password", "WRONG"));
    assert.equal(offerState(), null);
    // A setup the server confirms keeps it for after logging in.
    answers.push(async () => new Response('{"account":{"account_id":"a"}}', { status: 201 }));
    await setUp("owner", "a long password", "CODE");
    assert.equal(offerState(), "pending");
  } finally {
    globalThis.fetch = realFetch;
    Reflect.deleteProperty(globalThis, "localStorage");
    if (channel) Object.defineProperty(globalThis, "BroadcastChannel", channel);
    await win.happyDOM.close();
  }
});
