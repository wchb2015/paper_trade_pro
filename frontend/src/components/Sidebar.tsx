import { Icon, type IconName } from "./Icon";
import type { PageKey, Portfolio } from "../lib/types";

interface SidebarProps {
  page: PageKey;
  onNavigate: (p: PageKey, ticker?: string) => void;
  portfolio: Portfolio;
  activeAlerts: number;
  unreadTriggered: number;
  provider: string;
  /** When true, the drawer is shown over the page (only matters <640px). */
  open: boolean;
  /** Closes the drawer; called on backdrop click and on nav. */
  onClose: () => void;
}

export function Sidebar({
  page,
  onNavigate,
  portfolio,
  activeAlerts,
  unreadTriggered,
  provider,
  open,
  onClose,
}: SidebarProps) {
  const navItems: {
    id: PageKey;
    label: string;
    icon: IconName;
    badge?: number | null;
    dot?: boolean;
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
      id: "orders",
      label: "Orders",
      icon: "orders",
      badge: portfolio.orders.filter(
        (o) => o.status === "pending" || o.status === "pending_fill",
      ).length || null,
    },
    {
      id: "alerts",
      label: "Alerts",
      icon: "alerts",
      badge: activeAlerts || null,
      dot: unreadTriggered > 0,
    },
  ];

  return (
    <>
      {open && <div className="sidebar-backdrop" onClick={onClose} />}
      <aside className={`sidebar${open ? " open" : ""}`}>
        <div className="nav-group-label">Workspace</div>
        {navItems.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${page === item.id ? "active" : ""}`}
            onClick={() => {
              onClose();
              onNavigate(item.id);
            }}
          >
            <Icon name={item.icon} className="nav-icon" size={16} />
            <span>{item.label}</span>
            {item.badge ? <span className="badge">{item.badge}</span> : null}
            {item.dot ? (
              <span
                aria-label={`${unreadTriggered} unread triggered alerts`}
                style={{
                  marginLeft: 6,
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: 'var(--down)',
                  display: 'inline-block',
                }}
              />
            ) : null}
          </button>
        ))}
        <div className="nav-group-label">Settings</div>
        <button
          className={`nav-item ${page === "account" ? "active" : ""}`}
          onClick={() => {
            onClose();
            onNavigate("account");
          }}
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
    </>
  );
}
