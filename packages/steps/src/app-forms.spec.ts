import { AppDefinitionSchema, canMove, checkFormValues, movesFrom, viewPageOf, listPageOf, type CompileResult } from "@realentity/storm-shared";
import { defaultCatalog } from "./catalog";
import { PipelineCompiler } from "./compiler";

const compiler = new PipelineCompiler(defaultCatalog());

const STAGES = {
  field: "status",
  initial: "new",
  states: ["new", "favorite", "applied", "interview", "rejected"],
  moves: [
    { from: "new", to: ["favorite", "applied", "rejected"] },
    { from: "favorite", to: ["applied", "rejected"] },
    { from: ["applied", "new"], to: ["interview", "rejected"], by: ["me", "pipeline"] },
  ],
};

const jobSearch = AppDefinitionSchema.parse({
  name: "Job Search",
  types: {
    Job: {
      key: "url",
      title: "title",
      stages: STAGES,
      fields: {
        url: { type: "url", required: true },
        title: { type: "text", required: true },
        contact: { type: "email" },
        favorite: { type: "yesno", mine: true },
        comments: { type: "longtext", mine: true },
        rating: { type: "number", mine: true },
      },
    },
    Company: {
      mine: true,
      key: "name",
      fields: { name: { type: "text", required: true }, email: { type: "email" }, site: { type: "url" } },
    },
  },
  pages: [
    { form: "Job", fields: ["comments", "favorite"] },
    { view: "Job", actions: [{ label: "Apply", run: "Job submit", when: { status: "favorite" }, confirm: "Apply?" }] },
    { list: "Job", actions: [{ label: "Check now", run: "Job Search collect" }] },
  ],
});

function ok(result: CompileResult): Extract<CompileResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected success, got:\n${result.errors.map((e) => `${e.path}: ${e.message}`).join("\n")}`);
  return result;
}

function errorsOf(result: CompileResult): string[] {
  if (result.ok) throw new Error("expected compile errors");
  return result.errors.map((e) => `${e.path}: ${e.message}`);
}

const inApp = (steps: object[], extra: object = {}) => ({ name: "P", app: "Job Search", steps, ...extra });

// M32-U1
describe("forms, stages and buttons (M32)", () => {
  it("adds the stage as an enum of its states, and moves only as its moves say, by whom", () => {
    const job = jobSearch.types.Job;
    expect(job.fields.status).toEqual({ type: "enum", values: STAGES.states, required: false, mine: false });
    const stages = job.stages!;
    expect(canMove(stages, "new", "favorite", "me")).toBe(true);
    expect(canMove(stages, "new", "favorite", "pipeline")).toBe(false);
    expect(canMove(stages, "applied", "interview", "pipeline")).toBe(true);
    expect(canMove(stages, "interview", "applied", "pipeline")).toBe(false);
    expect(movesFrom(stages, "new", "me")).toEqual(["favorite", "applied", "interview", "rejected"]);
    expect(movesFrom(stages, "rejected", "me")).toEqual([]);
    // Parsing a parsed App again (its JSON copy) gives the same App.
    expect(AppDefinitionSchema.parse(JSON.parse(JSON.stringify(jobSearch)))).toEqual(jobSearch);
  });

  it("refuses stages, forms and buttons that can't work", () => {
    const result = AppDefinitionSchema.safeParse({
      name: "Bad",
      types: {
        Job: {
          key: "url",
          stages: { field: "url", initial: "draft", states: ["new", "new"], moves: [{ from: "old", to: ["gone"] }] },
          fields: { url: { type: "url" }, note: { type: "text", mine: true } },
        },
        Mine: {
          mine: true,
          key: "name",
          stages: { field: "s", initial: "a", states: ["a", "b"], moves: [{ from: "a", to: ["b"], by: ["pipeline"] }] },
          fields: { name: { type: "text" } },
        },
      },
      pages: [
        { form: "Job", fields: ["url", "nope"] },
        {
          view: "Job",
          actions: [
            { label: "Go", run: "X", when: { nope: "a" } },
            { label: "Go", run: "Y" },
          ],
        },
      ],
    });
    expect(result.error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([
      'types.Job.stages.field: "url" is already a field: the stage gets its own',
      "types.Job.stages.states: each state once",
      'types.Job.stages.initial: "draft" is not one of the states',
      'types.Job.stages.moves.0.from: "old" is not one of the states',
      'types.Job.stages.moves.0.to.0: "gone" is not one of the states',
      "types.Mine.stages.moves.0.by: pipelines don't write a type of mine",
      "pages.0.fields.0: Job.url is written by pipelines: a form edits fields of mine",
      'pages.0.fields.1: Job has no field "nope"',
      'pages.1.actions.0.when.nope: Job has no field "nope"',
      'pages.1.actions.1.label: "Go" is used by an earlier button',
    ]);
  });

  it("puts fields of mine on the form, the key of a type of mine off it, and checks each value as its kind", () => {
    expect(viewPageOf(jobSearch, "Job").form.map((f) => f.field)).toEqual(["comments", "favorite"]);
    expect(viewPageOf(jobSearch, "Company").form.map((f) => f.field)).toEqual(["email", "site"]);
    expect(listPageOf(jobSearch, "Company").create?.map((f) => f.field)).toEqual(["name", "email", "site"]);
    expect(listPageOf(jobSearch, "Job").create).toBeNull();
    expect(
      checkFormValues(jobSearch.types.Job, ["comments", "favorite", "rating"], { favorite: "yes", rating: "4", comments: "" }),
    ).toEqual({
      values: { favorite: true, rating: 4, comments: null },
      problems: [],
    });
    expect(checkFormValues(jobSearch.types.Job, ["rating"], { rating: "a lot", title: "x" }).problems).toEqual([
      { field: "rating", message: "isn't a number" },
      { field: "title", message: "isn't on this form" },
    ]);
  });

  describe("pipelines", () => {
    it("never write a type of mine, nor a stage only the user moves", () => {
      expect(
        errorsOf(
          compiler.compile(
            inApp([
              { id: "read", type: "data.read", with: { type: "Job" } },
              { id: "save", type: "data.save", with: { items: "{{read.items}}", type: "Company" } },
              { id: "back", type: "data.save", with: { items: "{{read.items}}", type: "Job" } },
            ]),
            {
              app: AppDefinitionSchema.parse({
                ...jobSearch,
                types: {
                  ...jobSearch.types,
                  Job: {
                    ...jobSearch.types.Job,
                    stages: { ...STAGES, moves: [{ from: "new", to: ["applied"] }] },
                    fields: Object.fromEntries(Object.entries(jobSearch.types.Job.fields).filter(([n]) => n !== "status")),
                  },
                },
              }),
            },
          ),
        ),
      ).toEqual([
        "steps[1].with.type: Company is a type of mine: pipelines read it, only the user writes it",
        "steps[2].with.items: Job.favorite is mine: a pipeline can't write it",
        "steps[2].with.items: Job.comments is mine: a pipeline can't write it",
        "steps[2].with.items: Job.rating is mine: a pipeline can't write it",
        "steps[2].with.items: Job.status is moved only by the user: no move of it is by: [pipeline]",
      ]);
    });

    it("start on a move into a stage, or on an entity's button, typed by the type", () => {
      ok(
        compiler.compile(
          inApp(
            [
              {
                id: "tell",
                type: "notify.telegram",
                with: { text: "{{trigger.item.title}}: {{trigger.stage.from}} → {{trigger.item.status}}" },
              },
            ],
            {
              trigger: { on: "entity.changed", type: "Job", stage: "interview" },
            },
          ),
          { app: jobSearch },
        ),
      );
      ok(
        compiler.compile(
          inApp([{ id: "tell", type: "notify.telegram", with: { text: "{{trigger.action}}: {{trigger.item.comments}}" } }], {
            trigger: { on: "entity.action", type: "Job" },
          }),
          {
            app: jobSearch,
          },
        ),
      );
      expect(
        errorsOf(
          compiler.compile(
            inApp([{ id: "tell", type: "notify.telegram", with: { text: "{{trigger.item.nope}}" } }], {
              trigger: { on: "entity.action", type: "Job" },
            }),
            {
              app: jobSearch,
            },
          ),
        ),
      ).toEqual([
        'steps[0].with.text: {{trigger.item.nope}}: "item" has no field "nope" (fields: url, title, contact, favorite, comments, rating, status)',
      ]);
      expect(
        errorsOf(
          compiler.compile(
            inApp([{ id: "tell", type: "notify.telegram", with: { text: "x" } }], {
              trigger: { on: "entity.changed", type: "Job", stage: "hired" },
            }),
            { app: jobSearch },
          ),
        ),
      ).toEqual(['trigger.stage: "hired" is not a state of Job (states: new, favorite, applied, interview, rejected)']);
      expect(
        errorsOf(
          compiler.compile(
            inApp([{ id: "tell", type: "notify.telegram", with: { text: "x" } }], {
              trigger: { on: "entity.changed", type: "Company", stage: "a" },
            }),
            { app: jobSearch },
          ),
        ),
      ).toEqual(["trigger.stage: Company has no stages"]);
    });

    // M32-S1: a target only from what the user entered, an entity of a type of mine
    it("take a target only from an entity of a type of mine", () => {
      const mail = (to: string) => ({
        id: "mail",
        type: "email.send",
        forEach: "{{read.items}}",
        with: { to, subject: "Hi", body: "Hello" },
      });
      ok(
        compiler.compile(inApp([{ id: "read", type: "data.read", with: { type: "Company" } }, mail("{{item.email}}")]), { app: jobSearch }),
      );
      expect(
        errorsOf(
          compiler.compile(inApp([{ id: "read", type: "data.read", with: { type: "Job" } }, mail("{{item.contact}}")]), { app: jobSearch }),
        ),
      ).toEqual([
        "steps[1].with.to: {{item.contact}} can't be a target: Job is written by pipelines, from what pages, feeds or emails said; only a type of mine can be",
      ]);
      const send = (to: string, type: string) =>
        compiler.compile(
          inApp([{ id: "mail", type: "email.send", with: { to, subject: "Hi", body: "Hello" } }], {
            trigger: { on: "entity.action", type },
          }),
          { app: jobSearch },
        );
      ok(send("{{trigger.item.email}}", "Company"));
      expect(errorsOf(send("{{trigger.item.contact}}", "Job"))).toEqual([
        "steps[0].with.to: {{trigger.item.contact}} can't be a target: an entity holds what a pipeline read from pages, feeds or emails (only a type of mine can be)",
      ]);
    });
  });
});
