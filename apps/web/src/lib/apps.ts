import { readAppPackage } from "@realentity/storm-shared";
import { parse } from "yaml";

/**
 * A new App from nothing (M35): one type with one field, to grow in the designer. No description (its box says what
 * goes there), and no comment on the key: renamed in the designer, it would say the old name.
 */
export const EMPTY_APP = `name: My App
icon: list
types:
  Item:
    key: name
    fields:
      name: { type: text, required: true }
`;

/** The ready-made Apps in examples/apps, without their pipelines (comments and all), by their name. */
export const APP_TEMPLATES: { name: string; description: string; source: string }[] = Object.values(
  import.meta.glob<string>("../../../../examples/apps/*.yaml", { query: "?raw", import: "default", eager: true }),
)
  .map((text) => {
    const { source } = readAppPackage(text).documents[0];
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
