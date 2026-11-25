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
  // (the Google page says so, then takes it out of the address)
  await page.goto("/settings?google=connected#google");
  await expect(page.getByText("Google connected")).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/google$/);
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

// M63: the Storm bot, the hooks address, Google's OAuth client and the run limits in Settings, not .env.
test("Telegram: the bot is set up with its token, chat and webhook secret, and the code; the hooks address is saved", async ({ page }) => {
  await page.goto("/settings/telegram");
  await expect(page.getByTestId("telegram-not-set-up")).toBeVisible();
  await page.getByTestId("telegram-edit").click();
  const dialog = page.getByRole("dialog");
  // A first secret is generated unless one is pasted; the code is asked for.
  await expect(dialog.getByTestId("telegram-webhook-generate")).toBeChecked();
  await expect(dialog.getByTestId("telegram-code")).toBeVisible();
  await dialog.getByTestId("telegram-token").fill(`123456:${"a".repeat(35)}`);
  await dialog.getByTestId("telegram-chat").fill("4242");
  await expect(dialog.getByTestId("telegram-save")).toBeDisabled();
  await dialog.getByTestId("telegram-webhook-paste").check({ force: true }); // Tabler's label covers the radio
  await dialog.getByTestId("telegram-webhook-secret").fill("too-short");
  await dialog.getByTestId("telegram-code").fill("123456");
  await expect(dialog.getByTestId("telegram-save")).toBeDisabled();
  await dialog.getByTestId("telegram-webhook-secret").fill("s".repeat(40));
  await expect(dialog.getByTestId("telegram-save")).toBeEnabled();
  // Registering offers the hooks address + /telegram once it is set.
  await dialog.getByTestId("telegram-register").check();
  await expect(dialog.getByTestId("telegram-register-url")).toHaveValue("");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  const hooks = page.getByTestId("hooks-address");
  await hooks.getByLabel("Hooks address").fill("https://hooks.example.com/hooks/");
  await hooks.getByRole("button", { name: "Save" }).click();
  await expect(hooks.getByLabel("Hooks address")).toHaveValue("https://hooks.example.com/hooks");
  await page.getByTestId("telegram-edit").click();
  await page.getByRole("dialog").getByTestId("telegram-register").check();
  await expect(page.getByRole("dialog").getByTestId("telegram-register-url")).toHaveValue("https://hooks.example.com/hooks/telegram");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await hooks.getByLabel("Hooks address").fill("");
  await hooks.getByRole("button", { name: "Save" }).click();
  await expect(hooks.getByLabel("Hooks address")).toHaveValue("");
});

test("Google: the OAuth client is set up above the accounts, with its secret and the code", async ({ page }) => {
  await page.goto("/settings/google");
  const client = page.getByTestId("google-client");
  await expect(client.getByTestId("google-client-not-set")).toBeVisible();
  await expect(client).toContainText("/api/google/callback");
  await expect(page.getByTestId("google-setup")).toContainText("OAuth client above");
  await client.getByTestId("google-client-edit").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("google-client-id").fill("123-abc.apps.googleusercontent.com");
  await expect(dialog.getByTestId("google-client-save")).toBeDisabled();
  await dialog.getByTestId("google-client-secret").fill("GOCSPX-made-up-secret");
  await expect(dialog.getByTestId("google-client-save")).toBeDisabled();
  await dialog.getByTestId("google-client-code").fill("12345");
  await expect(dialog.getByTestId("google-client-save")).toBeDisabled();
  await dialog.getByTestId("google-client-code").fill("123456");
  await expect(dialog.getByTestId("google-client-save")).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("Runs & browser: the run limits saved, and back to their defaults", async ({ page }) => {
  await page.goto("/settings/runs");
  const limits = page.getByTestId("run-limits");
  await expect(limits.getByLabel("Keep run files")).toHaveValue("90");
  await expect(limits.getByLabel("Wait in the live view")).toHaveValue("30");
  await expect(limits.getByLabel("Largest download")).toHaveValue("25");
  await limits.getByLabel("Wait in the live view").fill("0");
  await expect(limits.getByRole("button", { name: "Save" })).toBeDisabled();
  await limits.getByLabel("Wait in the live view").fill("10");
  await limits.getByLabel("Largest download").fill("50");
  await limits.getByRole("button", { name: "Save" }).click();
  await page.reload();
  await expect(page.getByTestId("run-limits").getByLabel("Wait in the live view")).toHaveValue("10");
  await expect(page.getByTestId("run-limits").getByLabel("Largest download")).toHaveValue("50");
  await page.getByTestId("run-limits").getByLabel("Wait in the live view").fill("30");
  await page.getByTestId("run-limits").getByLabel("Largest download").fill("25");
  await page.getByTestId("run-limits").getByRole("button", { name: "Save" }).click();
  await page.reload();
  await expect(page.getByTestId("run-limits").getByLabel("Largest download")).toHaveValue("25");
});
