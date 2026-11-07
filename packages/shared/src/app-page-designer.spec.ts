import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addPage, moveListPage, removePage, setPageProperty } from "./app-page-designer";
import { checkAppSource } from "./app-source";

const SOURCE = `name: Bills
types:
  Bill:
    key: id
    fields:
      id: { type: text, required: true }
      issuer: { type: text }
      amount: { type: money, currency: currency }
      currency: { type: text }
      status: { type: enum, values: [due, paid] }
  Shop:
    key: name
    fields:
      name: { type: text, required: true }
pages:
  - list: Bill
    columns: [issuer, amount]   # the two I look at
`;

// M37-U: each page edit gives the YAML expected, the rest as written
describe("the Pages tab's edits (M37-T1)", () => {
  it("sets a page's property where it is, keeping my comment", () => {
    expect(setPageProperty(SOURCE, "list", "Bill", "columns", ["issuer", "amount", "status"])).toBe(
      SOURCE.replace("columns: [issuer, amount]   #", "columns: [issuer, amount, status] #"),
    );
  });

  it("adds a property where I'd write it, a list on one line", () => {
    const edited = setPageProperty(SOURCE, "list", "Bill", "menu", { label: "Bills", icon: "receipt" });
    expect(edited).toContain(
      "  - list: Bill\n    menu: { label: Bills, icon: receipt }\n    columns: [issuer, amount]   # the two I look at\n",
    );
    const sorted = setPageProperty(SOURCE, "list", "Bill", "sort", "-amount");
    expect(sorted).toContain("    columns: [issuer, amount]   # the two I look at\n    sort: -amount\n");
    const grouped = setPageProperty(SOURCE, "list", "Bill", "group", {
      by: "status",
      totals: [{ field: "amount", when: { status: "due" } }],
    });
    expect(grouped).toContain(
      "    group: { by: status, totals: [ { field: amount, when: { status: due } } ] }\n"
        .replace(/\[ \{/, "[{")
        .replace(/\} \] \}/, "}] }"),
    );
  });

  it("removes a property, its default in its place", () => {
    expect(setPageProperty(SOURCE, "list", "Bill", "columns", undefined)).toBe(
      SOURCE.replace("    columns: [issuer, amount]   # the two I look at\n", ""),
    );
    expect(setPageProperty(SOURCE, "view", "Bill", "fields", undefined)).toBe(SOURCE);
  });

  it("writes a default page on its first change, after its type's pages", () => {
    const view = setPageProperty(SOURCE, "view", "Bill", "fields", ["issuer", "amount"]);
    expect(view).toBe(`${SOURCE}  - view: Bill\n    fields: [issuer, amount]\n`);
    const shop = addPage(view, "list", "Shop");
    expect(shop.endsWith("  - list: Shop\n")).toBe(true);
    const before = addPage(SOURCE.replace("  - list: Bill\n", "  - view: Bill\n"), "list", "Bill");
    expect(before).toContain("pages:\n  - list: Bill\n  - view: Bill\n");
    expect(() => addPage(SOURCE, "list", "Bill")).toThrow(/already/);
    expect(() => addPage(SOURCE, "list", "Nope")).toThrow(/no type/);
    const none = SOURCE.slice(0, SOURCE.indexOf("pages:"));
    expect(addPage(none, "form", "Bill")).toBe(`${none}pages:\n  - form: Bill\n`);
  });

  it("writes a view's sections a line each", () => {
    const edited = setPageProperty(SOURCE, "view", "Bill", "sections", [
      { title: "Bill", fields: ["issuer", "amount"] },
      { title: "More", fields: ["status"] },
    ]);
    expect(edited).toContain(
      "  - view: Bill\n    sections:\n      - { title: Bill, fields: [issuer, amount] }\n      - { title: More, fields: [status] }\n",
    );
  });

  it("removes a page and moves a list in the menu", () => {
    expect(removePage(SOURCE, "list", "Bill")).toBe(SOURCE.slice(0, SOURCE.indexOf("pages:")));
    const two = addPage(SOURCE, "list", "Shop");
    expect(moveListPage(two, "Shop", -1)).toContain("pages:\n  - list: Shop\n  - list: Bill\n");
    expect(moveListPage(two, "Bill", -1)).toBe(two);
  });

  it("gives a page the App check passes, from each template's", () => {
    const bills = readFileSync(join(__dirname, "../../../pipelines/apps/bills.yaml"), "utf8");
    const edited = setPageProperty(setPageProperty(bills, "list", "Bill", "sort", "-amount"), "view", "Bill", "fields", ["issuer"]);
    expect(checkAppSource(edited).errors).toEqual([]);
    expect(edited).toContain("  - view: Bill\n    fields: [issuer]\n");
    expect(() => setPageProperty(SOURCE, "list", "Bill", "sections", [])).toThrow(/no sections/);
  });
});
