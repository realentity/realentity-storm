import { Module } from "@nestjs/common";
import { AppsModule } from "../apps/apps.module";
import { PipelinesModule } from "../pipelines/pipelines.module";
import { BundlesController } from "./bundles.controller";
import { BundlesService } from "./bundles.service";

/** M35-T5: import and export of Apps and pipelines as YAML; apart from both, as it saves both. */
@Module({
  imports: [AppsModule, PipelinesModule],
  controllers: [BundlesController],
  providers: [BundlesService],
})
export class BundlesModule {}
