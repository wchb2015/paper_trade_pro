import { useEffect, useMemo, useState } from 'react';
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
import { STOCK_META } from './lib/seedStocks';
import type {
  AlertCtx,
  Market,
  PageKey,
  Theme,
  TradeCtx,
  Tweaks,
} from './lib/types';

const TWEAK_DEFAULTS: Tweaks = {
  accent: '#4f46e5',
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

  // ---- portfolio <-> market wiring ----------------------------------------
  // usePortfolio needs the live Market so placeOrder can fill at ask/bid and
  // the order/alert evaluator can trigger against real prices. But useMarket
  // (below) depends on portfolio state to know which symbols to subscribe to,
  // which would be circular.
  //
  // We break the cycle with a mirrored Market state: usePortfolio consumes
  // `marketView`, useMarket returns the live `market`, and an effect further
  // down copies `market` → `marketView` on every update. One extra render per
  // tick; placeOrder always sees fresh data.
  // -----------------------------------------------------------------------
  const [marketView, setMarketView] = useState<Market>({});
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
  } = usePortfolio(marketView);

  const interestingSymbols = useMemo(() => {
    const set = new Set<string>();
    portfolio.watchlist.forEach((t) => set.add(t));
    portfolio.positions.forEach((p) => set.add(p.ticker));
    portfolio.orders.forEach((o) => set.add(o.ticker));
    portfolio.alerts.forEach((a) => set.add(a.ticker));
    if (page === 'detail' && detailTicker) set.add(detailTicker);
    if (tradeCtx?.ticker) set.add(tradeCtx.ticker);
    if (alertCtx?.ticker) set.add(alertCtx.ticker);
    // Include the static catalog so the Add modal can search + display prices.
    STOCK_META.forEach((m) => set.add(m.ticker));
    return Array.from(set).map((s) => s.toUpperCase());
  }, [
    portfolio.watchlist,
    portfolio.positions,
    portfolio.orders,
    portfolio.alerts,
    page,
    detailTicker,
    tradeCtx?.ticker,
    alertCtx?.ticker,
  ]);

  const { market, liveConnected, providerStatus, provider, error } =
    useMarket(interestingSymbols);

  // Mirror the live market into `marketView` so usePortfolio sees fresh data.
  // This is the second half of the cycle-break described above.
  useEffect(() => {
    setMarketView(market);
  }, [market]);

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

  // Reconcile valuation using the live market.
  const liveValuation = useMemo(() => {
    let marketValue = 0;
    let unrealizedPnL = 0;
    portfolio.positions.forEach((p) => {
      const m = market[p.ticker];
      if (!m) return;
      if (p.side === 'long') {
        marketValue += m.price * p.qty;
        unrealizedPnL += (m.price - p.avgPrice) * p.qty;
      } else {
        marketValue += p.avgPrice * p.qty;
        unrealizedPnL += (p.avgPrice - m.price) * p.qty;
      }
    });
    const shortDiff = portfolio.positions
      .filter((p) => p.side === 'short')
      .reduce((s, p) => {
        const m = market[p.ticker];
        if (!m) return s;
        return s + (p.avgPrice - m.price) * p.qty;
      }, 0);
    const equity = portfolio.cash + marketValue + shortDiff;
    const totalPnL = equity - portfolio.initialCash;
    return {
      marketValue,
      unrealizedPnL,
      equity,
      totalPnL,
      dayPnL: unrealizedPnL,
    };
  }, [market, portfolio.positions, portfolio.cash, portfolio.initialCash]);

  // Prefer the live valuation (reflects real market) over the empty-market
  // fallback returned by usePortfolio.
  const effectiveValuation = liveValuation.marketValue > 0 || portfolio.positions.length === 0
    ? liveValuation
    : valuation;

  const totalValue = effectiveValuation.equity;
  const totalPct =
    portfolio.initialCash === 0
      ? 0
      : ((totalValue - portfolio.initialCash) / portfolio.initialCash) * 100;

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
            valuation={effectiveValuation}
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
            valuation={effectiveValuation}
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
            valuation={effectiveValuation}
            resetFunds={resetFunds}
          />
        );
      default:
        return null;
    }
  };

  // Status pill derivation — single place to compute what the top-right
  // indicator should show.
  const statusPill = (() => {
    if (!liveConnected) {
      return {
        label: 'Offline',
        dot: 'var(--down)',
        title: 'Backend socket disconnected',
      } as const;
    }
    if (providerStatus === 'live') {
      return {
        label: `Live · ${provider || 'provider'}`,
        dot: 'var(--up)',
        title: `${provider} stream connected`,
      } as const;
    }
    if (providerStatus === 'stale') {
      return {
        label: 'Stale',
        dot: '#f59e0b',
        title: 'No recent ticks — market may be closed',
      } as const;
    }
    return {
      label: 'Unavailable',
      dot: 'var(--down)',
      title: error ?? 'Provider unavailable',
    } as const;
  })();

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
          <span
            className="btn ghost sm"
            title={statusPill.title}
            style={{ cursor: 'default' }}
          >
            {statusPill.label}
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 7,
                background: statusPill.dot,
                boxShadow:
                  providerStatus === 'live'
                    ? '0 0 0 3px rgba(5,150,105,0.18)'
                    : 'none',
                marginLeft: 2,
                animation:
                  providerStatus === 'live' ? 'pulse 1.6s infinite' : 'none',
              }}
            />
          </span>
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
          Paper trading — simulated funds, real market data
          {provider ? ` (${provider})` : ''}.
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
