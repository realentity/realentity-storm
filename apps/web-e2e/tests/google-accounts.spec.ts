import { createPrismaConnection } from "@realentity/storm-db";
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createPipeline, unique } from "./support";

const CALENDAR = "https://www.googleapis.com/auth/calendar.events";
const DRIVE = "https://www.googleapis.com/auth/drive.readonly";

// M50-T8: several Google accounts in Settings (one the default, removal asked first), and a calendar step's google slot
// offered only the accounts that allow the calendar. The sign-in itself is Google's: the accounts are put in the database.
test("Google accounts: listed in Settings, one the default; a calendar step's slot picks one allowing the calendar", async ({ page }) => {
  const id = Date.now().toString(36);
  const home = `home-${id}@gmail.test`;
  const work = `work-${id}@gmail.test`;
  const db = createPrismaConnection();
  const { userId } = await db.client.user.findFirstOrThrow();
  const sealed = { ciphertext: Buffer.from("x"), iv: Buffer.from("x"), authTag: Buffer.from("x"), wrappedDek: Buffer.from("x") };
  await db.client.googleAccount.deleteMany({ where: { userId } });
  await db.client.googleAccount.create({
    data: { googleAccountId: randomUUID(), userId, email: home, scopes: [CALENDAR, DRIVE], isDefault: true, ...sealed },
  });
  await db.client.googleAccount.create({ data: { googleAccountId: randomUUID(), userId, email: work, scopes: [DRIVE], ...sealed } });
  try {
    await page.goto("/settings/google");
    const card = page.getByTestId("google-accounts");
    await expect(card.getByTestId(`google-account-${home}`)).toContainText("default");
    await expect(card.getByTestId(`google-account-${work}`).getByTestId("google-allowed")).toContainText("Calendar: not allowed");
    await card.getByRole("button", { name: `Make ${work} the default` }).click();
    await expect(card.getByTestId(`google-account-${work}`)).toContainText("default");

    // Only the account allowing the calendar fits the calendar step's slot.
    const pipeline = await createPipeline(
      page,
      `name: ${unique("Work calendar")}
steps:
  - id: today
    type: calendar.find
    with: { account: work }
`,
    );
    await page.goto(`/pipelines/${pipeline.pipelineId}`);
    const slot = page.getByTestId("needs-card").getByTestId("need-google-work");
    await expect(slot.locator("option")).toHaveText(["Your default account", home]);
    await slot.selectOption({ label: home });
    await expect(page.getByText("Chosen")).toBeVisible();

    await page.goto("/settings/google");
    await expect(card.getByTestId(`google-account-${home}`)).toContainText("Chosen on");
    await card.getByRole("button", { name: `Disconnect ${home}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Disconnect" }).click();
    await expect(card.getByTestId(`google-account-${home}`)).toHaveCount(0);
  } finally {
    await db.client.googleAccount.deleteMany({ where: { userId } });
    await db.close();
  }
});
