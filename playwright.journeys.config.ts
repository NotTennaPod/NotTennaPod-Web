// The journeys: the built app against a real NotTennaPod-Server, in
// Chromium, Firefox and WebKit.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  testMatch: /(journeys|selection|recovery|recovery-key|import|refresh|heads|sessions)\.spec\.ts$/,
  globalSetup: "./e2e/support/build.ts",
  timeout: 0, // no time limit on a test; each wait has its own
  fullyParallel: false,
  workers: 3,
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
  outputDir: ".work/journeys-results",
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
