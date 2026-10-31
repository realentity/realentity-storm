import { z } from "zod";
import { EmailMessageSchema, type StepCatalog, type StepDefinition } from "./catalog";

/** Schemas used by several steps: described once, referred to by name. */
const NAMED: [string, z.ZodType][] = [["EmailMessage", EmailMessageSchema]];

interface Def {
  type: string;
  innerType?: z.ZodType;
  element?: z.ZodType;
  valueType?: z.ZodType;
  defaultValue?: unknown;
}

const defOf = (schema: z.ZodType): Def => (schema as unknown as { def: Def }).def;

/**
 * The step catalog as text for the builder's system prompt (README §2.3: the builder can only use these): each
 * step's purpose, flags, parameters and output fields, compact enough to cache.
 */
export function describeCatalog(catalog: StepCatalog): string {
  const named = NAMED.map(([name, schema]) => `${name}:\n${fields(schema as z.ZodObject, "  ")}`).join("\n");
  return [...catalog.list().map(describeStep), `Shared types:\n${named}`].join("\n\n");
}

export function describeStep(step: StepDefinition): string {
  const flags = [
    step.sideEffect && "SIDE EFFECT (runs only after I press Act at its gate)",
    step.targets &&
      `targets: ${Object.entries(step.targets)
        .map(([field, kind]) => `${field} (${kind})`)
        .join(", ")}`,
    step.llmOutput && "output written by an LLM",
    step.acceptsCredentials && "accepts {{cred:name}}",
    step.headed && "headed browser",
  ].filter(Boolean);
  return [
    `## ${step.type}`,
    step.description,
    ...(flags.length ? [`Flags: ${flags.join("; ")}`] : []),
    "with:",
    fields(step.input, "  ") || "  (none)",
    "output:",
    fields(step.output, "  ") || "  (none)",
  ].join("\n");
}

function fields(object: z.ZodObject, indent: string): string {
  return Object.entries(object.shape as Record<string, z.ZodType>)
    .map(([key, schema]) => {
      const { type, optional, fallback } = unwrap(schema);
      const rendered = render(type, indent);
      const description = schema.description ?? type.description;
      // "list of objects", "list of emails": type labels for the UI, the rendered type already says it.
      const note = description && !description.startsWith("list of") ? `  # ${description}` : "";
      return `${indent}${key}${optional ? "?" : ""}: ${rendered}${fallback}${note}`;
    })
    .join("\n");
}

/** Strips optional/default/nullable wrappers, noting what they mean for the author. */
function unwrap(schema: z.ZodType): { type: z.ZodType; optional: boolean; fallback: string } {
  let type = schema;
  let optional = false;
  let fallback = "";
  for (;;) {
    const def = defOf(type);
    if (def.type === "optional" && def.innerType) optional = true;
    else if (def.type === "default" && def.innerType) {
      optional = true;
      const value = typeof def.defaultValue === "function" ? (def.defaultValue as () => unknown)() : def.defaultValue;
      fallback = ` = ${JSON.stringify(value)}`;
    } else if (def.type === "nullable" && def.innerType) fallback += " (or null)";
    else return { type, optional, fallback };
    type = def.innerType;
  }
}

function render(schema: z.ZodType, indent: string): string {
  const name = NAMED.find(([, named]) => named === schema)?.[0];
  if (name) return name;
  const def = defOf(schema);
  switch (def.type) {
    case "optional":
    case "default":
    case "nullable":
      return render(unwrap(schema).type, indent);
    case "array":
      return `list of ${def.element ? render(def.element, indent) : "unknown"}`;
    case "object":
      return `{\n${fields(schema as z.ZodObject, `${indent}  `)}\n${indent}}`;
    case "record":
      return "object";
    case "unknown":
    case "any":
      return "any";
    default:
      return leaf(schema);
  }
}

/** A primitive with its bounds, from its JSON Schema. */
function leaf(schema: z.ZodType): string {
  let json: Record<string, unknown>;
  try {
    json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  } catch {
    return "any";
  }
  if (Array.isArray(json.enum)) return json.enum.map((v) => JSON.stringify(v)).join(" | ");
  if ("const" in json) return JSON.stringify(json.const);
  const type = json.type === "integer" ? "integer" : typeof json.type === "string" ? json.type : "any";
  const bounds = [
    range(json.minimum, json.maximum),
    range(json.minLength, json.maxLength, " chars"),
    typeof json.format === "string" ? json.format : null,
  ].filter(Boolean);
  return bounds.length ? `${type} (${bounds.join(", ")})` : type;
}

function range(min: unknown, max: unknown, unit = ""): string | null {
  // z.int() carries the safe-integer bounds: no real limit.
  if (min === Number.MIN_SAFE_INTEGER) min = undefined;
  if (max === Number.MAX_SAFE_INTEGER) max = undefined;
  if (typeof min === "number" && typeof max === "number") return `${min}–${max}${unit}`;
  if (typeof min === "number") return `≥ ${min}${unit}`;
  if (typeof max === "number") return `≤ ${max}${unit}`;
  return null;
}
