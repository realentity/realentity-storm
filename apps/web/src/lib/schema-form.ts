import { type JsonSchema } from "@ai-me/shared";

/** Inputs whose text is long or code: a box, monospace for code. */
const LONG = new Set(["instruction", "text", "body", "prompt", "content", "html", "message", "summary", "notes"]);
const CODE = new Set(["sql", "expression", "query", "script", "template"]);

/** A schema with its "or nothing" taken off; null when it is several kinds the form can't choose between. */
export function resolve(schema: JsonSchema | undefined): JsonSchema {
  if (!schema) return {};
  const options = schema.anyOf ?? schema.oneOf;
  if (options) {
    const real = options.filter((o) => o.type !== "null");
    if (real.length === 1)
      return { ...real[0], description: schema.description ?? real[0].description, default: schema.default ?? real[0].default };
    return schema;
  }
  return schema;
}

/** What kind of field an input gets. */
export function fieldKind(name: string, schema: JsonSchema): "enum" | "boolean" | "number" | "code" | "long" | "text" | "lines" | "yaml" {
  const s = resolve(schema);
  if (s.enum && s.enum.every((v) => typeof v === "string")) return "enum";
  if (s.type === "boolean") return "boolean";
  if (s.type === "number" || s.type === "integer") return "number";
  if (s.type === "string") {
    if (CODE.has(name) || /jsonata|sql/i.test(s.description ?? "")) return "code";
    if (LONG.has(name) || (typeof s.maxLength === "number" && s.maxLength > 500)) return "long";
    return "text";
  }
  if (s.type === "array" && resolve(s.items).type === "string" && !resolve(s.items).enum) return "lines";
  return "yaml";
}
