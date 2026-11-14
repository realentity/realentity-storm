import { expect, test } from "@playwright/test";
import { createPipeline, unique } from "./support";

// M50-T7: email accounts in Settings (Gmail's servers filled in, another made the default, removal asked first), and a
// pipeline's email slot choosing one of them on its page.
test("email accounts: added in Settings, one the default; a pipeline's email slot picks one", async ({ page }) => {
  const id = Date.now().toString(36);
  const home = `home-${id}@example.com`;
  const work = `work-${id}@example.com`;

  await page.goto("/settings");
  const card = page.getByTestId("email-accounts");
  for (const [address, label] of [
    [home, ""],
    [work, "Work"],
  ]) {
    await card.getByTestId("email-account-add").click();
    await page.getByLabel("Address").fill(address);
    await page.getByLabel("App password").fill(`made-up-${id}`);
    if (label) await page.getByLabel(/^Label/).fill(label);
    await page.getByTestId("email-account-save").click();
    await expect(card.getByTestId(`email-account-${address}`)).toContainText("imap.gmail.com:993");
  }
  // The first added is the default; the other becomes it on request.
  await expect(card.getByTestId(`email-account-${home}`)).toContainText("default");
  await card.getByRole("button", { name: `Make ${work} the default` }).click();
  await expect(card.getByTestId(`email-account-${work}`)).toContainText("default");
  await expect(card.getByTestId(`email-account-${home}`)).not.toContainText("default");

  // A pipeline reading "work" mail: its slot offers the accounts, the default until one is chosen.
  const pipeline = await createPipeline(
    page,
    `name: ${unique("Work mail")}
steps:
  - id: fetch
    type: email.fetch
    with: { account: work }
`,
  );
  await page.goto(`/pipelines/${pipeline.pipelineId}`);
  const needs = page.getByTestId("needs-card");
  await expect(needs.getByTestId("needs-missing")).toHaveCount(0);
  const slot = needs.getByTestId("need-email-work");
  await expect(slot).toHaveValue("");
  await slot.selectOption({ label: home });
  await expect(page.getByText("Chosen")).toBeVisible();

  // Settings says where each is used; removing asks first.
  await page.goto("/settings");
  await expect(card.getByTestId(`email-account-${home}`)).toContainText("Chosen on");
  for (const address of [home, work]) {
    await card.getByRole("button", { name: `Remove ${address}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
    await expect(card.getByTestId(`email-account-${address}`)).toHaveCount(0);
  }
});
