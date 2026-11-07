import { type AppMapEdgeKind, type AppMapNode, type AppMapView } from "@ai-me/shared";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

const BOX_W = 190;
const BOX_H = 46;
const GAP_X = 100;
const GAP_Y = 14;
const TOP = 34;

const KINDS: Record<AppMapEdgeKind, { color: string; label: string; dashed?: boolean }> = {
  starts: { color: "var(--tblr-blue)", label: "starts" },
  writes: { color: "var(--tblr-green)", label: "writes" },
  reads: { color: "var(--tblr-purple)", label: "reads" },
  watches: { color: "var(--tblr-orange)", label: "starts on a change", dashed: true },
  shows: { color: "var(--tblr-secondary)", label: "shows" },
};

const COLUMNS = ["What starts them", "Pipelines", "Types", "Pages"] as const;

interface Placed extends AppMapNode {
  column: number;
  x: number;
  y: number;
  href?: string;
  muted?: boolean;
}

const short = (text: string, max = 26) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * M37-T4: an App's map, in four columns: what starts its pipelines, the pipelines, its types, its pages. Arrows say
 * which pipeline writes or reads which type, what a change of a type or a page's button starts. A box opens its page;
 * hovering one leaves only its arrows.
 */
export function AppMap({ appId, map }: Readonly<{ appId: string; map: AppMapView }>) {
  const navigate = useNavigate();
  const [hover, setHover] = useState<string | null>(null);
  const columns: Placed[][] = [
    map.triggers.map((n) => ({ ...n, column: 0, x: 0, y: 0, href: `/pipelines/${n.id.slice("trigger:".length)}` })),
    map.pipelines.map((n) => ({ ...n, column: 1, x: 0, y: 0, href: `/pipelines/${n.pipelineId}`, muted: !n.enabled })),
    map.types.map((n) => ({ ...n, column: 2, x: 0, y: 0, href: `/a/${appId}/${encodeURIComponent(n.type)}` })),
    map.pages.map((n) => ({ ...n, column: 3, x: 0, y: 0, href: `/a/${appId}/${encodeURIComponent(n.type)}` })),
  ];
  const rows = Math.max(1, ...columns.map((c) => c.length));
  // Each column centred on the tallest; a trigger beside the pipeline it starts.
  for (const [i, column] of columns.entries()) {
    const offset = ((rows - column.length) * (BOX_H + GAP_Y)) / 2;
    column.forEach((node, j) => {
      node.x = i * (BOX_W + GAP_X);
      node.y = TOP + offset + j * (BOX_H + GAP_Y);
    });
  }
  const pipelineY = new Map(columns[1].map((n) => [n.id.slice("pipeline:".length), n.y]));
  for (const trigger of columns[0]) trigger.y = pipelineY.get(trigger.id.slice("trigger:".length)) ?? trigger.y;
  const nodes = new Map(columns.flat().map((n) => [n.id, n]));
  // An arrow going back past a column (a page's button to its pipeline) loops under the boxes, in a lane of its own.
  const bottom = TOP + rows * (BOX_H + GAP_Y);
  const looping = map.edges.filter((e) => {
    const from = nodes.get(e.from);
    const to = nodes.get(e.to);
    return from && to && from.column - to.column > 1;
  });
  const height = bottom + (looping.length ? 16 + looping.length * 14 : 0);
  // Arrows between the same two boxes, side by side.
  const pairs = new Map<string, number>();
  const nth = map.edges.map((e) => {
    const key = [e.from, e.to].sort((a, b) => a.localeCompare(b)).join("|");
    const n = pairs.get(key) ?? 0;
    pairs.set(key, n + 1);
    return n;
  });
  const width = 4 * BOX_W + 3 * GAP_X;
  const touches = (id: string) =>
    hover === null || hover === id || map.edges.some((e) => (e.from === hover && e.to === id) || (e.to === hover && e.from === id));

  return (
    <div data-testid="app-map">
      <div style={{ overflowX: "auto" }}>
        <svg
          viewBox={`-4 0 ${width + 8} ${height}`}
          width="100%"
          style={{ minWidth: 760, maxHeight: Math.max(240, height * 1.1) }}
          role="img"
          aria-label="How the App and its pipelines connect"
        >
          <defs>
            {Object.entries(KINDS).map(([kind, { color }]) => (
              <marker
                key={kind}
                id={`map-arrow-${kind}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" style={{ fill: color }} />
              </marker>
            ))}
          </defs>
          {COLUMNS.map((title, i) => (
            <text
              key={title}
              x={i * (BOX_W + GAP_X) + BOX_W / 2}
              y={16}
              textAnchor="middle"
              className="small"
              style={{ fill: "var(--tblr-secondary)", fontSize: 12 }}
            >
              {title}
            </text>
          ))}
          {map.edges.map((edge, i) => {
            const from = nodes.get(edge.from);
            const to = nodes.get(edge.to);
            if (!from || !to) return null;
            const forward = from.column < to.column;
            const shift = nth[i] * 10;
            const x1 = forward ? from.x + BOX_W : from.x;
            const x2 = forward ? to.x : to.x + BOX_W;
            const y1 = from.y + BOX_H / 2 - 5 + shift;
            const y2 = to.y + BOX_H / 2 - 5 + shift;
            const lane = looping.indexOf(edge);
            let d: string;
            let labelAt: [number, number];
            if (lane >= 0) {
              // Down from the bottom of the box, along its lane under the others, up the gap left of the target's column
              // and into its side.
              const y = bottom + 10 + lane * 14;
              const sx = from.x + BOX_W / 2;
              const tx = to.x - 24 - lane * 6;
              const ty = to.y + BOX_H / 2;
              d = `M${sx},${from.y + BOX_H} Q${sx},${y} ${sx - 12},${y} L${tx + 12},${y} Q${tx},${y} ${tx},${y - 12} L${tx},${ty + 12} Q${tx},${ty} ${tx + 12},${ty} L${to.x},${ty}`;
              labelAt = [(sx + tx) / 2, y - 3];
            } else {
              const bend = Math.max(40, Math.abs(x2 - x1) / 2) * (forward ? 1 : -1) + (forward ? shift : -shift);
              d = `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
              labelAt = [(x1 + x2) / 2, (y1 + y2) / 2 - 4];
            }
            const { color, dashed } = KINDS[edge.kind];
            const shown = hover === null || edge.from === hover || edge.to === hover;
            return (
              <g
                key={i}
                style={{ opacity: shown ? 1 : 0.12 }}
                data-testid="map-edge"
                data-from={edge.from}
                data-to={edge.to}
                data-kind={edge.kind}
              >
                <path
                  d={d}
                  fill="none"
                  style={{ stroke: color }}
                  strokeWidth={1.6}
                  strokeDasharray={dashed ? "5 4" : undefined}
                  markerEnd={`url(#map-arrow-${edge.kind})`}
                />
                {edge.label && (
                  <text
                    x={labelAt[0]}
                    y={labelAt[1]}
                    textAnchor="middle"
                    style={{ fill: color, fontSize: 11, paintOrder: "stroke", stroke: "var(--tblr-bg-surface)", strokeWidth: 4 }}
                  >
                    {short(edge.label, 22)}
                  </text>
                )}
              </g>
            );
          })}
          {[...nodes.values()].map((node) => (
            <g
              key={node.id}
              transform={`translate(${node.x},${node.y})`}
              style={{ cursor: node.href ? "pointer" : undefined, opacity: touches(node.id) ? 1 : 0.35 }}
              onMouseEnter={() => setHover(node.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => node.href && void navigate(node.href)}
              data-testid="map-node"
              data-id={node.id}
            >
              <title>{node.detail ? `${node.label}: ${node.detail}` : node.label}</title>
              <rect
                width={BOX_W}
                height={BOX_H}
                rx={6}
                style={{
                  fill: "var(--tblr-bg-surface)",
                  stroke: node.column === 2 ? "var(--tblr-primary)" : "var(--tblr-border-color)",
                  strokeWidth: node.column === 2 ? 1.6 : 1,
                  strokeDasharray: node.muted ? "4 3" : undefined,
                }}
              />
              <text
                x={10}
                y={node.detail ? 19 : 28}
                style={{ fill: "var(--tblr-body-color)", fontSize: 13, fontWeight: node.column === 2 ? 600 : 500 }}
              >
                {short(node.label)}
              </text>
              {node.detail && (
                <text x={10} y={36} style={{ fill: "var(--tblr-secondary)", fontSize: 11 }}>
                  {short(node.detail, 30)}
                </text>
              )}
            </g>
          ))}
        </svg>
      </div>
      <div className="d-flex flex-wrap gap-3 small text-secondary mt-2">
        {Object.entries(KINDS).map(([kind, { color, label, dashed }]) => (
          <span key={kind} className="d-inline-flex align-items-center gap-1">
            <svg width="22" height="8" aria-hidden>
              <line x1="0" y1="4" x2="22" y2="4" style={{ stroke: color }} strokeWidth="2" strokeDasharray={dashed ? "4 3" : undefined} />
            </svg>
            {label}
          </span>
        ))}
        <span>· a dashed box: a pipeline that is off</span>
      </div>
    </div>
  );
}
