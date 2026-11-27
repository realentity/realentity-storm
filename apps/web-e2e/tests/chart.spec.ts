import { exampleYaml } from "@realentity/storm-shared/example-files";
import { createPrismaConnection } from "@realentity/storm-db";
import { expect, test } from "@playwright/test";
import { unique, openAppPage } from "./support";

// M29-E1 (on an App since M71): a list's chart of every key's trend above the list
test("a list's chart: a line per key with a legend, values on hover, the list below", async ({ page }) => {
  const name = unique("Tables");
  const tag = name.split(" ")[1];
  const source = exampleYaml("apps/tables.yaml")
    .replace("name: Tables", `name: ${name}`)
    .replace("menu: { label: Tables, icon: chart }", `menu: { label: "Tables ${tag}", icon: chart }`)
    .replaceAll("table-rows", `rows-${tag.toLowerCase()}`);
  const created = await page.request.post("/api/apps", { data: { source } });
  expect(created.status(), await created.text()).toBe(201);
  const { appId } = (await created.json()) as { appId: string };

  // Three tables, and a week of hourly counts, as the App's pipeline and data.history would have kept them.
  const db = createPrismaConnection();
  try {
    const { userId } = await db.client.app.findUniqueOrThrow({ where: { appId } });
    const tables = { orders: 18_234, users: 4_120, sessions: 9_650 };
    await db.client.dataEntity.createMany({
      data: Object.entries(tables).map(([key, rows]) => ({ appId, type: "Table", key, value: { name: key, rows } })),
    });
    const start = Date.now() - 7 * 86_400_000;
    const data = [];
    for (let hour = 0; hour <= 7 * 24; hour += 3) {
      const at = new Date(start + hour * 3_600_000);
      const surge = hour > 120 ? (hour - 120) * 40 : 0;
      const collection = `rows-${tag.toLowerCase()}`;
      data.push({ userId, collection, key: "orders", value: 12_000 + hour * 25 + surge, at });
      data.push({ userId, collection, key: "sessions", value: 9_000 + Math.round(400 * Math.sin(hour / 4)), at });
      data.push({ userId, collection, key: "users", value: 3_900 + hour, at });
    }
    await db.client.dataPoint.createMany({ data });
  } finally {
    await db.close();
  }

  await openAppPage(page, `Tables ${tag}`);
  const chart = page.getByTestId("app-chart");
  await expect(chart.getByRole("heading", { name: "Rows" })).toBeVisible();
  await expect(chart.getByLabel("Legend")).toHaveText(/orders.*sessions.*users/);
  await expect(chart.locator("polyline")).toHaveCount(3);
  await expect(page.getByTestId("entity-row")).toHaveCount(3);
  await page.screenshot({ path: "test-results/app-chart.png", fullPage: true });

  const svg = chart.locator("svg");
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2);
  await expect(chart.locator("[aria-live]")).toContainText(/orders [\d,]+ · sessions [\d,]+ · users [\d,]+/);
  await chart.screenshot({ path: "test-results/app-chart-hover.png" });
});
