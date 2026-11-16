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
  await expect(page.getByText("imported or edited")).toBeVisible();
  await expect(page.getByText("item: article.job")).toBeVisible();

  // Edited in place: a recipe that doesn't hold up is refused, a fixed one is saved as v2
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const source = page.getByLabel("Recipe (YAML)");
  await expect(source).toHaveValue(/^url: https:\/\/example\.org\/jobs\?q=\{query\}\nparams:/);
  await source.fill((await source.inputValue()).replace("key: url", "key: link"));
  await page.getByRole("button", { name: "Save as v2" }).click();
  await expect(page.getByTestId("recipe-editor")).toContainText('key "link" is not one of the fields');
  await source.fill((await source.inputValue()).replace("key: link", "key: url\nempty: .no-results"));
  await page.getByRole("button", { name: "Save as v2" }).click();
  await expect(page.getByTestId("recipe-editor")).toBeHidden();
  await expect(page.getByRole("heading", { name: "v2 in use" })).toBeVisible();
  await expect(page.getByText("empty: .no-results")).toBeVisible();

  // Tried with a search: the items it reads, in place; a page that doesn't match says what didn't
  const tryCard = page.getByTestId("try-recipe");
  await expect(tryCard.getByRole("heading", { name: "Try v2" })).toBeVisible();
  await expect(page.getByTestId("try-address")).toContainText("The recipe reads https://example.org/jobs?q=<query>");
  await expect(page.getByTestId("try-opens")).toHaveText("Opens https://example.org/jobs?q=<query>");
  await tryCard.getByLabel("query").fill("net");
  await expect(page.getByTestId("try-opens")).toHaveText("Opens https://example.org/jobs?q=net");
  await tryCard.getByRole("button", { name: "Try" }).click();
  await expect(page.getByTestId("try-result")).toContainText("2 items on 2 pages.");
  await expect(page.getByTestId("try-items").getByRole("link", { name: "https://example.org/jobs/net-1" })).toBeVisible();
  await expect(page.getByTestId("try-items")).toContainText("net developer 2");

  await tryCard.getByLabel("query").fill("redesigned");
  await tryCard.getByRole("button", { name: "Try" }).click();
  await expect(page.getByTestId("try-result")).toContainText(`Recipe ${name} v1 doesn't match the page: "article.job" matched nothing`);

  // With a detail section, Try shows those fields of the first items too
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await source.fill(`${await source.inputValue()}detail: { fields: { description: { selector: .description } } }\n`);
  await page.getByRole("button", { name: "Save as v3" }).click();
  await expect(page.getByRole("heading", { name: "v3 in use" })).toBeVisible();
  await tryCard.getByLabel("query").fill("net");
  await tryCard.getByRole("button", { name: "Try" }).click();
  await expect(page.getByTestId("try-result")).toContainText("2 items on 2 pages. Details from 2 of the first 2 item pages.");
  await expect(page.getByTestId("try-items").getByRole("columnheader", { name: "description" })).toBeVisible();
  await expect(page.getByTestId("try-items")).toContainText("About net developer 1");
  // A try changes nothing: still not run
  await page.goto("/recipes");
  await expect(page.getByTestId("recipes").locator("tr", { hasText: name })).toContainText("Not run yet");
});

// The Teach form explains params with examples, and shows the address the recipe keeps as they are typed
test("the Teach form shows what the recipe keeps of the search results page", async ({ page }) => {
  await page.goto("/recipes");
  await page.getByTestId("teach").click();
  await expect(page.getByTestId("teach-params-examples")).toContainText("is https://www.bergfreunde.eu/s/<query>");
  await page.getByLabel("The list holds").selectOption({ label: "Products" });
  await page.getByRole("button", { name: "Fill in an example" }).click();
  await expect(page.getByLabel("Search results page")).toHaveValue("https://www.bergfreunde.eu/s/fjallraven-jacket");
  await expect(page.getByTestId("teach-preview")).toHaveText("Read as https://www.bergfreunde.eu/s/<query>");

  await page.getByLabel("Params").fill("query=fjallraven-jacket, sort=price");
  await expect(page.getByTestId("teach-preview")).toContainText("The value of sort isn't in the address");
  await page.getByLabel("Params").fill("");
  await expect(page.getByTestId("teach-preview")).toHaveText("Read as https://www.bergfreunde.eu/s/fjallraven-jacket: always this page.");
});
