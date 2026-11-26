import { expect, test } from "@playwright/test";
import { createPipeline, openAppPage, startRun, unique } from "./support";

// M65-I3: a list's controls from YAML: tags as chips (several picked), a calendar of days, buttons; the filter and the
// search in the link, so a link opens the list as it was.
test("a list filters by chips, a calendar day and buttons, and opens from its link filtered", async ({ page }) => {
  const name = unique("Notes");
  const label = `Notes ${name.split(" ")[1]}`;
  const created = await page.request.post("/api/apps", {
    data: {
      source: `name: ${name}
icon: bookmark
types:
  Note:
    key: id
    title: title
    fields:
      id: { type: text, required: true }
      title: { type: text, required: true }
      tags: { type: list, of: text }
      due: { type: date }
      kind: { type: enum, values: [idea, note] }
pages:
  - list: Note
    menu: { label: "${label}" }
    columns: [title, { field: tags, control: chips }, due, kind]
    sort: title
    sources:
      tags: { from: Note, distinct: tags }
      days: { from: Note, distinct: due, by: day }
    controls:
      - { control: chips, source: tags, filters: tags, multiple: true }
      - { control: calendar, source: days, filters: due }
      - { control: buttons, filters: kind }
`,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const pipeline = await createPipeline(
    page,
    `name: ${unique("Note reader")}
app: ${name}
steps:
  - id: save
    type: data.save
    with:
      type: Note
      items:
        - { id: a, title: Alpha, tags: [home, work], due: "2026-11-10", kind: idea }
        - { id: b, title: Beta, tags: [Home], due: "2026-11-20", kind: note }
        - { id: c, title: Gamma, due: "2026-10-05", kind: note }
`,
  );
  await startRun(page, pipeline.pipelineId);

  await openAppPage(page, label);
  const rows = page.getByTestId("entity-row");
  await expect(rows).toHaveCount(3, { timeout: 20_000 });
  const list = page.url();
  // A list of text read as chips.
  await expect(rows.nth(0).getByTestId("value-chips")).toHaveText(/home\s*work/);

  // Chips of the tags in use, with counts (without case: home twice); several picked match any.
  const tags = page.getByTestId("filter-tags");
  await expect(tags.locator('[data-value="home"]')).toContainText("2");
  await tags.locator('[data-value="home"]').click();
  await expect(rows).toHaveCount(2);
  await expect(page).toHaveURL(/f\.tags=home/);
  await tags.locator('[data-value="work"]').click();
  await expect(rows).toHaveCount(2);
  await tags.locator('[data-value="home"]').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("Alpha");
  await tags.getByRole("button", { name: "All" }).click();
  await expect(rows).toHaveCount(3);

  // The calendar opens on the latest day marked; a day picks it, again clears it.
  const calendar = page.getByTestId("filter-due");
  await expect(calendar.getByTestId("calendar-month")).toHaveText("November 2026");
  await expect(calendar.locator('[data-day="2026-11-10"]')).toHaveAttribute("data-count", "1");
  await calendar.locator('[data-day="2026-11-20"]').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("Beta");
  await expect(page).toHaveURL(/f\.due=2026-11-20/);
  // Facets: the tags' counts are of what the day leaves (Beta's, spelled as it has it).
  await expect(tags.locator('[data-value="Home"]')).toContainText("1");
  await expect(tags.locator('[data-value="work"]')).toHaveCount(0);
  await calendar.locator('[data-day="2026-11-20"]').click();
  await expect(rows).toHaveCount(3);
  await calendar.getByRole("button", { name: "Previous month" }).click();
  await expect(calendar.getByTestId("calendar-month")).toHaveText("October 2026");
  await expect(calendar.locator('[data-day="2026-10-05"]')).toHaveAttribute("data-count", "1");

  // Buttons of an enum's values.
  await page.getByTestId("filter-kind").getByRole("button", { name: "note" }).click();
  await expect(rows).toHaveCount(2);

  // A link opens the list filtered, searched, its controls showing it.
  await page.goto(`${list}?f.tags=work`);
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("Alpha");
  await expect(tags.locator('[data-value="work"]')).toHaveAttribute("aria-pressed", "true");
  await page.goto(`${list}?q=gam`);
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("Gamma");
  await expect(page.getByLabel("Search")).toHaveValue("gam");
  // Back: the list as it was before.
  await page.goBack();
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("Alpha");
  await expect(page.getByLabel("Search")).toHaveValue("");
});
