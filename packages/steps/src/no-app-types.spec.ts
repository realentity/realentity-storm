import { exampleApps } from "@realentity/storm-shared/example-files";
import { readAppSource } from "@realentity/storm-shared";
import { z } from "zod";
import { defaultCatalog } from "./catalog";

/** Every type an example App has, or reads from another App. */
const exampleTypes = () =>
  new Set(
    exampleApps().flatMap((source) => {
      const app = readAppSource(source);
      return [...Object.keys(app.types), ...Object.keys(app.uses ?? {})];
    }),
  );

/** Each value a schema fixes: its defaults, constants and choices. */
function fixedValues(node: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) node.forEach((n) => fixedValues(n, out));
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "default" || key === "const") out.push(value);
      else if (key === "enum" && Array.isArray(value)) out.push(...(value as unknown[]));
      else fixedValues(value, out);
    }
  }
  return out;
}

// M71-T6: a step knows a source or a protocol, never an App's type: the App names its types, the step takes them as input
describe("no step names an App's type", () => {
  const types = exampleTypes();

  it("finds the examples' types to look for", () => {
    expect([...types]).toEqual(expect.arrayContaining(["Bill", "Job", "Offer", "Product", "Shop", "Meeting", "FollowUp", "Candidate"]));
  });

  it("no step's input or output fixes a type's name, as a default, a constant or a choice", () => {
    const named = defaultCatalog()
      .list()
      .flatMap((step) =>
        [step.input, step.output].flatMap((schema) =>
          fixedValues(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }))
            .filter((value): value is string => typeof value === "string" && types.has(value))
            .map((value) => `${step.type}: ${value}`),
        ),
      );
    expect(named).toEqual([]);
  });
});
