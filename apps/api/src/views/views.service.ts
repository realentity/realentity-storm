import { type DataRecord } from "@realentity/storm-db";
import {
  CHART_SERIES,
  fieldOf,
  isEventTrigger,
  isWebhookTrigger,
  type CompiledDefinition,
  type PipelineView,
  type RunDetailView,
  type ViewChart,
  type ViewHeader,
  type ViewMenuItem,
  type ViewPageView,
  type ViewQuery,
  type ViewRow,
  type ViewRowView,
} from "@realentity/storm-shared";
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { RunsService } from "../runs/runs.service";

/** A page reads at most this many rows of its collection, the newest first; sorted and searched in memory. */
const MAX_ROWS = 5000;

/**
 * Pipelines' pages (M27): the collection a pipeline's data.save keeps, shown as its `view` says, with the user's marks on
 * the rows and buttons that start pipelines (ordinary runs: gates, policy and the kill switch hold).
 */
@Injectable()
export class ViewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: RunsService,
  ) {}

  /** Every saved pipeline whose current version has a view, for the menu. */
  async menu(userId: string): Promise<ViewMenuItem[]> {
    const pipelines = await this.prisma.client.pipeline.findMany({
      where: { userId, currentVersionId: { not: null } },
      select: { pipelineId: true, name: true, currentVersionId: true },
    });
    const versions = await this.prisma.client.pipelineVersion.findMany({
      where: { pipelineVersionId: { in: pipelines.map((p) => p.currentVersionId!) } },
      select: { pipelineVersionId: true, definition: true },
    });
    const views = new Map(versions.map((v) => [v.pipelineVersionId, (v.definition as unknown as CompiledDefinition).view]));
    return pipelines
      .flatMap((p) => {
        const view = views.get(p.currentVersionId!);
        return view ? [{ pipelineId: p.pipelineId, pipelineName: p.name, label: view.menu.label, icon: view.menu.icon }] : [];
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  async page(userId: string, pipelineId: string, query: ViewQuery): Promise<ViewPageView> {
    const header = await this.header(userId, pipelineId);
    const { view } = header;
    const records = await this.prisma.client.dataRecord.findMany({
      where: { userId, collection: view.collection },
      orderBy: { firstSeenAt: "desc" },
      take: MAX_ROWS,
    });
    const rows = records.map(rowOf);
    const counts: Record<string, number> = { current: rows.filter((r) => inTab(r, "current", view)).length };
    if (view.removed) counts.removed = rows.filter((r) => inTab(r, "removed", view)).length;
    for (const mark of view.marks) counts[`mark:${mark.id}`] = rows.filter((r) => inTab(r, `mark:${mark.id}`, view)).length;
    if (!(query.tab in counts)) throw new NotFoundException(`This page has no tab "${query.tab}"`);

    const q = query.q?.toLowerCase();
    const matching = rows.filter(
      (r) => inTab(r, query.tab, view) && (!q || JSON.stringify(r.value).toLowerCase().includes(q) || r.key.toLowerCase().includes(q)),
    );
    matching.sort((a, b) => compare(fieldOf(a, view.sort.by), fieldOf(b, view.sort.by), view.sort.desc));
    const chart = view.chart ? await this.chart(userId, view.chart.history, view, rows) : null;
    return { ...header, rows: matching.slice(query.offset, query.offset + query.limit), total: matching.length, counts, chart };
  }

  /**
   * M29-T8: every key's values in a data.history collection (data.history keeps the last `keep` per key), drawn as the
   * CHART_SERIES keys with the highest latest value; a key that is a row is named by the row's title.
   */
  private async chart(userId: string, collection: string, view: PipelineView, rows: ViewRow[]): Promise<ViewChart> {
    const points = await this.prisma.client.dataPoint.findMany({
      where: { userId, collection },
      orderBy: { at: "asc" },
      select: { key: true, at: true, value: true },
    });
    const byKey = new Map<string, { at: string; value: number }[]>();
    for (const p of points) byKey.set(p.key, [...(byKey.get(p.key) ?? []), { at: p.at.toISOString(), value: p.value }]);
    const titles = new Map(rows.map((r) => [r.key, fieldOf(r, view.title ?? view.columns[0].field)]));
    const series = [...byKey]
      .map(([key, values]) => {
        const title = titles.get(key);
        return { key, label: typeof title === "string" || typeof title === "number" ? String(title) : key, points: values };
      })
      .sort((a, b) => b.points.at(-1)!.value - a.points.at(-1)!.value);
    return { series: series.slice(0, CHART_SERIES), more: Math.max(0, series.length - CHART_SERIES) };
  }

  async row(userId: string, pipelineId: string, key: string): Promise<ViewRowView> {
    const header = await this.header(userId, pipelineId);
    const row = rowOf(await this.record(userId, header.view, key));
    const history = header.view.detail.history
      ? (
          await this.prisma.client.dataPoint.findMany({
            where: { userId, collection: header.view.detail.history, key },
            orderBy: { at: "asc" },
            select: { at: true, value: true },
          })
        ).map((p) => ({ at: p.at.toISOString(), value: p.value }))
      : null;
    return { ...header, row, history };
  }

  /** The user's mark on a row; data.save never touches it. */
  async mark(userId: string, pipelineId: string, key: string, markId: string, on: boolean): Promise<ViewRow> {
    const { view } = await this.header(userId, pipelineId);
    if (!view.marks.some((m) => m.id === markId)) throw new NotFoundException(`This page has no mark "${markId}"`);
    const record = await this.record(userId, view, key);
    const marks = { ...(record.marks as Record<string, string>) };
    if (on) marks[markId] ??= new Date().toISOString();
    else delete marks[markId];
    return rowOf(
      await this.prisma.client.dataRecord.update({
        where: { dataRecordId: record.dataRecordId },
        data: { marks },
      }),
    );
  }

  /**
   * A button: a page's starts a manual or scheduled pipeline as a manual run; a row's starts one triggered by
   * { on: view.action } with the row as {{trigger.item}}.
   */
  async act(userId: string, pipelineId: string, index: number, key: string | undefined): Promise<RunDetailView> {
    const header = await this.header(userId, pipelineId);
    const action = header.view.actions[index];
    if (!action) throw new NotFoundException();
    const target =
      action.run === "self"
        ? await this.prisma.client.pipeline.findFirst({ where: { pipelineId, userId } })
        : await this.prisma.client.pipeline.findFirst({
            where: { userId, name: action.run, currentVersionId: { not: null } },
            orderBy: { dateUpdated: "desc" },
          });
    if (!target?.currentVersionId) throw new NotFoundException(`No saved pipeline is called "${action.run}"`);
    const version = await this.prisma.client.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId: target.currentVersionId } });
    const trigger = (version.definition as unknown as CompiledDefinition).trigger;

    if (!action.row) {
      if (isEventTrigger(trigger) || isWebhookTrigger(trigger)) {
        throw new ConflictException(`"${target.name}" is started by an event or a webhook, not by a button`);
      }
      return this.runs.start(userId, target.pipelineId, false);
    }
    if (!key) throw new BadRequestException("A row's button needs the row's key");
    if (!isEventTrigger(trigger) || trigger.on !== "view.action") {
      throw new ConflictException(`"${target.name}" isn't triggered by { on: view.action }, so a row can't start it`);
    }
    if (trigger.collection && trigger.collection !== header.view.collection) {
      throw new ConflictException(`"${target.name}" takes rows of "${trigger.collection}", not "${header.view.collection}"`);
    }
    const record = await this.record(userId, header.view, key);
    return this.runs.startVersion(userId, version.pipelineVersionId, false, "view", {
      collection: header.view.collection,
      key: record.key,
      item: record.value,
      action: action.label,
    });
  }

  private async header(userId: string, pipelineId: string): Promise<ViewHeader> {
    const pipeline = await this.prisma.client.pipeline.findFirst({ where: { pipelineId, userId } });
    if (!pipeline?.currentVersionId) throw new NotFoundException();
    const version = await this.prisma.client.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId: pipeline.currentVersionId } });
    const view = (version.definition as unknown as CompiledDefinition).view;
    if (!view) throw new NotFoundException(`"${pipeline.name}" has no page`);
    return { pipelineId, pipelineName: pipeline.name, version: version.version, view };
  }

  private async record(userId: string, view: PipelineView, key: string): Promise<DataRecord> {
    const record = await this.prisma.client.dataRecord.findUnique({
      where: { userId_collection_key: { userId, collection: view.collection, key } },
    });
    if (!record) throw new NotFoundException();
    return record;
  }
}

function rowOf(record: DataRecord): ViewRow {
  const value = record.value;
  return {
    key: record.key,
    value: value && typeof value === "object" && !Array.isArray(value) ? value : { value },
    marks: (record.marks ?? {}) as Record<string, string>,
    firstSeenAt: record.firstSeenAt.toISOString(),
    lastSeenAt: record.lastSeenAt.toISOString(),
    removedAt: record.removedAt?.toISOString() ?? null,
  };
}

/** current: not removed, not hidden by a mark; removed; mark:<id>: marked (removed or not). */
function inTab(row: ViewRow, tab: string, view: PipelineView): boolean {
  if (tab === "removed") return row.removedAt !== null;
  if (tab.startsWith("mark:")) return tab.slice(5) in row.marks;
  return row.removedAt === null && !view.marks.some((m) => m.hides && m.id in row.marks);
}

/** Numbers as numbers, everything else as text; an empty value last either way. */
function compare(a: unknown, b: unknown, desc: boolean): number {
  const empty = (v: unknown) => v === undefined || v === null || v === "";
  if (empty(a) || empty(b)) return empty(a) === empty(b) ? 0 : empty(a) ? 1 : -1;
  const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  const order = typeof a === "number" && typeof b === "number" ? a - b : text(a).localeCompare(text(b), undefined, { numeric: true });
  return desc ? -order : order;
}
