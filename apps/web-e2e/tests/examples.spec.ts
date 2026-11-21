import { expect, test } from "@playwright/test";

// M40-T2: the gallery: examples with what they need, installed as an App with its pipelines; twice, two of them
test("the examples gallery: the starter first, an example installed twice under names of its own", async ({ page }) => {
  await page.goto("/apps");
  const cards = page.getByTestId("example-card");
  await expect(cards.first()).toHaveAttribute("data-example", "releases-to-read");
  await expect(cards.first().getByTestId("example-needs")).toContainText("Nothing: it works as it is.");
  const tables = page.locator('[data-testid="example-card"][data-example="tables"]');
  // M50: chosen when it is installed, never "a credential named …".
  await expect(tables.getByTestId("example-slot")).toHaveText("You choose: The database whose tables it counts (a user that may only read)");

  // Its map, before installing.
  await tables.getByTestId("example-map").click();
  await expect(tables.getByTestId("app-map")).toContainText("Tables · Growth");

  const before = ((await (await page.request.get("/api/apps")).json()) as { name: string }[]).map((a) => a.name);
  const expected = before.includes("Tables") ? /^Tables \d+$/ : /^Tables$/;
  const installed = async () => {
    await page.waitForURL(/\/apps\/[0-9a-f-]{36}$/);
    return ((await (await page.request.get(`/api${new URL(page.url()).pathname}`)).json()) as { name: string }).name;
  };
  // Install asks first, saying what it adds; Cancel adds nothing.
  await tables.getByTestId("example-install").click();
  const summary = page.getByTestId("example-install-summary");
  await expect(summary).toContainText("Tables · Growth");
  await expect(summary).toContainText("Its pipelines start off");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(summary).toBeHidden();
  expect((await (await page.request.get("/api/apps")).json()) as unknown[]).toHaveLength(before.length);

  await tables.getByTestId("example-install").click();
  await page.getByTestId("example-install-confirm").click();
  expect(await installed()).toMatch(expected);

  // Installed: the card says so and opens it; installing again is a copy.
  await page.goto("/apps");
  const again = page.locator('[data-testid="example-card"][data-example="tables"]');
  await expect(again.getByTestId("example-installed")).toBeVisible();
  await expect(again.getByTestId("example-open")).toContainText("Open Tables");
  await expect(again.getByTestId("example-install")).toHaveText("Install a copy");
  await again.getByTestId("example-install").click();
  await expect(page.getByTestId("example-install-copy")).toContainText("this installs a second one");
  await page.getByTestId("example-install-confirm").click();
  expect(await installed()).toMatch(/^Tables \d+$/);
  const pipelines = ((await (await page.request.get("/api/pipelines")).json()) as { name: string }[]).map((p) => p.name);
  expect(pipelines.filter((n) => n.includes("· Growth")).length).toBeGreaterThanOrEqual(2);
});

// M40-E1: the starter installed from the gallery, its pipeline run, its entities on its page, its checklist done
test("the starter: installed, tried, switched on and run; its releases on its page, its checklist gone", async ({ page }) => {
  await page.goto("/apps");
  await page.locator('[data-testid="example-card"][data-example="releases-to-read"]').getByTestId("example-install").click();
  await page.getByTestId("example-install-confirm").click();
  await page.waitForURL(/\/apps\/[0-9a-f-]{36}$/);
  const appUrl = page.url();
  const appId = new URL(appUrl).pathname.split("/").pop()!;

  // Installed off: the page says its pipeline doesn't run by itself yet, and its tile on Home marks the App.
  const tile = page.locator(`[data-testid="app-tile"][href^="/a/${appId}/"]`);
  await expect(page.getByTestId("pipelines-off").getByTestId("pipeline-off")).toHaveCount(1);
  await page.goto("/");
  await expect(tile.getByTestId("app-nothing-on")).toBeVisible();
  await page.goto(appUrl);

  // Needs nothing: what is left is its pipeline, tried and switched on.
  const checklist = page.getByTestId("example-checklist");
  await expect(checklist.getByTestId("checklist-item")).toHaveCount(2);
  await expect(checklist).toContainText("2 of 2 left");

  // Tried: a dry run, which saves nothing.
  await checklist.getByTestId("checklist-item").first().getByRole("link", { name: "Do it" }).click();
  await page.waitForURL(/\/pipelines\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "Dry run" }).click();
  await expect(page.getByText("DONE").first()).toBeVisible({ timeout: 20_000 });
  await page.goto(appUrl);
  await expect(checklist).toContainText("1 of 2 left");

  // Switched on.
  await checklist.getByTestId("checklist-item").last().getByRole("link", { name: "Do it" }).click();
  await page.getByTestId("enable-pipeline").click();
  await page.getByTestId("confirm-enable").click();
  await expect(page.getByTestId("enable-pipeline")).toBeChecked();
  await page.goto(appUrl);
  await expect(page.getByTestId("example-checklist")).toHaveCount(0);
  await expect(page.getByTestId("pipelines-off")).toHaveCount(0);
  await page.goto("/");
  await expect(tile).toBeVisible();
  await expect(tile.getByTestId("app-nothing-on")).toHaveCount(0);

  // Run from its list's button: its releases there, new, to mark read.
  await page.goto(`/a/${appId}/Release`);
  await expect(page.getByTestId("entity-row")).toHaveCount(0);
  await page.getByRole("button", { name: "Check now" }).click();
  await page.waitForURL(/\/runs\//);
  await expect(page.getByText("DONE").first()).toBeVisible({ timeout: 20_000 });
  await page.goto(`/a/${appId}/Release`);
  await expect(page.getByTestId("entity-row")).toHaveCount(2);
  await expect(page.getByTestId("entity-row").first()).toContainText("new");
  await page.getByTestId("entity-row").first().getByRole("button", { name: "read" }).click();
  await expect(page.getByTestId("entity-row").first()).toContainText("read");

  // The pipelines list by App: found by the App's name, under its heading, which opens it.
  const appName = ((await (await page.request.get(`/api/apps/${appId}`)).json()) as { name: string }).name;
  await page.goto("/pipelines");
  await page.getByTestId("pipelines-search").fill(appName);
  const heading = page.locator(`[data-testid="pipelines-group"]:has(a[href="/apps/${appId}"])`);
  await expect(heading).toContainText("1");
  await expect(page.getByTestId("pipeline-row").first()).toBeVisible();
  await page.getByTestId("pipelines-search").fill("no pipeline is called like this");
  await expect(page.getByTestId("pipeline-row")).toHaveCount(0);
});

// M48-E1: Tasks, Memos and Papers installed from the gallery; a task, a memo and a paper added by hand
test("Tasks, Memos and Papers: installed from the gallery, one of each added on its page", async ({ page }) => {
  const install = async (id: string) => {
    await page.goto("/apps");
    await page.locator(`[data-testid="example-card"][data-example="${id}"]`).getByTestId("example-install").click();
    await page.getByTestId("example-install-confirm").click();
    await page.waitForURL(/\/apps\/[0-9a-f-]{36}$/);
    return new URL(page.url()).pathname.split("/").pop()!;
  };
  const add = async (appId: string, type: string, fill: (form: ReturnType<typeof page.getByTestId>) => Promise<void>, title: string) => {
    await page.goto(`/a/${appId}/${type}`);
    await page.getByTestId("add-entity").click();
    const form = page.getByTestId("add-form");
    await fill(form);
    await form.getByRole("button", { name: "Add" }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    // Its key was made by Storm: the page's address ends with it.
    expect(page.url()).toMatch(new RegExp(`/a/${appId}/${type}/[a-z0-9]{12}$`));
  };

  const tasks = await install("tasks");
  await add(
    tasks,
    "Task",
    async (form) => {
      await form.getByLabel("Title").fill("Renew the passport");
      await form.getByLabel("Due").fill("2026-12-01");
      await form.getByLabel("Tag").selectOption("errands");
    },
    "Renew the passport",
  );
  await page.getByTestId("stage-move").filter({ hasText: "done" }).click();
  await expect(page.getByTestId("stage-value")).toHaveText("done");

  const memos = await install("memos");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await add(
    memos,
    "Memo",
    async (form) => {
      await form.getByLabel("Title").fill("Wi-Fi at the cottage");
      await form.getByLabel("Text").fill("Network: Cottage, password on the router's back.");
      await form.getByLabel("Photo").setInputFiles({ name: "router.png", mimeType: "image/png", buffer: png });
      await expect(form.getByTestId("file-photo").getByRole("link", { name: "router.png" })).toBeVisible();
    },
    "Wi-Fi at the cottage",
  );

  const papers = await install("papers");
  await add(
    papers,
    "Paper",
    async (form) => {
      await form.getByLabel("Title").fill("Washing machine");
      await form.getByLabel("Document").setInputFiles({ name: "receipt.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% a receipt\n%%EOF\n") });
      await expect(form.getByTestId("file-document").getByRole("link", { name: "receipt.pdf" })).toBeVisible();
      await form.getByLabel("Warranty until").fill("2028-11-10");
    },
    "Washing machine",
  );
  await expect(page.getByTestId("entity-fields").last()).toContainText("receipt.pdf");
});
