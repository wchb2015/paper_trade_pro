import { useMemo, useState } from 'react';
import { Empty } from '../components/Empty';
import { DateRangePicker } from '../components/DateRangePicker';
import { ORDER_TYPES } from '../lib/orderTypes';
import {
  defaultRange,
  formatRangeLabel,
  rangeWindow,
  type DateRangeValue,
} from '../lib/dateRange';
import { fmtLocalTime, fmtMoney, fmtPct } from '../lib/format';
import { replayFifo } from '../lib/pnl';
import type {
  Market,
  Order,
  OrderType,
  PageKey,
  Portfolio,
} from '../lib/types';

interface OrdersPageProps {
  market: Market;
  portfolio: Portfolio;
  cancelOrder: (id: string) => void;
  onNavigate: (page: PageKey, ticker?: string) => void;
}

type Tab = 'working' | 'filled' | 'cancelled';

function orderTimestamp(o: Order, tab: Tab): number {
  if (tab === 'filled') return o.filledAt ?? o.createdAt;
  if (tab === 'cancelled') return o.cancelledAt ?? o.createdAt;
  return o.createdAt;
}

const typeLabel = (t: OrderType) =>
  ORDER_TYPES.find((x) => x.value === t)?.label ?? t;

const triggerCell = (o: Order): string => {
  if (o.type === 'limit') return `Limit $${o.limitPrice?.toFixed(2) ?? '—'}`;
  if (o.type === 'stop') return `Stop $${o.stopPrice?.toFixed(2) ?? '—'}`;
  if (o.type === 'stop_limit')
    return `Stop $${o.stopPrice?.toFixed(2) ?? '—'} / Lim $${o.limitPrice?.toFixed(2) ?? '—'}`;
  if (o.type === 'trailing_stop') return `Trail ${o.trailPct ?? '—'}%`;
  if (o.type === 'conditional' && o.condTrigger)
    return `${o.condTrigger.ticker} ${o.condTrigger.op} $${o.condTrigger.price.toFixed(2)}`;
  return 'Market';
};

export function OrdersPage({
  portfolio,
  cancelOrder,
  onNavigate,
}: OrdersPageProps) {
  const [tab, setTab] = useState<Tab>('filled');
  const [range, setRange] = useState<DateRangeValue>(() => defaultRange('30d'));
  const [symbolFilter, setSymbolFilter] = useState<string>('');

  // Working orders live on portfolio.orders; filled+cancelled live on
  // portfolio.history. Server enforces the split in PortfolioStore.
  const working = useMemo(
    () =>
      portfolio.orders.filter(
        (o) => o.status === 'pending' || o.status === 'pending_fill',
      ),
    [portfolio.orders],
  );
  const filled = useMemo(
    () => portfolio.history.filter((o) => o.status === 'filled'),
    [portfolio.history],
  );
  const cancelled = useMemo(
    () => portfolio.history.filter((o) => o.status === 'cancelled'),
    [portfolio.history],
  );

  // FIFO replay over the entire filled history. Recomputes only when
  // history or current positions change. Result is keyed by order id, so
  // per-row lookup in the table is O(1).
  const fifo = useMemo(
    () => replayFifo(portfolio.history, portfolio.positions),
    [portfolio.history, portfolio.positions],
  );

  // Distinct symbols across all order buckets — feeds the <datalist>.
  const symbolOptions = useMemo(() => {
    const set = new Set<string>();
    [...working, ...filled, ...cancelled].forEach((o) => set.add(o.ticker));
    return Array.from(set).sort();
  }, [working, filled, cancelled]);

  const baseRows: Order[] =
    tab === 'working' ? working : tab === 'filled' ? filled : cancelled;

  // Apply filters. Working tab ignores the time range (an order placed 60
  // days ago is still "working" today; filtering it out would surprise).
  const rows = useMemo(() => {
    const sym = symbolFilter.trim().toUpperCase();
    const win =
      tab === 'working'
        ? { from: 0, to: Number.POSITIVE_INFINITY }
        : rangeWindow(range);
    return baseRows.filter((o) => {
      if (sym && !o.ticker.toUpperCase().includes(sym)) return false;
      const t = orderTimestamp(o, tab);
      if (t < win.from || t > win.to) return false;
      return true;
    });
  }, [baseRows, tab, range, symbolFilter]);

  const tabHasAmber = working.length > 0;

  const activeFilterChips: { label: string; clear: () => void }[] = [];
  if (symbolFilter.trim()) {
    activeFilterChips.push({
      label: `Symbol: ${symbolFilter.trim().toUpperCase()}`,
      clear: () => setSymbolFilter(''),
    });
  }
  if (tab !== 'working' && range.presetId !== 'all') {
    activeFilterChips.push({
      label: `Range: ${formatRangeLabel(range)}`,
      clear: () => setRange(defaultRange('all')),
    });
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Orders</h1>
          <div className="page-subtitle">
            {working.length} working · {filled.length} filled ·{' '}
            {cancelled.length} cancelled
          </div>
        </div>
      </div>

      {/* Filter shelf */}
      <div className="orders-shelf">
        <span className="orders-shelf-label">Range</span>
        <DateRangePicker
          value={range}
          onChange={setRange}
          disabled={tab === 'working'}
          ariaLabel="Order time range"
        />
        <input
          className="input mono"
          placeholder="Symbol… (e.g. AAPL)"
          value={symbolFilter}
          onChange={(e) => setSymbolFilter(e.target.value.toUpperCase())}
          list="orders-symbol-options"
          aria-label="Filter by symbol"
        />
        <datalist id="orders-symbol-options">
          {symbolOptions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </div>

      {/* Active filter chips */}
      <div className="orders-active-filters">
        {activeFilterChips.length === 0 ? (
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            {tab === 'working'
              ? 'Showing all working orders.'
              : `Showing ${formatRangeLabel(range)} window.`}
          </span>
        ) : (
          activeFilterChips.map((c) => (
            <span key={c.label} className="orders-filter-badge">
              {c.label}
              <span className="x" onClick={c.clear} role="button" aria-label={`Clear ${c.label}`}>
                ✕
              </span>
            </span>
          ))
        )}
      </div>

      {/* Tabs */}
      <div className="orders-tabs">
        <button
          className={`orders-tab ${tab === 'working' ? 'active' : ''}`}
          onClick={() => setTab('working')}
        >
          <span className={`orders-tab-dot ${tabHasAmber ? 'amber' : 'gray'}`} />
          Working
          <span className="orders-tab-count">{working.length}</span>
        </button>
        <button
          className={`orders-tab ${tab === 'filled' ? 'active' : ''}`}
          onClick={() => setTab('filled')}
        >
          Filled
          <span className="orders-tab-count">
            {tab === 'filled' ? rows.length : filled.length}
          </span>
        </button>
        <button
          className={`orders-tab ${tab === 'cancelled' ? 'active' : ''}`}
          onClick={() => setTab('cancelled')}
        >
          Cancelled
          <span className="orders-tab-count">
            {tab === 'cancelled' ? rows.length : cancelled.length}
          </span>
        </button>
      </div>

      {/* Table */}
      <div className="card" style={{ borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
        {rows.length === 0 ? (
          <Empty
            title={
              tab === 'working'
                ? 'Nothing pending'
                : tab === 'filled'
                  ? 'No fills in this range'
                  : 'No cancelled orders in this range'
            }
            subtitle={
              tab === 'working'
                ? 'When you place a limit, stop, or conditional order it will wait here.'
                : symbolFilter.trim()
                  ? `Try clearing the "${symbolFilter.trim().toUpperCase()}" filter or widening the time range.`
                  : 'Try widening the time range or switching to All.'
            }
          />
        ) : (
          <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Symbol</th>
                <th>Action</th>
                <th>Type</th>
                <th className="num">Qty</th>
                <th className="num">Trigger</th>
                <th className="num">Fill</th>
                {tab === 'filled' && <th className="num">P&L</th>}
                {tab === 'working' && <th></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td style={{ color: 'var(--text-muted)' }}>
                    {fmtLocalTime(orderTimestamp(o, tab))}
                  </td>
                  <td>
                    <div
                      className="ticker"
                      onClick={() => onNavigate('trade', o.ticker)}
                      style={{ cursor: 'pointer' }}
                    >
                      {o.ticker}
                    </div>
                  </td>
                  <td>
                    <span
                      className={`pill ${
                        o.side === 'buy' || o.side === 'cover' ? 'long' : 'short'
                      }`}
                    >
                      {o.side.toUpperCase()}
                    </span>
                  </td>
                  <td>{typeLabel(o.type)}</td>
                  <td className="num">{o.qty}</td>
                  <td className="num" style={{ fontSize: 12 }}>
                    {triggerCell(o)}
                  </td>
                  <td className="num">
                    {o.fillPrice ? `$${o.fillPrice.toFixed(2)}` : '—'}
                  </td>
                  {tab === 'filled' && (() => {
                    // Buy/short rows open positions, no realized P&L.
                    // Sell/cover rows always have a P&L thanks to FIFO + fallback.
                    if (o.side !== 'sell' && o.side !== 'cover') {
                      return (
                        <td className="num" style={{ color: 'var(--text-muted)' }}>
                          —
                        </td>
                      );
                    }
                    const pnl = fifo.pnlByOrderId.get(o.id);
                    if (!pnl) {
                      return (
                        <td className="num" style={{ color: 'var(--text-muted)' }}>
                          —
                        </td>
                      );
                    }
                    const color =
                      pnl.abs > 0
                        ? 'var(--up)'
                        : pnl.abs < 0
                          ? 'var(--down)'
                          : 'var(--text)';
                    return (
                      <td className="num" style={{ color, fontWeight: 500 }}>
                        {fmtMoney(pnl.abs, { signed: true })}
                        <span style={{ marginLeft: 6, fontSize: 11.5 }}>
                          {fmtPct(pnl.pct)}
                        </span>
                      </td>
                    );
                  })()}
                  {tab === 'working' && (
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="btn sm ghost"
                        onClick={() => cancelOrder(o.id)}
                      >
                        Cancel
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}
