import { type DraftTypeView } from "@ai-me/shared";

/** A new App's starting point (M30). */
export const NEW_APP_TEMPLATE = `name: Job Search
description: Jobs I find, and where I am with each
icon: briefcase
types:
  Job:
    key: url                     # one entity per url
    title: position
    fields:
      url: { type: url, required: true }
      position: { type: text, required: true }
      company: { type: text }
      salary: { type: money, currency: currency }
      currency: { type: text }
      favorite: { type: yesno, mine: true }     # set by me; pipelines never write it
`;

/** A step output with a list of objects to draft a type from. */
export function hasItems(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  return Object.values(output).some(
    (v) => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === "object" && !Array.isArray(x)),
  );
}

/** The draft as one more type under `types:`, at the end of the definition (my comments stay as they are). */
export function withType(source: string, name: string, draft: DraftTypeView): string {
  const body = draft.source
    .replace(/^Item:/, `${name}:`)
    .trimEnd()
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  const base = source.trimEnd();
  return /^types:\s*$/m.test(base) ? `${base}\n${body}\n` : `${base}\ntypes:\n${body}\n`;
}
