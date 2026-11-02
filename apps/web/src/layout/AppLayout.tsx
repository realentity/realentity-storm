import {
  IconBriefcase,
  IconBulb,
  IconChartBar,
  IconHistory,
  IconId,
  IconInbox,
  IconKey,
  IconListSearch,
  IconLogout,
  IconMenu2,
  IconRoute,
  IconSettings,
} from "@tabler/icons-react";
import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { KillSwitchButton } from "../components/KillSwitchButton";
import { useSession } from "../context/use-session";
import { api } from "../lib/endpoints";
import { useConnectionState } from "../lib/events";
import { useLoad } from "../lib/use-load";

const NAVIGATION = [
  { to: "/inbox", label: "Inbox", icon: IconInbox },
  { to: "/pipelines", label: "Pipelines", icon: IconRoute },
  { to: "/jobs", label: "Jobs", icon: IconBriefcase },
  { to: "/insight", label: "Insight", icon: IconChartBar },
  { to: "/history", label: "History", icon: IconHistory },
  { to: "/rules", label: "Rules", icon: IconBulb },
  { to: "/recipes", label: "Recipes", icon: IconListSearch },
  { to: "/profile", label: "Profile", icon: IconId },
  { to: "/credentials", label: "Credentials", icon: IconKey },
  { to: "/settings", label: "Settings", icon: IconSettings },
];

/** Signed-in area: sidebar, top bar (kill switch always visible), page. */
export function AppLayout() {
  const { session, logout } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const connection = useConnectionState();
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
            <NavLink to="/inbox" className="text-reset text-decoration-none fw-bold fs-2">
              AI ME
            </NavLink>
          </div>
          <div className={`collapse navbar-collapse ${menuOpen ? "show" : ""}`}>
            <ul className="navbar-nav pt-lg-3">
              {NAVIGATION.map((item) => (
                <li key={item.to} className="nav-item">
                  <NavLink
                    to={item.to}
                    className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
                    onClick={() => setMenuOpen(false)}
                  >
                    <span className="nav-link-icon">
                      <item.icon size={20} />
                    </span>
                    <span className="nav-link-title">{item.label}</span>
                    {item.to === "/inbox" && (pending.data?.length ?? 0) > 0 && (
                      <span className="badge bg-yellow text-yellow-fg ms-auto" data-testid="inbox-count">
                        {pending.data?.length}
                      </span>
                    )}
                  </NavLink>
                </li>
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
