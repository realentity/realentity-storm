import { type LlmUsage } from "@ai-me/llm";

/** What a step implementation knows about where it runs. */
export interface StepContext {
  runId: string;
  userId: string;
  stepId: string;
  stepKey: string;
  itemIndex: number | null;
  dryRun: boolean;
  /** LLM steps report each call's usage; it is saved on the step (Step.llmUsage), also when the step fails. */
  recordUsage(usage: LlmUsage): void;
}

/**
 * The implementation of one catalog step type (README §2.3). Inputs arrive resolved and validated against the
 * step's input schema; the returned value is validated against its output schema.
 */
export interface StepExecutor {
  readonly type: string;
  execute(input: Record<string, unknown>, context: StepContext): Promise<unknown>;
}

export class ExecutorRegistry {
  private readonly executors = new Map<string, StepExecutor>();

  constructor(executors: Iterable<StepExecutor> = []) {
    for (const executor of executors) {
      if (this.executors.has(executor.type)) throw new Error(`Executor for ${executor.type} is registered twice`);
      this.executors.set(executor.type, executor);
    }
  }

  get(type: string): StepExecutor | undefined {
    return this.executors.get(type);
  }
}
