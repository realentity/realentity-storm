import {
  IntegrationCreateSchema,
  IntegrationTestSchema,
  IntegrationUpdateSchema,
  type IntegrationTestView,
  type IntegrationUpdate,
  type IntegrationView,
} from "@realentity/storm-shared";
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import type { z } from "zod";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { IntegrationsService } from "./integrations.service";

/** M62: Settings → AI → Model servers. */
@Controller("integrations")
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<IntegrationView[]> {
    return this.integrations.list(user.userId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(IntegrationCreateSchema)) body: z.output<typeof IntegrationCreateSchema>,
  ): Promise<IntegrationView> {
    return this.integrations.create(user.userId, body);
  }

  @Patch(":integrationId")
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("integrationId", ParseUUIDPipe) integrationId: string,
    @Body(new ZodBodyPipe(IntegrationUpdateSchema)) body: IntegrationUpdate,
  ): Promise<IntegrationView> {
    return this.integrations.update(user.userId, integrationId, body);
  }

  @Delete(":integrationId")
  @HttpCode(204)
  remove(@CurrentUser() user: AuthenticatedUser, @Param("integrationId", ParseUUIDPipe) integrationId: string): Promise<void> {
    return this.integrations.remove(user.userId, integrationId);
  }

  @Post(":integrationId/test")
  @HttpCode(200)
  test(
    @CurrentUser() user: AuthenticatedUser,
    @Param("integrationId", ParseUUIDPipe) integrationId: string,
    @Body(new ZodBodyPipe(IntegrationTestSchema)) body: z.output<typeof IntegrationTestSchema>,
  ): Promise<IntegrationTestView> {
    return this.integrations.test(user.userId, integrationId, body.model);
  }
}
