import { Module } from "@nestjs/common";
import { AppsModule } from "../apps/apps.module";
import { BindingsModule } from "../bindings/bindings.module";
import { ExamplesController } from "./examples.controller";
import { ExamplesService } from "./examples.service";

/** M40: the examples' needs and an installed one's checklist. */
@Module({
  imports: [AppsModule, BindingsModule],
  controllers: [ExamplesController],
  providers: [ExamplesService],
  exports: [ExamplesService],
})
export class ExamplesModule {}
