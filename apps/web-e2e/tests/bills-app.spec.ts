import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPipeline, startRun, unique } from "./support";

// M33-E1 (Bills): what the Bills page did, on the Bills App's list: months with their totals and what is unpaid,
// a badge on what is due soon, Mark paid on the row
test("the Bills App's list: months, totals, unpaid, due badges and paid on the row", async ({ page }) => {
  const name = unique("Bills");
  const label = `Bills ${name.split(" ")[1]}`;
  const source = readFileSync(join(__dirname, "../../../pipelines/apps/bills.yaml"), "utf8")
    .replace("name: Bills", `name: ${name}`)
    .replace("menu: { label: Bills, icon: receipt }", `menu: { label: "${label}", icon: receipt }`);
  const created = await page.request.post("/api/apps", { data: { source } });
  expect(created.status(), await created.text()).toBe(201);

  // Local dates, as the page counts days.
  const day = (offset: number) => {
    const d = new Date(Date.now() + offset * 86_400_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const month = day(0).slice(0, 7);
  const bill = (key: string, issuer: string, amount: number, dueDate: string) =>
    `{ billKey: "${key}", issuer: ${issuer}, issuerKey: ${issuer.toLowerCase()}.test, amount: ${amount}, currency: BGN, dueDate: "${dueDate}", month: "${month}-01", from: "billing@x.test", subject: Bill, messageId: "<${key}>" }`;
  const reader = await createPipeline(
    page,
    `name: ${unique("Bill reader")}
app: ${name}
steps:
  - id: save
    type: data.save
    with:
      type: Bill
      items:
        - ${bill("a", "EVN", 84.2, day(-1))}
        - ${bill("b", "Water", 21.5, day(2))}
        - ${bill("c", "Rent", 900, day(20))}
`,
  );
  await startRun(page, reader.pipelineId);

  await page.goto("/inbox");
  await page.getByTestId("app-menu-item").filter({ hasText: label }).click();
  const rows = page.getByTestId("entity-row");
  await expect(rows).toHaveCount(3, { timeout: 20_000 });
  const totals = page.getByTestId("group-total");
  await expect(totals.nth(0)).toHaveText("Amount: 1005.70 BGN");
  await expect(totals.nth(1)).toHaveText("Unpaid: 1005.70 BGN");
  await expect(rows.nth(0).getByTestId("due-badge")).toHaveText("overdue");
  await expect(rows.nth(1).getByTestId("due-badge")).toHaveText("in 2 d");
  await expect(rows.nth(2).getByTestId("due-badge")).toHaveCount(0);

  await rows.nth(0).getByTestId("row-move").filter({ hasText: "paid" }).click();
  await expect(totals.nth(1)).toHaveText("Unpaid: 921.50 BGN");
  await expect(rows.nth(0).getByTestId("due-badge")).toHaveCount(0);
  await expect(rows.nth(0).getByTestId("row-move")).toHaveText("due");
});
