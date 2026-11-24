import { llmFromConfig, ModelRouter, type LlmChat } from "@realentity/storm-llm";
import { AppsModule } from "../apps/apps.module";
import { type ServerEnv } from "@realentity/storm-shared";
import { PipelineCompiler, StepCatalog } from "@realentity/storm-steps";
import { Module } from "@nestjs/common";
import { SERVER_ENV } from "../config/server-env";
import { PrismaService } from "../database/prisma.service";
import { PipelinesModule } from "../pipelines/pipelines.module";
import { RunsModule } from "../runs/runs.module";
import { Builder } from "./builder";
import { BuilderController } from "./builder.controller";
import { BUILDER_LLM, BuilderService } from "./builder.service";

@Module({
  imports: [AppsModule, PipelinesModule, RunsModule],
  controllers: [BuilderController],
  providers: [
    {
      provide: BUILDER_LLM,
      inject: [SERVER_ENV],
      useFactory: (env: ServerEnv): LlmChat | null => {
        const llm = llmFromConfig({ anthropicApiKey: env.ANTHROPIC_API_KEY, openaiBaseUrl: env.OPENAI_BASE_URL, openaiApiKey: env.OPENAI_API_KEY });
        return llm.configured ? llm.chat : null;
      },
    },
    {
      provide: ModelRouter,
      inject: [PrismaService, SERVER_ENV],
      useFactory: (db: PrismaService, env: ServerEnv) =>
        new ModelRouter((userId, taskKey) => db.client.modelSetting.findUnique({ where: { userId_taskKey: { userId, taskKey } } }), {
          LLM_MODEL_BUILDER: env.LLM_MODEL_BUILDER,
          LLM_MODEL: env.LLM_MODEL,
        }),
    },
    {
      provide: Builder,
      inject: [BUILDER_LLM, PipelineCompiler, StepCatalog],
      // Without a key the service refuses before the builder is used.
      useFactory: (llm: LlmChat | null, compiler: PipelineCompiler, catalog: StepCatalog) =>
        new Builder(llm ?? { send: () => Promise.reject(new Error("No LLM is set up (ANTHROPIC_API_KEY or OPENAI_BASE_URL)")) }, compiler, catalog),
    },
    BuilderService,
  ],
  exports: [BuilderService],
})
export class BuilderModule {}
