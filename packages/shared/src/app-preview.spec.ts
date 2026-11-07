import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listPageOf } from "./app-pages";
import { sampleRows } from "./app-preview";
import { checkAppSource } from "./app-source";

// M37-T2: a type with no entities yet still shows its pages, from made-up ones
describe("the preview's made-up entities (M37-T2)", () => {
  const bills = checkAppSource(readFileSync(join(__dirname, "../../../pipelines/apps/bills.yaml"), "utf8")).definition!;
  const rows = sampleRows("Bill", bills.types.Bill, 6, new Date("2026-11-07T10:00:00Z"));

  it("gives each field a value of its kind, the key its own", () => {
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.key)).size).toBe(6);
    const first = rows[0].value;
    expect(typeof first.amount).toBe("number");
    expect(first.currency).toBe("EUR");
    expect(first.dueDate).toBe("2026-10-24");
    expect(first.from).toMatch(/@example\.org$/);
  });

  it("spreads them so groups, sorts, stages and due dates show", () => {
    expect(new Set(rows.map((r) => r.value.status))).toEqual(new Set(["due", "paid"]));
    expect(new Set(rows.map((r) => String(r.value.month).slice(0, 7))).size).toBeGreaterThan(1);
    expect(rows.some((r) => String(r.value.dueDate) < "2026-11-07")).toBe(true);
    expect(rows.some((r) => String(r.value.dueDate) > "2026-11-07")).toBe(true);
    // Every column of the page has a value.
    for (const column of listPageOf(bills, "Bill").columns) expect(rows[0].value[column.field]).toBeDefined();
  });
});
