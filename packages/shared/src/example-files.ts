import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readAppPackage } from "./app-package";

/**
 * The examples in the repository, for tests and evals (Node only, so not part of the package's index): each App's file
 * in examples/apps, and the pipelines in examples/pipelines.
 */

function examplesDir(): string {
  let dir = process.cwd();
  while (!existsSync(join(dir, "examples", "apps"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("examples/apps not found above the working directory");
    dir = parent;
  }
  return join(dir, "examples");
}

const read = (...path: string[]) => readFileSync(join(examplesDir(), ...path), "utf8").replaceAll("\r\n", "\n");
const yamlFiles = (folder: string) => readdirSync(join(examplesDir(), folder)).filter((f) => f.endsWith(".yaml"));

/** Each App's file as written, by its id (the file's name). */
export function exampleFiles(): Record<string, string> {
  return Object.fromEntries(yamlFiles("apps").map((f) => [f.replace(/\.yaml$/, ""), read("apps", f)]));
}

/** Each App as Storm keeps it, without its pipelines. */
export function exampleApps(): string[] {
  return Object.values(exampleFiles()).map((text) => readAppPackage(text).documents[0].source);
}

/** Every pipeline: "<its key in its App's file>.yaml", or a file of examples/pipelines. */
export function examplePipelineFiles(): string[] {
  const inApps = Object.values(exampleFiles()).flatMap((text) => readAppPackage(text).documents.flatMap((d) => (d.key ? [`${d.key}.yaml`] : [])));
  return [...inApps, ...yamlFiles("pipelines")];
}

/** "apps/bills.yaml": the App as Storm keeps it. "bills.yaml": the pipeline of that key, or of examples/pipelines. */
export function exampleYaml(file: string): string {
  const name = file.replace(/\.yaml$/, "");
  if (name.startsWith("apps/")) return readAppPackage(read(`${name}.yaml`)).documents[0].source;
  if (existsSync(join(examplesDir(), "pipelines", file))) return read("pipelines", file);
  for (const text of Object.values(exampleFiles())) {
    const found = readAppPackage(text).documents.find((d) => d.key === name);
    if (found) return found.source;
  }
  throw new Error(`No example has a pipeline "${name}"`);
}
