import { type AppMenuItem } from "@realentity/storm-shared";
import { IconDots } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { appUrl } from "../lib/app-menu";
import { VIEW_ICON } from "../lib/view";

/** While there are no more than this many Apps, all of them are squares; past it, only the pinned ones. */
export const SQUARES_UNPINNED = 8;

/** The Apps in the sidebar: the pinned ones, or every App while there are few and none is pinned. */
export function squaresOf(apps: readonly AppMenuItem[]): AppMenuItem[] {
  const pinned = apps.filter((a) => a.pinned);
  if (pinned.length > 0) return pinned;
  return apps.length <= SQUARES_UNPINNED ? [...apps] : [];
}

/**
 * The sidebar's Apps, like a taskbar: a square each with its icon, its name and what waits in it; the one open is lit.
 * The last square opens the Start menu with all of them.
 */
export function AppSquares({
  apps,
  openAppId,
  onAll,
  onOpen,
}: {
  apps: readonly AppMenuItem[];
  openAppId: string | undefined;
  onAll: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="app-squares" data-testid="app-squares">
      {squaresOf(apps).map((app) => {
        const Icon = VIEW_ICON[app.icon] ?? VIEW_ICON.list;
        const open = app.appId === openAppId;
        return (
          <Link
            key={app.appId}
            to={appUrl(app)}
            className={`app-square ${open ? "active" : ""}`}
            aria-current={open ? "page" : undefined}
            title={app.name}
            onClick={onOpen}
            data-testid="app-square"
          >
            <Icon size={22} />
            <span className="app-square-name">{app.name}</span>
            {app.pending > 0 && (
              <span className="badge bg-yellow text-yellow-fg badge-pill app-square-count" title={`${app.pending} waiting for your decision`}>
                {app.pending}
              </span>
            )}
          </Link>
        );
      })}
      <button type="button" className="app-square app-square-all" title="All Apps (Ctrl K)" onClick={onAll} data-testid="app-square-all">
        <IconDots size={22} />
        <span className="app-square-name">All Apps</span>
      </button>
    </div>
  );
}
