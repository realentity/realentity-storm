import { seal, KeyRing } from "@realentity/storm-crypto";
import { JobQueue } from "@realentity/storm-queue";
import { isWebhookTrigger, type CompiledDefinition, type ServerEnv, type WebhookView } from "@realentity/storm-shared";
import { Inject, Injectable, NotFoundException, PayloadTooLargeException, UnauthorizedException, UnsupportedMediaTypeException } from "@nestjs/common";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type IncomingHttpHeaders } from "node:http";
import { SERVER_ENV } from "../config/server-env";
import { PrismaService } from "../database/prisma.service";

/** The largest body a webhook takes (hooks-gateway on the VPS limits it the same). */
export const MAX_WEBHOOK_BYTES = 64 * 1024;
const WEBHOOK_ID = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE = /^sha256=[0-9a-f]{64}$/;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Webhooks (M12-T2): a pipeline's address and secret, and accepting a call to it. The api checks what it can
 * without decrypting anything (the address, the pipeline, the size, a bearer token against its hash) and queues the
 * call; the worker checks an hmac-sha256 signature with the sealed secret and starts the run.
 */
@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: KeyRing,
    private readonly queue: JobQueue,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  async get(userId: string, pipelineId: string): Promise<WebhookView | null> {
    await this.pipeline(userId, pipelineId);
    const hook = await this.prisma.client.webhook.findUnique({ where: { pipelineId } });
    return hook ? this.view(hook) : null;
  }

  /** A new secret, shown in this answer only; the address stays (a first call creates it). */
  async rotate(userId: string, pipelineId: string): Promise<WebhookView> {
    await this.pipeline(userId, pipelineId);
    const existing = await this.prisma.client.webhook.findUnique({ where: { pipelineId } });
    const webhookId = existing?.webhookId ?? randomBytes(32).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    const sealed = seal(this.keys, webhookId, secret);
    const data = { secretHash: sha256(secret), ...sealed };
    const hook = await this.prisma.client.webhook.upsert({
      where: { pipelineId },
      create: { webhookId, userId, pipelineId, ...data },
      update: data,
    });
    return { ...this.view(hook), secret };
  }

  async remove(userId: string, pipelineId: string): Promise<void> {
    await this.pipeline(userId, pipelineId);
    await this.prisma.client.webhook.deleteMany({ where: { pipelineId } });
  }

  /** A call from the Internet: 404 for anything that isn't a webhook of an enabled pipeline with a webhook trigger. */
  async accept(webhookId: string, body: Buffer | undefined, headers: IncomingHttpHeaders): Promise<{ accepted: true }> {
    if (!WEBHOOK_ID.test(webhookId)) throw new NotFoundException();
    const hook = await this.prisma.client.webhook.findUnique({ where: { webhookId }, include: { pipeline: true } });
    if (!hook?.pipeline.enabled || !hook.pipeline.currentVersionId) throw new NotFoundException();
    const version = await this.prisma.client.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId: hook.pipeline.currentVersionId } });
    const trigger = (version.definition as unknown as CompiledDefinition).trigger;
    if (!isWebhookTrigger(trigger)) throw new NotFoundException();
    if (!body) throw new UnsupportedMediaTypeException("A JSON or form body");
    if (body.length > MAX_WEBHOOK_BYTES) throw new PayloadTooLargeException(`At most ${MAX_WEBHOOK_BYTES / 1024} KB`);

    const signature = header(headers, "x-hub-signature-256");
    if (trigger.webhook === "token") {
      const token = /^Bearer (\S+)$/.exec(header(headers, "authorization") ?? "")?.[1];
      if (!token || !sameHex(sha256(token), hook.secretHash)) throw new UnauthorizedException();
    } else if (!signature || !SIGNATURE.test(signature)) {
      throw new UnauthorizedException();
    }
    await this.queue.enqueueWebhook({
      webhookId,
      body: body.toString("base64"),
      signature: trigger.webhook === "hmac-sha256" ? signature! : null,
      event: (header(headers, "x-github-event") ?? header(headers, "x-event"))?.slice(0, 100) ?? null,
      receivedAt: new Date().toISOString(),
    });
    return { accepted: true };
  }

  private async pipeline(userId: string, pipelineId: string): Promise<void> {
    const pipeline = await this.prisma.client.pipeline.findFirst({ where: { pipelineId, userId } });
    if (!pipeline) throw new NotFoundException();
  }

  private view(hook: { webhookId: string; lastCalledAt: Date | null; dateCreated: Date }): WebhookView {
    return {
      path: `/hooks/${hook.webhookId}`,
      url: this.env.HOOKS_PUBLIC_URL ? `${this.env.HOOKS_PUBLIC_URL}/${hook.webhookId}` : null,
      lastCalledAt: hook.lastCalledAt?.toISOString() ?? null,
      dateCreated: hook.dateCreated.toISOString(),
    };
  }
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sameHex(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
