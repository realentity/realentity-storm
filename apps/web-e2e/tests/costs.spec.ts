import { createPrismaConnection } from "@realentity/storm-db";
import { expect, test } from "@playwright/test";
import { REPLIES, createPipeline, startRun, unique } from "./support";

const usage = (model: string, inputTokens: number, outputTokens: number, costUsd: number) => ({
  models: [model],
  calls: 1,
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd,
});

test.describe("costs", () => {
  // M28-E1
  test("every run with its cost; a pipeline's steps by share; a run's steps; the report", async ({ page, context }) => {
    const name = unique("E1 costs");
    const pipeline = await createPipeline(page, REPLIES(name));
    const run = await startRun(page, pipeline.pipelineId);
    // What the worker records for LLM steps (the test steps call none).
    const db = createPrismaConnection();
    try {
      await db.client.step.createMany({
        data: [
          { runId: run.runId, stepKey: "classify", type: "llm.classify", status: "DONE", startedAt: new Date(), llmUsage: usage("claude-haiku-5-5", 2400, 40, 0.00026) },
          { runId: run.runId, stepKey: "draft", itemIndex: 0, type: "email.draftReply", status: "DONE", startedAt: new Date(), llmUsage: usage("claude-sonnet-5-5", 3100, 700, 0.0132) },
        ],
      });
    } finally {
      await db.close();
    }

    await page.goto("/costs");
    await page.getByLabel("Pipeline").selectOption({ label: name });
    await expect(page.getByTestId("costs-total")).toHaveText("$0.0135");

    const steps = page.getByTestId("costs-steps");
    await expect(steps.locator("tbody tr").first()).toContainText("draft");
    await expect(steps.locator("tbody tr").first()).toContainText("98%");
    await page.screenshot({ path: "test-results/costs-pipeline.png", fullPage: true });

    const row = page.getByTestId("costs-run").first();
    await expect(row).toContainText("$0.0135");
    await row.click();
    await expect(page.getByTestId("costs-runs")).toContainText("claude-sonnet-5-5");
    await page.screenshot({ path: "test-results/costs-run.png", fullPage: true });

    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByTestId("copy-report").click();
    await expect(page.getByText("Report copied")).toBeVisible();
    const report = await page.evaluate(() => navigator.clipboard.readText());
    expect(report).toContain(`### ${name}: 1 runs, $0.0135, $0.0135 per run`);
    expect(report).toContain("| draft | email.draftReply | claude-sonnet-5-5 | 1.0 | 3.1K | 700 | 0 | 0 | $0.0132 | 98% |");
  });
});
