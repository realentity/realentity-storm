import { expect, test } from "@playwright/test";
import { unique } from "./support";

// An App's report page: in the menu, its tiles with a share, a table by a field, the period picked
test("an App's report: tiles, a share and a table, opened from the menu", async ({ page }) => {
  const name = unique("Spending");
  const tag = name.split(" ")[1];
  const source = `
name: ${name}
types:
  Expense:
    mine: true
    key: title
    fields:
      title: { type: text, required: true }
      amount: { type: number }
      kind: { type: enum, values: [food, travel] }
pages:
  - report: Expense
    menu: { label: "Spent ${tag}" }
    tiles:
      - { label: Expenses, count: true }
      - { label: Spent, sum: amount }
      - { label: Travel, count: true, when: { kind: travel }, of: Expenses }
    tables:
      - { by: kind, columns: [Expenses, Spent] }
`;
  const created = await page.request.post("/api/apps", { data: { source } });
  expect(created.status(), await created.text()).toBe(201);
  const { appId } = (await created.json()) as { appId: string };
  for (const values of [
    { title: "Lunch", amount: 12.5, kind: "food" },
    { title: "Dinner", amount: 30, kind: "food" },
    { title: "Train", amount: 45, kind: "travel" },
  ]) {
    const added = await page.request.post(`/api/apps/${appId}/pages/Expense`, { data: { values } });
    expect(added.status(), await added.text()).toBe(201);
  }

  await page.goto("/inbox");
  await page
    .getByTestId("app-menu-item")
    .filter({ hasText: `Spent ${tag}` })
    .click();
  await expect(page.getByRole("heading", { name: `Spent ${tag}` })).toBeVisible();
  await expect(page.getByRole("button", { name: "30 days" })).toHaveAttribute("aria-pressed", "true");

  const tiles = page.getByTestId("report-tile");
  await expect(tiles).toHaveCount(3);
  await expect(tiles.nth(0)).toContainText("3");
  await expect(tiles.nth(1)).toContainText("87.5");
  await expect(tiles.nth(2)).toContainText("33% of Expenses");

  const rows = page.getByTestId("report-table").locator("tbody tr");
  await expect(rows).toHaveText([/food\s*2\s*42\.5/, /travel\s*1\s*45/]);

  await page.getByRole("button", { name: "All time" }).click();
  await expect(page.getByRole("button", { name: "All time" })).toHaveAttribute("aria-pressed", "true");
  await expect(tiles.nth(0)).toContainText("3");
});
