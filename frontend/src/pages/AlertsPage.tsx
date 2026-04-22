import { Icon } from '../components/Icon';
import { Empty } from '../components/Empty';
import { fmtPct, timeAgo } from '../lib/format';
import type { Alert, Market, Portfolio } from '../lib/types';

interface AlertsPageProps {
  market: Market;
  portfolio: Portfolio;
  toggleAlert: (id: string) => void;
  removeAlert: (id: string) => void;
  onAdd: () => void;
}

export function AlertsPage({
  market,
  portfolio,
  toggleAlert,
  removeAlert,
  onAdd,
}: AlertsPageProps) {
  const { alerts } = portfolio;
  const active = alerts.filter((a) => !a.triggeredAt);
  const triggered = alerts.filter((a) => a.triggeredAt);

  const card = (a: Alert) => {
    const m = market[a.ticker];
    const pct = m ? ((m.price - a.price) / a.price) * 100 : 0;
    const distance = m ? Math.abs(m.price - a.price) : 0;
    return (
      <div
        key={a.id}
        style={{
          padding: '14px 18px',
          borderBottom: '1px solid var(--border)',
          display: 'grid',
          gridTemplateColumns: '1fr auto auto auto',
          gap: 14,
          alignItems: 'center',
        }}
      >
        <div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span className="ticker">{a.ticker}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              {a.condition === 'above' ? 'Price above' : 'Price below'}{' '}
              <span
                className="mono tnum"
                style={{ color: 'var(--text)', fontWeight: 500 }}
              >
                ${a.price.toFixed(2)}
              </span>
            </span>
            {a.triggeredAt && (
              <span className="pill triggered">TRIGGERED</span>
            )}
          </div>
          {a.note && (
            <div className="company" style={{ marginTop: 3 }}>
              {a.note}
            </div>
          )}
          {a.triggeredAt && (
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--text-muted)',
                marginTop: 2,
              }}
            >
              Triggered {timeAgo(a.triggeredAt)} at $
              {a.triggeredPrice?.toFixed(2)}
            </div>
          )}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="mono tnum" style={{ fontWeight: 500 }}>
            ${m?.price.toFixed(2)}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            {distance.toFixed(2)} away · {fmtPct(pct, { digits: 1 })}
          </div>
        </div>
        <div
          className={`switch ${a.active && !a.triggeredAt ? 'on' : ''}`}
          onClick={() => !a.triggeredAt && toggleAlert(a.id)}
        />
        <button
          className="btn sm ghost icon-only"
          onClick={() => removeAlert(a.id)}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
    );
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Alerts</h1>
          <div className="page-subtitle">
            {active.length} active · {triggered.length} triggered
          </div>
        </div>
        <button className="btn accent" onClick={onAdd}>
          <Icon name="plus" size={14} /> New alert
        </button>
      </div>
      <div className="card">
        {alerts.length === 0 ? (
          <Empty
            title="No alerts yet"
            subtitle="Create a price alert from any stock's detail page or with the button above."
          />
        ) : (
          <>
            {active.map(card)}
            {triggered.map(card)}
          </>
        )}
      </div>
    </div>
  );
}
