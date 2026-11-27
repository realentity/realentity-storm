import { type Prisma } from "@realentity/storm-db";
import { checkEntity, readAppSource, type AppImportRequest, type AppDefinition, type AppImportResult, type AppImportView } from "@realentity/storm-shared";
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

/**
 * M33-T5: a collection a pipeline's data.save kept (M13) moved into one of an App's types, when a pipeline grows into an
 * App: its rows become entities, once (a moved one is skipped, so pressing it again moves only what came since).
 */
@Injectable()
export class AppImportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The collections this App can take: any, into a type pipelines write. */
  async available(userId: string, app: AppDefinition): Promise<AppImportView[]> {
    if (!Object.values(app.types).some((t) => !t.mine)) return [];
    const collections = await this.prisma.client.dataRecord.groupBy({ by: ["collection"], where: { userId }, _count: { _all: true }, orderBy: { collection: "asc" } });
    return collections.map((c) => ({ from: "collection", collection: c.collection, label: `the "${c.collection}" collection`, count: c._count._all }));
  }

  async move(userId: string, appId: string, { collection, type }: AppImportRequest): Promise<AppImportResult> {
    const row = await this.prisma.client.app.findFirst({ where: { appId, userId } });
    const version = row?.currentVersionId
      ? await this.prisma.client.appVersion.findUnique({ where: { appVersionId: row.currentVersionId } })
      : null;
    if (!row || !version) throw new NotFoundException();
    const app = readAppSource(version.source);
    if (!(await this.available(userId, app)).some((i) => i.collection === collection)) {
      throw new ConflictException(`"${app.name}" can't take the "${collection}" collection: it needs a type pipelines write`);
    }
    return this.moveCollection(userId, appId, app, collection, type);
  }

  /**
   * A collection's rows (M33-T5) as entities of a type pipelines write: each value checked as the type says (one
   * without its key or a required field stays behind), a mark of the user's on the row as the yes/no field (mine) of its
   * name (Upgraded → upgraded: true). A row already here (by key) is skipped.
   */
  private async moveCollection(userId: string, appId: string, app: AppDefinition, collection: string, typeName: string): Promise<AppImportResult> {
    const type = Object.hasOwn(app.types, typeName) ? app.types[typeName] : undefined;
    if (!type || type.mine) throw new ConflictException(`"${app.name}" has no type ${typeName} pipelines write`);
    const records = await this.prisma.client.dataRecord.findMany({ where: { userId, collection }, orderBy: { firstSeenAt: "asc" } });
    const here = new Set((await this.prisma.client.dataEntity.findMany({ where: { appId, type: typeName }, select: { key: true } })).map((e) => e.key));
    const data: Prisma.DataEntityCreateManyInput[] = [];
    for (const record of records) {
      const checked = checkEntity(type, record.value as Record<string, unknown>);
      if (checked.rejected || !checked.key || here.has(checked.key)) continue;
      here.add(checked.key);
      const marks = Object.keys((record.marks ?? {}) as Record<string, string>);
      const mine = Object.fromEntries(marks.filter((m) => type.fields[m]?.mine && type.fields[m]?.type === "yesno").map((m) => [m, true]));
      data.push({
        appId,
        type: typeName,
        key: checked.key,
        value: checked.value as Prisma.InputJsonObject,
        mine,
        ...(type.stages ? { stage: type.stages.initial, stageDates: { [type.stages.initial]: record.firstSeenAt.toISOString() } } : {}),
        firstSeenAt: record.firstSeenAt,
        lastSeenAt: record.lastSeenAt,
        removedAt: record.removedAt,
      });
    }
    await this.prisma.client.dataEntity.createMany({ data });
    return { moved: data.length, skipped: records.length - data.length };
  }
}
