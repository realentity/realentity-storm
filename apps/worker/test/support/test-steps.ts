import { type Prisma, type PrismaClient } from "@ai-me/db";
import { defaultCatalog, PipelineCompiler, type CompileContext, type StepDefinition } from "@ai-me/steps";
import { z } from "zod";
import { type StepExecutor } from "../../src/runner/step-executor";

/** Stand-ins for later milestones' steps: a data source and two side-effect steps. */
export const TEST_STEPS: StepDefinition[] = [
  {
    type: "test.search",
    description: "returns jobs",
    sideEffect: false,
    saasSafe: true,
    input: z.object({ query: z.string() }),
    output: z.object({ items: z.array(z.object({ title: z.string(), applyUrl: z.string(), recruiter: z.string() })) }),
  },
  {
    type: "test.note",
    description: "writes a note (stands in for an LLM step)",
    sideEffect: false,
    saasSafe: true,
    input: z.object({ text: z.string() }),
    output: z.object({ text: z.string() }),
  },
  {
    type: "test.send",
    description: "sends a message",
    sideEffect: true,
    saasSafe: true,
    targets: { to: "recipient" },
    input: z.object({ to: z.string(), body: z.string() }),
    output: z.object({ messageId: z.string() }),
  },
  {
    type: "test.submit",
    description: "submits a form",
    sideEffect: true,
    saasSafe: false,
    targets: { url: "domain" },
    input: z.object({ url: z.string(), letter: z.string() }),
    output: z.object({ confirmation: z.string() }),
  },
];

export const JOBS = [
  { title: "Senior .NET", applyUrl: "https://jobs.example.org/a", recruiter: "ana@acme.test" },
  { title: "Lead .NET", applyUrl: "https://careers.other.test/b", recruiter: "bob@other.test" },
];

export const catalog = defaultCatalog().with(...TEST_STEPS);
export const compiler = new PipelineCompiler(catalog);

/** Executors that count calls, so tests can prove nothing ran twice (or at all). */
export class Counting implements StepExecutor {
  calls: Record<string, unknown>[] = [];
  failuresLeft = 0;
  constructor(
    readonly type: string,
    private readonly produce: (input: Record<string, unknown>) => unknown,
  ) {}
  async execute(input: Record<string, unknown>): Promise<unknown> {
    this.calls.push(input);
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error(`${this.type} failed on purpose`);
    }
    return this.produce(input);
  }
}

/** Compiles a pipeline and stores it as version 1 of a new pipeline. Returns the pipelineVersionId. */
export async function createVersion(prisma: PrismaClient, userId: string, source: string, using = compiler, context: CompileContext = {}): Promise<string> {
  const result = using.compileText(source, context);
  if (!result.ok) throw new Error(result.errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
  // M39-T1: a saved pipeline's name is its own; a test's second one of a name gets " (2)", as the migration names them.
  let name = result.definition.name;
  for (let n = 2; await prisma.pipeline.findFirst({ where: { userId, name, currentVersionId: { not: null } } }); n++) {
    name = `${result.definition.name} (${n})`;
  }
  const pipeline = await prisma.pipeline.create({ data: { userId, name } });
  const v = await prisma.pipelineVersion.create({
    data: {
      pipelineId: pipeline.pipelineId,
      version: 1,
      definition: result.definition as unknown as Prisma.InputJsonValue,
      policy: result.policy as unknown as Prisma.InputJsonValue,
      savedAt: new Date(),
    },
  });
  await prisma.pipeline.update({ where: { pipelineId: pipeline.pipelineId }, data: { currentVersionId: v.pipelineVersionId } });
  return v.pipelineVersionId;
}
