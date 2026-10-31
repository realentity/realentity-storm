import { expect, test } from "@playwright/test";
import { createPipeline, REPLIES, unique } from "./support";

// M7-E1 (the builder's model is a stand-in, src/test-builder.ts)
test('"Also include Plovdiv" in the pipeline chat → diff shown → confirm → the next version is saved', async ({ page }) => {
  const pipeline = await createPipeline(page, REPLIES(unique("Builder e2e")));
  await page.goto(`/pipelines/${pipeline.pipelineId}`);

  const chat = page.getByTestId("pipeline-chat");
  await chat.getByTestId("builder-input").fill("Also include Plovdiv");
  await chat.getByTestId("builder-send").click();

  const proposal = chat.getByTestId("builder-proposal");
  await expect(proposal).toContainText("Also search in Plovdiv");
  await expect(proposal).toContainText("Changes against v1");
  await expect(proposal).toContainText("dotnet Plovdiv");
  await expect(chat.getByTestId("builder-answer").last()).toContainText("The search now includes it.");

  await proposal.getByTestId("builder-save").click();
  await expect(proposal).toContainText("saved as v2");
  await expect(page.getByTestId("versions")).toContainText("v2");
  await expect(page.getByTestId("versions")).toContainText("query");
});
