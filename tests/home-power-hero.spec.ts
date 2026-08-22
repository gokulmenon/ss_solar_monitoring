import { expect, test } from "@playwright/test";

test("home shows the isometric live power hero without horizontal overflow", async ({ page }) => {
  await page.goto("/home");

  const hero = page.getByRole("region", { name: "Live home energy flow" });
  await expect(hero).toBeVisible();
  await expect(page.getByTestId("hero-solar-power")).toContainText("kW");
  await expect(page.getByTestId("grid-flow-badge")).toContainText(/Exporting|Importing|Balanced/);
  await expect(page.getByTestId("loads-flow-badge")).toContainText("Loads");
  await expect(page.getByTestId("today-production-card")).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));

  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});
