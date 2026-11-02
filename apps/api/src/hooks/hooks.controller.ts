import { HealthReportSchema, type ServerEnv, type WebhookView } from "@ai-me/shared";
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  type RawBodyRequest,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { type Request } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { CurrentUser, Public, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { SERVER_ENV } from "../config/server-env";
import { HealthChecks } from "../health/health-checks";
import { TelegramBot } from "../telegram/telegram-bot";
import { WebhooksService } from "./webhooks.service";

const digest = (text: string) => createHash("sha256").update(text).digest();

/**
 * What reaches AI ME from the Internet (M12-T5): hooks-gateway on the VPS forwards to the hooks-only site on the server
 * (Caddy :8081, /hooks/* only), which ends here. No session: each call carries its own secret.
 */
@Public()
@Throttle({ default: { limit: 120, ttl: 60_000 } })
@Controller("hooks")
export class HooksController {
  constructor(
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
    private readonly bot: TelegramBot,
    private readonly webhooks: WebhooksService,
    private readonly health: HealthChecks,
  ) {}

  /**
   * the server's own jobs reporting (M26): the nightly backup, the restore test, disk and services. From the host, through
   * the hooks-only site. A wrong token gets the same 404 as an unknown path.
   */
  @Post("health")
  @HttpCode(204)
  async report(
    @Headers("x-aime-health-token") token: string | undefined,
    @Body() body: unknown,
  ): Promise<void> {
    const expected = this.env.HEALTH_REPORT_TOKEN;
    if (!expected || !token || !timingSafeEqual(digest(token), digest(expected))) throw new NotFoundException();
    // Checked after the token: without it, nothing about the endpoint shows.
    await this.health.report(new ZodBodyPipe(HealthReportSchema).transform(body));
  }

  /** The AI ME bot's updates. A wrong secret gets the same 404 as an unknown path. */
  @Post("telegram")
  @HttpCode(200)
  async telegram(@Headers("x-telegram-bot-api-secret-token") secret: string | undefined, @Req() request: Request): Promise<{ ok: true }> {
    const expected = this.env.TELEGRAM_WEBHOOK_SECRET;
    if (!expected || !secret || !timingSafeEqual(digest(secret), digest(expected))) throw new NotFoundException();
    await this.bot.handle(request.body);
    return { ok: true };
  }

  @Post(":webhookId")
  @HttpCode(202)
  webhook(@Param("webhookId") webhookId: string, @Req() request: RawBodyRequest<Request>): Promise<{ accepted: true }> {
    return this.webhooks.accept(webhookId, request.rawBody, request.headers);
  }
}

/** A pipeline's webhook, managed on its page. */
@Controller("pipelines/:pipelineId/webhook")
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get()
  async get(@CurrentUser() user: AuthenticatedUser, @Param("pipelineId", ParseUUIDPipe) pipelineId: string): Promise<{ webhook: WebhookView | null }> {
    return { webhook: await this.webhooks.get(user.userId, pipelineId) };
  }

  /** Creates it, or gives it a new secret (the answer is the only time the secret is shown). */
  @Put()
  rotate(@CurrentUser() user: AuthenticatedUser, @Param("pipelineId", ParseUUIDPipe) pipelineId: string): Promise<WebhookView> {
    return this.webhooks.rotate(user.userId, pipelineId);
  }

  @Delete()
  @HttpCode(204)
  remove(@CurrentUser() user: AuthenticatedUser, @Param("pipelineId", ParseUUIDPipe) pipelineId: string): Promise<void> {
    return this.webhooks.remove(user.userId, pipelineId);
  }
}
