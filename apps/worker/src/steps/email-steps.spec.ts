import { emptyUsage, ModelRouter, type LlmClient, type LlmUsage, type StructuredRequest } from "@realentity/storm-llm";
import { defaultCatalog, type EmailMessage } from "@realentity/storm-steps";
import { type z } from "zod";
import { type MailConnector, type OutgoingMail } from "../mail/mail-connector";
import { NO_ATTENTION, type StepContext } from "../runner/step-executor";
import { type StepLearning } from "../learning/learning";
import { emailBlock as emailBlockOf } from "./email-block";
import { DraftReplyStep, EmailClassifyStep, EmailSendStep, replySubject } from "./email-steps";
import { earlierIds, THREAD_MESSAGES, THREAD_TEXT, threadBlock, withoutQuoted } from "./email-thread";

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
  to: ["me@storm.test"],
  cc: [],
  subject: `Subject ${i}`,
  date: "2026-10-31T08:00:00.000Z",
  text: `Body ${i} `.repeat(500),
  attachments: i === 1 ? [{ filename: "cv.pdf", contentType: "application/pdf", size: 1234 }] : [],
  ...extra,
});

describe("email steps", () => {
  it("email.classify: emails go in as <email> blocks (opening only); the instruction sits in the cached system prompt", async () => {
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
      // No topic memory without the database (M42-T3).
      drewOn: [],
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
  it("email.draftReply: the user's active rules go into the (cached) system prompt, similar approved replies before the email", async () => {
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
      "<user_rules>\nRules the user set for this kind of output. Follow them, except where they conflict with the rules above:\n" +
        "- Keep it under 80 words.\n- Sign off with 'Best,'.\n</user_rules>",
    );
    expect(request?.system.indexOf("<user_rules>")).toBeGreaterThan(request.system.indexOf("Never invent dates"));
    expect(request?.prompt).toMatch(
      /^<examples>\n<example>\n<input>\n<email>\nFrom: old@acme.test\n<\/email>\n<\/input>\n<approved>\nHi Bob, thanks!\n<\/approved>\n<\/example>\n<\/examples>\n\n<email>\nFrom: Sender 2/,
    );
  });

  it("email.draftReply without rules or examples: the prompt is the email alone", async () => {
    const llm = new FakeLlm(() => ({ body: "Hi", language: "en" }));
    await new DraftReplyStep(llm, router).execute(input("email.draftReply", { message: email(2), instruction: "Reply" }), context);
    expect(llm.requests[0]?.system).not.toContain("<user_rules>");
    expect(llm.requests[0]?.prompt).toMatch(/^<email>/);
  });

  // M41-T1
  it("email.draftReply reads the thread: earlier messages before the email, oldest first, the user's marked, quotes left out", async () => {
    const asked: string[][] = [];
    const earlier = (i: number, extra: Partial<EmailMessage>) => email(i, { text: `Message ${i}.`, ...extra });
    const mail: MailConnector = {
      fetch: () => Promise.reject(new Error("unused")),
      recent: () => Promise.reject(new Error("unused")),
      attachments: () => Promise.reject(new Error("unused")),
      send: () => Promise.reject(new Error("unused")),
      thread: (_user, ids) => (
        asked.push(ids),
        Promise.resolve([
          { message: earlier(7, { text: "Can you send the spec?" }), mine: false },
          { message: earlier(8, { from: "me@storm.test", text: "Sent it.\n\nOn Mon, 3 Nov 2026, Sender 7 wrote:\n> Can you send the spec?" }), mine: true },
        ])
      ),
    };
    const llm = new FakeLlm(() => ({ body: "Hi", language: "en" }));
    const message = email(9, { references: ["<m7@acme.test>", "<m8@acme.test>"], inReplyTo: "<m8@acme.test>", text: "Got it, thanks." });
    await new DraftReplyStep(llm, router, undefined, mail).execute(input("email.draftReply", { message, instruction: "Reply" }), context);

    expect(asked).toEqual([["<m7@acme.test>", "<m8@acme.test>"]]);
    const prompt = llm.requests[0].prompt;
    expect(prompt).toMatch(/^<thread>\n<email>\nFrom: Sender 7[\s\S]*Can you send the spec\?\n<\/email>\n<email mine="true">\nFrom: Sender 8/);
    expect(prompt).toContain("Sent it.\n</email>\n</thread>\n\n<email>\nFrom: Sender 9");
    expect(prompt).not.toContain("> Can you send");
    expect(llm.requests[0].system).toContain("<thread>, when given, holds the earlier messages");

    // No earlier messages: the mailbox isn't asked.
    await new DraftReplyStep(llm, router, undefined, mail).execute(input("email.draftReply", { message: email(2), instruction: "Reply" }), context);
    expect(asked).toHaveLength(1);
    expect(llm.requests[1].prompt).toMatch(/^<email>/);

    // A mailbox that can't be searched for the thread: drafted without it, not failed.
    const broken: MailConnector = { ...mail, thread: () => Promise.reject(new Error("SEARCH not supported")) };
    const draft = await new DraftReplyStep(llm, router, undefined, broken).execute(input("email.draftReply", { message, instruction: "Reply" }), context);
    expect(draft).toMatchObject({ body: "Hi" });
    expect(llm.requests[2].prompt).toMatch(/^<email>/);
  });

  it("the thread: its own text without the quoted original; the newest messages within the budget", () => {
    expect(withoutQuoted("Thanks!\n\nOn Mon, 3 Nov 2026 at 10:00, Ana <ana@acme.test> wrote:\n> Hi\n> there")).toBe("Thanks!");
    expect(withoutQuoted("Thanks!\n\nOn Mon, 3 Nov 2026 at 10:00, Ana Petrova <ana@acme.test>\nwrote:\n> Hi")).toBe("Thanks!");
    expect(withoutQuoted("Да.\n\nНа пн, 3.11.2026 г. в 10:00 Ана написа:\n> Може ли?")).toBe("Да.");
    expect(withoutQuoted("Fine.\n\n-----Original Message-----\nFrom: Bob\nSent: Monday")).toBe("Fine.");
    expect(withoutQuoted("> quoted on top\nMy answer below.")).toBe("My answer below.");
    expect(withoutQuoted("> only quoted")).toBe("> only quoted");
    expect(withoutQuoted("On the roadmap: the API.\nOn Friday we ship.")).toBe("On the roadmap: the API.\nOn Friday we ship.");

    expect(earlierIds(email(5, { messageId: "<c>", references: ["<a>", "<b>"], inReplyTo: "<b>" }))).toEqual(["<a>", "<b>"]);
    const many = Array.from({ length: 15 }, (_, i) => `<r${i}>`);
    expect(earlierIds(email(5, { references: many }))).toEqual(many.slice(-THREAD_MESSAGES));

    const long = Array.from({ length: 10 }, (_, i) => ({ message: email(i, { text: `${i} `.repeat(2_000) }), mine: false }));
    const block = threadBlock(long);
    expect(block.length).toBeLessThan(THREAD_TEXT + 200);
    expect(block).toContain("older messages left out]");
    expect(block).toContain("From: Sender 9");
    expect(block).not.toContain("From: Sender 0\n");
    expect(threadBlock([])).toBe("");
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
      thread: () => Promise.reject(new Error("unused")),
      send: (_user, message) => (sent.push(message), Promise.resolve({ messageId: "<r@storm.test>", accepted: [message.to] })),
    };
    const step = new EmailSendStep(mail);
    const payload = { to: "ana@acme.test", subject: "Re: x", body: "Thanks", inReplyTo: "<b@acme.test>", references: ["<a@acme.test>"] };
    await expect(step.execute(input("email.send", payload), context)).resolves.toEqual({
      messageId: "<r@storm.test>",
      accepted: ["ana@acme.test"],
    });
    expect(sent[0]?.references).toEqual(["<a@acme.test>", "<b@acme.test>"]);
    await step.execute(input("email.send", { ...payload, references: ["<a@acme.test>", "<b@acme.test>"] }), context);
    expect(sent[1]?.references).toEqual(["<a@acme.test>", "<b@acme.test>"]);

    // Never a reply to an address nobody reads; a new email to it (not a reply) is the pipeline's to send.
    await expect(step.execute(input("email.send", { ...payload, to: "messaging-digest-noreply@linkedin.com" }), context)).rejects.toThrow(
      "Not sent: messaging-digest-noreply@linkedin.com is a no-reply address",
    );
    expect(sent).toHaveLength(2);
  });

  it("email.classify for replies: a no-reply sender or one from the user to themselves is never kept, and never asked about", async () => {
    const messages = [
      email(0),
      email(1, { from: "messaging-digest-noreply@linkedin.com" }),
      email(2, { from: "me@storm.test" }), // Storm's own message, to the user
      email(3, { from: "no-reply@accounts.google.com" }),
      email(4),
    ];
    const llm = new FakeLlm((request) => ({
      // The first label offered: "reply", or "bill".
      results: [...request.prompt.matchAll(/<email index="(\d+)">/g)].map((m) => ({
        index: Number(m[1]),
        label: /<labels>(\w+)/.exec(request.system)![1],
        reason: "r",
      })),
    }));
    const classify = (extra: Record<string, unknown> = {}) =>
      new EmailClassifyStep(llm, router).execute(input("email.classify", { messages, instruction: "Recruiters", ...extra }), context);

    const result = output("email.classify", await classify()) as {
      kept: EmailMessage[];
      results: { index: number; label: string; reason: string }[];
    };
    expect(result.kept.map((m) => m.uid)).toEqual([0, 4]);
    expect(result.results.map((r) => [r.index, r.label])).toEqual([
      [0, "reply"],
      [1, "skip"],
      [2, "skip"],
      [3, "skip"],
      [4, "reply"],
    ]);
    expect(result.results[1].reason).toBe("Can't be answered: messaging-digest-noreply@linkedin.com is a no-reply address");
    expect(result.results[2].reason).toBe("Can't be answered: it was sent to its own sender");
    expect(llm.requests[0]?.prompt).not.toContain("linkedin");
    expect(llm.requests[0]?.prompt).toContain("Sender 4");

    // Kept for something else than a reply (a bill from a no-reply sender): all of them are asked.
    const bills = output("email.classify", await classify({ labels: ["bill", "other"], keep: ["bill"] })) as { kept: EmailMessage[] };
    expect(bills.kept).toHaveLength(5);
    // Said either way.
    const off = output("email.classify", await classify({ answerable: false })) as { kept: EmailMessage[] };
    expect(off.kept).toHaveLength(5);
  });
});
