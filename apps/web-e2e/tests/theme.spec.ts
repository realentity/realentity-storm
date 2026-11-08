import { expect, test, type Page } from "@playwright/test";

const theme = (page: Page) => page.locator("html").getAttribute("data-bs-theme");

// The theme switch: system → light → dark, kept across reloads, applied before the page draws.
test("switches the theme and keeps the choice", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/history");
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  expect(await theme(page)).toBe("light");

  const toggle = page.getByTestId("theme-switch");
  await toggle.click(); // system → light
  expect(await theme(page)).toBe("light");
  await toggle.click(); // light → dark
  await expect(page.locator("html")).toHaveAttribute("data-bs-theme", "dark");

  await page.reload();
  expect(await theme(page)).toBe("dark");

  await toggle.click(); // dark → system, which is light here; dark again when the system turns dark
  await expect(page.locator("html")).toHaveAttribute("data-bs-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-bs-theme", "dark");
});
