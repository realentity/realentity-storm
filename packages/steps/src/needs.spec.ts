import { AppDefinitionSchema, readAppPackage, readAppSource, slotsUsed, type CompileResult } from "@realentity/storm-shared";
import { exampleFiles } from "@realentity/storm-shared/example-files";
import { defaultCatalog } from "./catalog";
import { PipelineCompiler } from "./compiler";

const compiler = new PipelineCompiler(defaultCatalog());

function ok(result: CompileResult): Extract<CompileResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected success, got:\n${result.errors.map((e) => `${e.path}: ${e.message}`).join("\n")}`);
  return result;
}

function errorsOf(result: CompileResult): string[] {
  if (result.ok) throw new Error("expected compile errors");
  return result.errors.map((e) => `${e.path}: ${e.message}`);
}

const ISSUE = {
  id: "issue",
  type: "http.request",
  with: {
    method: "POST",
    url: "https://api.github.com/repos/{{setting.repository}}/issues",
    headers: { Authorization: "Bearer {{cred:github}}" },
    body: { title: "Down" },
  },
};

// M50-U1: slots, not names
describe("needs (M50)", () => {
  it("takes the slots it declares, and adds those its steps use: a database for db.query, a host when it is written", () => {
    const result = ok(
      compiler.compile({
        name: "P",
        policy: { allowedDomains: ["api.example.org"], allowedRecipients: [] },
        needs: { github: { kind: "credential", type: "api_key", for: "api.github.com", label: "GitHub" } },
        steps: [
          ISSUE,
          { id: "rows", type: "db.query", with: { connection: "{{cred:app-db}}", sql: "SELECT 1" } },
          { id: "feed", type: "http.fetch", with: { url: "https://api.example.org/v1/feed", headers: { "X-Key": "{{cred:feed}}" } } },
        ],
      }),
    );
    expect(result.definition.needs).toEqual({
      github: { kind: "credential", type: "api_key", for: "api.github.com", label: "GitHub" },
      repository: { kind: "text" },
      "app-db": { kind: "credential", type: "database" },
      feed: { kind: "credential", for: "api.example.org" },
    });
    // Without slots, none.
    expect(
      ok(compiler.compile({ name: "P", steps: [{ id: "t", type: "notify.telegram", with: { text: "hi" } }] })).definition.needs,
    ).toBeUndefined();
  });

  it("M50-T7: an email step's account written as a name is an email slot; one from data ({{…}}) is not; a credential slot isn't one", () => {
    const reply = {
      id: "send",
      type: "email.send",
      forEach: "{{fetch.messages}}",
      with: { to: "a@example.org", subject: "Hi", body: "Hi", account: "{{item.account}}" },
    };
    const result = ok(
      compiler.compile({
        name: "P",
        policy: { allowedDomains: [], allowedRecipients: ["a@example.org"] },
        steps: [{ id: "fetch", type: "email.fetch", with: { account: "work" } }, reply],
      }),
    );
    expect(result.definition.needs).toEqual({ work: { kind: "email" } });
    expect(
      errorsOf(
        compiler.compile({
          name: "P",
          needs: { work: { kind: "credential" } },
          steps: [{ id: "fetch", type: "email.fetch", with: { account: "work" } }],
        }),
      ),
    ).toEqual(['steps[0].with.account: "work" is a credential, not an email account']);
  });

  it("M50-T16: email.fetch's account: topics is the topics' mailboxes, not a slot; on other steps refused", () => {
    expect(
      ok(compiler.compile({ name: "P", steps: [{ id: "fetch", type: "email.fetch", with: { account: "topics" } }] })).definition.needs,
    ).toBeUndefined();
    expect(
      errorsOf(
        compiler.compile({
          name: "P",
          policy: { allowedDomains: [], allowedRecipients: ["a@example.org"] },
          steps: [{ id: "send", type: "email.send", with: { to: "a@example.org", subject: "Hi", body: "Hi", account: "topics" } }],
        }),
      ),
    ).toEqual(['steps[0].with.account: only email.fetch reads "topics" (the mailboxes your topics read)']);
  });

  it("M50-T8: a calendar step's account is a google slot for the calendar; one declared for Drive only is refused", () => {
    const find = { id: "free", type: "calendar.find", with: { account: "work", calendar: "{{setting.calendar}}" } };
    expect(ok(compiler.compile({ name: "P", steps: [find] })).definition.needs).toEqual({
      work: { kind: "google", uses: ["calendar"] },
      calendar: { kind: "text" },
    });
    expect(errorsOf(compiler.compile({ name: "P", needs: { work: { kind: "google", uses: ["drive"] } }, steps: [find] }))).toEqual([
      'steps[0].with.account: "work" is a Google account for drive: add calendar to its uses',
    ]);
    expect(errorsOf(compiler.compile({ name: "P", needs: { work: { kind: "email" } }, steps: [find] }))).toEqual([
      'steps[0].with.account: "work" is an email account, not a Google account',
    ]);
  });

  it("uses each slot as what it is: a credential isn't a setting, nor a setting a credential, nor an API key a database", () => {
    expect(
      errorsOf(
        compiler.compile({
          name: "P",
          needs: { repository: { kind: "credential" }, github: { kind: "text" }, db: { kind: "credential", type: "api_key" } },
          steps: [ISSUE, { id: "rows", type: "db.query", with: { connection: "{{cred:db}}", sql: "SELECT 1" } }],
        }),
      ),
    ).toEqual([
      'steps[0].with.url: "repository" is a credential, not a setting: {{cred:repository}}',
      'steps[0].with.headers: "github" is a setting (text), not a credential: {{setting.github}}',
      'steps[1].with.connection: "db" is a api_key credential; db.query\'s connection is a database',
    ]);
    expect(
      errorsOf(compiler.compile({ name: "P", steps: [{ id: "t", type: "notify.telegram", with: { text: "{{setting.a.b}}" } }] }))[0],
    ).toContain("is not a setting: {{setting.<slot>}}");
  });

  it("leaves a slot its App declares to the App: each install fills it", () => {
    const app = AppDefinitionSchema.parse({
      name: "Ops",
      types: { Incident: { key: "id", fields: { id: { type: "text" } } } },
      needs: { github: { kind: "credential", for: "api.github.com" }, repository: { kind: "text", example: "me/infra" } },
    });
    const result = ok(compiler.compile({ name: "P", app: "Ops", steps: [ISSUE] }, { app }));
    expect(result.definition.needs).toBeUndefined();
  });
});

// A pipeline of an App needs only the App's slots it uses (Server ops' monitors switched on without its database)
describe("slotsUsed", () => {
  it("finds {{cred:…}} and {{setting.…}} anywhere in a step's inputs, and an account step's account by name", () => {
    expect(
      slotsUsed([
        ISSUE,
        { type: "db.query", with: { connection: "{{ cred:orders-db }}", sql: "SELECT 1" } },
        { type: "notify.telegram", with: { text: "{{setting.greeting}} and {{setting.greeting}}" } },
        { type: "email.send", with: { to: "a@mail.example", subject: "x", body: "y", account: "work" } },
        { type: "calendar.create", with: { title: "x", account: "personal" } },
      ]),
    ).toEqual(new Set(["repository", "github", "orders-db", "greeting", "work", "personal"]));
  });

  it("not: email.fetch's topics, an account from data, an `account` on another step, a step's other parts, a reference that isn't one", () => {
    expect(
      slotsUsed([
        { type: "email.fetch", with: { account: "topics" } },
        { type: "email.send", with: { to: "a@mail.example", account: "{{item.account}}" } },
        { type: "http.request", with: { account: "billing", url: "https://api.example.com/{{cred}}", body: { note: "cred:token setting.title" } } },
        { type: "notify.telegram" },
      ]),
    ).toEqual(new Set());
  });

  it("agrees with the compiler on every example: a pipeline's own slots are ones it uses, its App's all used by one of its pipelines", () => {
    for (const [id, text] of Object.entries(exampleFiles())) {
      const documents = readAppPackage(text).documents;
      const app = readAppSource(documents[0].source);
      const usedByApp = new Set<string>();
      for (const document of documents.slice(1)) {
        const result = ok(compiler.compileText(document.source, { app }));
        const used = slotsUsed(result.definition.steps);
        used.forEach((slot) => usedByApp.add(slot));
        const declared = new Set([...Object.keys(result.definition.needs ?? {}), ...Object.keys(app.needs ?? {})]);
        expect({ id, pipeline: document.key, undeclared: [...used].filter((s) => !declared.has(s)) }).toEqual({ id, pipeline: document.key, undeclared: [] });
        const unused = Object.keys(result.definition.needs ?? {}).filter((s) => !used.has(s));
        expect({ id, pipeline: document.key, unused }).toEqual({ id, pipeline: document.key, unused: [] });
      }
      expect({ id, unusedAppSlots: Object.keys(app.needs ?? {}).filter((s) => !usedByApp.has(s)) }).toEqual({ id, unusedAppSlots: [] });
    }
    // Server ops: only Database check reads the database.
    const ops = readAppPackage(exampleFiles()["server-ops"]).documents;
    const opsApp = readAppSource(ops[0].source);
    const using = ops.slice(1).filter((d) => slotsUsed(ok(compiler.compileText(d.source, { app: opsApp })).definition.steps).has("database"));
    expect(using.map((d) => d.key)).toEqual(["database-check"]);
  });
});
