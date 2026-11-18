import { checkAppSource, readAppPackage, readExamples, type AppMapPipeline, type CompiledDefinition, type Example } from "@realentity/storm-shared";
import { parse } from "yaml";

/**
 * M40: the examples, the App files of examples/apps read at build time (as the App templates are): each one's file, its
 * App and its pipelines for the map on its card.
 */
const FILES = import.meta.glob<string>("../../../../examples/apps/*.yaml", { query: "?raw", import: "default", eager: true });
const byId = Object.fromEntries(Object.entries(FILES).map(([path, text]) => [path.replace(/^.*\/|\.yaml$/g, ""), text]));

export interface ExampleEntry extends Example {
  /** The App with its pipelines, as one file to import. */
  bundle: string;
  app: ReturnType<typeof checkAppSource>["definition"];
  pipelines: AppMapPipeline[];
  /** M50: what you choose when you install it (its App's and pipelines' slots), by what each is for. */
  slots: string[];
}

export const EXAMPLES: ExampleEntry[] = readExamples(byId).map((example) => {
  const [appSource, ...pipelineSources] = readAppPackage(example.text).documents.map((d) => d.source);
  const declared = [appSource, ...pipelineSources].flatMap((source) =>
    Object.entries(((parse(source) ?? {}) as { needs?: Record<string, { label?: string }> }).needs ?? {}).map(([slot, need]) => need.label ?? slot),
  );
  return {
    ...example,
    slots: [...new Set(declared)],
    bundle: example.text,
    app: checkAppSource(appSource).definition,
    pipelines: pipelineSources.map((source) => {
      const parsed = (parse(source) ?? {}) as Partial<CompiledDefinition>;
      const name = String(parsed.name ?? "");
      return { pipelineId: name, name, enabled: false, definition: { trigger: parsed.trigger ?? "manual", steps: parsed.steps ?? [] } };
    }),
  };
});
