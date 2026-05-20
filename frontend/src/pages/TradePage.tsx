import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'react-hot-toast';
import { Icon } from '../components/Icon';
import { PriceChart } from '../components/PriceChart';
import { Empty } from '../components/Empty';
import { TradeForm } from '../components/TradeForm';
import { LotSellPanel } from '../components/LotSellPanel';
import { fmtLocalTime, fmtMoney, fmtPct } from '../lib/format';
import { dayChange, dayChangePct, money } from '../lib/quote';
import { getLotRows, type LotRow } from '../lib/lotView';
import { useBars } from '../hooks/useBars';
import { priceClient } from '../lib/priceClient';
import type { PlaceOrderInput } from '../hooks/usePortfolio';
import type { AlpacaFeed, BarTimeframe } from '../../../shared/src';
import type {
  AlertCtx,
  Market,
  OrderSide,
  PageKey,
  Portfolio,
} from '../lib/types';

interface TradePageProps {
  ticker: string;
  market: Market;
  portfolio: Portfolio;
  toggleWatch: (ticker: string) => void;
  placeOrder: (order: PlaceOrderInput) => void;
  setAlertCtx: (ctx: AlertCtx | null) => void;
  cancelOrder: (id: string) => void;
  removeAlert: (id: string) => void;
  onNavigate: (page: PageKey, ticker?: string) => void;
  /** Currently active live WS feed reported by the server. */
  liveFeed: AlpacaFeed | null;
}

type RangeKey = '1D' | '1W' | '1M' | '3M';

// Each visible range maps to the bar resolution + how many bars to request.
const rangeConfig: Record<
  RangeKey,
  { timeframe: BarTimeframe; limit: number; xLabel: 'date' | 'time' }
> = {
  '1D': { timeframe: '1Min', limit: 390, xLabel: 'time' },
  '1W': { timeframe: '1Day', limit: 5, xLabel: 'date' },
  '1M': { timeframe: '1Day', limit: 22, xLabel: 'date' },
  '3M': { timeframe: '1Day', limit: 66, xLabel: 'date' },
};

const TICKER_RE = /^[A-Z][A-Z0-9.]{0,7}$/;
const RECENT_KEY = 'paperTradePro.recentSymbols';

export function TradePage({
  ticker,
  market,
  portfolio,
  toggleWatch,
  placeOrder,
  setAlertCtx,
  cancelOrder,
  removeAlert,
  onNavigate,
  liveFeed,
}: TradePageProps) {
  // Lifted side state — lets the position-card "Close" button preset the
  // inline TradeForm to sell/cover instead of spawning a separate modal.
  const [formSide, setFormSide] = useState<OrderSide>('buy');
  const [tradeMode, setTradeMode] = useState<'quick' | 'byLot'>('quick');
  // Mirror the prop-driven ticker into local state so the rail can switch
  // symbol without leaving the page. Also reflect the change up to App via
  // onNavigate so persisted state survives reloads.
  const [activeTicker, setActiveTicker] = useState(ticker);
  // Sync local state when the App-level prop changes (e.g. user clicks a
  // watchlist symbol from another page). The lint rule against setState in
  // an effect targets cascading-render footguns; here we are explicitly
  // syncing one external authority into local state, which is the pattern
  // the rule's docs suggest as the legitimate exception.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveTicker(ticker);
    setTradeMode('quick');
  }, [ticker]);

  const [range, setRange] = useState<RangeKey>('1D');
  const [extMode, setExtMode] = useState<'rth' | 'iex' | 'sip'>('rth');
  const [feedSwitching, setFeedSwitching] = useState(false);

  const [search, setSearch] = useState('');
  const [searchError, setSearchError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch (err) {
      console.error('ERROR load recent symbols', err);
      return [];
    }
  });

  const switchTo = (sym: string) => {
    setActiveTicker(sym);
    setTradeMode('quick');
    onNavigate('trade', sym);
    setRecent((prev) => {
      const next = [sym, ...prev.filter((t) => t !== sym)].slice(0, 5);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch (err) {
        console.error('ERROR persist recent symbols', err);
      }
      return next;
    });
  };

  const submitSearch = () => {
    const sym = search.trim().toUpperCase();
    if (!sym) return;
    if (!TICKER_RE.test(sym)) {
      setSearchError('Letters/digits/dot, max 8 chars (e.g. AAPL, BRK.B).');
      return;
    }
    setSearchError(null);
    setSearch('');
    switchTo(sym);
  };

  const onPickExtMode = async (next: 'rth' | 'iex' | 'sip') => {
    if (next === 'rth') {
      setExtMode('rth');
      return;
    }
    setFeedSwitching(true);
    setExtMode(next);
    try {
      const result = await priceClient.setLiveFeed(next);
      if (result.fellBack) {
        toast(
          `Live feed: ${next.toUpperCase()} unavailable on this account` +
            (result.reason ? ` (${result.reason})` : '') +
            ` — using ${result.feed.toUpperCase()}`,
          { icon: 'ℹ️', duration: 6000 },
        );
        setExtMode(result.feed);
      }
    } catch (err) {
      console.error('ERROR setLiveFeed failed', err);
      setExtMode(liveFeed ?? 'rth');
    } finally {
      setFeedSwitching(false);
    }
  };

  const renderRail = () => (
    <aside className="trade-rail">
      <input
        className="input mono"
        placeholder="Search ticker"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value.toUpperCase());
          if (searchError) setSearchError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submitSearch();
        }}
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
      />
      {searchError && <div className="trade-rail-error">{searchError}</div>}

      <div className="trade-rail-section-label">Watchlist</div>
      {portfolio.watchlist.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '0 8px' }}>
          No symbols yet
        </div>
      ) : (
        portfolio.watchlist.map((t) => (
          <div
            key={t}
            className={`trade-rail-row ${t === activeTicker ? 'active' : ''}`}
            onClick={() => switchTo(t)}
          >
            {t}
          </div>
        ))
      )}

      {recent.length > 0 && (
        <>
          <div className="trade-rail-section-label">Recent</div>
          {recent.map((t) => (
            <div
              key={t}
              className={`trade-rail-row ${t === activeTicker ? 'active' : ''}`}
              onClick={() => switchTo(t)}
            >
              {t}
            </div>
          ))}
        </>
      )}
    </aside>
  );

  const cfg = rangeConfig[range];
  const requestedFeed: AlpacaFeed | undefined =
    range === '1D' && extMode !== 'rth' ? extMode : undefined;
  const barsBySymbol = useBars(
    [activeTicker],
    cfg.timeframe,
    cfg.limit,
    60_000,
    requestedFeed,
  );
  const rawBars = barsBySymbol[activeTicker] ?? [];
  const bars =
    range === '1D' && extMode === 'rth' ? filterRegularHours(rawBars) : rawBars;
  const rangeChange =
    bars.length >= 2
      ? {
          abs: bars[bars.length - 1].c - bars[0].o,
          pct: ((bars[bars.length - 1].c - bars[0].o) / bars[0].o) * 100,
        }
      : null;

  const m = market[activeTicker];

  // Lot rows for the "By lot" tab. Memoized on history/positions/markPrice so
  // it only recomputes when something the panel actually displays changes.
  // Hook must run before the !m early-return; we read price defensively.
  const markPrice = m?.price ?? 0;
  const lotRowsResult = useMemo(
    () => getLotRows(portfolio, activeTicker, market),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTicker, portfolio.history, portfolio.positions, markPrice],
  );

  if (!m) {
    return (
      <div className="trade-shell">
        {renderRail()}
        <div>
          <Empty
            title={`No quote for ${activeTicker}`}
            subtitle="Try a different symbol or check the data provider status."
          />
        </div>
      </div>
    );
  }

  const chartPoints = bars.map((b) => ({ t: b.t, p: b.c }));
  const pct = dayChangePct(m);
  const change = dayChange(m);
  const dayDir =
    change == null || change === 0 ? null : change > 0 ? 'up' : 'down';

  const inWatch = portfolio.watchlist.includes(activeTicker);
  const longPos = portfolio.positions.find(
    (p) => p.ticker === activeTicker && p.side === 'long',
  );
  const shortPos = portfolio.positions.find(
    (p) => p.ticker === activeTicker && p.side === 'short',
  );

  const stats: [string, ReactNode][] = [
    ['Open', money(m.dayOpen)],
    ['Day High', money(m.dayHigh)],
    ['Day Low', money(m.dayLow)],
    ['Bid', money(m.bid)],
    ['Ask', money(m.ask)],
    ['Prev Close', money(m.prevClose)],
  ];

  const symbolOrders = portfolio.orders.filter(
    (o) =>
      o.ticker === activeTicker &&
      (o.status === 'pending' || o.status === 'pending_fill'),
  );
  const symbolAlerts = portfolio.alerts.filter(
    (a) => a.ticker === activeTicker && !a.triggeredAt,
  );

  return (
    <div className="trade-shell">
      {renderRail()}

      <div>
        <div className="page-header">
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
              <h1 className="page-title" style={{ margin: 0 }}>
                {activeTicker}
              </h1>
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 14,
                marginTop: 10,
              }}
            >
              <div
                className={`mono tnum ${dayDir ?? ''}`}
                style={{
                  fontSize: 34,
                  fontWeight: 600,
                  letterSpacing: '-0.02em',
                }}
              >
                ${m.price.toFixed(2)}
              </div>
              <div>
                {change == null || pct == null ? (
                  <div
                    className="mono tnum"
                    style={{
                      fontSize: 15,
                      fontWeight: 500,
                      color: 'var(--text-muted)',
                    }}
                  >
                    —
                  </div>
                ) : (
                  <div
                    className={`mono tnum ${pct >= 0 ? 'up' : 'down'}`}
                    style={{ fontSize: 15, fontWeight: 500 }}
                  >
                    {change >= 0 ? '+' : ''}
                    {change.toFixed(2)}{' '}
                    <span className={`chip ${pct >= 0 ? 'up' : 'down'}`}>
                      {fmtPct(pct)}
                    </span>
                  </div>
                )}
                <div
                  style={{
                    fontSize: 11.5,
                    color: 'var(--text-muted)',
                    marginTop: 2,
                  }}
                >
                  Today
                </div>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => toggleWatch(activeTicker)}>
              <Icon name={inWatch ? 'starFilled' : 'star'} size={14} />
              {inWatch ? 'Watching' : 'Watch'}
            </button>
            <button className="btn" onClick={() => setAlertCtx({ ticker: activeTicker })}>
              <Icon name="alerts" size={14} /> Alert
            </button>
          </div>
        </div>

        <div className="detail-layout">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="card">
              <div className="card-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <h3 className="card-title">Price</h3>
                  {range !== '1D' && rangeChange && (
                    <span
                      className={`chip ${rangeChange.pct >= 0 ? 'up' : 'down'}`}
                      title={`${range} change: ${rangeChange.abs >= 0 ? '+' : ''}${rangeChange.abs.toFixed(2)}`}
                    >
                      {fmtPct(rangeChange.pct)}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {range === '1D' && (
                    <div
                      className="segmented"
                      title="Switch the data feed: RTH = regular hours only, IEX = free IEX-only feed (~8a-5p ET), SIP = paid consolidated tape (4a-8p ET)"
                    >
                      <button
                        className={extMode === 'rth' ? 'active' : ''}
                        onClick={() => void onPickExtMode('rth')}
                        disabled={feedSwitching}
                      >
                        RTH
                      </button>
                      <button
                        className={extMode === 'iex' ? 'active' : ''}
                        onClick={() => void onPickExtMode('iex')}
                        disabled={feedSwitching}
                      >
                        Ext (IEX)
                      </button>
                      <button
                        className={extMode === 'sip' ? 'active' : ''}
                        onClick={() => void onPickExtMode('sip')}
                        disabled={feedSwitching}
                      >
                        Ext (SIP)
                      </button>
                    </div>
                  )}
                  <div className="segmented">
                    {(Object.keys(rangeConfig) as RangeKey[]).map((r) => (
                      <button
                        key={r}
                        className={range === r ? 'active' : ''}
                        onClick={() => setRange(r)}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="card-body">
                {chartPoints.length >= 2 ? (
                  <PriceChart
                    points={chartPoints}
                    height={320}
                    xLabelMode={cfg.xLabel}
                  />
                ) : (
                  <div
                    style={{
                      height: 320,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--text-muted)',
                      fontSize: 13,
                    }}
                  >
                    {bars.length === 0
                      ? 'Loading historical bars…'
                      : `No ${range} data available for this symbol.`}
                  </div>
                )}
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <h3 className="card-title">Key stats</h3>
              </div>
              <div
                className="card-body"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, 1fr)',
                  gap: 18,
                }}
              >
                {stats.map(([k, v]) => (
                  <div key={k}>
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                      }}
                    >
                      {k}
                    </div>
                    <div
                      className="mono tnum"
                      style={{ marginTop: 4, fontSize: 14, fontWeight: 500 }}
                    >
                      {v}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {(longPos || shortPos) && (
              <div className="card">
                <div className="card-header">
                  <h3 className="card-title">Your position</h3>
                </div>
                <div
                  className="card-body"
                  style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}
                >
                  {[longPos, shortPos]
                    .filter((p): p is NonNullable<typeof p> => Boolean(p))
                    .map((p) => {
                      const pnl =
                        p.side === 'long'
                          ? (m.price - p.avgPrice) * p.qty
                          : (p.avgPrice - m.price) * p.qty;
                      const pnlPct = (pnl / (p.avgPrice * p.qty)) * 100;
                      return (
                        <div
                          key={p.id}
                          style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}
                        >
                          <div>
                            <div
                              style={{
                                fontSize: 11,
                                color: 'var(--text-muted)',
                                textTransform: 'uppercase',
                              }}
                            >
                              Side
                            </div>
                            <div style={{ marginTop: 4 }}>
                              <span className={`pill ${p.side}`}>
                                {p.side.toUpperCase()}
                              </span>
                            </div>
                          </div>
                          <div>
                            <div
                              style={{
                                fontSize: 11,
                                color: 'var(--text-muted)',
                                textTransform: 'uppercase',
                              }}
                            >
                              Quantity
                            </div>
                            <div
                              className="mono tnum"
                              style={{ marginTop: 4, fontWeight: 500 }}
                            >
                              {p.qty}
                            </div>
                          </div>
                          <div>
                            <div
                              style={{
                                fontSize: 11,
                                color: 'var(--text-muted)',
                                textTransform: 'uppercase',
                              }}
                            >
                              Avg Cost
                            </div>
                            <div
                              className="mono tnum"
                              style={{ marginTop: 4, fontWeight: 500 }}
                            >
                              ${p.avgPrice.toFixed(2)}
                            </div>
                          </div>
                          <div>
                            <div
                              style={{
                                fontSize: 11,
                                color: 'var(--text-muted)',
                                textTransform: 'uppercase',
                              }}
                            >
                              Unrealized P&L
                            </div>
                            <div
                              className="mono tnum"
                              style={{
                                marginTop: 4,
                                fontWeight: 500,
                                color: pnl >= 0 ? 'var(--up)' : 'var(--down)',
                              }}
                            >
                              {fmtMoney(pnl, { signed: true })} (
                              {fmtPct(pnlPct)})
                            </div>
                          </div>
                          <div
                            style={{
                              marginLeft: 'auto',
                              display: 'flex',
                              gap: 6,
                            }}
                          >
                            <button
                              className="btn sm"
                              onClick={() => {
                                setFormSide(p.side === 'long' ? 'sell' : 'cover');
                                document
                                  .getElementById('trade-form-card')
                                  ?.scrollIntoView({
                                    behavior: 'smooth',
                                    block: 'start',
                                  });
                              }}
                            >
                              Close
                            </button>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              position: 'sticky',
              top: 74,
            }}
          >
            <div className="card" id="trade-form-card">
              <div className="card-header">
                <h3 className="card-title">Place order</h3>
                <div className="segmented trade-mode-tabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tradeMode === 'quick'}
                    className={tradeMode === 'quick' ? 'active' : ''}
                    onClick={() => setTradeMode('quick')}
                  >
                    Quick trade
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tradeMode === 'byLot'}
                    className={tradeMode === 'byLot' ? 'active' : ''}
                    onClick={() => setTradeMode('byLot')}
                  >
                    By lot
                  </button>
                </div>
              </div>
              <div className="card-body">
                {tradeMode === 'quick' ? (
                  <TradeForm
                    ticker={activeTicker}
                    market={market}
                    portfolio={portfolio}
                    placeOrder={placeOrder}
                    initialSide={formSide}
                    layout="panel"
                  />
                ) : (
                  <ByLotView
                    ticker={activeTicker}
                    market={market}
                    placeOrder={placeOrder}
                    rows={lotRowsResult}
                  />
                )}
              </div>
            </div>
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">Alerts</h3>
                <button
                  className="btn sm accent"
                  onClick={() => setAlertCtx({ ticker: activeTicker })}
                >
                  + New
                </button>
              </div>
              <div className="card-body p0">
                {symbolAlerts.length === 0 ? (
                  <Empty
                    title={`No alerts on ${activeTicker}`}
                    subtitle="Click + New to be notified at a price you choose."
                  />
                ) : (
                  symbolAlerts.map((a) => (
                    <div
                      key={a.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        padding: '10px 18px',
                        borderBottom: '1px solid var(--border)',
                        gap: 14,
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, color: 'var(--text)' }}>
                          {a.condition === 'above' ? 'Above' : 'Below'}{' '}
                          <span
                            className="mono tnum"
                            style={{ fontWeight: 600 }}
                          >
                            ${a.price.toFixed(2)}
                          </span>
                        </div>
                        {a.note && (
                          <div className="company" style={{ marginTop: 2 }}>
                            {a.note}
                          </div>
                        )}
                      </div>
                      <button
                        className="btn sm ghost icon-only"
                        onClick={() => removeAlert(a.id)}
                        title="Delete alert"
                      >
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        {symbolOrders.length > 0 && (
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-header">
              <h3 className="card-title">Working orders for {activeTicker}</h3>
            </div>
            <div className="card-body p0">
              <table className="table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Action</th>
                    <th>Type</th>
                    <th className="num">Qty</th>
                    <th className="num">Trigger</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {symbolOrders.map((o) => (
                    <tr key={o.id}>
                      <td style={{ color: 'var(--text-muted)' }}>
                        {fmtLocalTime(o.createdAt)}
                      </td>
                      <td>
                        <span
                          className={`pill ${
                            o.side === 'buy' || o.side === 'cover'
                              ? 'long'
                              : 'short'
                          }`}
                        >
                          {o.side.toUpperCase()}
                        </span>
                      </td>
                      <td>{o.type}</td>
                      <td className="num">{o.qty}</td>
                      <td className="num" style={{ fontSize: 12 }}>
                        {o.type === 'limit'
                          ? `Limit $${o.limitPrice?.toFixed(2) ?? '—'}`
                          : o.type === 'stop'
                            ? `Stop $${o.stopPrice?.toFixed(2) ?? '—'}`
                            : o.type === 'stop_limit'
                              ? `Stop $${o.stopPrice?.toFixed(2) ?? '—'} / Lim $${o.limitPrice?.toFixed(2) ?? '—'}`
                              : o.type === 'trailing_stop'
                                ? `Trail ${o.trailPct ?? '—'}%`
                                : 'Market'}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className="btn sm ghost"
                          onClick={() => cancelOrder(o.id)}
                        >
                          Cancel
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

// Keep only bars whose timestamp falls inside US regular trading hours
// (09:30–16:00 America/New_York). Uses Intl to read the ET wall-clock so
// DST is handled automatically — no hard-coded UTC offset.
function filterRegularHours<T extends { t: number }>(bars: T[]): T[] {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  return bars.filter((b) => {
    const parts = fmt.formatToParts(new Date(b.t));
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const min = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    const minutesET = h * 60 + min;
    return minutesET >= 9 * 60 + 30 && minutesET < 16 * 60;
  });
}

interface ByLotViewProps {
  ticker: string;
  market: Market;
  placeOrder: (order: PlaceOrderInput) => void;
  rows: {
    long: LotRow[];
    short: LotRow[];
    aggregate: boolean;
    failed: boolean;
  };
}

function ByLotView({ ticker, market, placeOrder, rows }: ByLotViewProps) {
  if (rows.failed) {
    return (
      <div className="lot-warn">
        Lot history unavailable for {ticker}. Use Quick trade to manage this
        position.
      </div>
    );
  }

  if (rows.long.length === 0 && rows.short.length === 0) {
    return (
      <div className="trade-bylot-empty">
        No open shares of {ticker}. Open a position from{' '}
        <span style={{ fontWeight: 600 }}>Quick trade</span> to use lot
        selling.
      </div>
    );
  }

  return (
    <div className="trade-bylot">
      {rows.long.length > 0 && (
        <LotSellPanel
          ticker={ticker}
          side="long"
          rows={rows.long}
          aggregateFallback={rows.long.some((r) => r.aggregateFallback)}
          market={market}
          placeOrder={placeOrder}
        />
      )}
      {rows.short.length > 0 && (
        <LotSellPanel
          ticker={ticker}
          side="short"
          rows={rows.short}
          aggregateFallback={rows.short.some((r) => r.aggregateFallback)}
          market={market}
          placeOrder={placeOrder}
        />
      )}
    </div>
  );
}
