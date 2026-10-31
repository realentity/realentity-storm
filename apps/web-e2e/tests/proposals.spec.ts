import { expect, test } from "@playwright/test";
import { REPLIES, createPipeline, openProposal, startRun, stepRow, unique } from "./support";

test.describe("proposals", () => {
  // M3-E2
  test("edit a proposal's payload → approve → Act → the run continues with the edited payload", async ({ page }) => {
    const name = unique("E2 replies");
    const pipeline = await createPipeline(page, REPLIES(name));
    const run = await startRun(page, pipeline.pipelineId);

    await openProposal(page, name, "reply", 1);
    await expect(page.getByTestId("payload")).toContainText("Thanks for Senior .NET");
    // From the run's own data, but not on the pipeline's allowlist: shown as new.
    await expect(page.getByTestId("targets")).toContainText("ana@acme.test");
    await expect(page.getByTestId("targets")).toContainText("New recipient");

    await page.getByTestId("edit-payload").click();
    await page.getByTestId("field-body").fill("Thanks, Ana: edited by me");
    await expect(page.getByTestId("act")).toHaveText(/Act with edits/);
    await page.getByTestId("act").click();
    await expect(page.getByRole("dialog")).toContainText("edited: body");
    await page.getByTestId("act-confirm").click();
    await expect(page.getByTestId("decision")).toContainText("Approved with edits");

    await page.goto(`/runs/${run.runId}`);
    const sent = stepRow(page, "test.send", 1);
    await expect(sent).toContainText("done");
    await sent.click();
    await expect(page.getByTestId("timeline")).toContainText('"sentBody": "Thanks, Ana: edited by me"');
    // Item 2 still waits for me.
    await expect(page.getByTestId("run-status")).toContainText("waiting for me");
  });

  // M3-E3
  test("reject with a reason → the run skips that item and keeps the reason", async ({ page }) => {
    const name = unique("E3 replies");
    const pipeline = await createPipeline(page, REPLIES(name));
    const run = await startRun(page, pipeline.pipelineId);

    await openProposal(page, name, "reply", 2);
    await page.getByTestId("reject").click();
    await page.getByLabel(/Why\?/).fill("Agency, not a direct hire");
    await page.getByTestId("reject-confirm").click();
    await expect(page).toHaveURL(/\/inbox$/);

    await openProposal(page, name, "reply", 1);
    await page.getByTestId("act").click();
    await page.getByTestId("act-confirm").click();
    await expect(page.getByTestId("decision")).toContainText("Approved");

    await page.goto(`/runs/${run.runId}`);
    await expect(page.getByTestId("run-status")).toContainText("done");
    await expect(stepRow(page, "test.send", 2)).toContainText("skipped");
    await expect(stepRow(page, "test.send", 1)).toContainText("done");
    const rejected = page.getByTestId("run-proposals").getByRole("link", { name: /reply\s*#2/ });
    await expect(rejected).toContainText("rejected");
    await expect(rejected).toContainText("“Agency, not a direct hire”");
  });
});
