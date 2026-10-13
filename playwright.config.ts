import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // The journeys need a real server; they run with playwright.journeys.config.ts,
  // and the web actor's test with playwright.acceptance.config.ts.
  testIgnore: [/journeys\.spec\.ts$/, /acceptance\//],
  forbidOnly: true,
  reporter: [["list"]],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
