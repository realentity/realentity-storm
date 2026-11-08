import { checkAppSource, joinBundle, readExamples, type AppMapPipeline, type CompiledDefinition, type Example } from "@ai-me/shared";
import { parse } from "yaml";

/**
 * M40: the examples, as pipelines/examples.yaml lists them, with their files read at build time (as the App templates
 * are): each one's bundle, its App and its pipelines for the map on its card.
 */
const FILES = import.meta.glob<string>("../../../../pipelines/**/*.yaml", { query: "?raw", import: "default", eager: true });
const file = (path: string) => FILES[`../../../../pipelines/${path}`] ?? "";

export interface ExampleEntry extends Example {
  /** The App then its pipelines, as one file to import. */
  bundle: string;
  app: ReturnType<typeof checkAppSource>["definition"];
  pipelines: AppMapPipeline[];
}

export const EXAMPLES: ExampleEntry[] = readExamples(file("examples.yaml")).map((example) => {
  const [appSource, ...pipelineSources] = example.files.map(file);
  return {
    ...example,
    bundle: joinBundle([appSource, ...pipelineSources]),
    app: checkAppSource(appSource).definition,
    pipelines: pipelineSources.map((source) => {
      const parsed = (parse(source) ?? {}) as Partial<CompiledDefinition>;
      const name = String(parsed.name ?? "");
      return { pipelineId: name, name, enabled: false, definition: { trigger: parsed.trigger ?? "manual", steps: parsed.steps ?? [] } };
    }),
  };
});
