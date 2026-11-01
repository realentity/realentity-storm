import { type CompileResult, type CompiledDefinition } from "@ai-me/shared";
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
    it.each(readdirSync(PIPELINES).filter((f) => f.endsWith(".yaml")))("pipelines/%s compiles", (file) => {
      const result = ok(compiler.compileText(readFileSync(join(PIPELINES, file), "utf8")));
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
});
