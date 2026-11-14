import { AppDefinitionSchema, type CompileResult } from "@realentity/storm-shared";
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
    expect(ok(compiler.compile({ name: "P", steps: [{ id: "t", type: "notify.telegram", with: { text: "hi" } }] })).definition.needs).toBeUndefined();
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
    expect(errorsOf(compiler.compile({ name: "P", steps: [{ id: "t", type: "notify.telegram", with: { text: "{{setting.a.b}}" } }] }))[0]).toContain(
      "is not a setting: {{setting.<slot>}}",
    );
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
