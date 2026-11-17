import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unique } from "./support";

// M55-E1 (Lockbox v2): a project's entries added on its page (the project set), filtered by project on Entries; an
// entry's project picked from a list; a field's help under its input; deleting a project in use asks first
test("Lockbox: entries added on their project's page, filtered by project, deleting a project in use asks", async ({ page }) => {
  const name = unique("Lockbox");
  const source = readFileSync(join(__dirname, "../../../pipelines/apps/lockbox.yaml"), "utf8").replace(/^name: Lockbox$/m, `name: ${name}`);
  const created = await page.request.post("/api/apps", { data: { source } });
  expect(created.status(), await created.text()).toBe(201);
  const appId = ((await created.json()) as { appId: string }).appId;
  for (const project of ["Acme", "Globex"]) {
    const added = await page.request.post(`/api/apps/${appId}/pages/Project`, { data: { values: { name: project } } });
    expect(added.status(), await added.text()).toBe(201);
  }

  // On Acme's page: Add a variable; its project is Acme, and stays.
  await page.goto(`/a/${appId}/Project/Acme`);
  const entries = page.getByTestId("related-Entry");
  await expect(entries).toContainText("None yet.");
  await entries.getByTestId("related-add-Entry").click();
  const form = page.getByTestId("related-form");
  await expect(form.getByTestId("ref-project")).toHaveValue("Acme");
  await expect(form.getByTestId("ref-project")).toBeDisabled();
  await expect(form).toContainText("Where in the project, e.g. /backend-api");
  await form.getByLabel("Name").fill("DATABASE_URL");
  await form.getByLabel("Kind").selectOption("secret");
  await form.getByLabel("Path").fill("/_backend");
  await form.getByLabel("Environment").selectOption("production");
  await form.getByLabel("Secret").fill("postgres://made-up");
  await form.getByRole("button", { name: "Add" }).click();
  await expect(entries.getByTestId("related-row")).toHaveCount(1);
  await expect(entries).toContainText("DATABASE_URL");

  // One for Globex, added on Entries with its project picked from the list.
  await page.goto(`/a/${appId}/Entry`);
  await page.getByTestId("add-entity").click();
  const add = page.getByTestId("add-form");
  await add.getByLabel("Name").fill("LOG_LEVEL");
  await add.getByLabel("Kind").selectOption("variable");
  await add.getByTestId("ref-project").selectOption({ label: "Globex" });
  await add.getByLabel("Path").fill("/api");
  await add.getByLabel("Environment").selectOption("staging");
  await add.getByRole("button", { name: "Add" }).click();
  await page.goto(`/a/${appId}/Entry`);
  await expect(page.getByTestId("entity-row")).toHaveCount(2);
  await page.getByTestId("filter-project").selectOption({ label: "Project: Acme" });
  await expect(page.getByTestId("entity-row")).toHaveCount(1);
  await expect(page.getByTestId("entity-row")).toContainText("DATABASE_URL");

  // Deleting Acme says its entry points at it.
  await page.goto(`/a/${appId}/Project/Acme`);
  await page.getByTestId("delete-entity").click();
  await expect(page.getByTestId("delete-referenced")).toContainText("1 Entry point at it");
});
