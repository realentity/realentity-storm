import { type LlmClient, type ModelRouter } from "@ai-me/llm";
import { type StepExecutor } from "../runner/step-executor";
import { DedupeStep, FilterStep } from "./data-steps";
import { ClassifyStep, GenerateStep, ScoreStep, SummarizeStep } from "./llm-steps";
import { TelegramStep, type TelegramConfig } from "./telegram-step";

export interface CoreStepDependencies {
  llm: LlmClient;
  router: ModelRouter;
  telegram: TelegramConfig;
  fetch?: typeof fetch;
}

/** Implementations of the M2 catalog steps (gates need none: the runner handles them). */
export function coreSteps(deps: CoreStepDependencies): StepExecutor[] {
  return [
    new DedupeStep(),
    new FilterStep(),
    new ClassifyStep(deps.llm, deps.router),
    new ScoreStep(deps.llm, deps.router),
    new GenerateStep(deps.llm, deps.router),
    new SummarizeStep(deps.llm, deps.router),
    new TelegramStep(deps.telegram, deps.fetch),
  ];
}
