import { expect, test } from "@playwright/test";
import { createPipeline, unique } from "./support";

// M50-E1: a pipeline's needs filled on its page (a credential that fits, one added in place, a setting); switched on
// only then; the Credentials page says where each is used, and asks before deleting one in use.
test("a pipeline's needs: chosen on its page, one credential added in place, switched on only then; where each is used", async ({
  page,
}) => {
  const id = Date.now().toString(36);
  const host = `api.e2e-${id}.example`;
  const credential = async (name: string, kind: string, allowedHosts: string[], secret = `made-up-${id}`) => {
    const created = await page.request.post("/api/credentials", { data: { name, kind, allowedHosts, secret } });
    expect(created.status(), await created.text()).toBe(201);
  };
  // Two tokens fit its API: neither is chosen for it until the user does.
  await credential(`token-a-${id}`, "API_KEY", [host]);
  await credential(`token-b-${id}`, "API_KEY", [host]);
  const name = unique("Open issue");
  const pipeline = await createPipeline(
    page,
    `name: ${name}
trigger: { schedule: "0 9 * * 1" }
needs:
  api: { kind: credential, type: api_key, for: ${host}, label: "The tracker's API" }
  project: { kind: text, label: "Project", example: infra }
  database: { kind: credential, type: database, for: db-${id}.example.org, label: "The database it counts" }
steps:
  - id: count
    type: db.query
    with: { connection: "{{cred:database}}", sql: "SELECT 1 AS n" }
  - id: issue
    type: http.request
    with:
      method: POST
      url: "https://${host}/projects/{{setting.project}}/issues"
      headers: { Authorization: "Bearer {{cred:api}}" }
      body: { title: "Weekly" }
`,
  );

  await page.goto(`/pipelines/${pipeline.pipelineId}`);
  const needs = page.getByTestId("needs-card");
  await expect(needs.getByTestId("needs-missing")).toHaveText("3 to fill in");
  // Off until they are filled.
  await page.getByTestId("enable-pipeline").click();
  await expect(page.getByText(/Fill in "The tracker's API", "Project", "The database it counts" first/)).toBeVisible();

  await needs.getByTestId("need-credential-api").selectOption({ label: `token-b-${id}` });
  await needs.getByTestId("need-text-project").fill("infra");
  await needs.getByRole("button", { name: "Save Project" }).click();
  await expect(needs.getByTestId("needs-missing")).toHaveText("1 to fill in");

  // No database of the user's fits: added here, filled in from the slot, and chosen.
  await needs.getByTestId("need-credential-database").selectOption({ label: "Add a new one…" });
  const form = page.getByTestId("credential-form");
  await expect(form.getByLabel("Name", { exact: true })).toHaveValue("database");
  await form.getByLabel("Name", { exact: true }).fill(`orders-db-${id}`);
  await page.getByTestId("credential-secret").fill(`postgresql://reader:made-up@db-${id}.example.org:5432/orders`);
  await form.getByRole("button", { name: "Store" }).click();
  await expect(needs.getByTestId("needs-missing")).toHaveCount(0);
  await expect(needs.getByTestId("need-credential-database")).toHaveValue(/.+/);

  await page.getByTestId("enable-pipeline").click();
  await expect(page.getByTestId("enable-pipeline")).toBeChecked();

  // Where each is used; a delete that would empty a slot says so first.
  await page.goto("/credentials");
  await expect(page.getByTestId(`used-by-token-b-${id}`)).toContainText(name);
  await expect(page.getByTestId(`used-by-token-a-${id}`)).toHaveText("—");
  await page
    .getByTestId("credentials")
    .locator("tr", { hasText: `token-b-${id}` })
    .getByTitle("Delete")
    .click();
  await expect(page.getByTestId("delete-used-by")).toContainText(`${name} (api)`);
});

// M50-T12: a pipeline's own slot moved up to its App, filled once there for all its pipelines
test("a pipeline's own slot moved to its App: shown as the App's, set on the App's page", async ({ page }) => {
  const id = Date.now().toString(36);
  const app = unique("Status board");
  const created = await page.request.post("/api/apps", {
    data: { source: `name: ${app}\ntypes:\n  Check:\n    key: id\n    fields: { id: { type: text } }\n` },
  });
  expect(created.status(), await created.text()).toBe(201);
  const pipeline = await createPipeline(
    page,
    `name: ${unique("Status feed")}
app: ${app}
steps:
  - id: feed
    type: http.fetch
    with: { url: "https://status-${id}.example.org/feed", headers: { X-Key: "{{cred:status}}" } }
policy: { allowedDomains: [status-${id}.example.org] }
`,
  );
  await page.goto(`/pipelines/${pipeline.pipelineId}`);
  const needs = page.getByTestId("needs-card");
  await needs.getByTestId("need-to-app-status").click();
  await expect(page.getByText(`"status" is ${app}'s now`)).toBeVisible();
  await expect(needs.getByTestId("need-status")).toContainText("the App's");
  await expect(needs.getByTestId("need-to-app-status")).toHaveCount(0);
  await needs
    .getByTestId("need-status")
    .getByRole("link", { name: `set on ${app}` })
    .click();
  await expect(page.getByTestId("needs-card").getByTestId("need-credential-status")).toBeVisible();
});
