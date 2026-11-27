import { exampleYaml } from "@realentity/storm-shared/example-files";
import { expect, test } from "@playwright/test";
import { unique, openAppPage } from "./support";

// M33-E1 (Prices; M71: its shops a type of mine): a product of mine added on its list, a shop for it on the Shops
// list (its product picked, its page and variant typed); its offers' list a tab of the App
test("the Prices App: a watched product, a shop for it, and the Prices list", async ({ page }) => {
  const name = unique("Prices");
  const tag = name.split(" ")[1];
  const source = exampleYaml("apps/prices.yaml")
    .replace("name: Prices", `name: ${name}`)
    .replace("menu: { label: Prices, icon: tag }", `menu: { label: "Prices ${tag}", icon: tag }`)
    .replace("menu: { label: Watched products, icon: tag }", `menu: { label: "Watched ${tag}", icon: tag }`)
    .replace("menu: { label: Shops, icon: tag }", `menu: { label: "Shops ${tag}", icon: tag }`);
  const created = await page.request.post("/api/apps", { data: { source } });
  expect(created.status(), await created.text()).toBe(201);

  await openAppPage(page, `Watched ${tag}`);
  await page.getByTestId("add-entity").click();
  const form = page.getByTestId("add-form");
  await form.getByLabel("Name").fill("Jacket");
  await form.getByLabel("Target").fill("300");
  await form.getByLabel("Currency").fill("EUR");
  await form.getByLabel("Watched").selectOption("true");
  await form.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("heading", { name: "Jacket" })).toBeVisible();
  await expect(page.getByTestId("entity-fields")).toContainText("300.00 EUR");

  await page.getByTestId("app-tab").filter({ hasText: `Shops ${tag}` }).click();
  await page.getByTestId("add-entity").click();
  const shop = page.getByTestId("add-form");
  await shop.getByLabel("Name").fill("Jacket at one, M");
  await shop.getByTestId("ref-product").selectOption("Jacket");
  await shop.getByLabel("Page").fill("https://one.example.org/jacket");
  await shop.getByLabel("Variant").fill("size: M, color: Black");
  await shop.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("heading", { name: "Jacket at one, M" })).toBeVisible();
  const fields = page.getByTestId("entity-fields");
  await expect(fields).toContainText("one.example.org/jacket");
  await expect(fields).toContainText("size: M, color: Black");

  // Edited on its form: another page.
  await page.getByTestId("entity-form").getByLabel("Page").fill("https://two.example.org/p/7");
  await page.getByTestId("entity-form").getByRole("button", { name: "Save" }).click();
  await expect(fields).not.toContainText("one.example.org");

  // The App's other page: its tab.
  await page.getByTestId("app-tab").filter({ hasText: `Prices ${tag}` }).click();
  await expect(page.getByTestId("app-tab").filter({ hasText: `Prices ${tag}` })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("No prices")).toBeVisible();
});
