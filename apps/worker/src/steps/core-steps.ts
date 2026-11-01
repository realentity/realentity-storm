import { type PrismaClient } from "@ai-me/db";
import { type LlmChat, type LlmClient, type ModelRouter } from "@ai-me/llm";
import { type StepLearning } from "../learning/learning";
import { type MailConnector } from "../mail/mail-connector";
import { type StepExecutor } from "../runner/step-executor";
import { BrowserAgentStep, BrowserSubmitStep } from "./agent-steps";
import { BrowserOpenStep, type BrowserDependencies } from "./browser-steps";
import { DedupeStep, FilterStep, SaveStep } from "./data-steps";
import { DigestStep } from "./digest-step";
import { BrowserDownloadStep, BrowserUploadStep, FileReadStep } from "./file-steps";
import { emailSteps } from "./email-steps";
import { FillAndSubmitStep, MapFormStep, type FormDependencies } from "./form-steps";
import { ClassifyStep, GenerateStep, ScoreStep, SummarizeStep } from "./llm-steps";
import { BrowserExtractStep } from "./recipe-steps";
import { RecipeFallback } from "./recipe-fallback";
import { BrowserTeachStep, RecipeWriter } from "./teach-step";
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
  /** Browser steps (README §6); left out where no browser is needed. Forms also need my documents. */
  browser?: BrowserDependencies | FormDependencies;
  /** browser.agent's conversation with tools (README §2.4); without it, no agent. */
  chat?: LlmChat;
  /** DOWNLOAD_MAX_MB: browser.download keeps nothing larger. */
  downloadMaxMb?: number;
}

/** Implementations of the catalog's steps (gates need none: the runner handles them). */
export function coreSteps(deps: CoreStepDependencies): StepExecutor[] {
  const telegram = new TelegramStep(deps.telegram, deps.fetch);
  return [
    new DedupeStep(deps.prisma),
    new FilterStep(),
    new SaveStep(deps.prisma),
    new ClassifyStep(deps.llm, deps.router, deps.learning),
    new ScoreStep(deps.llm, deps.router, deps.learning),
    new GenerateStep(deps.llm, deps.router, deps.learning),
    new SummarizeStep(deps.llm, deps.router, deps.learning),
    telegram,
    new DigestStep(deps.prisma, telegram),
    ...emailSteps({ mail: deps.mail, prisma: deps.prisma, llm: deps.llm, router: deps.router, learning: deps.learning }),
    ...(deps.browser ? browserSteps(deps, deps.browser) : []),
    ...(deps.browser && "documents" in deps.browser
      ? [
          new MapFormStep(deps.browser, deps.llm, deps.router, deps.learning),
          new FillAndSubmitStep(deps.browser),
          new BrowserSubmitStep(deps.browser),
          new BrowserUploadStep(deps.browser),
        ]
      : []),
  ];
}

/** browser.open, extract and teach; the agent when there is a chat, which also gives extract its fallback (M11-T3). */
function browserSteps(deps: CoreStepDependencies, browser: BrowserDependencies | FormDependencies): StepExecutor[] {
  const agent = deps.chat ? new BrowserAgentStep({ ...browser, chat: deps.chat, router: deps.router }) : null;
  const fallback = agent ? new RecipeFallback(browser, agent, new RecipeWriter(deps.llm, deps.router)) : undefined;
  return [
    new BrowserOpenStep(browser),
    new BrowserExtractStep(browser, undefined, fallback),
    new BrowserTeachStep(browser, deps.llm, deps.router),
    new BrowserDownloadStep(browser, deps.downloadMaxMb),
    new FileReadStep(browser.prisma, browser.artifacts, "documents" in browser ? browser.documents : undefined),
    ...(agent ? [agent] : []),
  ];
}
