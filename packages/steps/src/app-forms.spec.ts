import { addedByHand, AppDefinitionSchema, canMove, checkEntity, checkFormValues, movesFrom, viewPageOf, listPageOf, type CompileResult } from "@realentity/storm-shared";
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
      "pages.0.fields.0: Job.url is its stage: it moves by its buttons, not on the form",
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

// M45-U1, M45-S1
describe("entities kept by me and pipelines together (M45)", () => {
  const tasks = AppDefinitionSchema.parse({
    name: "Tasks",
    types: {
      Task: {
        key: "title",
        stages: { field: "state", initial: "open", states: ["open", "done"], moves: [{ from: "open", to: ["done"], by: ["me", "pipeline"] }] },
        fields: {
          title: { type: "text", required: true },
          due: { type: "date" },
          owner: { type: "email" },
          note: { type: "longtext", mine: true },
        },
      },
    },
    pages: [
      { list: "Task", add: true },
      { form: "Task", fields: ["due", "owner", "note"] },
    ],
  });

  it("adds by hand on the key and the form's fields, and edits any field but the key and the stage", () => {
    expect(addedByHand(tasks, "Task")).toBe(true);
    expect(addedByHand(jobSearch, "Job")).toBe(false);
    expect(addedByHand(jobSearch, "Company")).toBe(true);
    expect(listPageOf(tasks, "Task").create?.map((f) => f.field)).toEqual(["title", "due", "owner", "note"]);
    expect(viewPageOf(tasks, "Task").form.map((f) => f.field)).toEqual(["due", "owner", "note"]);
    expect(viewPageOf(tasks, "Task").remove).toBe(true);
    expect(viewPageOf(jobSearch, "Job").remove).toBe(false);
  });

  it("refuses adding by hand without a required field on the form, and the stage on a form", () => {
    const result = AppDefinitionSchema.safeParse({
      ...tasks,
      types: { Task: { ...tasks.types.Task, fields: { ...tasks.types.Task.fields, project: { type: "text", required: true } } } },
      pages: [
        { list: "Task", add: true },
        { form: "Task", fields: ["due", "state"] },
      ],
    });
    expect(result.error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([
      "pages.0.add: Task.project is required: put it on Task's form to add one by hand",
      "pages.1.fields.1: Task.state is its stage: it moves by its buttons, not on the form",
    ]);
  });

  it("refuses a complete save of a type added by hand, and never takes a target from it", () => {
    const save = (complete: boolean) =>
      compiler.compile(
        {
          name: "P",
          app: "Tasks",
          steps: [
            { id: "save", type: "data.save", with: { items: [{ title: "Renew the passport" }], type: "Task", complete } },
          ],
        },
        { app: tasks },
      );
    ok(save(false));
    expect(errorsOf(save(true))).toEqual([
      "steps[0].with.complete: Task is added by hand too: a pipeline's list isn't the whole of it, so it can't be complete",
    ]);
    expect(
      errorsOf(
        compiler.compile(
          {
            name: "P",
            app: "Tasks",
            steps: [
              { id: "read", type: "data.read", with: { type: "Task" } },
              { id: "mail", type: "email.send", forEach: "{{read.items}}", with: { to: "{{item.owner}}", subject: "Due", body: "Hi" } },
            ],
          },
          { app: tasks },
        ),
      ),
    ).toEqual([
      "steps[1].with.to: {{item.owner}} can't be a target: Task is written by pipelines, from what pages, feeds or emails said; only a type of mine can be",
    ]);
  });
});

// M46-U1: a file or an image is held as a reference; a pipeline gives one file.keep kept
describe("files and images (M46)", () => {
  const papers = AppDefinitionSchema.parse({
    name: "Papers",
    types: { Paper: { key: "title", fields: { title: { type: "text", required: true }, scan: { type: "image" }, receipt: { type: "file" } } } },
    pages: [{ list: "Paper", add: true }, { form: "Paper", fields: ["scan", "receipt"] }],
  });
  const id = "1b671a64-40d5-491e-99b0-da01e8a64ba1";

  it("takes an uploaded file's id on the form, nothing else", () => {
    expect(checkFormValues(papers.types.Paper, ["scan", "receipt"], { scan: id, receipt: { id: id.toUpperCase() } })).toEqual({
      values: { scan: { id }, receipt: { id } },
      problems: [],
    });
    expect(checkFormValues(papers.types.Paper, ["scan"], { scan: "https://example.org/a.png" }).problems).toEqual([
      { field: "scan", message: "isn't an uploaded file" },
    ]);
  });

  it("takes a file's reference from what a pipeline saves (the worker attaches it), nothing else", () => {
    expect(checkEntity(papers.types.Paper, { title: "Oven", scan: { id, name: "a.jpg", mime: "image/jpeg", size: 1 }, receipt: "https://example.org/r.pdf" })).toEqual({
      value: { title: "Oven", scan: { id } },
      key: "Oven",
      problems: ["receipt isn't an uploaded file"],
      rejected: false,
    });
  });

  it("compiles a receipt by email kept as a Paper's file, and its photo read by the model (docs/capabilities.md)", () => {
    ok(
      compiler.compile(
        {
          name: "Receipts",
          app: "Papers",
          trigger: { schedule: "0 8 * * *" },
          steps: [
            { id: "receipts", type: "email.fetch", with: { mailbox: "INBOX" } },
            { id: "keep", type: "file.keep", forEach: "{{receipts.messages}}", with: { type: "Paper", field: "receipt", message: "{{item}}" } },
            { id: "save", type: "data.save", forEach: "{{receipts.messages}}", with: { type: "Paper", items: [{ title: "{{item.subject}}", receipt: "{{keep.first}}" }] } },
          ],
        },
        { app: papers },
      ),
    );
    ok(
      compiler.compile(
        {
          name: "Read a paper",
          app: "Papers",
          trigger: { on: "entity.changed", type: "Paper" },
          steps: [{ id: "read", type: "llm.extract", with: { files: ["{{trigger.item.scan}}"], fields: { merchant: "the shop" } } }],
        },
        { app: papers },
      ),
    );
  });

  it("keeps a file only into a file field of the App's types that pipelines write", () => {
    const keep = (type: string, field: string, app = papers) =>
      compiler.compile({ name: "P", app: "Papers", steps: [{ id: "keep", type: "file.keep", with: { type, field, artifact: id } }] }, { app });
    ok(keep("Paper", "scan"));
    expect(errorsOf(keep("Paper", "title"))).toEqual(["steps[0].with.field: Paper.title isn't a file or an image (those: scan, receipt)"]);
    expect(errorsOf(keep("Note", "scan"))).toEqual(['steps[0].with.type: "Papers" has no type "Note" (types: Paper)']);
    const mine = AppDefinitionSchema.parse({ ...papers, types: { Paper: { ...papers.types.Paper, fields: { ...papers.types.Paper.fields, scan: { type: "image", mine: true } } } } });
    expect(errorsOf(keep("Paper", "scan", mine))).toEqual(["steps[0].with.field: Paper.scan is mine: a pipeline can't write it"]);
    expect(errorsOf(compiler.compile({ name: "P", steps: [{ id: "keep", type: "file.keep", with: { type: "Paper", field: "scan", artifact: id } }] }))).toEqual([
      "steps[0].with.type: files belong to an App: say which with `app:` at the top of the pipeline",
    ]);
  });
});

// M48: a key Storm makes
describe("auto keys (M48)", () => {
  const todo = AppDefinitionSchema.parse({
    name: "Todo",
    types: { Task: { key: "id", title: "title", fields: { id: { type: "text", auto: true }, title: { type: "text", required: true } } } },
    pages: [{ list: "Task", add: true }, { form: "Task", fields: ["title"] }],
  });

  it("isn't asked for on the form, and is made for a pipeline's new item without it", () => {
    expect(listPageOf(todo, "Task").create?.map((f) => f.field)).toEqual(["title"]);
    const made = checkEntity(todo.types.Task, { title: "Water the plants" });
    expect(made).toMatchObject({ rejected: false, problems: [] });
    expect(made.key).toMatch(/^[a-z0-9]{12}$/);
    expect(checkEntity(todo.types.Task, { id: "t1", title: "Water the plants" }).key).toBe("t1");
  });

  it("is only the key, and text", () => {
    const issues = (fields: object, key = "id") =>
      AppDefinitionSchema.safeParse({ name: "Bad", types: { Task: { key, fields } } }).error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    expect(issues({ id: { type: "number", auto: true } })).toEqual(["types.Task.fields.id.auto: a key Storm makes is text"]);
    expect(issues({ id: { type: "text" }, title: { type: "text", auto: true } })).toEqual(["types.Task.fields.title.auto: only the key is made by Storm"]);
  });
});
