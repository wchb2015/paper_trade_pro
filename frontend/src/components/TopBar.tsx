import { Icon } from "./Icon";
import { fmtMoney, fmtPct } from "../lib/format";
import { GoogleButton } from "../landing/GoogleButton";
import { signOut } from "../lib/auth";
import type { AuthUser, Portfolio, Theme } from "../lib/types";
import type { ReplayClockAnchor } from "../hooks/useMarket";

interface TopBarProps {
  totalValue: number;
  totalPct: number;
  cash: Portfolio["cash"];
  theme: Theme;
  setTheme: (t: Theme) => void;
  onOpenTweaks: () => void;
  liveConnected: boolean;
  provider: string;
  providerStatus: "live" | "stale" | "unavailable";
  error: string | null;
  replayDate: string | null;
  replayClock: ReplayClockAnchor | null;
  replaySimMs: number | null;
  liveFeed: "iex" | "sip" | null;
  user: AuthUser;
  readOnly: boolean;
}

// Single place to compute what the top-right status indicator should show.
function deriveStatusPill(
  liveConnected: boolean,
  provider: string,
  providerStatus: "live" | "stale" | "unavailable",
  error: string | null,
  replayDate: string | null,
  liveFeed: "iex" | "sip" | null,
) {
  if (!liveConnected) {
    return {
      label: "Offline",
      dot: "var(--down)",
      title: "Backend socket disconnected",
    } as const;
  }
  // Replay mode: pill always reflects the replay session, never falls back
  // to "Unavailable" during the boot gap before the watchlist subscribes.
  // Per-symbol "no NDJSON file" cases are surfaced inline on the Watchlist.
  if (provider === "replay") {
    return {
      label: replayDate ? `Replay · ${replayDate}` : "Replay",
      dot: "#3b82f6",
      title: replayDate ? `Replaying ${replayDate} (ET)` : "Replay session",
    } as const;
  }
  if (providerStatus === "live") {
    const feedSuffix = liveFeed ? ` · ${liveFeed.toUpperCase()}` : "";
    return {
      label: `Live · ${provider || "provider"}${feedSuffix}`,
      dot: "var(--up)",
      title: liveFeed
        ? `${provider} stream connected on ${liveFeed.toUpperCase()} feed`
        : `${provider} stream connected`,
    } as const;
  }
  if (providerStatus === "stale") {
    return {
      label: "Stale",
      dot: "#f59e0b",
      title: "No recent ticks — market may be closed",
    } as const;
  }
  return {
    label: "Unavailable",
    dot: "var(--down)",
    title: error ?? "Provider unavailable",
  } as const;
}

export function TopBar({
  totalValue,
  totalPct,
  cash,
  theme,
  setTheme,
  onOpenTweaks,
  liveConnected,
  provider,
  providerStatus,
  error,
  replayDate,
  replayClock,
  replaySimMs,
  liveFeed,
  user,
  readOnly,
}: TopBarProps) {
  const showDemoCta = readOnly || user.isDemo;
  const statusPill = deriveStatusPill(
    liveConnected,
    provider,
    providerStatus,
    error,
    replayDate,
    liveFeed,
  );

  return (
    <div className="topbar">
      <div className="brand">
        <div className="brand-mark">P</div>
        <span className="brand-text">Paper Trade Pro</span>
      </div>

      <div className="portfolio-summary">
        <div className="ps-item">
          <span className="ps-label">Portfolio</span>
          <span className="ps-value mono tnum">{fmtMoney(totalValue)}</span>
        </div>
        <div className="ps-item">
          <span className="ps-label">All-time</span>
          <span
            className={`ps-value mono tnum ${totalPct >= 0 ? "up" : "down"}`}
          >
            {fmtPct(totalPct)}
          </span>
        </div>
        <div className="ps-item">
          <span className="ps-label">Cash</span>
          <span className="ps-value mono tnum">
            {fmtMoney(cash, { digits: 0 })}
          </span>
        </div>
      </div>

      <div className="top-actions">
        <span
          className="btn ghost sm"
          title={statusPill.title}
          style={{ cursor: "default" }}
        >
          {statusPill.label}
          {replaySimMs !== null && (
            <span
              className="mono tnum"
              style={{
                marginLeft: 6,
                paddingLeft: 6,
                borderLeft: "1px solid var(--border)",
                color: "var(--text-muted)",
                fontSize: 11.5,
              }}
              title={`Replay session clock @ ${replayClock?.speed ?? 1}x (America/New_York)`}
            >
              {new Date(replaySimMs).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false,
                timeZone: "America/New_York",
              })}
              {" ET"}
            </span>
          )}
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: 7,
              background: statusPill.dot,
              boxShadow:
                providerStatus === "live"
                  ? "0 0 0 3px rgba(5,150,105,0.18)"
                  : "none",
              marginLeft: 2,
              animation:
                providerStatus === "live" ? "pulse 1.6s infinite" : "none",
            }}
          />
        </span>
        {showDemoCta ? (
          <GoogleButton label="Sign in" />
        ) : (
          <button
            className="btn ghost icon-only"
            onClick={() => void signOut()}
            title={`Sign out (${user.email})`}
            aria-label="Sign out"
          >
            <Icon name="account" size={16} />
          </button>
        )}
        <button
          className="btn ghost icon-only"
          onClick={onOpenTweaks}
          title="Tweaks"
        >
          <Icon name="settings" size={16} />
        </button>
        <button
          className="btn ghost icon-only"
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          title="Toggle theme"
        >
          <Icon name={theme === "light" ? "moon" : "sun"} size={16} />
        </button>
      </div>
    </div>
  );
}
