import { type ViewColumn } from "@realentity/storm-shared";
import { type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { PriceChart } from "../components/PriceChart";
import { ErrorAlert, Loading, PageHeader } from "../components/ui";
import { RowLink, RowMarks, ViewActions, ViewValue } from "../components/ViewParts";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { useLoad } from "../lib/use-load";
import { columnLabel, rowTitle } from "../lib/view";

/** M27: one row of a pipeline's page: its fields, the user's marks, its buttons, and its history when the view keeps one. */
export function ViewRowPage() {
  const { pipelineId = "", key = "" } = useParams();
  const loaded = useLoad(
    () => api.views.row(pipelineId, key),
    [pipelineId, key],
    (signal) => signal.type === "run" && signal.status === "DONE",
  );
  if (!loaded.data) return loaded.error ? <ErrorAlert error={loaded.error} /> : <Loading />;
  const { view, row, history } = loaded.data;

  // The view's detail fields, else its columns' fields then the rest of the row (Postgres keeps JSON keys in its own
  // order), each shown as its column says when it is one.
  const formats = new Map(view.columns.map((c) => [c.field, c]));
  const order = view.detail.fields ?? [
    ...new Set([...view.columns.map((c) => c.field).filter((f) => !f.startsWith("@") && !f.includes(".")), ...Object.keys(row.value)]),
  ];
  const fields: ViewColumn[] = order.map((field) => formats.get(field) ?? { field, as: "text" });

  return (
    <>
      <PageHeader
        title={rowTitle(view, row)}
        pretitle={<Link to={`/v/${pipelineId}`}>{view.menu.label}</Link>}
        actions={
          <>
            <RowLink view={view} row={row} />
            <RowMarks pipelineId={pipelineId} view={view} row={row} onChanged={loaded.reload} />
            <ViewActions pipelineId={pipelineId} view={view} row={row} />
          </>
        }
      />
      <div className="row g-3">
        <div className="col-lg-7">
          <div className="card">
            <div className="card-body">
              <dl className="row mb-0">
                {fields.map((column) => (
                  <Field key={column.field} label={columnLabel(column)}>
                    <ViewValue row={row} column={column} full />
                  </Field>
                ))}
              </dl>
            </div>
          </div>
        </div>
        <div className="col-lg-5 d-flex flex-column gap-3">
          {history && history.length > 0 && (
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">History</h3>
              </div>
              <div className="card-body">
                <PriceChart
                  history={{
                    days: 0,
                    offers: [{ watchedOfferId: row.key, shop: view.detail.history ?? "", currency: null, points: history }],
                  }}
                />
              </div>
            </div>
          )}
          <div className="card">
            <div className="card-body">
              <dl className="row mb-0 small">
                <Field label="First seen">{formatDateTime(row.firstSeenAt)}</Field>
                <Field label="Last seen">{formatDateTime(row.lastSeenAt)}</Field>
                {row.removedAt && <Field label="Removed">{formatDateTime(row.removedAt)}</Field>}
                {view.marks
                  .filter((m) => m.id in row.marks)
                  .map((m) => (
                    <Field key={m.id} label={m.label}>
                      {formatDateTime(row.marks[m.id])}
                    </Field>
                  ))}
                <Field label="Key">
                  <code className="text-break">{row.key}</code>
                </Field>
              </dl>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="col-4 text-secondary fw-normal">{label}</dt>
      <dd className="col-8 text-break">{children}</dd>
    </>
  );
}
