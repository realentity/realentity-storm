import {
  EmailAccountRequestSchema,
  EmailAccountUpdateSchema,
  type EmailAccountUpdate,
  type EmailAccountView,
} from "@realentity/storm-shared";
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import type { z } from "zod";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { EmailAccountsService } from "./email-accounts.service";

@Controller("email-accounts")
export class EmailAccountsController {
  constructor(private readonly accounts: EmailAccountsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<EmailAccountView[]> {
    return this.accounts.list(user.userId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(EmailAccountRequestSchema)) body: z.output<typeof EmailAccountRequestSchema>,
  ): Promise<EmailAccountView> {
    return this.accounts.create(user.userId, body);
  }

  @Patch(":emailAccountId")
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("emailAccountId", ParseUUIDPipe) emailAccountId: string,
    @Body(new ZodBodyPipe(EmailAccountUpdateSchema)) body: EmailAccountUpdate,
  ): Promise<EmailAccountView> {
    return this.accounts.update(user.userId, emailAccountId, body);
  }

  @Delete(":emailAccountId")
  @HttpCode(204)
  remove(@CurrentUser() user: AuthenticatedUser, @Param("emailAccountId", ParseUUIDPipe) emailAccountId: string): Promise<void> {
    return this.accounts.remove(user.userId, emailAccountId);
  }
}
