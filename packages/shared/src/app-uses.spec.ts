import { parse as parseYaml } from "yaml";
import { AppDefinitionSchema, declaredOnly, identifiedUses, narrowedType, useProblems } from "./app";
import { viewPageOf } from "./app-pages";
import { readAppPackage, toAppPackage } from "./app-package";

const app = (uses: unknown, types: Record<string, unknown> = { Expense: { key: "id", fields: { id: { type: "text" } } } }) =>
  AppDefinitionSchema.safeParse({ name: "Report", types, uses });
const issues = (result: ReturnType<typeof app>) => (result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));

const BILL = AppDefinitionSchema.parse(
  parseYaml(`
name: Bills
types:
  Bill:
    mine: true
    key: billKey
    fields:
      billKey: { type: text }
      issuer: { type: text }
      amount: { type: money }
      note: { type: longtext, encrypted: true }
      scan: { type: file }
      token: { type: credential, for: api.example.com }
`),
).types.Bill;

// M66-U1: `uses:` in the App format: a local name, the App and type it names, the fields read
describe("an App's uses (M66)", () => {
  it("reads a use: from, fields, help, optional", () => {
    const result = app({ Bill: { from: { app: "Bills", type: "Bill" }, fields: ["issuer", "amount"], help: "For the report", optional: true } });
    expect(result.success).toBe(true);
    expect(result.data?.uses).toEqual({ Bill: { from: { app: "Bills", type: "Bill" }, fields: ["issuer", "amount"], help: "For the report", optional: true } });
    expect(issues(app({ Bill: { from: { app: "Bills", type: "Bill" }, fields: ["issuer"], optional: "yes" } }))).toEqual([
      "uses.Bill.optional: Invalid input: expected boolean, received string",
    ]);
  });

  it("refuses a use named as one of its own types, fields named twice or none, and anything else in it", () => {
    expect(issues(app({ Expense: { from: { app: "Bills", type: "Bill" }, fields: ["issuer"] } }))).toEqual([
      "uses.Expense: \"Expense\" is a type of this App: give the use another name (e.g. BillsExpense)",
    ]);
    expect(issues(app({ Bill: { from: { app: "Bills", type: "Bill" }, fields: ["issuer", "issuer"] } }))).toEqual(["uses.Bill.fields: a field is named once"]);
    expect(issues(app({ Bill: { from: { app: "Bills", type: "Bill" }, fields: [] } }))).toEqual(["uses.Bill.fields: at least one field"]);
    expect(issues(app({ Bill: { from: { app: "Bills", type: "Bill" }, fields: ["issuer"], write: true } }))).toEqual([
      'uses.Bill: Unrecognized key: "write"',
    ]);
    expect(issues(app({ bill: { from: { app: "Bills", type: "Bill" }, fields: ["issuer"] } }))).toEqual(["uses.bill: Invalid key in record"]);
    expect(issues(app({ Bill: { from: { app: "Bills", type: "bill" }, fields: ["issuer"] } }))).toEqual(['uses.Bill.from.type: a type name, e.g. "Bill"']);
  });

  it("a type fits a use when it has the fields, none encrypted, a credential or a file", () => {
    expect(useProblems({ fields: ["issuer", "amount"] }, BILL)).toEqual([]);
    expect(useProblems({ fields: ["issuer", "vat", "note", "scan", "token"] }, BILL)).toEqual([
      'it has no field "vat"',
      "note is encrypted",
      "scan is a file",
      "token is a credential",
    ]);
  });

  it("a ref points at a use; never matching through it; an unknown one lists the uses too", () => {
    const expense = (bill: Record<string, unknown>) => ({ Expense: { key: "id", fields: { id: { type: "text" }, parent: { type: "ref", to: "Expense" }, bill: { type: "ref", ...bill } } } });
    const use = { Bill: { from: { app: "Bills", type: "Bill" }, fields: ["billKey", "issuer"] } };
    expect(issues(app(use, expense({ to: "Bill" })))).toEqual([]);
    expect(issues(app(use, { Expense: { key: "id", fields: { id: { type: "text" }, bills: { type: "list", of: "ref", to: "Bill" } } } }))).toEqual([]);
    expect(issues(app(use, expense({ to: "Bill", match: "parent" })))).toEqual(["types.Expense.fields.bill.match: Bill is another App's type (a use): a ref to it can't match"]);
    expect(issues(app(use, expense({ to: "Invoice" })))).toEqual(['types.Expense.fields.bill.to: there is no type "Invoice" (types: Expense; uses: Bill)']);
    expect(issues(app(undefined, expense({ to: "Invoice" })))).toEqual(['types.Expense.fields.bill.to: there is no type "Invoice" (types: Expense)']);
  });

  it("a page's source reads a use by the fields it declares only; a related list doesn't group by a ref to one", () => {
    const withSources = (sources: Record<string, unknown>, extra: unknown[] = []) =>
      AppDefinitionSchema.safeParse({
        name: "Report",
        types: { Expense: { key: "id", fields: { id: { type: "text" }, bill: { type: "ref", to: "Bill" } } }, Note: { key: "id", fields: { id: { type: "text" }, expense: { type: "ref", to: "Expense" }, bill: { type: "ref", to: "Bill" } } } },
        uses: { Bill: { from: { app: "Bills", type: "Bill" }, fields: ["billKey", "issuer", "dueDate"] } },
        pages: [{ list: "Expense", sources }, ...extra],
      });
    expect(
      issues(
        withSources({
          bills: { from: "Bill", where: [{ field: "dueDate", op: "gte", value: "2026-11-01" }], sort: "-dueDate", id: "billKey", display: "issuer" },
          issuers: { from: "Bill", distinct: "issuer" },
          days: { from: "Bill", distinct: "dueDate", by: "day" },
          newest: { from: "Bill", sort: "-@firstSeen" },
        }),
      ),
    ).toEqual([]);
    expect(
      issues(
        withSources({
          a: { from: "Bill", distinct: "amount" },
          b: { from: "Bill", where: [{ field: "account", op: "eq", value: "x" }], sort: "vat", id: "ref", display: "note" },
        }),
      ),
    ).toEqual([
      'pages.0.sources.a.distinct: Bill is read only by the fields it declares: "amount" isn\'t one (billKey, issuer, dueDate)',
      'pages.0.sources.b.where.0.field: Bill is read only by the fields it declares: "account" isn\'t one (billKey, issuer, dueDate)',
      'pages.0.sources.b.sort: Bill is read only by the fields it declares: "vat" isn\'t one (billKey, issuer, dueDate)',
      'pages.0.sources.b.id: Bill is read only by the fields it declares: "ref" isn\'t one (billKey, issuer, dueDate)',
      'pages.0.sources.b.display: Bill is read only by the fields it declares: "note" isn\'t one (billKey, issuer, dueDate)',
    ]);
    expect(issues(withSources({}, [{ view: "Expense", related: [{ type: "Note", by: "expense", group: "bill" }] }]))).toEqual([
      "pages.1.related.0.group: bill points at another App's type (Bill): a related list groups by a ref to this App's own types",
    ]);
  });

  it("identified: a use a ref points at, or a page lists without its id and label, needs the chosen type's key and title", () => {
    const definition = (types: Record<string, unknown>, sources: Record<string, unknown> = {}) =>
      AppDefinitionSchema.parse({
        name: "Report",
        types,
        uses: {
          Bill: { from: { app: "Bills", type: "Bill" }, fields: ["issuer"] },
          Payment: { from: { app: "Bills", type: "Payment" }, fields: ["issuer"] },
        },
        pages: [{ list: Object.keys(types)[0], sources }],
      });
    const plain = { Expense: { key: "id", fields: { id: { type: "text" } } } };
    expect(identifiedUses(definition(plain))).toEqual(new Set());
    // No uses, a view page, a list without sources: none.
    expect(identifiedUses(AppDefinitionSchema.parse({ name: "Plain", types: plain, pages: [{ view: "Expense" }, { list: "Expense" }] }))).toEqual(new Set());
    expect(identifiedUses(definition({ Expense: { key: "id", fields: { id: { type: "text" }, bill: { type: "ref", to: "Bill" } } } }))).toEqual(new Set(["Bill"]));
    expect(identifiedUses(definition(plain, { a: { from: "Bill" }, b: { from: "Payment", id: "issuer", display: "issuer" }, c: { from: "Payment", distinct: "issuer" } }))).toEqual(
      new Set(["Bill"]),
    );
    expect(identifiedUses(definition(plain, { a: { from: "Payment", id: "issuer" } }))).toEqual(new Set(["Payment"]));

    // The key and title among the fields; a type without a title shows its key.
    const titled = { ...BILL, title: "issuer" };
    expect(useProblems({ fields: ["issuer"] }, titled, true)).toEqual(["its key billKey isn't among the fields read (a ref holds it)"]);
    expect(useProblems({ fields: ["billKey"] }, titled, true)).toEqual(["its title issuer isn't among the fields read (a ref shows it)"]);
    expect(useProblems({ fields: ["billKey", "issuer"] }, titled, true)).toEqual([]);
    expect(useProblems({ fields: ["billKey"] }, BILL, true)).toEqual([]);
    expect(useProblems({ fields: ["issuer"] }, titled, false)).toEqual([]);
  });

  it("the chosen type as a use reads it: its declared fields, its stages only with their field; an entity's declared fields at their paths", () => {
    const staged = AppDefinitionSchema.parse(
      parseYaml(`
name: Bills
types:
  Bill:
    key: billKey
    stages: { field: status, initial: due, states: [due, paid], moves: [{ from: due, to: [paid] }] }
    fields:
      billKey: { type: text }
      issuer: { type: text }
      account: { type: text }
`),
    ).types.Bill;
    expect(Object.keys(narrowedType(staged, { fields: ["billKey", "status"] }).fields)).toEqual(["billKey", "status"]);
    expect(narrowedType(staged, { fields: ["billKey", "status"] }).stages?.field).toBe("status");
    expect(narrowedType(staged, { fields: ["billKey", "issuer"] }).stages).toBeUndefined();
    expect(declaredOnly({ billKey: "b1", issuer: "Power Co", account: "BG00", address: { city: "Sofia", street: "Main" } }, ["issuer", "address.city", "missing"])).toEqual({
      issuer: "Power Co",
      address: { city: "Sofia" },
    });
  });

  it("a form's ref to a use says so, for its choices", () => {
    const definition = AppDefinitionSchema.parse({
      name: "Report",
      types: { Expense: { key: "id", mine: true, fields: { id: { type: "text" }, bill: { type: "ref", to: "Bill" }, note: { type: "ref", to: "Expense" } } } },
      uses: { Bill: { from: { app: "Bills", type: "Bill" }, fields: ["billKey"] } },
    });
    const form = viewPageOf(definition, "Expense").form;
    expect(form.find((f) => f.field === "bill")).toMatchObject({ ref: "Bill", use: true });
    expect(form.find((f) => f.field === "note")).toMatchObject({ ref: "Expense" });
    expect(form.find((f) => f.field === "note")).not.toHaveProperty("use");
  });

  it("stays in an App file, at its top, as types and pages do", () => {
    const read = readAppPackage(`app:
  name: Report
types:
  Expense:
    key: id
    fields: { id: { type: text } }
uses:
  Bill:
    from: { app: Bills, type: Bill }
    fields: [issuer]
`);
    expect(read.errors).toEqual([]);
    const source = read.documents[0].source;
    expect(AppDefinitionSchema.parse(parseYaml(source)).uses).toEqual({ Bill: { from: { app: "Bills", type: "Bill" }, fields: ["issuer"] } });

    // Exported with its pipelines and read back: the use is still there, as written.
    const exported = toAppPackage(source, ["name: Report · Sum\napp: Report\nsteps: []\n"]);
    expect(exported).toContain("uses:\n  Bill:\n    from: { app: Bills, type: Bill }\n    fields: [ issuer ]\n");
    const again = readAppPackage(exported);
    expect(again.errors).toEqual([]);
    expect(AppDefinitionSchema.parse(parseYaml(again.documents[0].source)).uses).toEqual({ Bill: { from: { app: "Bills", type: "Bill" }, fields: ["issuer"] } });
  });
});
