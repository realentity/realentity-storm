import { z } from "zod";

/**
 * Why a step's input didn't fit its type, as a sentence for the run's page rather than zod's JSON: each field by its
 * path, and the reference it was written as when that is where the value came from ("query.name expected string,
 * received undefined (from {{trigger.data.trip.destination}})"), since an empty reference is the usual cause.
 */
export function inputError(error: unknown, written: unknown): string {
  if (!(error instanceof z.ZodError)) return error instanceof Error ? error.message : String(error);
  return error.issues
    .map((issue) => {
      const field = issue.path.map(String).join(".") || "input";
      const what = issue.message.replace(/^Invalid input:\s*/, "");
      const from = writtenAt(written, issue.path);
      return typeof from === "string" && from.includes("{{") ? `${field} ${what} (from ${from})` : `${field} ${what}`;
    })
    .join("; ");
}

/** The value at a path in the step's `with` as written, before its references were resolved. */
function writtenAt(written: unknown, path: readonly PropertyKey[]): unknown {
  let at = written;
  for (const key of path) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<PropertyKey, unknown>)[key];
  }
  return at;
}
