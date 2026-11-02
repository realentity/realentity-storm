import { type FunnelRow, type InsightView } from "@ai-me/shared";
import { useState } from "react";
import { Empty, ErrorAlert, Loading, PageHeader } from "../components/ui";
import { api } from "../lib/endpoints";
import { useLoad } from "../lib/use-load";

const PERIODS = [30, 90, 180, 365] as const;

/** n of total as a whole percent; "—" without a total (a rate of nothing isn't 0%). */
const rate = (n: number, total: number): string => (total ? `${Math.round((n / total) * 100)}%` : "—");

/**
 * The job search in numbers (M16-T1): postings found in a period and what came of them, by source and by score band.
 * The score bands are the calibration view: if higher scores don't get more replies and interviews, the scoring
 * criteria (or the outcomes it learns from, llm.score's `outcomes`) need another look.
 */
export function InsightPage() {
  const [days, setDays] = useState<number>(90);
  const insight = useLoad(() => api.insight.get(days), [days], (signal) => signal.type === "run");
  const data = insight.data;
  return (
    <>
      <PageHeader
        title="Insight"
        pretitle="The job search in numbers"
        actions={
          <div className="btn-group" role="group" aria-label="Period">
            {PERIODS.map((period) => (
              <button key={period} type="button" className={`btn ${period === days ? "btn-primary" : ""}`} onClick={() => setDays(period)}>
                {period} days
              </button>
            ))}
          </div>
        }
      />
      <ErrorAlert error={insight.error} />
      {!data && insight.loading && <Loading />}
      {data && data.totals.found === 0 && <Empty>No postings found in the last {days} days.</Empty>}
      {data && data.totals.found > 0 && <Dashboard data={data} />}
    </>
  );
}

function Dashboard({ data }: { data: InsightView }) {
  const t = data.totals;
  return (
    <>
      <div className="row row-cards mb-3" data-testid="insight-totals">
        <Tile label="Found" value={t.found} hint={`${t.shortlisted} shortlisted`} />
        <Tile label="Applied" value={t.applied} hint={`${rate(t.applied, t.found)} of found`} />
        <Tile label="Replied" value={t.replied} hint={`${rate(t.replied, t.applied)} of applied`} />
        <Tile label="Interviews" value={t.interview} hint={`${rate(t.interview, t.applied)} of applied`} />
        <Tile label="Rejected" value={t.rejected} hint={`${t.waiting} still waiting`} />
        <Tile
          label="First answer"
          value={data.medianDaysToAnswer === null ? "—" : `${data.medianDaysToAnswer} d`}
          hint="median days after applying"
        />
      </div>
      <Funnel
        title="By score band"
        subtitle="Calibration: the better the score, the more replies and interviews it should get."
        rows={data.byScore}
        testId="insight-score"
      />
      <Funnel title="By source" subtitle="Where the postings that go somewhere come from." rows={data.bySource} testId="insight-source" />
    </>
  );
}

function Tile({ label, value, hint }: { label: string; value: number | string; hint: string }) {
  return (
    <div className="col-6 col-md-4 col-xl-2">
      <div className="card card-sm h-100">
        <div className="card-body">
          <div className="subheader">{label}</div>
          <div className="h1 mb-1">{value}</div>
          <div className="small text-secondary">{hint}</div>
        </div>
      </div>
    </div>
  );
}

function Funnel({ title, subtitle, rows, testId }: { title: string; subtitle: string; rows: FunnelRow[]; testId: string }) {
  return (
    <div className="card mb-3" data-testid={testId}>
      <div className="card-header">
        <div>
          <h3 className="card-title">{title}</h3>
          <div className="card-subtitle">{subtitle}</div>
        </div>
      </div>
      <div className="table-responsive">
        <table className="table table-vcenter card-table">
          <thead>
            <tr>
              <th />
              <th className="text-end">Found</th>
              <th className="text-end">Applied</th>
              <th className="text-end">Replied</th>
              <th className="text-end">Interviews</th>
              <th className="text-end">Rejected</th>
              <th style={{ width: "22%" }}>Interview rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} data-testid={`${testId}-${row.key}`}>
                <td className="fw-medium">{row.key}</td>
                <td className="text-end">{row.found}</td>
                <td className="text-end">{row.applied}</td>
                <td className="text-end">
                  {row.replied} <span className="text-secondary small">{rate(row.replied, row.applied)}</span>
                </td>
                <td className="text-end">{row.interview}</td>
                <td className="text-end">{row.rejected}</td>
                <td>
                  <div className="d-flex align-items-center gap-2">
                    <div className="progress progress-sm flex-fill" title={`${row.interview} of ${row.applied} applied`}>
                      <div className="progress-bar bg-primary" style={{ width: row.applied ? `${(row.interview / row.applied) * 100}%` : 0 }} />
                    </div>
                    <span className="small text-secondary" style={{ minWidth: "2.5rem" }}>
                      {rate(row.interview, row.applied)}
                    </span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
