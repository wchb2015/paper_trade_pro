import { Icon, type IconName } from "./Icon";
import type { PageKey, Portfolio } from "../lib/types";

interface SidebarProps {
  page: PageKey;
  onNavigate: (p: PageKey, ticker?: string) => void;
  portfolio: Portfolio;
  activeAlerts: number;
  provider: string;
}

export function Sidebar({
  page,
  onNavigate,
  portfolio,
  activeAlerts,
  provider,
}: SidebarProps) {
  const navItems: {
    id: PageKey;
    label: string;
    icon: IconName;
    badge?: number | null;
  }[] = [
    { id: "portfolio", label: "Portfolio", icon: "dashboard" },
    {
      id: "watchlist",
      label: "Watchlist",
      icon: "watchlist",
      badge: portfolio.watchlist.length,
    },
    { id: "trade", label: "Trade", icon: "positions", badge: null },
    {
      id: "alerts",
      label: "Alerts",
      icon: "alerts",
      badge: activeAlerts || null,
    },
  ];

  return (
    <aside className="sidebar">
      <div className="nav-group-label">Workspace</div>
      {navItems.map((item) => (
        <button
          key={item.id}
          className={`nav-item ${page === item.id ? "active" : ""}`}
          onClick={() => onNavigate(item.id)}
        >
          <Icon name={item.icon} className="nav-icon" size={16} />
          <span>{item.label}</span>
          {item.badge ? <span className="badge">{item.badge}</span> : null}
        </button>
      ))}
      <div className="nav-group-label">Settings</div>
      <button
        className={`nav-item ${page === "account" ? "active" : ""}`}
        onClick={() => onNavigate("account")}
      >
        <Icon name="account" className="nav-icon" size={16} />
        <span>Account</span>
      </button>

      <div
        style={{
          marginTop: "auto",
          padding: "12px 10px",
          fontSize: 11,
          color: "var(--text-dim)",
          lineHeight: 1.5,
        }}
      >
        Paper trading — simulated funds, real market data
        {provider ? ` (${provider})` : ""}.
      </div>
    </aside>
  );
}
