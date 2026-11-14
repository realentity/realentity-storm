import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

// M45-E1: a type pipelines write, added by hand too; a field set over the pipeline's, then reset; deleted
test("an entity added by hand next to a pipeline's; a field set over the pipeline's and reset", async ({ page }) => {
  const name = unique("Tasks");
  const created = await page.request.post("/api/apps", {
    data: {
      source: `name: ${name}
types:
  Task:
    key: title
    fields:
      title: { type: text, required: true }
      tag: { type: enum, values: [home, work] }
      due: { type: date }
pages:
  - list: Task
    add: true
  - form: Task
    fields: [tag, due]
`,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const appId = ((await created.json()) as { appId: string }).appId;
  const collect = await createPipeline(
    page,
    `name: ${unique("Task collect")}
app: ${name}
steps:
  - id: save
    type: data.save
    with: { type: Task, items: [{ title: "Water the plants", tag: home }] }
`,
  );
  await startRun(page, collect.pipelineId);

  await page.goto(`/a/${appId}/Task`);
  await expect(page.getByTestId("entity-row")).toHaveCount(1, { timeout: 20_000 });
  await page.getByTestId("add-entity").click();
  await page.getByTestId("add-form").getByLabel("Title").fill("Renew the passport");
  await page.getByTestId("add-form").getByLabel("Tag").selectOption("work");
  await page.getByTestId("add-form").getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("heading", { name: "Renew the passport" })).toBeVisible();
  await page.getByTestId("delete-entity").click();
  await page.getByTestId("confirm-delete").click();
  await expect(page.getByTestId("entity-row")).toHaveCount(1);

  // The pipeline's task: the form shows its tag; set over it, then reset to it.
  await page.getByRole("link", { name: "Water the plants" }).click();
  const form = page.getByTestId("entity-form");
  await expect(form.getByLabel("Tag")).toHaveValue("home");
  await form.getByLabel("Tag").selectOption("work");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("entity-fields")).toContainText("work");
  await expect(page.getByTestId("written-tag")).toContainText("home");
  await page.getByTestId("reset-tag").click();
  await expect(page.getByTestId("written-tag")).toHaveCount(0);
  await expect(form.getByLabel("Tag")).toHaveValue("home");
  await expect(page.getByTestId("entity-fields")).toContainText("home");
});

// M46-E1: an image and a file uploaded on the form; the image's thumbnail on the list and the page, the file a link
test("an image and a file on an App's form: a thumbnail on the list and the page, the file a download", async ({ page }) => {
  const name = unique("Papers");
  const created = await page.request.post("/api/apps", {
    data: {
      source: `name: ${name}
types:
  Paper:
    key: title
    fields:
      title: { type: text, required: true }
      scan: { type: image }
      receipt: { type: file }
pages:
  - list: Paper
    add: true
    columns: [scan, title, receipt]
  - form: Paper
    fields: [scan, receipt]
`,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const appId = ((await created.json()) as { appId: string }).appId;
  // A 1×1 PNG and a small PDF, made up.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const pdf = Buffer.from("%PDF-1.4\n% a receipt\n%%EOF\n");

  await page.goto(`/a/${appId}/Paper`);
  await page.getByTestId("add-entity").click();
  const form = page.getByTestId("add-form");
  await form.getByLabel("Title").fill("Washing machine");
  await form.getByLabel("Scan").setInputFiles({ name: "warranty.png", mimeType: "image/png", buffer: png });
  await expect(page.getByTestId("file-scan").getByRole("link", { name: "warranty.png" })).toBeVisible();
  await form.getByLabel("Receipt").setInputFiles({ name: "receipt.pdf", mimeType: "application/pdf", buffer: pdf });
  await expect(page.getByTestId("file-receipt").getByRole("link", { name: "receipt.pdf" })).toBeVisible();
  await form.getByRole("button", { name: "Add" }).click();

  await expect(page.getByRole("heading", { name: "Washing machine" })).toBeVisible();
  const image = page.getByTestId("entity-fields").getByTestId("entity-image").locator("img");
  await expect(image).toHaveAttribute("alt", "warranty.png");
  // Lazy-loaded: in view, then loaded (slower when the whole suite runs).
  await image.scrollIntoViewIfNeeded();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), { timeout: 15_000 }).toBe(1);
  await expect(page.getByTestId("entity-fields").getByTestId("entity-file")).toHaveText("receipt.pdf");
  const download = page.waitForEvent("download");
  await page.getByTestId("entity-fields").getByTestId("entity-file").click();
  expect((await download).suggestedFilename()).toBe("receipt.pdf");

  // Removed on the form: gone from the page.
  await page.getByTestId("file-receipt").getByRole("button", { name: "Remove Receipt" }).click();
  await page.getByTestId("entity-form").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("entity-fields").getByTestId("entity-file")).toHaveCount(0);

  await page.goto(`/a/${appId}/Paper`);
  await expect(page.getByTestId("entity-row").getByTestId("entity-image")).toHaveCount(1);
});

// M47-E1: a monitor added on its list, checked by the button; its status, response time chart and incident
test("Server ops: a monitor added on its form, checked by Check now: its status, chart and incident", async ({ page }) => {
  const read = (file: string) => readFileSync(join(__dirname, "../../../pipelines", file), "utf8");
  const name = unique("Server ops");
  const checks = unique("Check monitors");
  const app = read("apps/server-ops.yaml").replace("name: Server ops", `name: ${name}`).replace("run: Check monitors }", `run: "${checks}" }`);
  const created = await page.request.post("/api/apps", { data: { source: app } });
  expect(created.status(), await created.text()).toBe(201);
  const appId = ((await created.json()) as { appId: string }).appId;
  await createPipeline(page, read("check-monitors.yaml").replace("name: Check monitors", `name: ${checks}`).replace("app: Server ops", `app: ${name}`));

  await page.goto(`/a/${appId}/Monitor`);
  for (const [monitor, url] of [
    ["nas", "https://nas.home.example:5001/"],
    ["shop", "https://down.shop.example/"],
  ]) {
    await page.getByTestId("add-entity").click();
    const form = page.getByTestId("add-form");
    await form.getByLabel("Name").fill(monitor);
    await form.getByLabel("Kind").selectOption("http");
    await form.getByLabel("Address").fill(url);
    await form.getByRole("button", { name: "Add" }).click();
    await expect(page.getByRole("heading", { name: monitor })).toBeVisible();
    await page.goto(`/a/${appId}/Monitor`);
  }

  await page.getByTestId("entity-action").filter({ hasText: "Check now" }).click();
  await expect(page).toHaveURL(/\/runs\//);
  await expect(page.getByTestId("run-status")).toContainText("done", { timeout: 30_000 });

  await page.goto(`/a/${appId}/Monitor`);
  const row = (monitor: string) => page.getByTestId("entity-row").filter({ hasText: monitor });
  await expect(row("nas")).toContainText("up");
  await expect(row("nas")).toContainText("42");
  await expect(row("shop")).toContainText("down");
  await row("nas").getByRole("link", { name: "nas", exact: true }).click();
  await expect(page.getByTestId("entity-fields").first()).toContainText("31 Jan 2027");
  await expect(page.getByRole("heading", { name: "Response time (ms)" })).toBeVisible();

  await page.goto(`/a/${appId}/Incident`);
  await expect(page.getByTestId("entity-row")).toHaveCount(1);
  await expect(page.getByTestId("entity-row")).toContainText("shop is down");
});
