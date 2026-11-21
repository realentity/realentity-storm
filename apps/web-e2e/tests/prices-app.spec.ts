import { exampleYaml } from "@realentity/storm-shared/example-files";
import { expect, test } from "@playwright/test";
import { unique, openAppPage } from "./support";

// M33-E1 (Prices): a product of mine added on its list, its shops a line each; its offers' list a tab of the App
test("the Prices App: a watched product added with its shops, and the Prices list", async ({ page }) => {
  const name = unique("Prices");
  const tag = name.split(" ")[1];
  const source = exampleYaml("apps/prices.yaml")
    .replace("name: Prices", `name: ${name}`)
    .replace("menu: { label: Prices, icon: tag }", `menu: { label: "Prices ${tag}", icon: tag }`)
    .replace("menu: { label: Watched products, icon: tag }", `menu: { label: "Watched ${tag}", icon: tag }`);
  const created = await page.request.post("/api/apps", { data: { source } });
  expect(created.status(), await created.text()).toBe(201);

  await openAppPage(page, `Watched ${tag}`);
  await page.getByTestId("add-entity").click();
  const form = page.getByTestId("add-form");
  await form.getByLabel("Name").fill("Jacket");
  await form.getByLabel("Target").fill("300");
  await form.getByLabel("Currency").fill("EUR");
  await form.getByLabel("Watched").selectOption("true");
  await form.getByLabel("Shops").fill("https://one.example.org/jacket | size: M, color: Black\nhttps://two.example.org/p/7");
  await form.getByRole("button", { name: "Add" }).click();

  await expect(page.getByRole("heading", { name: "Jacket" })).toBeVisible();
  const fields = page.getByTestId("entity-fields");
  await expect(fields).toContainText("300.00 EUR");
  await expect(fields).toContainText("https://one.example.org/jacket | size: M, color: Black, https://two.example.org/p/7");

  // Edited on its form: a shop line less.
  await page.getByTestId("entity-form").getByLabel("Shops").fill("https://two.example.org/p/7");
  await page.getByTestId("entity-form").getByRole("button", { name: "Save" }).click();
  await expect(fields).not.toContainText("one.example.org");

  // The App's other page: its tab.
  await page.getByTestId("app-tab").filter({ hasText: `Prices ${tag}` }).click();
  await expect(page.getByTestId("app-tab").filter({ hasText: `Prices ${tag}` })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("No prices")).toBeVisible();
});
