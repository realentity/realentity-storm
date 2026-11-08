import { type DataEntity, type Prisma, type PrismaClient } from "@realentity/storm-db";
import { canMove, entityItem, readAppSource, type ApplicationStatusName, type DataType } from "@realentity/storm-shared";
import { contractProblems, JOB_ENTITY } from "@realentity/storm-steps";
import { type StepContext } from "../runner/step-executor";

type Item = Record<string, unknown>;

/** A Job's stage as the application.status it was (M12): the event its pipelines still start on. */
export const STAGE_STATUS: Record<string, ApplicationStatusName> = {
  prepared: "PREPARED",
  applied: "SUBMITTED",
  responded: "RESPONDED",
  interview: "INTERVIEW",
  rejected: "REJECTED",
};

export interface JobApp {
  appId: string;
  app: string;
  type: DataType;
}

/**
 * The pipeline's App when it keeps jobs (M33): a Job type the job steps can move. Null outside an App: the steps then
 * work on what the old Jobs page kept, until it goes (M33-T4).
 */
export async function jobAppOf(prisma: PrismaClient, context: StepContext): Promise<JobApp | null> {
  if (!context.app) return null;
  const row = await prisma.app.findUnique({ where: { userId_name: { userId: context.userId, name: context.app } } });
  const version = row?.currentVersionId ? await prisma.appVersion.findUnique({ where: { appVersionId: row.currentVersionId } }) : null;
  if (!row || !version) return null;
  const app = readAppSource(version.source);
  const type = Object.hasOwn(app.types, JOB_ENTITY.type) ? app.types[JOB_ENTITY.type] : undefined;
  return type && contractProblems(type, JOB_ENTITY).length === 0 ? { appId: row.appId, app: app.name, type } : null;
}

/** Every App of the user's that keeps jobs: Insight and the weekly review count them all. */
export async function jobAppIds(prisma: PrismaClient, userId: string): Promise<string[]> {
  const apps = await prisma.app.findMany({ where: { userId, currentVersionId: { not: null } } });
  const versions = await prisma.appVersion.findMany({ where: { appVersionId: { in: apps.map((a) => a.currentVersionId!) } } });
  return apps.flatMap((app) => {
    const version = versions.find((v) => v.appVersionId === app.currentVersionId);
    if (!version) return [];
    const type = readAppSource(version.source).types[JOB_ENTITY.type];
    return type && contractProblems(type, JOB_ENTITY).length === 0 ? [app.appId] : [];
  });
}

/** A Job as its pipelines and events see it: what was read, the user's fields, its stage. */
export function jobItem(job: JobApp, entity: Pick<DataEntity, "value" | "mine" | "stage">): Item {
  return entityItem(entity.value, entity.mine, { field: job.type.stages!.field, value: entity.stage ?? job.type.stages!.initial });
}

/**
 * Moves a Job as a pipeline may (forward only, as the type's moves say), keeping when it first reached the stage, and
 * tells: entity.changed, and application.status for an application's stages. False when it may not move there.
 */
export async function moveJob(
  prisma: PrismaClient,
  context: StepContext,
  job: JobApp,
  entity: DataEntity,
  to: string,
  note?: string,
): Promise<boolean> {
  const stages = job.type.stages!;
  const from = entity.stage ?? stages.initial;
  if (from === to || !canMove(stages, from, to, "pipeline")) return false;
  if (context.dryRun) return true;
  const stageDates = { ...(entity.stageDates as Record<string, string>) };
  stageDates[to] ??= new Date().toISOString();
  const mine = { ...(entity.mine as Item) };
  if (note && "comments" in job.type.fields && job.type.fields.comments?.mine) {
    mine.comments = typeof mine.comments === "string" && mine.comments ? `${mine.comments}\n${note}` : note;
  }
  await prisma.dataEntity.update({
    where: { dataEntityId: entity.dataEntityId },
    data: { stage: to, stageDates, mine: mine as Prisma.InputJsonObject },
  });
  const before = jobItem(job, entity);
  const item = jobItem(job, { ...entity, stage: to, mine: mine as Prisma.JsonObject });
  await context.emit?.("entity.changed", {
    app: job.app,
    appId: job.appId,
    type: JOB_ENTITY.type,
    key: entity.key,
    item,
    before,
    changed: [stages.field],
    by: "pipeline",
    stage: { from, to },
  });
  await emitStatus(context, entity, to, item);
  return true;
}

/** application.status (M12-T1) for a Job reaching an application's stage; the Job's id is the application's. */
export async function emitStatus(context: StepContext, entity: DataEntity, stage: string, item: Item): Promise<void> {
  const status = STAGE_STATUS[stage];
  if (!status) return;
  await context.emit?.("application.status", {
    applicationId: entity.dataEntityId,
    status,
    job: { title: text(item.title), company: text(item.company) ?? null, location: text(item.location) ?? null, url: entity.key },
  });
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
