import { expect, test } from "@playwright/test";
import { unique } from "./support";

// M52-E1 (the form's part): a secret set on the add form, never shown again, replaced and cleared
test("an encrypted field: set, shown only as set, replaced and cleared", async ({ page }) => {
  const name = unique("Secrets");
  const created = await page.request.post("/api/apps", {
    data: {
      source: `name: ${name}
types:
  Secret:
    key: name
    fields:
      name: { type: text, required: true }
      value: { type: text, mine: true, encrypted: true }
pages:
  - list: Secret
    add: true
  - form: Secret
    fields: [value]
`,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const appId = ((await created.json()) as { appId: string }).appId;

  await page.goto(`/a/${appId}/Secret`);
  await page.getByTestId("add-entity").click();
  const add = page.getByTestId("add-form");
  await add.getByLabel("Name").fill("API_TOKEN");
  await expect(add.getByLabel("Value")).toHaveAttribute("type", "password");
  await add.getByLabel("Value").fill("s3cret-token");
  await add.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("heading", { name: "API_TOKEN" })).toBeVisible();

  // Its page: *** and "Set, encrypted"; the value is nowhere on it.
  await expect(page.getByTestId("entity-fields")).toContainText("***");
  await expect(page.getByTestId("secret-value")).toContainText("Set, encrypted");
  await expect(page.locator("body")).not.toContainText("s3cret-token");

  // Replace: a new value; the page still shows it only as set.
  await page.getByTestId("replace-value").click();
  await page.getByTestId("entity-form").getByLabel("Value").fill("new-token");
  await page.getByTestId("entity-form").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("secret-value")).toContainText("Set, encrypted");
  await expect(page.locator("body")).not.toContainText("new-token");

  // Clear: gone.
  await page.getByTestId("clear-value").click();
  await page.getByTestId("entity-form").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("entity-fields")).not.toContainText("***");
  await expect(page.getByTestId("entity-form").getByLabel("Value")).toHaveValue("");
});
