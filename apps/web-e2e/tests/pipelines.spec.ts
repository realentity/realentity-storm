import { expect, test } from "@playwright/test";
import { REPLIES, createPipeline, startRun, unique } from "./support";

test.describe("pipelines", () => {
  // M3-E1
  test("paste YAML → review → dry run → save v1 → enable", async ({ page }) => {
    const name = unique("E1 replies");
    await page.goto("/pipelines/new");
    await page.getByTestId("pipeline-tab-yaml").click();
    await page.getByTestId("pipeline-source").fill(REPLIES(name, '{ schedule: "0 8 * * 1-5", tz: Europe/Sofia }'));

    await page.getByTestId("check").click();
    await expect(page.getByTestId("policy-summary")).toContainText(
      "reply (test.send) acts outside Storm, once per item; it waits for your approval at replyGate.",
    );
    await expect(page.getByTestId("policy-summary")).toContainText("reply.to (recipient) must come from {{item.recruiter}}");
    await expect(page.getByTestId("step-graph")).toContainText("replyGate");
    await expect(page.getByText("On schedule 0 8 * * 1-5 (Europe/Sofia)")).toBeVisible();

    await page.getByTestId("dry-run").click();
    const dryRun = page.getByTestId("dry-run-status");
    await expect(dryRun).toContainText("done");
    await expect(dryRun).toContainText("Would act: reply #1 → ana@acme.test");
    await expect(dryRun).toContainText("Would act: reply #2 → bob@other.test");

    await page.getByTestId("save").click();
    await expect(page).toHaveURL(/\/pipelines\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name })).toBeVisible();
    await expect(page.getByTestId("versions")).toContainText("v1");
    // The dry run previewed the draft that became v1, so it stays with v1.
    await expect(page.getByTestId("runs")).toContainText("dry-run");

    // M17-E1: what it cost: the dry run, and per month on its schedule (weekdays at 8).
    await expect(page.getByTestId("pipeline-cost")).toContainText("Runs1 (1 dry)");
    await expect(page.getByTestId("cost-per-month")).toContainText(/≈ \$0 \(2\d runs\)/);

    // The switch shows the saved state: it turns on once the api has enabled the pipeline. A schedule asks first,
    // with what it would cost a month.
    const enable = page.getByTestId("enable-pipeline");
    await enable.click();
    await expect(page.getByText(/It runs 2\d times in the next 30 days/)).toBeVisible();
    await page.getByTestId("confirm-enable").click();
    await expect(enable).toBeChecked();
    await page.reload();
    await expect(page.getByTestId("enable-pipeline")).toBeChecked();
  });

  // M3-E4
  test("saving v2 shows the diff against v1; runs reference their version", async ({ page }) => {
    const name = unique("E4 replies");
    const pipeline = await createPipeline(page, REPLIES(name));
    await startRun(page, pipeline.pipelineId);

    await page.goto(`/pipelines/${pipeline.pipelineId}/edit`);
    await page.getByTestId("pipeline-tab-yaml").click();
    const source = page.getByTestId("pipeline-source");
    await expect(source).toHaveValue(/query: dotnet/);
    await source.fill((await source.inputValue()).replace("query: dotnet", "query: golang"));
    await page.getByTestId("check").click();
    const diff = page.getByTestId("version-diff");
    await expect(diff).toContainText("Changes against v1");
    await expect(diff).toContainText('step search with.query: "dotnet" → "golang"');
    await expect(diff.locator("li")).toHaveCount(1);

    await page.getByTestId("save").click();
    await expect(page.getByTestId("versions")).toContainText("v2");
    await expect(page.getByTestId("versions")).toContainText("step search: with.query");

    await page.getByTestId("run-now").click();
    await expect(page).toHaveURL(/\/runs\//);
    await expect(page.getByRole("link", { name: `${name} · v2` })).toBeVisible();

    await page.goto(`/history?pipelineId=${pipeline.pipelineId}`);
    const rows = page.getByTestId("runs").locator("tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("v2");
    await expect(rows.nth(1)).toContainText("v1");

    await page.goto(`/history?pipelineId=${pipeline.pipelineId}&version=1`);
    await expect(page.getByTestId("runs").locator("tbody tr")).toHaveCount(1);
  });
  // M12-E1
  test("a webhook pipeline: create its address, see the secret once, rotate it", async ({ page }) => {
    const name = unique("E1 hook");
    const pipeline = await createPipeline(page, REPLIES(name, "{ webhook: hmac-sha256 }"));
    await page.goto(`/pipelines/${pipeline.pipelineId}`);
    await expect(page.getByText("On a webhook call (HMAC-SHA256 signature), while enabled.")).toBeVisible();

    const card = page.getByTestId("webhook");
    await expect(card).toContainText("No address yet");
    await page.getByTestId("webhook-rotate").click();
    await expect(page.getByTestId("webhook-address")).toContainText(/\/hooks\/[A-Za-z0-9_-]{43}$/);
    const first = await page.getByTestId("webhook-secret").locator("code").innerText();
    const address = await page.getByTestId("webhook-address").innerText();

    await page.reload();
    await expect(page.getByTestId("webhook-address")).toHaveText(address);
    await expect(page.getByTestId("webhook-secret")).toHaveCount(0);

    await page.getByTestId("webhook-rotate").click();
    await expect(page.getByTestId("webhook-secret").locator("code")).not.toHaveText(first);
    await expect(page.getByTestId("webhook-address")).toHaveText(address);
  });
});
