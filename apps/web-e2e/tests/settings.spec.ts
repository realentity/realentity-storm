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

// M62: the model servers on the AI page; the models chosen from them
test("AI: Claude among the model servers; a task's effort chosen, then reset; a server switched off and on", async ({ page }) => {
  await page.goto("/settings/ai");
  const servers = page.getByTestId("model-servers");
  const claude = servers.getByTestId("model-server").filter({ hasText: "Claude" });
  await expect(claude).toContainText("Claude API");
  await expect(claude).toContainText("key …-key");
  await expect(page.getByTestId("default-model")).toBeVisible();

  const row = page.getByTestId("models").getByRole("row").filter({ hasText: "llm.summarize" });
  await row.getByLabel("llm.summarize effort").selectOption("high");
  await expect(row).toContainText("chosen here");
  await expect(row.getByLabel("llm.summarize effort")).toHaveValue("high");
  await row.getByRole("button", { name: "Reset" }).click();
  await expect(row).toContainText("built-in default");
  await expect(row.getByLabel("llm.summarize effort")).toHaveValue("medium");

  // Off: its models can't be chosen; on again.
  // The switch follows the saved state: it changes once the server is switched off.
  await claude.getByLabel("Claude on").click();
  await expect(claude.getByLabel("Claude on")).not.toBeChecked();
  await expect(page.getByTestId("models").getByLabel("llm.summarize model").locator("optgroup")).toHaveAttribute("label", "Claude (off)");
  await claude.getByLabel("Claude on").click();
  await expect(claude.getByLabel("Claude on")).toBeChecked();
  await expect(page.getByTestId("models").getByLabel("llm.summarize model").locator("optgroup")).toHaveAttribute("label", "Claude");
});

test("AI: a model server's address and key are saved only with the authenticator code", async ({ page }) => {
  await page.goto("/settings/ai");
  await page.getByTestId("model-server-add").click();
  const dialog = page.getByRole("dialog");
  // Claude is set up already: the form offers a server of your own.
  await expect(dialog.getByTestId("model-server-kind-openai")).toBeChecked();
  await expect(dialog.getByTestId("model-server-url")).toHaveValue("http://host.docker.internal:11434/v1");
  await expect(dialog.getByTestId("model-server-code")).toBeVisible();
  await expect(dialog.getByTestId("model-server-save")).toBeDisabled();
  await dialog.getByTestId("model-server-code").fill("12ab");
  await expect(dialog.getByTestId("model-server-code")).toHaveValue("12");
  await expect(dialog.getByTestId("model-server-save")).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
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
