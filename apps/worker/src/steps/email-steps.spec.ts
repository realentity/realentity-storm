import { emptyUsage, ModelRouter, type LlmClient, type LlmUsage, type StructuredRequest } from "@ai-me/llm";
import { defaultCatalog, type EmailMessage } from "@ai-me/steps";
import { type z } from "zod";
import { type MailConnector, type OutgoingMail } from "../mail/mail-connector";
import { NO_ATTENTION, type StepContext } from "../runner/step-executor";
import { type StepLearning } from "../learning/learning";
import { emailBlock as emailBlockOf } from "./email-block";
import { DraftReplyStep, EmailClassifyStep, EmailSendStep, replySubject } from "./email-steps";

const catalog = defaultCatalog();
const input = (type: string, raw: Record<string, unknown>) => catalog.get(type)!.input.parse(raw);
const output = (type: string, value: unknown) => catalog.get(type)!.output.parse(value);
const context: StepContext = {
  runId: "r",
  userId: "u",
  pipelineId: "p",
  stepId: "s",
  stepKey: "k",
  itemIndex: null,
  dryRun: false,
  recordUsage: () => undefined,
  attention: NO_ATTENTION,
};
const router = new ModelRouter(() => Promise.resolve(null));

class FakeLlm implements LlmClient {
  requests: StructuredRequest<z.ZodObject>[] = [];
  constructor(private readonly answer: (request: StructuredRequest<z.ZodObject>) => unknown) {}
  structured<S extends z.ZodObject>(request: StructuredRequest<S>): Promise<{ output: z.infer<S>; usage: LlmUsage }> {
    this.requests.push(request);
    return Promise.resolve({
      output: request.schema.parse(this.answer(request as unknown as StructuredRequest<z.ZodObject>)),
      usage: emptyUsage(),
    });
  }
}

const email = (i: number, extra: Partial<EmailMessage> = {}): EmailMessage => ({
  uid: i,
  messageId: `<m${i}@acme.test>`,
  threadId: `<m${i}@acme.test>`,
  inReplyTo: null,
  references: [],
  from: `sender${i}@acme.test`,
  fromName: `Sender ${i}`,
  replyTo: `sender${i}@acme.test`,
  to: ["me@aime.test"],
  cc: [],
  subject: `Subject ${i}`,
  date: "2026-10-31T08:00:00.000Z",
  text: `Body ${i} `.repeat(500),
  attachments: i === 1 ? [{ filename: "cv.pdf", contentType: "application/pdf", size: 1234 }] : [],
  ...extra,
});

describe("email steps", () => {
  it("email.classify: emails go in as <email> blocks (opening only); my instruction sits in the cached system prompt", async () => {
    const messages = Array.from({ length: 23 }, (_, i) => email(i));
    const llm = new FakeLlm((request) => ({
      results: [...request.prompt.matchAll(/<email index="(\d+)">/g)].map((m) => ({
        index: Number(m[1]),
        label: Number(m[1]) % 2 ? "skip" : "reply",
        reason: "r",
      })),
    }));
    const raw = await new EmailClassifyStep(llm, router).execute(
      input("email.classify", { messages, instruction: "Recruiters writing to me personally" }),
      context,
    );
    const result = output("email.classify", raw) as { kept: EmailMessage[]; dropped: EmailMessage[] };
    expect(result.kept.map((m) => m.uid)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
    expect(result.kept[0]).toEqual(messages[0]);

    expect(llm.requests).toHaveLength(2); // chunks of 20
    for (const request of llm.requests) {
      expect(request.cacheSystem).toBe(true);
      expect(request.system).toContain("<instruction>Recruiters writing to me personally</instruction>");
      expect(request.system).toContain("<labels>reply, skip</labels>");
      expect(request.prompt).not.toContain("Recruiters writing");
    }
    expect(llm.requests[0]?.prompt).toContain(
      "From: Sender 1 <sender1@acme.test>\nDate: 2026-10-31T08:00:00.000Z\nSubject: Subject 1\nAttachments: cv.pdf",
    );
    expect(llm.requests[0]?.prompt.length).toBeLessThan(20 * 3_300);
  });

  it("email.draftReply: a body in the email's language; the subject is the original's with Re:, never the LLM's", async () => {
    const llm = new FakeLlm(() => ({ body: "  Здравейте,\n\nБлагодаря. [date] е удобно.\n  ", language: "BG" }));
    const raw = await new DraftReplyStep(llm, router).execute(
      input("email.draftReply", {
        message: email(3, { subject: "Позиция Senior .NET" }),
        instruction: "Offer a call",
        context: { availability: "from December" },
        signature: "Alex",
      }),
      context,
    );
    expect(output("email.draftReply", raw)).toEqual({
      subject: "Re: Позиция Senior .NET",
      body: "Здравейте,\n\nБлагодаря. [date] е удобно.",
      language: "bg",
    });
    const [request] = llm.requests;
    expect(request?.cacheSystem).toBe(true);
    expect(request?.system).toMatch(/Reply in the language the email is written in/);
    expect(request?.system).toMatch(/Never invent dates, prices/);
    expect(request?.system).toContain('"availability": "from December"');
    expect(request?.system).toContain("<signature>\nAlex\n</signature>");
    expect(request?.prompt).toMatch(/^<email>\nFrom: Sender 3 <sender3@acme.test>/);
    expect(Object.keys(request.schema.shape)).toEqual(["body", "language"]);
  });

  // M6-T4, M6-T6
  it("email.draftReply: my active rules go into the (cached) system prompt, similar approved replies before the email", async () => {
    const llm = new FakeLlm(() => ({ body: "Hi Ana,\n\nThanks.", language: "en" }));
    const asked: { rules: unknown[][]; examples: unknown[][] } = { rules: [], examples: [] };
    const learning: StepLearning = {
      rules: (...args) => (asked.rules.push(args), Promise.resolve(["Keep it under 80 words.", "Sign off with 'Best,'."])),
      examples: (...args) => (
        asked.examples.push(args.slice(0, 3)),
        Promise.resolve([{ context: "<email>\nFrom: old@acme.test\n</email>", output: "Hi Bob, thanks!" }])
      ),
    };
    await new DraftReplyStep(llm, router, learning).execute(
      input("email.draftReply", { message: email(2), instruction: "Reply" }),
      context,
    );

    const [request] = llm.requests;
    expect(asked.rules).toEqual([["u", "email.draftReply", "p"]]);
    expect(asked.examples).toEqual([["u", "email.draftReply", emailBlockOf(email(2))]]);
    expect(request?.system).toContain(
      "<my_rules>\nRules I set for this kind of output. Follow them, except where they conflict with the rules above:\n" +
        "- Keep it under 80 words.\n- Sign off with 'Best,'.\n</my_rules>",
    );
    expect(request?.system.indexOf("<my_rules>")).toBeGreaterThan(request.system.indexOf("Never invent dates"));
    expect(request?.prompt).toMatch(
      /^<examples>\n<example>\n<input>\n<email>\nFrom: old@acme.test\n<\/email>\n<\/input>\n<approved>\nHi Bob, thanks!\n<\/approved>\n<\/example>\n<\/examples>\n\n<email>\nFrom: Sender 2/,
    );
  });

  it("email.draftReply without rules or examples: the prompt is the email alone", async () => {
    const llm = new FakeLlm(() => ({ body: "Hi", language: "en" }));
    await new DraftReplyStep(llm, router).execute(input("email.draftReply", { message: email(2), instruction: "Reply" }), context);
    expect(llm.requests[0]?.system).not.toContain("<my_rules>");
    expect(llm.requests[0]?.prompt).toMatch(/^<email>/);
  });

  it("reply subjects: Re: once, recognizing Re/AW/Отн", () => {
    expect(replySubject("Senior role")).toBe("Re: Senior role");
    expect(replySubject("RE: Senior role")).toBe("RE: Senior role");
    expect(replySubject("Отн: Позиция")).toBe("Отн: Позиция");
    expect(replySubject("  ")).toBe("Re: (no subject)");
  });

  it("email.send: replies in the thread (References end with the message replied to)", async () => {
    const sent: OutgoingMail[] = [];
    const mail: MailConnector = {
      fetch: () => Promise.reject(new Error("unused")),
      recent: () => Promise.reject(new Error("unused")),
      attachments: () => Promise.reject(new Error("unused")),
      send: (_user, message) => (sent.push(message), Promise.resolve({ messageId: "<r@aime.test>", accepted: [message.to] })),
    };
    const step = new EmailSendStep(mail);
    const payload = { to: "ana@acme.test", subject: "Re: x", body: "Thanks", inReplyTo: "<b@acme.test>", references: ["<a@acme.test>"] };
    await expect(step.execute(input("email.send", payload), context)).resolves.toEqual({
      messageId: "<r@aime.test>",
      accepted: ["ana@acme.test"],
    });
    expect(sent[0]?.references).toEqual(["<a@acme.test>", "<b@acme.test>"]);
    await step.execute(input("email.send", { ...payload, references: ["<a@acme.test>", "<b@acme.test>"] }), context);
    expect(sent[1]?.references).toEqual(["<a@acme.test>", "<b@acme.test>"]);
  });
});
