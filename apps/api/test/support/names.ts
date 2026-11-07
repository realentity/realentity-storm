import { type PrismaConnection } from "@ai-me/db";

/**
 * M39-T1: a saved pipeline's name is its own. A test that saves a source a second time gets its name with " (2)", as
 * the migration names duplicates; the first keeps the name.
 */
export async function freeName(db: PrismaConnection, source: string): Promise<string> {
  const match = /^name: (.+)$/m.exec(source);
  if (!match) return source;
  const base = match[1].trim();
  let name = base;
  for (let n = 2; await db.client.pipeline.findFirst({ where: { name, currentVersionId: { not: null } } }); n++) name = `${base} (${n})`;
  return name === base ? source : source.replace(match[0], `name: ${name}`);
}
