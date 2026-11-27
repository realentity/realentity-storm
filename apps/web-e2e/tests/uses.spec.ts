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
  const billsId = await create(bill(bills));
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

  // The App it came from deleted: to choose again, from another App, a type of another name among them.
  await page.getByTestId("use-source-Bill").selectOption({ label: `${bills} › Bill` });
  await expect(page.getByTestId("uses-missing")).toHaveCount(0);
  expect((await page.request.delete(`/api/apps/${billsId}`)).status()).toBe(204);
  const household = unique("Household");
  await create(bill(household).replace("  Bill:", "  Payment:"));
  await page.reload();
  await expect(page.getByTestId("uses-missing")).toHaveText("1 to choose");
  await page.getByTestId("use-source-Bill").selectOption({ label: `${household} › Payment` });
  await expect(page.getByTestId("uses-missing")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("use-source-Bill").locator("option:checked")).toHaveText(`${household} › Payment`);

  // An optional use, not chosen: said so, and nothing waits for it.
  const optional = await create(`name: ${unique("Expenses")}
types:
  Expense:
    key: id
    fields: { id: { type: text } }
uses:
  Bill:
    from: { app: ${unique("No such Bills")}, type: Bill }
    fields: [issuer]
    optional: true
`);
  await page.goto(`/apps/${optional}`);
  await expect(page.getByTestId("use-optional-Bill")).toHaveText("optional");
  await expect(page.getByTestId("use-source-Bill").locator("option:checked")).toHaveText("None: it works without it");
  await expect(page.getByTestId("uses-missing")).toHaveCount(0);
});

// M66-E1 (the pages' half): a ref to another App's type picks among the chosen App's entities, and is named by them
test("a ref to another App's type: picked among the chosen App's bills on a form, shown by its title", async ({ page }) => {
  const bills = unique("Bills");
  const post = async (url: string, data: unknown) => {
    const created = await page.request.post(url, { data });
    expect(created.status(), await created.text()).toBe(201);
    return (await created.json()) as { appId: string };
  };
  const { appId: billsId } = await post("/api/apps", {
    source: `name: ${bills}
types:
  Bill:
    mine: true
    key: billKey
    title: issuer
    fields:
      billKey: { type: text }
      issuer: { type: text }
      account: { type: text }
`,
  });
  await post(`/api/apps/${billsId}/pages/Bill`, { values: { billKey: "power-11", issuer: "Power Co", account: "BG00 1111" } });
  await post(`/api/apps/${billsId}/pages/Bill`, { values: { billKey: "water-11", issuer: "Water Co", account: "BG00 2222" } });
  const { appId } = await post("/api/apps", {
    source: `name: ${unique("Expenses")}
types:
  Expense:
    mine: true
    key: id
    fields:
      id: { type: text }
      bill: { type: ref, to: Bill }
uses:
  Bill:
    from: { app: ${bills}, type: Bill }
    fields: [billKey, issuer]
`,
  });

  await page.goto(`/a/${appId}/Expense`);
  await page.getByTestId("add-entity").click();
  const form = page.getByTestId("add-form");
  await expect(form.getByTestId("ref-bill").locator("option")).toHaveText(["Choose one…", "Power Co", "Water Co"]);
  await form.getByLabel("Id").fill("e1");
  await form.getByTestId("ref-bill").selectOption({ label: "Water Co" });
  await form.getByRole("button", { name: "Add" }).click();
  await expect(page.getByTestId("entity-fields")).toContainText("Water Co");
  await expect(page.getByTestId("entity-fields")).not.toContainText("BG00");

  await page.goto(`/a/${appId}/Expense`);
  await expect(page.getByTestId("entity-row")).toContainText("Water Co");

  // In the designer, a ref points at its own types or at a use.
  await page.goto(`/apps/${appId}/edit`);
  const ref = page.getByTestId("types-tab").getByTestId("field-ref");
  await expect(ref.locator("option")).toHaveText(["points at…", "a Expense", "a Bill (from another App)"]);
  await expect(ref.locator("option:checked")).toHaveText("a Bill (from another App)");
});
