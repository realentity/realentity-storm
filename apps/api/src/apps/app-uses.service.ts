import {
  identifiedUses,
  narrowedType,
  readAppSource,
  useProblems,
  type AppDefinition,
  type DataType,
  type AppUse,
  type AppUseSourceView,
  type AppUsesRequest,
  type AppUseView,
} from "@realentity/storm-shared";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

/**
 * M66: a use as an App's pages read it: chosen and still fitting. The chosen App's id, its type's name, the type
 * narrowed to the declared fields, and its title (by which a ref names one).
 */
export interface ChosenUse {
  appId: string;
  typeName: string;
  type: DataType;
  fields: string[];
  title: string;
}

/** One of the user's Apps as it is now: its id, name and definition. */
interface InstalledApp {
  appId: string;
  name: string;
  definition: AppDefinition;
}

/**
 * M66: which of the user's Apps fills each use of another App's type (`uses:`), by id, never by name: chosen at
 * install or in the App's settings. A use is filled only by another App of the same user whose type has the declared
 * fields, none of them encrypted, a credential or a file.
 */
@Injectable()
export class AppUsesService {
  constructor(private readonly prisma: PrismaService) {}

  /** An App's uses, what fills each and what could. */
  async of(userId: string, appId: string): Promise<AppUseView[]> {
    const apps = await this.installed(userId);
    const app = apps.find((a) => a.appId === appId);
    if (!app) throw new NotFoundException();
    const rows = await this.prisma.client.appUse.findMany({ where: { appId } });
    const identified = identifiedUses(app.definition);
    return Object.entries(app.definition.uses ?? {}).map(([name, use]) => {
      const fits = fitting(use, apps, appId, identified.has(name));
      const row = rows.find((r) => r.name === name);
      const owner = row ? apps.find((a) => a.appId === row.sourceAppId) : undefined;
      if (!row || !owner) return { name, use, source: null, problems: [], fits };
      const type = Object.hasOwn(owner.definition.types, row.sourceType) ? owner.definition.types[row.sourceType] : undefined;
      const problems = type ? useProblems(use, type, identified.has(name)) : [`${owner.name} has no type ${row.sourceType} any more`];
      return { name, use, source: { appId: owner.appId, app: owner.name, type: row.sourceType }, problems, fits };
    });
  }

  /**
   * M66: an App's uses that its pages can read now: chosen, of one of the user's Apps, and still fitting. One not
   * chosen, or no longer fitting, isn't there: a page shows nothing of it (the App's page says why).
   */
  async chosen(userId: string, appId: string, definition: AppDefinition): Promise<Map<string, ChosenUse>> {
    const uses = definition.uses ?? {};
    const found = new Map<string, ChosenUse>();
    const rows = await this.prisma.client.appUse.findMany({ where: { appId } });
    const owners = await this.installed(userId, rows.map((r) => r.sourceAppId));
    const identified = identifiedUses(definition);
    for (const row of rows) {
      const use = Object.hasOwn(uses, row.name) ? uses[row.name] : undefined;
      const owner = owners.find((a) => a.appId === row.sourceAppId);
      const type = owner && Object.hasOwn(owner.definition.types, row.sourceType) ? owner.definition.types[row.sourceType] : undefined;
      if (!use || !owner || !type || useProblems(use, type, identified.has(row.name)).length > 0) continue;
      found.set(row.name, { appId: owner.appId, typeName: row.sourceType, type: narrowedType(type, use), fields: use.fields, title: type.title ?? type.key });
    }
    return found;
  }

  /** `{ use: { appId, type } }` fills a use (only with what fits it); null clears it. */
  async set(userId: string, appId: string, body: AppUsesRequest): Promise<AppUseView[]> {
    const apps = await this.installed(userId);
    const app = apps.find((a) => a.appId === appId);
    if (!app) throw new NotFoundException();
    const uses = app.definition.uses ?? {};
    const identified = identifiedUses(app.definition);
    const problems: { path: string; message: string }[] = [];
    for (const [name, value] of Object.entries(body)) {
      const use = Object.hasOwn(uses, name) ? uses[name] : undefined;
      if (!use) problems.push({ path: name, message: "isn't one of its uses" });
      else if (value && !fitting(use, apps, appId, identified.has(name)).some((f) => f.appId === value.appId && f.type === value.type))
        problems.push({ path: name, message: unfit(apps, appId, use, value, identified.has(name)) });
    }
    if (problems.length > 0) throw new BadRequestException({ message: "Some uses can't be filled", errors: problems });
    for (const [name, value] of Object.entries(body)) {
      if (value === null) await this.prisma.client.appUse.deleteMany({ where: { appId, name } });
      else
        await this.prisma.client.appUse.upsert({
          where: { appId_name: { appId, name } },
          create: { appId, name, sourceAppId: value.appId, sourceType: value.type },
          update: { sourceAppId: value.appId, sourceType: value.type },
        });
    }
    return this.of(userId, appId);
  }

  /**
   * After an App is installed (`before` null) or saved: a use is filled by the App and type its `from` names only when
   * that has just become possible, so a choice the user cleared stays cleared:
   * - the App's own uses that are new (all of them at install), by the one App of that name whose type fits;
   * - other Apps' uses not filled, when this App is the one they name and it fits now but didn't before (installed,
   *   renamed to that name, or given the fields).
   * Never another App by a guess: two Apps of that name, or one named otherwise, wait for the user's choice. Its uses
   * gone from its YAML are let go.
   */
  async fillWhereNamed(userId: string, appId: string, before: AppDefinition | null): Promise<void> {
    const apps = await this.installed(userId);
    const app = apps.find((a) => a.appId === appId);
    if (!app) return;
    const rows = await this.prisma.client.appUse.findMany({ where: { appId: { in: apps.map((a) => a.appId) } } });
    const uses = app.definition.uses ?? {};
    const gone = rows.filter((r) => r.appId === appId && !Object.hasOwn(uses, r.name));
    if (gone.length > 0) await this.prisma.client.appUse.deleteMany({ where: { appUseId: { in: gone.map((r) => r.appUseId) } } });

    const fill = async (consumer: InstalledApp, name: string, use: AppUse) => {
      if (rows.some((r) => r.appId === consumer.appId && r.name === name)) return;
      const named = fitting(use, apps, consumer.appId, identifiedUses(consumer.definition).has(name)).filter((f) => f.app === use.from.app && f.type === use.from.type);
      if (named.length === 1)
        await this.prisma.client.appUse.create({ data: { appId: consumer.appId, name, sourceAppId: named[0].appId, sourceType: named[0].type } });
    };
    for (const [name, use] of Object.entries(uses)) if (!before?.uses?.[name]) await fill(app, name, use);
    for (const other of apps) {
      if (other.appId === appId) continue;
      const identified = identifiedUses(other.definition);
      for (const [name, use] of Object.entries(other.definition.uses ?? {})) {
        if (use.from.app !== app.name || !Object.hasOwn(app.definition.types, use.from.type)) continue;
        if (useProblems(use, app.definition.types[use.from.type], identified.has(name)).length > 0) continue;
        const fitBefore =
          before?.name === use.from.app &&
          Object.hasOwn(before.types, use.from.type) &&
          useProblems(use, before.types[use.from.type], identified.has(name)).length === 0;
        if (!fitBefore) await fill(other, name, use);
      }
    }
  }

  /** The user's Apps with a current version (`ids`: only these). */
  private async installed(userId: string, ids?: string[]): Promise<InstalledApp[]> {
    const apps = await this.prisma.client.app.findMany({
      where: { userId, currentVersionId: { not: null }, ...(ids ? { appId: { in: ids } } : {}) },
      select: { appId: true, name: true, currentVersionId: true },
    });
    const versions = await this.prisma.client.appVersion.findMany({
      where: { appVersionId: { in: apps.map((a) => a.currentVersionId!) } },
      select: { appVersionId: true, source: true },
    });
    return apps.flatMap((app) => {
      const version = versions.find((v) => v.appVersionId === app.currentVersionId);
      return version ? [{ appId: app.appId, name: app.name, definition: readAppSource(version.source) }] : [];
    });
  }
}

/** The user's other Apps' types that fit a use: the one `from` names first, then by App and type. */
function fitting(use: AppUse, apps: InstalledApp[], appId: string, identified: boolean): AppUseSourceView[] {
  const fits = apps
    .filter((a) => a.appId !== appId)
    .flatMap((a) =>
      Object.entries(a.definition.types)
        .filter(([, type]) => useProblems(use, type, identified).length === 0)
        .map(([type]) => ({ appId: a.appId, app: a.name, type })),
    );
  const named = (f: AppUseSourceView) => (f.app === use.from.app && f.type === use.from.type ? 0 : 1);
  return fits.sort((a, b) => named(a) - named(b) || a.app.localeCompare(b.app) || a.type.localeCompare(b.type));
}

/** Why a choice can't fill a use. */
function unfit(apps: InstalledApp[], appId: string, use: AppUse, value: { appId: string; type: string }, identified: boolean): string {
  if (value.appId === appId) return "an App's own types aren't a use: use them directly";
  const owner = apps.find((a) => a.appId === value.appId);
  if (!owner) return "no such App";
  const type = Object.hasOwn(owner.definition.types, value.type) ? owner.definition.types[value.type] : undefined;
  if (!type) return `${owner.name} has no type ${value.type}`;
  return `${owner.name} › ${value.type} doesn't fit: ${useProblems(use, type, identified).join("; ")}`;
}
