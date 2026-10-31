import { ClaudeBatches, ClaudeClient, LlmError, ModelRouter, OpenAiEmbeddings, emptyUsage, type LlmClient } from "@ai-me/llm";
import { JobQueue, publishEvent } from "@ai-me/queue";
import { type ServerEnv } from "@ai-me/shared";
import { defaultCatalog, StepCatalog } from "@ai-me/steps";
import { Injectable, Logger, Module, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { SERVER_ENV } from "../config/server-env";
import { PrismaService } from "../database/prisma.service";
import { PipelineRunner, type EventSink } from "../runner/pipeline-runner";
import { RunControls } from "../runner/run-controls";
import { ExecutorRegistry, type StepExecutor } from "../runner/step-executor";
import { ImapSmtpConnector } from "../mail/imap-smtp-connector";
import { Learning } from "../learning/learning";
import { Reflector } from "../learning/reflection";
import { CredentialVault } from "../secrets/credential-vault";
import { SecretsModule } from "../secrets/secrets.module";
import { coreSteps } from "../steps/core-steps";
import { JobHandlers } from "./job-handlers";

/** The implementations of the catalog's steps (the browser tests add test steps through ExecutorRegistry). */
export const STEP_EXECUTORS = Symbol("STEP_EXECUTORS");
const EVENT_SINK = Symbol("EVENT_SINK");

/** Without ANTHROPIC_API_KEY, LLM steps fail with a clear error instead of the worker refusing to start. */
const NO_LLM: LlmClient = {
  structured: () => Promise.reject(new LlmError("ANTHROPIC_API_KEY is not set", emptyUsage())),
};

/** Recovers interrupted runs and syncs schedules before consuming jobs; stops the queue on shutdown. */
@Injectable()
class JobsLifecycle implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(
    private readonly handlers: JobHandlers,
    private readonly queue: JobQueue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.handlers.recover();
    await this.handlers.syncSchedules();
    await this.handlers.consume();
  }

  /** First shutdown phase: active jobs finish (or fail back to the queue) while the database is still open. */
  async onModuleDestroy(): Promise<void> {
    await this.queue.stop();
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
    {
      provide: STEP_EXECUTORS,
      inject: [PrismaService, SERVER_ENV, CredentialVault, ModelRouter, Learning],
      useFactory: (db: PrismaService, env: ServerEnv, vault: CredentialVault, router: ModelRouter, learning: Learning): StepExecutor[] => {
        return coreSteps({
          llm: env.ANTHROPIC_API_KEY ? ClaudeClient.fromApiKey(env.ANTHROPIC_API_KEY) : NO_LLM,
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
      useFactory: (db: PrismaService, env: ServerEnv) => new RunControls(db.client, { monthlyBudgetUsd: env.LLM_MONTHLY_BUDGET_USD }),
    },
    {
      provide: PipelineRunner,
      inject: [PrismaService, StepCatalog, ExecutorRegistry, RunControls, EVENT_SINK],
      useFactory: (db: PrismaService, catalog: StepCatalog, executors: ExecutorRegistry, controls: RunControls, events: EventSink) =>
        new PipelineRunner(db.client, catalog, executors, controls, events),
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
      inject: [PrismaService, PipelineRunner, JobQueue, Learning, Reflector],
      useFactory: (db: PrismaService, runner: PipelineRunner, queue: JobQueue, learning: Learning, reflector: Reflector) =>
        new JobHandlers(db.client, runner, queue, learning, reflector),
    },
    JobsLifecycle,
  ],
})
export class JobsModule {}
