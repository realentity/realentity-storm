import {
  KillSwitchSchema,
  SettingsSchema,
  type KillSwitchRequest,
  type KillSwitchView,
  type SettingsRequest,
  type SettingsView,
  type SpendingView,
} from "@realentity/storm-shared";
import { Body, Controller, Get, Put } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { ControlsService } from "./controls.service";

@Controller("kill-switch")
export class KillSwitchController {
  constructor(private readonly controls: ControlsService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<KillSwitchView> {
    return this.controls.killSwitch(user.userId);
  }

  @Put()
  set(@CurrentUser() user: AuthenticatedUser, @Body(new ZodBodyPipe(KillSwitchSchema)) body: KillSwitchRequest): Promise<KillSwitchView> {
    return this.controls.setKillSwitch(user.userId, body.engaged);
  }
}

@Controller("settings")
export class SettingsController {
  constructor(private readonly controls: ControlsService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<SettingsView> {
    return this.controls.settings(user.userId);
  }

  @Get("spending")
  spending(@CurrentUser() user: AuthenticatedUser): Promise<SpendingView> {
    return this.controls.spending(user.userId);
  }

  @Put()
  update(@CurrentUser() user: AuthenticatedUser, @Body(new ZodBodyPipe(SettingsSchema)) body: SettingsRequest): Promise<SettingsView> {
    return this.controls.updateSettings(user.userId, body);
  }
}
