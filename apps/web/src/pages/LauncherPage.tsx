import { IconAlertTriangle, IconApps, IconInbox } from "@tabler/icons-react";
import { Link, Navigate, useParams } from "react-router-dom";
import { Empty, ErrorAlert, Loading } from "../components/ui";
import { appUrl, useLayout } from "../lib/app-menu";
import { VIEW_ICON } from "../lib/view";

/**
 * The first screen after signing in: every installed App as a tile that opens it, with what waits for you in it and
 * whether anything of it runs by itself; under them, the pages pipelines keep without an App.
 */
export function LauncherPage() {
  const { apps, pending } = useLayout();
  if (!apps.data) return apps.error ? <ErrorAlert error={apps.error} /> : <Loading />;

  return (
    <>
      <div className="page-header d-print-none mb-3">
        <h2 className="page-title">Home</h2>
      </div>
      {pending > 0 && (
        <Link to="/inbox" className="alert alert-warning d-flex align-items-center gap-2 text-decoration-none" data-testid="launcher-inbox">
          <IconInbox size={20} />
          {pending === 1 ? "1 proposal waits" : `${pending} proposals wait`} for your decision in the Inbox
        </Link>
      )}
      {apps.data.length === 0 ? (
        <Empty>
          No Apps yet. <Link to="/apps">Install one of the examples</Link> or make your own.
        </Empty>
      ) : (
        <div className="row row-cards" data-testid="launcher">
          {apps.data.map((app) => {
            const Icon = VIEW_ICON[app.icon] ?? VIEW_ICON.list;
            return (
              <div key={app.appId} className="col-6 col-sm-4 col-lg-3 col-xl-2">
                <Link
                  to={appUrl(app)}
                  className="card card-link card-link-pop h-100 text-reset text-decoration-none position-relative"
                  title={app.description ?? app.name}
                  data-testid="app-tile"
                >
                  {app.pending > 0 && (
                    <span
                      className="badge bg-yellow text-yellow-fg badge-notification badge-pill"
                      title={`${app.pending} waiting for your decision`}
                      data-testid="app-tile-pending"
                    >
                      {app.pending}
                    </span>
                  )}
                  <div className="card-body text-center py-4">
                    <span className="avatar avatar-lg bg-primary-lt mb-3">
                      <Icon size={32} />
                    </span>
                    <div className="fw-bold d-flex align-items-center justify-content-center gap-1">
                      {app.name}
                      {app.nothingOn && (
                        <span className="text-yellow" title={`None of ${app.name}'s pipelines is on: nothing runs by itself yet`} data-testid="app-nothing-on">
                          <IconAlertTriangle size={16} />
                        </span>
                      )}
                    </div>
                    <div className="text-secondary small">
                      {app.pages.length === 0 ? "No pages" : app.pages.map((p) => p.label).join(" · ")}
                    </div>
                  </div>
                </Link>
              </div>
            );
          })}
          <div className="col-6 col-sm-4 col-lg-3 col-xl-2">
            <Link to="/apps" className="card card-link h-100 text-secondary text-decoration-none border-dashed" data-testid="launcher-more">
              <div className="card-body text-center py-4">
                <span className="avatar avatar-lg mb-3">
                  <IconApps size={32} />
                </span>
                <div>More Apps</div>
              </div>
            </Link>
          </div>
        </div>
      )}
    </>
  );
}

/** `/a/:appId`: the App's first page, as its tile opens it. */
export function AppHome() {
  const { appId = "" } = useParams();
  const { apps } = useLayout();
  if (!apps.data) return apps.error ? <ErrorAlert error={apps.error} /> : <Loading />;
  const app = apps.data.find((a) => a.appId === appId);
  return <Navigate to={app ? appUrl(app) : `/apps/${appId}`} replace />;
}
