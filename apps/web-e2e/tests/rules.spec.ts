import { expect, test } from "@playwright/test";
import { createPipeline, REPLIES, unique } from "./support";

// M6-T6
test("a rule added is active for the step type and pipeline picked; it can be edited, disabled and enabled", async ({ page }) => {
  const pipeline = await createPipeline(page, REPLIES(unique("Rules e2e")));
  const text = unique("Keep replies under 80 words");

  await page.goto("/rules");
  await page.getByTestId("add-rule").click();
  const form = page.getByTestId("rule-form");
  await form.getByLabel("Rule").fill(text);
  await form.getByLabel("Step type").selectOption("email.draftReply");
  await form.getByLabel("Pipeline").selectOption(pipeline.pipelineId);
  await form.getByRole("button", { name: "Add" }).click();

  const active = page.getByTestId("active-rules").locator(".list-group-item", { hasText: text });
  await expect(active).toContainText(`email.draftReply · ${pipeline.name}`);

  await active.getByTitle("Edit").click();
  await page.getByTestId("rule-form").getByLabel("Rule").fill(`${text}, and sign off with "Best,"`);
  await page.getByTestId("rule-form").getByRole("button", { name: "Save" }).click();
  const edited = page.getByTestId("active-rules").locator(".list-group-item", { hasText: 'sign off with "Best,"' });
  await expect(edited).toBeVisible();

  await edited.getByTitle("Disable").click();
  const disabled = page.getByTestId("disabled-rules").locator(".list-group-item", { hasText: text });
  await expect(disabled).toBeVisible();
  await disabled.getByTitle("Enable").click();
  await expect(page.getByTestId("active-rules").locator(".list-group-item", { hasText: text })).toBeVisible();
});
