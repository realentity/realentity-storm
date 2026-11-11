import { type StepContext } from "../runner/step-executor";

/**
 * A step's context that also tells `add` what each LLM call cost (M44-T5): to share a topic step's cost out among the
 * topics it was for. The run records the usage as before.
 */
export function costed(context: StepContext, add: (costUsd: number) => void): StepContext {
  return {
    ...context,
    recordUsage: (usage) => {
      context.recordUsage(usage);
      add(usage.costUsd);
    },
  };
}
