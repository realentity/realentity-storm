import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { unique } from "./support";

/** Type into a card's box and leave it: written into the YAML then. */
async function commit(page: Page, locator: ReturnType<Page["getByTestId"]>, value: string) {
  await locator.fill(value);
  await locator.blur();
}

async function yaml(page: Page): Promise<string> {
  await page.getByTestId("pipeline-tab-yaml").click();
  const source = await page.getByTestId("pipeline-source").inputValue();
  await page.getByTestId("pipeline-tab-cards").click();
  return source;
}

const card = (page: Page, id: string) => page.locator(`[data-testid="step-card"][data-step="${id}"]`);

async function addStep(page: Page, type: string) {
  await page.getByTestId("add-step").click();
  await page.getByTestId("step-search").fill(type);
  await page.locator(`[data-testid="pick-step"][data-type="${type}"]`).click();
}

// M36-T2, T3, T5: a pipeline built on cards: its trigger, steps from the catalog, their inputs as forms, problems on
// their card
test("a pipeline built on cards: trigger, steps, inputs, renames and problems where they are", async ({ page }) => {
  const name = unique("Cards");
  await page.goto("/pipelines/new");
  await commit(page, page.getByTestId("pipeline-name"), name);

  // On a schedule: weekdays at 07:30.
  await page.getByTestId("trigger-schedule").click();
  await page.getByTestId("day-Sun").click();
  await page.getByTestId("day-Sat").click();
  await commit(page, page.getByTestId("schedule-times"), "07:30");
  await expect(page.getByTestId("schedule-cron")).toHaveValue("30 7 * * 1-5");

  // The template's two steps go; email.fetch and notify.telegram come from the catalog.
  await card(page, "summary").getByTestId("remove-step").click();
  await addStep(page, "email.fetch");
  await card(page, "tell").getByTestId("remove-step").click();
  await addStep(page, "notify.telegram");
  await expect(page.getByTestId("step-card")).toHaveCount(2);

  // telegram needs its text: a problem on its card, and on its input.
  await expect(card(page, "telegram").getByTestId("card-issue")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("pipeline-tab-cards")).toContainText("1");

  // Its optional inputs are under More.
  await card(page, "fetch").getByTestId("more-inputs").click();
  await commit(page, card(page, "fetch").getByTestId("input-sinceDays"), "3");
  await commit(page, card(page, "fetch").getByTestId("step-id"), "mail");
  await commit(page, card(page, "telegram").getByTestId("input-text"), "New mail: {{mail.messages}}");
  await expect(card(page, "telegram").getByTestId("card-issue")).toHaveCount(0, { timeout: 10_000 });

  // Renaming a step renames what refers to it.
  await commit(page, card(page, "mail").getByTestId("step-id"), "inbox");
  await expect(card(page, "telegram").getByTestId("input-text")).toHaveValue("New mail: {{inbox.messages}}");
  await card(page, "telegram").getByTestId("step-options").click();
  await commit(page, card(page, "telegram").getByTestId("step-when"), "{{inbox.messages}}");

  expect(await yaml(page)).toBe(`name: ${name}
description: What it does, in a sentence
trigger: { schedule: "30 7 * * 1-5", tz: Europe/Sofia } # or { schedule: "0 8 * * 1-5", tz: Europe/Sofia }, { on: run.finished, pipeline: Jobs }, { webhook: hmac-sha256 }
steps:
  - id: inbox
    type: email.fetch
    with: { sinceDays: 3 }
  - id: telegram
    type: notify.telegram
    when: "{{inbox.messages}}"
    with: { text: "New mail: {{inbox.messages}}" }
`);

  // Undo puts back the last change; Save as v1 once it checks.
  await page.getByTestId("pipeline-undo").click();
  expect(await yaml(page)).not.toContain("when:");
  await page.getByTestId("check").click();
  await page.getByTestId("save").click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
});

// M36-E1: table-growth.yaml built from an empty pipeline on cards, without the YAML tab, and compiled the same
test("table-growth.yaml built on cards compiles the same as the template", async ({ page }) => {
  test.setTimeout(120_000);
  const appName = unique("Tables");
  const tables = readFileSync(resolve(__dirname, "../../../pipelines/apps/tables.yaml"), "utf8").replace(
    "name: Tables",
    `name: ${appName}`,
  );
  await page.request.post("/api/bundles", { data: { text: tables } });
  const template = readFileSync(resolve(__dirname, "../../../pipelines/table-growth.yaml"), "utf8")
    .replaceAll("\r\n", "\n")
    .replace("app: Tables", `app: ${appName}`);
  const name = unique("Table growth");

  await page.goto("/pipelines/new");
  await commit(page, page.getByTestId("pipeline-name"), name);
  await page.getByTestId("pipeline-app").selectOption(appName);
  await commit(
    page,
    page.getByLabel("The pipeline's description"),
    "Told when a table grows much faster than usual, and when it is back to normal.",
  );
  await page.getByTestId("trigger-schedule").click();
  await commit(page, page.getByTestId("schedule-cron"), "0 * * * *");

  const fill = async (id: string, input: string, value: string) => {
    const field = card(page, id).getByTestId(`input-${input}`);
    if (!(await field.isVisible())) await card(page, id).getByTestId("more-inputs").click();
    if ((await field.evaluate((e) => e.tagName)) === "SELECT") await field.selectOption(value);
    else await commit(page, field, value);
  };
  const add = async (type: string, id: string) => {
    await addStep(page, type);
    await commit(page, page.getByTestId("step-card").last().getByTestId("step-id"), id);
  };

  // The template's two steps go once there is another: a pipeline always has one.
  await add("db.query", "counts");
  await card(page, "summary").getByTestId("remove-step").click();
  await card(page, "tell").getByTestId("remove-step").click();
  await fill("counts", "connection", "{{cred:app-db}}");
  await fill("counts", "sql", "SELECT 'orders' AS name, count(*) AS rows FROM orders\nUNION ALL SELECT 'users', count(*) FROM users");
  await add("data.save", "latest");
  await fill("latest", "type", "Table");
  await fill("latest", "complete", "yes");
  // The data picker: counts' items.
  await card(page, "latest").locator('[data-input="items"]').getByTestId("data-picker").click();
  await page.locator('[data-testid="data-offer"][data-reference="{{counts.items}}"]').click();
  await add("data.history", "trend");
  await fill("trend", "items", "{{counts.items}}");
  await fill("trend", "collection", "table-rows");
  await fill("trend", "key", "name");
  await fill("trend", "value", "rows");
  await fill("trend", "keep", "168");
  await add("data.alert", "fast");
  await fill("fast", "items", "{{trend.items}}");
  await fill("fast", "key", "name");
  await fill("fast", "value", "history.vsUsual");
  await fill("fast", "above", "3");
  await fill("fast", "clearAt", "1.5");
  await add("notify.telegram", "tell");
  await fill("tell", "text", "Tables growing faster than usual (times their usual hourly growth):\n{{fast.text}}");
  await card(page, "tell").getByTestId("step-options").click();
  await card(page, "tell").locator('[data-testid="step-when"]').fill("{{fast.text}}");
  await card(page, "tell").locator('[data-testid="step-when"]').blur();
  await expect(page.getByTestId("pipeline-tab-cards")).not.toContainText(/\d/, { timeout: 10_000 });

  const built = await yaml(page);
  const compile = async (source: string) =>
    (
      (await (await page.request.post("/api/pipelines/compile", { data: { source } })).json()) as {
        result: { ok: boolean; definition: unknown };
      }
    ).result;
  const made = await compile(built);
  const expected = await compile(template.replace("name: Table growth", `name: ${name}`));
  expect([made.errors ?? [], built]).toEqual([[], built]);
  expect(made.definition).toEqual(expected.definition);
});

// M36-U1: every step of the catalog gets a form with each of its inputs
test("every step in the catalog gets a form with each of its inputs", async ({ page }) => {
  const steps = (await (await page.request.get("/api/steps")).json()) as {
    type: string;
    input: { properties?: Record<string, unknown> };
  }[];
  const source = `name: All steps\nsteps:\n${steps.map((s, i) => `  - id: s${i}\n    type: ${s.type}\n`).join("")}`;
  await page.goto("/pipelines/new");
  await page.getByTestId("pipeline-tab-yaml").click();
  await page.getByTestId("pipeline-source").fill(source);
  await page.getByTestId("pipeline-tab-cards").click();
  for (const [i, step] of steps.entries()) {
    const stepCard = card(page, `s${i}`);
    const more = stepCard.getByTestId("more-inputs");
    if (await more.isVisible()) await more.click();
    for (const input of Object.keys(step.input.properties ?? {})) {
      await expect(stepCard.locator(`[data-input="${input}"]`), `${step.type}.${input}`).toHaveCount(1);
    }
  }
});

// M37-T3, M37-I1: try up to a step: it stops there, shows what the step gave, and the cards after it pick from that
test("try up to a step: its output on its card, nothing after it, its fields in the picker", async ({ page }) => {
  await page.goto("/pipelines/new");
  await page.getByTestId("pipeline-tab-yaml").click();
  await page.getByTestId("pipeline-source").fill(`name: ${unique("Try")}
steps:
  - id: shape
    type: data.map
    with:
      from: [{ name: Ana, score: 3 }, { name: Bo, score: 5 }]
      expression: "$"
  - id: tell
    type: notify.telegram
    forEach: "{{shape.items}}"
    with: { text: "hello" }
`);
  await page.getByTestId("pipeline-tab-cards").click();

  // Before a try, shape's items are "a list of items": no fields to pick for each one.
  const picker = async () => {
    await card(page, "tell").getByRole("button", { name: "Data for text" }).click();
    const offered = await page.getByTestId("data-offer").evaluateAll((els) => els.map((el) => el.getAttribute("data-reference")));
    await card(page, "tell").getByRole("button", { name: "Data for text" }).click();
    return offered;
  };
  expect(await picker()).not.toContain("{{item.name}}");

  await card(page, "shape").getByTestId("try-here").click();
  await expect(card(page, "shape").getByTestId("step-output")).toContainText('"name": "Ana"', { timeout: 20_000 });
  await expect(page.getByTestId("dry-run-summary")).toHaveText("Tried up to shape: tell didn't run.");
  await expect(card(page, "tell").getByTestId("try-here-box")).toContainText("didn't reach it");
  await expect(card(page, "tell").getByTestId("step-output")).toHaveCount(0);

  // Now each item's fields, from what it really gave.
  expect(await picker()).toEqual(expect.arrayContaining(["{{item.name}}", "{{item.score}}"]));
});
