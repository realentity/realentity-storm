import { Integrations } from "@realentity/storm-db";
import { llmOver, ModelRouter, type LlmChat } from "@realentity/storm-llm";
import { AppsModule } from "../apps/apps.module";
import { PipelineCompiler, StepCatalog } from "@realentity/storm-steps";
import { Module } from "@nestjs/common";
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
    // M62: the builder's model is looked up at each turn in Settings → AI (Claude, a model server).
    { provide: BUILDER_LLM, inject: [Integrations], useFactory: (integrations: Integrations): LlmChat => llmOver(integrations).chat },
    {
      provide: ModelRouter,
      inject: [PrismaService, Integrations],
      useFactory: (db: PrismaService, integrations: Integrations) =>
        new ModelRouter(
          (userId, taskKey) => db.client.modelSetting.findUnique({ where: { userId_taskKey: { userId, taskKey } } }),
          (userId) => integrations.prefs(userId),
        ),
    },
    {
      provide: Builder,
      inject: [BUILDER_LLM, PipelineCompiler, StepCatalog],
      useFactory: (llm: LlmChat, compiler: PipelineCompiler, catalog: StepCatalog) => new Builder(llm, compiler, catalog),
    },
    BuilderService,
  ],
  exports: [BuilderService],
})
export class BuilderModule {}
