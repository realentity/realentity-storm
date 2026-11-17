import { AppDefinitionSchema, checkFormValues, encryptedFields, listPageOf } from "@realentity/storm-shared";

const secrets = {
  name: "GitHub Secrets",
  types: {
    Secret: {
      key: "name",
      fields: {
        name: { type: "text", required: true },
        repository: { type: "text", required: true },
        value: { type: "text", encrypted: true },
        note: { type: "longtext", encrypted: true },
      },
    },
  },
};

const issues = (app: object) => {
  const result = AppDefinitionSchema.safeParse(app);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("encrypted fields (M52)", () => {
  describe("an App's definition", () => {
    it("takes encrypted on a text or longtext field", () => {
      const app = AppDefinitionSchema.parse(secrets);
      expect(encryptedFields(app.types.Secret)).toEqual(["value", "note"]);
    });

    it("refuses it on another kind, the key, the title and a currency", () => {
      expect(
        issues({
          name: "Bad",
          types: {
            Thing: {
              key: "name",
              title: "label",
              fields: {
                name: { type: "text", encrypted: true },
                label: { type: "text", encrypted: true },
                amount: { type: "money", currency: "code" },
                code: { type: "text", encrypted: true },
                pin: { type: "number", encrypted: true },
              },
            },
          },
        }),
      ).toEqual(
        expect.arrayContaining([
          "types.Thing.fields.name.encrypted: the key names the entity, so it can't be encrypted",
          "types.Thing.fields.label.encrypted: the title is shown, so it can't be encrypted",
          "types.Thing.fields.code.encrypted: a currency is shown, so it can't be encrypted",
          "types.Thing.fields.pin.encrypted: only text and longtext can be encrypted, not number",
        ]),
      );
    });

    it("refuses a list page that shows, searches, sorts or groups by one", () => {
      expect(
        issues({
          ...secrets,
          pages: [{ list: "Secret", columns: ["name", "value"], search: ["note"], sort: "-value", group: { by: "value" } }],
        }),
      ).toEqual([
        "pages.0.columns.1: Secret.value is encrypted: it can't be a column",
        "pages.0.search.0: Secret.note is encrypted: it can't be searched",
        "pages.0.sort: Secret.value is encrypted: it can't be sorted by",
        "pages.0.group.by: Secret.value is encrypted: it can't be grouped by",
      ]);
    });

    it("takes one on a form and on the entity's page", () => {
      expect(
        issues({
          ...secrets,
          pages: [
            { form: "Secret", fields: ["repository", "value"] },
            { view: "Secret", fields: ["repository", "value"] },
          ],
        }),
      ).toEqual([]);
    });

    it("leaves it out of a list's default columns and search", () => {
      const page = listPageOf(AppDefinitionSchema.parse(secrets), "Secret");
      expect(page.columns.map((c) => c.field)).toEqual(["name", "repository"]);
      expect(page.search).toEqual(["name", "repository"]);
    });
  });
});

describe("an encrypted field's value (M52)", () => {
  const type = AppDefinitionSchema.parse(secrets).types.Secret;

  it("is never cut short: a value too long is refused", () => {
    expect(checkFormValues(type, ["value"], { value: "x".repeat(1001) }).problems).toEqual([
      { field: "value", message: "is longer than 1000 characters (a longtext takes more)" },
    ]);
    expect(checkFormValues(type, ["value"], { value: "x".repeat(1000) }).problems).toEqual([]);
  });
});
