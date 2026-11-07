import { expect, test, type Locator } from "@playwright/test";
import { startRun, unique } from "./support";

/** Type into a box and leave it: written into the YAML then. */
async function commit(box: Locator, value: string) {
  await box.fill(value);
  await box.press("Enter");
}

// M39-I1, M39-I2: an App and a pipeline renamed in the editors; what refers to them follows, and runs
test("an App and its pipeline renamed: the note says what follows, its run, editor and button still work", async ({ page }) => {
  const appName = unique("Shelf");
  const pipelineName = unique("Books in");
  const app = `name: ${appName}
types:
  Book:
    key: isbn
    fields:
      isbn: { type: text, required: true }
      title: { type: text }
pages:
  - list: Book
    actions:
      - { label: Fetch now, run: ${pipelineName} }
`;
  const saved = await page.request.post("/api/bundles", {
    data: {
      text: `${app}---\nname: ${pipelineName}\napp: ${appName}\nsteps:\n  - id: save\n    type: data.save\n    with:\n      type: Book\n      items:\n        - { isbn: "978-0", title: Dune }\n`,
    },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const appId = ((await (await page.request.get("/api/apps")).json()) as { appId: string; name: string }[]).find(
    (a) => a.name === appName,
  )!.appId;

  // The App renamed in the designer: its pipeline follows.
  const library = unique("Library");
  await page.goto(`/apps/${appId}/edit`);
  await commit(page.getByTestId("app-name"), library);
  await expect(page.getByTestId("rename-followers")).toContainText(`1 pipeline follows the new name: ${pipelineName}`);
  await page.getByTestId("save-app").click();
  await page.waitForURL(`/apps/${appId}`);

  // Its pipeline still saves its entities, and its editor shows the new name.
  const pipelineId = ((await (await page.request.get("/api/pipelines")).json()) as { pipelineId: string; name: string }[]).find(
    (p) => p.name === pipelineName,
  )!.pipelineId;
  const run = await startRun(page, pipelineId);
  await page.goto(`/runs/${run.runId}`);
  await expect(page.getByText("DONE").first()).toBeVisible({ timeout: 20_000 });
  await page.goto(`/a/${appId}/Book`);
  await expect(page.getByTestId("entity-row")).toHaveCount(1);
  await page.goto(`/pipelines/${pipelineId}/edit`);
  await expect(page.getByTestId("pipeline-app")).toHaveValue(library);

  // The pipeline renamed on its cards: the App's button follows, and starts it.
  const fetched = unique("Books fetched");
  await commit(page.getByTestId("pipeline-name"), fetched);
  await expect(page.getByTestId("rename-followers")).toContainText(`a button of "${library}"`);
  await page.getByTestId("save").click();
  await page.waitForURL(`/pipelines/${pipelineId}`);
  await page.goto(`/a/${appId}/Book`);
  await page.getByRole("button", { name: "Fetch now" }).click();
  await expect(page).toHaveURL(/\/runs\//);
  const runs = (await (await page.request.get(`/api/runs?pipelineId=${pipelineId}`)).json()) as unknown[];
  expect(runs).toHaveLength(2);
});
