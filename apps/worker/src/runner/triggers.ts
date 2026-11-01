import { open, type KeyRing } from "@ai-me/crypto";
import { type PrismaClient } from "@ai-me/db";
import { type EventJob, type JobQueue, type LaterJob, type WebhookJob } from "@ai-me/queue";
import { isEventTrigger, isWebhookTrigger, type CompiledDefinition, type EventTrigger } from "@ai-me/shared";
import { Logger } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { type LaterStarts } from "./later";
import { type PipelineRunner } from "./pipeline-runner";

/** A run started by an event is one deeper than the run whose event it was; deeper than this, nothing starts. */
export const MAX_CHAIN_DEPTH = 3;

/**
 * Starts the pipelines triggered by what happens (M12-T1), by webhook calls (M12-T2) and by flow.later (M14-T3).
 * Only enabled pipelines, never with the kill switch on, never a pipeline on its own event, and chains stop at
 * MAX_CHAIN_DEPTH. An event first cancels the flow.later starts it was to cancel.
 */
export class Triggers {
  private readonly logger = new Logger(Triggers.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly runner: PipelineRunner,
    private readonly queue: JobQueue,
    private readonly keys: KeyRing,
    private readonly later?: LaterStarts,
  ) {}

  /** The runs it started. */
  async fire(job: EventJob): Promise<string[]> {
    const cancelled = (await this.later?.cancelByEvent(job)) ?? 0;
    if (cancelled) this.logger.log(`${job.event} cancelled ${cancelled} flow.later start(s)`);
    const depth = job.source.depth + 1;
    if (depth > MAX_CHAIN_DEPTH) {
      this.logger.warn(`${job.event} from run ${job.source.runId ?? "?"} starts nothing: ${MAX_CHAIN_DEPTH} triggered runs in a chain already`);
      return [];
    }
    if (await this.paused(job.userId)) return [];
    const started: string[] = [];
    for (const { pipelineId, name, versionId, trigger } of await this.enabled(job.userId)) {
      if (!isEventTrigger(trigger) || !matches(trigger, job)) continue;
      if (pipelineId === job.source.pipelineId) {
        this.logger.warn(`"${name}" is triggered by its own ${job.event}: not started`);
        continue;
      }
      started.push(
        await this.start(versionId, {
          trigger: "event",
          triggerData: job.data,
          chainDepth: depth,
          ...(job.source.runId ? { triggeredByRunId: job.source.runId } : {}),
        }),
      );
    }
    return started;
  }

  /**
   * A webhook call the api accepted (it checked the address, the size and a bearer token): an hmac-sha256 one is
   * checked here, where the secret can be opened. A bad signature starts nothing (the caller already got 202).
   */
  async webhook(call: WebhookJob): Promise<string | null> {
    const hook = await this.prisma.webhook.findUnique({ where: { webhookId: call.webhookId }, include: { pipeline: true } });
    if (!hook?.pipeline.enabled || !hook.pipeline.currentVersionId) return null;
    const version = await this.prisma.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId: hook.pipeline.currentVersionId } });
    const trigger = (version.definition as unknown as CompiledDefinition).trigger;
    if (!isWebhookTrigger(trigger)) return null;
    const body = Buffer.from(call.body, "base64");
    if (trigger.webhook === "hmac-sha256") {
      const secret = open(this.keys, hook.webhookId, hook);
      const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
      if (!call.signature || !sameText(call.signature, expected)) {
        this.logger.warn(`Webhook of "${hook.pipeline.name}": wrong or missing signature; not started`);
        return null;
      }
    }
    if (await this.paused(hook.userId)) return null;
    await this.prisma.webhook.update({ where: { webhookId: hook.webhookId }, data: { lastCalledAt: new Date() } });
    return this.start(version.pipelineVersionId, {
      trigger: "webhook",
      triggerData: { body: parseBody(body), event: call.event, receivedAt: call.receivedAt },
    });
  }

  /** A flow.later start whose time has come: its pipeline, once, if it is still enabled and the kill switch is off. */
  async fireLater(job: LaterJob): Promise<string | null> {
    if (!this.later) return null;
    const row = await this.later.claim(job.scheduledStartId);
    if (!row) return null;
    const skip = async (reason: string) => {
      await this.later!.finish(row.scheduledStartId, { skipped: reason });
      this.logger.log(`flow.later start skipped: ${reason}`);
      return null;
    };
    if (await this.paused(row.userId)) return skip("the kill switch was on");
    const pipeline = await this.prisma.pipeline.findUnique({ where: { pipelineId: row.pipelineId } });
    if (!pipeline?.enabled || !pipeline.currentVersionId) return skip(`"${pipeline?.name ?? "?"}" isn't enabled`);
    const version = await this.prisma.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId: pipeline.currentVersionId } });
    const trigger = (version.definition as unknown as CompiledDefinition).trigger;
    if (!isEventTrigger(trigger) || trigger.on !== "flow.later") return skip(`"${pipeline.name}" isn't triggered by flow.later any more`);
    const scheduledBy = row.scheduledByRunId ? await this.prisma.run.findUnique({ where: { runId: row.scheduledByRunId } }) : null;
    const depth = (scheduledBy?.chainDepth ?? 0) + 1;
    if (depth > MAX_CHAIN_DEPTH) return skip(`${MAX_CHAIN_DEPTH} triggered runs in a chain already`);
    const runId = await this.start(version.pipelineVersionId, {
      trigger: "event",
      triggerData: { data: row.data, key: row.key, scheduledAt: row.dateCreated.toISOString(), scheduledByRunId: row.scheduledByRunId },
      chainDepth: depth,
      ...(row.scheduledByRunId ? { triggeredByRunId: row.scheduledByRunId } : {}),
    });
    await this.later.finish(row.scheduledStartId, { runId });
    return runId;
  }

  private async start(versionId: string, options: Parameters<PipelineRunner["start"]>[1]): Promise<string> {
    const runId = await this.runner.start(versionId, options);
    await this.queue.enqueueRun(await this.prisma.run.findUniqueOrThrow({ where: { runId } }));
    return runId;
  }

  private async paused(userId: string): Promise<boolean> {
    const paused = (await this.prisma.userSetting.findUnique({ where: { userId } }))?.paused ?? false;
    if (paused) this.logger.log("Kill switch is on: triggered runs skipped");
    return paused;
  }

  private async enabled(userId: string) {
    const pipelines = await this.prisma.pipeline.findMany({ where: { userId, enabled: true, currentVersionId: { not: null } } });
    const versions = await this.prisma.pipelineVersion.findMany({
      where: { pipelineVersionId: { in: pipelines.map((p) => p.currentVersionId!) } },
    });
    const byId = new Map(versions.map((v) => [v.pipelineVersionId, v]));
    return pipelines.flatMap((p) => {
      const version = byId.get(p.currentVersionId!);
      if (!version) return [];
      const trigger = (version.definition as unknown as CompiledDefinition).trigger;
      return [{ pipelineId: p.pipelineId, name: p.name, versionId: version.pipelineVersionId, trigger }];
    });
  }
}

function matches(trigger: EventTrigger, job: EventJob): boolean {
  if (trigger.on !== job.event) return false;
  const data = job.data;
  switch (trigger.on) {
    case "run.finished":
      return data.pipeline === trigger.pipeline && (trigger.status ?? ["DONE"]).includes(data.status as "DONE");
    case "application.status":
      return !trigger.status || trigger.status.includes(data.status as (typeof trigger.status)[number]);
    case "recipe.broken":
      return !trigger.site || data.site === trigger.site;
    case "email.classified":
      return !trigger.label || trigger.label.includes(data.label as string);
    case "flow.later":
      // Started by its own scheduled start (fireLater), never by an event.
      return false;
  }
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** JSON as data; anything else as its text. */
function parseBody(body: Buffer): unknown {
  const text = body.toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
