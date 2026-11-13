import { type AppDefinition, type DataType, type FieldKind } from "@realentity/storm-shared";
import { type TypeInfo } from "./type-info";

/** A type of an App by name (M30). */
export function entityTypeOf(app: AppDefinition, name: string): DataType | undefined {
  return Object.hasOwn(app.types, name) ? app.types[name] : undefined;
}

const KIND_TYPES: Record<FieldKind, TypeInfo> = {
  text: { kind: "string" },
  longtext: { kind: "string" },
  number: { kind: "number" },
  money: { kind: "number" },
  date: { kind: "string" },
  datetime: { kind: "string" },
  url: { kind: "string" },
  email: { kind: "string" },
  yesno: { kind: "boolean" },
  enum: { kind: "string" },
  list: { kind: "array", element: { kind: "unknown" } },
  // M46: a stored file's reference; its content is read by file.read (M46-T3).
  file: { kind: "object", fields: { id: { kind: "string" }, name: { kind: "string" }, mime: { kind: "string" }, size: { kind: "number" } } },
  image: { kind: "object", fields: { id: { kind: "string" }, name: { kind: "string" }, mime: { kind: "string" }, size: { kind: "number" } } },
};

/** An entity as the compiler sees it: its fields by their kinds, dotted names as nested objects. */
export function entityTypeInfo(type: DataType): TypeInfo {
  const root: { kind: "object"; fields: Record<string, TypeInfo> } = { kind: "object", fields: {} };
  for (const [name, field] of Object.entries(type.fields)) {
    const segments = name.split(".");
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      const next = current.fields[segment];
      if (next?.kind !== "object") current.fields[segment] = { kind: "object", fields: {} };
      current = current.fields[segment] as typeof root;
    }
    current.fields[segments.at(-1)!] = KIND_TYPES[field.type];
  }
  return root;
}
