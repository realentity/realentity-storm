import { expect, test } from "@playwright/test";
import { createPipeline, startRun, unique } from "./support";

// M30: an App, its type's entities, a version that would break its pipeline, a type drafted from a dry run
test("an App keeps its entities, refuses a version that breaks its pipeline, and drafts a type from a source", async ({ page }) => {
  const name = unique("Disks");
  const app = `name: ${name}
icon: cpu
types:
  Disk:
    key: id                # one per shop's product id
    title: name
    fields:
      id: { type: text, required: true }
      name: { type: text, required: true }
      price: { type: money, currency: currency }
      currency: { type: text }
      wanted: { type: yesno, mine: true }
`;
  await page.goto("/apps/new");
  await page.getByTestId("app-source").fill(app);
  await page.getByTestId("save-app").click();
  await expect(page.getByRole("heading", { name })).toBeVisible();

  const pipeline = await createPipeline(
    page,
    `name: ${unique("Disk prices")}
app: ${name}
steps:
  - id: save
    type: data.save
    with:
      type: Disk
      items:
        - { id: a, name: "WD Purple 8TB", price: "399", currency: BGN, url: "https://shop.example.org/a" }
        - { id: b, name: "Seagate SkyHawk 8TB", price: 419.5, currency: BGN, url: "https://shop.example.org/b" }
`,
  );
  const run = await startRun(page, pipeline.pipelineId);
  await page.goto(`/runs/${run.runId}`);
  await expect(page.getByText("DONE").first()).toBeVisible({ timeout: 20_000 });

  await page.goto("/apps");
  await page.getByTestId("app-card").filter({ hasText: name }).click();
  const entities = page.getByTestId("entities");
  await expect(entities.locator("tbody tr")).toHaveCount(2);
  await expect(entities).toContainText("WD Purple 8TB");
  await expect(entities).toContainText("399");
  await expect(page.getByRole("link", { name: pipeline.name })).toBeVisible();
  // M34-T4: url is in the items, not in the type: suggested, as a url.
  await expect(page.getByTestId("app-drift")).toContainText("Disk.url");
  await expect(page.getByTestId("app-drift")).toContainText("url");
  await expect(page.getByTestId("describe-change")).toBeVisible();

  // Dropping a field the pipeline doesn't name is fine; renaming its type isn't.
  await page.getByTestId("edit-app").click();
  await page.getByTestId("app-source").fill(app.replace("  Disk:", "  Drive:"));
  await page.getByTestId("save-app").click();
  await expect(page.getByRole("alert")).toContainText(`It would break "${pipeline.name}"`);
  await expect(page.getByRole("alert")).toContainText('has no type "Disk"');

  // A type from what the source really gives.
  await page.getByLabel("Pipeline to try").selectOption({ label: pipeline.name });
  await page.getByTestId("try-source").click();
  await page.getByTestId("draft-type").getByRole("button", { name: "save" }).click({ timeout: 20_000 });
  await expect(page.getByTestId("draft-source")).toContainText("key: id");
  await expect(page.getByTestId("draft-source")).toContainText("type: url");
  // "399" and 419.5 next to a currency: money, its currency the code.
  await expect(page.getByTestId("draft-source")).toContainText(/type: money\s+required: true\s+currency: currency/);
  await page.getByLabel("Type name").fill("Offer");
  await page.getByTestId("add-type").click();
  await expect(page.getByTestId("app-source")).toHaveValue(/\n {2}Offer:\n {4}key: id\n/);
  await page
    .getByTestId("app-source")
    .fill(app.replace("wanted: { type: yesno, mine: true }", "wanted: { type: yesno, mine: true }\n      url: { type: url }"));
  await page.getByTestId("save-app").click();
  await expect(page.getByText("Disk.url added (url)")).toBeVisible();
});
