import { canonicalJson, type AppDefinition, type EntityField } from "@realentity/storm-shared";

/** What changed between two versions of an App (M30), a line each: shown with the version. */
export function diffApps(before: AppDefinition, after: AppDefinition): string[] {
  const lines: string[] = [];
  for (const field of ["name", "description", "icon"] as const) {
    if (before[field] !== after[field]) lines.push(`${field}: ${before[field] ?? "none"} → ${after[field] ?? "none"}`);
  }
  for (const name of Object.keys(before.types)) if (!(name in after.types)) lines.push(`type ${name} removed`);
  for (const [name, type] of Object.entries(after.types)) {
    const old = before.types[name];
    if (!old) {
      lines.push(`type ${name} added (${Object.keys(type.fields).length} fields)`);
      continue;
    }
    if (old.key !== type.key) lines.push(`${name} key: ${old.key} → ${type.key}`);
    if (old.title !== type.title) lines.push(`${name} title: ${old.title ?? "the key"} → ${type.title ?? "the key"}`);
    for (const field of Object.keys(old.fields)) if (!(field in type.fields)) lines.push(`${name}.${field} removed`);
    for (const [field, value] of Object.entries(type.fields)) {
      const was = old.fields[field];
      if (!was) lines.push(`${name}.${field} added (${describe(value)})`);
      else if (canonicalJson(was) !== canonicalJson(value)) lines.push(`${name}.${field}: ${describe(was)} → ${describe(value)}`);
    }
  }
  const pages = (app: AppDefinition) => new Map(app.pages.map((p) => ["list" in p ? `list page of ${p.list}` : "view" in p ? `view page of ${p.view}` : `form of ${p.form}`, p]));
  const [was, now] = [pages(before), pages(after)];
  for (const name of was.keys()) if (!now.has(name)) lines.push(`${name} removed`);
  for (const [name, page] of now) {
    if (!was.has(name)) lines.push(`${name} added`);
    else if (canonicalJson(was.get(name)) !== canonicalJson(page)) lines.push(`${name} changed`);
  }
  return lines;
}

function describe(field: EntityField): string {
  return [
    field.type,
    ...(field.values ? [`(${field.values.join(", ")})`] : []),
    ...(field.required ? ["required"] : []),
    ...(field.mine ? ["mine"] : []),
  ].join(" ");
}
