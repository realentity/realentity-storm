import {
  addStages,
  addState,
  moveState,
  removeStages,
  removeState,
  renameState,
  setInitialState,
  setStageEdge,
  stageEdges,
} from "./app-stages";
import { checkAppSource } from "./app-source";

const SOURCE = `name: Jobs
types:
  Job:
    key: url
    stages:
      field: status
      initial: new
      states: [new, skipped, applied, interview]
      moves:
        - { from: new, to: [skipped, applied], by: [me, pipeline] }
        - { from: [applied, interview], to: [applied, interview] }   # a mistake undone
    fields:
      url: { type: url, required: true }
      title: { type: text }
      salary: { type: number }
pages:
  - list: Job
    columns: [title, status]
    group: { by: status, totals: [{ field: salary, when: { status: [applied, interview] } }] }
  - view: Job
    actions:
      - { label: Apply, run: Apply, when: { status: new } }
`;

const valid = (source: string) => {
  const { definition, errors } = checkAppSource(source);
  expect(errors).toEqual([]);
  return definition!.types.Job.stages!;
};

describe("stageEdges", () => {
  it("gives each arrow once, with who may make it, and none from a state to itself", () => {
    const edges = stageEdges([
      { from: "new", to: ["skipped", "applied"], by: ["me", "pipeline"] },
      { from: ["applied", "interview"], to: ["applied", "interview"] },
      { from: "new", to: ["applied"] },
    ]);
    expect(edges).toEqual([
      { from: "new", to: "skipped", by: ["me", "pipeline"] },
      { from: "new", to: "applied", by: ["me", "pipeline"] },
      { from: "applied", to: "interview", by: ["me"] },
      { from: "interview", to: "applied", by: ["me"] },
    ]);
  });
});

// M35-U1: the diagram's edits give the YAML expected
describe("the stages diagram's edits (M35-T3)", () => {
  it("adds an arrow as its own move, written as I would", () => {
    const edited = setStageEdge(SOURCE, "Job", "skipped", "new", ["me"]);
    expect(edited).toBe(SOURCE.replace("   # a mistake undone\n", "   # a mistake undone\n        - { from: skipped, to: [new] }\n"));
    valid(edited);
    expect(setStageEdge(SOURCE, "Job", "interview", "skipped", ["pipeline"])).toContain(
      "- { from: interview, to: [skipped], by: [pipeline] }",
    );
  });

  it("changes who makes an arrow by splitting it out of its group, the rest of the line as it was", () => {
    const edited = setStageEdge(SOURCE, "Job", "new", "applied", ["me"]);
    expect(edited).toBe(
      SOURCE.replace(
        "        - { from: new, to: [skipped, applied], by: [me, pipeline] }\n",
        "        - { from: new, to: [skipped], by: [me, pipeline] }\n",
      ).replace("   # a mistake undone\n", "   # a mistake undone\n        - { from: new, to: [applied] }\n"),
    );
    expect(stageEdges(valid(edited).moves)).toContainEqual({ from: "new", to: "applied", by: ["me"] });
    expect(stageEdges(valid(edited).moves)).toContainEqual({ from: "new", to: "skipped", by: ["me", "pipeline"] });
  });

  it("removes an arrow from a group of several states, keeping my comment on the line", () => {
    const edited = setStageEdge(SOURCE, "Job", "applied", "interview", []);
    const edges = stageEdges(valid(edited).moves);
    expect(edges).not.toContainEqual(expect.objectContaining({ from: "applied", to: "interview" }));
    expect(edges).toContainEqual({ from: "interview", to: "applied", by: ["me"] });
    expect(edited).toContain("# a mistake undone");
  });

  it("adds, orders and makes a state the first", () => {
    let edited = addState(SOURCE, "Job", "offer");
    expect(edited).toContain("states: [new, skipped, applied, interview, offer]");
    edited = moveState(edited, "Job", "offer", -1);
    expect(edited).toContain("states: [new, skipped, applied, offer, interview]");
    edited = setInitialState(edited, "Job", "skipped");
    expect(valid(edited).initial).toBe("skipped");
    expect(() => addState(SOURCE, "Job", "new")).toThrow(/already/);
  });

  it("renames a state in its list, the moves and the pages' conditions on the stage", () => {
    const edited = renameState(SOURCE, "Job", "applied", "sent");
    expect(edited).toBe(
      SOURCE.replace("states: [new, skipped, applied, interview]", "states: [new, skipped, sent, interview]")
        .replace("to: [skipped, applied]", "to: [skipped, sent]")
        .replace(
          "{ from: [applied, interview], to: [applied, interview] }   #",
          "{ from: [sent, interview], to: [sent, interview] }         #",
        )
        .replace("when: { status: [applied, interview] }", "when: { status: [sent, interview] }"),
    );
    valid(edited);
    expect(renameState(SOURCE, "Job", "new", "fresh")).toContain("when: { status: fresh }");
    expect(valid(renameState(SOURCE, "Job", "new", "fresh")).initial).toBe("fresh");
  });

  it("removes a state with its arrows; the first one moves on", () => {
    const edited = removeState(SOURCE, "Job", "new");
    const stages = valid(edited.replace("when: { status: new }", "when: { status: skipped }"));
    expect(stages.states).toEqual(["skipped", "applied", "interview"]);
    expect(stages.initial).toBe("skipped");
    expect(stageEdges(stages.moves)).toEqual([
      { from: "applied", to: "interview", by: ["me"] },
      { from: "interview", to: "applied", by: ["me"] },
    ]);
  });

  it("adds stages to a type before its fields, and removes them", () => {
    const plain = SOURCE.replace(/ {4}stages:\n(?: {6}.*\n| {8}.*\n)+/, "")
      .replace(", status]", "]")
      .replace(/ {4}group: .*\n/, "")
      .replace(/ {2}- view: Job\n(?: {4}.*\n| {6}.*\n)+/, "");
    expect(checkAppSource(plain).errors).toEqual([]);
    const edited = addStages(plain, "Job");
    expect(edited).toContain(
      "    key: url\n    stages:\n      field: status\n      initial: new\n      states: [new, done]\n      moves:\n        - { from: new, to: [done] }\n    fields:\n",
    );
    expect(valid(edited).states).toEqual(["new", "done"]);
    expect(removeStages(edited, "Job")).toBe(plain);
  });
});
