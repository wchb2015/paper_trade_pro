import { useState } from 'react';
import { Empty } from '../components/Empty';
import { ORDER_TYPES } from '../components/TradeTicket';
import { timeAgo } from '../lib/format';
import type { Market, Order, OrderType, Portfolio } from '../lib/types';

interface OrdersPageProps {
  market: Market;
  portfolio: Portfolio;
  cancelOrder: (id: string) => void;
}

type Tab = 'working' | 'filled' | 'cancelled';

export function OrdersPage({
  portfolio,
  cancelOrder,
}: OrdersPageProps) {
  const [tab, setTab] = useState<Tab>('working');

  const working = portfolio.orders.filter(
    (o) => o.status === 'pending' || o.status === 'pending_fill',
  );
  const done = portfolio.orders.filter(
    (o) => o.status !== 'pending' && o.status !== 'pending_fill',
  );
  const rows: Order[] =
    tab === 'working'
      ? working
      : tab === 'filled'
        ? done.filter((o) => o.status === 'filled')
        : done.filter((o) => o.status === 'cancelled');

  const typeLabel = (t: OrderType) =>
    ORDER_TYPES.find((x) => x.value === t)?.label || t;

  const triggerCell = (o: Order) => {
    if (o.type === 'limit')
      return `Limit $${o.limitPrice?.toFixed(2) ?? '—'}`;
    if (o.type === 'stop') return `Stop $${o.stopPrice?.toFixed(2) ?? '—'}`;
    if (o.type === 'stop_limit')
      return `Stop $${o.stopPrice?.toFixed(2) ?? '—'} / Lim $${o.limitPrice?.toFixed(2) ?? '—'}`;
    if (o.type === 'trailing_stop')
      return `Trail ${o.trailPct ?? '—'}%`;
    if (o.type === 'conditional' && o.condTrigger)
      return `${o.condTrigger.ticker} ${o.condTrigger.op} $${o.condTrigger.price.toFixed(2)}`;
    return 'Market';
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Orders</h1>
          <div className="page-subtitle">
            {working.length} working ·{' '}
            {done.filter((o) => o.status === 'filled').length} filled today
          </div>
        </div>
      </div>
      <div className="tabs">
        <button
          className={tab === 'working' ? 'active' : ''}
          onClick={() => setTab('working')}
        >
          Working ({working.length})
        </button>
        <button
          className={tab === 'filled' ? 'active' : ''}
          onClick={() => setTab('filled')}
        >
          Filled ({done.filter((o) => o.status === 'filled').length})
        </button>
        <button
          className={tab === 'cancelled' ? 'active' : ''}
          onClick={() => setTab('cancelled')}
        >
          Cancelled ({done.filter((o) => o.status === 'cancelled').length})
        </button>
      </div>
      <div className="card">
        {rows.length === 0 ? (
          <Empty
            title="No orders here"
            subtitle="Orders you place will appear in this list."
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Symbol</th>
                <th>Action</th>
                <th>Type</th>
                <th className="num">Qty</th>
                <th className="num">Trigger</th>
                <th className="num">Fill Price</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td style={{ color: 'var(--text-muted)' }}>
                    {timeAgo(o.createdAt)}
                  </td>
                  <td>
                    <div className="ticker">{o.ticker}</div>
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
                  <td>{typeLabel(o.type)}</td>
                  <td className="num">{o.qty}</td>
                  <td className="num" style={{ fontSize: 12 }}>
                    {triggerCell(o)}
                  </td>
                  <td className="num">
                    {o.fillPrice ? `$${o.fillPrice.toFixed(2)}` : '—'}
                  </td>
                  <td>
                    <span
                      className={`pill ${
                        o.status === 'filled'
                          ? 'filled'
                          : o.status === 'cancelled'
                            ? ''
                            : 'pending'
                      }`}
                    >
                      {o.status === 'pending_fill'
                        ? 'PENDING'
                        : o.status.toUpperCase()}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {(o.status === 'pending' ||
                      o.status === 'pending_fill') && (
                      <button
                        className="btn sm ghost"
                        onClick={() => cancelOrder(o.id)}
                      >
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
