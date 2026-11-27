import { type DataEntity, type Prisma, type PrismaClient } from "@realentity/storm-db";
import { canMove, entityItem, readAppSource, type DataType } from "@realentity/storm-shared";
import { contractProblems, JOB_ENTITY } from "@realentity/storm-steps";
import { type StepContext } from "../runner/step-executor";

type Item = Record<string, unknown>;

export interface JobApp {
  appId: string;
  app: string;
  type: DataType;
}

/**
 * The pipeline's App when it keeps jobs (M33): a Job type the job steps can move. Null outside an App, or without one.
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

/** A Job as its pipelines and events see it: what was read, the user's fields, its stage. */
export function jobItem(job: JobApp, entity: Pick<DataEntity, "value" | "mine" | "stage">): Item {
  return entityItem(entity.value, entity.mine, { field: job.type.stages!.field, value: entity.stage ?? job.type.stages!.initial });
}

/**
 * Moves a Job as a pipeline may (forward only, as the type's moves say), keeping when it first reached the stage, and
 * tells: entity.changed. False when it may not move there.
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
  return true;
}
