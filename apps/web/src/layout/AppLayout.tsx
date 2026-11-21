import {
  IconApps,
  IconBulb,
  IconChevronDown,
  IconChevronRight,
  IconCoin,
  IconHeartbeat,
  IconHistory,
  IconHome,
  IconId,
  IconInbox,
  IconKey,
  IconLayoutGrid,
  IconListSearch,
  IconLogout,
  IconMenu2,
  IconRoute,
  IconSettings,
  IconTags,
  type Icon as TablerIcon,
} from "@tabler/icons-react";
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { AppSquares } from "../components/AppSquares";
import { KillSwitchButton } from "../components/KillSwitchButton";
import { StartMenu } from "../components/StartMenu";
import { ThemeSwitch } from "../components/ThemeSwitch";
import { useSession } from "../context/use-session";
import { api } from "../lib/endpoints";
import { useConnectionState } from "../lib/events";
import { type LayoutContext } from "../lib/app-menu";
import { failuresSeenAt, markFailuresSeen } from "../lib/failures-seen";
import { useLoad } from "../lib/use-load";

/** What you use every day: the Apps (on Home), what waits for you, what ran; then where Apps and pipelines are made. */
const NAVIGATION = [
  { to: "/", label: "Home", icon: IconHome },
  { to: "/inbox", label: "Inbox", icon: IconInbox },
  { to: "/history", label: "History", icon: IconHistory },
  { to: "/pipelines", label: "Pipelines", icon: IconRoute },
  { to: "/apps", label: "Apps", icon: IconApps },
];

/** Storm's own setup, folded under Settings: open while you are on one of them. */
const SETUP = [
  { to: "/rules", label: "Rules", icon: IconBulb },
  { to: "/topics", label: "Topics", icon: IconTags },
  { to: "/recipes", label: "Recipes", icon: IconListSearch },
  { to: "/profile", label: "Profile", icon: IconId },
  { to: "/credentials", label: "Credentials", icon: IconKey },
  { to: "/costs", label: "Costs", icon: IconCoin },
  { to: "/health", label: "Health", icon: IconHeartbeat },
  { to: "/settings", label: "Settings", icon: IconSettings },
];

const SETUP_OPEN = "storm.setupOpen";

/** The App a page belongs to: its pages, its reports, where it is managed. */
const APP_PATH = /^\/(?:a|r|apps)\/([0-9a-f-]{36})(?:\/|$)/;

/** Signed-in area: sidebar, top bar (kill switch always visible), page. */
export function AppLayout() {
  const { session, logout } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const connection = useConnectionState();
  const { pathname } = useLocation();
  // Pipelines' pages (M27) and the Apps with theirs (M31): saving one changes them, so they are read again on every page change.
  const views = useLoad(() => api.views.menu(), [pathname]);
  // Their tiles count what waits for a decision: a proposal made or decided changes it.
  const apps = useLoad(
    () => api.apps.menu(),
    [pathname],
    (signal) => signal.type === "proposal",
  );
  const openAppId = APP_PATH.exec(pathname)?.[1];
  // The Start menu: every App over the page that is open; Ctrl+K (⌘K) opens and closes it anywhere.
  const [startOpen, setStartOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setStartOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const onSetup = SETUP.some((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
  const [setupOpen, setSetupOpen] = useState(() => {
    try {
      return localStorage.getItem(SETUP_OPEN) === "true";
    } catch {
      return false;
    }
  });
  const toggleSetup = () => {
    const open = !setupOpen;
    setSetupOpen(open);
    try {
      localStorage.setItem(SETUP_OPEN, String(open));
    } catch {
      // Not kept: it starts folded next time.
    }
  };
  const pending = useLoad(
    () => api.proposals.list(),
    [],
    (signal) => signal.type === "proposal" || signal.type === "killSwitch",
  );
  // Failures since History was last open: seen while it is open, and up to the moment it is left.
  const onHistory = pathname === "/history";
  useEffect(() => {
    if (!onHistory) return undefined;
    markFailuresSeen();
    return () => markFailuresSeen();
  }, [onHistory]);
  const failures = useLoad(
    () => (onHistory ? Promise.resolve({ count: 0 }) : api.runs.failures(failuresSeenAt())),
    [onHistory],
    (signal) => signal.type === "run",
  );

  return (
    <div className="page">
      <aside className="navbar navbar-vertical navbar-expand-lg" data-bs-theme="dark">
        <div className="container-fluid">
          <button className="navbar-toggler" type="button" aria-label="Menu" onClick={() => setMenuOpen((open) => !open)}>
            <IconMenu2 size={20} />
          </button>
          <div className="navbar-brand navbar-brand-autodark">
            <NavLink to="/" className="text-reset text-decoration-none fw-bold fs-2 d-flex align-items-center gap-2">
              <img src="/logo.svg" alt="" width={32} height={32} />
              Storm
            </NavLink>
          </div>
          <div className={`collapse navbar-collapse ${menuOpen ? "show" : ""}`}>
            <ul className="navbar-nav pt-lg-3">
              {NAVIGATION.map((item) => (
                <MenuLink key={item.to} to={item.to} label={item.label} icon={item.icon} end={item.to === "/"} onClick={() => setMenuOpen(false)}>
                  {item.to === "/inbox" && (pending.data?.length ?? 0) > 0 && (
                    <span className="badge bg-yellow text-yellow-fg ms-auto" data-testid="inbox-count">
                      {pending.data?.length}
                    </span>
                  )}
                  {item.to === "/history" && (failures.data?.count ?? 0) > 0 && (
                    <span className="badge bg-red text-red-fg ms-auto" title="Runs that failed since you last opened History" data-testid="history-failures">
                      {failures.data?.count}
                    </span>
                  )}
                </MenuLink>
              ))}
              <li className="nav-item mt-3">
                <button
                  type="button"
                  className="nav-link border-0 bg-transparent w-100 text-start text-uppercase small text-secondary py-1"
                  aria-expanded={setupOpen || onSetup}
                  onClick={toggleSetup}
                  data-testid="setup-toggle"
                >
                  <span className="nav-link-title">Setup</span>
                  <span className="ms-auto">{setupOpen || onSetup ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}</span>
                </button>
              </li>
              {(setupOpen || onSetup) &&
                SETUP.map((item) => <MenuLink key={item.to} to={item.to} label={item.label} icon={item.icon} onClick={() => setMenuOpen(false)} />)}
              <li className="nav-item mt-3">
                <AppSquares
                  apps={apps.data ?? []}
                  openAppId={openAppId}
                  onAll={() => {
                    setMenuOpen(false);
                    setStartOpen(true);
                  }}
                  onOpen={() => setMenuOpen(false)}
                />
              </li>
            </ul>
          </div>
        </div>
      </aside>

      {startOpen && (
        <StartMenu apps={apps.data ?? []} views={views.data ?? []} onPinned={apps.reload} onClose={() => setStartOpen(false)} />
      )}
      <div className="page-wrapper">
        <header className="navbar navbar-expand-md d-print-none sticky-top">
          <div className="container-xl">
            <button
              type="button"
              className="btn btn-ghost-secondary"
              title="All Apps (Ctrl K)"
              aria-haspopup="dialog"
              aria-expanded={startOpen}
              onClick={() => setStartOpen(true)}
              data-testid="start-button"
            >
              <IconLayoutGrid size={18} className="me-1" />
              Apps
            </button>
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
            <Outlet context={{ apps, views, pending: pending.data?.length ?? 0 } satisfies LayoutContext} />
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
  end,
  onClick,
  children,
}: {
  to: string;
  label: string;
  icon: TablerIcon;
  end?: boolean;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <li className="nav-item">
      <NavLink to={to} end={end} className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`} onClick={onClick}>
        <span className="nav-link-icon">
          <Icon size={20} />
        </span>
        <span className="nav-link-title">{label}</span>
        {children}
      </NavLink>
    </li>
  );
}
