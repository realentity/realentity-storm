import { createPrismaConnection } from "@ai-me/db";
import { expect, test } from "@playwright/test";
import { createPipeline, startRun, unique } from "./support";

// M29-E1: a pipeline's page with a chart of every key above the list
test("a page's chart: a line per key with a legend, values on hover, the list below", async ({ page }) => {
  const tag = unique("e2e").split(" ")[1].toLowerCase();
  const label = `Tables ${tag}`;
  const watch = await createPipeline(
    page,
    `name: ${unique("Table counts")}
steps:
  - id: latest
    type: data.save
    with:
      collection: tables-${tag}
      key: name
      items: [{ name: orders, rows: 18234 }, { name: users, rows: 4120 }, { name: sessions, rows: 9650 }]
  - id: trend
    type: data.history
    with: { items: "{{latest.added}}", collection: rows-${tag}, key: name, value: rows }
view:
  menu: { label: "${label}", icon: chart }
  collection: tables-${tag}
  columns: [name, { field: rows, as: number }]
  sort: -rows
  chart: { history: rows-${tag}, label: Rows }
`,
  );
  await startRun(page, watch.pipelineId);
  // A week of hourly counts, as data.history would have kept them: orders grow fast one evening.
  const db = createPrismaConnection();
  try {
    const { userId } = await db.client.pipeline.findUniqueOrThrow({ where: { pipelineId: watch.pipelineId } });
    await db.client.dataPoint.deleteMany({ where: { collection: `rows-${tag}` } });
    const start = Date.now() - 7 * 86_400_000;
    const data = [];
    for (let hour = 0; hour <= 7 * 24; hour += 3) {
      const at = new Date(start + hour * 3_600_000);
      const surge = hour > 120 ? (hour - 120) * 40 : 0;
      data.push({ userId, collection: `rows-${tag}`, key: "orders", value: 12_000 + hour * 25 + surge, at });
      data.push({ userId, collection: `rows-${tag}`, key: "sessions", value: 9_000 + Math.round(400 * Math.sin(hour / 4)), at });
      data.push({ userId, collection: `rows-${tag}`, key: "users", value: 3_900 + hour, at });
    }
    await db.client.dataPoint.createMany({ data });
  } finally {
    await db.close();
  }

  await page.goto("/inbox");
  await page.getByTestId("view-menu-item").filter({ hasText: label }).click();
  const chart = page.getByTestId("view-chart");
  await expect(chart.getByRole("heading", { name: "Rows" })).toBeVisible();
  await expect(chart.getByLabel("Legend")).toHaveText(/orders.*sessions.*users/);
  await expect(chart.locator("polyline")).toHaveCount(3);
  await expect(page.getByTestId("view-row")).toHaveCount(3);
  await page.screenshot({ path: "test-results/view-chart.png", fullPage: true });

  const svg = chart.locator("svg");
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2);
  await expect(chart.locator("[aria-live]")).toContainText(/orders [\d,]+ · sessions [\d,]+ · users [\d,]+/);
  await chart.screenshot({ path: "test-results/view-chart-hover.png" });
});
