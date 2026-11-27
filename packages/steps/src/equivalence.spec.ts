import { AppDefinitionSchema, readAppPackage, readAppSource, type CompiledDefinition } from "@realentity/storm-shared";
import { examplePipelineFiles, exampleFiles, exampleYaml } from "@realentity/storm-shared/example-files";
import { defaultCatalog } from "./catalog";
import { PipelineCompiler } from "./compiler";
import { appDifferences, capabilities, capabilitiesUsed, pipelineDifferences, type AppWithPipelines } from "./equivalence";

const catalog = defaultCatalog();
const compiler = new PipelineCompiler(catalog);

/** An example App with its pipelines, each compiled against it. */
function exampleApp(id: string): AppWithPipelines {
  const documents = readAppPackage(exampleFiles()[id]).documents;
  const app = readAppSource(documents[0].source);
  const pipelines = documents.slice(1).map((d) => {
    const result = compiler.compileText(d.source, { app });
    if (!result.ok) throw new Error(`${id} / ${d.key}: ${result.errors.map((e) => e.message).join("; ")}`);
    return result.definition;
  });
  return { app, pipelines };
}

const standalone = (file: string): CompiledDefinition => {
  const result = compiler.compileText(exampleYaml(file));
  if (!result.ok) throw new Error(file);
  return result.definition;
};

/** Ids renamed throughout, as the builder may name them otherwise. */
function renamed(definition: CompiledDefinition): CompiledDefinition {
  const ids = new Map(definition.steps.map((s, i) => [s.id, `step${i}`]));
  let text = JSON.stringify(definition);
  for (const [from, to] of ids) {
    text = text
      .replaceAll(`"id":"${from}"`, `"id":"${to}"`)
      .replaceAll(`"for":"${from}"`, `"for":"${to}"`)
      .replace(new RegExp(`\\{\\{(\\s*)${from}(?=[.}\\s\\[])`, "g"), `{{$1${to}`);
  }
  return JSON.parse(text) as CompiledDefinition;
}

// M67-T1: the builder's eval compares what it proposed with the example on what matters, not on wording
describe("the builder's eval: equivalent to an example (M67)", () => {
  it("every example App and every pipeline is equivalent to itself, ids renamed and its pipelines in another order", () => {
    for (const id of Object.keys(exampleFiles())) {
      const app = exampleApp(id);
      expect([id, appDifferences(app, app, catalog)]).toEqual([id, []]);
      const shuffled = { app: app.app, pipelines: [...app.pipelines].reverse().map(renamed) };
      expect([id, appDifferences(app, shuffled, catalog)]).toEqual([id, []]);
    }
    for (const file of examplePipelineFiles().filter((f) => !f.includes("/"))) {
      if (!Object.values(exampleFiles()).some((text) => text.includes(`\n  ${file.replace(/\.yaml$/, "")}:\n`))) {
        const pipeline = standalone(file);
        expect([file, pipelineDifferences(pipeline, renamed(pipeline), catalog)]).toEqual([file, []]);
      }
    }
  });

  it("a pipeline: its wording, order and shaping steps may differ; its trigger, kinds of steps, side effects, slots and limits may not", () => {
    const replies = standalone("recruiter-replies.yaml");
    const reworded = structuredClone(replies);
    reworded.name = "Answer recruiters";
    for (const step of reworded.steps) if (typeof step.with.instruction === "string") step.with.instruction = "Write a reply.";
    expect(pipelineDifferences(replies, reworded, catalog)).toEqual([]);

    // In another order, a step that shapes data more, one that tells me or reads more, a reply out of its thread: the same.
    const send = replies.steps.find((s) => s.type === "email.send")!;
    const loose = structuredClone(replies);
    loose.steps.reverse();
    loose.steps.push(
      { id: "shape", type: "data.map", with: { items: "{{fetch.messages}}", value: "{{item.subject}}" } },
      { id: "tell", type: "notify.telegram", with: { message: "Replied." } },
      { id: "look", type: "data.read", with: { type: "Note" } },
    );
    const { inReplyTo: _, ...unthreaded } = send.with;
    loose.steps.find((s) => s.id === send.id)!.with = { ...unthreaded, to: "{{item.replyTo}}" };
    expect(pipelineDifferences(replies, loose, catalog)).toEqual([]);

    const changed = structuredClone(replies);
    changed.trigger = { schedule: "*/30 * * * *", tz: "Europe/Sofia" };
    changed.steps = changed.steps.filter((s) => s.type !== "gate.act").map((s) => (s.id === send.id ? { ...s, forEach: undefined } : s));
    changed.limits = Object.fromEntries(Object.keys(replies.limits ?? {}).map((k) => [k, "1/day"]));
    const problems = pipelineDifferences(replies, changed, catalog);
    expect(problems.map((p) => p.split(":")[0])).toEqual(["trigger", "steps", "side effects", "limits"]);
    expect(problems[2]).toContain("email.send once");

    // An LLM step more is another design; so is a reply to an address another step wrote.
    const classified = structuredClone(replies);
    classified.steps.push({ id: "score", type: "llm.score", with: { items: "{{fetch.messages}}", instruction: "How urgent?" } });
    expect(pipelineDifferences(replies, classified, catalog)).toEqual([expect.stringMatching(/^steps: .*"llm\.score"/)]);
    const elsewhere = structuredClone(replies);
    elsewhere.steps.find((s) => s.id === send.id)!.with = { ...send.with, to: "{{draft.subject}}" };
    expect(pipelineDifferences(replies, elsewhere, catalog)).toEqual([expect.stringMatching(/^side effects: .*to from email\.draftReply/)]);

    // A limit more is a stricter cap: fine. The example's limit left out, or another value: not.
    const stricter = structuredClone(replies);
    stricter.limits = { ...stricter.limits, "email.fetch": "100/day" };
    expect(pipelineDifferences(replies, stricter, catalog)).toEqual([]);
    const [limited] = Object.keys(replies.limits ?? {});
    expect(limited).toBeDefined();
    const looser = structuredClone(replies);
    looser.limits = {};
    expect(pipelineDifferences(replies, looser, catalog)).toEqual([expect.stringMatching(/^limits: /)]);

    // A slot more: a credential it didn't use.
    const tables = exampleApp("tables").pipelines[0];
    const fewer = structuredClone(tables);
    fewer.steps[0].with = { ...fewer.steps[0].with, connection: "postgresql://reader@db.example/app" };
    expect(pipelineDifferences(tables, fewer, catalog)).toEqual(["credentials: expected 1, got 0"]);
    // A setting more (what it hard-coded, made mine to set): fine.
    const settable = structuredClone(tables);
    settable.steps[0].with = { ...settable.steps[0].with, sql: "SELECT {{setting.tables}}" };
    expect(pipelineDifferences(tables, settable, catalog)).toEqual([]);
  });

  it("an App: its types, keys, fields of mine, stages, added by hand, reports, slots, uses and pipelines", () => {
    const bills = exampleApp("bills");
    const app = (edit: (definition: Record<string, unknown>) => void): AppWithPipelines => {
      const raw = structuredClone(bills.app) as unknown as Record<string, unknown>;
      edit(raw);
      return { app: AppDefinitionSchema.parse(raw), pipelines: bills.pipelines };
    };
    type Raw = { types: Record<string, { key: string; mine?: boolean; fields: Record<string, { type?: string; mine?: boolean }>; stages?: { states: string[]; moves: unknown[] } }> };
    const [typeName] = Object.keys(bills.app.types);
    const type = (raw: Record<string, unknown>) => (raw as unknown as Raw).types[typeName];

    expect(appDifferences(bills, app((raw) => (raw.description = "Other words")), catalog)).toEqual([]);
    // Keyed by a field of another kind; of the same kind, named otherwise, is the same.
    const kind = (raw: Record<string, unknown>, f: string) => type(raw).fields[f].type;
    const keyed = appDifferences(bills, app((raw) => (type(raw).key = Object.keys(type(raw).fields).find((f) => kind(raw, f) === "email")!)), catalog);
    expect(keyed).toEqual([expect.stringMatching(new RegExp(`^${typeName}: expected .*"key"`))]);
    // A field of mine more is fine (one more for me to write); one less is not.
    const field = Object.keys(bills.app.types[typeName].fields).find((f) => f !== bills.app.types[typeName].key && !bills.app.types[typeName].fields[f].mine && !bills.app.types[typeName].fields[f].required)!;
    expect(appDifferences(bills, app((raw) => (type(raw).fields[field].mine = true)), catalog)).toEqual([]);
    const papers = exampleApp("papers");
    const raw = structuredClone(papers.app) as unknown as Raw;
    raw.types.Paper.fields.seller.mine = false;
    expect(appDifferences(papers, { app: AppDefinitionSchema.parse(raw), pipelines: papers.pipelines }, catalog)).toEqual(['Paper: fields of mine missing: ["ref"]']);
    expect(appDifferences(bills, app((raw) => ((raw as unknown as Raw).types.Extra = { key: "id", fields: { id: { type: "text" } } })), catalog)).toEqual([
      expect.stringMatching(/^types: expected \[.*\], got \[.*"Extra".*\]$/),
    ]);
    // A text setting more is fine; a credential more, or one less, is not.
    expect(appDifferences(bills, app((raw) => (raw.needs = { ...(raw.needs as object), extra: { kind: "text" } })), catalog)).toEqual([]);
    expect(appDifferences(bills, app((raw) => (raw.needs = { ...(raw.needs as object), key: { kind: "credential", type: "api_key" } })), catalog)).toEqual([
      expect.stringMatching(/^credential slots: /),
    ]);
    const tables = exampleApp("tables");
    const fewer2 = { app: AppDefinitionSchema.parse({ ...tables.app, needs: {} }), pipelines: tables.pipelines };
    expect(appDifferences(tables, fewer2, catalog)).toEqual(['credential slots: expected ["credential:database"], got []']);
    // An email or Google account slot is the default account otherwise: either is fine.
    expect(appDifferences(bills, app((raw) => (raw.needs = { ...(raw.needs as object), mail: { kind: "email" }, google: { kind: "google" } })), catalog)).toEqual([]);
    expect(appDifferences(bills, app((raw) => (raw.uses = { Card: { from: { app: "Cards", type: "Card" }, fields: ["number"] } })), catalog)).toEqual([
      'uses: expected [], got ["Card ← Cards › Card"]',
    ]);

    // A pipeline left out; one that differs, named by the example's.
    const fewer = { app: bills.app, pipelines: bills.pipelines.slice(1) };
    expect(appDifferences(bills, fewer, catalog)).toEqual(expect.arrayContaining([`pipelines: expected ${bills.pipelines.length}, got ${bills.pipelines.length - 1}`]));
    const otherwise = { app: bills.app, pipelines: bills.pipelines.map((p, i) => (i === 0 ? { ...p, trigger: "manual" as const } : p)) };
    expect(appDifferences(bills, otherwise, catalog)).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^pipeline "${bills.pipelines[0].name}": trigger`))]));
  });

  it("stages: their states and initial, and at least the moves pipelines make; the ones I make, and staying put, may differ", () => {
    const quotes = exampleApp("quotes");
    type Moves = { from: string | string[]; to: string[]; by: string[] }[];
    const withMoves = (edit: (moves: Moves) => Moves, states?: string[]) => {
      const raw = structuredClone(quotes.app) as unknown as { types: { Quote: { fields: Record<string, unknown>; stages: { field: string; states: string[]; moves: Moves } } } };
      // As written: the stage isn't one of its fields (parsing adds it).
      delete raw.types.Quote.fields[raw.types.Quote.stages.field];
      raw.types.Quote.stages.moves = edit(raw.types.Quote.stages.moves);
      if (states) raw.types.Quote.stages.states = states;
      return { app: AppDefinitionSchema.parse(raw), pipelines: quotes.pipelines };
    };
    // Mine left out, mine made a pipeline's too, a pipeline's more, staying put: the same.
    expect(appDifferences(quotes, withMoves((moves) => moves.filter((m) => m.by.includes("pipeline"))), catalog)).toEqual([]);
    expect(appDifferences(quotes, withMoves((moves) => moves.map((m) => ({ ...m, by: ["me", "pipeline"] }))), catalog)).toEqual([]);
    expect(appDifferences(quotes, withMoves((moves) => [...moves, { from: "quoted", to: ["quoted"], by: ["pipeline"] }]), catalog)).toEqual([]);
    // A pipeline's move left out, or a state more: not.
    expect(appDifferences(quotes, withMoves((moves) => moves.slice(1)), catalog)).toEqual(['Quote: moves by a pipeline missing: ["asked→quoted"]']);
    const more = withMoves((moves) => moves, ["asked", "quoted", "accepted", "declined", "expired"]);
    expect(appDifferences(quotes, more, catalog)).toEqual([expect.stringMatching(/^Quote: expected .*"states"/)]);
  });

  it("a trigger by what it points at: not a command's help text, a field by its kind, another pipeline by its short name", () => {
    const papers = exampleApp("papers");
    const apps = { expected: papers.app, actual: papers.app };
    const onField = papers.pipelines.find((p) => typeof p.trigger === "object" && "on" in p.trigger && p.trigger.on === "entity.changed" && p.trigger.field === "warrantyUntil")!;
    const fields = papers.app.types.Paper.fields;
    const otherDate = Object.keys(fields).find((f) => f !== "warrantyUntil" && fields[f].type === fields.warrantyUntil.type)!;
    const otherKind = Object.keys(fields).find((f) => fields[f].type !== fields.warrantyUntil.type)!;
    const withField = (field: string) => ({ ...onField, trigger: { on: "entity.changed" as const, type: "Paper", field } });
    expect(pipelineDifferences(onField, withField(otherDate), catalog, apps)).toEqual([]);
    expect(pipelineDifferences(onField, withField(otherKind), catalog, apps)).toEqual([expect.stringMatching(/^trigger: /)]);

    const command = papers.pipelines.find((p) => typeof p.trigger === "object" && "on" in p.trigger && p.trigger.on === "telegram.command")!;
    const reworded = { ...command, trigger: { ...(command.trigger as object), description: "Other words" } } as CompiledDefinition;
    expect(pipelineDifferences(command, reworded, catalog)).toEqual([]);
    const renamed = { ...command, trigger: { ...(command.trigger as object), command: "receipt" } } as CompiledDefinition;
    expect(pipelineDifferences(command, renamed, catalog)).toEqual([expect.stringMatching(/^trigger: /)]);

    const releases = exampleApp("releases");
    const onRun = releases.pipelines.find((p) => typeof p.trigger === "object" && "on" in p.trigger && p.trigger.on === "run.finished")!;
    const trigger = onRun.trigger as { on: "run.finished"; pipeline: string };
    expect(trigger.pipeline).toContain(" · ");
    const short = { ...onRun, trigger: { ...trigger, pipeline: trigger.pipeline.split(" · ")[1] } };
    expect(pipelineDifferences(onRun, short, catalog)).toEqual([]);
    expect(pipelineDifferences(onRun, { ...onRun, trigger: { ...trigger, pipeline: "Another" } }, catalog)).toEqual([expect.stringMatching(/^trigger: /)]);
  });
});

// M67-T4: the capability matrix: what the examples use, and what none does (the cases to add)
describe("the capability matrix (M67-T4)", () => {
  it("lists every step, trigger, field kind, page and control; the examples' use marks each one they use", () => {
    const all = capabilities(catalog);
    expect(all).toEqual(expect.arrayContaining(["step:email.send", "trigger:schedule", "trigger:entity.changed", "field:money", "page:report", "control:calendar"]));
    expect(new Set(all).size).toBe(all.length);
    const used = new Set<string>();
    for (const id of Object.keys(exampleFiles())) {
      const { app, pipelines } = exampleApp(id);
      for (const c of capabilitiesUsed(app, pipelines)) used.add(c);
    }
    for (const c of used) expect(all).toContain(c);
    const tables = exampleApp("tables");
    expect([...capabilitiesUsed(tables.app, tables.pipelines)].sort()).toEqual(
      expect.arrayContaining(["field:number", "field:text", "page:list", "page:view", "step:data.save", "step:db.query", "trigger:schedule"]),
    );
    // Some are used by none yet: the eval's report lists them, with the cases that cover the rest.
    expect(all.filter((c) => !used.has(c)).length).toBeGreaterThan(0);
  });
});
