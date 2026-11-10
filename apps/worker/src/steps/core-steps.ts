import { type PrismaClient } from "@realentity/storm-db";
import { type LlmChat, type LlmClient, type ModelRouter } from "@realentity/storm-llm";
import { type StepLearning } from "../learning/learning";
import { type GoogleConnection } from "../google/google-connection";
import { type MailConnector } from "../mail/mail-connector";
import { type LaterStarts } from "../runner/later";
import { type StepExecutor } from "../runner/step-executor";
import { type CredentialVault } from "../secrets/credential-vault";
import { BrowserAgentStep, BrowserSubmitStep } from "./agent-steps";
import { ApplicationOutcomeStep } from "./application-steps";
import { BrowserOpenStep, type BrowserDependencies } from "./browser-steps";
import { CalendarCreateStep, CalendarFindStep } from "./calendar-steps";
import { DedupeStep, FilterStep, SaveStep } from "./data-steps";
import { ReadStep } from "./entity-steps";
import { DbQueryStep } from "./db-step";
import { DigestStep } from "./digest-step";
import { BrowserDownloadStep, BrowserUploadStep, FileReadStep } from "./file-steps";
import { emailSteps } from "./email-steps";
import { FillAndSubmitStep, MapFormStep, type FormDependencies } from "./form-steps";
import { HistoryStep } from "./history-step";
import { HttpFetchStep, HttpRequestStep, type HttpFetchOptions } from "./http-steps";
import { AlertStep, MapStep } from "./map-alert-steps";
import { PriceWatchStep } from "./price-steps";
import { ProductStep } from "./product-step";
import { FlowCancelStep, FlowLaterStep } from "./flow-steps";
import { ClassifyStep, ExtractStep, GenerateStep, ScoreStep, SummarizeStep } from "./llm-steps";
import { BrowserExtractStep } from "./recipe-steps";
import { RecipeFallback } from "./recipe-fallback";
import { BrowserTeachStep, RecipeWriter } from "./teach-step";
import { TelegramStep, type TelegramConfig } from "./telegram-step";
import { TopicApplyStep, TopicExtractStep } from "./topic-memory-steps";
import { TopicMatchStep } from "./topic-steps";

export interface CoreStepDependencies {
  llm: LlmClient;
  router: ModelRouter;
  telegram: TelegramConfig;
  fetch?: typeof fetch;
  mail: MailConnector;
  prisma: PrismaClient;
  /** Active rules and few-shot examples (docs/design.md §8); none in tests unless given. */
  learning?: StepLearning;
  /** Browser steps (docs/design.md §6); left out where no browser is needed. Forms also need the user's documents. */
  browser?: BrowserDependencies | FormDependencies;
  /** browser.agent's conversation with tools (docs/design.md §2.4); without it, no agent. */
  chat?: LlmChat;
  /** DOWNLOAD_MAX_MB: browser.download keeps nothing larger. */
  downloadMaxMb?: number;
  /** calendar.* (M14-T1); left out where there is no Google connection. */
  google?: GoogleConnection;
  /** APP_ORIGIN: the calendar's Reconnect button. */
  appOrigin?: string;
  /** flow.later and flow.cancel (M14-T3). */
  later?: LaterStarts;
  /** http.fetch's and shop.product's address checks and DNS; tests reach their local server through them. */
  http?: HttpFetchOptions;
  /** http.fetch's and http.request's API keys, db.query's connections (M29); without it, steps using {{cred:…}} fail. */
  vault?: CredentialVault;
}

/** Implementations of the catalog's steps (gates need none: the runner handles them). */
export function coreSteps(deps: CoreStepDependencies): StepExecutor[] {
  const telegram = new TelegramStep(deps.telegram, deps.fetch);
  const product = new ProductStep(deps.llm, deps.router, deps.http, deps.browser?.pool);
  return [
    new DedupeStep(deps.prisma),
    new FilterStep(),
    new SaveStep(deps.prisma),
    new ReadStep(deps.prisma),
    new HistoryStep(deps.prisma),
    new MapStep(),
    new AlertStep(deps.prisma),
    new HttpFetchStep(deps.prisma, deps.http, deps.vault),
    new HttpRequestStep(deps.http, deps.vault),
    new DbQueryStep(deps.vault),
    product,
    new PriceWatchStep(deps.prisma, product),
    new ClassifyStep(deps.llm, deps.router, deps.learning),
    new ScoreStep(deps.llm, deps.router, deps.learning, deps.prisma),
    new ApplicationOutcomeStep(deps.prisma, deps.llm, deps.router, deps.learning),
    new GenerateStep(deps.llm, deps.router, deps.learning),
    new SummarizeStep(deps.llm, deps.router, deps.learning),
    new ExtractStep(deps.llm, deps.router, deps.learning),
    new TopicMatchStep(deps.llm, deps.router, deps.learning, deps.prisma),
    new TopicExtractStep(deps.llm, deps.router, deps.learning, deps.prisma),
    new TopicApplyStep(deps.prisma),
    ...(deps.google ? [new CalendarFindStep({ google: deps.google, appOrigin: deps.appOrigin }), new CalendarCreateStep({ google: deps.google, appOrigin: deps.appOrigin })] : []),
    ...(deps.later ? [new FlowLaterStep(deps.later), new FlowCancelStep(deps.later)] : []),
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
