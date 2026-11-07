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
  await page.getByTestId("start-empty").click();
  await page.getByTestId("tab-yaml").click();
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
  // M35-T1: the designer says so as I type, before Save.
  await page.getByTestId("edit-app").click();
  await page.getByTestId("tab-yaml").click();
  await page.getByTestId("app-source").fill(app.replace("  Disk:", "  Drive:"));
  await expect(page.getByTestId("broken-pipelines")).toContainText(pipeline.name);
  await page.getByTestId("save-app").click();
  await expect(page.getByRole("alert")).toContainText(`It would break "${pipeline.name}"`);
  await expect(page.getByRole("alert")).toContainText('has no type "Disk"');

  // A type from what the source really gives.
  await page.getByTestId("tab-types").click();
  await page.getByTestId("draft-from-run").click();
  await page.getByLabel("Pipeline to try").selectOption({ label: pipeline.name });
  await page.getByTestId("try-source").click();
  await page.getByTestId("draft-type").getByRole("button", { name: "save" }).click({ timeout: 20_000 });
  const draftRow = (field: string) => page.getByTestId("draft-row").filter({ has: page.locator(`input[value="${field}"]`) });
  await expect(page.getByTestId("draft-key")).toHaveValue("id");
  await expect(draftRow("url").getByTestId("draft-kind")).toContainText("url");
  // "399" and 419.5 next to a currency: money, its currency the code.
  await expect(draftRow("price").getByTestId("draft-kind")).toContainText("money · always · in currency");
  await page.getByLabel("Type name").fill("Offer");
  await page.getByTestId("add-type").click();
  await expect(page.getByTestId("type-name").last()).toHaveValue("Offer");
  await page.getByTestId("tab-yaml").click();
  await expect(page.getByTestId("app-source")).toHaveValue(/\n {2}Offer:\n {4}key: id\n/);
  await page
    .getByTestId("app-source")
    .fill(app.replace("wanted: { type: yesno, mine: true }", "wanted: { type: yesno, mine: true }\n      url: { type: url }"));
  await page.getByTestId("save-app").click();
  await expect(page.getByText("Disk.url added (url)")).toBeVisible();
});

// M35-T1: the designer: an App from a template, shown as types, stages and pages; a problem on its tab and at its line
test("the designer shows an App by its tabs and a problem where it is", async ({ page }) => {
  await page.goto("/apps/new");
  await page.getByTestId("start-template").filter({ hasText: "Bills" }).click();
  await expect(page.getByTestId("type-name")).toHaveValue("Bill");
  await expect(page.locator(`[data-testid="field-name"][value="amount"]`)).toBeVisible();
  await expect(page.getByTestId("app-check")).toContainText("No problems");

  await page.getByTestId("tab-stages").click();
  await expect(page.getByTestId("stages-tab")).toContainText("due");
  await expect(page.getByTestId("stages-tab")).toContainText("paid");
  await page.getByTestId("tab-pages").click();
  await expect(page.getByTestId("pages-tab")).toContainText("list");

  // A money field whose currency is no field: on the Types tab, and at its line in the YAML.
  await page.getByTestId("tab-yaml").click();
  const source = await page.getByTestId("app-source").inputValue();
  await page.getByTestId("app-source").fill(source.replace(/currency: currency/, "currency: nowhere"));
  await expect(page.getByTestId("app-check")).toContainText("1 problem");
  await expect(page.getByTestId("tab-types")).toContainText("1");
  await expect(page.getByTestId("yaml-issues")).toContainText(/line \d+/);
  await page.getByTestId("tab-types").click();
  await expect(page.getByTestId("types-tab")).toContainText('"nowhere" is not a text field of this type');
  await page
    .getByTestId("types-tab")
    .getByRole("button", { name: /^line / })
    .click();
  await expect(page.getByTestId("app-source")).toBeFocused();
});
