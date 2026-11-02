import { useMemo, useState } from "react";

/** Categorical slots in fixed order (validated for colour-vision deficiency): a series keeps its colour by position. */
const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"];
const WIDTH = 640;
const HEIGHT = 200;
const PAD = { top: 12, right: 12, bottom: 24, left: 52 };

export interface Series {
  id: string;
  label: string;
  points: { at: string; value: number }[];
}

/**
 * Values over time (M24-T2, M29-T8): one 2px line per series (at most five, in fixed colours), one y-axis, a legend from
 * two series, a crosshair with every series' value on hover. `stepped`: a value holds until the next is read (a price);
 * otherwise a line between readings (a count). The page shows the same data as text beside it.
 */
export function SeriesChart({
  series: all,
  stepped = false,
  label,
  format = (value) => value.toLocaleString("en-GB", { maximumFractionDigits: 2 }),
  empty,
}: {
  series: Series[];
  stepped?: boolean;
  /** What the chart shows, for screen readers. */
  label: string;
  format?: (value: number, series: Series) => string;
  empty: string;
}) {
  const series = all.filter((s) => s.points.length > 0).slice(0, SERIES_COLORS.length);
  const [hover, setHover] = useState<number | null>(null);
  const scale = useMemo(() => scaleOf(series), [series]);
  if (!scale) return <div className="text-secondary small">{empty}</div>;
  const { x, y, from, to, ticks } = scale;
  const plotW = WIDTH - PAD.left - PAD.right;
  const at = hover === null ? null : from + ((hover - PAD.left) / plotW) * (to - from);

  return (
    <div>
      {series.length > 1 && (
        <div className="d-flex flex-wrap gap-3 small mb-1" aria-label="Legend">
          {series.map((s, i) => (
            <span key={s.id} className="d-inline-flex align-items-center gap-1">
              <span style={{ width: 12, height: 2, background: SERIES_COLORS[i], display: "inline-block" }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-100"
        style={{ height: "auto", maxHeight: 240 }}
        role="img"
        aria-label={label}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - box.left) / box.width) * WIDTH;
          setHover(px >= PAD.left && px <= WIDTH - PAD.right ? px : null);
        }}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} stroke="var(--tblr-border-color)" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(tick)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--tblr-secondary)">
              {tickText(tick)}
            </text>
          </g>
        ))}
        <text x={PAD.left} y={HEIGHT - 6} fontSize={11} fill="var(--tblr-secondary)">
          {day(from)}
        </text>
        <text x={WIDTH - PAD.right} y={HEIGHT - 6} fontSize={11} textAnchor="end" fill="var(--tblr-secondary)">
          {day(to)}
        </text>
        {series.map((s, i) => {
          const points = s.points.map((p) => [x(Date.parse(p.at)), y(p.value)] as const);
          return (
            <g key={s.id}>
              <polyline
                points={stepped ? steps(points) : points.map(([px, py]) => `${px},${py}`).join(" ")}
                fill="none"
                stroke={SERIES_COLORS[i]}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {points.length === 1 && <circle cx={points[0][0]} cy={points[0][1]} r={4} fill={SERIES_COLORS[i]} />}
            </g>
          );
        })}
        {at !== null && hover !== null && (
          <g pointerEvents="none">
            <line x1={hover} x2={hover} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke="var(--tblr-secondary)" strokeWidth={1} strokeDasharray="3 3" />
            {series.map((s, i) => {
              const point = nearest(s, at);
              return point ? (
                <circle key={s.id} cx={x(Date.parse(point.at))} cy={y(point.value)} r={4} fill={SERIES_COLORS[i]} stroke="var(--tblr-bg-surface)" strokeWidth={2} />
              ) : null;
            })}
          </g>
        )}
      </svg>
      {at !== null && (
        <div className="small" aria-live="polite">
          <span className="text-secondary">{day(at)}: </span>
          {series
            .map((s) => {
              const point = nearest(s, at);
              return point ? `${s.label} ${format(point.value, s)}` : null;
            })
            .filter(Boolean)
            .join(" · ")}
        </div>
      )}
    </div>
  );
}

function scaleOf(series: Series[]) {
  const all = series.flatMap((s) => s.points);
  if (all.length === 0) return null;
  const times = all.map((p) => Date.parse(p.at));
  const values = all.map((p) => p.value);
  const from = Math.min(...times);
  const to = Math.max(...times, from + 86_400_000);
  const pad = (Math.max(...values) - Math.min(...values)) * 0.1 || Math.max(...values) * 0.05 || 1;
  const low = Math.max(0, Math.min(...values) - pad);
  const high = Math.max(...values) + pad;
  const x = (t: number) => PAD.left + ((t - from) / (to - from)) * (WIDTH - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - low) / (high - low)) * (HEIGHT - PAD.top - PAD.bottom);
  const ticks = [low, (low + high) / 2, high];
  return { x, y, from, to, ticks };
}

/** Short axis labels: 12.50, 340, 18.2k, 1.4M. */
function tickText(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  return value.toFixed(value < 10 ? 2 : 0);
}

/** A value holds until the next one is read: a step after each point, not a slope between them. */
function steps(points: (readonly [number, number])[]): string {
  return points.flatMap(([px, py], i) => (i === 0 ? [`${px},${py}`] : [`${px},${points[i - 1][1]}`, `${px},${py}`])).join(" ");
}

/** The series' last value at or before `at`. */
function nearest(series: Series, at: number) {
  return series.points.filter((p) => Date.parse(p.at) <= at).at(-1) ?? null;
}

function day(t: number): string {
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
