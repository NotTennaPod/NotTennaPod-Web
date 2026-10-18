// Layout and keyboard view tests (PROTOCOL §12): every screen at narrow,
// medium and wide widths, left-to-right and right-to-left, in Chromium,
// Firefox and WebKit, against a real server with the emulator library.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  testMatch: /layout\.spec\.ts$/,
  globalSetup: "./e2e/support/build.ts",
  timeout: 0, // no time limit on a test; each wait has its own
  fullyParallel: false,
  workers: 3,
  reporter: [["list"]],
  outputDir: ".work/layout-results",
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
