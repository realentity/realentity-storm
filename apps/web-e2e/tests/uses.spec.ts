import { expect, test } from "@playwright/test";
import { unique } from "./support";

// M66-E1 (the choosing half): an App's use of another App's type, filled by the App it names, changed on its page
test("an App's use of another App's type: filled by the App it names, another chosen or cleared on its page", async ({ page }) => {
  const bills = unique("Bills");
  const home = unique("Home bills");
  const bill = (name: string) => `name: ${name}
types:
  Bill:
    key: billKey
    fields:
      billKey: { type: text }
      issuer: { type: text }
      amount: { type: money }
`;
  const create = async (source: string) => {
    const created = await page.request.post("/api/apps", { data: { source } });
    expect(created.status(), await created.text()).toBe(201);
    return ((await created.json()) as { appId: string }).appId;
  };
  await create(bill(bills));
  await create(bill(home));
  const report = await create(`name: ${unique("Report")}
types:
  Expense:
    key: id
    fields: { id: { type: text } }
uses:
  Bill:
    from: { app: ${bills}, type: Bill }
    fields: [issuer, amount]
    help: Your bills, for the monthly expense report
`);

  await page.goto(`/apps/${report}`);
  const card = page.getByTestId("uses-card");
  await expect(card.getByTestId("use-Bill")).toContainText(`as ${bills} › Bill: issuer, amount`);
  await expect(card.getByTestId("use-Bill")).toContainText("Your bills, for the monthly expense report");
  const source = card.getByTestId("use-source-Bill");
  // Filled by the App it names, at install.
  await expect(source.locator("option:checked")).toHaveText(`${bills} › Bill`);
  await expect(card.getByTestId("uses-missing")).toHaveCount(0);

  await source.selectOption({ label: `${home} › Bill` });
  await expect(page.getByText("Chosen")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("use-source-Bill").locator("option:checked")).toHaveText(`${home} › Bill`);

  await page.getByTestId("use-source-Bill").selectOption({ value: "" });
  await expect(page.getByTestId("uses-missing")).toHaveText("1 to choose");
});
