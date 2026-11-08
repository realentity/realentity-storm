import { readAppSource, type CompileResult, type CompiledDefinition } from "@realentity/storm-shared";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CORE_STEPS, defaultCatalog, type StepDefinition } from "./catalog";
import { PipelineCompiler } from "./compiler";

/** Stand-ins for the side-effect steps later milestones add (email.send, browser.fillAndSubmit). */
const TEST_STEPS: StepDefinition[] = [
  {
    type: "test.send",
    description: "sends a message",
    sideEffect: true,
    saasSafe: true,
    targets: { to: "recipient" },
    input: z.object({ to: z.union([z.string(), z.array(z.string())]), body: z.string() }),
    output: z.object({ messageId: z.string() }),
  },
  {
    type: "test.submit",
    description: "submits a form",
    sideEffect: true,
    saasSafe: false,
    targets: { url: "domain" },
    acceptsCredentials: true,
    input: z.object({ url: z.string(), fields: z.record(z.string(), z.unknown()).default({}), files: z.array(z.string()).default([]) }),
    output: z.object({ confirmation: z.string() }),
  },
  {
    type: "test.search",
    description: "returns jobs",
    sideEffect: false,
    saasSafe: true,
    input: z.object({ query: z.string() }),
    output: z.object({ items: z.array(z.object({ title: z.string(), applyUrl: z.string(), recruiter: z.string() })), total: z.number() }),
  },
];

/** Hand-written pipelines, ready to paste into the web app. */
const PIPELINES = join(__dirname, "../../../pipelines");

const compiler = new PipelineCompiler(defaultCatalog().with(...TEST_STEPS));

function ok(result: CompileResult): Extract<CompileResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected success, got:\n${result.errors.map((e) => `${e.path}: ${e.message}`).join("\n")}`);
  return result;
}

function errorsOf(result: CompileResult): string[] {
  if (result.ok) throw new Error("expected compile errors");
  return result.errors.map((e) => `${e.path}: ${e.message}`);
}

const pipeline = (steps: object[], extra: object = {}): object => ({ name: "Test", steps, ...extra });
const ids = (definition: CompiledDefinition): string[] => definition.steps.map((s) => s.id);

describe("PipelineCompiler", () => {
  it("compiles the README job-search pipeline from YAML, inserting no gate where one is authored", () => {
    const result = ok(
      compiler.compileText(`
name: Daily .NET job search
trigger: { schedule: "0 8 * * 1-5", tz: Europe/Sofia }
steps:
  - id: search
    type: test.search
    with: { query: "senior .NET" }
  - id: dedupe
    type: data.dedupe
    with: { from: "{{search.items}}", key: applyUrl }
  - id: filter
    type: llm.classify
    with: { items: "{{dedupe.items}}", instruction: "Exclude recruitment agencies." }
  - id: score
    type: llm.score
    with: { items: "{{filter.kept}}", against: profile, top: 10 }
  - id: shortlist
    type: gate.review
    with: { items: "{{score.top}}" }
  - id: prepare
    type: llm.generate
    forEach: "{{shortlist.selected}}"
    with: { instruction: "Write a cover letter", context: "{{item}}" }
  - id: approve
    type: gate.act
    forEach: "{{shortlist.selected}}"
    with: { for: apply }
  - id: apply
    type: test.submit
    forEach: "{{shortlist.selected}}"
    with: { url: "{{item.applyUrl}}", fields: { letter: "{{prepare.text}}" } }
limits:
  test.submit: 10/day
`),
    );
    expect(ids(result.definition)).toEqual(["search", "dedupe", "filter", "score", "shortlist", "prepare", "approve", "apply"]);
    expect(result.definition.trigger).toEqual({ schedule: "0 8 * * 1-5", tz: "Europe/Sofia" });
    expect(result.policy.provenance).toEqual([{ stepId: "apply", field: "url", kind: "domain", source: "item.applyUrl" }]);
    expect(result.warnings).toEqual([]);
  });

  // M2-U1
  describe("catalog", () => {
    it("tells which pipelines need the headed browser", () => {
      const headed = defaultCatalog().with({ ...TEST_STEPS[1], type: "test.headed", headed: true });
      expect(headed.needsHeaded([{ type: "llm.generate" }, { type: "test.headed" }])).toBe(true);
      expect(headed.needsHeaded([{ type: "llm.generate" }, { type: "unknown.step" }])).toBe(false);
    });

    it("rejects unknown step types", () => {
      expect(errorsOf(compiler.compile(pipeline([{ id: "a", type: "shell.exec", with: { cmd: "rm -rf /" } }])))).toEqual([
        'steps[0].type: unknown step type "shell.exec"',
      ]);
    });

    it("rejects unknown parameters and missing required ones", () => {
      const errors = errorsOf(compiler.compile(pipeline([{ id: "a", type: "llm.generate", with: { prompt: "x" } }])));
      expect(errors).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^steps\[0\]\.with\.prompt: unknown parameter for llm\.generate/),
          "steps[0].with.instruction: is required",
        ]),
      );
    });

    it("validates literal values against the step's schema", () => {
      const errors = errorsOf(
        compiler.compile(
          pipeline([
            { id: "s", type: "test.search", with: { query: "x" } },
            { id: "a", type: "llm.score", with: { items: "{{s.items}}", against: "p", top: 0 } },
          ]),
        ),
      );
      expect(errors).toEqual([expect.stringMatching(/^steps\[1\]\.with\.top: /)]);
    });

    it("rejects unknown top-level keys, bad ids, bad triggers and limits", () => {
      const errors = errorsOf(
        compiler.compile({
          name: "x",
          run: "now",
          trigger: { schedule: "every day", tz: "Mars/Olympus" },
          steps: [{ id: "Bad.Id", type: "llm.generate", with: { instruction: "x" } }],
          limits: { "llm.generate": "lots" },
        }),
      );
      expect(errors.join("\n")).toMatch(/run/);
      expect(errors.join("\n")).toMatch(/trigger/);
      expect(errors.join("\n")).toMatch(/steps\[0\]\.id/);
      expect(errors.join("\n")).toMatch(/limits/);
    });

    it("rejects rate limits on unknown and non-side-effect step types", () => {
      const steps = [{ id: "a", type: "llm.generate", with: { instruction: "x" } }];
      expect(errorsOf(compiler.compile({ ...pipeline(steps), limits: { "llm.generate": "5/day", "mail.send": "5/day" } }))).toEqual([
        "limits.llm.generate: only side-effect steps have rate limits",
        'limits.mail.send: unknown step type "mail.send"',
      ]);
    });

    it("rejects duplicate step ids and reserved ids", () => {
      const step = { type: "llm.generate", with: { instruction: "x" } };
      expect(
        errorsOf(
          compiler.compile(
            pipeline([
              { id: "a", ...step },
              { id: "a", ...step },
            ]),
          ),
        ),
      ).toEqual(['steps[1].id: "a" is used by an earlier step']);
      expect(errorsOf(compiler.compile(pipeline([{ id: "item", ...step }])))).toEqual(["steps[0].id: is reserved"]);
    });

    it("reports invalid YAML", () => {
      expect(errorsOf(compiler.compileText("name: [unclosed"))[0]).toMatch(/^: Not valid YAML/);
    });
  });

  // M2-U2
  describe("references", () => {
    const search = { id: "search", type: "test.search", with: { query: "x" } };

    it("rejects references to missing or later steps", () => {
      expect(errorsOf(compiler.compile(pipeline([{ id: "a", type: "llm.summarize", with: { content: "{{nope.items}}" } }])))).toEqual([
        'steps[0].with.content: {{nope.items}} refers to "nope", which is not an earlier step',
      ]);
      expect(
        errorsOf(compiler.compile(pipeline([{ id: "a", type: "llm.summarize", with: { content: "{{search.items}}" } }, search])))[0],
      ).toMatch(/not an earlier step/);
    });

    it("rejects references to fields the output doesn't have", () => {
      expect(
        errorsOf(compiler.compile(pipeline([search, { id: "a", type: "llm.summarize", with: { content: "{{search.results}}" } }]))),
      ).toEqual(['steps[1].with.content: {{search.results}}: the output has no field "results" (fields: items, total)']);
    });

    it("rejects type mismatches for whole-value references", () => {
      expect(
        errorsOf(compiler.compile(pipeline([search, { id: "a", type: "data.dedupe", with: { from: "{{search.total}}", key: "k" } }]))),
      ).toEqual(["steps[1].with.from: expects list of object but {{search.total}} is number"]);
    });

    it("allows references embedded in text for string fields only", () => {
      ok(compiler.compile(pipeline([search, { id: "a", type: "notify.telegram", with: { text: "Found {{search.total}} jobs" } }])));
      expect(
        errorsOf(compiler.compile(pipeline([search, { id: "a", type: "data.dedupe", with: { from: "x {{search.items}}", key: "k" } }])))[0],
      ).toMatch(/text with references is a string/);
    });

    it("resolves {{item}} only inside forEach, against the list's element type", () => {
      ok(
        compiler.compile(
          pipeline([search, { id: "a", type: "notify.telegram", forEach: "{{search.items}}", with: { text: "{{item.title}}" } }]),
        ),
      );
      expect(
        errorsOf(compiler.compile(pipeline([search, { id: "a", type: "notify.telegram", with: { text: "{{item.title}}" } }])))[0],
      ).toMatch(/only available in a step with forEach/);
      expect(
        errorsOf(
          compiler.compile(
            pipeline([search, { id: "a", type: "notify.telegram", forEach: "{{search.items}}", with: { text: "{{item.salary}}" } }]),
          ),
        )[0],
      ).toMatch(/the item has no field "salary"/);
    });

    it("requires forEach to be a list", () => {
      expect(
        errorsOf(
          compiler.compile(pipeline([search, { id: "a", type: "notify.telegram", forEach: "{{search.total}}", with: { text: "x" } }])),
        ),
      ).toEqual(["steps[1].forEach: {{search.total}} is a number, not a list"]);
    });

    it("gives aligned per-item values to steps over the same list, and lists to others", () => {
      const each = { forEach: "{{search.items}}" };
      const gen = { id: "gen", type: "llm.generate", ...each, with: { instruction: "x" } };
      // same list: {{gen.text}} is a string
      ok(compiler.compile(pipeline([search, gen, { id: "n", type: "notify.telegram", ...each, with: { text: "{{gen.text}}" } }])));
      // outside the forEach: {{gen.text}} is a list of strings
      expect(
        errorsOf(compiler.compile(pipeline([search, gen, { id: "n", type: "notify.telegram", with: { text: "{{gen.text}}" } }]))),
      ).toEqual(["steps[2].with.text: expects string but {{gen.text}} is list of string"]);
    });
  });

  // M2-U3, M2-U4
  describe("gates", () => {
    const send = { id: "send", type: "test.send", with: { to: "me@example.com", body: "hi" } };

    it("inserts a gate before an ungated side-effect step", () => {
      const result = ok(compiler.compile(pipeline([send])));
      expect(result.definition.steps).toEqual([{ id: "sendGate", type: "gate.act", with: { for: "send" }, autoInserted: true }, send]);
      expect(result.warnings[0]?.message).toMatch(/inserted gate "sendGate"/);
    });

    it("leaves authored gates alone", () => {
      const result = ok(compiler.compile(pipeline([{ id: "ok", type: "gate.act", with: { for: "send" } }, send])));
      expect(ids(result.definition)).toEqual(["ok", "send"]);
      expect(result.warnings).toEqual([]);
    });

    it("re-inserts the gate when a new version removes it (gates can't be removed)", () => {
      const v1 = ok(compiler.compile(pipeline([send])));
      const withoutGate = { ...v1.definition, steps: v1.definition.steps.filter((s) => s.type !== "gate.act") };
      expect(ids(ok(compiler.compile(withoutGate)).definition)).toEqual(["sendGate", "send"]);
    });

    it("gives the inserted gate the side-effect step's forEach", () => {
      const result = ok(
        compiler.compile(
          pipeline([
            { id: "search", type: "test.search", with: { query: "x" } },
            { id: "apply", type: "test.submit", forEach: "{{search.items}}", with: { url: "{{item.applyUrl}}" } },
          ]),
        ),
      );
      expect(result.definition.steps[1]).toMatchObject({ id: "applyGate", forEach: "{{search.items}}", with: { for: "apply" } });
    });

    it("avoids id collisions for inserted gates", () => {
      const result = ok(compiler.compile(pipeline([{ id: "sendGate", type: "llm.generate", with: { instruction: "x" } }, send])));
      expect(ids(result.definition)).toEqual(["sendGate", "sendGate2", "send"]);
    });

    it.each([
      [[send, { id: "g", type: "gate.act", with: { for: "send" } }], /the gate must come before "send"/],
      [[{ id: "g", type: "gate.act", with: { for: "nope" } }, send], /"nope" is not a step/],
      [
        [
          { id: "x", type: "llm.generate", with: { instruction: "x" } },
          { id: "g", type: "gate.act", with: { for: "x" } },
        ],
        /has no side effect/,
      ],
      [
        [{ id: "g1", type: "gate.act", with: { for: "send" } }, { id: "g2", type: "gate.act", with: { for: "send" } }, send],
        /already has a gate/,
      ],
    ])("rejects misplaced gates (%#)", (steps, message) => {
      expect(errorsOf(compiler.compile(pipeline(steps))).join("\n")).toMatch(message);
    });

    it("rejects a gate over different items than its step", () => {
      const steps = [
        { id: "search", type: "test.search", with: { query: "x" } },
        { id: "g", type: "gate.act", with: { for: "apply" } },
        { id: "apply", type: "test.submit", forEach: "{{search.items}}", with: { url: "{{item.applyUrl}}" } },
      ];
      expect(errorsOf(compiler.compile(pipeline(steps))).join("\n")).toMatch(/same items/);
    });

    it("rejects a gate placed before steps its action depends on (it couldn't show the payload)", () => {
      const steps = [
        { id: "g", type: "gate.act", with: { for: "send" } },
        { id: "draft", type: "llm.generate", with: { instruction: "x" } },
        { id: "send", type: "test.send", with: { to: "me@example.com", body: "{{draft.text}}" } },
      ];
      expect(errorsOf(compiler.compile(pipeline(steps))).join("\n")).toMatch(/"send" uses draft, which run after the gate/);
    });

    it("never retries side-effect steps", () => {
      expect(errorsOf(compiler.compile(pipeline([{ ...send, retries: 2 }])))).toEqual([
        "steps[0].retries: side-effect steps are never retried automatically",
      ]);
    });
  });

  // M2-U5
  it("classifies every catalog step that takes files as a side effect", () => {
    for (const step of [...CORE_STEPS, ...TEST_STEPS]) {
      const takesFiles = Object.keys(step.input.shape).some((field) => /files?|attachments?|uploads?/i.test(field));
      if (takesFiles) expect({ type: step.type, sideEffect: step.sideEffect }).toEqual({ type: step.type, sideEffect: true });
    }
  });

  describe("policy", () => {
    it("adds literal targets to the static lists and references to provenance", () => {
      const result = ok(
        compiler.compile(
          pipeline(
            [
              { id: "search", type: "test.search", with: { query: "x" } },
              { id: "mail", type: "test.send", with: { to: ["Boss@Example.com", "{{search.items}}"], body: "x" } },
              { id: "form", type: "test.submit", with: { url: "https://jobs.example.org/apply?id={{search.total}}" } },
              { id: "each", type: "test.send", forEach: "{{search.items}}", with: { to: "{{item.recruiter}}", body: "hello" } },
            ],
            { policy: { allowedDomains: ["dev.bg"], allowedRecipients: [] } },
          ),
        ),
      );
      expect(result.policy.allowedRecipients).toEqual(["boss@example.com"]);
      expect(result.policy.allowedDomains).toEqual(["dev.bg", "jobs.example.org"]);
      expect(result.policy.provenance).toEqual([
        { stepId: "mail", field: "to", kind: "recipient", source: "search.items" },
        { stepId: "each", field: "to", kind: "recipient", source: "item.recruiter" },
      ]);
    });

    it.each([
      [{ to: "Dear {{x.y}}", body: "b" }, "test.send", /literal address or a single reference/],
      [{ to: "not-an-email", body: "b" }, "test.send", /not an email address/],
      [{ url: "https://{{x.host}}/apply" }, "test.submit", /host of a target URL must be literal/],
      [{ url: "ftp://example.com" }, "test.submit", /not an http\(s\) URL/],
      [{ url: "{{cred:linkedin}}" }, "test.submit", /credential can't be a target/],
      [{ to: "{{draft.text}}", body: "b" }, "test.send", /recipient can't come from LLM output/],
    ])("rejects unsafe targets %#", (input, type, message) => {
      const steps = [
        { id: "x", type: "test.search", with: { query: "q" } },
        { id: "draft", type: "llm.generate", with: { instruction: "q" } },
        { id: "s", type, with: input },
      ];
      expect(errorsOf(compiler.compile(pipeline(steps))).join("\n")).toMatch(message);
    });
  });

  // M10: the form's address is the page's, not the LLM's: it may be fillAndSubmit's target; LLM-written fields may not
  it("takes a form's address from browser.mapForm as a target, never its LLM-written text", () => {
    const steps = (url: string) => [
      { id: "map", type: "browser.mapForm", with: { url: "https://ats.example.org/jobs/7", cv: "cv-main" } },
      { id: "apply", type: "browser.fillAndSubmit", with: { url, fields: "{{map.fields}}", files: "{{map.files}}" } },
    ];
    const result = ok(compiler.compile(pipeline(steps("{{map.formUrl}}"))));
    expect(ids(result.definition)).toEqual(["map", "applyGate", "apply"]);
    expect(result.policy.provenance).toEqual([{ stepId: "apply", field: "url", kind: "domain", source: "map.formUrl" }]);
    expect(errorsOf(compiler.compile(pipeline(steps("{{map.notes}}")))).join("\n")).toMatch(/domain can't come from LLM output/);
  });

  // M11-T2, M11-S3 (compile time): browser.agent sends nothing itself; browser.submit always gets its gate
  it("puts a gate between browser.agent and browser.submit; the target is the agent's start address, never its text", () => {
    const steps = (url: string) => [
      { id: "agent", type: "browser.agent", with: { url: "https://careers.example.org/jobs/3", goal: "Apply", documents: ["cv-main"] } },
      {
        id: "send",
        type: "browser.submit",
        with: { url, actions: "{{agent.actions}}", files: "{{agent.files}}", submit: "{{agent.submit}}" },
      },
    ];
    const result = ok(compiler.compile(pipeline(steps("{{agent.url}}"))));
    expect(ids(result.definition)).toEqual(["agent", "sendGate", "send"]);
    expect(result.policy.provenance).toEqual([{ stepId: "send", field: "url", kind: "domain", source: "agent.url" }]);
    expect(errorsOf(compiler.compile(pipeline(steps("{{agent.pageUrl}}")))).join("\n")).toMatch(/domain can't come from LLM output/);
  });

  // M4-T4, M4-S2 (compile time)
  describe("email", () => {
    const REPLIES = (to: string) => `
name: Recruiter replies
trigger: { schedule: "*/15 * * * *", tz: Europe/Sofia }
steps:
  - id: fetch
    type: email.fetch
  - id: triage
    type: email.classify
    with: { messages: "{{fetch.messages}}", instruction: "Recruiters or clients writing to me personally" }
  - id: draft
    type: email.draftReply
    forEach: "{{triage.kept}}"
    with: { message: "{{item}}", instruction: "Reply briefly; offer a call" }
  - id: send
    type: email.send
    forEach: "{{triage.kept}}"
    with:
      to: "${to}"
      subject: "{{draft.subject}}"
      body: "{{draft.body}}"
      inReplyTo: "{{item.messageId}}"
      references: "{{item.references}}"
`;

    it("compiles fetch → classify → draft → gate → send, the recipient bound to the fetched sender", () => {
      const result = ok(compiler.compileText(REPLIES("{{item.from}}")));
      expect(ids(result.definition)).toEqual(["fetch", "triage", "draft", "sendGate", "send"]);
      expect(result.policy.provenance).toEqual([{ stepId: "send", field: "to", kind: "recipient", source: "item.from" }]);
    });

    it.each(["{{draft.subject}}", "{{triage.results}}"])("refuses a recipient written by an LLM step (%s)", (to) => {
      expect(errorsOf(compiler.compileText(REPLIES(to))).join("\n")).toMatch(/recipient can't come from LLM output/);
    });

    // M4-T6: the hand-written pipelines in /pipelines stay valid.
    // M30: a pipeline of an App compiles against the App's definition in pipelines/apps.
    const apps = readdirSync(join(PIPELINES, "apps")).map((f) => readAppSource(readFileSync(join(PIPELINES, "apps", f), "utf8")));
    // examples.yaml is the examples' manifest (M40), not a pipeline: its pipelines compile in apps/api's examples test.
    it.each(readdirSync(PIPELINES).filter((f) => f.endsWith(".yaml") && f !== "examples.yaml"))("pipelines/%s compiles", (file) => {
      const text = readFileSync(join(PIPELINES, file), "utf8");
      const app = apps.find((a) => /^app: (.+)$/m.exec(text)?.[1]?.trim() === a.name);
      const result = ok(compiler.compileText(text, app ? { app } : {}));
      if (file === "recruiter-replies.yaml") {
        expect(ids(result.definition)).toEqual(["fetch", "triage", "draft", "sendGate", "send"]);
        expect(result.policy).toEqual({
          allowedDomains: [],
          allowedRecipients: [],
          provenance: [{ stepId: "send", field: "to", kind: "recipient", source: "item.from" }],
        });
      }
    });

    it("type-checks fields of fetched emails", () => {
      expect(errorsOf(compiler.compileText(REPLIES("{{item.sender}}"))).join("\n")).toMatch(/has no field "sender"/);
    });
  });

  describe("credentials", () => {
    it("allows {{cred:…}} only in steps that accept credentials", () => {
      ok(
        compiler.compile(
          pipeline([{ id: "s", type: "test.submit", with: { url: "https://example.com", fields: { password: "{{cred:example}}" } } }]),
        ),
      );
      expect(
        errorsOf(compiler.compile(pipeline([{ id: "g", type: "llm.generate", with: { instruction: "Use {{cred:example}}" } }]))),
      ).toEqual([
        "steps[0].with.instruction: llm.generate can't receive credentials ({{cred:…}}); they never reach the LLM or notifications",
      ]);
      expect(errorsOf(compiler.compile(pipeline([{ id: "n", type: "notify.telegram", with: { text: "{{cred:example}}" } }])))[0]).toMatch(
        /can't receive credentials/,
      );
    });
  });

  describe("triggers (M12-T1/T2)", () => {
    const after = { on: "run.finished", pipeline: "Jobs" };
    const tell = (text: string) => [{ id: "n", type: "notify.telegram", with: { text } }];

    it("accepts event and webhook triggers and rejects unknown events and filters", () => {
      ok(compiler.compile(pipeline(tell("x"), { trigger: after })));
      ok(compiler.compile(pipeline(tell("x"), { trigger: { on: "application.status", status: ["INTERVIEW"] } })));
      ok(compiler.compile(pipeline(tell("x"), { trigger: { on: "email.classified", label: ["recruiter"] } })));
      ok(compiler.compile(pipeline(tell("x"), { trigger: { on: "recipe.broken" } })));
      ok(compiler.compile(pipeline(tell("x"), { trigger: { webhook: "hmac-sha256" } })));
      for (const trigger of [{ on: "file.changed" }, { on: "application.status", status: ["HIRED"] }, { webhook: "basic" }]) {
        expect(errorsOf(compiler.compile(pipeline(tell("x"), { trigger }))).join("\n")).toMatch(/trigger/);
      }
    });

    it("type-checks {{trigger.*}} against the event's data, and refuses it without an event or webhook", () => {
      ok(compiler.compile(pipeline(tell("{{trigger.pipeline}}: {{trigger.summary}}"), { trigger: after })));
      ok(compiler.compile(pipeline(tell("{{trigger.body.ref}}"), { trigger: { webhook: "token" } })));
      expect(errorsOf(compiler.compile(pipeline(tell("{{trigger.job.title}}"), { trigger: after })))).toEqual([
        expect.stringMatching(/^steps\[0\]\.with\.text: \{\{trigger\.job\.title\}\}: .*"job"/),
      ]);
      expect(errorsOf(compiler.compile(pipeline(tell("{{trigger.summary}}"))))).toEqual([
        "steps[0].with.text: {{trigger.summary}} is only available in a pipeline triggered by an event or a webhook",
      ]);
    });

    it("lets an email's own address or a posting's URL be a target, never a webhook body or a run's outputs", () => {
      const reply = ok(
        compiler.compile(
          pipeline([{ id: "send", type: "test.send", with: { to: "{{trigger.message.from}}", body: "Thanks" } }], {
            trigger: { on: "email.classified", label: ["recruiter"] },
          }),
        ),
      );
      expect(reply.policy.provenance).toEqual([{ stepId: "send", field: "to", kind: "recipient", source: "trigger.message.from" }]);
      ok(compiler.compile(pipeline([{ id: "apply", type: "test.submit", with: { url: "{{trigger.job.url}}" } }], { trigger: { on: "application.status" } })));
      const fromBody = pipeline([{ id: "send", type: "test.send", with: { to: "{{trigger.body.email}}", body: "x" } }], { trigger: { webhook: "token" } });
      expect(errorsOf(compiler.compile(fromBody))).toEqual([
        "steps[0].with.to: {{trigger.body.email}} can't be a target: a webhook's body is written by whoever calls it",
      ]);
      const fromOutputs = pipeline([{ id: "send", type: "test.send", with: { to: "{{trigger.outputs.write}}", body: "x" } }], { trigger: after });
      expect(errorsOf(compiler.compile(fromOutputs))).toEqual([expect.stringMatching(/can't be a target: only an email's own addresses/)]);
    });

    it("reserves the id trigger", () => {
      expect(errorsOf(compiler.compile(pipeline([{ id: "trigger", type: "notify.telegram", with: { text: "x" } }])))).toEqual([
        "steps[0].id: is reserved",
      ]);
    });
  });

  describe("inputs and conditions (M13)", () => {
    const fetch = (url: unknown, allowed: string[] = ["github.com"]) =>
      pipeline([{ id: "fetch", type: "http.fetch", with: { [Array.isArray(url) ? "urls" : "url"]: url } }], { policy: { allowedDomains: allowed } });

    it("lets http.fetch read only literal hosts on policy.allowedDomains", () => {
      ok(compiler.compile(fetch("https://github.com/nodejs/node/releases.atom")));
      ok(compiler.compile(fetch(["https://github.com/a/b/releases.atom", "https://api.github.com/x"], ["github.com", "*.github.com"])));
      expect(errorsOf(compiler.compile(fetch("https://www.postgresql.org/news.rss")))).toEqual([
        "steps[0].with.url: www.postgresql.org isn't in policy.allowedDomains: add it there to read from it",
      ]);
      expect(errorsOf(compiler.compile(fetch(["https://github.com/a", "https://evil.test/b"])))).toEqual([
        "steps[0].with.urls[1]: evil.test isn't in policy.allowedDomains: add it there to read from it",
      ]);
    });

    it("checks shop.product's addresses inside products too", () => {
      const product = (products: unknown[]) =>
        pipeline([{ id: "product", type: "shop.product", with: { products } }], { policy: { allowedDomains: ["www.bergfreunde.eu"] } });
      ok(compiler.compile(product([{ url: "https://www.bergfreunde.eu/jacket/", select: { size: "M", color: "Black" } }])));
      expect(errorsOf(compiler.compile(product([{ url: "https://www.bergfreunde.eu/a/" }, { url: "https://shop.test/b" }])))).toEqual([
        "steps[0].with.products[1].url: shop.test isn't in policy.allowedDomains: add it there to read from it",
      ]);
    });

    it("checks when's reference, and gives an inserted gate the same when", () => {
      const steps = [
        { id: "search", type: "test.search", with: { query: "dotnet" } },
        { id: "send", type: "test.send", when: "{{search.items}}", with: { to: "ana@acme.test", body: "{{search.total}} jobs" } },
      ];
      const compiled = ok(compiler.compile(pipeline(steps)));
      expect(compiled.definition.steps.find((s) => s.id === "sendGate")).toMatchObject({ when: "{{search.items}}", autoInserted: true });
      expect(errorsOf(compiler.compile(pipeline([{ ...steps[0], when: "{{nothing.items}}" }])))).toEqual([
        'steps[0].when: {{nothing.items}} refers to "nothing", which is not an earlier step',
      ]);
      expect(errorsOf(compiler.compile(pipeline([{ ...steps[0], when: "search.items" }])))[0]).toMatch(/^steps\[0\]\.when: a single reference/);
    });
  });

  // M29-U1
  describe("data.map and data.alert", () => {
    const steps = (expression: string, alert: object = { below: 10 }) =>
      pipeline([
        { id: "search", type: "test.search", with: { query: "x" } },
        { id: "shape", type: "data.map", with: { from: "{{search.items}}", expression } },
        { id: "cold", type: "data.alert", with: { items: "{{shape.items}}", key: "place", value: "min", ...alert } },
      ]);

    it("refuses an expression that isn't JSONata when the pipeline is saved, not on its first run", () => {
      ok(compiler.compile(steps('{ "place": "Sofia", "min": $min(total) }')));
      expect(errorsOf(compiler.compile(steps('{ "place": "Sofia", "min": $min(total) ')))).toEqual([
        "steps[1].with.expression: a JSONata expression (see jsonata.org)",
      ]);
    });

    it("takes {{ in an expression as a reference: an object inside an object needs a space", () => {
      expect(errorsOf(compiler.compile(steps('$map(items, function($i) {{ "x": $i }})')))[0]).toMatch(/^steps\[1\]\.with\.expression: \{\{"x": \$i\}\} refers to/);
    });

    it("M29-T5: http.fetch takes {{cred:…}} in headers and query only; a header the connection sets is refused", () => {
      const fetch = (extra: object, url = "https://api.example.com/v1/me") =>
        pipeline([{ id: "me", type: "http.fetch", with: { url, ...extra } }], { policy: { allowedDomains: ["api.example.com"] } });
      ok(compiler.compile(fetch({ headers: { Authorization: "Bearer {{cred:github}}" }, query: { appid: "{{cred:weather}}" } })));
      expect(errorsOf(compiler.compile(fetch({}, "https://api.example.com/v1/me?key={{cred:github}}")))).toEqual([
        "steps[0].with.url: http.fetch takes credentials ({{cred:…}}) only in headers and query",
      ]);
      expect(errorsOf(compiler.compile(fetch({ headers: { Host: "evil.test" } })))[0]).toMatch(/^steps\[0\]\.with\.headers: not host/);
      expect(errorsOf(compiler.compile(fetch({ headers: { "Bad Header": "x" } })))[0]).toMatch(/^steps\[0\]\.with\.headers: header names are letters/);
    });

    it("M29-T6: http.request waits at an inserted gate; its literal host joins the allowed domains; keys only in headers and query", () => {
      const request = (url: string, extra: object = {}) =>
        pipeline([{ id: "issue", type: "http.request", with: { method: "POST", url, body: { title: "x" }, ...extra } }]);
      const compiled = ok(compiler.compile(request("https://api.github.com/repos/me/app/issues", { headers: { Authorization: "Bearer {{cred:github}}" } })));
      expect(ids(compiled.definition)).toEqual(["issueGate", "issue"]);
      expect(compiled.policy.allowedDomains).toContain("api.github.com");
      expect(errorsOf(compiler.compile(request("https://api.github.com/{{cred:github}}/issues")))).toContain(
        "steps[0].with.url: http.request takes credentials ({{cred:…}}) only in headers and query",
      );
    });

    it("M29-T8: a view's chart is a data.history collection of this pipeline", () => {
      const source = (chart: string) =>
        pipeline(
          [
            { id: "feeds", type: "http.fetch", with: { url: "https://github.com/acme/app/releases.atom" } },
            { id: "seen", type: "data.save", with: { items: "{{feeds.items}}", collection: "releases", key: "id" } },
            { id: "stars", type: "data.history", with: { items: "{{feeds.items}}", collection: "release-stars", key: "id", value: "title" } },
          ],
          { policy: { allowedDomains: ["github.com"] }, view: { menu: { label: "Releases" }, collection: "releases", columns: ["title"], chart: { history: chart } } },
        );
      expect(ok(compiler.compile(source("release-stars"))).definition.view?.chart).toEqual({ history: "release-stars", stepped: false });
      expect(errorsOf(compiler.compile(source("releases")))).toEqual(['view.chart.history: no data.history step of this pipeline writes "releases"']);
    });

    it("takes either below or above, with clearAt on the normal side", () => {
      const input = defaultCatalog().get("data.alert")!.input;
      const base = { items: [], key: "place", value: "min" };
      expect(input.safeParse({ ...base, below: 10, clearAt: 12 }).success).toBe(true);
      expect(input.safeParse({ ...base, above: 3, clearAt: 1.5 }).success).toBe(true);
      expect(input.safeParse(base).success).toBe(false);
      expect(input.safeParse({ ...base, below: 10, above: 20 }).success).toBe(false);
      expect(input.safeParse({ ...base, below: 10, clearAt: 8 }).success).toBe(false);
      expect(input.safeParse({ ...base, above: 3, clearAt: 4 }).success).toBe(false);
    });
  });

  describe("views (M27)", () => {
    const steps = [
      { id: "feeds", type: "http.fetch", with: { url: "https://github.com/acme/app/releases.atom" } },
      { id: "seen", type: "data.save", with: { items: "{{feeds.items}}", collection: "releases", key: "id" } },
      { id: "prices", type: "data.history", with: { items: "{{feeds.items}}", collection: "release-counts", key: "id", value: "title" } },
    ];
    const policy = { allowedDomains: ["github.com"] };
    const view = { menu: { label: "Releases", icon: "package" }, collection: "releases", columns: ["title", { field: "published", as: "date" }] };

    it("fills in a view's defaults: columns as fields, newest first, no marks or buttons", () => {
      const compiled = ok(compiler.compile(pipeline(steps, { policy, view })));
      expect(compiled.definition.view).toEqual({
        ...view,
        columns: [
          { field: "title", as: "text" },
          { field: "published", as: "date" },
        ],
        sort: { by: "@firstSeen", desc: true },
        removed: false,
        detail: {},
        marks: [],
        actions: [],
      });
      expect(ok(compiler.compile(pipeline(steps, { policy, view: { ...view, sort: "title" } }))).definition.view?.sort).toEqual({ by: "title", desc: false });
    });

    it("shows only what this pipeline keeps", () => {
      expect(errorsOf(compiler.compile(pipeline(steps, { policy, view: { ...view, collection: "other", detail: { history: "prices" } } })))).toEqual([
        'view.collection: no data.save step of this pipeline writes the collection "other"',
        'view.detail.history: no data.history step of this pipeline writes "prices"',
      ]);
      ok(compiler.compile(pipeline(steps, { policy, view: { ...view, detail: { history: "release-counts" } } })));
    });

    it("checks marks, buttons and fields", () => {
      const marks = [
        { id: "done", label: "Done", hides: true },
        { id: "done", label: "Again" },
      ];
      const actions = [
        { label: "Check now", run: "self" },
        { label: "Check now", run: "Other" },
        { label: "Notes", run: "self", row: true },
      ];
      expect(errorsOf(compiler.compile(pipeline(steps, { policy, view: { ...view, marks, actions } })))).toEqual([
        'view.marks[1].id: "done" is used by an earlier mark',
        'view.actions[1].label: "Check now" is used by an earlier button',
        "view.actions[2].run: a row's button starts another pipeline, one triggered by { on: view.action }",
      ]);
      const triggered = pipeline(steps, { policy, trigger: { on: "flow.later" }, view: { ...view, actions: [actions[0]] } });
      expect(errorsOf(compiler.compile(triggered))).toEqual(["view.actions[0].run: a pipeline started by an event or a webhook can't be run from a button"]);
      expect(errorsOf(compiler.compile(pipeline(steps, { policy, view: { ...view, columns: ["<b>x</b>"] } })))[0]).toMatch(/^view\.columns\[0\]/);
      expect(errorsOf(compiler.compile(pipeline(steps, { policy, view: { ...view, menu: { label: "Releases", icon: "skull" } } })))[0]).toMatch(/^view\.menu\.icon/);
    });

    it("gives a row's pipeline the row as {{trigger.item}}, never as a target", () => {
      const notes = (to: string) =>
        pipeline([{ id: "send", type: "test.send", with: { to, body: "{{trigger.item.title}} ({{trigger.collection}})" } }], {
          trigger: { on: "view.action", collection: "releases" },
        });
      ok(compiler.compile(notes("me@acme.test")));
      expect(errorsOf(compiler.compile(notes("{{trigger.item.author}}")))).toEqual([
        "steps[0].with.to: {{trigger.item.author}} can't be a target: a row holds what a pipeline read from pages, feeds or emails",
      ]);
    });
  });
});
