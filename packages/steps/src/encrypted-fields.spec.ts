import { AppDefinitionSchema, checkFormValues, encryptedFields, listPageOf } from "@realentity/storm-shared";
import { defaultCatalog } from "./catalog";
import { PipelineCompiler } from "./compiler";

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

describe("an encrypted field in a pipeline (M52-T5, T7)", () => {
  const compiler = new PipelineCompiler(defaultCatalog());
  const app = AppDefinitionSchema.parse(secrets);
  const pipeline = (steps: object[]) => ({ name: "Sync", app: "GitHub Secrets", policy: { allowedDomains: ["api.github.com"] }, steps });
  const read = { id: "read", type: "data.read", with: { type: "Secret" } };
  const errors = (steps: object[]) => {
    const result = compiler.compile(pipeline(steps), { app });
    return result.ok ? [] : result.errors.map((e) => `${e.path}: ${e.message}`);
  };

  it("goes into http.request's headers, query and body, and data.save's items; its hash anywhere", () => {
    expect(
      errors([
        read,
        {
          id: "put",
          type: "http.request",
          forEach: "{{read.items}}",
          with: {
            method: "PUT",
            url: "https://api.github.com/repos/me/infra/actions/secrets/{{item.name}}",
            headers: { Authorization: "Bearer {{item.value}}" },
            query: { v: "{{item.note}}" },
            body: { encrypted_value: "{{item.value}}", hash: "{{item.value.hash}}" },
          },
        },
        { id: "copy", type: "data.save", with: { type: "Secret", items: "{{read.items}}" } },
        { id: "tell", type: "notify.telegram", forEach: "{{read.items}}", with: { text: "{{item.name}} changed: {{item.value.hash}}" } },
      ]),
    ).toEqual([]);
  });

  it("is refused anywhere else, saying where it may go", () => {
    expect(
      errors([
        read,
        { id: "tell", type: "notify.telegram", forEach: "{{read.items}}", with: { text: "{{item.name}}: {{item.value}}" } },
        { id: "sort", type: "llm.summarize", forEach: "{{read.items}}", with: { content: "{{item.note}}" } },
        { id: "put", type: "http.request", forEach: "{{read.items}}", with: { method: "POST", url: "{{item.value}}" } },
        { id: "deep", type: "notify.telegram", forEach: "{{read.items}}", with: { text: "{{item.value.ciphertext}}" } },
        { id: "where", type: "data.read", with: { type: "Secret", where: [{ field: "value", op: "eq", value: "x" }], sort: "-note" } },
      ]),
    ).toEqual(
      expect.arrayContaining([
        "steps[1].with.text: {{item.value}} is encrypted: only http.request sends it (in headers, query or body), and data.save keeps it; it never reaches notify.telegram",
        "steps[2].with.content: {{item.note}} is encrypted: only http.request sends it (in headers, query or body), and data.save keeps it; it never reaches llm.summarize",
        "steps[3].with.url: {{item.value}} is encrypted: http.request takes it only in headers, query, body",
        'steps[4].with.text: {{item.value.ciphertext}}: "value" is encrypted: only its hash can be read ({{…value.hash}})',
        "steps[5].with.where[0].field: Secret.value is encrypted: it can't be a condition",
        "steps[5].with.sort: Secret.note is encrypted: it can't be sorted by",
      ]),
    );
  });
});

describe("transforms in a reference (M52-T9)", () => {
  const compiler = new PipelineCompiler(defaultCatalog());
  const app = AppDefinitionSchema.parse(secrets);
  const errors = (steps: object[]) => {
    const result = compiler.compile(
      { name: "Sync", app: "GitHub Secrets", policy: { allowedDomains: ["api.github.com"] }, steps },
      { app },
    );
    return result.ok ? [] : result.errors.map((e) => `${e.path}: ${e.message}`);
  };
  const key = { id: "key", type: "http.fetch", with: { url: "https://api.github.com/repos/me/infra/actions/secrets/public-key" } };
  const read = { id: "read", type: "data.read", with: { type: "Secret" } };
  const put = (body: object, headers: object = {}) => ({
    id: "put",
    type: "http.request",
    forEach: "{{read.items}}",
    with: { method: "PUT", url: "https://api.github.com/repos/me/infra/actions/secrets/{{item.name}}", headers, body },
  });

  it("takes base64 and sealedBox, on an encrypted value or any other", () => {
    expect(
      errors([
        key,
        read,
        put(
          { encrypted_value: "{{item.value | sealedBox: key.json.key}}", key_id: "{{key.json.key_id}}", plain: "{{item.name | base64}}" },
          { Authorization: "Basic {{item.value | base64}}" },
        ),
      ]),
    ).toEqual([]);
  });

  it("refuses an unknown transform, a missing or extra argument, one on a credential, and a transformed secret elsewhere", () => {
    expect(
      errors([
        key,
        read,
        put(
          {
            a: "{{item.value | rot13}}",
            b: "{{item.value | sealedBox}}",
            c: "{{item.name | base64: key.json.key}}",
            d: "{{item.value | sealedBox: nope.key}}",
          },
          {
            Authorization: "{{cred:github | base64}}",
          },
        ),
        { id: "tell", type: "notify.telegram", forEach: "{{read.items}}", with: { text: "{{item.value | base64}}" } },
      ]),
    ).toEqual(
      expect.arrayContaining([
        'steps[2].with.body: {{item.value | rot13}}: there is no transform "rot13" (transforms: base64, sealedBox)',
        "steps[2].with.body: {{item.value | sealedBox}}: sealedBox takes a reference to what it uses, e.g. sealedBox: key.json.key",
        "steps[2].with.body: {{item.name | base64: key.json.key}}: base64 takes nothing after it",
        expect.stringContaining('steps[2].with.body: {{item.value | sealedBox: nope.key}}: {{nope.key}} refers to "nope"'),
        "steps[2].with.headers: {{cred:github | base64}}: a credential takes no transform; it is opened as it is sent",
        "steps[3].with.text: {{item.value}} is encrypted: only http.request sends it (in headers, query or body), and data.save keeps it; it never reaches notify.telegram",
      ]),
    );
  });
});
