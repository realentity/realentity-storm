import { IconPlus } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { ImportYaml } from "../components/ImportYaml";
import { Empty, ErrorAlert, Loading, PageHeader } from "../components/ui";
import { api } from "../lib/endpoints";
import { useLoad } from "../lib/use-load";
import { VIEW_ICON } from "../lib/view";

/** M30: my Apps, each with its types (and how many entities each keeps) and the pipelines that name it. */
export function AppsPage() {
  const apps = useLoad(() => api.apps.list(), []);
  return (
    <>
      <PageHeader
        title="Apps"
        actions={
          <div className="btn-list">
            <ImportYaml onImported={apps.reload} />
            <Link to="/apps/new" className="btn btn-primary">
              <IconPlus size={18} className="me-1" />
              New App
            </Link>
          </div>
        }
      />
      <ErrorAlert error={apps.error} />
      {!apps.data && !apps.error && <Loading />}
      {apps.data?.length === 0 && <Empty>No Apps yet. An App groups data types and the pipelines that write, read and watch them.</Empty>}
      <div className="row row-cards">
        {apps.data?.map((app) => {
          const Icon = VIEW_ICON[app.icon] ?? VIEW_ICON.list;
          return (
            <div key={app.appId} className="col-md-6 col-xl-4">
              <Link to={`/apps/${app.appId}`} className="card card-link h-100 text-reset text-decoration-none" data-testid="app-card">
                <div className="card-body">
                  <div className="d-flex align-items-center gap-2 mb-2">
                    <Icon size={22} />
                    <h3 className="card-title mb-0">{app.name}</h3>
                    <span className="badge bg-secondary-lt ms-auto">v{app.version}</span>
                  </div>
                  <div className="text-secondary small">{app.types.map((t) => `${t.name} (${t.entities})`).join(", ")}</div>
                  <div className="text-secondary small mt-1">
                    {app.pipelines.length === 0 ? "No pipelines yet" : app.pipelines.map((p) => p.name).join(", ")}
                  </div>
                </div>
              </Link>
            </div>
          );
        })}
      </div>
    </>
  );
}
