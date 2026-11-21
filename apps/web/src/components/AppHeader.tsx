import { type AppMenuPage } from "@realentity/storm-shared";
import { IconAlertTriangle, IconSettings } from "@tabler/icons-react";
import { Fragment, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { appPageUrl, useLayout } from "../lib/app-menu";
import { VIEW_ICON } from "../lib/view";

/** A step of the breadcrumb after the App; the last one is where the user is. */
export interface Crumb {
  label: ReactNode;
  to?: string;
}

/**
 * The top of an open App's pages: where you are (Home › App › page › entity), the App with its icon, a way to manage
 * it, and its pages as tabs. The page it is on, or the list an entity is in, is the active tab.
 */
export function AppHeader({
  appId,
  appName,
  current,
  trail,
  actions,
}: {
  appId: string;
  /** The App's name as the page loaded it: shown until the launcher's list is there. */
  appName: string;
  current?: Pick<AppMenuPage, "kind" | "type">;
  trail: Crumb[];
  actions?: ReactNode;
}) {
  const { apps } = useLayout();
  const app = apps.data?.find((a) => a.appId === appId);
  const Icon = VIEW_ICON[app?.icon ?? "list"] ?? VIEW_ICON.list;
  const crumbs: Crumb[] = [{ label: "Home", to: "/" }, { label: app?.name ?? appName, to: `/a/${appId}` }, ...trail];
  const isCurrent = (page: AppMenuPage) => page.kind === current?.kind && page.type === current.type;

  return (
    <div className="page-header d-print-none mb-3" data-testid="app-header">
      <ol className="breadcrumb" aria-label="Breadcrumb" data-testid="breadcrumb">
        {crumbs.map((crumb, i) => (
          <Fragment key={i}>
            {i < crumbs.length - 1 && crumb.to ? (
              <li className="breadcrumb-item">
                <Link to={crumb.to}>{crumb.label}</Link>
              </li>
            ) : (
              <li className="breadcrumb-item active" aria-current="page">
                {crumb.label}
              </li>
            )}
          </Fragment>
        ))}
      </ol>
      <div className="row g-2 align-items-center mt-2">
        <div className="col d-flex align-items-center gap-2">
          <span className="avatar avatar-sm bg-primary-lt">
            <Icon size={20} />
          </span>
          <h2 className="page-title mb-0" data-testid="app-name">
            {app?.name ?? appName}
          </h2>
          {app?.nothingOn && (
            <span className="text-yellow" title={`None of ${app.name}'s pipelines is on: nothing runs by itself yet`}>
              <IconAlertTriangle size={18} />
            </span>
          )}
        </div>
        <div className="col-auto ms-auto d-flex gap-2 flex-wrap">
          {actions}
          <Link to={`/apps/${appId}`} className="btn btn-icon" title={`Manage ${app?.name ?? appName}`} aria-label="Manage" data-testid="app-manage">
            <IconSettings size={18} />
          </Link>
        </div>
      </div>
      {(app?.pages.length ?? 0) > 0 && (
        <ul className="nav nav-tabs mt-3" data-testid="app-tabs">
          {app?.pages.map((page) => {
            const PageIcon = VIEW_ICON[page.icon] ?? VIEW_ICON.list;
            return (
              <li key={`${page.kind}:${page.type}`} className="nav-item">
                <Link
                  to={appPageUrl(appId, page)}
                  className={`nav-link ${isCurrent(page) ? "active" : ""}`}
                  aria-current={isCurrent(page) ? "page" : undefined}
                  data-testid="app-tab"
                >
                  <PageIcon size={16} className="me-1" />
                  {page.label}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
