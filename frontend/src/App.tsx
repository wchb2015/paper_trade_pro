import { useEffect, useState } from 'react';
import { Icon, type IconName } from './components/Icon';
import { TradeTicket } from './components/TradeTicket';
import { AddStockModal } from './components/AddStockModal';
import { NewAlertModal } from './components/NewAlertModal';
import { DashboardPage } from './pages/DashboardPage';
import { WatchlistPage } from './pages/WatchlistPage';
import { DetailPage } from './pages/DetailPage';
import { PositionsPage } from './pages/PositionsPage';
import { OrdersPage } from './pages/OrdersPage';
import { AlertsPage } from './pages/AlertsPage';
import { AccountPage } from './pages/AccountPage';
import { useMarket } from './hooks/useMarket';
import { usePortfolio } from './hooks/usePortfolio';
import { fmtMoney, fmtPct } from './lib/format';
import type {
  AlertCtx,
  PageKey,
  Theme,
  TradeCtx,
  Tweaks,
} from './lib/types';

const TWEAK_DEFAULTS: Tweaks = {
  accent: '#4f46e5',
  density: 'comfortable',
  gainColor: '#059669',
  lossColor: '#e11d48',
};

function getStored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : (v as unknown as T);
  } catch {
    return fallback;
  }
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(() =>
    getStored<Theme>('ptp_theme', 'light'),
  );
  const [page, setPage] = useState<PageKey>(() =>
    getStored<PageKey>('ptp_page', 'dashboard'),
  );
  const [detailTicker, setDetailTicker] = useState<string>(() =>
    getStored<string>('ptp_detail', 'AAPL'),
  );
  const [tradeCtx, setTradeCtx] = useState<TradeCtx | null>(null);
  const [alertCtx, setAlertCtx] = useState<AlertCtx | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [tweaks, setTweaks] = useState<Tweaks>(TWEAK_DEFAULTS);

  const { market, paused, setPaused, speed, setSpeed, liveConnected } =
    useMarket();
  const {
    portfolio,
    valuation,
    placeOrder,
    cancelOrder,
    resetFunds,
    toggleWatch,
    addAlert,
    removeAlert,
    toggleAlert,
  } = usePortfolio(market);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('ptp_theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem('ptp_page', page);
    } catch {
      /* ignore */
    }
  }, [page]);

  useEffect(() => {
    try {
      localStorage.setItem('ptp_detail', detailTicker);
    } catch {
      /* ignore */
    }
  }, [detailTicker]);

  // Apply live tweaks
  useEffect(() => {
    const r = document.documentElement.style;
    r.setProperty('--accent', tweaks.accent);
    r.setProperty('--up', tweaks.gainColor);
    r.setProperty('--down', tweaks.lossColor);
  }, [tweaks]);

  const setTweak = <K extends keyof Tweaks>(k: K, v: Tweaks[K]) => {
    setTweaks((prev) => ({ ...prev, [k]: v }));
  };

  const onNavigate = (p: PageKey, ticker?: string) => {
    if (ticker) setDetailTicker(ticker);
    setPage(p);
  };

  const activeAlerts = portfolio.alerts.filter(
    (a) => a.active && !a.triggeredAt,
  ).length;
  const workingOrders = portfolio.orders.filter(
    (o) => o.status === 'pending' || o.status === 'pending_fill',
  ).length;
  const totalValue = valuation.equity;
  const totalPct =
    ((totalValue - portfolio.initialCash) / portfolio.initialCash) * 100;

  const navItems: {
    id: PageKey;
    label: string;
    icon: IconName;
    badge?: number | null;
  }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
    {
      id: 'watchlist',
      label: 'Watchlist',
      icon: 'watchlist',
      badge: portfolio.watchlist.length,
    },
    {
      id: 'positions',
      label: 'Positions',
      icon: 'positions',
      badge: portfolio.positions.length || null,
    },
    {
      id: 'orders',
      label: 'Orders',
      icon: 'orders',
      badge: workingOrders || null,
    },
    {
      id: 'alerts',
      label: 'Alerts',
      icon: 'alerts',
      badge: activeAlerts || null,
    },
  ];

  const renderPage = () => {
    switch (page) {
      case 'dashboard':
        return (
          <DashboardPage
            market={market}
            portfolio={portfolio}
            valuation={valuation}
            onNavigate={onNavigate}
            setTradeCtx={setTradeCtx}
          />
        );
      case 'watchlist':
        return (
          <WatchlistPage
            market={market}
            portfolio={portfolio}
            toggleWatch={toggleWatch}
            onNavigate={onNavigate}
            onAdd={() => setAddOpen(true)}
            setTradeCtx={setTradeCtx}
          />
        );
      case 'detail':
        return (
          <DetailPage
            ticker={detailTicker}
            market={market}
            portfolio={portfolio}
            toggleWatch={toggleWatch}
            setTradeCtx={setTradeCtx}
            setAlertCtx={setAlertCtx}
            onNavigate={onNavigate}
          />
        );
      case 'positions':
        return (
          <PositionsPage
            market={market}
            portfolio={portfolio}
            valuation={valuation}
            setTradeCtx={setTradeCtx}
          />
        );
      case 'orders':
        return (
          <OrdersPage
            market={market}
            portfolio={portfolio}
            cancelOrder={cancelOrder}
          />
        );
      case 'alerts':
        return (
          <AlertsPage
            market={market}
            portfolio={portfolio}
            toggleAlert={toggleAlert}
            removeAlert={removeAlert}
            onAdd={() => setAlertCtx({ ticker: detailTicker || 'AAPL' })}
          />
        );
      case 'account':
        return (
          <AccountPage
            portfolio={portfolio}
            valuation={valuation}
            resetFunds={resetFunds}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="app">
      {/* Top bar */}
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
              className={`ps-value mono tnum ${totalPct >= 0 ? 'up' : 'down'}`}
            >
              {fmtPct(totalPct)}
            </span>
          </div>
          <div className="ps-item">
            <span className="ps-label">Cash</span>
            <span className="ps-value mono tnum">
              {fmtMoney(portfolio.cash, { digits: 0 })}
            </span>
          </div>
        </div>

        <div className="top-actions">
          <button
            className="btn ghost sm"
            onClick={() => setPaused(!paused)}
            title={paused ? 'Resume market feed' : 'Pause market feed'}
          >
            <Icon name={paused ? 'play' : 'pause'} size={13} />
            {paused ? 'Resume' : liveConnected ? 'Live' : 'Sim'}
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 7,
                background: paused ? 'var(--text-dim)' : 'var(--up)',
                boxShadow: paused
                  ? 'none'
                  : '0 0 0 3px rgba(5,150,105,0.18)',
                marginLeft: 2,
                animation: paused ? 'none' : 'pulse 1.6s infinite',
              }}
            />
          </button>
          <button
            className="btn ghost icon-only"
            onClick={() => setTweaksOpen((v) => !v)}
            title="Tweaks"
          >
            <Icon name="settings" size={16} />
          </button>
          <button
            className="btn ghost icon-only"
            onClick={() => onNavigate('account')}
            title="Account"
          >
            <Icon name="account" size={16} />
          </button>
          <button
            className="btn ghost icon-only"
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
            title="Toggle theme"
          >
            <Icon name={theme === 'light' ? 'moon' : 'sun'} size={16} />
          </button>
        </div>
      </div>

      {/* Sidebar */}
      <aside className="sidebar">
        <div className="nav-group-label">Workspace</div>
        {navItems.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${page === item.id ? 'active' : ''}`}
            onClick={() => onNavigate(item.id)}
          >
            <Icon name={item.icon} className="nav-icon" size={16} />
            <span>{item.label}</span>
            {item.badge ? <span className="badge">{item.badge}</span> : null}
          </button>
        ))}
        <div className="nav-group-label">Settings</div>
        <button
          className={`nav-item ${page === 'account' ? 'active' : ''}`}
          onClick={() => onNavigate('account')}
        >
          <Icon name="account" className="nav-icon" size={16} />
          <span>Account</span>
        </button>

        <div
          style={{
            marginTop: 'auto',
            padding: '12px 10px',
            fontSize: 11,
            color: 'var(--text-dim)',
            lineHeight: 1.5,
          }}
        >
          Simulated data for practice only. Not real market prices.
          {liveConnected && (
            <span style={{ color: 'var(--up)' }}>
              <br />● Live feed connected
            </span>
          )}
        </div>
      </aside>

      {/* Main */}
      <main className="main">{renderPage()}</main>

      {/* Modals */}
      {tradeCtx && (
        <TradeTicket
          open={!!tradeCtx}
          onClose={() => setTradeCtx(null)}
          ticker={tradeCtx.ticker}
          initialSide={tradeCtx.side}
          market={market}
          portfolio={portfolio}
          placeOrder={placeOrder}
        />
      )}
      {alertCtx && (
        <NewAlertModal
          open={!!alertCtx}
          onClose={() => setAlertCtx(null)}
          ticker={alertCtx.ticker}
          market={market}
          addAlert={addAlert}
        />
      )}
      {addOpen && (
        <AddStockModal
          open={addOpen}
          onClose={() => setAddOpen(false)}
          market={market}
          onAdd={(t) => toggleWatch(t)}
          existing={portfolio.watchlist}
        />
      )}

      {/* Tweaks panel */}
      {tweaksOpen && (
        <div className="tweaks-panel">
          <div className="tweaks-header">
            <span>Tweaks</span>
            <button
              className="btn ghost icon-only"
              onClick={() => setTweaksOpen(false)}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
          <div className="tweaks-body">
            <div className="tweaks-row">
              <label className="label">Accent color</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {[
                  '#4f46e5',
                  '#0ea5e9',
                  '#f59e0b',
                  '#ec4899',
                  '#14b8a6',
                  '#111111',
                ].map((c) => (
                  <button
                    key={c}
                    onClick={() => setTweak('accent', c)}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      background: c,
                      border:
                        tweaks.accent === c
                          ? '2px solid var(--text)'
                          : '2px solid var(--border)',
                      cursor: 'pointer',
                    }}
                  />
                ))}
              </div>
            </div>
            <div className="tweaks-row">
              <label className="label">Gain / Loss palette</label>
              <div
                className="segmented"
                style={{ display: 'flex', width: '100%' }}
              >
                <button
                  className={tweaks.gainColor === '#059669' ? 'active' : ''}
                  style={{ flex: 1 }}
                  onClick={() => {
                    setTweak('gainColor', '#059669');
                    setTweak('lossColor', '#e11d48');
                  }}
                >
                  Green / Red
                </button>
                <button
                  className={tweaks.gainColor === '#2563eb' ? 'active' : ''}
                  style={{ flex: 1 }}
                  onClick={() => {
                    setTweak('gainColor', '#2563eb');
                    setTweak('lossColor', '#ea580c');
                  }}
                >
                  Blue / Orange
                </button>
              </div>
            </div>
            <div className="tweaks-row">
              <label className="label">Simulation speed</label>
              <div
                className="segmented"
                style={{ display: 'flex', width: '100%' }}
              >
                {[0.5, 1, 2, 4].map((s) => (
                  <button
                    key={s}
                    className={speed === s ? 'active' : ''}
                    style={{ flex: 1 }}
                    onClick={() => setSpeed(s)}
                  >
                    {s}×
                  </button>
                ))}
              </div>
            </div>
            <div className="tweaks-row">
              <label className="label">Theme</label>
              <div
                className="segmented"
                style={{ display: 'flex', width: '100%' }}
              >
                <button
                  className={theme === 'light' ? 'active' : ''}
                  style={{ flex: 1 }}
                  onClick={() => setTheme('light')}
                >
                  Light
                </button>
                <button
                  className={theme === 'dark' ? 'active' : ''}
                  style={{ flex: 1 }}
                  onClick={() => setTheme('dark')}
                >
                  Dark
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
