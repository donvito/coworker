import type { ReactNode } from "react";
import appIcon from "../assets/app-icon.png";
import type { PageId } from "../navigation";
import { Icon, type IconName } from "./Icon";

const navigation: Array<{ id: PageId; label: string; icon: IconName }> = [
  { id: "home", label: "Home", icon: "home" },
  { id: "coworkers", label: "Coworkers", icon: "people" },
  { id: "files", label: "Files", icon: "file" },
  { id: "approvals", label: "Approvals", icon: "check" },
  { id: "schedules", label: "Schedules", icon: "clock" },
  { id: "activity", label: "Activity", icon: "activity" },
];

export function AppShell({
  activePage,
  conversationMode = false,
  onNavigate,
  pendingApprovals,
  children,
}: {
  activePage: PageId;
  conversationMode?: boolean;
  onNavigate: (page: PageId) => void;
  pendingApprovals: number;
  children: ReactNode;
}) {
  return (
    <div className={conversationMode ? "app-frame conversation-mode" : "app-frame"}>
      {!conversationMode ? (
        <aside className="sidebar">
          <div className="window-drag-region" />
          <button className="brand" onClick={() => onNavigate("home")}>
            <img className="brand-mark" src={appIcon} alt="" />
            <span>
              <strong>Workroom</strong>
              <small>Local coworker desk</small>
            </span>
          </button>

          <nav className="primary-nav" aria-label="Main navigation">
            <span className="nav-eyebrow">Your workspace</span>
            {navigation.map((item) => (
              <button
                key={item.id}
                className={activePage === item.id ? "nav-item active" : "nav-item"}
                onClick={() => onNavigate(item.id)}
                aria-current={activePage === item.id ? "page" : undefined}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
                {item.id === "approvals" && pendingApprovals > 0 ? (
                  <span className="nav-badge">{pendingApprovals}</span>
                ) : null}
              </button>
            ))}
          </nav>

          <div className="sidebar-spacer" />
          <button
            className={activePage === "settings" ? "nav-item active" : "nav-item"}
            onClick={() => onNavigate("settings")}
          >
            <Icon name="settings" />
            <span>Settings</span>
          </button>
        </aside>
      ) : null}
      <main className="main-stage">{children}</main>
    </div>
  );
}
