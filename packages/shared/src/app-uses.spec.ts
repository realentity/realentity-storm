import { parse as parseYaml } from "yaml";
import { AppDefinitionSchema, useProblems } from "./app";
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
  it("reads a use: from, fields, help", () => {
    const result = app({ Bill: { from: { app: "Bills", type: "Bill" }, fields: ["issuer", "amount"], help: "For the report" } });
    expect(result.success).toBe(true);
    expect(result.data?.uses).toEqual({ Bill: { from: { app: "Bills", type: "Bill" }, fields: ["issuer", "amount"], help: "For the report" } });
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
