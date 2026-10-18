// The player journeys, the player's races and its MediaSource feed: the built app against a
// real NotTennaPod-Server, with media from the fixture publisher, in
// Chromium, Firefox and WebKit.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  testMatch: /(player(-races|-start|-chapters)?|feed)\.spec\.ts$/,
  globalSetup: "./e2e/support/build.ts",
  timeout: 0, // no time limit on a test; each wait has its own
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  reporter: [["list"]],
  use: { trace: "retain-on-failure", ignoreHTTPSErrors: true },
  outputDir: ".work/player-results",
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
