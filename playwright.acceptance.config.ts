// The web actor's own test (PROTOCOL §16): the actor runs as a child
// process against a real NotTennaPod-Server, with its own Chromium; the test
// needs no browser of its own.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e/acceptance",
  testMatch: /actor\.spec\.ts$/,
  globalSetup: "./e2e/support/build.ts",
  timeout: 300_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  reporter: [["list"]],
  outputDir: ".work/acceptance-results",
  projects: [{ name: "actor" }],
});
