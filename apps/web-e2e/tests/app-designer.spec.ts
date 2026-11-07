import { checkAppSource } from "@ai-me/shared";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { unique } from "./support";

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
  await page.getByTestId("app-icon").selectOption("cpu");

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
description: What it keeps, in a sentence
icon: cpu
types:
  Disk:
    key: id                      # one entity per name
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

/** Drag on the diagram from one state's box to another's: a move made by me. */
async function drawMove(page: Page, from: string, to: string, nth = 0) {
  const diagram = page.getByTestId("designer-stages").nth(nth);
  const a = await diagram.locator(`[data-testid="stage-box"][data-state="${from}"]`).boundingBox();
  const b = await diagram.locator(`[data-testid="stage-box"][data-state="${to}"]`).boundingBox();
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2);
  await page.mouse.down();
  await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2, { steps: 5 });
  await page.mouse.up();
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

// M35-E1: the Bills App's types and stages made in the designer from empty, without the YAML tab
test("the Bills App's types and stages made in the designer, as pipelines/apps/bills.yaml has them", async ({ page }) => {
  const bills = readFileSync(resolve(__dirname, "../../../pipelines/apps/bills.yaml"), "utf8");
  const name = unique("Bills");
  await page.goto("/apps/new");
  await page.getByTestId("start-empty").click();
  await commit(page, "app-name", name);
  await page.getByTestId("app-icon").selectOption("receipt");
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

  const made = checkAppSource(await yaml(page));
  const template = checkAppSource(bills);
  expect(made.errors).toEqual([]);
  expect(made.definition!.types).toEqual(template.definition!.types);
  expect(made.definition!.icon).toBe("receipt");

  await page.getByTestId("save-app").click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
});

// M35-T4: a type from a sample I paste, its fields kept or left out, into a new type and into one that is there
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
  const app = `# books I have
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
  const text = readFileSync((await file.path()), "utf8");
  expect(text.startsWith(`${app}---\n`)).toBe(true);
  expect(text).toContain(`name: ${pipelineName}`);

  // Imported again: the same, nothing to do.
  await page.goto("/pipelines");
  await page.getByTestId("import-yaml").click();
  await page.getByTestId("import-text").fill(text);
  await expect(page.getByTestId("import-check")).toContainText("Everything in it is as I have it already");
  await expect(page.getByTestId("import-save")).toBeDisabled();
});
