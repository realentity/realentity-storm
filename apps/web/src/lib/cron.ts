/**
 * M36-T2: a schedule as days and times for the trigger card. Only the crons that are that ("0 8,18 * * 1-5": minute,
 * hours, every day of the month, days of the week) are read this way; any other is kept as written and shown as it is.
 */
export interface SimpleSchedule {
  /** "HH:MM", in order. */
  times: string[];
  /** Days of the week, 0 Sunday … 6 Saturday; all seven is every day. */
  days: number[];
}

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function readCron(cron: string): SimpleSchedule | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;
  if (dom !== "*" || month !== "*" || !/^\d{1,2}$/.test(minute)) return null;
  const hours = list(hour, 0, 23);
  const days = dow === "*" ? [0, 1, 2, 3, 4, 5, 6] : list(dow, 0, 7)?.map((d) => d % 7);
  if (!hours || !days || Number(minute) > 59) return null;
  const mm = minute.padStart(2, "0");
  return { times: hours.map((h) => `${String(h).padStart(2, "0")}:${mm}`), days: [...new Set(days)].sort((a, b) => a - b) };
}

/**
 * The cron of days and times. Times share one minute in a cron: when they don't, the first one's minute is used for
 * all, and `writeCron` says so by returning the times it kept.
 */
export function writeCron({ times, days }: SimpleSchedule): string {
  const parsed = times.map((t) => t.split(":").map(Number)).filter(([h, m]) => Number.isInteger(h) && Number.isInteger(m));
  const minute = parsed[0]?.[1] ?? 0;
  const hours = [...new Set(parsed.map(([h]) => h))].sort((a, b) => a - b);
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const dow = sorted.length === 7 || sorted.length === 0 ? "*" : ranges(sorted);
  return `${minute} ${hours.length ? hours.join(",") : "8"} * * ${dow}`;
}

function list(field: string, min: number, max: number): number[] | null {
  const values: number[] = [];
  for (const part of field.split(",")) {
    const range = /^(\d{1,2})-(\d{1,2})$/.exec(part);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      if (a > b || a < min || b > max) return null;
      for (let n = a; n <= b; n++) values.push(n);
    } else if (/^\d{1,2}$/.test(part) && Number(part) >= min && Number(part) <= max) values.push(Number(part));
    else return null;
  }
  return values;
}

/** 1,2,3,4,5 → 1-5; 1,3,5 stays. */
function ranges(days: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < days.length;) {
    let j = i;
    while (j + 1 < days.length && days[j + 1] === days[j] + 1) j++;
    out.push(j - i >= 2 ? `${days[i]}-${days[j]}` : days.slice(i, j + 1).join(","));
    i = j + 1;
  }
  return out.join(",");
}
