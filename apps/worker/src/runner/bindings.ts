import { type PrismaClient } from "@realentity/storm-db";
import { type CompiledDefinition } from "@realentity/storm-shared";

/** M50: what fills a run's slots: credentials by id, settings as text. */
export interface RunBindings {
  credentials: Record<string, string>;
  settings: Record<string, string>;
}

/**
 * The bindings of a run's pipeline and of its App's install (M50): the pipeline's own over its App's, for the same
 * slot. Read when the run is loaded, so a run sees one set of them throughout.
 */
export async function loadBindings(prisma: PrismaClient, userId: string, pipelineId: string, definition: CompiledDefinition): Promise<RunBindings> {
  const appId =
    definition.refs?.appId ??
    (definition.app ? (await prisma.app.findUnique({ where: { userId_name: { userId, name: definition.app } }, select: { appId: true } }))?.appId : undefined);
  const rows = await prisma.binding.findMany({
    where: { OR: [{ pipelineId }, ...(appId ? [{ appId }] : [])] },
    orderBy: { pipelineId: { sort: "asc", nulls: "first" } },
  });
  const bindings: RunBindings = { credentials: {}, settings: {} };
  // The App's first, then the pipeline's over them.
  for (const row of [...rows.filter((r) => r.appId), ...rows.filter((r) => r.pipelineId)]) {
    if (row.credentialId) bindings.credentials[row.slot] = row.credentialId;
    if (row.text !== null) bindings.settings[row.slot] = row.text;
  }
  return bindings;
}
