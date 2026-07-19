import { expect, test } from "@playwright/test";

test("the app loads at /live, shows the tab bar, and navigates to history", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/live\/?$/);
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Live" })).toBeVisible();

  await page.getByRole("link", { name: "History" }).click();

  await expect(page).toHaveURL(/\/history\/?$/);
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
});
