import { expect, test } from "@playwright/test";

// M61: Settings in pages: AI, Email, Google, Telegram, Runs & browser
test("Settings opens on AI; each tab is a page of its own; the old #email and #google links still land", async ({ page }) => {
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/ai$/);
  await expect(page.getByTestId("models")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Monthly LLM budget" })).toBeVisible();
  await expect(page.getByTestId("settings-ai")).toHaveClass(/active/);
  // The other pages' cards aren't on this one.
  await expect(page.getByTestId("email-accounts")).toHaveCount(0);
  await expect(page.getByTestId("telegram-approvals")).toHaveCount(0);

  const pages = [
    { tab: "email", shows: page.getByTestId("email-accounts") },
    { tab: "google", shows: page.getByTestId("google-accounts") },
    { tab: "telegram", shows: page.getByTestId("telegram-approvals") },
    { tab: "runs", shows: page.getByRole("heading", { name: "Global rate limits" }) },
  ];
  for (const { tab, shows } of pages) {
    await page.getByTestId(`settings-${tab}`).click();
    await expect(page).toHaveURL(new RegExp(`/settings/${tab}$`));
    await expect(shows).toBeVisible();
    await expect(page.getByTestId("models")).toHaveCount(0);
  }
  await expect(page.getByTestId("telegram-approvals")).toHaveCount(0);

  await page.goto("/settings#email");
  await expect(page).toHaveURL(/\/settings\/email$/);
  await expect(page.getByTestId("email-accounts")).toBeVisible();
  // Back from Google's consent screen with an old address: the outcome in the query is kept.
  await page.goto("/settings?google=connected#google");
  await expect(page).toHaveURL(/\/settings\/google\?google=connected$/);
  await expect(page.getByTestId("google-accounts")).toBeVisible();
  await page.goto("/settings/nothing-here");
  await expect(page).toHaveURL(/\/settings\/ai$/);
});

// M60 on its page: without a model server local models can't be switched on, and a task's effort is chosen here
test("AI: local models off without a server; a task's effort chosen, then reset", async ({ page }) => {
  await page.goto("/settings/ai");
  const local = page.getByTestId("local-models");
  await expect(page.getByTestId("local-models-switch")).toBeDisabled();
  await expect(local).toContainText("set OPENAI_BASE_URL in .env");
  await expect(page.getByTestId("local-model")).toHaveCount(0);

  const row = page.getByTestId("models").getByRole("row").filter({ hasText: "llm.summarize" });
  await row.getByLabel("llm.summarize effort").selectOption("high");
  await expect(row).toContainText("chosen here");
  await expect(row.getByLabel("llm.summarize effort")).toHaveValue("high");
  await row.getByRole("button", { name: "Reset" }).click();
  await expect(row).toContainText("default");
  await expect(row.getByLabel("llm.summarize effort")).toHaveValue("medium");
});

test("Telegram: the morning brief switched off and on again on its page", async ({ page }) => {
  await page.goto("/settings/telegram");
  const brief = page.getByTestId("morning-brief");
  await expect(brief).toBeChecked();
  await brief.click();
  await expect(brief).not.toBeChecked();
  await page.reload();
  await expect(page.getByTestId("morning-brief")).not.toBeChecked();
  await page.getByTestId("morning-brief").click();
  await expect(page.getByTestId("morning-brief")).toBeChecked();
});
