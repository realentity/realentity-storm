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

/**
 * The App a pipeline's version belongs to (M39-T3): the one it was saved with, by id (renamed since, under its name
 * now); else the one it names. Null: none, or one that is gone.
 */
export function appOf<A extends { appId: string; name: string }>(
  definition: Pick<CompiledDefinition, "app" | "refs"> | undefined,
  apps: readonly A[],
): A | null {
  if (!definition) return null;
  if (definition.refs?.appId) return apps.find((a) => a.appId === definition.refs!.appId) ?? null;
  return definition.app ? (apps.find((a) => a.name === definition.app) ?? null) : null;
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
  const apps = await prisma.app.findMany({ where: { userId }, select: { appId: true, name: true } });
  const byApp = new Map<string, AppPipelineView[]>();
  for (const pipeline of pipelines) {
    const compiled = versions.find((v) => v.pipelineVersionId === pipeline.currentVersionId)?.definition as unknown as
      CompiledDefinition | undefined;
    const app = appOf(compiled, apps)?.name;
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
