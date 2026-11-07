import {
  checkAppSource,
  definitionToSource,
  joinBundle,
  splitBundle,
  type AppDefinition,
  type AppIssue,
  type BundleCheckView,
  type BundleExportView,
  type BundleItemView,
  type CompiledDefinition,
} from "@ai-me/shared";
import { diffApps, diffDefinitions } from "@ai-me/steps";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { parse as parseYaml } from "yaml";
import { AppsService } from "../apps/apps.service";
import { PrismaService } from "../database/prisma.service";
import { PipelinesService } from "../pipelines/pipelines.service";

/**
 * M35-T5: Apps and pipelines in and out as YAML files. A file is checked whole before anything is saved: its App,
 * each of its pipelines against that App (or the one they name that I have), and my pipelines of that App it leaves
 * out. Then the App first (its pipelines compile against it), then the pipelines; one I have by name gets its next
 * version, one that is the same is left as it is.
 */
@Injectable()
export class BundlesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly apps: AppsService,
    private readonly pipelines: PipelinesService,
  ) {}

  async check(userId: string, text: string): Promise<BundleCheckView> {
    return (await this.read(userId, text)).view;
  }

  async save(userId: string, text: string): Promise<BundleCheckView> {
    const { view, app, pipelines } = await this.read(userId, text);
    if (!view.ok) throw new BadRequestException({ message: "The file has problems: nothing was saved", ...view });
    if (app) {
      const item = view.items.find((i) => i.kind === "app")!;
      if (item.action === "create") item.id = (await this.apps.create(userId, app.source)).appId;
      else if (item.action === "update") await this.apps.save(userId, item.id!, app.source);
    }
    for (const pipeline of pipelines) {
      const item = view.items.find((i) => i.kind === "pipeline" && i.name === pipeline.name)!;
      if (item.action === "create") item.id = (await this.pipelines.create(userId, pipeline.source)).pipelineId;
      else if (item.action === "update") await this.pipelines.addVersion(userId, item.id!, pipeline.source);
    }
    return view;
  }

  /** An App as one file: its YAML as written, then its pipelines'. */
  async exportApp(userId: string, appId: string): Promise<BundleExportView> {
    const { name, source, pipelines } = await this.apps.forBuilder(userId, appId);
    const sorted = [...pipelines].sort((a, b) => a.name.localeCompare(b.name));
    return { filename: `${fileName(name)}.yaml`, text: joinBundle([source, ...sorted.map((p) => definitionToSource(p))]) };
  }

  async exportPipeline(userId: string, pipelineId: string): Promise<BundleExportView> {
    const pipeline = await this.prisma.client.pipeline.findFirst({ where: { pipelineId, userId } });
    const version = pipeline?.currentVersionId
      ? await this.prisma.client.pipelineVersion.findUnique({ where: { pipelineVersionId: pipeline.currentVersionId } })
      : null;
    if (!pipeline || !version) throw new NotFoundException();
    return { filename: `${fileName(pipeline.name)}.yaml`, text: definitionToSource(version.definition as unknown as CompiledDefinition) };
  }

  private async read(userId: string, text: string) {
    const documents = splitBundle(text);
    const errors: AppIssue[] = [];
    const items: BundleItemView[] = [];
    const at = (line: number, issue: AppIssue): AppIssue => ({
      ...issue,
      ...(issue.line !== undefined ? { line: line + issue.line - 1 } : { line }),
    });

    if (documents.length === 0) errors.push({ path: "", message: "The file has no App or pipeline in it" });
    for (const unknown of documents.filter((d) => d.kind === "unknown")) {
      errors.push({
        path: "",
        message: "This document is neither an App (it has types) nor a pipeline (it has steps)",
        line: unknown.line,
      });
    }
    const appDocuments = documents.filter((d) => d.kind === "app");
    if (appDocuments.length > 1)
      errors.push({ path: "", message: "One App a file: its pipelines may come with it", line: appDocuments[1].line });

    // The App: checked as Save would, and what it changes against the one I have by its name.
    const appDocument = appDocuments[0];
    let app: AppDefinition | null = null;
    if (appDocument) {
      const checked = checkAppSource(appDocument.source);
      app = checked.definition;
      const name = app?.name ?? appDocument.name ?? "App";
      const existing = app ? await this.apps.byName(userId, app.name) : null;
      const changes = existing && app ? diffApps(existing.definition, app) : [];
      items.push({
        kind: "app",
        name,
        id: existing?.appId ?? null,
        action: !existing ? "create" : changes.length > 0 ? "update" : "same",
        changes,
        errors: checked.errors.map((e) => at(appDocument.line, e)),
      });
    }

    // Each pipeline: against the App in the file when it names it, else as Save would (the App I have, if any).
    const pipelineDocuments = documents.filter((d) => d.kind === "pipeline");
    const byName = new Map((await this.prisma.client.pipeline.findMany({ where: { userId } })).map((p) => [p.name, p]));
    const seen = new Set<string>();
    for (const document of pipelineDocuments) {
      const named = (parseYaml(document.source) as { app?: unknown }).app;
      const result =
        app && named === app.name
          ? await this.apps.compileWith(document.source, app)
          : await this.apps.compileSource(userId, document.source);
      const name = result.ok ? result.definition.name : (document.name ?? "pipeline");
      const issues = result.ok ? [] : result.errors.map((e) => ({ path: e.path, message: e.message, line: document.line }));
      if (appDocument && !app && named === appDocument.name)
        issues.push({ path: "app", message: "Its App in this file has problems", line: document.line });
      if (seen.has(name)) issues.push({ path: "name", message: `"${name}" is in the file twice`, line: document.line });
      seen.add(name);
      const existing = byName.get(name);
      const current = existing?.currentVersionId
        ? await this.prisma.client.pipelineVersion.findUnique({ where: { pipelineVersionId: existing.currentVersionId } })
        : null;
      const diff = current && result.ok ? diffDefinitions(current.definition as unknown as CompiledDefinition, result.definition) : null;
      const changes = diff && diff.changes.length > 0 ? diff.summary.split("\n") : [];
      items.push({
        kind: "pipeline",
        name,
        id: current ? existing!.pipelineId : null,
        action: !current ? "create" : changes.length > 0 ? "update" : "same",
        changes,
        errors: issues,
      });
    }

    // My pipelines of the App that the file leaves out: they must still compile against it.
    const broken = app ? await this.apps.brokenBy(userId, app.name, app, [...seen]) : [];
    const ok = errors.length === 0 && items.every((i) => i.errors.length === 0) && broken.length === 0;
    return {
      view: { ok, errors, items, broken } satisfies BundleCheckView,
      app: appDocument && app ? { source: appDocument.source } : null,
      pipelines: pipelineDocuments.map((d, i) => ({ source: d.source, name: items.filter((x) => x.kind === "pipeline")[i].name })),
    };
  }
}

/** A name as a file's: lower case, spaces as dashes, nothing a file system minds. */
function fileName(name: string): string {
  return (
    name
      .toLowerCase()
      .replaceAll(/[^\p{L}\p{N}]+/gu, "-")
      .replaceAll(/^-+|-+$/g, "") || "export"
  );
}
