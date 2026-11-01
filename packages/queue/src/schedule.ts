import { type Trigger } from "@ai-me/shared";
import { CronExpressionParser } from "cron-parser";

export type ScheduleTrigger = Extract<Trigger, { schedule: string }>;

export function isScheduled(trigger: Trigger): trigger is ScheduleTrigger {
  return typeof trigger === "object" && "schedule" in trigger;
}

/**
 * The next times a schedule fires, as instants. Same parser and options as pg-boss's cron monitor, so this is what
 * pg-boss does: local wall-clock time in `tz`; a time skipped by DST fires an hour later, a repeated one fires once.
 */
export function nextFireTimes(trigger: ScheduleTrigger, from: Date, count: number): Date[] {
  const interval = CronExpressionParser.parse(trigger.schedule, { tz: trigger.tz, currentDate: from, strict: false });
  return Array.from({ length: count }, () => interval.next().toDate());
}
