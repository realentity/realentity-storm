import { type PriceHistoryView } from "@ai-me/shared";
import { useMemo, useState } from "react";

/** Categorical slots in fixed order (validated for colour-vision deficiency): a shop keeps its colour by position. */
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"];
const WIDTH = 640;
const HEIGHT = 200;
const PAD = { top: 12, right: 12, bottom: 24, left: 52 };

type Offer = PriceHistoryView["offers"][number];

/**
 * A product's price per shop over time (M24-T2): one 2px line per shop, one y-axis, a crosshair with every shop's
 * price on hover. The offers table beside it is the same data as text.
 */
export function PriceChart({ history }: { history: PriceHistoryView }) {
  const offers = history.offers.filter((o) => o.points.length > 0);
  const [hover, setHover] = useState<number | null>(null);
  const scale = useMemo(() => scaleOf(offers), [offers]);
  if (!scale) return <div className="text-secondary small">No prices kept yet: the Prices pipeline adds one per shop each run.</div>;
  const { x, y, from, to, ticks } = scale;
  const plotW = WIDTH - PAD.left - PAD.right;
  const at = hover === null ? null : from + ((hover - PAD.left) / plotW) * (to - from);

  return (
    <div>
      {offers.length > 1 && (
        <div className="d-flex flex-wrap gap-3 small mb-1" aria-label="Shops">
          {offers.map((offer, i) => (
            <span key={offer.watchedOfferId} className="d-inline-flex align-items-center gap-1">
              <span style={{ width: 12, height: 2, background: SERIES[i % SERIES.length], display: "inline-block" }} />
              {offer.shop}
            </span>
          ))}
        </div>
      )}
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-100"
        style={{ height: "auto", maxHeight: 240 }}
        role="img"
        aria-label={`Prices over the last ${history.days} days`}
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
              {tick.toFixed(tick < 10 ? 2 : 0)}
            </text>
          </g>
        ))}
        <text x={PAD.left} y={HEIGHT - 6} fontSize={11} fill="var(--tblr-secondary)">
          {day(from)}
        </text>
        <text x={WIDTH - PAD.right} y={HEIGHT - 6} fontSize={11} textAnchor="end" fill="var(--tblr-secondary)">
          {day(to)}
        </text>
        {offers.map((offer, i) => {
          const points = offer.points.map((p) => [x(Date.parse(p.at)), y(p.value)] as const);
          const color = SERIES[i % SERIES.length];
          return (
            <g key={offer.watchedOfferId}>
              <polyline points={steps(points)} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {points.length === 1 && <circle cx={points[0][0]} cy={points[0][1]} r={4} fill={color} />}
            </g>
          );
        })}
        {at !== null && hover !== null && (
          <g pointerEvents="none">
            <line x1={hover} x2={hover} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke="var(--tblr-secondary)" strokeWidth={1} strokeDasharray="3 3" />
            {offers.map((offer, i) => {
              const point = nearest(offer, at);
              return point ? <circle key={offer.watchedOfferId} cx={x(Date.parse(point.at))} cy={y(point.value)} r={4} fill={SERIES[i % SERIES.length]} stroke="var(--tblr-bg-surface)" strokeWidth={2} /> : null;
            })}
          </g>
        )}
      </svg>
      {at !== null && (
        <div className="small" aria-live="polite">
          <span className="text-secondary">{day(at)}: </span>
          {offers
            .map((offer) => {
              const point = nearest(offer, at);
              return point ? `${offer.shop} ${point.value.toFixed(2)}${offer.currency ? ` ${offer.currency}` : ""}` : null;
            })
            .filter(Boolean)
            .join(" · ")}
        </div>
      )}
    </div>
  );
}

function scaleOf(offers: Offer[]) {
  const all = offers.flatMap((o) => o.points);
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

/** A price holds until the next one is read: a step after each point, not a slope between them. */
function steps(points: (readonly [number, number])[]): string {
  return points.flatMap(([px, py], i) => (i === 0 ? [`${px},${py}`] : [`${px},${points[i - 1][1]}`, `${px},${py}`])).join(" ");
}

/** The shop's last price at or before `at` (what it cost then). */
function nearest(offer: Offer, at: number) {
  return offer.points.filter((p) => Date.parse(p.at) <= at).at(-1) ?? null;
}

function day(t: number): string {
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
