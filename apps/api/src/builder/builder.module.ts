import { ClaudeChat, ModelRouter, type LlmChat } from "@ai-me/llm";
import { type ServerEnv } from "@ai-me/shared";
import { PipelineCompiler, StepCatalog } from "@ai-me/steps";
import { Module } from "@nestjs/common";
import { SERVER_ENV } from "../config/server-env";
import { PrismaService } from "../database/prisma.service";
import { PipelinesModule } from "../pipelines/pipelines.module";
import { RunsModule } from "../runs/runs.module";
import { Builder } from "./builder";
import { BuilderController } from "./builder.controller";
import { BUILDER_LLM, BuilderService } from "./builder.service";

@Module({
  imports: [PipelinesModule, RunsModule],
  controllers: [BuilderController],
  providers: [
    {
      provide: BUILDER_LLM,
      inject: [SERVER_ENV],
      useFactory: (env: ServerEnv): LlmChat | null => (env.ANTHROPIC_API_KEY ? ClaudeChat.fromApiKey(env.ANTHROPIC_API_KEY) : null),
    },
    {
      provide: ModelRouter,
      inject: [PrismaService, SERVER_ENV],
      useFactory: (db: PrismaService, env: ServerEnv) =>
        new ModelRouter((userId, taskKey) => db.client.modelSetting.findUnique({ where: { userId_taskKey: { userId, taskKey } } }), {
          LLM_MODEL_BUILDER: env.LLM_MODEL_BUILDER,
        }),
    },
    {
      provide: Builder,
      inject: [BUILDER_LLM, PipelineCompiler, StepCatalog],
      // Without a key the service refuses before the builder is used.
      useFactory: (llm: LlmChat | null, compiler: PipelineCompiler, catalog: StepCatalog) =>
        new Builder(llm ?? { send: () => Promise.reject(new Error("ANTHROPIC_API_KEY is not set")) }, compiler, catalog),
    },
    BuilderService,
  ],
})
export class BuilderModule {}
