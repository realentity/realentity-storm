import { expect, test } from "@playwright/test";
import { createPipeline, startRun, unique } from "./support";

// M9-T6: postings a pipeline saved, best first; the decision is kept
test("the Jobs page lists saved postings best first and keeps the status set by hand", async ({ page }) => {
  const tag = unique("e2e");
  const url = (n: number) => `https://jobs.example.org/${tag.replace(/\W+/g, "-")}/${n}`;
  const pipeline = await createPipeline(
    page,
    `name: ${unique("Save jobs")}
steps:
  - id: save
    type: data.save
    with:
      items:
        - { url: "${url(1)}", title: "Mid .NET Engineer ${tag}", company: Beta, score: 64, scoreReason: "Mid-level" }
        - { url: "${url(2)}", title: "Senior .NET Developer ${tag}", company: Acme, location: Sofia, score: 91, scoreReason: "Senior .NET in Sofia" }
`,
  );
  await startRun(page, pipeline.pipelineId);

  await page.goto("/jobs");
  await page.getByLabel("Search").fill(tag);
  await page.getByRole("button", { name: "Search" }).click();
  const rows = page.getByTestId("jobs").locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText(`Senior .NET Developer ${tag}`);
  await expect(rows.nth(0)).toContainText("Acme · Sofia");
  await expect(rows.nth(0)).toContainText("Senior .NET in Sofia");
  await expect(rows.nth(1)).toContainText("64");
  await expect(rows.nth(0).getByRole("link")).toHaveAttribute("rel", "noopener noreferrer");

  await page.getByLabel(`Status of Senior .NET Developer ${tag}`).selectOption("SHORTLISTED");
  await expect(rows.nth(0)).toContainText("shortlisted");
  await page.getByLabel("Status", { exact: true }).selectOption("SHORTLISTED");
  await expect(rows).toHaveCount(1);
  await page.reload();
  await page.getByLabel("Search").fill(tag);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByLabel(`Status of Senior .NET Developer ${tag}`)).toHaveValue("SHORTLISTED");
});

// M9-T3: a recipe imported on the Recipes page, then its versions
test("a recipe imported on the Recipes page is listed with its versions", async ({ page }) => {
  const name = `example.org/${unique("e2e").replace(/\W+/g, "-").toLowerCase()}`;
  await page.goto("/recipes");
  await page.getByRole("button", { name: "Import" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Recipe (YAML or JSON)").fill(`url: https://example.org/jobs?q={query}
params: { query: {} }
item: article.job
fields:
  url: { selector: a, attr: href, required: true }
  title: { selector: a, required: true }
`);
  await page.getByRole("button", { name: "Save as the next version" }).click();
  const row = page.getByTestId("recipes").locator("tr", { hasText: name });
  await expect(row).toContainText("v1");
  await expect(row).toContainText("Not run yet");

  await row.getByRole("link", { name }).click();
  await expect(page.getByText("in use")).toBeVisible();
  await expect(page.getByText("imported")).toBeVisible();
  await expect(page.getByText('"item": "article.job"')).toBeVisible();
});
