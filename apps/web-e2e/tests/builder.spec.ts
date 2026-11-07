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

// M38-E3: the builder beside the cards: it sees what is open, its proposal goes onto the cards marked, saved from there
test("a proposal from the editor's chat goes onto the cards with its changes marked, and is saved from the editor", async ({ page }) => {
  const pipeline = await createPipeline(page, REPLIES(unique("Editor chat")));
  await page.goto(`/pipelines/${pipeline.pipelineId}/edit`);

  // A change on the cards, not saved: the builder must keep it.
  const description = page.getByLabel("The pipeline's description");
  await description.fill("Replies to recruiters");
  await description.press("Enter");
  // What I am on goes with the message.
  await page.locator('[data-testid="step-card"][data-step="search"]').getByTestId("input-query").focus();
  const chat = page.getByTestId("editor-chat");
  await expect(chat.getByTestId("editor-chat-context")).toContainText("step search, input query");

  await chat.getByTestId("builder-input").fill("Also include Plovdiv");
  await chat.getByTestId("builder-send").click();
  await expect(chat.getByTestId("builder-proposal")).toContainText("Also search in Plovdiv");
  await chat.getByTestId("builder-use").click();

  const search = page.locator('[data-testid="step-card"][data-step="search"]');
  await expect(search).toHaveAttribute("data-marked", "true");
  await expect(search.getByTestId("builder-mark")).toBeVisible();
  await expect(page.locator('[data-testid="step-card"][data-step="reply"]')).not.toHaveAttribute("data-marked", "true");
  await expect(page.getByTestId("builder-marks")).toContainText("search changed");
  await expect(search.getByTestId("input-query")).toHaveValue("dotnet Plovdiv");
  await expect(description).toHaveValue("Replies to recruiters");

  // Undo takes it back; used again, it is saved from the editor.
  await page.getByTestId("pipeline-undo").click();
  await expect(search.getByTestId("input-query")).toHaveValue("dotnet");
  await expect(page.getByTestId("builder-marks")).toHaveCount(0);
  await chat.getByTestId("builder-use").click();
  await page.getByTestId("save").click();
  await expect(page).toHaveURL(new RegExp(`/pipelines/${pipeline.pipelineId}$`));
  await expect(page.getByTestId("versions")).toContainText("v2");
  const saved = (await (await page.request.get(`/api/pipelines/${pipeline.pipelineId}`)).json()) as {
    current: { definition: { description?: string; steps: { id: string; with: { query?: string } }[] } };
  };
  expect(saved.current.definition.description).toBe("Replies to recruiters");
  expect(saved.current.definition.steps[0].with.query).toBe("dotnet Plovdiv");
});
