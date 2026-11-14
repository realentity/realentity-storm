import { Module } from "@nestjs/common";
import { BindingsModule } from "../bindings/bindings.module";
import { RunsModule } from "../runs/runs.module";
import { AppFilesController } from "./app-files.controller";
import { AppFilesService } from "./app-files.service";
import { AppImportsService } from "./app-imports.service";
import { AppPagesController } from "./app-pages.controller";
import { AppPagesService } from "./app-pages.service";
import { AppsController } from "./apps.controller";
import { AppsService } from "./apps.service";
import { EntityActionsService } from "./entity-actions.service";

@Module({
  imports: [RunsModule, BindingsModule],
  // AppPagesController first: its /apps/menu before AppsController's /apps/:appId.
  controllers: [AppPagesController, AppsController, AppFilesController],
  providers: [AppsService, AppPagesService, EntityActionsService, AppImportsService, AppFilesService],
  exports: [AppsService],
})
export class AppsModule {}
