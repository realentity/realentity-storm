import { expect, test } from "@playwright/test";

// M40-T2: the gallery: examples with what they need, installed as an App with its pipelines; twice, two of them
test("the examples gallery: the starter first, an example installed twice under names of its own", async ({ page }) => {
  await page.goto("/apps");
  const cards = page.getByTestId("example-card");
  await expect(cards.first()).toHaveAttribute("data-example", "releases-to-read");
  await expect(cards.first().getByTestId("example-needs")).toContainText("Nothing: it works as it is.");
  const tables = page.locator('[data-testid="example-card"][data-example="tables"]');
  await expect(tables.getByTestId("example-needs")).toContainText("A database credential named app-db");

  // Its map, before installing.
  await tables.getByTestId("example-map").click();
  await expect(tables.getByTestId("app-map")).toContainText("Table growth");

  const before = ((await (await page.request.get("/api/apps")).json()) as { name: string }[]).map((a) => a.name);
  const expected = before.includes("Tables") ? /^Tables \d+$/ : /^Tables$/;
  const installed = async () => {
    await page.waitForURL(/\/apps\/[0-9a-f-]{36}$/);
    return ((await (await page.request.get(`/api${new URL(page.url()).pathname}`)).json()) as { name: string }).name;
  };
  await tables.getByTestId("example-install").click();
  expect(await installed()).toMatch(expected);

  // Installed: the card says so and opens it; installing again is a copy.
  await page.goto("/apps");
  const again = page.locator('[data-testid="example-card"][data-example="tables"]');
  await expect(again.getByTestId("example-installed")).toBeVisible();
  await expect(again.getByTestId("example-open")).toContainText("Open Tables");
  await expect(again.getByTestId("example-install")).toHaveText("Install a copy");
  await again.getByTestId("example-install").click();
  expect(await installed()).toMatch(/^Tables \d+$/);
  const pipelines = ((await (await page.request.get("/api/pipelines")).json()) as { name: string }[]).map((p) => p.name);
  expect(pipelines.filter((n) => n.startsWith("Table growth")).length).toBeGreaterThanOrEqual(2);
});

// M40-E1: the starter installed from the gallery, its pipeline run, its entities on its page, its checklist done
test("the starter: installed, tried, switched on and run; its releases on its page, its checklist gone", async ({ page }) => {
  await page.goto("/apps");
  await page.locator('[data-testid="example-card"][data-example="releases-to-read"]').getByTestId("example-install").click();
  await page.waitForURL(/\/apps\/[0-9a-f-]{36}$/);
  const appUrl = page.url();
  const appId = new URL(appUrl).pathname.split("/").pop()!;

  // Needs nothing: what is left is its pipeline, tried and switched on.
  const checklist = page.getByTestId("example-checklist");
  await expect(checklist.getByTestId("checklist-item")).toHaveCount(2);
  await expect(checklist).toContainText("2 of 2 left");

  // Tried: a dry run, which saves nothing.
  await checklist.getByTestId("checklist-item").first().getByRole("link", { name: "Do it" }).click();
  await page.waitForURL(/\/pipelines\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "Dry run" }).click();
  await expect(page.getByText("DONE").first()).toBeVisible({ timeout: 20_000 });
  await page.goto(appUrl);
  await expect(checklist).toContainText("1 of 2 left");

  // Switched on.
  await checklist.getByTestId("checklist-item").last().getByRole("link", { name: "Do it" }).click();
  await page.getByTestId("enable-pipeline").click();
  await page.getByTestId("confirm-enable").click();
  await expect(page.getByTestId("enable-pipeline")).toBeChecked();
  await page.goto(appUrl);
  await expect(page.getByTestId("example-checklist")).toHaveCount(0);

  // Run from its list's button: its releases there, new, to mark read.
  await page.goto(`/a/${appId}/Release`);
  await expect(page.getByTestId("entity-row")).toHaveCount(0);
  await page.getByRole("button", { name: "Check now" }).click();
  await page.waitForURL(/\/runs\//);
  await expect(page.getByText("DONE").first()).toBeVisible({ timeout: 20_000 });
  await page.goto(`/a/${appId}/Release`);
  await expect(page.getByTestId("entity-row")).toHaveCount(2);
  await expect(page.getByTestId("entity-row").first()).toContainText("new");
  await page.getByTestId("entity-row").first().getByRole("button", { name: "read" }).click();
  await expect(page.getByTestId("entity-row").first()).toContainText("read");
});
