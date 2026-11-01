import { Module } from "@nestjs/common";
import { ControlsModule } from "../controls/controls.module";
import { TelegramModule } from "../telegram/telegram.module";
import { ProposalsController } from "./proposals.controller";
import { ProposalsService } from "./proposals.service";

@Module({
  imports: [ControlsModule, TelegramModule],
  controllers: [ProposalsController],
  providers: [ProposalsService],
  exports: [ProposalsService],
})
export class ProposalsModule {}
