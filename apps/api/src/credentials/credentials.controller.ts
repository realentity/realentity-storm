import {
  CreateCredentialSchema,
  ReplaceCredentialSecretSchema,
  type CreateCredentialRequest,
  type CredentialView,
  type ReplaceCredentialSecretRequest,
} from "@realentity/storm-shared";
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { CredentialsService } from "./credentials.service";

@Controller("credentials")
export class CredentialsController {
  constructor(private readonly credentials: CredentialsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<CredentialView[]> {
    return this.credentials.list(user.userId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(CreateCredentialSchema)) body: CreateCredentialRequest,
  ): Promise<CredentialView> {
    return this.credentials.create(user.userId, body);
  }

  @Put(":credentialId/secret")
  replaceSecret(
    @CurrentUser() user: AuthenticatedUser,
    @Param("credentialId", ParseUUIDPipe) credentialId: string,
    @Body(new ZodBodyPipe(ReplaceCredentialSecretSchema)) body: ReplaceCredentialSecretRequest,
  ): Promise<CredentialView> {
    return this.credentials.replaceSecret(user.userId, credentialId, body.secret);
  }

  @Delete(":credentialId")
  @HttpCode(204)
  remove(@CurrentUser() user: AuthenticatedUser, @Param("credentialId", ParseUUIDPipe) credentialId: string): Promise<void> {
    return this.credentials.remove(user.userId, credentialId);
  }
}
