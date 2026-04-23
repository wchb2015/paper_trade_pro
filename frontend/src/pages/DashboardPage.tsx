import { useMemo } from 'react';
import { STOCK_META } from '../lib/seedStocks';
import { dayChangePct } from '../lib/quote';
import { fmtMoney, fmtPct } from '../lib/format';
import { PriceChart } from '../components/PriceChart';
import { PriceCell } from '../components/PriceCell';
import { Sparkline } from '../components/Sparkline';
import { Empty } from '../components/Empty';
import type {
  Market,
  PageKey,
  Portfolio,
  TradeCtx,
  Valuation,
} from '../lib/types';

interface DashboardPageProps {
  market: Market;
  portfolio: Portfolio;
  valuation: Valuation;
  onNavigate: (page: PageKey, ticker?: string) => void;
  setTradeCtx: (ctx: TradeCtx | null) => void;
}

export function DashboardPage({
  market,
  portfolio,
  valuation,
  onNavigate,
  setTradeCtx,
}: DashboardPageProps) {
  const { cash, initialCash, positions } = portfolio;
  const totalValue = valuation.equity;
  const totalPct = ((totalValue - initialCash) / initialCash) * 100;
  const dayPct = initialCash ? (valuation.dayPnL / initialCash) * 100 : 0;

  const equityHist = useMemo(() => {
    const arr = Array.from({ length: 60 }, (_, i) => {
      const t = i / 60;
      return (
        initialCash *
        (1 + (totalPct / 100) * t + Math.sin(i / 6) * 0.003)
      );
    });
    arr[arr.length - 1] = totalValue;
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalValue, initialCash]);

  const topMovers = useMemo(() => {
    return [...STOCK_META]
      .map((s) => {
        const m = market[s.ticker];
        const pct = m ? dayChangePct(m) : 0;
        return { ...s, m, pct };
      })
      .filter((s) => s.m)
      .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
      .slice(0, 6);
  }, [market]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <div className="page-subtitle">
            Paper trading · Real market data
          </div>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat">
          <div className="stat-label">Portfolio Value</div>
          <div className="stat-value">{fmtMoney(totalValue)}</div>
          <div className="stat-delta">
            <span className={`chip ${totalPct >= 0 ? 'up' : 'down'}`}>
              {fmtPct(totalPct)}
            </span>{' '}
            <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>
              all-time
            </span>
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Cash</div>
          <div className="stat-value">{fmtMoney(cash)}</div>
          <div className="stat-delta" style={{ color: 'var(--text-muted)' }}>
            {((cash / totalValue) * 100).toFixed(1)}% of portfolio
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Day P&L</div>
          <div
            className="stat-value"
            style={{
              color: valuation.dayPnL >= 0 ? 'var(--up)' : 'var(--down)',
            }}
          >
            {fmtMoney(valuation.dayPnL, { signed: true })}
          </div>
          <div className="stat-delta">
            <span className={`chip ${dayPct >= 0 ? 'up' : 'down'}`}>
              {fmtPct(dayPct)}
            </span>
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Open Positions</div>
          <div className="stat-value">{positions.length}</div>
          <div className="stat-delta" style={{ color: 'var(--text-muted)' }}>
            {positions.filter((p) => p.side === 'long').length} long ·{' '}
            {positions.filter((p) => p.side === 'short').length} short
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Portfolio value</h3>
            <div className="segmented">
              <button className="active">1M</button>
              <button>3M</button>
              <button>YTD</button>
              <button>ALL</button>
            </div>
          </div>
          <div className="card-body">
            <PriceChart data={equityHist} height={260} />
          </div>
        </div>
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Top movers</h3>
          </div>
          <div className="card-body p0">
            {topMovers.map((t) => (
              <div
                key={t.ticker}
                onClick={() => onNavigate('detail', t.ticker)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto auto',
                  gap: 10,
                  alignItems: 'center',
                  padding: '11px 18px',
                  borderBottom: '1px solid var(--border)',
                  cursor: 'pointer',
                }}
              >
                <div>
                  <div className="ticker">{t.ticker}</div>
                  <div className="company">{t.name}</div>
                </div>
                <Sparkline
                  data={t.m!.history.slice(-30)}
                  width={62}
                  height={22}
                />
                <div style={{ textAlign: 'right', minWidth: 82 }}>
                  <div className="mono tnum">${t.m!.price.toFixed(2)}</div>
                  <div
                    className={`chip ${t.pct >= 0 ? 'up' : 'down'}`}
                    style={{ marginTop: 2 }}
                  >
                    {fmtPct(t.pct)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header">
          <h3 className="card-title">Open positions</h3>
          <button
            className="btn sm ghost"
            onClick={() => onNavigate('positions')}
          >
            View all →
          </button>
        </div>
        <div className="card-body p0">
          {positions.length === 0 ? (
            <Empty
              title="No open positions"
              subtitle="Pick a symbol from your watchlist to place your first trade."
            />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th className="num">Qty</th>
                  <th className="num">Avg Cost</th>
                  <th className="num">Mark</th>
                  <th className="num">Market Value</th>
                  <th className="num">P&L</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const m = market[p.ticker];
                  if (!m) return null;
                  const mkt =
                    (p.side === 'long' ? m.price : p.avgPrice) * p.qty;
                  const pnl =
                    p.side === 'long'
                      ? (m.price - p.avgPrice) * p.qty
                      : (p.avgPrice - m.price) * p.qty;
                  const pnlPct = (pnl / (p.avgPrice * p.qty)) * 100;
                  return (
                    <tr key={p.id}>
                      <td>
                        <div className="ticker">{p.ticker}</div>
                        <div className="company">{m.name}</div>
                      </td>
                      <td>
                        <span className={`pill ${p.side}`}>
                          {p.side.toUpperCase()}
                        </span>
                      </td>
                      <td className="num">{p.qty}</td>
                      <td className="num">${p.avgPrice.toFixed(2)}</td>
                      <td className="num">
                        <PriceCell value={m.price} prefix="$" />
                      </td>
                      <td className="num">${mkt.toFixed(2)}</td>
                      <td className="num">
                        <div
                          style={{
                            color: pnl >= 0 ? 'var(--up)' : 'var(--down)',
                            fontWeight: 500,
                          }}
                        >
                          {fmtMoney(pnl, { signed: true })}
                        </div>
                        <div
                          style={{ fontSize: 11, color: 'var(--text-muted)' }}
                        >
                          {fmtPct(pnlPct)}
                        </div>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className="btn sm"
                          onClick={() =>
                            setTradeCtx({
                              ticker: p.ticker,
                              side: p.side === 'long' ? 'sell' : 'cover',
                            })
                          }
                        >
                          Close
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
