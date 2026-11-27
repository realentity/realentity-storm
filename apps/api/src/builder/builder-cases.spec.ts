import { exampleFiles } from "@realentity/storm-shared/example-files";
import { defaultCatalog } from "@realentity/storm-steps";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Case {
  name: string;
  file: string;
  description: string;
  notes?: string;
}

const cases = JSON.parse(readFileSync(resolve(__dirname, "../../evals/builder-cases.json"), "utf8")) as Case[];

// M67-T1: the builder's eval has a case per example App and pipeline, each a description as a person would say it
describe("the builder's eval cases (M67)", () => {
  it("has one case per example App and per standalone pipeline, each named once", () => {
    const apps = Object.keys(exampleFiles()).map((id) => `apps/${id}.yaml`);
    const pipelines = readdirSync(resolve(__dirname, "../../../../examples/pipelines"))
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => `pipelines/${f}`);
    expect(cases.map((c) => c.file).sort()).toEqual([...apps, ...pipelines].sort());
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
  });

  it("says it in plain words: no step types, no references, no YAML options, no real-looking addresses", () => {
    const types = defaultCatalog()
      .list()
      .map((s) => s.type);
    for (const c of cases) {
      expect([c.name, c.description.trim().length > 40]).toEqual([c.name, true]);
      expect([c.name, types.filter((t) => c.description.includes(t))]).toEqual([c.name, []]);
      expect([c.name, /\{\{|\bforEach\b|\b(mine|required|add): (true|false)\b/.test(c.description)]).toEqual([c.name, false]);
      const emails = c.description.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? [];
      expect([c.name, emails.filter((e) => !/@([\w-]+\.)*(example\.(com|org|net)|[\w-]+\.example|[\w-]+\.test)$/.test(e))]).toEqual([c.name, []]);
    }
  });
});
