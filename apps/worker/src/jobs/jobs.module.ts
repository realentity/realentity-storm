import { ClaudeClient, LlmError, ModelRouter, emptyUsage, type LlmClient } from "@ai-me/llm";
import { JobQueue } from "@ai-me/queue";
import { type ServerEnv } from "@ai-me/shared";
import { defaultCatalog } from "@ai-me/steps";
import { Injectable, Logger, Module, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { SERVER_ENV } from "../config/server-env";
import { PrismaService } from "../database/prisma.service";
import { PipelineRunner } from "../runner/pipeline-runner";
import { RunControls } from "../runner/run-controls";
import { ExecutorRegistry } from "../runner/step-executor";
import { coreSteps } from "../steps/core-steps";
import { JobHandlers } from "./job-handlers";

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
    {
      provide: PipelineRunner,
      inject: [PrismaService, SERVER_ENV],
      useFactory: (db: PrismaService, env: ServerEnv) => {
        const router = new ModelRouter(
          (userId, taskKey) => db.client.modelSetting.findUnique({ where: { userId_taskKey: { userId, taskKey } } }),
          { LLM_MODEL_CLASSIFY: env.LLM_MODEL_CLASSIFY, LLM_MODEL_WRITING: env.LLM_MODEL_WRITING },
        );
        const steps = coreSteps({
          llm: env.ANTHROPIC_API_KEY ? ClaudeClient.fromApiKey(env.ANTHROPIC_API_KEY) : NO_LLM,
          router,
          telegram: { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID },
        });
        return new PipelineRunner(
          db.client,
          defaultCatalog(),
          new ExecutorRegistry(steps),
          new RunControls(db.client, { monthlyBudgetUsd: env.LLM_MONTHLY_BUDGET_USD }),
        );
      },
    },
    {
      provide: JobHandlers,
      inject: [PrismaService, PipelineRunner, JobQueue],
      useFactory: (db: PrismaService, runner: PipelineRunner, queue: JobQueue) => new JobHandlers(db.client, runner, queue),
    },
    JobsLifecycle,
  ],
})
export class JobsModule {}
