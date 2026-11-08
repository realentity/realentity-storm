import { expect, test } from "@playwright/test";
import { createPipeline, startRun, unique } from "./support";

// M27: a pipeline's page in the menu, its rows, the user's marks, a row's button
test("a pipeline's page lists what it keeps, keeps the user's marks and starts a pipeline from a row", async ({ page }) => {
  const tag = unique("e2e");
  const collection = tag.replace(/\W+/g, "-").toLowerCase();
  const label = `Disks ${tag.split(" ")[1]}`;
  const replies = unique("Disk replies");
  await createPipeline(
    page,
    `name: ${replies}
trigger: { on: view.action, collection: ${collection} }
steps:
  - id: reply
    type: test.send
    with: { to: "me@example.org", body: "About {{trigger.item.name}}" }
`,
  );
  const watch = await createPipeline(
    page,
    `name: ${unique("Disk watch")}
steps:
  - id: save
    type: data.save
    with:
      collection: ${collection}
      key: id
      items:
        - { id: a, name: "WD Purple 8TB", price: 399, currency: BGN, url: "https://shop.example.org/a" }
        - { id: b, name: "Seagate SkyHawk 8TB", price: 419.5, currency: BGN, url: "javascript:alert(1)" }
view:
  menu: { label: "${label}", icon: cpu }
  collection: ${collection}
  columns: [name, { field: price, as: money, currency: currency }, { field: url, as: link }]
  link: url
  sort: -price
  marks: [{ id: done, label: Done, hides: true }]
  actions:
    - { label: Ask, run: "${replies}", row: true }
`,
  );
  await startRun(page, watch.pipelineId);

  await page.goto("/inbox");
  await page.getByTestId("view-menu-item").filter({ hasText: label }).click();
  await expect(page.getByRole("heading", { name: label })).toBeVisible();
  const rows = page.getByTestId("view-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Seagate SkyHawk 8TB");
  await expect(rows.nth(0)).toContainText("419.50 BGN");
  // A javascript: address stays text: no link, no open button.
  await expect(rows.nth(0)).toContainText("javascript:alert(1)");
  await expect(rows.nth(0).locator('a[href^="javascript"]')).toHaveCount(0);
  await expect(rows.nth(1).locator('a[href="https://shop.example.org/a"]').first()).toHaveAttribute("rel", "noopener noreferrer");

  await rows.nth(0).getByTestId("mark-done").click();
  await expect(rows).toHaveCount(1);
  await page.getByRole("tab", { name: /Done/ }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("Seagate SkyHawk 8TB");
  await page.getByRole("tab", { name: /Current/ }).click();

  await rows.nth(0).getByRole("link", { name: "WD Purple 8TB" }).click();
  await expect(page.getByRole("heading", { name: "WD Purple 8TB" })).toBeVisible();
  await expect(page.getByText("First seen")).toBeVisible();

  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page).toHaveURL(/\/runs\//);
  await expect(page.getByText(replies).first()).toBeVisible();
});
