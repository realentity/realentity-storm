import { type PrismaClient } from "@realentity/storm-db";
import { isEventTrigger, type AppPipelineView, type CompiledDefinition, type Trigger } from "@realentity/storm-shared";

/**
 * Whether a pipeline runs only while it is on: a schedule, an event, a command or a webhook. One started by hand or by
 * an entity's button runs when started, on or off (M40-T3: an example's checklist doesn't ask to switch it on).
 */
export function runsOnItsOwn(trigger: Trigger | undefined): boolean {
  if (trigger === undefined || trigger === "manual") return false;
  return !(isEventTrigger(trigger) && trigger.on === "entity.action");
}

/** Each App's pipelines (by the App's name now), with whether they are on and what that means. */
export async function pipelinesByApp(prisma: PrismaClient, userId: string): Promise<Map<string, AppPipelineView[]>> {
  const pipelines = await prisma.pipeline.findMany({
    where: { userId, currentVersionId: { not: null } },
    orderBy: { name: "asc" },
  });
  const versions = await prisma.pipelineVersion.findMany({
    where: { pipelineVersionId: { in: pipelines.map((p) => p.currentVersionId!) } },
    select: { pipelineVersionId: true, definition: true },
  });
  const appNames = new Map((await prisma.app.findMany({ where: { userId } })).map((a) => [a.appId, a.name]));
  const byApp = new Map<string, AppPipelineView[]>();
  for (const pipeline of pipelines) {
    const compiled = versions.find((v) => v.pipelineVersionId === pipeline.currentVersionId)?.definition as unknown as
      | CompiledDefinition
      | undefined;
    // M39-T3: the App its version was saved with, by id (renamed since, it is under its name now); else by name.
    const app = compiled?.refs?.appId ? appNames.get(compiled.refs.appId) : compiled?.app;
    if (!app) continue;
    const trigger = compiled?.trigger;
    const command = trigger !== undefined && isEventTrigger(trigger) && trigger.on === "telegram.command" ? trigger.command : null;
    byApp.set(app, [
      ...(byApp.get(app) ?? []),
      { pipelineId: pipeline.pipelineId, name: pipeline.name, enabled: pipeline.enabled, runsOnItsOwn: runsOnItsOwn(trigger), command },
    ]);
  }
  return byApp;
}

/** An App none of whose pipelines that run on their own is on: installed, but nothing happens by itself yet. */
export function nothingOn(pipelines: readonly AppPipelineView[]): boolean {
  const own = pipelines.filter((p) => p.runsOnItsOwn);
  return own.length > 0 && own.every((p) => !p.enabled);
}
