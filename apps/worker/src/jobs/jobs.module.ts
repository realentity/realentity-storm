import { ClaudeBatches, ClaudeChat, ClaudeClient, LlmError, ModelRouter, OpenAiEmbeddings, emptyUsage, type LlmChat, type LlmClient } from "@realentity/storm-llm";
import { TopicBackfills } from "../sources/backfill";
import { JobQueue, publishEvent } from "@realentity/storm-queue";
import { KeyRing } from "@realentity/storm-crypto";
import { sendTelegramMessage, type ServerEnv, type TelegramMessage } from "@realentity/storm-shared";
import { defaultCatalog, StepCatalog } from "@realentity/storm-steps";
import { Injectable, Logger, Module, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { SERVER_ENV } from "../config/server-env";
import { PrismaService } from "../database/prisma.service";
import { ArtifactStore } from "../browser/artifact-store";
import { BrowserPool } from "../browser/browser-pool";
import { DocumentStore } from "../browser/document-store";
import { SessionStore } from "../browser/session-store";
import { PipelineRunner, type EventSink } from "../runner/pipeline-runner";
import { TakeoverDesk } from "../runner/takeovers";
import { LaterStarts } from "../runner/later";
import { Asker } from "../learning/asker";
import { Facts } from "../learning/facts";
import { GoogleConnection } from "../google/google-connection";
import { RunControls } from "../runner/run-controls";
import { ExecutorRegistry, type StepExecutor } from "../runner/step-executor";
import { ImapSmtpConnector } from "../mail/imap-smtp-connector";
import { Learning } from "../learning/learning";
import { Reflector } from "../learning/reflection";
import { CredentialVault } from "../secrets/credential-vault";
import { SecretsModule } from "../secrets/secrets.module";
import { AppFileStore } from "../steps/app-file-steps";
import { coreSteps } from "../steps/core-steps";
import { Triggers } from "../runner/triggers";
import { JobHandlers } from "./job-handlers";
import { ProposalNotifier } from "./proposal-notifier";
import { MorningBrief, type TodaysEvents } from "./morning-brief";
import { WeeklyReview } from "./weekly-review";
import { listEvents } from "../steps/calendar-steps";

/** A message to the user on the Storm bot: text, or text with buttons. */
function notifier(env: ServerEnv): (message: string | TelegramMessage) => Promise<void> {
  const config = { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID };
  return async (message) => {
    await sendTelegramMessage(config, typeof message === "string" ? { text: message } : message);
  };
}

/** Today's events for the morning brief; none when Google was never connected. */
function calendarEvents(db: PrismaService, google: GoogleConnection): TodaysEvents {
  return async (userId, from, to) => {
    if (!(await db.client.googleConnection.findUnique({ where: { userId }, select: { userId: true } }))) return null;
    const events = await listEvents(google, userId, from, to, undefined, 20);
    return events.map((e) => ({
      title: e.summary ?? "(no title)",
      start: new Date(e.start?.dateTime ?? `${e.start?.date ?? ""}T00:00:00`),
      allDay: Boolean(e.start?.date && !e.start.dateTime),
      location: e.location ?? null,
    }));
  };
}

/** The implementations of the catalog's steps (the browser tests add test steps through ExecutorRegistry). */
export const STEP_EXECUTORS = Symbol("STEP_EXECUTORS");
const EVENT_SINK = Symbol("EVENT_SINK");

/** Without ANTHROPIC_API_KEY, LLM steps fail with a clear error instead of the worker refusing to start. */
const NO_LLM: LlmClient = {
  structured: () => Promise.reject(new LlmError("ANTHROPIC_API_KEY is not set", emptyUsage())),
};

const NO_CHAT: LlmChat = {
  send: () => Promise.reject(new Error("ANTHROPIC_API_KEY is not set")),
};

/** Recovers interrupted runs and syncs schedules before consuming jobs; stops the queue on shutdown. */
@Injectable()
class JobsLifecycle implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(
    private readonly handlers: JobHandlers,
    private readonly queue: JobQueue,
    private readonly browsers: BrowserPool,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.handlers.recover();
    await this.handlers.syncSchedules();
    await this.handlers.consume();
  }

  /** First shutdown phase: active jobs finish (or fail back to the queue) while the database is still open. */
  async onModuleDestroy(): Promise<void> {
    await this.queue.stop();
    await this.browsers.close();
  }
}

@Module({
  imports: [SecretsModule],
  providers: [
    {
      provide: JobQueue,
      inject: [SERVER_ENV],
      useFactory: (env: ServerEnv): Promise<JobQueue> => {
        const logger = new Logger("Queue");
        return JobQueue.start({
          connectionString: env.DATABASE_URL,
          role: "worker",
          onError: (error) => logger.error(error.message, error.stack),
        });
      },
    },
    { provide: StepCatalog, useFactory: (): StepCatalog => defaultCatalog() },
    {
      provide: ModelRouter,
      inject: [PrismaService, SERVER_ENV],
      useFactory: (db: PrismaService, env: ServerEnv) =>
        new ModelRouter((userId, taskKey) => db.client.modelSetting.findUnique({ where: { userId_taskKey: { userId, taskKey } } }), {
          LLM_MODEL_CLASSIFY: env.LLM_MODEL_CLASSIFY,
          LLM_MODEL_WRITING: env.LLM_MODEL_WRITING,
          LLM_MODEL_REFLECTION: env.LLM_MODEL_REFLECTION,
        }),
    },
    {
      provide: Learning,
      inject: [PrismaService, SERVER_ENV, StepCatalog],
      useFactory: (db: PrismaService, env: ServerEnv, catalog: StepCatalog) =>
        new Learning(db.client, catalog, env.OPENAI_API_KEY ? new OpenAiEmbeddings(env.OPENAI_API_KEY, env.EMBEDDINGS_MODEL) : null),
    },
    { provide: BrowserPool, useFactory: () => new BrowserPool() },
    { provide: ArtifactStore, inject: [SERVER_ENV], useFactory: (env: ServerEnv) => new ArtifactStore(env.ARTIFACTS_DIR) },
    {
      provide: SessionStore,
      inject: [PrismaService, KeyRing, CredentialVault],
      useFactory: (db: PrismaService, keys: KeyRing, vault: CredentialVault) => new SessionStore(db.client, keys, vault),
    },
    {
      provide: GoogleConnection,
      inject: [PrismaService, KeyRing, SERVER_ENV],
      useFactory: (db: PrismaService, keys: KeyRing, env: ServerEnv) =>
        new GoogleConnection(db.client, keys, { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }),
    },
    { provide: LaterStarts, inject: [PrismaService, JobQueue], useFactory: (db: PrismaService, queue: JobQueue) => new LaterStarts(db.client, queue) },
    {
      provide: STEP_EXECUTORS,
      inject: [PrismaService, SERVER_ENV, CredentialVault, ModelRouter, Learning, BrowserPool, SessionStore, ArtifactStore, GoogleConnection, LaterStarts],
      useFactory: (
        db: PrismaService,
        env: ServerEnv,
        vault: CredentialVault,
        router: ModelRouter,
        learning: Learning,
        pool: BrowserPool,
        sessions: SessionStore,
        artifacts: ArtifactStore,
        google: GoogleConnection,
        later: LaterStarts,
      ): StepExecutor[] => {
        return coreSteps({
          google,
          later,
          appOrigin: env.APP_ORIGIN,
          browser: {
            prisma: db.client,
            pool,
            sessions,
            vault,
            artifacts,
            documents: new DocumentStore(env.DOCUMENTS_DIR),
            facts: new Facts(db.client),
            asker: new Asker(db.client, { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }, env.APP_ORIGIN),
            notify: notifier(env),
            appOrigin: env.APP_ORIGIN,
          },
          llm: env.ANTHROPIC_API_KEY ? ClaudeClient.fromApiKey(env.ANTHROPIC_API_KEY) : NO_LLM,
          chat: env.ANTHROPIC_API_KEY ? ClaudeChat.fromApiKey(env.ANTHROPIC_API_KEY) : NO_CHAT,
          downloadMaxMb: env.DOWNLOAD_MAX_MB,
          appFiles: new AppFileStore(env.DOCUMENTS_DIR),
          router,
          telegram: { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID },
          mail: new ImapSmtpConnector(
            {
              imapHost: env.IMAP_HOST,
              imapPort: env.IMAP_PORT,
              smtpHost: env.SMTP_HOST,
              smtpPort: env.SMTP_PORT,
              tls: env.MAIL_TLS,
              credential: env.MAIL_CREDENTIAL,
            },
            vault,
          ),
          prisma: db.client,
          learning,
          vault,
          embeddings: env.OPENAI_API_KEY ? new OpenAiEmbeddings(env.OPENAI_API_KEY, env.EMBEDDINGS_MODEL) : null,
        });
      },
    },
    { provide: ExecutorRegistry, inject: [STEP_EXECUTORS], useFactory: (steps: StepExecutor[]) => new ExecutorRegistry(steps) },
    {
      provide: EVENT_SINK,
      inject: [PrismaService],
      useFactory: (db: PrismaService): EventSink => {
        const logger = new Logger("Events");
        return (userId, event) =>
          publishEvent((sql, ...values) => db.client.$executeRaw(sql, ...values), userId, event).catch((error: Error) =>
            logger.warn(`Event not published: ${error.message}`),
          );
      },
    },
    {
      provide: RunControls,
      inject: [PrismaService, SERVER_ENV],
      useFactory: (db: PrismaService, env: ServerEnv) =>
        new RunControls(db.client, { monthlyBudgetUsd: env.LLM_MONTHLY_BUDGET_USD, notify: notifier(env), appOrigin: env.APP_ORIGIN }),
    },
    {
      provide: TakeoverDesk,
      inject: [PrismaService, SERVER_ENV, EVENT_SINK],
      useFactory: (db: PrismaService, env: ServerEnv, events: EventSink) =>
        new TakeoverDesk(db.client, events, {
          timeoutMs: env.TAKEOVER_TIMEOUT_MINUTES * 60_000,
          appOrigin: env.APP_ORIGIN,
          notify: notifier(env),
        }),
    },
    {
      provide: PipelineRunner,
      inject: [PrismaService, StepCatalog, ExecutorRegistry, RunControls, EVENT_SINK, TakeoverDesk, JobQueue],
      useFactory: (
        db: PrismaService,
        catalog: StepCatalog,
        executors: ExecutorRegistry,
        controls: RunControls,
        events: EventSink,
        takeovers: TakeoverDesk,
        queue: JobQueue,
      ) => new PipelineRunner(db.client, catalog, executors, controls, events, takeovers, (event) => queue.enqueueEvent(event)),
    },
    {
      provide: Reflector,
      inject: [PrismaService, SERVER_ENV, StepCatalog, ModelRouter, RunControls, JobQueue, EVENT_SINK],
      useFactory: (
        db: PrismaService,
        env: ServerEnv,
        catalog: StepCatalog,
        router: ModelRouter,
        controls: RunControls,
        queue: JobQueue,
        events: EventSink,
      ) =>
        new Reflector(
          db.client,
          catalog,
          env.ANTHROPIC_API_KEY ? ClaudeBatches.fromApiKey(env.ANTHROPIC_API_KEY) : null,
          router,
          controls,
          (reflectionId, startAfter) => queue.pollReflection(reflectionId, startAfter),
          events,
        ),
    },
    {
      provide: JobHandlers,
      inject: [
        PrismaService,
        PipelineRunner,
        JobQueue,
        Learning,
        Reflector,
        TakeoverDesk,
        ArtifactStore,
        SERVER_ENV,
        KeyRing,
        LaterStarts,
        RunControls,
        GoogleConnection,
        CredentialVault,
        ModelRouter,
      ],
      useFactory: (
        db: PrismaService,
        runner: PipelineRunner,
        queue: JobQueue,
        learning: Learning,
        reflector: Reflector,
        takeovers: TakeoverDesk,
        artifacts: ArtifactStore,
        env: ServerEnv,
        keys: KeyRing,
        later: LaterStarts,
        controls: RunControls,
        google: GoogleConnection,
        vault: CredentialVault,
        router: ModelRouter,
      ) =>
        new JobHandlers(
          db.client,
          runner,
          queue,
          learning,
          reflector,
          takeovers,
          { artifacts, days: env.ARTIFACTS_RETENTION_DAYS },
          {
            triggers: new Triggers(db.client, runner, queue, keys, later),
            notifier: new ProposalNotifier(db.client, { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }, env.APP_ORIGIN),
            review: new WeeklyReview(db.client, controls, notifier(env), env.APP_ORIGIN),
            brief: new MorningBrief(db.client, notifier(env), calendarEvents(db, google), env.APP_ORIGIN),
            backfills: new TopicBackfills(
              db.client,
              new ImapSmtpConnector(
                {
                  imapHost: env.IMAP_HOST,
                  imapPort: env.IMAP_PORT,
                  smtpHost: env.SMTP_HOST,
                  smtpPort: env.SMTP_PORT,
                  tls: env.MAIL_TLS,
                  credential: env.MAIL_CREDENTIAL,
                },
                vault,
              ),
              env.ANTHROPIC_API_KEY ? ClaudeBatches.fromApiKey(env.ANTHROPIC_API_KEY) : null,
              router,
              controls,
              (topicBackfillId, startAfter) => queue.enqueueBackfill(topicBackfillId, startAfter),
            ),
          },
        ),
    },
    JobsLifecycle,
  ],
})
export class JobsModule {}
