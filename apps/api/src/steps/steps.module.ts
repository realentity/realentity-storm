import { defaultCatalog, PipelineCompiler, StepCatalog } from "@ai-me/steps";
import { Global, Module } from "@nestjs/common";

/** The step catalog, and the compiler over it. Tests override StepCatalog to add test steps. */
@Global()
@Module({
  providers: [
    { provide: StepCatalog, useFactory: (): StepCatalog => defaultCatalog() },
    { provide: PipelineCompiler, inject: [StepCatalog], useFactory: (catalog: StepCatalog) => new PipelineCompiler(catalog) },
  ],
  exports: [StepCatalog, PipelineCompiler],
})
export class StepsModule {}
