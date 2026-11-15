import { expect, test } from "@playwright/test";
import { createPipeline, unique } from "./support";

// M49: the Storm bot's commands in Settings: a pipeline's, off, with the pipeline it starts; then on; and Storm's own.
test("Telegram commands in Settings: a pipeline's command, off until it is on, and Storm's own", async ({ page }) => {
  const command = `t${Date.now().toString(36)}`.slice(0, 32);
  const name = unique("Note it");
  const pipeline = await createPipeline(
    page,
    `name: ${name}
trigger: { on: telegram.command, command: ${command}, description: "Keep a note" }
steps:
  - id: tell
    type: notify.telegram
    with: { text: "{{trigger.text}}" }
`,
  );

  await page.goto("/settings");
  const card = page.getByTestId("telegram-commands");
  const row = card.getByTestId("telegram-command").filter({ hasText: `/${command}` });
  await expect(row).toContainText(name);
  await expect(row).toContainText("Keep a note");
  await expect(row).toHaveAttribute("data-answers", "false");
  await expect(row.getByTestId("telegram-command-off")).toContainText("Answers once the pipeline is switched on");
  await expect(card.getByTestId("telegram-command").filter({ hasText: "/inbox" })).toHaveAttribute("data-answers", "true");

  // Its pipeline's link opens it; switched on there, the command answers.
  await row.getByRole("link", { name }).click();
  await expect(page).toHaveURL(new RegExp(`/pipelines/${pipeline.pipelineId}$`));
  await page.getByTestId("enable-pipeline").click();
  await expect(page.getByTestId("enable-pipeline")).toBeChecked();
  await page.goto("/settings");
  await expect(row).toHaveAttribute("data-answers", "true");
  await expect(row.getByTestId("telegram-command-off")).toHaveCount(0);

  await page.request.patch(`/api/pipelines/${pipeline.pipelineId}`, { data: { enabled: false } });
});
