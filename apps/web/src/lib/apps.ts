import { parse } from "yaml";

/** A new App from nothing (M35): one type with one field, to grow in the designer. */
export const EMPTY_APP = `name: My App
description: What it keeps, in a sentence
icon: list
types:
  Item:
    key: name                    # one entity per name
    fields:
      name: { type: text, required: true }
`;

/** The ready-made Apps in pipelines/apps, as written there (comments and all), by their name. */
export const APP_TEMPLATES: { name: string; description: string; source: string }[] = Object.values(
  import.meta.glob<string>("../../../../pipelines/apps/*.yaml", { query: "?raw", import: "default", eager: true }),
)
  .map((source) => {
    const parsed = parse(source) as { name?: string; description?: string };
    return { name: parsed.name ?? "App", description: parsed.description ?? "", source };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

/** A step output with a list of objects to draft a type from. */
export function hasItems(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  return Object.values(output).some(
    (v) => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === "object" && !Array.isArray(x)),
  );
}
