import { expect, test } from "@playwright/test";

test("the app loads at /live, shows the tab bar, and navigates to history", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/home\/?$/);
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Home" })).toBeVisible();

  await page.getByRole("link", { name: "History" }).click();

  await expect(page).toHaveURL(/\/history\/?$/);
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
});

test("the EV tab renders charging status and history", async ({ page }) => {
  await page.goto("/ev");

  await expect(
    page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "EV" }),
  ).toBeVisible();
  await expect(page.getByText("Charging at 7.75 kW", { exact: true })).toBeVisible();
  await expect(page.getByText("Handle", { exact: true })).toBeVisible();
  await expect(page.getByText("Charging history", { exact: true })).toBeVisible();
  await expect(page.getByText("Daily EV charging", { exact: true })).toBeVisible();
});
