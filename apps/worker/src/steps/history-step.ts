import { type PrismaClient } from "@ai-me/db";
import { type StepContext, type StepExecutor } from "../runner/step-executor";
import { valueAt } from "./data-steps";

type Item = Record<string, unknown>;

interface HistoryInput {
  items: Item[];
  collection: string;
  key: string;
  value: string;
  keep: number;
}

/**
 * data.history (M13): a number per key over time, kept in `collection`. Each item gets `history`: the previous value,
 * the change, min and max so far, whether it is the lowest yet; an item whose value isn't a number gets null. One
 * value per key per run (the first item with that key); only the last `keep` stay. A dry run records nothing.
 */
export class HistoryStep implements StepExecutor {
  readonly type = "data.history";

  constructor(private readonly prisma: PrismaClient) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { items, collection, key, value, keep } = input as unknown as HistoryInput;
    const userId = context.userId;
    const readings = items.map((item) => {
      const k = valueAt(item, key);
      const text = typeof k === "string" ? k.trim() : typeof k === "number" ? String(k) : "";
      return { item, key: text, number: numberIn(valueAt(item, value)) };
    });
    const keys = [...new Set(readings.filter((r) => r.key && r.number !== null).map((r) => r.key))];
    const points = await this.prisma.dataPoint.findMany({ where: { userId, collection, key: { in: keys } }, orderBy: { at: "asc" } });
    const series = new Map<string, number[]>();
    for (const p of points) series.set(p.key, [...(series.get(p.key) ?? []), p.value]);

    const now = new Map<string, number>();
    const out = readings.map(({ item, key: k, number }) => {
      if (!k || number === null) return { ...item, history: null };
      const before = series.get(k) ?? [];
      if (!now.has(k)) now.set(k, number);
      return { ...item, history: historyOf(before, now.get(k)!) };
    });

    if (!context.dryRun && now.size > 0) {
      const at = new Date();
      await this.prisma.dataPoint.createMany({ data: [...now].map(([k, v]) => ({ userId, collection, key: k, value: v, at })) });
      for (const k of now.keys()) {
        const old = await this.prisma.dataPoint.findMany({
          where: { userId, collection, key: k },
          orderBy: { at: "desc" },
          skip: keep,
          select: { dataPointId: true },
        });
        if (old.length) await this.prisma.dataPoint.deleteMany({ where: { dataPointId: { in: old.map((p) => p.dataPointId) } } });
      }
    }
    return { items: out, recorded: now.size, unreadable: readings.filter((r) => r.number === null).length };
  }
}

function historyOf(before: number[], value: number) {
  const previous = before.at(-1) ?? null;
  const all = [...before, value];
  return {
    value,
    previous,
    change: previous === null ? null : round(value - previous),
    changePct: previous === null || previous === 0 ? null : round(((value - previous) / Math.abs(previous)) * 100),
    min: Math.min(...all),
    max: Math.max(...all),
    count: all.length,
    direction: previous === null ? "new" : value > previous ? "up" : value < previous ? "down" : "same",
    lowest: before.length > 0 && value < Math.min(...before),
  };
}

const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * A number as shops write it: 1299, "1 299,00 лв.", "€1,299.99", "1.299,99", "12.50", "1.299". With both "." and ","
 * the last one is the decimal mark; a single mark followed by exactly three digits (after a non-zero) groups
 * thousands.
 */
export function numberIn(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const match = /-?\d[\d\s.,'\u00a0\u202f]*/.exec(value);
  if (!match) return null;
  let text = match[0].replace(/[\s'\u00a0\u202f]/g, "").replace(/[.,]+$/, "");
  const lastDot = text.lastIndexOf(".");
  const lastComma = text.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? "." : ",";
    text = text.split(decimal === "." ? "," : ".").join("").replace(decimal, ".");
  } else if (lastDot >= 0 || lastComma >= 0) {
    const parts = text.split(lastDot >= 0 ? "." : ",");
    const thousands = parts.length > 2 || (parts[1]?.length === 3 && !/^-?0$/.test(parts[0] ?? ""));
    text = thousands ? parts.join("") : parts.join(".");
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}
