import { entityValueAt, type DataType, type EntityView } from "@realentity/storm-shared";
import { IconMessage, IconPencil } from "@tabler/icons-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AppMap } from "../components/AppMap";
import { DeleteButton } from "../components/DeleteButton";
import { ExampleChecklist } from "../components/ExampleChecklist";
import { ExportYaml } from "../components/ImportYaml";
import { toast } from "react-toastify";
import { Empty, ErrorAlert, Loading, PageHeader } from "../components/ui";
import { api } from "../lib/endpoints";
import { useAction, useLoad } from "../lib/use-load";
import { VIEW_ICON } from "../lib/view";

const PAGE = 50;
/** Columns of the plain table: the key, the title, then the first fields in the order written. */
const COLUMNS = 6;

/**
 * M30: an App: its types with their entities in a plain table (its pages come in M31), its pipelines, its versions.
 */
export function AppPage() {
  const { appId = "" } = useParams();
  const app = useLoad(() => api.apps.get(appId), [appId]);
  const [type, setType] = useState<string>();
  const mover = useAction();
  const navigate = useNavigate();
  const drift = useLoad(() => api.apps.drift(appId), [appId]);
  const map = useLoad(() => api.apps.map(appId), [appId]);
  const [into, setInto] = useState<Record<string, string>>({});
  if (!app.data) return app.error ? <ErrorAlert error={app.error} /> : <Loading />;
  const { data } = app;
  const Icon = VIEW_ICON[data.icon] ?? VIEW_ICON.list;
  const shown = type && type in data.definition.types ? type : Object.keys(data.definition.types)[0];

  return (
    <>
      <PageHeader
        pretitle={<Link to="/apps">Apps</Link>}
        title={
          <span className="d-flex align-items-center gap-2">
            <Icon size={24} />
            {data.name}
            <span className="badge bg-secondary-lt">v{data.version}</span>
          </span>
        }
        actions={
          <>
            <button
              type="button"
              className="btn"
              disabled={mover.busy}
              onClick={() =>
                void mover
                  .run(() => api.builder.create(undefined, appId))
                  .then((chat) => {
                    if (chat) void navigate(`/builder/${chat.chatId}`);
                  })
              }
              data-testid="describe-change"
            >
              <IconMessage size={18} className="me-1" />
              Describe a change
            </button>
            <ExportYaml what="app" id={appId} />
            <Link to={`/apps/${appId}/edit`} className="btn" data-testid="edit-app">
              <IconPencil size={18} className="me-1" />
              Edit
            </Link>
            <DeleteButton
              what="App"
              name={data.name}
              consequences={
                data.pipelines.length > 0
                  ? `Its pipelines (${data.pipelines.map((p) => p.name).join(", ")}) belong to it: delete them, or move them to another App, first.`
                  : `Its versions and the ${data.types.reduce((n, t) => n + t.entities, 0)} entities it keeps go with it.`
              }
              onDelete={() => api.apps.removeApp(appId)}
              then="/apps"
            />
          </>
        }
      />
      {data.definition.description && <p className="text-secondary">{data.definition.description}</p>}
      <ExampleChecklist appId={appId} />
      {data.imports.map((i) => (
        <div key={i.collection ?? i.from} className="alert alert-info d-flex align-items-center gap-3" data-testid="app-import">
          <div>
            {i.count} kept by {i.label} can move here, once: the old page stays until it goes.
          </div>
          {i.from === "collection" && (
            <select
              className="form-select w-auto ms-auto"
              aria-label={`Type for ${i.collection}`}
              value={into[i.collection!] ?? ""}
              onChange={(e) => setInto({ ...into, [i.collection!]: e.target.value })}
            >
              <option value="">into…</option>
              {Object.entries(data.definition.types)
                .filter(([, t]) => !t.mine)
                .map(([name]) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
            </select>
          )}
          <button
            type="button"
            className={`btn btn-primary ${i.from === "collection" ? "" : "ms-auto"}`}
            disabled={mover.busy || (i.from === "collection" && !into[i.collection!])}
            onClick={() =>
              void mover
                .run(() =>
                  api.apps.importFrom(appId, i.from, i.collection ? { collection: i.collection, type: into[i.collection] } : undefined),
                )
                .then((result) => {
                  if (!result) return;
                  toast.success(`Moved ${result.moved}${result.skipped ? `, ${result.skipped} already here` : ""}`);
                  app.reload();
                })
            }
          >
            Move them here
          </button>
        </div>
      ))}
      <ErrorAlert error={mover.error} />
      {map.data && (
        <div className="card mb-3">
          <div className="card-header">
            <h3 className="card-title">How it connects</h3>
            <span className="card-subtitle ms-2">its pipelines, what starts them, what they write and read, and its pages</span>
          </div>
          <div className="card-body">
            <AppMap appId={appId} map={map.data} />
          </div>
        </div>
      )}
      {drift.data && drift.data.length > 0 && (
        <div className="card mb-3" data-testid="app-drift">
          <div className="card-header">
            <h3 className="card-title">In the data, not in the types</h3>
            <span className="card-subtitle ms-2">
              what the sources give that the types don&apos;t name: kept with each entity, shown once added
            </span>
          </div>
          <div className="list-group list-group-flush">
            {drift.data.map((d) => (
              <div key={`${d.type}.${d.field}`} className="list-group-item d-flex align-items-center gap-3">
                <div>
                  <strong>
                    {d.type}.{d.field}
                  </strong>{" "}
                  <span className="badge bg-secondary-lt">{d.suggested.type}</span>
                  <div className="small text-secondary">
                    in {d.count} · e.g. {d.examples.join(", ")}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-sm ms-auto"
                  disabled={mover.busy}
                  onClick={() =>
                    void mover
                      .run(() => api.apps.addField(appId, d.type, d.field))
                      .then((saved) => {
                        if (!saved) return;
                        toast.success(`${d.type}.${d.field} added (v${saved.version})`);
                        app.reload();
                        drift.reload();
                      })
                  }
                  data-testid="add-drift-field"
                >
                  Add to the type
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="row g-3">
        <div className="col-xl-9">
          <div className="card">
            <div className="card-header">
              <ul className="nav nav-tabs card-header-tabs" role="tablist">
                {data.types.map((t) => (
                  <li key={t.name} className="nav-item">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={t.name === shown}
                      className={`nav-link ${t.name === shown ? "active" : ""}`}
                      onClick={() => setType(t.name)}
                    >
                      {t.name}
                      <span className="badge bg-secondary-lt ms-2">{t.entities}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div className="card-body border-bottom py-2">
              <Link to={`/a/${appId}/${encodeURIComponent(shown)}`} data-testid="open-list">
                Open the {shown} list
              </Link>
            </div>
            <Entities key={shown} appId={appId} type={shown} dataType={data.definition.types[shown]} />
          </div>
        </div>
        <div className="col-xl-3 d-flex flex-column gap-3">
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Pipelines</h3>
            </div>
            <div className="list-group list-group-flush">
              {data.pipelines.length === 0 && (
                <div className="list-group-item text-secondary">
                  None yet: a pipeline joins with <code>app: {data.name}</code>
                </div>
              )}
              {data.pipelines.map((p) => (
                <Link key={p.pipelineId} to={`/pipelines/${p.pipelineId}`} className="list-group-item list-group-item-action">
                  {p.name}
                  {!p.enabled && <span className="text-secondary small ms-2">off</span>}
                </Link>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Versions</h3>
            </div>
            <div className="list-group list-group-flush">
              {data.versions.map((v) => (
                <div key={v.version} className="list-group-item">
                  <div className="d-flex">
                    <strong>v{v.version}</strong>
                    <span className="text-secondary small ms-auto">{new Date(v.dateCreated).toLocaleDateString()}</span>
                  </div>
                  {v.changeSummary && (
                    <div className="small text-secondary" style={{ whiteSpace: "pre-line" }}>
                      {v.changeSummary}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Entities({ appId, type, dataType }: { appId: string; type: string; dataType: DataType }) {
  const [removed, setRemoved] = useState(false);
  const [offset, setOffset] = useState(0);
  const list = useLoad(() => api.apps.entities(appId, type, { removed, offset, limit: PAGE }), [appId, type, removed, offset]);
  const fields = [...new Set([dataType.key, ...(dataType.title ? [dataType.title] : []), ...Object.keys(dataType.fields)])].slice(
    0,
    COLUMNS,
  );
  const label = (name: string) => dataType.fields[name]?.label ?? name;

  return (
    <>
      <div className="card-body border-bottom py-2 d-flex align-items-center gap-3">
        <label className="form-check form-switch mb-0">
          <input
            className="form-check-input"
            type="checkbox"
            checked={removed}
            onChange={(e) => (setRemoved(e.target.checked), setOffset(0))}
          />
          <span className="form-check-label">Removed</span>
        </label>
        {list.data && (
          <span className="text-secondary small ms-auto">
            {list.data.total} {removed ? "removed" : "kept"}
          </span>
        )}
      </div>
      <ErrorAlert error={list.error} />
      {!list.data && !list.error && <Loading />}
      {list.data?.entities.length === 0 && (
        <Empty>
          No {type} yet: a pipeline of this App saves them with data.save {`{ type: ${type} }`}.
        </Empty>
      )}
      {list.data && list.data.entities.length > 0 && (
        <div className="table-responsive">
          <table className="table table-vcenter card-table" data-testid="entities">
            <thead>
              <tr>
                {fields.map((f) => (
                  <th key={f}>{label(f)}</th>
                ))}
                <th>First seen</th>
              </tr>
            </thead>
            <tbody>
              {list.data.entities.map((entity) => (
                <tr key={entity.key}>
                  {fields.map((f) => (
                    <td key={f} className="text-truncate" style={{ maxWidth: 280 }}>
                      {asText(valueOf(entity, f))}
                    </td>
                  ))}
                  <td className="text-secondary text-nowrap">{new Date(entity.firstSeenAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && list.data.total > PAGE && (
        <div className="card-footer d-flex gap-2 align-items-center">
          <button type="button" className="btn btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            Previous
          </button>
          <span className="text-secondary small">
            {offset + 1}–{Math.min(offset + PAGE, list.data.total)} of {list.data.total}
          </span>
          <button type="button" className="btn btn-sm" disabled={offset + PAGE >= list.data.total} onClick={() => setOffset(offset + PAGE)}>
            Next
          </button>
        </div>
      )}
    </>
  );
}

function valueOf(entity: EntityView, field: string): unknown {
  // The user's fields are kept by their name ("company.note"), what pipelines wrote as it came.
  return Object.hasOwn(entity.mine, field) ? entity.mine[field] : entityValueAt(entity.value, field);
}

/** Shown as text, whatever a pipeline wrote (M27-S1). */
function asText(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}
