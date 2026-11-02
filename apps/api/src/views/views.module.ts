import { Module } from "@nestjs/common";
import { RunsModule } from "../runs/runs.module";
import { ViewsController } from "./views.controller";
import { ViewsService } from "./views.service";

@Module({
  imports: [RunsModule],
  controllers: [ViewsController],
  providers: [ViewsService],
})
export class ViewsModule {}
