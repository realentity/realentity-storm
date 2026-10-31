import { expect, test } from "@playwright/test";
import { createPipeline, unique } from "./support";

const SLOW = (name: string) => `name: ${name}
steps:
${[1, 2, 3, 4, 5].map((n) => `  - id: wait${n}\n    type: test.wait\n    with: { ms: 1500 }`).join("\n")}
`;

test.afterEach(async ({ page }) => {
  // The kill switch is global: never leave it on for the next test.
  await page.request.put("/api/kill-switch", { data: { engaged: false } });
});

// M3-E6
test("the kill switch in the top bar stops a running pipeline at its next step", async ({ page }) => {
  const name = unique("E6 slow");
  const pipeline = await createPipeline(page, SLOW(name));

  await page.goto(`/pipelines/${pipeline.pipelineId}`);
  await page.getByTestId("run-now").click();
  await expect(page).toHaveURL(/\/runs\//);
  await expect(page.getByTestId("run-status")).toContainText("running");

  await page.getByTestId("kill-switch").click();
  await page.getByTestId("kill-switch-confirm").click();
  await expect(page.getByTestId("kill-switch")).toContainText("Paused");

  await expect(page.getByTestId("run-status")).toContainText("aborted");
  await expect(page.getByText("Stopped by the kill switch")).toBeVisible();
  // It stopped at a step boundary: some steps never ran.
  await expect(page.getByTestId("timeline").locator("tbody tr", { hasText: "wait5" })).toHaveCount(0);

  // Pressing it again lets pipelines run again.
  await page.getByTestId("kill-switch").click();
  await expect(page.getByTestId("kill-switch")).toContainText("Stop everything");
});
