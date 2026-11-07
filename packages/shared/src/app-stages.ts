import { isMap, isScalar, isSeq, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import { STAGE_ACTORS, type StageActor } from "./app";
import { editAppSource } from "./app-source";

/**
 * M35-T3: a type's stages as the diagram changes them: states, the first one, and moves as arrows (one state to
 * another, made by me, a pipeline or both). The YAML groups moves (`from: [a, b], to: [c, d]`); an arrow changed or
 * removed is split out of its group, which keeps the other arrows on its line as written.
 */

/** An arrow of the diagram: who may move an entity from one state to the other. */
export interface StageEdge {
  from: string;
  to: string;
  by: StageActor[];
}

/** The arrows the moves give, each once (who may make it, from every move that has it); none from a state to itself. */
export function stageEdges(moves: { from: string | string[]; to: string[]; by?: string[] }[]): StageEdge[] {
  const edges = new Map<string, StageEdge>();
  for (const move of moves) {
    const by = (move.by ?? ["me"]).filter((b): b is StageActor => (STAGE_ACTORS as readonly string[]).includes(b));
    for (const from of Array.isArray(move.from) ? move.from : [move.from]) {
      for (const to of move.to) {
        if (from === to) continue;
        const key = `${from}\u0000${to}`;
        const edge = edges.get(key) ?? { from, to, by: [] };
        edge.by = STAGE_ACTORS.filter((a) => edge.by.includes(a) || by.includes(a));
        edges.set(key, edge);
      }
    }
  }
  return [...edges.values()];
}

/** Stages for a type that has none: two states and a move, to grow on the diagram. */
export function addStages(source: string, type: string, field = "status"): string {
  return editAppSource(source, (document) => {
    const node = document.getIn(["types", type], true);
    if (!isMap(node)) throw new Error(`There is no type ${type}`);
    if (node.has("stages")) throw new Error(`${type} already has stages`);
    const stages = document.createNode({
      field,
      initial: "new",
      states: ["new", "done"],
      moves: [{ from: "new", to: ["done"] }],
    }) as YAMLMap;
    flow(stages.get("states", true));
    const moves = stages.get("moves", true);
    if (isSeq(moves)) moves.items.forEach((m) => flowMove(m));
    // Before the fields, as the templates have them.
    const index = node.items.findIndex((pair) => isScalar(pair.key) && pair.key.value === "fields");
    node.items.splice(index < 0 ? node.items.length : index, 0, document.createPair("stages", stages));
  });
}

export function removeStages(source: string, type: string): string {
  return editAppSource(source, (document) => document.deleteIn(["types", type, "stages"]));
}

export function setStagesProperty(source: string, type: string, property: "field" | "label", value: string): string {
  return editAppSource(source, (document) => {
    const stages = stagesOf(document, type);
    if (value === "" && property === "label") stages.delete("label");
    else stages.set(property, value);
  });
}

export function addState(source: string, type: string, state: string): string {
  return editAppSource(source, (document) => {
    const states = statesOf(document, type);
    if (states.items.some((s) => scalarValue(s) === state)) throw new Error(`${type} already has ${state}`);
    states.items.push(document.createNode(state));
  });
}

/** The state renamed in its list, as the first one, in the moves, and in the type's pages' conditions on the stage. */
export function renameState(source: string, type: string, from: string, to: string): string {
  if (from === to) return source;
  return editAppSource(source, (document) => {
    const stages = stagesOf(document, type);
    const states = statesOf(document, type);
    if (states.items.some((s) => scalarValue(s) === to)) throw new Error(`${type} already has ${to}`);
    renameIn(states, from, to);
    if (stages.get("initial") === from) stages.set("initial", to);
    for (const move of movesOf(stages)) {
      const fromNode = move.get("from", true);
      if (isScalar(fromNode) && fromNode.value === from) fromNode.value = to;
      else if (isSeq(fromNode)) renameIn(fromNode, from, to);
      const toNode = move.get("to", true);
      if (isSeq(toNode)) renameIn(toNode, from, to);
    }
    const field = String(stages.get("field"));
    for (const conditions of stageConditions(document, type)) {
      const value = conditions.get(field, true);
      if (isScalar(value) && value.value === from) value.value = to;
      else if (isSeq(value)) renameIn(value, from, to);
    }
  });
}

/** The state, every arrow to or from it, and the first state moved to the next one when it was that. */
export function removeState(source: string, type: string, state: string): string {
  return editAppSource(source, (document) => {
    const stages = stagesOf(document, type);
    const states = statesOf(document, type);
    states.items = states.items.filter((s) => scalarValue(s) !== state);
    if (stages.get("initial") === state) {
      const first = scalarValue(states.items[0]);
      if (first !== undefined) stages.set("initial", first);
    }
    const moves = stages.get("moves", true);
    if (!isSeq(moves)) return;
    for (const move of movesOf(stages)) {
      const fromNode = move.get("from", true);
      if (isSeq(fromNode)) fromNode.items = fromNode.items.filter((s) => scalarValue(s) !== state);
      const toNode = move.get("to", true);
      if (isSeq(toNode)) toNode.items = toNode.items.filter((s) => scalarValue(s) !== state);
    }
    moves.items = moves.items.filter((m) => {
      if (!isMap(m)) return true;
      const fromNode = m.get("from", true);
      const toNode = m.get("to", true);
      const noFrom = (isScalar(fromNode) && fromNode.value === state) || (isSeq(fromNode) && fromNode.items.length === 0);
      return !noFrom && !(isSeq(toNode) && toNode.items.length === 0);
    });
  });
}

export function setInitialState(source: string, type: string, state: string): string {
  return editAppSource(source, (document) => stagesOf(document, type).set("initial", state));
}

/** A state one place earlier or later in the list: the order the diagram, filters and buttons show them in. */
export function moveState(source: string, type: string, state: string, by: -1 | 1): string {
  return editAppSource(source, (document) => {
    const states = statesOf(document, type);
    const i = states.items.findIndex((s) => scalarValue(s) === state);
    const j = i + by;
    if (i < 0 || j < 0 || j >= states.items.length) return;
    [states.items[i], states.items[j]] = [states.items[j], states.items[i]];
  });
}

/** An arrow made by these (none: removed): split out of the moves that have it, then its own move when it stays. */
export function setStageEdge(source: string, type: string, from: string, to: string, by: StageActor[]): string {
  if (from === to) throw new Error("A move goes to another state");
  return editAppSource(source, (document) => {
    const stages = stagesOf(document, type);
    const moves = stages.get("moves", true);
    if (!isSeq(moves)) throw new Error(`${type}'s stages have no moves`);
    const next: typeof moves.items = [];
    for (const item of moves.items) {
      if (!isMap(item) || !hasEdge(item, from, to)) {
        next.push(item);
        continue;
      }
      next.push(...splitOut(document, item, from, to));
    }
    const actors = STAGE_ACTORS.filter((a) => by.includes(a));
    if (actors.length > 0) {
      const move = document.createNode({ from, to: [to], ...(actors.length === 1 && actors[0] === "me" ? {} : { by: actors }) }) as YAMLMap;
      flowMove(move);
      next.push(move);
    }
    moves.items = next;
    if (moves.items.length === 0) throw new Error("Stages need at least one move");
  });
}

function hasEdge(move: YAMLMap, from: string, to: string): boolean {
  return valuesOf(move.get("from", true)).includes(from) && valuesOf(move.get("to", true)).includes(to);
}

/**
 * A move without one of its arrows: the arrows from its other states as they were, and from this one to its other
 * targets; my comment on its line stays with the first.
 */
function splitOut(document: Document, move: YAMLMap, from: string, to: string): YAMLMap[] {
  const froms = valuesOf(move.get("from", true));
  const tos = valuesOf(move.get("to", true));
  const by = move.get("by", true);
  const parts: YAMLMap[] = [];
  const otherFroms = froms.filter((f) => f !== from);
  if (otherFroms.length > 0) {
    const fromNode = move.get("from", true);
    if (isSeq(fromNode)) fromNode.items = fromNode.items.filter((s) => scalarValue(s) !== from);
    else move.set("from", otherFroms[0]);
    parts.push(move);
  }
  const otherTos = tos.filter((t) => t !== to);
  if (otherTos.length > 0) {
    const part = document.createNode({ from, to: otherTos }) as YAMLMap;
    if (by !== undefined) part.set("by", by);
    flowMove(part);
    parts.push(part);
  }
  if (parts.length > 0 && parts[0] !== move) parts[0].comment = move.comment;
  return parts;
}

function stagesOf(document: Document, type: string): YAMLMap {
  const stages = document.getIn(["types", type, "stages"], true);
  if (!isMap(stages)) throw new Error(`${type} has no stages`);
  return stages;
}

function statesOf(document: Document, type: string): YAMLSeq {
  const states = stagesOf(document, type).get("states", true);
  if (!isSeq(states)) throw new Error(`${type}'s stages have no states`);
  return states;
}

function movesOf(stages: YAMLMap): YAMLMap[] {
  const moves = stages.get("moves", true);
  return isSeq(moves) ? moves.items.filter((m): m is YAMLMap => isMap(m)) : [];
}

/** The conditions on the type's pages (a button's or a total's when, a due date's unless): maps of field to value. */
function stageConditions(document: Document, type: string): YAMLMap[] {
  const pages = document.get("pages", true);
  if (!isSeq(pages)) return [];
  const found: YAMLMap[] = [];
  const visit = (node: unknown, key?: unknown) => {
    if (isMap(node)) {
      if (key === "when" || key === "unless") found.push(node);
      for (const pair of node.items) visit(pair.value, isScalar(pair.key) ? pair.key.value : undefined);
    } else if (isSeq(node)) node.items.forEach((item) => visit(item));
  };
  for (const page of pages.items) {
    if (isMap(page) && ["list", "view", "form"].some((kind) => page.get(kind) === type)) visit(page);
  }
  return found;
}

function renameIn(seq: YAMLSeq, from: string, to: string): void {
  for (const item of seq.items) if (isScalar(item) && item.value === from) item.value = to;
}

function valuesOf(node: unknown): string[] {
  if (isScalar(node)) return [String(node.value)];
  if (isSeq(node)) return node.items.map((s) => String(scalarValue(s)));
  return [];
}

function scalarValue(node: unknown): string | undefined {
  return isScalar(node) ? String(node.value) : undefined;
}

function flow(node: unknown): void {
  if (isSeq(node) || isMap(node)) node.flow = true;
}

function flowMove(move: unknown): void {
  if (!isMap(move)) return;
  move.flow = true;
  for (const pair of move.items) flow(pair.value);
}
