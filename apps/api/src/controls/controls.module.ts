import { Module } from "@nestjs/common";
import { KillSwitchController, SettingsController } from "./controls.controller";
import { ControlsService } from "./controls.service";

@Module({
  controllers: [KillSwitchController, SettingsController],
  providers: [ControlsService],
  exports: [ControlsService],
})
export class ControlsModule {}
