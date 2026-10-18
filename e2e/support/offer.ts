// After setup, the app offers once to save the recovery key (PROTOCOL §11.1).
// Journeys about something else answer it with "Not now".
import { expect, type Page } from "@playwright/test";

export async function notNow(page: Page): Promise<void> {
  const offer = page.getByRole("dialog", { name: "Save recovery key" });
  await offer.getByRole("button", { name: "Not now" }).click();
  await expect(offer).toHaveCount(0);
}
