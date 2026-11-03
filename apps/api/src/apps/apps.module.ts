import { Module } from "@nestjs/common";
import { RunsModule } from "../runs/runs.module";
import { AppImportsService } from "./app-imports.service";
import { AppPagesController } from "./app-pages.controller";
import { AppPagesService } from "./app-pages.service";
import { AppsController } from "./apps.controller";
import { AppsService } from "./apps.service";
import { EntityActionsService } from "./entity-actions.service";

@Module({
  imports: [RunsModule],
  // AppPagesController first: its /apps/menu before AppsController's /apps/:appId.
  controllers: [AppPagesController, AppsController],
  providers: [AppsService, AppPagesService, EntityActionsService, AppImportsService],
  exports: [AppsService],
})
export class AppsModule {}
