import { type LlmUsage } from "@ai-me/llm";

/** What a step implementation knows about where it runs. */
export interface StepContext {
  runId: string;
  userId: string;
  pipelineId: string;
  stepId: string;
  stepKey: string;
  itemIndex: number | null;
  dryRun: boolean;
  /** LLM steps report each call's usage; it is saved on the step (Step.llmUsage), also when the step fails. */
  recordUsage(usage: LlmUsage): void;
  /** Headed steps: pausing for me in the live view (README §6). */
  attention: Attention;
}

/**
 * How a headed step hands the page to me and gets it back. Both wait with the page kept open, and throw RunStopped
 * when I abort (or the kill switch is on).
 */
export interface Attention {
  /** At a safe point between actions: if I pressed Take over, waits until I continue. */
  checkpoint(url?: string): Promise<void>;
  /** The page needs me (CAPTCHA, 2FA, a page it doesn't recognize): waits until I continue. */
  needMe(reason: string, url?: string): Promise<void>;
}

/** The run is to stop (Abort in the live view, the kill switch): the runner aborts it instead of failing the step. */
export class RunStopped extends Error {}

/** Outside a run with a live view (headless, tests): nobody can take over, so needing me fails the step. */
export const NO_ATTENTION: Attention = {
  checkpoint: () => Promise.resolve(),
  needMe: (reason) => Promise.reject(new Error(`${reason}: needs me, and this step has no live view (set headed: true to take over)`)),
};

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
