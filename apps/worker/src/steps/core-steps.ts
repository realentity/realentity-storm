import { type PrismaClient } from "@ai-me/db";
import { type LlmClient, type ModelRouter } from "@ai-me/llm";
import { type StepLearning } from "../learning/learning";
import { type MailConnector } from "../mail/mail-connector";
import { type StepExecutor } from "../runner/step-executor";
import { BrowserOpenStep, type BrowserDependencies } from "./browser-steps";
import { DedupeStep, FilterStep } from "./data-steps";
import { DigestStep } from "./digest-step";
import { emailSteps } from "./email-steps";
import { ClassifyStep, GenerateStep, ScoreStep, SummarizeStep } from "./llm-steps";
import { TelegramStep, type TelegramConfig } from "./telegram-step";

export interface CoreStepDependencies {
  llm: LlmClient;
  router: ModelRouter;
  telegram: TelegramConfig;
  fetch?: typeof fetch;
  mail: MailConnector;
  prisma: PrismaClient;
  /** Active rules and few-shot examples (README §8); none in tests unless given. */
  learning?: StepLearning;
  /** Browser steps (README §6); left out where no browser is needed. */
  browser?: BrowserDependencies;
}

/** Implementations of the catalog's steps (gates need none: the runner handles them). */
export function coreSteps(deps: CoreStepDependencies): StepExecutor[] {
  const telegram = new TelegramStep(deps.telegram, deps.fetch);
  return [
    new DedupeStep(),
    new FilterStep(),
    new ClassifyStep(deps.llm, deps.router, deps.learning),
    new ScoreStep(deps.llm, deps.router, deps.learning),
    new GenerateStep(deps.llm, deps.router, deps.learning),
    new SummarizeStep(deps.llm, deps.router, deps.learning),
    telegram,
    new DigestStep(deps.prisma, telegram),
    ...emailSteps({ mail: deps.mail, prisma: deps.prisma, llm: deps.llm, router: deps.router, learning: deps.learning }),
    ...(deps.browser ? [new BrowserOpenStep(deps.browser)] : []),
  ];
}
