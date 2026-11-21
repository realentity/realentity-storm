import { type AppMenuItem, type ViewMenuItem } from "@realentity/storm-shared";
import { IconPin, IconPinnedFilled, IconSearch } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import { appUrl } from "../lib/app-menu";
import { api } from "../lib/endpoints";
import { VIEW_ICON } from "../lib/view";

/** The pinned Apps first, then the others, each by name as the server sorts them. */
export function byPinned(apps: readonly AppMenuItem[]): AppMenuItem[] {
  return [...apps.filter((a) => a.pinned), ...apps.filter((a) => !a.pinned)];
}

/**
 * Every installed App, over whatever page is open: found by typing, opened with a click or Enter, pinned to the
 * sidebar from here; the pipelines' own pages under them. Escape or a click beside it closes it, and you are where
 * you were.
 */
export function StartMenu({
  apps,
  views,
  onPinned,
  onClose,
}: {
  apps: readonly AppMenuItem[];
  views: readonly ViewMenuItem[];
  onPinned: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const navigate = useNavigate();
  const wanted = q.trim().toLowerCase();
  const matches = (...texts: (string | null)[]) => !wanted || texts.some((t) => t?.toLowerCase().includes(wanted));
  const shown = byPinned(apps).filter((a) => matches(a.name, a.description, ...a.pages.map((p) => p.label)));
  const shownViews = views.filter((v) => matches(v.label, v.pipelineName));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const open = (to: string) => {
    onClose();
    void navigate(to);
  };
  const pin = async (app: AppMenuItem) => {
    try {
      await api.apps.pin(app.appId, !app.pinned);
      onPinned();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Not saved");
    }
  };

  return (
    <>
      <div className="modal show d-block start-menu" role="dialog" aria-modal="true" aria-label="All Apps" onClick={onClose} data-testid="start-menu">
        <div className="modal-dialog modal-lg" onClick={(e) => e.stopPropagation()}>
          <div className="modal-content">
            <div className="modal-header gap-2">
              <IconSearch size={18} className="text-secondary" />
              <input
                className="form-control px-3"
                placeholder="Find an App or a page…"
                aria-label="Find an App"
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  if (shown[0]) open(appUrl(shown[0]));
                  else if (shownViews[0]) open(`/v/${shownViews[0].pipelineId}`);
                }}
                data-testid="start-search"
              />
              <span className="text-secondary small text-nowrap d-none d-md-inline">Ctrl K</span>
            </div>
            <div className="modal-body">
              {apps.length === 0 ? (
                <div className="text-secondary">No Apps yet.</div>
              ) : shown.length === 0 ? (
                <div className="text-secondary">No App matches.</div>
              ) : (
                <div className="row g-2">
                  {shown.map((app) => {
                    const Icon = VIEW_ICON[app.icon] ?? VIEW_ICON.list;
                    return (
                      <div key={app.appId} className="col-4 col-sm-3">
                        <div className="start-tile position-relative">
                          <Link
                            to={appUrl(app)}
                            onClick={onClose}
                            className="d-flex flex-column align-items-center gap-1 p-2 rounded text-reset text-decoration-none"
                            title={app.description ?? app.name}
                            data-testid="start-app"
                          >
                            <span className="avatar bg-primary-lt">
                              <Icon size={24} />
                            </span>
                            <span className="small text-center text-truncate w-100">{app.name}</span>
                          </Link>
                          {app.pending > 0 && (
                            <span className="badge bg-yellow text-yellow-fg badge-pill start-tile-count" title={`${app.pending} waiting for your decision`}>
                              {app.pending}
                            </span>
                          )}
                          <button
                            type="button"
                            className={`btn btn-icon btn-sm btn-ghost-secondary start-tile-pin ${app.pinned ? "pinned" : ""}`}
                            title={app.pinned ? `Unpin ${app.name} from the sidebar` : `Pin ${app.name} to the sidebar`}
                            aria-label={app.pinned ? `Unpin ${app.name}` : `Pin ${app.name}`}
                            aria-pressed={app.pinned}
                            onClick={() => void pin(app)}
                            data-testid="start-pin"
                          >
                            {app.pinned ? <IconPinnedFilled size={14} /> : <IconPin size={14} />}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {shownViews.length > 0 && (
                <>
                  <div className="text-uppercase small text-secondary mt-3 mb-1">Pipeline pages</div>
                  <div className="list-group list-group-flush">
                    {shownViews.map((view) => {
                      const Icon = VIEW_ICON[view.icon] ?? VIEW_ICON.list;
                      return (
                        <Link
                          key={view.pipelineId}
                          to={`/v/${view.pipelineId}`}
                          onClick={onClose}
                          className="list-group-item list-group-item-action d-flex align-items-center gap-2"
                          data-testid="start-view"
                        >
                          <Icon size={18} />
                          {view.label}
                        </Link>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
            <div className="modal-footer justify-content-between py-2">
              <span className="text-secondary small">Pin an App to keep it in the sidebar.</span>
              <Link to="/apps" onClick={onClose} className="small">
                Install or make Apps
              </Link>
            </div>
          </div>
        </div>
      </div>
      <div className="modal-backdrop show" />
    </>
  );
}
