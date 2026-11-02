import { type PriceHistoryView } from "@ai-me/shared";
import { SeriesChart } from "./SeriesChart";

/**
 * A product's price per shop over time (M24-T2): a stepped line per shop, the price with its currency on hover. The
 * offers table beside it is the same data as text.
 */
export function PriceChart({ history }: { history: PriceHistoryView }) {
  const currency = new Map(history.offers.map((o) => [o.watchedOfferId, o.currency]));
  return (
    <SeriesChart
      series={history.offers.map((o) => ({ id: o.watchedOfferId, label: o.shop, points: o.points }))}
      stepped
      label={`Prices over the last ${history.days} days`}
      format={(value, s) => `${value.toFixed(2)}${currency.get(s.id) ? ` ${currency.get(s.id)}` : ""}`}
      empty="No prices kept yet: the Prices pipeline adds one per shop each run."
    />
  );
}
