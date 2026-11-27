import { checkAppSource, editAppSource, tabOf } from "./app-source";

const SOURCE = `# my bills
name: Bills
icon: receipt
types:
  Bill:
    key: id                       # one per bill
    stages:
      field: status
      initial: due
      states: [due, paid]
      moves:
        - { from: due, to: [paid] }
    fields:
      id: { type: text, required: true }
      amount: { type: money, currency: currency }
      currency: { type: text }
pages:
  - list: Bill
    columns: [id, amount]
`;

describe("checkAppSource (M35-T1)", () => {
  it("reads a valid App", () => {
    const { definition, errors } = checkAppSource(SOURCE);
    expect(errors).toEqual([]);
    expect(Object.keys(definition!.types.Bill.fields)).toEqual(["id", "amount", "currency", "status"]);
  });

  // M67: the builder retried a report page blind on "Invalid input"
  it("a page of a kind with a mistake in it: told the mistake, at its path, not that it is no page", () => {
    const report = `${SOURCE}  - report: Bill\n    tiles:\n      - { label: Due, count: true, share: 2 }\n`;
    const { errors } = checkAppSource(report);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ path: "pages.1.tiles.0", line: 22 });
    expect(errors[0].message).toContain("share");
    expect(errors[0].message).not.toBe("Invalid input");
    // A page of no kind it knows: still told what is wrong with it, on its line.
    const { errors: unknown } = checkAppSource(`${SOURCE}  - chart: Bill\n`);
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown.every((e) => e.path.startsWith("pages.1") && e.line === 20 && e.message !== "Invalid input")).toBe(true);
  });

  it("gives a YAML error its line", () => {
    const { definition, errors } = checkAppSource("name: Bills\ntypes:\n  Bill: { key: id\n");
    expect(definition).toBeNull();
    expect(errors[0].path).toBe("");
    expect(errors[0].line).toBeGreaterThanOrEqual(3);
  });

  it("gives a problem its path and the line it is on", () => {
    const { errors } = checkAppSource(SOURCE.replace("currency: currency }", "currency: nothing }"));
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe("types.Bill.fields.amount.currency");
    expect(errors[0].line).toBe(15);
  });

  it("doesn't add a page's use of the stage to a problem elsewhere in its type", () => {
    const { errors } = checkAppSource(
      SOURCE.replace("columns: [id, amount]", "columns: [id, amount, status]").replace("currency: currency }", "currency: nothing }"),
    );
    expect(errors.map((e) => e.path)).toEqual(["types.Bill.fields.amount.currency"]);
  });

  it("puts a missing field's problem on the nearest line that is there", () => {
    const { errors } = checkAppSource(SOURCE.replace("    key: id                       # one per bill\n", ""));
    const key = errors.find((e) => e.path === "types.Bill.key");
    expect(key?.line).toBe(5);
  });

  it("finds a page's line by its index", () => {
    const { errors } = checkAppSource(SOURCE.replace("columns: [id, amount]", "columns: [id, nope]"));
    expect(errors[0].path).toMatch(/^pages\.0/);
    expect(errors[0].line).toBeGreaterThanOrEqual(19);
  });
});

describe("editAppSource (M35-T1)", () => {
  it("changes the document, keeping its comments and order", () => {
    const edited = editAppSource(SOURCE, (document) =>
      document.setIn(["types", "Bill", "fields", "issuer"], document.createNode({ type: "text" }, { flow: true })),
    );
    expect(edited).toContain("# my bills");
    expect(edited).toContain("key: id                       # one per bill");
    expect(edited).toContain("issuer: { type: text }");
    expect(Object.keys(checkAppSource(edited).definition!.types.Bill.fields)).toEqual(["id", "amount", "currency", "issuer", "status"]);
  });

  it("leaves the lines it doesn't change as written", () => {
    const edited = editAppSource(SOURCE, (document) =>
      document.setIn(["types", "Bill", "stages", "states"], document.createNode(["due", "paid", "late"], { flow: true })),
    );
    expect(edited).toBe(SOURCE.replace("states: [due, paid]", "states: [due, paid, late]"));
  });

  it("removes a field's line, and only that", () => {
    const edited = editAppSource(SOURCE, (document) => document.deleteIn(["types", "Bill", "fields", "currency"]));
    expect(edited).toBe(SOURCE.replace("      currency: { type: text }\n", ""));
  });

  it("keeps Windows line ends out of the result's untouched lines", () => {
    const edited = editAppSource(SOURCE.replaceAll("\n", "\r\n"), (document) => document.setIn(["icon"], "tag"));
    expect(edited).toBe(SOURCE.replace("icon: receipt", "icon: tag"));
  });

  it("refuses to edit YAML with errors", () => {
    expect(() => editAppSource("name: [", () => undefined)).toThrow(/YAML tab/);
  });
});

describe("tabOf", () => {
  it("routes a problem to its tab", () => {
    expect(tabOf("types.Bill.fields.amount")).toBe("types");
    expect(tabOf("types.Bill.stages.moves.0")).toBe("stages");
    expect(tabOf("pages.1.columns")).toBe("pages");
    expect(tabOf("name")).toBe("app");
    expect(tabOf("")).toBe("app");
  });
});
