import { checkAppSource, listPageOf, viewPageOf } from "@realentity/storm-shared";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPipeline, startRun, unique } from "./support";

/** Type into a designer box and leave it: the designer writes it into the YAML then. */
async function commit(page: Page, testId: string, value: string, nth = 0) {
  const box = page.getByTestId(testId).nth(nth);
  await box.fill(value);
  await box.press("Enter");
}

async function yaml(page: Page): Promise<string> {
  await page.getByTestId("tab-yaml").click();
  const source = await page.getByTestId("app-source").inputValue();
  await page.getByTestId("tab-types").click();
  return source;
}

// M35-T2: an App's types built in the table, without writing YAML
test("the designer builds a type in its table: fields, kinds, key, renames and Undo", async ({ page }) => {
  const name = unique("Disks");
  await page.goto("/apps/new");
  await page.getByTestId("start-empty").click();
  await commit(page, "app-name", name);
  await page.getByTestId("app-icon").click();
  await page.locator('[data-testid="icon-option"][data-icon="cpu"]').click();

  // The empty App's Item becomes Disk; its name field becomes id.
  await commit(page, "type-name", "Disk");
  await commit(page, "field-name", "id");
  await expect(page.getByTestId("type-key")).toHaveValue("id");

  const add = async (field: string, kind: string) => {
    await page.getByTestId("new-field-name").fill(field);
    await page.getByTestId("new-field-kind").selectOption(kind);
    await page.getByTestId("add-field").click();
    await expect(page.getByTestId("field-name").last()).toHaveValue(field);
  };
  await add("title", "text");
  await add("price", "money");
  await add("currency", "text");
  await add("kind", "enum");
  await add("wanted", "yesno");
  await add("notes", "longtext");

  const row = (field: string) => page.getByTestId("field-row").filter({ has: page.locator(`input[value="${field}"]`) });
  await row("price").getByTestId("field-currency").selectOption("currency");
  await row("kind").getByTestId("field-values").fill("hdd, ssd");
  await row("kind").getByTestId("field-values").press("Enter");
  await row("wanted").getByTestId("field-mine").check();
  await row("title").getByTestId("field-required").check();
  await page.getByTestId("type-title").selectOption("title");
  await row("notes").getByTestId("remove-field").click();
  await expect(row("notes")).toHaveCount(0);
  await page.getByTestId("undo").click();
  await expect(row("notes")).toHaveCount(1);
  await row("notes").getByTestId("remove-field").click();

  await expect(page.getByTestId("app-check")).toContainText("No problems");
  expect(await yaml(page)).toBe(`name: ${name}
icon: cpu
types:
  Disk:
    key: id
    title: title
    fields:
      id: { type: text, required: true }
      title: { type: text, required: true }
      price: { type: money, currency: currency }
      currency: { type: text }
      kind: { type: enum, values: [hdd, ssd] }
      wanted: { type: yesno, mine: true }
`);

  // A money field's currency that is no longer text is a problem on its row, before Save.
  await row("currency").getByTestId("field-kind").selectOption("number");
  await expect(row("price")).toContainText('"currency" is not a text field of this type');
  await expect(page.getByTestId("tab-types")).toContainText("1");
  await page.getByTestId("undo").click();
  await expect(page.getByTestId("app-check")).toContainText("No problems");

  await page.getByTestId("save-app").click();
  // Saved: its own page (the editor shows the name before the save is done).
  await page.waitForURL(/\/apps\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name })).toBeVisible();
});

test("the designer leaves the types alone while the YAML has errors", async ({ page }) => {
  await page.goto("/apps/new");
  await page.getByTestId("start-empty").click();
  await page.getByTestId("tab-yaml").click();
  await page.getByTestId("app-source").fill("name: Broken\ntypes:\n  Item: { key: name\n");
  await page.getByTestId("tab-types").click();
  await expect(page.getByTestId("types-tab")).toContainText("fix them on the YAML tab");
  await expect(page.getByTestId("add-field")).toHaveCount(0);
});

/** Drag on the diagram from one state's box to another's: a move made by the user. */
async function drawMove(page: Page, from: string, to: string, nth = 0) {
  const diagram = page.getByTestId("designer-stages").nth(nth);
  const a = await diagram.locator(`[data-testid="stage-box"][data-state="${from}"]`).boundingBox();
  const b = await diagram.locator(`[data-testid="stage-box"][data-state="${to}"]`).boundingBox();
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2);
  await page.mouse.down();
  await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2, { steps: 5 });
  await page.mouse.up();
}

/** A page's field list down to these, by removing the others (their order as they were). */
async function keepOnly(chips: Locator, keep: string[]) {
  for (;;) {
    const fields = await chips.getByTestId("chip").evaluateAll((els) => els.map((el) => el.getAttribute("data-field") ?? ""));
    const extra = fields.find((f) => !keep.includes(f));
    if (!extra) break;
    await chips
      .locator(`[data-testid="chip"][data-field="${extra}"]`)
      .getByRole("button", { name: /^Remove / })
      .click();
    await expect(chips.locator(`[data-testid="chip"][data-field="${extra}"]`)).toHaveCount(0);
  }
  expect(await chips.getByTestId("chip").evaluateAll((els) => els.map((el) => el.getAttribute("data-field")))).toEqual(keep);
}

const move = (page: Page, from: string, to: string) => page.locator(`[data-testid="stage-move"][data-from="${from}"][data-to="${to}"]`);

// M35-T3: stages on the diagram
test("the stages diagram: states, a move drawn, who makes it, a state renamed everywhere", async ({ page }) => {
  await page.goto("/apps/new");
  await page.getByTestId("start-empty").click();
  await page.getByTestId("tab-stages").click();
  await page.getByTestId("add-stages").click();
  await expect(move(page, "new", "done")).toHaveAttribute("data-by", "me");

  await page.getByTestId("new-state").fill("waiting");
  await page.getByTestId("add-state").click();
  await drawMove(page, "done", "waiting");
  await expect(move(page, "done", "waiting")).toHaveAttribute("data-by", "me");
  await expect(page.getByTestId("selected-move")).toContainText("done → waiting");
  await page.getByTestId("move-by-pipeline").check();
  await expect(move(page, "done", "waiting")).toHaveAttribute("data-by", "me,pipeline");
  await page.getByTestId("move-by-me").uncheck();
  await expect(move(page, "done", "waiting")).toHaveAttribute("data-by", "pipeline");

  // The same, from the keyboard.
  await page.getByTestId("move-from").selectOption("waiting");
  await page.getByTestId("move-to").selectOption("new");
  await page.getByTestId("add-move").click();
  await expect(move(page, "waiting", "new")).toHaveAttribute("data-by", "me");
  await page.getByTestId("remove-move").click();
  await expect(move(page, "waiting", "new")).toHaveCount(0);

  await commit(page, "state-name", "open", 0);
  await expect(move(page, "open", "done")).toHaveCount(1);
  await page.getByTestId("state-initial").nth(2).click();
  await expect(page.getByTestId("app-check")).toContainText("No problems");
  const source = await yaml(page);
  expect(source).toContain(`    stages:
      field: status
      initial: waiting
      states: [open, done, waiting]
      moves:
        - { from: open, to: [done] }
        - { from: done, to: [waiting], by: [pipeline] }
    fields:
`);
});

// M35-E1, M37-E1: the Bills App's types, stages and pages made in the designer from empty, without the YAML tab
test("the Bills App made in the designer, as pipelines/apps/bills.yaml has it", async ({ page }) => {
  const bills = readFileSync(resolve(__dirname, "../../../pipelines/apps/bills.yaml"), "utf8");
  const name = unique("Bills");
  await page.goto("/apps/new");
  await page.getByTestId("start-empty").click();
  await commit(page, "app-name", name);
  await page.getByTestId("app-icon").click();
  await page.locator('[data-testid="icon-option"][data-icon="receipt"]').click();
  await commit(page, "app-description", "Bills from email, by month, paid or not");
  await commit(page, "type-name", "Bill");
  await commit(page, "field-name", "billKey");

  const row = (field: string) => page.getByTestId("field-row").filter({ has: page.locator(`input[value="${field}"]`) });
  const add = async (field: string, kind: string, label?: string) => {
    await page.getByTestId("new-field-name").fill(field);
    await page.getByTestId("new-field-kind").selectOption(kind);
    await page.getByTestId("add-field").click();
    await expect(row(field)).toHaveCount(1);
    if (label) {
      await row(field).getByLabel(`Bill.${field}'s label`).fill(label);
      await row(field).getByLabel(`Bill.${field}'s label`).press("Enter");
    }
  };
  await row("billKey").getByLabel("Bill.billKey's label").fill("Bill");
  await row("billKey").getByLabel("Bill.billKey's label").press("Enter");
  await add("issuer", "text");
  await add("issuerKey", "text", "Sender");
  await add("amount", "money");
  await add("currency", "text");
  await add("dueDate", "date", "Due");
  await add("month", "date");
  await add("period", "text");
  await add("reference", "text");
  await add("from", "email");
  await add("subject", "text");
  await add("messageId", "text");
  await row("issuer").getByTestId("field-required").check();
  await row("amount").getByTestId("field-required").check();
  await row("amount").getByTestId("field-currency").selectOption("currency");
  await page.getByTestId("type-title").selectOption("issuer");

  await page.getByTestId("tab-stages").click();
  await page.getByTestId("add-stages").click();
  await commit(page, "state-name", "due", 0);
  await commit(page, "state-name", "paid", 1);
  await drawMove(page, "paid", "due");
  await expect(page.getByTestId("app-check")).toContainText("No problems");

  // M37-T1: its pages, from their defaults.
  await page.getByTestId("tab-pages").click();
  const list = page.getByTestId("type-pages").filter({ hasText: "Bill" }).getByTestId("page-list");
  await expect(list.getByTestId("page-is-default")).toBeVisible();
  await commit(page, "page-menu-label", "Bills");
  await expect(list.getByTestId("page-default")).toBeVisible();
  await list.getByLabel("Bill's icon in the menu").selectOption("receipt");
  const columns = list.getByTestId("page-columns");
  await keepOnly(columns, ["issuer", "amount", "dueDate"]);
  for (const field of ["reference", "status"]) await columns.getByTestId("page-columns-add").selectOption(field);
  await list.getByTestId("page-due-field").selectOption("dueDate");
  await list.getByTestId("page-due-unless").selectOption("status=paid");
  await list.getByTestId("page-sort").selectOption("dueDate");
  await list.getByTestId("page-sort-order").selectOption("asc");
  await list.getByTestId("page-group").selectOption("month");
  await list.getByTestId("page-group-period").selectOption("month");
  await list.getByTestId("page-totals").locator('[data-field="amount"]').check();
  await list.getByTestId("when-total-when").selectOption("status=due");
  await list.getByTestId("when-total-label").fill("Unpaid");
  await list.getByTestId("when-total-add").click();
  await expect(list.getByTestId("when-total")).toContainText("Unpaid");
  await list.getByTestId("page-moves").check();

  const view = page.getByTestId("type-pages").filter({ hasText: "Bill" }).getByTestId("page-view");
  await view.getByTestId("add-section").click();
  await keepOnly(view.getByTestId("page-section-fields").first(), ["issuer", "amount", "dueDate", "period", "reference"]);
  await view.getByTestId("add-section").click();
  await commit(page, "page-section-title", "Email", 1);
  const email = view.getByTestId("page-section-fields").nth(1);
  for (const field of ["from", "subject"]) await email.getByTestId("page-section-fields-add").selectOption(field);
  await keepOnly(email, ["from", "subject"]);
  await expect(page.getByTestId("app-check")).toContainText("No problems");

  const made = checkAppSource(await yaml(page));
  const template = checkAppSource(bills);
  expect(made.errors).toEqual([]);
  expect(made.definition!.types).toEqual(template.definition!.types);
  expect(made.definition!.icon).toBe("receipt");
  expect(listPageOf(made.definition!, "Bill")).toEqual(listPageOf(template.definition!, "Bill"));
  expect(viewPageOf(made.definition!, "Bill")).toEqual(viewPageOf(template.definition!, "Bill"));

  await page.getByTestId("save-app").click();
  // Saved: its own page (the editor shows the name before the save is done).
  await page.waitForURL(/\/apps\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name })).toBeVisible();
});

// M35-T4: a type from a pasted sample, its fields kept or left out, into a new type and into one that is there
test("a type from a pasted sample: rows kept, renamed, into a new type and an existing one", async ({ page }) => {
  await page.goto("/apps/new");
  await page.getByTestId("start-empty").click();
  const sample = JSON.stringify({
    results: [
      { id: "a1", name: "WD Purple 8TB", price: 399, currency: "BGN", tracking: "x1" },
      { id: "a2", name: "Seagate SkyHawk 8TB", price: 419.5, currency: "BGN", tracking: "x2" },
    ],
  });
  await page.getByTestId("draft-sample").fill(sample);
  await page.getByTestId("draft-sample-go").click();
  const draftRow = (field: string) => page.getByTestId("draft-row").filter({ has: page.locator(`input[value="${field}"]`) });
  await expect(draftRow("price").getByTestId("draft-kind")).toContainText("money");
  await expect(draftRow("name")).toContainText("WD Purple 8TB");
  await draftRow("tracking").getByTestId("draft-keep").uncheck();
  await draftRow("name").getByLabel("Name for name").fill("title");
  await page.getByTestId("draft-type-name").fill("Disk");
  await page.getByTestId("add-type").click();
  await expect(page.getByTestId("type-name").last()).toHaveValue("Disk");
  await expect(page.getByTestId("app-check")).toContainText("No problems");
  const source = await yaml(page);
  expect(source).toContain("  Disk:\n    key: id\n");
  expect(source).toContain("      title: { type: text, required: true }\n");
  expect(source).toContain("      price: { type: money, required: true, currency: currency }\n");
  expect(source).not.toContain("tracking");

  // The same sample into Item: only what it doesn't have.
  await page.getByTestId("draft-sample-go").click();
  await page.getByTestId("draft-into").selectOption("Item");
  await page.getByTestId("add-type").click();
  expect(await yaml(page)).toContain("      name: { type: text, required: true }\n      id: { type: text, required: true }\n");
});

// M35-T5: an App with its pipeline imported from a file, checked first; exported back
test("imports an App with its pipeline from a YAML file, and exports it back", async ({ page }) => {
  const name = unique("Shelf");
  const app = `# books on the shelf
name: ${name}
icon: book
types:
  Book:
    key: isbn
    fields:
      isbn: { type: text, required: true }
      title: { type: text }
`;
  const pipeline = (pipelineName: string) => `name: ${pipelineName}
app: ${name}
steps:
  - id: save
    type: data.save
    with:
      type: Book
      items:
        - { isbn: "978-0", title: Dune }
`;
  const pipelineName = unique("Shelf books");
  await page.goto("/apps");
  await page.getByTestId("import-yaml").click();

  // A broken one first: said on its line, nothing to import.
  await page.getByTestId("import-text").fill(`${app}---\n${pipeline(pipelineName).replace("type: Book", "type: Novel")}`);
  await expect(page.getByTestId("import-check")).toContainText("Novel");
  await expect(page.getByTestId("import-check")).toContainText("Line 11:");
  await expect(page.getByTestId("import-save")).toBeDisabled();

  await page
    .getByTestId("import-file")
    .setInputFiles({ name: "shelf.yaml", mimeType: "application/yaml", buffer: Buffer.from(`${app}---\n${pipeline(pipelineName)}`) });
  await expect(page.getByTestId("import-item")).toHaveCount(2);
  await expect(page.getByTestId("import-item").first()).toContainText("new");
  await page.getByTestId("import-save").click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByRole("link", { name: pipelineName })).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByTestId("export-yaml").click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^shelf-.*\.yaml$/);
  const text = readFileSync(await file.path(), "utf8");
  expect(text.startsWith(`${app}---\n`)).toBe(true);
  expect(text).toContain(`name: ${pipelineName}`);

  // Imported again: the same, nothing to do.
  await page.goto("/pipelines");
  await page.getByTestId("import-yaml").click();
  await page.getByTestId("import-text").fill(text);
  await expect(page.getByTestId("import-check")).toContainText("Everything in it is as you have it already");
  await expect(page.getByTestId("import-save")).toBeDisabled();
});

// M37-E2: the preview is the page saved: what is dragged and clicked on it is on the App's list after Save
test("the page's preview, with its entities: a column dragged, a sort and a group clicked, as saved", async ({ page }) => {
  const name = unique("Drives");
  const app = `name: ${name}
types:
  Drive:
    key: id
    title: name
    fields:
      id: { type: text, required: true }
      name: { type: text, required: true }
      brand: { type: enum, values: [WD, Seagate] }
      size: { type: number }
`;
  // Before it has any: made-up ones.
  await page.goto("/apps/new");
  await page.getByTestId("start-empty").click();
  await page.getByTestId("tab-yaml").click();
  await page.getByTestId("app-source").fill(app);
  await page.getByTestId("tab-pages").click();
  await expect(page.getByTestId("preview-sample")).toBeVisible();
  await page.getByTestId("save-app").click();
  await page.waitForURL(/\/apps\/[0-9a-f-]{36}$/);
  const appId = page.url().split("/apps/")[1];

  const pipeline = await createPipeline(
    page,
    `name: ${unique("Drives in")}
app: ${name}
steps:
  - id: save
    type: data.save
    with:
      type: Drive
      items:
        - { id: a, name: Purple, brand: WD, size: 8 }
        - { id: b, name: SkyHawk, brand: Seagate, size: 12 }
        - { id: c, name: Red, brand: WD, size: 4 }
`,
  );
  const run = await startRun(page, pipeline.pipelineId);
  await page.goto(`/runs/${run.runId}`);
  await expect(page.getByText("DONE").first()).toBeVisible({ timeout: 20_000 });

  await page.goto(`/apps/${appId}/edit`);
  await page.getByTestId("tab-pages").click();
  const preview = page.getByTestId("page-preview");
  await expect(preview.getByTestId("entity-row")).toHaveCount(3);
  const heading = (field: string) => preview.locator(`[data-testid="list-heading"][data-field="${field}"]`);
  const headings = () => preview.getByTestId("list-heading").evaluateAll((els) => els.map((el) => el.getAttribute("data-field")));

  // By default: its title, its required fields, the rest that fit. size dragged before name; sorted by it (a number: highest first); in groups by brand.
  await heading("size").dragTo(heading("name"));
  await expect.poll(headings).toEqual(["size", "name", "id", "brand"]);
  await heading("size").getByTestId("heading-sort").click();
  await expect(preview.getByTestId("entity-row").first()).toContainText("SkyHawk");
  await heading("brand").getByTestId("heading-group").click();
  await expect(preview.getByTestId("entity-group")).toHaveCount(2);
  await expect(preview.getByTestId("entity-group").first()).toContainText("WD");
  await page.getByTestId("tab-yaml").click();
  const source = await page.getByTestId("app-source").inputValue();
  expect(source).toContain("pages:\n  - list: Drive\n    columns: [size, name, id, brand]\n    sort: -size\n    group: { by: brand }\n");

  await page.getByTestId("save-app").click();
  await page.waitForURL(`/apps/${appId}`);
  await page.goto(`/a/${appId}/Drive`);
  await expect(page.getByTestId("entity-row")).toHaveCount(3);
  expect(await page.locator("thead th").allTextContents()).toEqual(["Size", "Name", "Id", "Brand", ""]);
  await expect(page.getByTestId("entity-group").first()).toContainText("WD");
  await expect(page.getByTestId("entity-row").first()).toContainText("Purple");
  await expect(page.getByTestId("entity-row").last()).toContainText("SkyHawk");
});

// M37-E3: the map of Tables shows Table growth writing Table, Count now starting it
test("the App's map: what starts its pipelines, what they write, its pages' buttons", async ({ page }) => {
  const appName = unique("Tables");
  const pipelineName = unique("Table growth");
  const app = readFileSync(resolve(__dirname, "../../../pipelines/apps/tables.yaml"), "utf8")
    .replace("name: Tables", `name: ${appName}`)
    .replace("run: Table growth", `run: ${pipelineName}`);
  const pipeline = readFileSync(resolve(__dirname, "../../../pipelines/table-growth.yaml"), "utf8")
    .replace("name: Table growth", `name: ${pipelineName}`)
    .replace("app: Tables", `app: ${appName}`);
  const saved = await page.request.post("/api/bundles", { data: { text: `${app}---\n${pipeline}` } });
  expect(saved.ok(), await saved.text()).toBe(true);

  await page.goto("/apps");
  await page.getByTestId("app-card").filter({ hasText: appName }).click();
  const map = page.getByTestId("app-map");
  const node = (label: string) => map.getByTestId("map-node").filter({ hasText: label });
  await expect(node(pipelineName)).toBeVisible();
  await expect(node("on a schedule: 0 * * * *")).toBeVisible();
  const edge = (kind: string) => map.locator(`[data-testid="map-edge"][data-kind="${kind}"]`);
  await expect(edge("writes")).toHaveAttribute("data-to", "type:Table");
  await expect(map.locator('[data-testid="map-edge"][data-from="list:Table"][data-kind="starts"]')).toContainText("Count now");
  await expect(edge("shows")).toHaveCount(2);

  // A box opens what it is.
  await node(pipelineName).click();
  await expect(page).toHaveURL(/\/pipelines\/[0-9a-f-]{36}$/);
});

// M38-E1: the Bills and Job Search stage diagrams: every state readable, none on another; a move picked in its own card
for (const template of ["Bills", "Job Search"]) {
  test(`the ${template} stage diagram: no state on another, every label in its box, a picked move in a card`, async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.goto("/apps/new");
    await page.getByTestId("start-template").filter({ hasText: template }).first().click();
    await page.getByTestId("tab-stages").click();
    const diagram = page.getByTestId("stages-diagram").first();
    const area = (await diagram.boundingBox())!;
    const boxes = await diagram.getByTestId("stage-box").evaluateAll((els) =>
      els.map((el) => {
        const r = el.querySelector("rect")!.getBoundingClientRect();
        const t = el.querySelector("text")!.getBoundingClientRect();
        return { state: el.getAttribute("data-state"), x: r.x, y: r.y, w: r.width, h: r.height, tw: t.width, th: t.height };
      }),
    );
    expect(boxes.length).toBeGreaterThan(1);
    for (const [i, a] of boxes.entries()) {
      // Readable: no smaller than 85% of its size, its name inside it.
      expect(a.h).toBeGreaterThan(40 * 0.85 - 1);
      expect(a.tw).toBeLessThan(a.w);
      for (const b of boxes.slice(i + 1)) {
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart, `${a.state} and ${b.state} overlap`).toBe(true);
      }
    }
    // Every arrow ends inside the drawing.
    const ends = await diagram
      .getByTestId("stage-move")
      .evaluateAll((els) => els.map((el) => el.querySelector("path")!.getBoundingClientRect()));
    for (const r of ends) expect(r.bottom).toBeLessThanOrEqual(area.y + area.height + 1);

    // A move picked: highlighted, in a card titled by it, which closes.
    const first = diagram.getByTestId("stage-move").first();
    const [from, to] = [await first.getAttribute("data-from"), await first.getAttribute("data-to")];
    await page.getByTestId("move-from").first().selectOption(from);
    await page.getByTestId("move-to").first().selectOption(to);
    await page.getByTestId("add-move").first().click();
    await expect(page.getByTestId("selected-move")).toContainText(`Move: ${from} → ${to}`);
    await page.getByTestId("picked-close").click();
    await expect(page.getByTestId("selected-move")).toHaveCount(0);
    // A state clicked: its own card.
    await diagram.locator(`[data-testid="stage-box"][data-state="${from}"]`).click();
    await expect(page.getByTestId("selected-state")).toContainText(`State: ${from}`);
  });
}

/** The controls in `scope` that say nothing of what they are for: no tooltip, no labelled row with an info icon. */
async function unexplained(scope: Locator): Promise<string[]> {
  return scope.locator("input, select, textarea").evaluateAll((els) =>
    els
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .filter((el) => !el.getAttribute("title")?.trim() && !el.closest("[data-help]"))
      .map((el) => el.getAttribute("aria-label") ?? el.getAttribute("data-testid") ?? el.outerHTML.slice(0, 80)),
  );
}

// M38-E2: every control of the designer and the cards says what it is for
test("every control of the App designer and the step cards has its help", async ({ page }) => {
  await page.goto("/apps/new");
  await page.getByTestId("start-template").filter({ hasText: "Bills" }).click();
  expect(await unexplained(page.getByTestId("app-properties"))).toEqual([]);
  for (const tab of ["types", "stages", "pages"]) {
    await page.getByTestId(`tab-${tab}`).click();
    expect(await unexplained(page.getByTestId(`${tab}-tab`)), tab).toEqual([]);
  }
  // Mine says what it does, by the switch and in the table's heading.
  await page.getByTestId("tab-types").click();
  await expect(page.getByTestId("type-mine")).toHaveAttribute("title", /pipelines only read/);
  await expect(page.getByTestId("types-tab").locator("th").filter({ hasText: "Mine" }).getByTestId("help")).toHaveAttribute("title", /never write/);
  // The icon is picked by how it looks.
  await page.getByTestId("app-icon").click();
  await expect(page.getByTestId("icon-option")).not.toHaveCount(0);
  await page.locator('[data-testid="icon-option"][data-icon="chart"]').click();
  await expect(page.getByTestId("app-icon")).toContainText("chart");

  await page.goto("/pipelines/new");
  await page.getByTestId("pipeline-tab-yaml").click();
  await page.getByTestId("pipeline-source").fill(
    readFileSync(resolve(__dirname, "../../../pipelines/table-growth.yaml"), "utf8").replace(/^app: .*\n/m, ""),
  );
  await page.getByTestId("pipeline-tab-cards").click();
  for (const more of await page.getByTestId("more-inputs").all()) await more.click();
  expect(await unexplained(page.getByTestId("step-cards"))).toEqual([]);
});

// M38-T4: a start for the first time: what an App is, what each tab holds, what to do on an empty one
test("a first App and pipeline say where to start and what each tab holds", async ({ page }) => {
  await page.goto("/apps/new");
  await expect(page.getByTestId("start-intro")).toContainText("Types");
  await page.getByTestId("start-empty").click();
  for (const [tab, holds] of [
    ["types", "What the App keeps"],
    ["stages", "Where each entity is"],
    ["pages", "How the entities are shown"],
    ["yaml", "as it is saved"],
  ] as const) {
    await page.getByTestId(`tab-${tab}`).click();
    await expect(page.getByTestId("tab-intro")).toContainText(holds);
    await expect(page.getByTestId("tab-intro")).toContainText("The tabs and the YAML are the same App");
  }
  // No types left: one button for the first.
  await page.getByTestId("tab-types").click();
  page.once("dialog", (d) => void d.accept());
  await page.getByTestId("remove-type").click();
  await expect(page.getByTestId("no-types")).toBeVisible();
  await page.getByTestId("add-first-type").click();
  await expect(page.getByTestId("type-name")).toHaveValue("Item");

  await page.goto("/pipelines/new");
  await page.getByTestId("pipeline-tab-yaml").click();
  await page.getByTestId("pipeline-source").fill("name: Empty\nsteps: []\n");
  await page.getByTestId("pipeline-tab-cards").click();
  await expect(page.getByTestId("no-steps")).toContainText("No steps yet");
  await expect(page.getByTestId("tab-intro")).toContainText("same pipeline");
});
