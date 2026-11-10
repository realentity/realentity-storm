import {
  IconApps,
  IconBulb,
  IconChartBar,
  IconCoin,
  IconHeartbeat,
  IconHistory,
  IconId,
  IconInbox,
  IconKey,
  IconListSearch,
  IconLogout,
  IconMenu2,
  IconRoute,
  IconSettings,
  IconTags,
  type Icon as TablerIcon,
} from "@tabler/icons-react";
import { Fragment, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { KillSwitchButton } from "../components/KillSwitchButton";
import { ThemeSwitch } from "../components/ThemeSwitch";
import { useSession } from "../context/use-session";
import { api } from "../lib/endpoints";
import { useConnectionState } from "../lib/events";
import { useLoad } from "../lib/use-load";
import { VIEW_ICON } from "../lib/view";

/** Storm itself. */
const NAVIGATION = [
  { to: "/inbox", label: "Inbox", icon: IconInbox },
  { to: "/pipelines", label: "Pipelines", icon: IconRoute },
  { to: "/apps", label: "Apps", icon: IconApps },
  { to: "/history", label: "History", icon: IconHistory },
  { to: "/rules", label: "Rules", icon: IconBulb },
  { to: "/topics", label: "Topics", icon: IconTags },
  { to: "/recipes", label: "Recipes", icon: IconListSearch },
  { to: "/profile", label: "Profile", icon: IconId },
  { to: "/credentials", label: "Credentials", icon: IconKey },
  { to: "/costs", label: "Costs", icon: IconCoin },
  { to: "/health", label: "Health", icon: IconHeartbeat },
  { to: "/settings", label: "Settings", icon: IconSettings },
];

/** What pipelines produce, where the user acts on it: these hand-built pages, then the pipelines' own (M27, `view`). */
const PAGES = [
  { to: "/insight", label: "Insight", icon: IconChartBar },
];

/** Signed-in area: sidebar, top bar (kill switch always visible), page. */
export function AppLayout() {
  const { session, logout } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const connection = useConnectionState();
  const { pathname } = useLocation();
  // Pipelines' pages (M27): saving a pipeline changes them, so the menu is read again on every page change.
  const pages = useLoad(() => api.views.menu(), [pathname]);
  // Apps' lists (M31): saving an App changes them too.
  const appPages = useLoad(() => api.apps.menu(), [pathname]);
  const pending = useLoad(
    () => api.proposals.list(),
    [],
    (signal) => signal.type === "proposal" || signal.type === "killSwitch",
  );

  return (
    <div className="page">
      <aside className="navbar navbar-vertical navbar-expand-lg" data-bs-theme="dark">
        <div className="container-fluid">
          <button className="navbar-toggler" type="button" aria-label="Menu" onClick={() => setMenuOpen((open) => !open)}>
            <IconMenu2 size={20} />
          </button>
          <div className="navbar-brand navbar-brand-autodark">
            <NavLink to="/inbox" className="text-reset text-decoration-none fw-bold fs-2 d-flex align-items-center gap-2">
              <img src="/logo.svg" alt="" width={32} height={32} />
              Storm
            </NavLink>
          </div>
          <div className={`collapse navbar-collapse ${menuOpen ? "show" : ""}`}>
            <ul className="navbar-nav pt-lg-3">
              {NAVIGATION.map((item) => (
                <MenuLink key={item.to} to={item.to} label={item.label} icon={item.icon} onClick={() => setMenuOpen(false)}>
                  {item.to === "/inbox" && (pending.data?.length ?? 0) > 0 && (
                    <span className="badge bg-yellow text-yellow-fg ms-auto" data-testid="inbox-count">
                      {pending.data?.length}
                    </span>
                  )}
                </MenuLink>
              ))}
              <li className="nav-item mt-3">
                <div className="nav-link text-uppercase small text-secondary py-1">Pages</div>
              </li>
              {PAGES.map((item) => (
                <MenuLink key={item.to} to={item.to} label={item.label} icon={item.icon} onClick={() => setMenuOpen(false)} />
              ))}
              {appPages.data?.map((page, i, all) => (
                <Fragment key={`${page.appId}:${page.type}`}>
                  {/* An App with more than one list: its name above them. */}
                  {all.filter((p) => p.appId === page.appId).length > 1 && all[i - 1]?.appId !== page.appId && (
                    <li className="nav-item">
                      <div className="nav-link small text-secondary py-1">{page.appName}</div>
                    </li>
                  )}
                  <MenuLink
                    to={`/a/${page.appId}/${encodeURIComponent(page.type)}`}
                    label={page.label}
                    icon={VIEW_ICON[page.icon] ?? VIEW_ICON.list}
                    title={page.appName}
                    testId="app-menu-item"
                    onClick={() => setMenuOpen(false)}
                  />
                </Fragment>
              ))}
              {pages.data?.map((page) => (
                <MenuLink
                  key={page.pipelineId}
                  to={`/v/${page.pipelineId}`}
                  label={page.label}
                  icon={VIEW_ICON[page.icon] ?? VIEW_ICON.list}
                  title={page.pipelineName}
                  testId="view-menu-item"
                  onClick={() => setMenuOpen(false)}
                />
              ))}
            </ul>
          </div>
        </div>
      </aside>

      <div className="page-wrapper">
        <header className="navbar navbar-expand-md d-print-none sticky-top">
          <div className="container-xl">
            <div className="ms-auto d-flex align-items-center gap-3">
              <span
                className={`status-dot ${connection === "live" ? "status-green" : connection === "connecting" ? "status-yellow" : "status-red"}`}
                title={connection === "live" ? "Live updates on" : "Live updates offline; reconnecting"}
              />
              <KillSwitchButton />
              <span className="text-secondary d-none d-md-inline">{session?.email}</span>
              <ThemeSwitch />
              <button type="button" className="btn btn-ghost-secondary btn-icon" title="Sign out" onClick={() => void logout()}>
                <IconLogout size={18} />
              </button>
            </div>
          </div>
        </header>
        <div className="page-body">
          <div className="container-xl">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}

function MenuLink({
  to,
  label,
  icon: Icon,
  title,
  testId,
  onClick,
  children,
}: {
  to: string;
  label: string;
  icon: TablerIcon;
  title?: string;
  testId?: string;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <li className="nav-item" data-testid={testId}>
      <NavLink to={to} className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`} title={title} onClick={onClick}>
        <span className="nav-link-icon">
          <Icon size={20} />
        </span>
        <span className="nav-link-title">{label}</span>
        {children}
      </NavLink>
    </li>
  );
}
