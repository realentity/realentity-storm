import { type PrismaClient } from "@ai-me/db";
import jsonata from "jsonata";
import { type StepContext, type StepExecutor } from "../runner/step-executor";
import { valueAt } from "./data-steps";
import { numberIn } from "./history-step";

type Item = Record<string, unknown>;

/** How long, how deep and how long a sequence a data.map expression may take: a recursive one can't hang the worker. */
const LIMITS = { timeout: 1000, stack: 200, sequence: 100_000 };

/**
 * data.map (M29): JSON an API returned, reshaped into items by a JSONata expression. A list of objects becomes the
 * items, one object a single item, anything else { value }; undefined (nothing matched) is no items.
 */
export class MapStep implements StepExecutor {
  readonly type = "data.map";

  async execute(input: Record<string, unknown>): Promise<unknown> {
    const { from, expression, maxItems } = input as { from: unknown; expression: string; maxItems: number };
    let value: unknown;
    try {
      value = (await jsonata(expression, LIMITS).evaluate(from)) as unknown;
    } catch (error) {
      throw new Error(`data.map: ${(error as { message?: string }).message ?? String(error)}`);
    }
    // JSONata marks its result lists with extra properties; JSON keeps the values only.
    value = value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
    const list = value === undefined ? [] : Array.isArray(value) ? (value as unknown[]) : [value];
    const items = list.slice(0, maxItems).map((entry) => (isItem(entry) ? entry : { value: entry }));
    return { items, value: value ?? null };
  }
}

function isItem(value: unknown): value is Item {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface AlertInput {
  items: Item[];
  key: string;
  value: string;
  below?: number;
  above?: number;
  clearAt?: number;
  label?: string;
}

/**
 * data.alert (M29): tells once when a number crosses a line and once when it is back, remembered per pipeline, step
 * and key (AlertState: a row while past the line). One reading per key per run, the first; an item whose value isn't
 * a number changes nothing. A dry run reads what is remembered and keeps it as it was.
 */
export class AlertStep implements StepExecutor {
  readonly type = "data.alert";

  constructor(private readonly prisma: PrismaClient) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { items, key, value, below, above, clearAt, label } = input as unknown as AlertInput;
    const direction = below !== undefined ? "below" : "above";
    const line = (below ?? above)!;
    const back = clearAt ?? line;
    const past = (n: number) => (direction === "below" ? n < line : n > line);
    const normal = (n: number) => (direction === "below" ? n >= back : n <= back);

    const readings = new Map<string, { item: Item; number: number }>();
    let unreadable = 0;
    for (const item of items) {
      const k = valueAt(item, key);
      const text = typeof k === "string" ? k.trim() : typeof k === "number" ? String(k) : "";
      const number = numberIn(valueAt(item, value));
      if (!text || number === null) unreadable++;
      else if (!readings.has(text)) readings.set(text, { item, number });
    }

    const where = { pipelineId: context.pipelineId, stepKey: context.stepKey };
    const remembered = new Map(
      (await this.prisma.alertState.findMany({ where: { ...where, key: { in: [...readings.keys()] } } })).map((s) => [s.key, s]),
    );
    const now = new Date();
    const crossed: Item[] = [];
    const cleared: Item[] = [];
    const lines: string[] = [];
    for (const [k, { item, number }] of readings) {
      const named = label ? valueAt(item, label) : undefined;
      const name = typeof named === "string" || typeof named === "number" ? String(named) : k;
      const state = remembered.get(k);
      if (!state && past(number)) {
        crossed.push({ ...item, alert: { value: number, line, since: now.toISOString() } });
        lines.push(`${name}: ${number}, ${direction} ${line}`);
        if (!context.dryRun) await this.prisma.alertState.create({ data: { userId: context.userId, ...where, key: k, value: number, since: now } });
      } else if (state && normal(number)) {
        cleared.push({ ...item, alert: { value: number, line, since: state.since.toISOString() } });
        lines.push(`${name}: back to ${number}`);
        if (!context.dryRun) await this.prisma.alertState.delete({ where: { alertStateId: state.alertStateId } });
      }
    }
    const active = context.dryRun
      ? (await this.prisma.alertState.count({ where })) + crossed.length - cleared.length
      : await this.prisma.alertState.count({ where });
    return { crossed, cleared, active, text: lines.join("\n"), unreadable };
  }
}
