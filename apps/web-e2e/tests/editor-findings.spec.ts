import { type AppDetailView } from "@ai-me/shared";
import { expect, test, type Page } from "@playwright/test";
import { createPipeline, startRun, unique } from "./support";

// Found on the server (2026-11-08): what the editors and pages lacked

const card = (page: Page, id: string) => page.locator(`[data-testid="step-card"][data-step="${id}"]`);

async function addStep(page: Page, type: string) {
  await page.getByTestId("add-step").click();
  await page.getByTestId("step-search").fill(type);
  await page.locator(`[data-testid="pick-step"][data-type="${type}"]`).click();
}

async function createApp(page: Page, name: string): Promise<AppDetailView> {
  const source = `name: ${name}\ntypes:\n  Post:\n    key: url\n    title: title\n    fields:\n      url: { type: text, required: true }\n      title: { type: text }\npages:\n  - list: Post\n`;
  const response = await page.request.post("/api/apps", { data: { source } });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as AppDetailView;
}

test("on cards: a new pipeline has no made-up description, its address shown up front, a site allowed from the card", async ({ page }) => {
  const app = await createApp(page, unique("Posts"));
  await page.goto("/pipelines/new");
  await page.getByTestId("pipeline-app").selectOption(app.name);
  await addStep(page, "http.fetch");
  // Its address is shown without More, and a data step's type in an App.
  const url = card(page, "fetch").getByTestId("input-url");
  await expect(url).toBeVisible();
  await url.fill("https://feeds.test/news.rss");
  await url.blur();
  await addStep(page, "data.save");
  await expect(card(page, "save").getByTestId("input-type")).toBeVisible();

  // The site isn't allowed: allowed from the card, no YAML.
  const allow = card(page, "fetch").getByTestId("allow-site");
  await expect(allow).toHaveText("Allow feeds.test", { timeout: 10_000 });
  await allow.click();
  await expect(page.getByTestId("allowed-site")).toHaveText(["feeds.test"]);
  await expect(card(page, "fetch").getByTestId("card-issue")).toHaveCount(0, { timeout: 10_000 });

  await page.getByTestId("pipeline-tab-yaml").click();
  const source = await page.getByTestId("pipeline-source").inputValue();
  expect(source).not.toContain("description:");
  expect(source).toContain("policy:\n  allowedDomains: [feeds.test]\nsteps:");
});

test("an address kept as text is a short link; an App and a pipeline deleted, the App only once its pipelines are gone", async ({
  page,
}) => {
  const app = await createApp(page, unique("Posts"));
  const saver = await createPipeline(
    page,
    `name: ${unique("Posts in")}\napp: ${app.name}\nsteps:\n  - id: save\n    type: data.save\n    with:\n      type: Post\n      items:\n        - { url: "https://www.postgresql.org/about/news/a-very-long-address-of-a-news-item-3430/", title: Autobase }\n`,
  );
  await startRun(page, saver.pipelineId);
  await page.goto(`/a/${app.appId}/Post`);
  const link = page
    .getByTestId("entity-row")
    .first()
    .getByRole("link", { name: /^www\.postgresql\.org\/about\/news\// });
  await expect(link).toHaveAttribute("href", "https://www.postgresql.org/about/news/a-very-long-address-of-a-news-item-3430/", {
    timeout: 20_000,
  });

  // The App can't go while its pipeline belongs to it: the dialog says so.
  await page.goto(`/apps/${app.appId}`);
  await page.getByTestId("delete-app").click();
  await expect(page.getByRole("dialog")).toContainText("belong to it: delete them, or move them to another App, first");
  await page.getByTestId("confirm-delete").click();
  await expect(page.getByRole("dialog")).toContainText(`belongs to "${app.name}": delete or move it first`);
  await page.getByRole("button", { name: "Keep it" }).click();

  // The pipeline, then the App.
  await page.goto(`/pipelines/${saver.pipelineId}`);
  await page.getByTestId("delete-pipeline").click();
  await expect(page.getByRole("dialog")).toContainText("every run of it go with it");
  await page.getByTestId("confirm-delete").click();
  await page.waitForURL(/\/pipelines$/);
  expect((await page.request.get(`/api/pipelines/${saver.pipelineId}`)).status()).toBe(404);

  await page.goto(`/apps/${app.appId}`);
  await page.getByTestId("delete-app").click();
  await expect(page.getByRole("dialog")).toContainText("Its versions and the 1 entities it keeps go with it.");
  await page.getByTestId("confirm-delete").click();
  await page.waitForURL(/\/apps$/);
  expect((await page.request.get(`/api/apps/${app.appId}`)).status()).toBe(404);
});
