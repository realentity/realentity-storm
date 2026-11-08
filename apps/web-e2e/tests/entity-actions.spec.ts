import { expect, test } from "@playwright/test";
import { createPipeline, startRun, unique } from "./support";

// M32-E1: a comment on a job, a move to Favorite, then Apply starts its pipeline; a type of mine added by hand
test("an entity's form, stage and button; a type of mine added from its list", async ({ page }) => {
  const name = unique("Jobs");
  const label = `Jobs ${name.split(" ")[1]}`;
  const submit = unique("Job submit");
  const created = await page.request.post("/api/apps", {
    data: {
      source: `name: ${name}
types:
  Job:
    key: url
    title: title
    stages:
      field: status
      initial: new
      states: [new, favorite, applied]
      moves:
        - { from: new, to: [favorite] }
        - { from: favorite, to: [applied] }
    fields:
      url: { type: url, required: true }
      title: { type: text, required: true }
      comments: { type: longtext, mine: true }
  Company:
    mine: true
    key: name
    fields:
      name: { type: text, required: true }
      email: { type: email }
pages:
  - list: Job
    menu: { label: "${label}" }
  - view: Job
    actions:
      - { label: Apply, run: "${submit}", when: { status: favorite }, confirm: "Apply to this job?" }
`,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  await createPipeline(
    page,
    `name: ${submit}
app: ${name}
trigger: { on: entity.action, type: Job }
steps:
  - id: reply
    type: test.send
    with: { to: "me@example.org", body: "Applying to {{trigger.item.title}}: {{trigger.item.comments}}" }
`,
  );
  const collect = await createPipeline(
    page,
    `name: ${unique("Job collect")}
app: ${name}
steps:
  - id: save
    type: data.save
    with: { type: Job, items: [{ url: "https://jobs.example.org/1", title: "Staff engineer" }] }
`,
  );
  await startRun(page, collect.pipelineId);

  await page.goto("/inbox");
  await page.getByTestId("app-menu-item").filter({ hasText: label }).click();
  await expect(page.getByTestId("entity-row")).toHaveCount(1, { timeout: 20_000 });
  await page.getByRole("link", { name: "Staff engineer" }).click();

  // No Apply until it is a favorite.
  await expect(page.getByTestId("stage-value")).toHaveText("new");
  await expect(page.getByTestId("entity-action")).toHaveCount(0);
  await page.getByTestId("entity-form").getByLabel("Comments").fill("Great team");
  await page.getByTestId("entity-form").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("entity-fields")).toContainText("Great team");

  await page.getByTestId("stage-move").filter({ hasText: "favorite" }).click();
  await expect(page.getByTestId("stage-value")).toHaveText("favorite");
  await expect(page.getByTestId("stage-move")).toHaveText(["applied"]);

  await page.getByTestId("entity-action").filter({ hasText: "Apply" }).click();
  await expect(page.getByText("Apply to this job?")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/\/runs\//);
  await expect(page.getByText(submit).first()).toBeVisible();

  // A type of mine: added from its list, then deleted.
  const app = (await (await page.request.get("/api/apps")).json()) as { appId: string; name: string }[];
  const appId = app.find((a) => a.name === name)!.appId;
  await page.goto(`/a/${appId}/Company`);
  await page.getByTestId("add-entity").click();
  await page.getByTestId("add-form").getByLabel("Name").fill("Acme");
  await page.getByTestId("add-form").getByLabel("Email").fill("jobs@acme.example.org");
  await page.getByTestId("add-form").getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("heading", { name: "Acme" })).toBeVisible();
  await page.getByTestId("delete-entity").click();
  await page.getByTestId("confirm-delete").click();
  await expect(page.getByText("No company yet.")).toBeVisible();
});
