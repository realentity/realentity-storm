import {
  addDraftedFields,
  addField,
  addType,
  setAppProperty,
  removeField,
  removeType,
  renameField,
  renameType,
  setField,
  setTypeProperty,
} from "./app-designer";
import { checkAppSource } from "./app-source";

const SOURCE = `# my bills
name: Bills
types:
  Bill:
    key: billKey                  # one per bill
    title: issuer
    stages:
      field: status
      initial: due
      states: [due, paid]
      moves:
        - { from: due, to: [paid] }
    fields:
      billKey: { type: text, required: true }
      issuer: { type: text, required: true }    # who sends it
      amount: { type: money, currency: currency }
      currency: { type: text }
      dueDate: { type: date }
pages:
  - list: Bill
    columns: [issuer, amount, { field: dueDate, due: { days: 3, unless: { status: paid } } }]
    filters: [status]
    sort: -dueDate
    group: { by: issuer, totals: [amount, { field: amount, label: Unpaid, when: { status: due } }] }
  - view: Bill
    sections:
      - { title: Bill, fields: [issuer, amount] }
      - { title: When, fields: [dueDate] }
`;

const valid = (source: string) => {
  const { definition, errors } = checkAppSource(source);
  expect(errors).toEqual([]);
  return definition!;
};

// M35-U1: each designer edit gives the YAML expected, my comments and order kept
describe("the App designer's edits (M35-T2)", () => {
  it("adds a type with a key field", () => {
    const edited = addType(SOURCE, "Issuer");
    expect(edited).toContain("  Issuer:\n    key: name\n    fields:\n      name: { type: text, required: true }\n");
    expect(Object.keys(valid(edited).types)).toEqual(["Bill", "Issuer"]);
    expect(() => addType(SOURCE, "Bill")).toThrow(/already/);
  });

  it("renames a type where it is, with its pages", () => {
    const edited = renameType(SOURCE, "Bill", "Invoice");
    expect(edited).toBe(
      SOURCE.replace("  Bill:", "  Invoice:").replace("- list: Bill", "- list: Invoice").replace("- view: Bill", "- view: Invoice"),
    );
    valid(edited);
  });

  it("removes a type with its pages", () => {
    const edited = removeType(addType(SOURCE, "Issuer"), "Bill");
    expect(valid(edited).pages).toEqual([]);
    expect(edited).toContain("# my bills");
  });

  it("sets and removes a type's key, title, mine and description", () => {
    let edited = setTypeProperty(SOURCE, "Bill", "title", "amount");
    expect(edited).toBe(SOURCE.replace("title: issuer", "title: amount"));
    edited = setTypeProperty(edited, "Bill", "title", undefined);
    expect(edited).not.toContain("title: amount");
    edited = setTypeProperty(edited, "Bill", "description", "A bill to pay");
    expect(valid(edited).types.Bill.description).toBe("A bill to pay");
    expect(setTypeProperty(SOURCE, "Bill", "mine", false)).toBe(SOURCE);
  });

  it("adds a field as a line, an enum with values to rename", () => {
    const edited = addField(SOURCE, "Bill", "kind", "enum");
    expect(edited).toBe(
      SOURCE.replace("      dueDate: { type: date }\n", "      dueDate: { type: date }\n      kind: { type: enum, values: [one, two] }\n"),
    );
    valid(edited);
    expect(() => addField(SOURCE, "Bill", "amount", "number")).toThrow(/already/);
  });

  it("changes a field's properties on its line, dropping what its new kind can't have", () => {
    expect(setField(SOURCE, "Bill", "issuer", { label: "From" })).toBe(
      SOURCE.replace(
        "issuer: { type: text, required: true }    # who sends it",
        "issuer: { type: text, required: true, label: From } # who sends it",
      ),
    );
    expect(setField(SOURCE, "Bill", "issuer", { required: false })).toContain(
      "      issuer: { type: text }                    # who sends it\n",
    );
    const number = setField(SOURCE, "Bill", "amount", { type: "number" });
    expect(number).toContain("      amount: { type: number }\n");
    const kinds = setField(SOURCE, "Bill", "currency", { type: "enum" });
    expect(kinds).toContain("currency: { type: enum, values: [one, two] }");
    expect(setField(kinds, "Bill", "currency", { values: ["BGN", "EUR"] })).toContain("currency: { type: enum, values: [BGN, EUR] }");
    expect(() => setField(SOURCE, "Bill", "nothing", { label: "x" })).toThrow(/no field/);
  });

  it("renames a field everywhere the App uses it, and nowhere else", () => {
    const edited = renameField(SOURCE, "Bill", "issuer", "sender");
    expect(edited).toBe(
      SOURCE.replace("title: issuer", "title: sender")
        .replace("      issuer: { type: text, required: true }", "      sender: { type: text, required: true }")
        .replace("columns: [issuer,", "columns: [sender,")
        .replace("group: { by: issuer,", "group: { by: sender,")
        .replace("fields: [issuer, amount]", "fields: [sender, amount]"),
    );
    valid(edited);

    const key = renameField(SOURCE, "Bill", "billKey", "id");
    expect(valid(key).types.Bill.key).toBe("id");
    const currency = renameField(SOURCE, "Bill", "currency", "code");
    expect(valid(currency).types.Bill.fields.amount.currency).toBe("code");
    const due = renameField(SOURCE, "Bill", "dueDate", "due");
    expect(due).toContain("columns: [issuer, amount, { field: due, due: { days: 3, unless: { status: paid } } }]");
    expect(due).toContain("sort: -due\n");
    valid(due);
    expect(() => renameField(SOURCE, "Bill", "issuer", "amount")).toThrow(/already/);
  });

  it("renames a field in a page's conditions", () => {
    const source = SOURCE.replace("        - { from: due, to: [paid] }\n", "        - { from: due, to: [paid] }\n")
      .replace("      dueDate: { type: date }\n", "      dueDate: { type: date }\n      paid: { type: yesno, mine: true }\n")
      .replace("unless: { status: paid }", "unless: { paid: true }");
    valid(source);
    const edited = renameField(source, "Bill", "paid", "settled");
    expect(edited).toContain("unless: { settled: true }");
    valid(edited);
  });

  it("removes a field from its type's pages, an emptied list with it", () => {
    const edited = removeField(SOURCE, "Bill", "dueDate");
    expect(edited).toContain("columns: [issuer, amount]");
    expect(edited).not.toContain("sort: -dueDate");
    expect(edited).not.toContain("title: When");
    valid(edited);
    expect(removeField(SOURCE, "Bill", "issuer")).not.toContain("group:");
  });

  it("sets the App's name, description and icon, a new one after the name", () => {
    let edited = setAppProperty(SOURCE, "name", "Invoices");
    expect(edited).toBe(SOURCE.replace("name: Bills\n", "name: Invoices\n"));
    edited = setAppProperty(edited, "icon", "receipt");
    expect(edited).toBe(SOURCE.replace("name: Bills\n", "name: Invoices\nicon: receipt\n"));
    edited = setAppProperty(edited, "description", "What I pay");
    expect(edited).toBe(SOURCE.replace("name: Bills\n", "name: Invoices\ndescription: What I pay\nicon: receipt\n"));
    expect(setAppProperty(edited, "description", "")).toBe(SOURCE.replace("name: Bills\n", "name: Invoices\nicon: receipt\n"));
    valid(edited);
  });
});

describe("a type from a sample (M35-T4)", () => {
  const drafted = {
    id: { type: "text", required: true },
    name: { type: "text", required: true },
    price: { type: "money", currency: "currency" },
    currency: { type: "text" },
    kind: { type: "enum", values: ["hdd", "ssd"] },
  };

  it("adds the fields I kept as a new type, each a line", () => {
    const edited = addDraftedFields(SOURCE, "Disk", drafted, "id", "name");
    expect(edited).toContain(
      "  Disk:\n    key: id\n    title: name\n    fields:\n      id: { type: text, required: true }\n      name: { type: text, required: true }\n      price: { type: money, currency: currency }\n      currency: { type: text }\n      kind: { type: enum, values: [hdd, ssd] }\n",
    );
    valid(edited);
  });

  it("drops a currency I didn't keep, and wants the key kept", () => {
    const { currency: _, ...rest } = drafted;
    expect(addDraftedFields(SOURCE, "Disk", rest, "id")).toContain("price: { type: money }");
    expect(() => addDraftedFields(SOURCE, "Disk", { name: drafted.name }, "id")).toThrow(/key/);
  });

  it("adds to a type only the fields it doesn't have", () => {
    const edited = addDraftedFields(SOURCE, "Bill", { issuer: { type: "number" }, reference: { type: "text" } });
    expect(edited).toBe(
      SOURCE.replace("      dueDate: { type: date }\n", "      dueDate: { type: date }\n      reference: { type: text }\n"),
    );
  });
});
