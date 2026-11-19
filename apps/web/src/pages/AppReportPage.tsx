import { type AppReportView, type ReportCell, type ReportSums } from "@realentity/storm-shared";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Empty, ErrorAlert, Loading, PageHeader } from "../components/ui";
import { SeriesChart } from "../components/SeriesChart";
import { api } from "../lib/endpoints";
import { useLoad } from "../lib/use-load";

/**
 * A type's report, as its App's page says: tiles of counts and sums over a period, trends over time, tables by a field.
 * The period starts as the page's first one.
 */
export function AppReportPage() {
  const { appId = "", type = "" } = useParams();
  // undefined: the page's first period; null: all time.
  const [days, setDays] = useState<number | null | undefined>(undefined);
  const [shown, setShown] = useState(`${appId}/${type}`);
  if (shown !== `${appId}/${type}`) {
    setShown(`${appId}/${type}`);
    setDays(undefined);
  }
  const report = useLoad(
    () => api.apps.report(appId, type, days),
    [appId, type, days],
    (signal) => signal.type === "run" && (signal.status === "DONE" || signal.status === "FAILED"),
  );
  if (!report.data) return report.error ? <ErrorAlert error={report.error} /> : <Loading />;
  const data = report.data;
  const periods: (number | null)[] = [...data.page.periods, null];

  return (
    <>
      <PageHeader
        pretitle={<Link to={`/apps/${appId}`}>{data.app}</Link>}
        title={data.page.label}
        actions={
          <div className="btn-group" role="group" aria-label="Period">
            {periods.map((period) => (
              <button
                key={period ?? "all"}
                type="button"
                className={`btn ${period === data.days ? "btn-primary" : ""}`}
                aria-pressed={period === data.days}
                onClick={() => setDays(period)}
              >
                {period === null ? "All time" : `${period} days`}
              </button>
            ))}
          </div>
        }
      />
      <ErrorAlert error={report.error} />
      {data.count === 0 ? (
        <Empty>
          {data.days === null ? `No ${type} yet.` : `No ${type} with a ${data.page.date.label.toLowerCase()} in the last ${data.days} days.`}
        </Empty>
      ) : (
        <Report data={data} />
      )}
    </>
  );
}

function Report({ data }: { data: AppReportView }) {
  return (
    <>
      <div className="row row-cards mb-3" data-testid="report-tiles">
        {data.tiles.map((tile) => (
          <div key={tile.label} className="col-6 col-md-4 col-xl-2">
            <div className="card card-sm h-100" data-testid="report-tile">
              <div className="card-body">
                <div className="subheader">{tile.label}</div>
                <div className="h1 mb-1">{sumsText(tile.sums)}</div>
                {tile.share !== null && (
                  <div className="small text-secondary">
                    {tile.share}% of {data.page.tiles.find((t) => t.label === tile.label)?.of}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      {data.trends.map((trend) => (
        <div key={trend.label} className="card mb-3" data-testid="report-trend">
          <div className="card-header">
            <h3 className="card-title">{trend.label}</h3>
            <span className="card-subtitle ms-2">by {trend.every}</span>
          </div>
          <div className="card-body">
            <SeriesChart
              series={trend.series.map((s) => ({ id: s.currency || "value", label: s.currency || trend.label, points: s.points }))}
              label={`${trend.label} by ${trend.every}`}
              empty="Nothing with a date in this period."
            />
          </div>
        </div>
      ))}
      {data.tables.map((table) => (
        <div key={table.label} className="card mb-3" data-testid="report-table">
          <div className="card-header">
            <h3 className="card-title">{table.label}</h3>
          </div>
          <div className="table-responsive">
            <table className="table table-vcenter card-table">
              <thead>
                <tr>
                  <th />
                  {table.columns.map((column) => (
                    <th key={column} className="text-end">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row) => (
                  <tr key={row.value ?? ""}>
                    <td className="fw-medium">{row.label}</td>
                    {row.cells.map((c, i) => (
                      <td key={table.columns[i]} className="text-end">
                        <Cell cell={c} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {table.more > 0 && <div className="card-footer small text-secondary">and {table.more} more</div>}
        </div>
      ))}
    </>
  );
}

function Cell({ cell }: { cell: ReportCell }) {
  return (
    <>
      {sumsText(cell.sums)}
      {cell.share !== null && <span className="text-secondary small ms-1">{cell.share}%</span>}
    </>
  );
}

/** A count or a sum; money a sum per currency. */
function sumsText(sums: ReportSums): string {
  const entries = Object.entries(sums);
  if (entries.length === 0) return "0";
  return entries
    .map(([currency, value]) =>
      currency ? `${value.toFixed(2)} ${currency}` : value.toLocaleString("en-GB", { maximumFractionDigits: 2 }),
    )
    .join(" · ");
}
