import { type DataEntity, type Prisma } from "@realentity/storm-db";
import { JobQueue } from "@realentity/storm-queue";
import {
  actionApplies,
  addedByHand,
  autoKey,
  newKey,
  canMove,
  canonicalJson,
  checkFormValues,
  entityItem,
  entityValueAt,
  FILE_KINDS,
  isEventTrigger,
  isWebhookTrigger,
  listPageOf,
  readAppSource,
  viewPageOf,
  type AppDefinition,
  type AppRefs,
  type CompiledDefinition,
  type DataType,
  type EntityActionDef,
  type RunDetailView,
} from "@realentity/storm-shared";
import { contractProblems, JOB_ENTITY } from "@realentity/storm-steps";
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { RunsService } from "../runs/runs.service";
import { AppFilesService } from "./app-files.service";

type Item = Record<string, unknown>;

/** M46: a type's file and image fields. */
function fileFields(type: DataType): string[] {
  return Object.entries(type.fields).flatMap(([name, f]) => (FILE_KINDS.includes(f.type) ? [name] : []));
}

/** A Job's stage as the application.status it was (M12); the worker's job steps use the same. */
const STAGE_STATUS: Record<string, string> = { prepared: "PREPARED", applied: "SUBMITTED", responded: "RESPONDED", interview: "INTERVIEW", rejected: "REJECTED" };

/**
 * What the user does on an App's pages (M32): their fields on an entity's form, its stage moved as its moves allow them,
 * entities of a type of mine added and deleted, and buttons that start pipelines. Each change tells the App's pipelines
 * (entity.changed, by: me); a button's run is an ordinary one: gates, the policy and the kill switch hold.
 */
@Injectable()
export class EntityActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: JobQueue,
    private readonly runs: RunsService,
    private readonly files: AppFilesService,
  ) {}

  /**
   * The fields on the entity's form; null or "" clears one, so a field pipelines write too shows theirs again (M45:
   * Reset).
   */
  async saveValues(userId: string, appId: string, typeName: string, key: string, values: Item): Promise<void> {
    const { app, type } = await this.app(userId, appId, typeName);
    const entity = await this.entity(appId, typeName, key);
    const allowed = viewPageOf(app, typeName).form.map((f) => f.field);
    const checked = await this.files.attach(appId, typeName, key, this.check(type, allowed, values), fileFields(type));
    const mine = { ...(entity.mine as Item) };
    for (const [field, value] of Object.entries(checked)) {
      if (value === null) delete mine[field];
      else mine[field] = value;
    }
    const before = this.item(type, entity);
    await this.prisma.client.dataEntity.update({
      where: { dataEntityId: entity.dataEntityId },
      data: { mine: mine as Prisma.InputJsonObject },
    });
    // M46: a file replaced or cleared goes; one a pipeline's value still names stays.
    await this.files.release(appId, typeName, key, entity.value, mine);
    const after = this.item(type, { ...entity, mine: mine as Prisma.JsonObject });
    const changed = Object.keys(checked).filter(
      (f) => canonicalJson(entityValueAt(before, f) ?? null) !== canonicalJson(entityValueAt(after, f) ?? null),
    );
    if (changed.length > 0) await this.tell(userId, appId, app, typeName, key, after, before, changed, null);
  }

  /** Moves its stage, as a move by: [me] allows; the date it first reached a state is kept. */
  async move(userId: string, appId: string, typeName: string, key: string, to: string): Promise<void> {
    const { app, type } = await this.app(userId, appId, typeName);
    const stages = type.stages;
    if (!stages) throw new NotFoundException(`${typeName} has no stages`);
    const entity = await this.entity(appId, typeName, key);
    const from = entity.stage ?? stages.initial;
    if (from === to) return;
    if (!canMove(stages, from, to, "me")) throw new ConflictException(`${typeName} can't move from ${from} to ${to}`);
    const stageDates = { ...(entity.stageDates as Record<string, string>) };
    stageDates[to] ??= new Date().toISOString();
    const before = this.item(type, entity);
    await this.prisma.client.dataEntity.update({ where: { dataEntityId: entity.dataEntityId }, data: { stage: to, stageDates } });
    const after = this.item(type, { ...entity, stage: to });
    await this.tell(userId, appId, app, typeName, key, after, before, [stages.field], { from, to });
    // A Job reaching an application's stage (M33): the pipelines on application.status hear it, as from the Jobs page.
    const status = STAGE_STATUS[to];
    if (typeName === JOB_ENTITY.type && status && contractProblems(type, JOB_ENTITY).length === 0) {
      const text = (v: unknown) => (typeof v === "string" ? v : null);
      await this.queue.enqueueEvent({
        userId,
        event: "application.status",
        data: { applicationId: entity.dataEntityId, status, job: { title: text(after.title), company: text(after.company), location: text(after.location), url: key } },
        source: { depth: 0 },
      });
    }
  }

  /**
   * An entity added by hand, from its list's form (M32: a type of mine, every field; M45: a list with `add`, its key and
   * its form's fields). What I set is kept as mine, over what a pipeline writes later.
   */
  async create(userId: string, appId: string, typeName: string, values: Item): Promise<string> {
    const { app, type } = await this.app(userId, appId, typeName);
    if (!addedByHand(app, typeName)) throw new ConflictException(`${typeName} is added by pipelines; its list doesn't add one by hand`);
    const allowed = listPageOf(app, typeName).create!.map((f) => f.field);
    let checked = this.check(type, allowed, values);
    // M48: a key Storm makes.
    if (autoKey(type)) checked = { ...checked, [type.key]: await this.freshKey(appId, typeName) };
    const missing = Object.entries(type.fields).filter(
      ([name, f]) => (f.required || name === type.key) && allowed.includes(name) && (checked[name] ?? null) === null,
    );
    if (missing.length > 0) {
      throw new BadRequestException({
        message: "Some fields are required",
        errors: missing.map(([name]) => ({ path: name, message: "is required" })),
      });
    }
    const keyValue = checked[type.key];
    const key = typeof keyValue === "number" ? String(keyValue) : (keyValue as string);
    const stage = type.stages?.initial ?? null;
    const now = new Date();
    const existing = await this.prisma.client.dataEntity.findUnique({ where: { appId_type_key: { appId, type: typeName, key } } });
    if (existing) throw new ConflictException(`There is already a ${typeName} "${key}"`);
    checked = await this.files.attach(appId, typeName, key, checked, fileFields(type));
    const mine = Object.fromEntries(Object.entries(checked).filter(([name, value]) => name !== type.key && value !== null));
    const created = await this.prisma.client.dataEntity.create({
      data: {
        appId,
        type: typeName,
        key,
        value: { [type.key]: keyValue } as Prisma.InputJsonObject,
        mine: mine as Prisma.InputJsonObject,
        stage,
        stageDates: stage ? { [stage]: now.toISOString() } : {},
      },
    });
    const item = this.item(type, created);
    await this.tell(
      userId,
      appId,
      app,
      typeName,
      key,
      item,
      null,
      Object.keys(type.fields).filter((f) => entityValueAt(item, f) != null),
      stage ? { from: null, to: stage } : null,
    );
    return key;
  }

  /** M48: a key no entity of the type has yet. */
  private async freshKey(appId: string, typeName: string): Promise<string> {
    for (;;) {
      const key = newKey();
      if (!(await this.prisma.client.dataEntity.findUnique({ where: { appId_type_key: { appId, type: typeName, key } } }))) return key;
    }
  }

  /** An entity deleted by hand: of a type of mine, or one added by hand (M45). */
  async remove(userId: string, appId: string, typeName: string, key: string): Promise<void> {
    const { app } = await this.app(userId, appId, typeName);
    if (!addedByHand(app, typeName)) throw new ConflictException(`${typeName} is kept by pipelines; its list doesn't delete one by hand`);
    const entity = await this.entity(appId, typeName, key);
    await this.prisma.client.dataEntity.delete({ where: { dataEntityId: entity.dataEntityId } });
    await this.files.removeEntity(appId, typeName, key);
  }

  /**
   * A button: a list's (no key) starts a manual or scheduled pipeline as a manual run; an entity's starts one triggered
   * by { on: entity.action } of the same App, with the entity as {{trigger.item}}, while its `when` holds.
   */
  async act(userId: string, appId: string, typeName: string, index: number, key: string | undefined): Promise<RunDetailView> {
    const { app, type, refs } = await this.app(userId, appId, typeName);
    const action = key === undefined ? listPageOf(app, typeName).actions[index] : viewPageOf(app, typeName).actions[index];
    if (!action) throw new NotFoundException();
    // M39-T3: the pipeline the App's version was saved with, by id (renamed since, it is still the one); else by name.
    const id = refs?.pipelines[action.run];
    const target = await this.prisma.client.pipeline.findFirst({
      where: id ? { userId, pipelineId: id, currentVersionId: { not: null } } : { userId, name: action.run, currentVersionId: { not: null } },
    });
    if (!target?.currentVersionId) throw new NotFoundException(`No saved pipeline is called "${action.run}"`);
    const version = await this.prisma.client.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId: target.currentVersionId } });
    const definition = version.definition as unknown as CompiledDefinition;
    const trigger = definition.trigger;

    if (key === undefined) {
      if (isEventTrigger(trigger) || isWebhookTrigger(trigger)) {
        throw new ConflictException(`"${target.name}" is started by an event or a webhook, not by a button`);
      }
      return this.runs.start(userId, target.pipelineId, false);
    }
    if (!isEventTrigger(trigger) || trigger.on !== "entity.action") {
      throw new ConflictException(`"${target.name}" isn't triggered by { on: entity.action }, so an entity's button can't start it`);
    }
    const ofThisApp = definition.refs?.appId ? definition.refs.appId === appId : definition.app === app.name;
    if (!ofThisApp || (trigger.type && trigger.type !== typeName)) {
      throw new ConflictException(
        `"${target.name}" takes ${trigger.type ?? "entities"} of "${definition.app ?? "no App"}", not ${typeName} of "${app.name}"`,
      );
    }
    const entity = await this.entity(appId, typeName, key);
    const item = this.item(type, entity);
    if (!actionApplies({ when: (action as EntityActionDef).when }, item, entityValueAt)) {
      throw new ConflictException(`"${action.label}" doesn't apply to this ${typeName} now`);
    }
    return this.runs.startVersion(userId, version.pipelineVersionId, false, "view", {
      app: app.name,
      type: typeName,
      key,
      item,
      action: action.label,
    });
  }

  private check(type: DataType, allowed: string[], values: Item): Item {
    const { values: checked, problems } = checkFormValues(type, allowed, values);
    if (problems.length > 0) {
      throw new BadRequestException({
        message: "Some values can't be saved",
        errors: problems.map((p) => ({ path: p.field, message: p.message })),
      });
    }
    return checked;
  }

  private item(type: DataType, entity: Pick<DataEntity, "value" | "mine" | "stage">): Item {
    return entityItem(entity.value, entity.mine, type.stages ? { field: type.stages.field, value: entity.stage } : undefined);
  }

  /** entity.changed, by me: the App's pipelines watching the type start (the api queues it for the worker). */
  private async tell(
    userId: string,
    appId: string,
    app: AppDefinition,
    type: string,
    key: string,
    item: Item,
    before: Item | null,
    changed: string[],
    stage: { from: string | null; to: string } | null,
  ): Promise<void> {
    await this.queue.enqueueEvent({
      userId,
      event: "entity.changed",
      data: { app: app.name, appId, type, key, item, before, changed, by: "me", stage },
      source: { depth: 0 },
    });
  }

  private async app(userId: string, appId: string, typeName: string): Promise<{ app: AppDefinition; type: DataType; refs: AppRefs | null }> {
    const row = await this.prisma.client.app.findFirst({ where: { appId, userId } });
    const version = row?.currentVersionId
      ? await this.prisma.client.appVersion.findUnique({ where: { appVersionId: row.currentVersionId } })
      : null;
    if (!row || !version) throw new NotFoundException();
    const app = readAppSource(version.source);
    const type = Object.hasOwn(app.types, typeName) ? app.types[typeName] : undefined;
    if (!type) throw new NotFoundException(`"${app.name}" has no type "${typeName}"`);
    return { app, type, refs: version.refs as AppRefs | null };
  }

  private async entity(appId: string, type: string, key: string): Promise<DataEntity> {
    const entity = await this.prisma.client.dataEntity.findUnique({ where: { appId_type_key: { appId, type, key } } });
    if (!entity) throw new NotFoundException();
    return entity;
  }
}
