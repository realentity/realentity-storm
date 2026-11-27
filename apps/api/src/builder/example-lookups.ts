import { readAppPackage, readAppSource } from "@realentity/storm-shared";
import { exampleFiles } from "@realentity/storm-shared/example-files";

/**
 * M70-T3: the example Apps (examples/apps) for the builder to look up: "start from Hiring". Each by its id with its
 * description, types and pipelines; one whole, as its file is written. `hidden`: ids it doesn't see (the eval hides the
 * example a case rebuilds, so it measures building, not copying).
 */
export class ExampleLookups {
  private files: Record<string, string> | null = null;

  constructor(private readonly hidden: readonly string[] = []) {}

  /** One line per example: its id, name, what it is for, its types and pipelines. */
  list(): string {
    const files = this.all();
    const lines = Object.entries(files).map(([id, text]) => {
      const documents = readAppPackage(text).documents;
      if (documents.length === 0) return `${id}: (doesn't read)`;
      const app = readAppSource(documents[0].source);
      const pipelines = documents.slice(1).map((d) => String(d.key));
      return `${id}: ${app.name}${app.description ? `: ${app.description}` : ""} (types: ${Object.keys(app.types).join(", ")}; pipelines: ${pipelines.join(", ") || "none"})`;
    });
    return lines.length > 0 ? lines.join("\n") : "No examples here.";
  }

  /** The example's file, as written (its App, pages and pipelines); null when there is none of that id. */
  read(id: string): string | null {
    const files = this.all();
    return Object.hasOwn(files, id) ? files[id] : null;
  }

  private all(): Record<string, string> {
    if (!this.files) {
      let found: Record<string, string> = {};
      try {
        found = exampleFiles();
      } catch {
        // Not in this install (no examples folder): none to look up.
      }
      this.files = Object.fromEntries(Object.entries(found).filter(([id]) => !this.hidden.includes(id)));
    }
    return this.files;
  }
}
