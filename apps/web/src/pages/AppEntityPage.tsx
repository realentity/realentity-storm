import { fieldOf, type AppEntityView } from "@realentity/storm-shared";
import { IconTrash } from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "react-toastify";
import { EntityButtons } from "../components/EntityButtons";
import { EntityForm } from "../components/EntityForm";
import { EntityLink } from "../components/EntityLink";
import { SeriesChart } from "../components/SeriesChart";
import { ErrorAlert, Loading, Modal, PageHeader } from "../components/ui";
import { ViewValue } from "../components/ViewParts";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { useAction, useLoad } from "../lib/use-load";
import { asText } from "../lib/view";

/**
 * M31: an entity's own page: its fields (in sections when its App says so) and its history as a chart. M32: its stage
 * with the moves I may make, my fields on a form, its buttons; an entity of a type of mine can be deleted.
 */
export function AppEntityPage() {
  const { appId = "", type = "", key = "" } = useParams();
  const navigate = useNavigate();
  const loaded = useLoad(
    () => api.apps.entity(appId, type, key),
    [appId, type, key],
    (signal) => signal.type === "run" && signal.status === "DONE",
  );
  const [shown, setShown] = useState<AppEntityView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const action = useAction();
  const data = shown?.row.key === loaded.data?.row.key && shown ? shown : loaded.data;
  if (!data) return loaded.error ? <ErrorAlert error={loaded.error} /> : <Loading />;
  const { page, row, history, list, stage } = data;
  const title = fieldOf(row, page.title);
  const listUrl = `/a/${appId}/${encodeURIComponent(type)}`;

  const save = async (values: Record<string, unknown>) => {
    const saved = await action.run(() => api.apps.saveValues(appId, type, key, values));
    if (saved) {
      setShown(saved);
      toast.success("Saved");
    }
  };
  const move = async (to: string) => {
    const moved = await action.run(() => api.apps.move(appId, type, key, to));
    if (moved) setShown(moved);
  };
  const remove = async () => {
    const done = await action.run(async () => {
      await api.apps.remove(appId, type, key);
      return true;
    });
    if (done) void navigate(listUrl);
  };

  return (
    <>
      <PageHeader
        pretitle={
          <>
            <Link to={`/apps/${appId}`}>{data.app}</Link> · <Link to={listUrl}>{list.label}</Link>
          </>
        }
        title={title === undefined || title === null || title === "" ? row.key : asText(title)}
        actions={
          <>
            <EntityLink row={row} field={page.link} />
            <EntityButtons appId={appId} type={type} entityKey={key} actions={data.actions.map((i) => ({ index: i, ...page.actions[i] }))} />
            {page.mine && (
              <button type="button" className="btn btn-outline-danger" onClick={() => setDeleting(true)} data-testid="delete-entity">
                <IconTrash size={18} className="me-1" />
                Delete
              </button>
            )}
          </>
        }
      />
      <ErrorAlert error={action.error} />
      <div className="row g-3">
        <div className="col-lg-7 d-flex flex-column gap-3">
          {page.stages && stage && (
            <div className="card" data-testid="entity-stage">
              <div className="card-body d-flex flex-wrap align-items-center gap-2">
                <span className="text-secondary">{page.stages.label}</span>
                <span className="badge bg-blue-lt fs-4" data-testid="stage-value">
                  {stage.value}
                </span>
                {stage.moves.length > 0 && <span className="text-secondary ms-2">Move to</span>}
                {stage.moves.map((to) => (
                  <button key={to} type="button" className="btn btn-sm" disabled={action.busy} onClick={() => void move(to)} data-testid="stage-move">
                    {to}
                  </button>
                ))}
              </div>
            </div>
          )}
          {page.sections.map((section, i) => (
            <div key={section.title ?? i} className="card">
              {section.title && (
                <div className="card-header">
                  <h3 className="card-title">{section.title}</h3>
                </div>
              )}
              <div className="card-body">
                <dl className="row mb-0" data-testid="entity-fields">
                  {section.fields.map((column) => (
                    <Field key={column.field} label={column.label}>
                      <ViewValue row={row} column={column} full />
                    </Field>
                  ))}
                </dl>
              </div>
            </div>
          ))}
        </div>
        <div className="col-lg-5 d-flex flex-column gap-3">
          {page.form.length > 0 && (
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">Mine</h3>
              </div>
              <div className="card-body">
                <EntityForm
                  key={JSON.stringify(data.mine)}
                  fields={page.form}
                  values={data.mine}
                  submit={(values) => void save(values)}
                  busy={action.busy}
                  testId="entity-form"
                />
              </div>
            </div>
          )}
          {page.history && (
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">{page.history.label}</h3>
              </div>
              <div className="card-body">
                <SeriesChart
                  series={[{ id: row.key, label: page.history.label, points: history ?? [] }]}
                  stepped={page.history.stepped}
                  label={`${page.history.label} of ${asText(title ?? row.key)}`}
                  empty="Nothing kept yet."
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
                {stage &&
                  page.stages?.states
                    .filter((s) => stage.dates[s])
                    .map((s) => (
                      <Field key={s} label={s}>
                        {formatDateTime(stage.dates[s])}
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
      {deleting && (
        <Modal
          title={`Delete this ${type}?`}
          onClose={() => setDeleting(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setDeleting(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" onClick={() => void remove()} data-testid="confirm-delete">
                Delete
              </button>
            </>
          }
        >
          It goes from {list.label}; pipelines that read it won&apos;t see it any more.
        </Modal>
      )}
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
