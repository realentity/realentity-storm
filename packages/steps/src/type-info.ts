import { type z } from "zod";

/**
 * A coarse view of a zod schema, enough to type-check {{references}} at compile time.
 * The runner validates resolved inputs with the real schemas at run time.
 */
export type TypeInfo =
  | { kind: "string" | "number" | "boolean" | "null" | "unknown" }
  | { kind: "array"; element: TypeInfo }
  | { kind: "object"; fields: Record<string, TypeInfo> }
  | { kind: "record"; value: TypeInfo };

export const UNKNOWN: TypeInfo = { kind: "unknown" };

interface Def {
  type: string;
  innerType?: z.ZodType;
  element?: z.ZodType;
  valueType?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  options?: z.ZodType[];
  values?: unknown[];
  entries?: Record<string, unknown>;
  in?: z.ZodType;
}

const defOf = (schema: z.ZodType): Def => (schema as unknown as { def: Def }).def;

function primitiveOf(value: unknown): TypeInfo {
  if (typeof value === "string") return { kind: "string" };
  if (typeof value === "number") return { kind: "number" };
  if (typeof value === "boolean") return { kind: "boolean" };
  return UNKNOWN;
}

export function describeSchema(schema: z.ZodType): TypeInfo {
  const def = defOf(schema);
  switch (def.type) {
    case "string":
    case "number":
    case "boolean":
    case "null":
      return { kind: def.type };
    case "int":
    case "bigint":
      return { kind: "number" };
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
    case "catch":
      return def.innerType ? describeSchema(def.innerType) : UNKNOWN;
    case "pipe":
      return def.in ? describeSchema(def.in) : UNKNOWN;
    case "array":
      return { kind: "array", element: def.element ? describeSchema(def.element) : UNKNOWN };
    case "object": {
      const shape = (schema as unknown as { shape: Record<string, z.ZodType> }).shape;
      return { kind: "object", fields: Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, describeSchema(v)])) };
    }
    case "record":
      return { kind: "record", value: def.valueType ? describeSchema(def.valueType) : UNKNOWN };
    case "enum":
      return sameKind(Object.values(def.entries ?? {}).map(primitiveOf));
    case "literal":
      return sameKind((def.values ?? []).map(primitiveOf));
    case "union":
      return sameKind((def.options ?? []).map(describeSchema));
    default:
      return UNKNOWN;
  }
}

/** All the same primitive kind → that kind; anything else → unknown. */
function sameKind(types: TypeInfo[]): TypeInfo {
  const first = types[0];
  if (!first) return UNKNOWN;
  return types.every((t) => t.kind === first.kind && first.kind !== "array" && first.kind !== "object" && first.kind !== "record")
    ? first
    : UNKNOWN;
}

/** True when a field schema may be left out (optional or has a default). */
export function isOptional(schema: z.ZodType): boolean {
  return ["optional", "default", "prefault"].includes(defOf(schema).type);
}

export type Navigation = { ok: true; type: TypeInfo } | { ok: false; message: string };

/** Follows a dotted path (["top", "title"]) into a type. */
export function navigate(type: TypeInfo, segments: string[]): Navigation {
  let current = type;
  for (const [index, segment] of segments.entries()) {
    const at = segments.slice(0, index).join(".");
    switch (current.kind) {
      case "unknown":
        return { ok: true, type: UNKNOWN };
      case "record":
        current = current.value;
        break;
      case "object": {
        const next = current.fields[segment];
        if (!next) {
          const where = at ? `"${at}"` : "the output";
          return { ok: false, message: `${where} has no field "${segment}" (fields: ${Object.keys(current.fields).join(", ") || "none"})` };
        }
        current = next;
        break;
      }
      case "array":
        return { ok: false, message: `"${at}" is a list; iterate over it with forEach and use {{item.${segment}}}` };
      default:
        return { ok: false, message: `"${at}" is a ${current.kind} and has no field "${segment}"` };
    }
  }
  return { ok: true, type: current };
}

/** Can a value of type `source` be passed where `target` is expected? Coarse: unknown matches anything. */
export function isAssignable(source: TypeInfo, target: TypeInfo): boolean {
  if (source.kind === "unknown" || target.kind === "unknown") return true;
  if (source.kind === "array" && target.kind === "array") return isAssignable(source.element, target.element);
  const objectLike = (t: TypeInfo): boolean => t.kind === "object" || t.kind === "record";
  if (objectLike(source) && objectLike(target)) return true;
  return source.kind === target.kind;
}

export function formatType(type: TypeInfo): string {
  switch (type.kind) {
    case "array":
      return `list of ${formatType(type.element)}`;
    case "record":
      return "object";
    default:
      return type.kind;
  }
}
