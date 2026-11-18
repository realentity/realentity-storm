import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unique } from "./support";

// M55-E1, M56-E1, M57-E1 (Lockbox v3): on a project's page its paths, and its variables and secrets by path, each path with Add
// variable and Add secret (its path, the environment chosen and the kind set); a bundle's paths picked in order, its
// fields as its destination needs; an entry's path among its project's; deleting a project in use asks first
test("Lockbox: variables and secrets added by path on their project's page, a bundle's paths in order", async ({ page }) => {
  const name = unique("Lockbox");
  const source = readFileSync(join(__dirname, "../../../pipelines/apps/lockbox.yaml"), "utf8").replace(/^name: Lockbox$/m, `name: ${name}`);
  const created = await page.request.post("/api/apps", { data: { source } });
  expect(created.status(), await created.text()).toBe(201);
  const appId = ((await created.json()) as { appId: string }).appId;
  for (const project of ["Acme", "Globex"]) {
    const added = await page.request.post(`/api/apps/${appId}/pages/Project`, { data: { values: { name: project } } });
    expect(added.status(), await added.text()).toBe(201);
  }
  const globexPath = await page.request.post(`/api/apps/${appId}/pages/Path`, { data: { values: { project: "Globex", name: "/web" } } });
  expect(globexPath.status(), await globexPath.text()).toBe(201);

  // Acme's paths, added on its page.
  await page.goto(`/a/${appId}/Project/Acme`);
  const paths = page.getByTestId("related-Path");
  const entries = page.getByTestId("related-Entry");
  await expect(entries).toContainText("No path yet: add one first.");
  for (const path of ["/_backend", "/api"]) {
    await paths.getByTestId("related-add-Path").click();
    const form = page.getByTestId("related-form");
    await form.getByLabel("Name").fill(path);
    await form.getByRole("button", { name: "Add" }).click();
    await expect(paths.getByTestId("related-row").filter({ hasText: path })).toHaveCount(1);
  }

  // A group per path; production chosen above, Add secret in /api's: the kind, the path and the environment are set,
  // and only the secret's input is there.
  await expect(entries.getByTestId("related-group-label")).toHaveText([/^\/_backend/, /^\/api/]);
  await entries.getByTestId("related-filter-environment").selectOption("production");
  const api = entries.getByTestId("related-group").filter({ hasText: "/api" });
  await api.getByRole("button", { name: "Add secret" }).click();
  let form = page.getByTestId("related-form");
  await expect(form.getByLabel("Kind")).toHaveValue("secret");
  await expect(form.getByLabel("Kind")).toBeDisabled();
  await expect(form.getByTestId("ref-path")).toBeDisabled();
  await expect(form.getByTestId("ref-path").locator("option:checked")).toHaveText("/api");
  await expect(form.getByLabel("Environment")).toHaveValue("production");
  await expect(form.getByLabel("Value")).toHaveCount(0);
  await form.getByLabel("Name").fill("DATABASE_URL");
  await form.getByLabel("Secret").fill("postgres://made-up");
  await form.getByRole("button", { name: "Add" }).click();
  await expect(api.getByTestId("related-row")).toHaveCount(1);
  await expect(api).toContainText("DATABASE_URL");

  // Add variable in /_backend's: a value, no secret.
  const backend = entries.getByTestId("related-group").filter({ hasText: "/_backend" });
  await backend.getByRole("button", { name: "Add variable" }).click();
  form = page.getByTestId("related-form");
  await expect(form.getByLabel("Secret")).toHaveCount(0);
  await form.getByLabel("Name").fill("LOG_LEVEL");
  await form.getByLabel("Value").fill("info");
  await form.getByRole("button", { name: "Add" }).click();
  await expect(backend.getByTestId("related-row")).toHaveCount(1);

  // M57: a GitHub owner, its token a credential added from its form (GitHub's host set, the token's permissions shown).
  await page.goto(`/a/${appId}/GitHubOwner`);
  await page.getByTestId("add-entity").click();
  let owner = page.getByTestId("add-form");
  await owner.getByLabel("Name").fill("acme");
  await owner.getByLabel("Kind").selectOption("organization");
  await expect(owner).toContainText("Repository permissions, each Read and write");
  await owner.getByTestId("new-credential-token").click();
  const credential = page.getByTestId("credential-form");
  await expect(credential.getByTestId("credential-help")).toContainText("Fine-grained tokens");
  await credential.getByLabel("Name").fill(`acme-github-${Date.now().toString(36)}`);
  await credential.getByTestId("credential-secret").fill("github_pat_made_up_0123456789");
  await credential.getByRole("button", { name: "Store" }).click();
  await expect(credential).toHaveCount(0);
  owner = page.getByTestId("add-form");
  await expect(owner.getByLabel("Token").locator("option:checked")).toHaveText(/acme-github/);
  await owner.getByRole("button", { name: "Add" }).click();
  await expect(page.getByTestId("entity-fields")).toContainText("acme-github");
  await page.goto(`/a/${appId}/Project/Acme`);

  // A bundle: its paths picked in order (moved), its owner picked, an organization's fields only.
  await page.getByTestId("related-Bundle").getByTestId("related-add-Bundle").click();
  form = page.getByTestId("related-form");
  await form.getByLabel("Name").fill("acme production");
  await form.getByLabel("Environment").selectOption("production");
  await form.getByTestId("reflist-add-paths").selectOption({ label: "/api" });
  await form.getByTestId("reflist-add-paths").selectOption({ label: "/_backend" });
  await expect(form.getByTestId("reflist-add-paths").locator("option")).toHaveText(["All are picked"]);
  await form.getByRole("button", { name: "Move /_backend up" }).click();
  await expect(form.getByTestId("reflist-item")).toHaveText([/\/_backend/, /\/api/]);
  await expect(form.getByLabel("Repository")).toHaveCount(0);
  await form.getByLabel("Destination").selectOption("repository");
  await expect(form.getByLabel("Visibility")).toHaveCount(0);
  await expect(form).toContainText("github.com/acme/backend → backend");
  await form.getByLabel("Destination").selectOption("organization");
  await expect(form.getByLabel("Repository")).toHaveCount(0);
  await form.getByTestId("ref-owner").selectOption({ label: "acme" });
  await form.getByLabel("Visibility").selectOption("private");
  await form.getByRole("button", { name: "Add" }).click();
  await page.getByTestId("related-Bundle").getByRole("link", { name: "acme production" }).click();
  await expect(page.getByTestId("entity-fields")).toContainText("/_backend, /api");

  // On Entries: an entry's path is picked among its project's, by name.
  await page.goto(`/a/${appId}/Entry`);
  await expect(page.getByTestId("entity-row").filter({ hasText: "DATABASE_URL" })).toContainText("/api");
  await page.getByTestId("add-entity").click();
  const add = page.getByTestId("add-form");
  await expect(add.getByTestId("ref-path")).toBeDisabled();
  await add.getByTestId("ref-project").selectOption({ label: "Globex" });
  await expect(add.getByTestId("ref-path").locator("option")).toHaveText(["Choose one…", "/web"]);

  // Deleting Acme says what points at it.
  await page.goto(`/a/${appId}/Project/Acme`);
  await page.getByTestId("delete-entity").click();
  await expect(page.getByTestId("delete-referenced")).toContainText("2 Path");
});
