import { expect, test } from "@playwright/test";
import { createPipeline, startRun, unique } from "./support";

// M31-E1, S1: an App's list in the menu, filtered and grouped with totals, an entity's page; values only as text
test("an App's list is in the menu, filters and groups its entities, and opens an entity's page", async ({ page }) => {
  const name = unique("Bills");
  const label = `Bills ${name.split(" ")[1]}`;
  const created = await page.request.post("/api/apps", {
    data: {
      source: `name: ${name}
icon: receipt
types:
  Bill:
    key: id
    title: payee
    fields:
      id: { type: text, required: true }
      payee: { type: text, required: true }
      amount: { type: money, currency: currency }
      currency: { type: text }
      due: { type: date }
      status: { type: enum, values: [due, paid] }
      link: { type: text }
      site: { type: url }
pages:
  - list: Bill
    menu: { label: "${label}" }
    columns: [payee, amount, due, status, link]
    sort: due
    group: { by: status, totals: [amount] }
  - view: Bill
    sections:
      - { title: Payment, fields: [amount, due, status] }
      - { title: From, fields: [payee, link, site] }
`,
    },
  });
  expect(created.status(), await created.text()).toBe(201);

  const pipeline = await createPipeline(
    page,
    `name: ${unique("Bill reader")}
app: ${name}
steps:
  - id: save
    type: data.save
    with:
      type: Bill
      items:
        - { id: e1, payee: Electricity, amount: 120.5, currency: BGN, due: "2026-11-10", status: due, link: "javascript:alert(1)", site: "https://power.example.org/bill" }
        - { id: w1, payee: Water, amount: 30, currency: BGN, due: "2026-11-20", status: paid }
        - { id: g1, payee: Gas, amount: 45, currency: BGN, due: "2026-11-05", status: due }
`,
  );
  await startRun(page, pipeline.pipelineId);

  await page.goto("/inbox");
  await page.getByTestId("app-menu-item").filter({ hasText: label }).click();
  await expect(page.getByRole("heading", { name: label })).toBeVisible();
  const rows = page.getByTestId("entity-row");
  await expect(rows).toHaveCount(3, { timeout: 20_000 });
  const groups = page.getByTestId("entity-group");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toContainText("due");
  await expect(groups.nth(0)).toContainText("165.50 BGN");
  await expect(rows.nth(0)).toContainText("Gas");
  await expect(rows.nth(1)).toContainText("120.50 BGN");
  // S1: a javascript: address is text, never a link.
  await expect(rows.nth(1)).toContainText("javascript:alert(1)");
  await expect(page.locator('a[href^="javascript"]')).toHaveCount(0);

  await page.getByTestId("filter-status").selectOption("paid");
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("Water");
  await page.getByTestId("filter-status").selectOption("");
  await page.getByLabel("Search").fill("elec");
  await page.getByLabel("Search").press("Enter");
  await expect(rows).toHaveCount(1);

  await rows.nth(0).getByRole("link", { name: "Electricity" }).click();
  await expect(page.getByRole("heading", { name: "Electricity" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Payment" })).toBeVisible();
  await expect(page.getByTestId("entity-fields").nth(1)).toContainText("javascript:alert(1)");
  await expect(page.getByTestId("entity-link")).toHaveAttribute("href", "https://power.example.org/bill");
  await expect(page.getByTestId("entity-link")).toHaveAttribute("rel", "noopener noreferrer");
});
