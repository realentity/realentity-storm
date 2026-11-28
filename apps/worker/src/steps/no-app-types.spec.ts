import { exampleApps } from "@realentity/storm-shared/example-files";
import { readAppSource } from "@realentity/storm-shared";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// M71-T6: no step executor knows an App's type: none names one as a string ("Job", "Bill") to read, write or move
describe("the worker's steps name no App type", () => {
  const types = new Set(exampleApps().flatMap((source) => Object.keys(readAppSource(source).types)));
  const sources = readdirSync(__dirname)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".spec.ts"))
    .map((file) => ({ file, text: readFileSync(join(__dirname, file), "utf8") }));

  it("reads every step file", () => {
    expect(sources.map((s) => s.file)).toEqual(expect.arrayContaining(["entity-steps.ts", "llm-steps.ts", "form-steps.ts"]));
  });

  it("finds none of the examples' type names as a string literal", () => {
    // A source's own vocabulary, not an App's: a product page's schema.org "@type": "Product".
    const source: Record<string, string[]> = { "product-step.ts": ["Product"] };
    const named = sources.flatMap(({ file, text }) =>
      [...text.matchAll(/["'`]([A-Z][A-Za-z]+)["'`]/g)]
        .filter(([, name]) => types.has(name) && !source[file]?.includes(name))
        .map(([, name]) => `${file}: "${name}"`),
    );
    expect(named).toEqual([]);
  });
});
