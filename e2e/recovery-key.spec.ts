// Save recovery key (PROTOCOL §11.1), each journey on a fresh server: the
// offer once after setup, kept when setup's answer is lost and through a
// reload before it appears; the form's messages; downloads the server sealed
// but the browser never got, and confirmations that never arrived, leave the
// warning; the downloaded file puts lost keys back with the command line's
// keys install and restores a backup; "Not now" ends the offer, and a later
// login or a non-administrator gets none.
import { expect, test, type Download, type Page } from "@playwright/test";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root } from "./support/build.ts";
import { startServer, type RunningServer } from "./support/server.ts";

test.use({ timezoneId: "UTC" });

const user = "owner";
const password = "correct horse battery";
// Spaces at both ends and characters of several bytes: the file opens with exactly these.
const passphrase = "  Grüße, a passphrase 🎧  ";
const offerKey = "nottennapod.recoveryKeyOffer";

const dialog = (page: Page) => page.getByRole("dialog", { name: "Save recovery key" });
const flag = (page: Page) => page.evaluate((k) => localStorage.getItem(k), offerKey);
const exportedAt = (page: Page) =>
  page.evaluate(async () => ((await (await fetch("/v1/admin/service")).json()) as { keys_exported_at: number }).keys_exported_at);

async function logIn(page: Page, username: string, pw: string): Promise<void> {
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(pw);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.locator("nav.drawer")).toBeVisible();
}

async function fillForm(page: Page, pw: string, phrase: string, again = phrase): Promise<void> {
  const d = dialog(page);
  await d.getByLabel("Your password").fill(pw);
  await d.getByLabel("Passphrase for the file").fill(phrase);
  await d.getByLabel("Passphrase again").fill(again);
}

/** scratchCopy copies a stopped server's data directory without its keys, as a machine that lost them. */
function scratchCopy(dataDir: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ntp-e2e-keys-"));
  for (const name of readdirSync(dataDir)) {
    if (["receipt.keys", "secrets.key", "server.lock"].includes(name) || !statSync(join(dataDir, name)).isFile()) continue;
    copyFileSync(join(dataDir, name), join(dir, name));
  }
  return dir;
}

test("set up, get the offer, save, confirm: the warning goes, and the file puts the keys back with the command line", async ({ page, browserName }) => {
  const server: RunningServer = await startServer();
  const scratch: string[] = [];
  try {
    await page.goto(server.base + "/");
    await page.getByLabel("Setup code").fill(server.setupCode);
    await page.getByLabel("Username").fill(user);
    await page.getByLabel("Password").fill(password);
    // The server sets up, but its answer never reaches the browser: the offer is kept.
    await page.route("**/v1/setup", async (r) => {
      await r.fetch();
      await r.abort("connectionreset");
    });
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await page.unroute("**/v1/setup");
    expect(await flag(page)).toBe("pending");
    // A reload before the offer appears (here: its check fails) keeps it too.
    await page.route("**/v1/admin/service", (r) => r.abort());
    const checked = page.waitForEvent("requestfailed", (r) => r.url().endsWith("/v1/admin/service"));
    await page.reload();
    const login = page.getByRole("heading", { name: "Log in to NotTennaPod" });
    await expect(login.or(page.locator("nav.drawer"))).toBeVisible();
    if (await login.isVisible()) await logIn(page, user, password);
    await checked;
    await expect(page.locator("nav.drawer")).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    expect(await flag(page)).toBe("pending");
    await page.unroute("**/v1/admin/service");
    await page.reload();
    const d = dialog(page);
    await expect(d).toBeVisible();
    await expect(d.getByText(/^Your server is ready\./)).toBeVisible();
    await expect(d.getByText(/its backups can only be put back with this file and its passphrase/)).toBeVisible();
    await expect(d.getByLabel("Your password")).toHaveAttribute("autocomplete", "current-password");
    await d.screenshot({ path: join(root, ".work", "recovery-key-shots", browserName, "offer.png") });

    // The form's messages: a short passphrase (said at once), then a wrong password (said by the server).
    await fillForm(page, password, "too short");
    await d.getByRole("button", { name: "Download", exact: true }).click();
    await expect(d.getByRole("alert")).toHaveText("The passphrase needs at least 12 characters.");
    await fillForm(page, "not the password", passphrase);
    await d.getByRole("button", { name: "Download", exact: true }).click();
    await expect(d.getByRole("alert")).toHaveText("The password is incorrect.");

    // The server seals, but its answer is lost: nothing downloads, and the warning stays.
    await d.getByLabel("Your password").fill(password);
    await page.route("**/v1/admin/keys", async (r) => {
      await r.fetch();
      await r.abort("connectionreset");
    });
    await d.getByRole("button", { name: "Download", exact: true }).click();
    await expect(d.getByRole("alert")).toHaveText("Cannot reach the server. Try again.");
    await page.unroute("**/v1/admin/keys");
    expect(await exportedAt(page)).toBe(0);

    // The download: the browser is asked to save the file; the warning stays until the person confirms.
    let downloaded = page.waitForEvent("download");
    await d.getByRole("button", { name: "Download", exact: true }).click();
    const first: Download = await downloaded;
    const name = first.suggestedFilename();
    expect(name).toMatch(/^nottennapod-recovery-key-\d{8}\.json$/);
    await expect(d.getByText(`Your browser has been asked to save ${name}.`, { exact: false })).toBeVisible();
    const bundle = readFileSync((await first.path())!, "utf8");
    expect(JSON.parse(bundle)).toMatchObject({ format: "nottennapod-keys", version: 1 });
    expect(bundle).not.toContain(passphrase.trim());
    expect(await exportedAt(page)).toBe(0);
    downloaded = page.waitForEvent("download");
    await d.getByRole("button", { name: "Download again" }).click();
    const again = await downloaded;
    expect(again.suggestedFilename()).toBe(name);
    expect(readFileSync((await again.path())!, "utf8")).toBe(bundle);
    await page.screenshot({ path: join(root, ".work", "recovery-key-shots", browserName, "requested.png") });

    // The confirmation is lost: the dialog says so and the warning stays; then it arrives.
    await page.route("**/v1/admin/keys/*/saved", (r) => r.abort());
    await d.getByRole("button", { name: "I have saved the file" }).click();
    await expect(d.getByRole("alert")).toHaveText("Cannot reach the server. Try again.");
    expect(await exportedAt(page)).toBe(0);
    await page.unroute("**/v1/admin/keys/*/saved");
    await d.getByRole("button", { name: "I have saved the file" }).click();
    await expect(d).toHaveCount(0);
    await expect(page.locator(".snackbar", { hasText: "Recovery key saved." })).toBeVisible();
    expect(await flag(page)).toBe("done");
    const saved = await exportedAt(page);
    expect(saved).toBeGreaterThan(0);
    expect(saved).toBe(JSON.parse(bundle).created_at);

    // Settings: saved, with Save again, and no warning.
    await page.goto(server.base + "/settings");
    const section = page.locator(".server-section");
    await expect(section.getByText(/^Recovery key saved /)).toBeVisible();
    await expect(section.getByRole("button", { name: "Save again" })).toBeVisible();
    await expect(section.getByText(/has no saved recovery key/)).toHaveCount(0);
    await section.screenshot({
      path: join(root, ".work", "recovery-key-shots", browserName, "settings-saved.png"),
      mask: [section.locator("p").filter({ hasText: /^(Data folder|Daily backups in)/ })],
    });

    // A backup to restore, taken while the server runs.
    const backup = await page.evaluate(async () => {
      const r = await fetch("/v1/admin/backup", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      return ((await r.json()) as { file: string }).file;
    });
    expect(backup).toBeTruthy();

    // The command line: the file puts lost keys back (keys install) and restores the backup.
    await server.halt();
    try {
      const work = mkdtempSync(join(tmpdir(), "ntp-e2e-file-"));
      scratch.push(work);
      const file = join(work, name);
      const passFile = join(work, "pass");
      const trimmed = join(work, "trimmed");
      writeFileSync(file, bundle, { mode: 0o600 });
      writeFileSync(passFile, passphrase + "\n", { mode: 0o600 });
      writeFileSync(trimmed, passphrase.trim() + "\n", { mode: 0o600 });
      const lost = scratchCopy(server.dataDir);
      scratch.push(lost);
      expect(() => server.cli(["keys", "install", "--data-dir", lost, "--keys", file, "--passphrase-file", trimmed])).toThrow(/passphrase/);
      expect(server.cli(["keys", "install", "--data-dir", lost, "--keys", file, "--passphrase-file", passFile])).toContain("The keys are back.");
      for (const k of ["receipt.keys", "secrets.key"]) expect(readFileSync(join(lost, k)).equals(readFileSync(join(server.dataDir, k))), k).toBe(true);
      const restoredParent = mkdtempSync(join(tmpdir(), "ntp-e2e-restored-"));
      scratch.push(restoredParent);
      const restored = join(restoredParent, "data");
      const out = server.cli(["restore", "--data-dir", restored, "--from", join(server.dataDir, "backups", backup), "--keys", file, "--passphrase-file", passFile]);
      expect(out).toContain("Restored the database from");
      for (const k of ["receipt.keys", "secrets.key"]) expect(readFileSync(join(restored, k)).equals(readFileSync(join(server.dataDir, k))), k).toBe(true);
    } finally {
      await server.resume();
    }

    // A later ordinary login gets no offer.
    await page.goto(server.base + "/settings");
    await page.getByRole("button", { name: "Logout" }).click();
    await expect(page.getByRole("heading", { name: "Log in to NotTennaPod" })).toBeVisible();
    await logIn(page, user, password);
    await page.goto(server.base + "/settings");
    await expect(page.locator(".server-section").getByText(/^Recovery key saved /)).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
  } finally {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
    await server.stop();
  }
});

test("Not now, then reload: the offer does not return, the warning stays; a non-administrator gets no offer", async ({ page, browser, browserName }) => {
  const server: RunningServer = await startServer();
  try {
    await page.goto(server.base + "/");
    await page.getByLabel("Setup code").fill(server.setupCode);
    await page.getByLabel("Username").fill(user);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    await d.getByRole("button", { name: "Not now" }).click();
    await expect(d).toHaveCount(0);
    expect(await flag(page)).toBe("done");
    let asked = 0;
    page.on("request", (r) => void (r.url().endsWith("/v1/admin/service") && asked++));
    await page.reload();
    await page.goto(server.base + "/settings");
    const section = page.locator(".server-section");
    await expect(section.getByText(/^This server has no saved recovery key\./)).toBeVisible();
    await expect(section.getByRole("button", { name: "Save recovery key" })).toBeVisible();
    expect(asked).toBe(1); // Settings' own report: the offer did not ask again
    await expect(dialog(page)).toHaveCount(0);
    await section.screenshot({
      path: join(root, ".work", "recovery-key-shots", browserName, "settings-not-saved.png"),
      mask: [section.locator("p").filter({ hasText: /^(Data folder|Daily backups in)/ })],
    });
    expect(await exportedAt(page)).toBe(0);

    // A member (not an administrator) in a browser holding a pending offer is never offered, and it stays.
    await page.evaluate(async () => {
      await fetch("/v1/admin/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "member", password: "member password", is_admin: false }),
      });
    });
    const other = await browser.newContext();
    try {
      const p = await other.newPage();
      let memberAsked = 0;
      p.on("request", (r) => void (r.url().includes("/v1/admin/") && memberAsked++));
      await p.goto(server.base + "/");
      await p.evaluate((k) => localStorage.setItem(k, "pending"), offerKey);
      await logIn(p, "member", "member password");
      await p.goto(server.base + "/settings");
      await expect(p.getByRole("heading", { name: "Devices" })).toBeVisible();
      await expect(p.locator(".server-section")).toHaveCount(0);
      await expect(dialog(p)).toHaveCount(0);
      expect(memberAsked).toBe(0);
      expect(await flag(p)).toBe("pending");
    } finally {
      await other.close();
    }
  } finally {
    await server.stop();
  }
});

/**
 * hold keeps the matching request until release, then sends it on to the server (as a slow
 * connection would deliver it late). The page may have given the request up meanwhile.
 */
async function hold(page: Page, pattern: string): Promise<{ release: () => Promise<void> }> {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let handled!: () => void;
  const done = new Promise<void>((r) => (handled = r));
  await page.route(pattern, async (route) => {
    await gate;
    try {
      await route.fulfill({ response: await route.fetch() });
    } catch {
      /* the page gave the request up */
    }
    handled();
  });
  return {
    release: async () => {
      open();
      await done;
      await page.unroute(pattern);
      // Wait until the page has the answer, or gave the request up, and has acted on it.
      await expect.poll(() => page.evaluate(() => (window as unknown as { keyRequests: number }).keyRequests)).toBe(0);
      await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
    },
  };
}

/**
 * watchPage counts, in the page, the files it asks the browser to save (each makes a Blob URL),
 * and its recovery key requests still unanswered (an answer counts once its body is read).
 */
async function watchPage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { downloadsAsked: number; keyRequests: number };
    w.downloadsAsked = 0;
    w.keyRequests = 0;
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (o: Blob | MediaSource) => {
      w.downloadsAsked++;
      return create(o);
    };
    const fetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = fetch(input, init);
      if (String(input instanceof Request ? input.url : input).includes("/v1/admin/keys")) {
        w.keyRequests++;
        void answer
          .then((r) => r.clone().text())
          .catch(() => "")
          .finally(() => w.keyRequests--);
      }
      return answer;
    };
  });
}

/** downloadsAsked counts the files the page asked the browser to save (each makes a Blob URL). */
const downloadsAsked = (page: Page) => page.evaluate(() => (window as unknown as { downloadsAsked: number }).downloadsAsked);

test("a held export or confirmation can always be closed: Not now, Escape and Cancel; nothing arrives late", async ({ page }) => {
  const server: RunningServer = await startServer();
  try {
    await watchPage(page);
    await page.goto(server.base + "/");
    await page.getByLabel("Setup code").fill(server.setupCode);
    await page.getByLabel("Username").fill(user);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    const snackbar = page.locator(".snackbar", { hasText: "Recovery key saved." });

    // The offer: the export is held; Not now still works, and the late answer starts no download.
    await fillForm(page, password, passphrase);
    let held = await hold(page, "**/v1/admin/keys");
    await d.getByRole("button", { name: "Download", exact: true }).click();
    await expect(d).toHaveAttribute("aria-busy", "true");
    await expect(d.getByRole("button", { name: "Not now" })).toBeEnabled();
    await d.getByRole("button", { name: "Not now" }).click();
    await expect(d).toHaveCount(0);
    expect(await flag(page)).toBe("done");
    await held.release();
    expect(await downloadsAsked(page)).toBe(0);
    expect(await d.count()).toBe(0);
    expect(await exportedAt(page)).toBe(0);

    // Settings: the export held, closed with Escape, then with Cancel. Focus goes back to the
    // button, what was typed is gone, the late answer starts no download, and nothing is recorded.
    await page.goto(server.base + "/settings");
    const section = page.locator(".server-section");
    // Save recovery key, or Save again once a late confirmation has been recorded.
    const open = section.getByRole("button", { name: /^(Save recovery key|Save again)$/ });
    await expect(open).toBeVisible();
    const start = async () => {
      await open.focus();
      await page.keyboard.press("Enter");
      await expect(d).toBeVisible();
      await expect(d.getByLabel("Your password")).toHaveValue("");
      await expect(d.getByLabel("Passphrase for the file")).toHaveValue("");
      await fillForm(page, password, passphrase);
    };
    const closeWith = async (close: "Escape" | "Cancel") => {
      if (close === "Escape") return page.keyboard.press("Escape");
      const cancel = d.getByRole("button", { name: "Cancel" });
      await expect(cancel).toBeEnabled();
      await cancel.click();
    };
    for (const close of ["Escape", "Cancel"] as const) {
      await start();
      held = await hold(page, "**/v1/admin/keys");
      await d.getByRole("button", { name: "Download", exact: true }).click();
      await expect(d).toHaveAttribute("aria-busy", "true");
      await closeWith(close);
      await expect(d, `${close} while the export is held`).toHaveCount(0);
      await expect(open).toBeFocused();
      await held.release();
      expect(await downloadsAsked(page), `a download after ${close}`).toBe(0);
      expect(await d.count()).toBe(0);
      expect(await exportedAt(page)).toBe(0);
    }

    // The confirmation held, closed with Escape, then with Cancel: no notification when its answer
    // comes late; the section says what the server reports at its next reading.
    for (const close of ["Escape", "Cancel"] as const) {
      await start();
      const before = await downloadsAsked(page);
      await d.getByRole("button", { name: "Download", exact: true }).click();
      await expect(d.getByRole("button", { name: "I have saved the file" })).toBeVisible();
      expect(await downloadsAsked(page)).toBe(before + 1);
      held = await hold(page, "**/v1/admin/keys/*/saved");
      await d.getByRole("button", { name: "I have saved the file" }).click();
      await expect(d).toHaveAttribute("aria-busy", "true");
      await closeWith(close);
      await expect(d, `${close} while the confirmation is held`).toHaveCount(0);
      await expect(open).toBeFocused();
      await held.release();
      expect(await snackbar.count(), `a notification after ${close}`).toBe(0);
      expect(await d.count()).toBe(0);
      expect(await downloadsAsked(page)).toBe(before + 1);
      const saved = await exportedAt(page);
      await page.reload();
      await expect(saved ? section.getByText(/^Recovery key saved /) : section.getByText(/^This server has no saved recovery key\./)).toBeVisible();
    }
  } finally {
    await server.stop();
  }
});
