import { parse } from "yaml";
import { isAppPackage, readAppPackage, toAppPackage } from "./app-package";
import { checkAppSource } from "./app-source";

const FILE = `# Books I keep
app:
  name: Shelf
  description: What I read
  icon: book
  setup:
    - { kind: telegram, label: "Telegram, for the news" }
  starter: true
types:
  Book:
    key: isbn           # one per edition
    fields:
      isbn: { type: text, required: true }
pages:
  - list: Book
    actions:
      - { label: Fetch, run: fetch }
      - { label: Elsewhere, run: Another pipeline }
pipelines:
  fetch:
    name: Books in
    steps:
      - id: later
        type: flow.later
        with: { pipeline: tell, after: 1d }
  tell:
    fullName: Tell me
    trigger: { on: run.finished, pipeline: fetch }
    steps:
      - { id: note, type: llm.generate, with: { instruction: "fetch" } }
`;

describe("an App with its pipelines in one file", () => {
  it("is told from a pipeline, an App and several documents", () => {
    expect(isAppPackage(FILE)).toBe(true);
    expect(isAppPackage("name: Books in\napp: Shelf\nsteps: []\n")).toBe(false);
    expect(isAppPackage("name: Shelf\ntypes: {}\n")).toBe(false);
    expect(isAppPackage(`${FILE}---\nname: Other\nsteps: []\n`)).toBe(false);
  });

  it("reads as the App and the pipelines Storm keeps, each key replaced by the pipeline's name", () => {
    const { documents, setup, errors } = readAppPackage(FILE);
    expect(errors).toEqual([]);
    expect(setup).toEqual([{ kind: "telegram", label: "Telegram, for the news" }]);
    expect(documents.map((d) => [d.kind, d.name])).toEqual([
      ["app", "Shelf"],
      ["pipeline", "Shelf · Books in"],
      ["pipeline", "Tell me"],
    ]);

    const [app, fetch, tell] = documents;
    expect(checkAppSource(app.source).errors).toEqual([]);
    expect(app.source).toContain("# Books I keep");
    expect(app.source).toContain("# one per edition");
    expect(app.source).not.toContain("setup");
    expect(app.source).toContain("run: Shelf · Books in");
    expect(app.source).toContain("run: Another pipeline");

    expect(parse(fetch.source)).toMatchObject({ name: "Shelf · Books in", app: "Shelf", steps: [{ with: { pipeline: "Tell me" } }] });
    expect(parse(tell.source)).toMatchObject({ name: "Tell me", app: "Shelf", trigger: { pipeline: "Shelf · Books in" } });
    // Text that only says the key is left as it is.
    expect(tell.source).toContain('instruction: "fetch"');
  });

  it("names a copy's pipelines after the copy", () => {
    const { documents } = readAppPackage(FILE, "Shelf 2");
    expect(documents.map((d) => d.name)).toEqual(["Shelf 2", "Shelf 2 · Books in", "Tell me"]);
    expect(documents[0].source).toContain("run: Shelf 2 · Books in");
    expect(parse(documents[1].source)).toMatchObject({ app: "Shelf 2" });
  });

  it("says what is wrong, on its line", () => {
    const { errors } = readAppPackage(FILE.replace("  fetch:\n", "  Fetch:\n"));
    expect(errors[0]).toMatchObject({ path: "pipelines.Fetch", line: 20 });
    expect(readAppPackage(FILE.replace("    name: Books in\n", "    name: Books in\n    app: Other\n")).errors[0].message).toContain("leave out its app");
    expect(readAppPackage(FILE.replace("pipelines:\n", "extra: 1\npipelines:\n")).errors[0].path).toBe("");
  });

  it("is written back so that it reads as the same App and pipelines", () => {
    const { documents, setup } = readAppPackage(FILE);
    const written = toAppPackage(documents[0].source, documents.slice(1).map((d) => d.source), setup);
    expect(written).toContain("# Books I keep");
    expect(parse(written)).toMatchObject({
      app: { name: "Shelf", icon: "book", setup: [{ kind: "telegram" }] },
      pages: [{ actions: [{ run: "booksIn" }, { run: "Another pipeline" }] }],
      pipelines: { booksIn: { name: "Books in", steps: [{ with: { pipeline: "tellMe" } }] }, tellMe: { fullName: "Tell me", trigger: { pipeline: "booksIn" } } },
    });

    const again = readAppPackage(written);
    expect(again.errors).toEqual([]);
    expect(again.documents.map((d) => parse(d.source) as unknown)).toEqual(documents.map((d) => parse(d.source) as unknown));
  });
});
