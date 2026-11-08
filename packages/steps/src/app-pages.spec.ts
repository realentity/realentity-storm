import { AppDefinitionSchema, groupValue, listPageOf, viewPageOf } from "@realentity/storm-shared";

const types = {
  Bill: {
    key: "id",
    title: "payee",
    fields: {
      id: { type: "text", required: true },
      payee: { type: "text", required: true },
      amount: { type: "money", required: true, currency: "currency" },
      currency: { type: "text" },
      due: { type: "date" },
      status: { type: "enum", values: ["due", "paid", "late"] },
      paid: { type: "yesno", mine: true },
      url: { type: "url" },
      note: { type: "longtext" },
      tags: { type: "list" },
    },
  },
};

const app = (pages: unknown[] = []) => AppDefinitionSchema.parse({ name: "Bills", icon: "receipt", types, pages });
const issues = (pages: unknown[]) => {
  const result = AppDefinitionSchema.safeParse({ name: "Bills", types, pages });
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

// M31-U1
describe("an App's pages (M31)", () => {
  it("gives every type a list and a view by default, from its fields", () => {
    const list = listPageOf(app(), "Bill");
    expect(list).toMatchObject({
      type: "Bill",
      label: "Bill",
      icon: "receipt",
      menu: true,
      title: "payee",
      link: "url",
      removed: false,
      group: null,
    });
    // Title, then the required fields, then the rest that fit a row: no long text, lists, links or currency codes.
    expect(list.columns).toEqual([
      { field: "payee", label: "Payee", as: "text" },
      { field: "id", label: "Id", as: "text" },
      { field: "amount", label: "Amount", as: "money", currency: "currency" },
      { field: "due", label: "Due", as: "date" },
      { field: "status", label: "Status", as: "badge" },
      { field: "paid", label: "Paid", as: "yesno" },
    ]);
    expect(list.filters).toEqual([
      { field: "status", label: "Status", values: ["due", "paid", "late"].map((v) => ({ value: v, label: v })) },
      {
        field: "paid",
        label: "Paid",
        values: [
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
        ],
      },
    ]);
    expect(list.search).toEqual(["id", "payee", "currency", "status", "note"]);
    expect(list.sort).toEqual({ by: "@firstSeen", desc: true });
    expect(viewPageOf(app(), "Bill").sections[0].fields.map((f) => f.field)).toEqual(Object.keys(types.Bill.fields));
  });

  it("takes columns, filters, groups with totals, sections and history as written", () => {
    const written = app([
      {
        list: "Bill",
        menu: { label: "My bills" },
        columns: ["payee", { field: "amount", label: "Sum" }, "@firstSeen"],
        filters: ["status"],
        sort: "-due",
        group: { by: "due", period: "month", totals: ["amount"] },
        removed: true,
      },
      { view: "Bill", sections: [{ title: "Money", fields: ["amount", "due"] }], history: { collection: "bill-amounts", stepped: true } },
    ]);
    const list = listPageOf(written, "Bill");
    expect(list.label).toBe("My bills");
    expect(list.columns).toEqual([
      { field: "payee", label: "Payee", as: "text" },
      { field: "amount", label: "Sum", as: "money", currency: "currency" },
      { field: "@firstSeen", label: "First seen", as: "date" },
    ]);
    expect(list.group).toEqual({
      by: { field: "due", label: "Due", as: "date" },
      period: "month",
      totals: [{ field: "amount", label: "Amount", as: "money", currency: "currency" }],
    });
    expect(list.sort).toEqual({ by: "due", desc: true });
    expect(viewPageOf(written, "Bill")).toMatchObject({
      sections: [{ title: "Money", fields: [{ field: "amount" }, { field: "due" }] }],
      history: { collection: "bill-amounts", label: "History", stepped: true },
    });
    expect(listPageOf(app([{ list: "Bill", menu: false }]), "Bill").menu).toBe(false);
  });

  it("refuses pages on unknown types or fields, or a field used as its kind can't be", () => {
    expect(
      issues([
        { list: "Invoice" },
        {
          list: "Bill",
          columns: ["payee", "salery"],
          filters: ["payee"],
          search: ["amount"],
          sort: "-nope",
          group: { by: "status", period: "month", totals: ["payee"] },
        },
        { list: "Bill" },
        { view: "Bill", fields: ["payee"], sections: [{ title: "A", fields: ["nope"] }] },
      ]),
    ).toEqual([
      'pages.0.list: there is no type "Invoice"',
      'pages.1.columns.1: Bill has no field "salery"',
      'pages.1.filters.0: a filter is an enum or a yes/no field: "payee" is text',
      'pages.1.search.0: search looks in text fields: "amount" is money',
      'pages.1.sort: Bill has no field "nope"',
      'pages.1.group.period: a period groups a date field: "status" is enum',
      'pages.1.group.totals.0: a total is a number or money field: "payee" is text',
      "pages.2: Bill already has a list page",
      'pages.3.sections.0.fields.0: Bill has no field "nope"',
      "pages.3.sections: fields or sections, not both",
    ]);
  });

  // M33: what the Bills page did, as an App's list
  it("takes due badges, conditional totals and row moves, each where it can work", () => {
    expect(
      issues([
        {
          list: "Bill",
          columns: [{ field: "payee", due: { days: 3 } }, { field: "due", due: { unless: { nope: "x" } } }],
          group: { by: "due", totals: [{ field: "amount", when: { nope: "x" } }] },
          moves: true,
        },
      ]),
    ).toEqual([
      'pages.0.columns.0: a due badge is on a date field: "payee" is text',
      'pages.0.columns.1.due.unless.nope: Bill has no field "nope"',
      "pages.0.moves: Bill has no stages to move",
      'pages.0.group.totals.0.when.nope: Bill has no field "nope"',
    ]);
    const list = listPageOf(app([{ list: "Bill", columns: [{ field: "due", due: { unless: { status: "paid" } } }], group: { by: "due", totals: ["amount", { field: "amount", label: "Unpaid", when: { status: "due" } }] } }]), "Bill");
    expect(list.columns[0]).toEqual({ field: "due", label: "Due", as: "date", due: { days: 3, unless: { status: "paid" } } });
    expect(list.group?.totals.map((t) => [t.label, t.when])).toEqual([
      ["Amount", undefined],
      ["Unpaid", { status: "due" }],
    ]);
  });

  it("groups by a value, a month or a year", () => {
    expect(groupValue("2026-11-03", "month")).toBe("2026-11");
    expect(groupValue("2026-11-03T10:00:00Z", "year")).toBe("2026");
    expect(groupValue(true, null)).toBe("Yes");
    expect(groupValue("", null)).toBeNull();
    expect(groupValue("paid", null)).toBe("paid");
  });
});
