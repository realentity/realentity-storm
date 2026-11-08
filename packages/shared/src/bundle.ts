import { parse } from "yaml";
import { z } from "zod";
import { type AppIssue } from "./app";
import { ExampleNeedSchema } from "./examples";

/**
 * M35-T5: Apps and pipelines as YAML files to import and export. One file may hold several documents (`---` between
 * them): an App and the pipelines that name it, or pipelines alone. Each document is kept as written, comments and
 * all; an App's comments survive the round trip (its version keeps its YAML), a pipeline's don't (only its compiled
 * definition is kept).
 */

export interface BundleDocument {
  kind: "app" | "pipeline" | "unknown";
  /** The document as written. */
  source: string;
  /** Its name, when it has one. */
  name?: string;
  /** Its first line in the file: a problem's line in the document is this plus its own, less one. */
  line: number;
}

/** The documents of a file, split at the lines that are `---`; an App is the one with types, a pipeline has steps. */
export function splitBundle(text: string): BundleDocument[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const documents: BundleDocument[] = [];
  let start = 0;
  const close = (end: number) => {
    const source = lines.slice(start, end).join("\n");
    if (hasContent(source)) {
      documents.push({ ...classify(source), source: `${source.replace(/\n+$/, "")}\n`, line: start + 1 });
    }
  };
  lines.forEach((line, i) => {
    if (/^---\s*$/.test(line)) {
      close(i);
      start = i + 1;
    }
  });
  close(lines.length);
  return documents;
}

function hasContent(source: string): boolean {
  return source.split("\n").some((l) => l.trim() !== "" && !l.trim().startsWith("#"));
}

function classify(source: string): Pick<BundleDocument, "kind" | "name"> {
  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch {
    return { kind: "unknown" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "unknown" };
  const value = parsed as Record<string, unknown>;
  const name = typeof value.name === "string" ? value.name : undefined;
  if ("types" in value) return { kind: "app", name };
  if ("steps" in value) return { kind: "pipeline", name };
  return { kind: "unknown", name };
}

/** An App's YAML, then its pipelines', as one file. */
export function joinBundle(sources: string[]): string {
  return sources.map((s) => s.replace(/\n+$/, "\n")).join("---\n");
}

export const BundleRequestSchema = z
  .object({
    text: z.string().min(1).max(500_000),
    /** M40-T2: installed from an example: kept with its App, for its checklist (M40-T3). */
    example: z.object({ id: z.string().min(1).max(60), needs: z.array(ExampleNeedSchema).max(10) }).strict().optional(),
  })
  .strict();
export type BundleRequest = z.infer<typeof BundleRequestSchema>;

/** What an imported document would do: new, a next version (with what changes), nothing (the same), or its problems. */
export interface BundleItemView {
  kind: "app" | "pipeline";
  name: string;
  /** The App or pipeline of that name I have: its next version; else a new one. */
  id: string | null;
  action: "create" | "update" | "same";
  changes: string[];
  errors: AppIssue[];
}

export interface BundleCheckView {
  ok: boolean;
  /** About the file as a whole (two Apps, a document that is neither, YAML errors). */
  errors: AppIssue[];
  items: BundleItemView[];
  /** Pipelines I have that name the App and aren't in the file, and that it would break. */
  broken: { pipelineId: string; name: string; errors: AppIssue[] }[];
}

export interface BundleExportView {
  filename: string;
  text: string;
}
