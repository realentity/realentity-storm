import {
  addStages,
  addState,
  moveState,
  removeStages,
  removeState,
  renameState,
  setInitialState,
  setStageEdge,
  setStagesProperty,
  STAGE_ACTORS,
  stageEdges,
  type AppIssue,
  type StageActor,
  type StageEdge,
} from "@ai-me/shared";
import {
  IconArrowLeft,
  IconArrowRight,
  IconArrowsMaximize,
  IconFlag,
  IconMinus,
  IconPlus,
  IconTrash,
  IconX,
  IconZoomReset,
} from "@tabler/icons-react";
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { text, type LooseApp, type LooseType } from "../lib/loose-app";
import { HELP } from "../lib/help";
import { Issues } from "./AppIssues";
import { Help } from "./Help";
import { CommitInput, type DesignerEdit } from "./TypesDesigner";

const STATE = /^\S.{0,39}$/;
const BOX_W = 120;
const BOX_H = 40;
const GAP_X = 84;
const GAP_Y = 26;
const PAD = 24;

/** An arrow's colour by who may make it: me, a pipeline, or both. */
function edgeColor(by: StageActor[]): string {
  if (by.length === 2) return "var(--tblr-primary)";
  return by[0] === "pipeline" ? "var(--tblr-purple)" : "var(--tblr-secondary)";
}

/** What is picked on the diagram: a move (an arrow) or a state (a box). */
type Picked = { move: { from: string; to: string } } | { state: string } | null;

/**
 * M35-T3, M38-T1: a type's stages as a diagram: its states in columns, by how far along they are, each move an arrow
 * coloured by who may make it: forward ones left to right, back ones under the boxes and fainter. Drag from one state to
 * another for a move; click an arrow or a state for its card.
 */
export function StagesDesigner({
  app,
  issues,
  onLine,
  onEdit,
  editable,
}: Readonly<{
  app: LooseApp;
  issues: AppIssue[];
  onLine: (line: number) => void;
  onEdit: (edit: DesignerEdit) => void;
  editable: boolean;
}>) {
  return (
    <div className="card-body d-flex flex-column gap-4" data-testid="stages-tab">
      {!editable && (
        <div className="alert alert-warning mb-0">The YAML has errors: fix them on the YAML tab to change the stages here.</div>
      )}
      <div className="text-secondary small">
        Where each entity is (new, applied, paid…), and how it may move on: by me on its page, by a pipeline&apos;s save, or both. Pipelines
        only move forward along the arrows they may take.
      </div>
      {app.types.map(([name, type]) =>
        type.stages ? (
          <TypeStages
            key={name}
            name={name}
            type={type}
            issues={issues.filter((i) => i.path.startsWith(`types.${name}.`))}
            onLine={onLine}
            onEdit={onEdit}
            editable={editable}
          />
        ) : (
          <div key={name} className="d-flex align-items-center gap-2">
            <strong>{name}</strong>
            <span className="text-secondary">has no stages.</span>
            {editable && (
              <button type="button" className="btn btn-sm" onClick={() => onEdit((s) => addStages(s, name))} data-testid="add-stages">
                <IconPlus size={16} className="me-1" />
                Add stages
              </button>
            )}
          </div>
        ),
      )}
    </div>
  );
}

function TypeStages({
  name,
  type,
  issues,
  onLine,
  onEdit,
  editable,
}: Readonly<{
  name: string;
  type: LooseType;
  issues: AppIssue[];
  onLine: (line: number) => void;
  onEdit: (edit: DesignerEdit) => void;
  editable: boolean;
}>) {
  const stages = type.stages!;
  const edges = stageEdges(stages.moves);
  const [picked, setPicked] = useState<Picked>(null);
  const [newState, setNewState] = useState("");
  const [full, setFull] = useState(false);
  const initial = text(stages.initial);
  const pickedMove = picked && "move" in picked ? picked.move : null;
  const pickedState = picked && "state" in picked && stages.states.includes(picked.state) ? picked.state : null;
  const edge = pickedMove ? edges.find((e) => e.from === pickedMove.from && e.to === pickedMove.to) : undefined;
  const setEdge = (from: string, to: string, by: StageActor[]) => {
    onEdit((s) => setStageEdge(s, name, from, to, by));
    setPicked(by.length > 0 ? { move: { from, to } } : null);
  };
  useEffect(() => {
    if (!full) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [full]);

  const panel =
    edge !== undefined ? (
      <PickedCard title={`Move: ${edge.from} → ${edge.to}`} onClose={() => setPicked(null)} testId="selected-move">
        <div className="text-secondary small mb-1">Who may make it</div>
        <div className="d-flex gap-3 mb-2">
          {STAGE_ACTORS.map((actor) => (
            <label key={actor} className="form-check mb-0">
              <input
                type="checkbox"
                className="form-check-input"
                checked={edge.by.includes(actor)}
                disabled={!editable || (edge.by.length === 1 && edge.by[0] === actor)}
                onChange={(e) => setEdge(edge.from, edge.to, e.target.checked ? [...edge.by, actor] : edge.by.filter((b) => b !== actor))}
                title={actor === "me" ? HELP.moveByMe : HELP.moveByPipeline}
                data-testid={`move-by-${actor}`}
              />
              <span className="form-check-label">{actor === "me" ? "me, on its page" : "a pipeline's save"}</span>
            </label>
          ))}
        </div>
        <div className="d-flex gap-2 align-items-center">
          {edges.some((e) => e.from === edge.to && e.to === edge.from) && (
            <button type="button" className="btn btn-link btn-sm p-0" onClick={() => setPicked({ move: { from: edge.to, to: edge.from } })}>
              Also {edge.to} → {edge.from}
            </button>
          )}
          {editable && (
            <button
              type="button"
              className="btn btn-ghost-danger btn-sm ms-auto"
              onClick={() => setEdge(edge.from, edge.to, [])}
              data-testid="remove-move"
            >
              <IconTrash size={16} className="me-1" />
              Remove the move
            </button>
          )}
        </div>
      </PickedCard>
    ) : pickedState ? (
      <PickedCard title={`State: ${pickedState}`} onClose={() => setPicked(null)} testId="selected-state">
        <div className="small mb-2">
          {pickedState === initial ? (
            <span className="text-success">A new {name} starts here.</span>
          ) : (
            editable && (
              <button type="button" className="btn btn-sm" onClick={() => onEdit((s) => setInitialState(s, name, pickedState))}>
                <IconFlag size={14} className="me-1" />
                Make it the first state
              </button>
            )
          )}
        </div>
        {(["from", "to"] as const).map((end) => {
          const list = edges.filter((e) => e[end === "from" ? "from" : "to"] === pickedState);
          return (
            <div key={end} className="small mb-1">
              <span className="text-secondary">{end === "from" ? "Moves on to: " : "Reached from: "}</span>
              {list.length === 0 && <span className="text-secondary">none</span>}
              {list.map((e, i) => (
                <span key={`${e.from}>${e.to}`}>
                  {i > 0 && ", "}
                  <button
                    type="button"
                    className="btn btn-link btn-sm p-0 align-baseline"
                    onClick={() => setPicked({ move: { from: e.from, to: e.to } })}
                  >
                    {end === "from" ? e.to : e.from}
                  </button>
                </span>
              ))}
            </div>
          );
        })}
      </PickedCard>
    ) : null;

  const diagram = (
    <Diagram
      states={stages.states}
      initial={initial}
      edges={edges}
      picked={picked}
      onPick={setPicked}
      onConnect={(from, to) => {
        const existing = edges.find((e) => e.from === from && e.to === to);
        if (existing) setPicked({ move: { from, to } });
        else if (editable) setEdge(from, to, ["me"]);
      }}
      panel={panel}
      full={full}
      onFull={setFull}
    />
  );

  return (
    <div data-testid="designer-stages">
      <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
        <h3 className="mb-0 me-2">{name}</h3>
        <span className="text-secondary small">
          by the field <Help text={HELP.stageField} />
        </span>
        <CommitInput
          value={text(stages.field)}
          className="form-control form-control-sm font-monospace w-auto"
          valid={(v) => /^[A-Za-z_][\w-]{0,63}$/.test(v)}
          onCommit={(v) => onEdit((s) => setStagesProperty(s, name, "field", v))}
          disabled={!editable}
          ariaLabel={`${name}'s stage field`}
          help={HELP.stageField}
          testId="stage-field"
        />
        <Legend />
        {editable && (
          <button
            type="button"
            className="btn btn-ghost-danger btn-sm ms-auto"
            onClick={() => window.confirm(`Remove ${name}'s stages?`) && onEdit((s) => removeStages(s, name))}
            data-testid="remove-stages"
          >
            <IconTrash size={16} className="me-1" />
            Remove stages
          </button>
        )}
      </div>
      <Issues issues={issues} onLine={onLine} />
      {full ? (
        <div
          className="position-fixed top-0 start-0 w-100 h-100 p-3 d-flex flex-column gap-2"
          style={{ zIndex: 1050, background: "var(--tblr-bg-surface)" }}
          data-testid="stages-full"
        >
          <div className="d-flex align-items-center gap-2">
            <h3 className="mb-0">{name}&apos;s stages</h3>
            <Legend />
            <button type="button" className="btn btn-sm ms-auto" onClick={() => setFull(false)} data-testid="stages-full-close">
              <IconX size={16} className="me-1" />
              Close (Esc)
            </button>
          </div>
          <div className="flex-fill" style={{ minHeight: 0 }}>
            {diagram}
          </div>
        </div>
      ) : (
        diagram
      )}
      {editable && <AddMove states={stages.states} onAdd={(from, to, by) => setEdge(from, to, by)} />}
      <div className="d-flex flex-wrap gap-2 mt-3 align-items-center" data-testid="states">
        {stages.states.map((state, i) => (
          <div key={state} className="d-flex align-items-center gap-1 border rounded px-1 py-1" data-testid="state">
            <CommitInput
              value={state}
              className="form-control form-control-sm border-0"
              valid={(v) => STATE.test(v)}
              onCommit={(to) => onEdit((s) => renameState(s, name, state, to))}
              disabled={!editable}
              ariaLabel={`State ${state}`}
              help={HELP.stateName}
              testId="state-name"
            />
            {editable && (
              <>
                <button
                  type="button"
                  className={`btn btn-icon btn-sm ${state === stages.initial ? "btn-success" : "btn-ghost-secondary"}`}
                  title={state === stages.initial ? "The first state" : "Make it the first state"}
                  aria-label={`Make ${state} the first state`}
                  onClick={() => onEdit((s) => setInitialState(s, name, state))}
                  data-testid="state-initial"
                >
                  <IconFlag size={14} />
                </button>
                <button
                  type="button"
                  className="btn btn-icon btn-sm btn-ghost-secondary"
                  disabled={i === 0}
                  aria-label={`Move ${state} earlier`}
                  onClick={() => onEdit((s) => moveState(s, name, state, -1))}
                >
                  <IconArrowLeft size={14} />
                </button>
                <button
                  type="button"
                  className="btn btn-icon btn-sm btn-ghost-secondary"
                  disabled={i === stages.states.length - 1}
                  aria-label={`Move ${state} later`}
                  onClick={() => onEdit((s) => moveState(s, name, state, 1))}
                >
                  <IconArrowRight size={14} />
                </button>
                <button
                  type="button"
                  className="btn btn-icon btn-sm btn-ghost-danger"
                  aria-label={`Remove ${state}`}
                  onClick={() => onEdit((s) => removeState(s, name, state))}
                  data-testid="remove-state"
                >
                  <IconTrash size={14} />
                </button>
              </>
            )}
          </div>
        ))}
        {editable && (
          <form
            className="d-flex gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              onEdit((s) => addState(s, name, newState.trim()));
              setNewState("");
            }}
          >
            <input
              className="form-control form-control-sm w-auto"
              placeholder="a state"
              value={newState}
              onChange={(e) => setNewState(e.target.value)}
              aria-label={`New state of ${name}`}
              title={HELP.newState}
              data-testid="new-state"
            />
            <button type="submit" className="btn btn-sm" disabled={!STATE.test(newState.trim())} data-testid="add-state">
              <IconPlus size={16} className="me-1" />
              Add
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

/** M38-T2: what is picked on the diagram, in a card of its own beside it: titled by it, with a close button. */
function PickedCard({
  title,
  onClose,
  children,
  testId,
}: Readonly<{ title: string; onClose: () => void; children: ReactNode; testId: string }>) {
  return (
    <div
      className="card shadow-sm border-primary flex-shrink-0 align-self-start"
      style={{ width: 300, borderWidth: 2 }}
      data-testid={testId}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="card-header py-2 bg-primary-lt">
        <h4 className="card-title mb-0">{title}</h4>
        <button type="button" className="btn-close ms-auto" aria-label="Close" onClick={onClose} data-testid="picked-close" />
      </div>
      <div className="card-body py-2">{children}</div>
    </div>
  );
}

function Legend() {
  const item = (label: string, by: StageActor[], faint = false) => (
    <span className="d-inline-flex align-items-center gap-1 small text-secondary">
      <svg width="22" height="8" aria-hidden="true">
        <line
          x1="0"
          y1="4"
          x2="22"
          y2="4"
          style={{ stroke: edgeColor(by), opacity: faint ? 0.5 : 1 }}
          strokeWidth="2"
          strokeDasharray={faint ? "4 3" : undefined}
        />
      </svg>
      {label}
    </span>
  );
  return (
    <span className="d-inline-flex gap-3 ms-3 flex-wrap">
      {item("me", ["me"])}
      {item("a pipeline", ["pipeline"])}
      {item("both", ["me", "pipeline"])}
      {item("a move back", ["me"], true)}
    </span>
  );
}

/** The add-a-move form: what dragging does, for the keyboard. */
function AddMove({ states, onAdd }: Readonly<{ states: string[]; onAdd: (from: string, to: string, by: StageActor[]) => void }>) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [by, setBy] = useState<StageActor[]>(["me"]);
  return (
    <div className="d-flex align-items-center gap-2 mt-2 flex-wrap small">
      <span className="text-secondary">A move from</span>
      <select
        className="form-select form-select-sm w-auto"
        value={from}
        onChange={(e) => setFrom(e.target.value)}
        aria-label="Move from"
        title={HELP.moveFrom}
        data-testid="move-from"
      >
        <option value="">…</option>
        {states.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <span className="text-secondary">to</span>
      <select
        className="form-select form-select-sm w-auto"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        aria-label="Move to"
        title={HELP.moveTo}
        data-testid="move-to"
      >
        <option value="">…</option>
        {states
          .filter((s) => s !== from)
          .map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
      </select>
      <span className="text-secondary">by</span>
      {STAGE_ACTORS.map((actor) => (
        <label key={actor} className="form-check form-check-inline mb-0">
          <input
            type="checkbox"
            className="form-check-input"
            checked={by.includes(actor)}
            onChange={(e) => setBy(e.target.checked ? [...by, actor] : by.filter((b) => b !== actor))}
            title={actor === "me" ? HELP.moveByMe : HELP.moveByPipeline}
            data-testid={`new-move-by-${actor}`}
          />
          <span className="form-check-label">{actor === "me" ? "me" : "a pipeline"}</span>
        </label>
      ))}
      <button
        type="button"
        className="btn btn-sm"
        disabled={!from || !to || from === to || by.length === 0}
        onClick={() => {
          onAdd(from, to, by);
          setTo("");
        }}
        data-testid="add-move"
      >
        <IconPlus size={16} className="me-1" />
        Add the move
      </button>
    </div>
  );
}

/** How high a forward move arches when it passes over `skipped` columns. */
const archLift = (skipped: number) => 34 + skipped * 18;

interface Box {
  state: string;
  rank: number;
  x: number;
  y: number;
}

/**
 * Where each state goes: in columns by how far along it is. A state's column is one past the furthest of the states a
 * forward move reaches it from, counting the moves a pipeline makes (the path an entity takes) when there are any, else
 * every move to a later state; within a column, in the order I wrote them.
 */
function stageLayout(states: string[], edges: StageEdge[]): { boxes: Map<string, Box>; width: number; rowsHeight: number } {
  const index = new Map(states.map((s, i) => [s, i]));
  const placed = edges.filter((e) => index.has(e.from) && index.has(e.to));
  const byPipeline = placed.filter((e) => e.by.includes("pipeline"));
  const ranking = (byPipeline.length > 0 ? byPipeline : placed).filter((e) => index.get(e.to)! > index.get(e.from)!);
  const rank = new Map<string, number>();
  for (const state of states) {
    const into = ranking.filter((e) => e.to === state).map((e) => (rank.get(e.from) ?? 0) + 1);
    rank.set(state, Math.max(0, ...into));
  }
  const columns: string[][] = [];
  for (const state of states) (columns[rank.get(state)!] ??= []).push(state);
  const filled = columns.filter((c) => c !== undefined);
  const skips = Math.max(
    0,
    ...ranking.map((e) => rank.get(e.to)! - rank.get(e.from)! - 1),
    ...placed.map((e) => {
      const d = (rank.get(e.to) ?? 0) - (rank.get(e.from) ?? 0);
      return d > 1 ? d - 1 : 0;
    }),
  );
  const top = PAD + (skips > 0 ? archLift(skips) * 0.75 : 0);
  const tallest = Math.max(1, ...filled.map((c) => c.length));
  const boxes = new Map<string, Box>();
  filled.forEach((column, c) => {
    const offset = ((tallest - column.length) * (BOX_H + GAP_Y)) / 2;
    column.forEach((state, r) => boxes.set(state, { state, rank: c, x: PAD + c * (BOX_W + GAP_X), y: top + offset + r * (BOX_H + GAP_Y) }));
  });
  return { boxes, width: PAD * 2 + filled.length * (BOX_W + GAP_X) - GAP_X, rowsHeight: top + tallest * (BOX_H + GAP_Y) - GAP_Y };
}

function Diagram({
  states,
  initial,
  edges,
  picked,
  onPick,
  onConnect,
  panel,
  full,
  onFull,
}: Readonly<{
  states: string[];
  initial: string;
  edges: StageEdge[];
  picked: Picked;
  onPick: (picked: Picked) => void;
  onConnect: (from: string, to: string) => void;
  panel: ReactNode;
  full: boolean;
  onFull: (full: boolean) => void;
}>) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ from: string; x: number; y: number; moved: boolean } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  /** "fit": as wide as there is room; else a scale of its own size, scrolled. */
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const { boxes, width, rowsHeight } = stageLayout(states, edges);
  const placed = edges.filter((e) => boxes.has(e.from) && boxes.has(e.to));
  const forward = (e: StageEdge) => boxes.get(e.to)!.rank > boxes.get(e.from)!.rank;
  const back = placed.filter((e) => !forward(e));
  const height = rowsHeight + PAD + (back.length ? 24 + Math.min(back.length, 12) * 7 : 0);

  // Each arrow its own point on a box's side, ordered by where its other end is, so they fan out instead of piling up.
  const slots = new Map<string, number>();
  const spread = (key: (e: StageEdge) => string | null, along: (e: StageEdge) => number, length: number, margin: number) => {
    const groups = new Map<string, StageEdge[]>();
    for (const e of placed) {
      const k = key(e);
      if (k) groups.set(k, [...(groups.get(k) ?? []), e]);
    }
    for (const [k, group] of groups) {
      group.sort((a, b) => along(a) - along(b));
      group.forEach((e, i) => slots.set(`${k}|${e.from}>${e.to}`, margin + ((i + 1) * (length - 2 * margin)) / (group.length + 1)));
    }
  };
  const box = (s: string) => boxes.get(s)!;
  spread(
    (e) => (forward(e) ? `R:${e.from}` : null),
    (e) => box(e.to).y,
    BOX_H,
    4,
  );
  spread(
    (e) => (forward(e) ? `L:${e.to}` : null),
    (e) => box(e.from).y,
    BOX_H,
    4,
  );
  spread(
    (e) => (forward(e) ? null : `B:${e.from}`),
    (e) => -box(e.to).x,
    BOX_W,
    10,
  );
  spread(
    (e) => (forward(e) ? null : `B:${e.to}`),
    (e) => -box(e.from).x,
    BOX_W,
    10,
  );
  const slot = (side: string, state: string, e: StageEdge) => slots.get(`${side}:${state}|${e.from}>${e.to}`) ?? 0;

  const path = (e: StageEdge) => {
    const a = box(e.from);
    const b = box(e.to);
    if (forward(e)) {
      const x1 = a.x + BOX_W;
      const y1 = a.y + slot("R", e.from, e);
      const x2 = b.x;
      const y2 = b.y + slot("L", e.to, e);
      const skipped = b.rank - a.rank - 1;
      if (skipped > 0) {
        // Over the columns between, not behind their boxes.
        const peak = Math.min(a.y, b.y) - archLift(skipped);
        return `M ${x1} ${y1} C ${x1 + 50} ${peak} ${x2 - 50} ${peak} ${x2} ${y2}`;
      }
      const bend = Math.max(30, (x2 - x1) / 2);
      return `M ${x1} ${y1} C ${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
    }
    // Back (or within a column): out of the box's bottom, under the boxes, into the other's bottom.
    const x1 = a.x + slot("B", e.from, e);
    const x2 = b.x + slot("B", e.to, e);
    const y1 = a.y + BOX_H;
    const y2 = b.y + BOX_H;
    const deep = Math.max(y1, y2) + 28 + (back.indexOf(e) % 12) * 7;
    return `M ${x1} ${y1} C ${x1} ${deep} ${x2} ${deep} ${x2} ${y2}`;
  };

  const point = (event: PointerEvent) => {
    const matrix = svg.current?.getScreenCTM()?.inverse();
    if (!matrix) return { x: 0, y: 0 };
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix);
    return { x: p.x, y: p.y };
  };
  const stateAt = (x: number, y: number) =>
    [...boxes.values()].find((b) => x >= b.x && x <= b.x + BOX_W && y >= b.y && y <= b.y + BOX_H)?.state;

  const pickedMove = picked && "move" in picked ? picked.move : null;
  const focus = hover ?? (picked && "state" in picked ? picked.state : null);
  const isPicked = (e: StageEdge) => pickedMove?.from === e.from && pickedMove.to === e.to;
  const lit = (e: StageEdge) => isPicked(e) || (focus !== null && (e.from === focus || e.to === focus));
  const dimmed = focus !== null || pickedMove !== null;
  const scale = zoom === "fit" ? null : zoom;

  return (
    <div className={`d-flex gap-2 align-items-stretch ${full ? "h-100" : ""}`}>
      <div className="position-relative border rounded flex-fill" style={{ background: "var(--tblr-bg-surface-secondary)", minWidth: 0 }}>
        <div className="position-absolute bottom-0 start-0 m-2 btn-group" style={{ zIndex: 4 }}>
          <button
            type="button"
            className="btn btn-sm btn-icon"
            title="Smaller"
            aria-label="Smaller"
            onClick={() => setZoom(Math.max(0.5, (scale ?? 1) - 0.25))}
          >
            <IconMinus size={16} />
          </button>
          <button
            type="button"
            className={`btn btn-sm btn-icon ${zoom === "fit" ? "active" : ""}`}
            title="Fit to the width"
            aria-label="Fit to the width"
            onClick={() => setZoom("fit")}
          >
            <IconZoomReset size={16} />
          </button>
          <button
            type="button"
            className="btn btn-sm btn-icon"
            title="Larger"
            aria-label="Larger"
            onClick={() => setZoom(Math.min(2.5, (scale ?? 1) + 0.25))}
            data-testid="stages-zoom-in"
          >
            <IconPlus size={16} />
          </button>
          {!full && (
            <button
              type="button"
              className="btn btn-sm btn-icon"
              title="Full screen"
              aria-label="Full screen"
              onClick={() => onFull(true)}
              data-testid="stages-full-open"
            >
              <IconArrowsMaximize size={16} />
            </button>
          )}
        </div>
        <div className="overflow-auto" style={{ maxHeight: full ? "100%" : "70vh", height: full ? "100%" : undefined }}>
          <svg
            ref={svg}
            viewBox={`0 0 ${width} ${height}`}
            width={scale === null ? "100%" : width * scale}
            height={scale === null ? undefined : height * scale}
            role="img"
            aria-label="The stages and their moves"
            style={{
              display: "block",
              touchAction: "none",
              userSelect: "none",
              minHeight: scale === null ? Math.min(height, 260) : undefined,
              maxHeight: scale === null && full ? "100%" : undefined,
              // Fitted: no larger than a little over its own size, so two states don't fill the page.
              maxWidth: scale === null ? width * 1.25 : undefined,
              // …and no smaller than its words can be read: beyond that, it scrolls.
              minWidth: scale === null ? width * 0.85 : undefined,
              margin: scale === null ? "0 auto" : undefined,
            }}
            onPointerMove={(e) => drag && setDrag({ ...drag, ...point(e), moved: true })}
            onPointerUp={(e) => {
              if (!drag) return;
              const { x, y } = point(e);
              const to = stateAt(x, y);
              if (to && to !== drag.from) onConnect(drag.from, to);
              else if (to === drag.from) onPick({ state: drag.from });
              setDrag(null);
            }}
            onPointerLeave={() => setDrag(null)}
            data-testid="stages-diagram"
          >
            <defs>
              {[
                ["me", "var(--tblr-secondary)"],
                ["pipeline", "var(--tblr-purple)"],
                ["both", "var(--tblr-primary)"],
                ["selected", "var(--tblr-orange)"],
              ].map(([id, color]) => (
                <marker
                  key={id}
                  id={`arrow-${id}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" style={{ fill: color }} />
                </marker>
              ))}
            </defs>
            {placed.map((e) => {
              const chosen = isPicked(e);
              const isBack = !forward(e);
              const marker = chosen ? "selected" : e.by.length === 2 ? "both" : e.by[0];
              const opacity = chosen || lit(e) ? 1 : dimmed ? 0.12 : isBack ? 0.45 : 1;
              return (
                <g
                  key={`${e.from}>${e.to}`}
                  data-testid="stage-move"
                  data-from={e.from}
                  data-to={e.to}
                  data-by={e.by.join(",")}
                  style={{ opacity }}
                >
                  <path
                    d={path(e)}
                    fill="none"
                    style={{ stroke: chosen ? "var(--tblr-orange)" : edgeColor(e.by) }}
                    strokeWidth={chosen ? 3.2 : lit(e) ? 2.2 : 1.6}
                    strokeDasharray={isBack && !chosen ? "5 4" : undefined}
                    markerEnd={`url(#arrow-${marker})`}
                  />
                  <path
                    d={path(e)}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={12}
                    style={{ cursor: "pointer" }}
                    onClick={() => onPick(chosen ? null : { move: { from: e.from, to: e.to } })}
                  >
                    <title>
                      {e.from} → {e.to}: {e.by.join(" or ")}
                    </title>
                  </path>
                </g>
              );
            })}
            {[...boxes.values()].map(({ state, x, y }) => {
              const chosen = picked !== null && "state" in picked && picked.state === state;
              return (
                <g
                  key={state}
                  transform={`translate(${x}, ${y})`}
                  style={{
                    cursor: "crosshair",
                    opacity: focus && focus !== state && !placed.some((e) => lit(e) && (e.from === state || e.to === state)) ? 0.5 : 1,
                  }}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    setDrag({ from: state, ...point(e), moved: false });
                  }}
                  onPointerEnter={() => setHover(state)}
                  onPointerLeave={() => setHover(null)}
                  data-testid="stage-box"
                  data-state={state}
                >
                  <title>{`${state}: drag to another state for a move; click for its card`}</title>
                  <rect
                    width={BOX_W}
                    height={BOX_H}
                    rx={8}
                    style={{
                      fill: chosen ? "var(--tblr-primary-lt, var(--tblr-bg-surface))" : "var(--tblr-bg-surface)",
                      stroke: chosen
                        ? "var(--tblr-primary)"
                        : state === initial
                          ? "var(--tblr-green)"
                          : "var(--tblr-border-color-dark, var(--tblr-border-color))",
                    }}
                    strokeWidth={chosen || state === initial ? 2.2 : 1}
                  />
                  <text
                    x={BOX_W / 2}
                    y={BOX_H / 2 + 5}
                    textAnchor="middle"
                    fontSize="14"
                    fontWeight={chosen ? 600 : 400}
                    style={{ fill: "var(--tblr-body-color)" }}
                  >
                    {state.length > 15 ? `${state.slice(0, 14)}…` : state}
                  </text>
                  {state === initial && (
                    <text x={6} y={-5} fontSize="10" style={{ fill: "var(--tblr-green)" }}>
                      starts here
                    </text>
                  )}
                </g>
              );
            })}
            {drag?.moved && (
              <line
                x1={box(drag.from).x + BOX_W / 2}
                y1={box(drag.from).y + BOX_H / 2}
                x2={drag.x}
                y2={drag.y}
                style={{ stroke: "var(--tblr-orange)" }}
                strokeWidth={2}
                strokeDasharray="4 3"
                pointerEvents="none"
              />
            )}
          </svg>
        </div>
      </div>
      {panel}
    </div>
  );
}
