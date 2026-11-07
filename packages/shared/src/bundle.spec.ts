import { joinBundle, splitBundle } from "./bundle";

const APP = `# my disks
name: Disks
types:
  Disk:
    key: id
    fields:
      id: { type: text, required: true }
`;
const PIPELINE = `name: Disk prices
app: Disks
steps:
  - id: save
    type: data.save
    with: { type: Disk, items: [] }
`;

describe("splitBundle (M35-T5)", () => {
  it("splits a file into its App and pipelines, each as written, with its first line", () => {
    const documents = splitBundle(`${APP}---\n${PIPELINE}`);
    expect(documents).toEqual([
      { kind: "app", name: "Disks", source: APP, line: 1 },
      { kind: "pipeline", name: "Disk prices", source: PIPELINE, line: 9 },
    ]);
  });

  it("reads one document, a leading ---, Windows line ends and empty documents", () => {
    expect(splitBundle(PIPELINE)).toEqual([{ kind: "pipeline", name: "Disk prices", source: PIPELINE, line: 1 }]);
    expect(splitBundle(`---\n${APP.replaceAll("\n", "\r\n")}---\n# nothing\n---\n`)).toEqual([{ kind: "app", name: "Disks", source: APP, line: 2 }]);
  });

  it("says what it can't tell", () => {
    expect(splitBundle("just: a map\n")[0].kind).toBe("unknown");
    expect(splitBundle("name: [\n")[0].kind).toBe("unknown");
  });

  it("joins them back the same", () => {
    const text = joinBundle([APP, PIPELINE]);
    expect(text).toBe(`${APP}---\n${PIPELINE}`);
    expect(splitBundle(text).map((d) => d.source)).toEqual([APP, PIPELINE]);
  });
});
