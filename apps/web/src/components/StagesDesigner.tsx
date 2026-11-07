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
import { IconArrowLeft, IconArrowRight, IconFlag, IconPlus, IconTrash } from "@tabler/icons-react";
import { useRef, useState, type PointerEvent } from "react";
import { text, type LooseApp, type LooseType } from "../lib/loose-app";
import { Issues } from "./AppIssues";
import { CommitInput, type DesignerEdit } from "./TypesDesigner";

const STATE = /^\S.{0,39}$/;
const BOX_W = 104;
const BOX_H = 36;
const STEP = 132;
const PAD = 16;

/** An arrow's colour by who may make it: me, a pipeline, or both. */
function edgeColor(by: StageActor[]): string {
  if (by.length === 2) return "var(--tblr-primary)";
  return by[0] === "pipeline" ? "var(--tblr-purple)" : "var(--tblr-secondary)";
}

/**
 * M35-T3: a type's stages as a diagram: its states as boxes in their order, each move an arrow (forward above, back
 * below), coloured by who may make it. Drag from one state to another for a move; click an arrow to change it.
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
  const [selected, setSelected] = useState<{ from: string; to: string } | null>(null);
  const [newState, setNewState] = useState("");
  const edge = selected ? edges.find((e) => e.from === selected.from && e.to === selected.to) : undefined;
  const setEdge = (from: string, to: string, by: StageActor[]) => {
    onEdit((s) => setStageEdge(s, name, from, to, by));
    setSelected(by.length > 0 ? { from, to } : null);
  };
  return (
    <div data-testid="designer-stages">
      <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
        <h3 className="mb-0 me-2">{name}</h3>
        <span className="text-secondary small">by the field</span>
        <CommitInput
          value={text(stages.field)}
          className="form-control form-control-sm font-monospace w-auto"
          valid={(v) => /^[A-Za-z_][\w-]{0,63}$/.test(v)}
          onCommit={(v) => onEdit((s) => setStagesProperty(s, name, "field", v))}
          disabled={!editable}
          ariaLabel={`${name}'s stage field`}
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
      <Diagram
        states={stages.states}
        initial={text(stages.initial)}
        edges={edges}
        selected={selected}
        onSelect={setSelected}
        onConnect={(from, to) => {
          const existing = edges.find((e) => e.from === from && e.to === to);
          if (existing) setSelected({ from, to });
          else if (editable) setEdge(from, to, ["me"]);
        }}
      />
      {edge && (
        <div className="d-flex align-items-center gap-3 border rounded p-2 mt-2" data-testid="selected-move">
          <strong>
            {edge.from} → {edge.to}
          </strong>
          <span className="text-secondary small">may be made by</span>
          {STAGE_ACTORS.map((actor) => (
            <label key={actor} className="form-check form-check-inline mb-0">
              <input
                type="checkbox"
                className="form-check-input"
                checked={edge.by.includes(actor)}
                disabled={!editable || (edge.by.length === 1 && edge.by[0] === actor)}
                onChange={(e) => setEdge(edge.from, edge.to, e.target.checked ? [...edge.by, actor] : edge.by.filter((b) => b !== actor))}
                data-testid={`move-by-${actor}`}
              />
              <span className="form-check-label">{actor === "me" ? "me" : "a pipeline"}</span>
            </label>
          ))}
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

function Legend() {
  const item = (label: string, by: StageActor[]) => (
    <span className="d-inline-flex align-items-center gap-1 small text-secondary">
      <svg width="22" height="8" aria-hidden="true">
        <line x1="0" y1="4" x2="22" y2="4" style={{ stroke: edgeColor(by) }} strokeWidth="2" />
      </svg>
      {label}
    </span>
  );
  return (
    <span className="d-inline-flex gap-3 ms-3">
      {item("me", ["me"])}
      {item("a pipeline", ["pipeline"])}
      {item("both", ["me", "pipeline"])}
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

/** The states in a row; an arrow forward arches above them, one back below; the further, the higher. */
function Diagram({
  states,
  initial,
  edges,
  selected,
  onSelect,
  onConnect,
}: Readonly<{
  states: string[];
  initial: string;
  edges: StageEdge[];
  selected: { from: string; to: string } | null;
  onSelect: (edge: { from: string; to: string } | null) => void;
  onConnect: (from: string, to: string) => void;
}>) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ from: string; x: number; y: number } | null>(null);
  const index = new Map(states.map((s, i) => [s, i]));
  const placed = edges.filter((e) => index.has(e.from) && index.has(e.to));
  const span = (e: StageEdge) => Math.abs(index.get(e.to)! - index.get(e.from)!);
  const lift = (n: number) => 18 + n * 16;
  const above = Math.max(0, ...placed.filter((e) => index.get(e.to)! > index.get(e.from)!).map((e) => lift(span(e))));
  const below = Math.max(0, ...placed.filter((e) => index.get(e.to)! < index.get(e.from)!).map((e) => lift(span(e))));
  const top = PAD + above;
  const width = Math.max(1, states.length) * STEP - (STEP - BOX_W) + PAD * 2;
  const height = top + BOX_H + below + PAD;
  const cx = (i: number) => PAD + i * STEP + BOX_W / 2;

  const point = (event: PointerEvent) => {
    const matrix = svg.current?.getScreenCTM()?.inverse();
    if (!matrix) return { x: 0, y: 0 };
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix);
    return { x: p.x, y: p.y };
  };
  const stateAt = (x: number, y: number) => {
    if (y < top || y > top + BOX_H) return undefined;
    return states.find((_, i) => Math.abs(x - cx(i)) <= BOX_W / 2);
  };

  /**
   * Where an arrow leaves or reaches a box: each its own point on the box's edge, the nearer its other end the further
   * out, so arrows nest instead of piling up. Forward ones leave a box's top right and reach the next's top left;
   * back ones leave its bottom left and reach the other's bottom right.
   */
  const slot = (e: StageEdge, end: "from" | "to") => {
    const state = e[end];
    const forward = index.get(e.to)! > index.get(e.from)!;
    const right = forward === (end === "from");
    const sharing = placed
      .filter((o) => o[end] === state && index.get(o.to)! > index.get(o.from)! === forward)
      .sort((a, b) => span(a) - span(b) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    const k = sharing.indexOf(e);
    const room = BOX_W / 2 - 14;
    const out = 8 + (k * room) / Math.max(1, sharing.length);
    const x = cx(index.get(state)!);
    return right ? x + BOX_W / 2 - out : x - BOX_W / 2 + out;
  };

  const path = (e: StageEdge) => {
    const forward = index.get(e.to)! > index.get(e.from)!;
    const x1 = slot(e, "from");
    const x2 = slot(e, "to");
    const y = forward ? top : top + BOX_H;
    const peak = forward ? y - lift(span(e)) * 2 : y + lift(span(e)) * 2;
    return `M ${x1} ${y} Q ${(x1 + x2) / 2} ${peak} ${x2} ${y}`;
  };
  const isSelected = (e: StageEdge) => selected?.from === e.from && selected.to === e.to;

  return (
    <div className="overflow-auto border rounded" style={{ background: "var(--tblr-bg-surface-secondary)" }}>
      <svg
        ref={svg}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-label="The stages and their moves"
        style={{ display: "block", touchAction: "none", userSelect: "none" }}
        onPointerMove={(e) => drag && setDrag({ ...drag, ...point(e) })}
        onPointerUp={(e) => {
          if (!drag) return;
          const { x, y } = point(e);
          const to = stateAt(x, y);
          if (to && to !== drag.from) onConnect(drag.from, to);
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
          const chosen = isSelected(e);
          const marker = chosen ? "selected" : e.by.length === 2 ? "both" : e.by[0];
          return (
            <g key={`${e.from}>${e.to}`} data-testid="stage-move" data-from={e.from} data-to={e.to} data-by={e.by.join(",")}>
              <path
                d={path(e)}
                fill="none"
                style={{ stroke: chosen ? "var(--tblr-orange)" : edgeColor(e.by) }}
                strokeWidth={chosen ? 3 : 1.6}
                markerEnd={`url(#arrow-${marker})`}
              />
              <path
                d={path(e)}
                fill="none"
                stroke="transparent"
                strokeWidth={12}
                style={{ cursor: "pointer" }}
                onClick={() => onSelect(chosen ? null : { from: e.from, to: e.to })}
              >
                <title>
                  {e.from} → {e.to}: {e.by.join(" or ")}
                </title>
              </path>
            </g>
          );
        })}
        {states.map((state, i) => (
          <g
            key={state}
            transform={`translate(${PAD + i * STEP}, ${top})`}
            style={{ cursor: "crosshair" }}
            onPointerDown={(e) => {
              e.preventDefault();
              setDrag({ from: state, ...point(e) });
            }}
            data-testid="stage-box"
            data-state={state}
          >
            <rect
              width={BOX_W}
              height={BOX_H}
              rx={6}
              style={{
                fill: "var(--tblr-bg-surface)",
                stroke: state === initial ? "var(--tblr-green)" : "var(--tblr-border-color-dark, var(--tblr-border-color))",
              }}
              strokeWidth={state === initial ? 2 : 1}
            />
            <text x={BOX_W / 2} y={BOX_H / 2 + 4} textAnchor="middle" fontSize="13" style={{ fill: "var(--tblr-body-color)" }}>
              {state.length > 14 ? `${state.slice(0, 13)}…` : state}
            </text>
          </g>
        ))}
        {drag && (
          <line
            x1={cx(index.get(drag.from) ?? 0)}
            y1={top + BOX_H / 2}
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
  );
}
