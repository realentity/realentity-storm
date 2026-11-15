import { type PipelineSummaryView } from "@realentity/storm-shared";

export interface PipelineGroup {
  /** null: the pipelines in no App. */
  app: { appId: string; name: string } | null;
  pipelines: PipelineSummaryView[];
}

/**
 * The pipelines list by App: the Apps by name, then those in none; within each, by name. `query` keeps the pipelines
 * whose name or App's name has it (any case); an App's name matching keeps all of its pipelines.
 */
export function groupByApp(pipelines: readonly PipelineSummaryView[], query = ""): PipelineGroup[] {
  const wanted = query.trim().toLowerCase();
  const matches = (p: PipelineSummaryView) =>
    !wanted || p.name.toLowerCase().includes(wanted) || (p.app?.name.toLowerCase().includes(wanted) ?? false);
  const groups = new Map<string, PipelineGroup>();
  for (const p of pipelines.filter(matches)) {
    const key = p.app?.appId ?? "";
    if (!groups.has(key)) groups.set(key, { app: p.app, pipelines: [] });
    groups.get(key)!.pipelines.push(p);
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });
  for (const group of groups.values()) group.pipelines.sort((a, b) => byName(a.name, b.name));
  return [...groups.values()].sort((a, b) => (a.app && b.app ? byName(a.app.name, b.app.name) : a.app ? -1 : b.app ? 1 : 0));
}
