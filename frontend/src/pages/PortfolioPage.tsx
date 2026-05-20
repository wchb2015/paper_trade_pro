import { useEffect, useMemo, useState } from 'react';
import { dayChangePct } from '../lib/quote';
import { fmtMoney, fmtPct } from '../lib/format';
import { PriceChart, type PriceChartPoint } from '../components/PriceChart';
import { PriceCell } from '../components/PriceCell';
import { Sparkline } from '../components/Sparkline';
import { Empty } from '../components/Empty';
import { portfolioClient } from '../lib/portfolioClient';
import type { HistoryRange } from '../../../shared/src';
import type {
  Market,
  PageKey,
  Portfolio,
  TradeCtx,
  Valuation,
} from '../lib/types';

interface PortfolioPageProps {
  market: Market;
  portfolio: Portfolio;
  valuation: Valuation;
  onNavigate: (page: PageKey, ticker?: string) => void;
  setTradeCtx: (ctx: TradeCtx | null) => void;
  /** Open the per-ticker lot drawer (replaces the old "click symbol → Trade page" nav). */
  onOpenLots: (ticker: string) => void;
}

export function PortfolioPage({
  market,
  portfolio,
  valuation,
  onNavigate,
  setTradeCtx,
  onOpenLots,
}: PortfolioPageProps) {
  const { cash, initialCash, positions } = portfolio;
  const totalValue = valuation.equity;
  const totalPct = ((totalValue - initialCash) / initialCash) * 100;
  const dayPct = initialCash ? (valuation.dayPnL / initialCash) * 100 : 0;

  const [range, setRange] = useState<HistoryRange>('1D');
  const [historyPoints, setHistoryPoints] = useState<PriceChartPoint[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);

  type Tab = 'overview' | 'positions';
  const [tab, setTab] = useState<Tab>('overview');

  useEffect(() => {
    let cancelled = false;
    portfolioClient
      .getHistory(range)
      .then((res) => {
        if (cancelled) return;
        setHistoryPoints(res.points.map((pt) => ({ t: pt.t, p: pt.p })));
        setHistoryError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        // CLAUDE.md rule 4/10: never silently swallow.
        // eslint-disable-next-line no-console
        console.error('ERROR PortfolioPage.getHistory failed', { err, range });
        setHistoryError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  // Append a synthetic "now" point so the rightmost edge tracks live equity
  // between server snapshots. Skip if the latest server point is fresh.
  const chartPoints = useMemo<PriceChartPoint[]>(() => {
    if (historyPoints.length === 0) {
      return [{ t: Date.now(), p: totalValue }];
    }
    const last = historyPoints[historyPoints.length - 1];
    if (last && Date.now() - last.t < 5_000) return historyPoints;
    return [...historyPoints, { t: Date.now(), p: totalValue }];
  }, [historyPoints, totalValue]);

  // Range-scoped delta: difference between the rightmost (live) and leftmost
  // points of the chart series. Mirrors what the user sees on the curve.
  const rangeDelta = useMemo(() => {
    if (chartPoints.length < 2) return null;
    const start = chartPoints[0]!.p;
    const end = chartPoints[chartPoints.length - 1]!.p;
    if (!Number.isFinite(start) || start === 0) return null;
    const abs = end - start;
    const pct = (abs / start) * 100;
    return { abs, pct };
  }, [chartPoints]);

  // Rank movers from the user's tracked symbols (watchlist + positions +
  // working orders + alerts). No static catalog any more — the dashboard
  // only ranks things the user actually cares about.
  const topMovers = useMemo(() => {
    const tracked = new Set<string>();
    portfolio.watchlist.forEach((t) => tracked.add(t));
    portfolio.positions.forEach((p) => tracked.add(p.ticker));
    portfolio.orders.forEach((o) => tracked.add(o.ticker));
    portfolio.alerts.forEach((a) => tracked.add(a.ticker));
    return Array.from(tracked)
      .map((ticker) => {
        const m = market[ticker];
        const pct = m ? dayChangePct(m) : null;
        return { ticker, m, pct };
      })
      .filter((s) => s.m && s.pct != null)
      .sort((a, b) => Math.abs(b.pct ?? 0) - Math.abs(a.pct ?? 0))
      .slice(0, 6);
  }, [
    market,
    portfolio.watchlist,
    portfolio.positions,
    portfolio.orders,
    portfolio.alerts,
  ]);

  // Top 5 by absolute unrealized P&L — keeps Overview a summary, not a
  // second copy of the Positions tab.
  const previewPositions = useMemo(() => {
    return positions
      .map((p) => {
        const m = market[p.ticker];
        if (!m) return null;
        const mkt = (p.side === 'long' ? m.price : p.avgPrice) * p.qty;
        const pnl =
          p.side === 'long'
            ? (m.price - p.avgPrice) * p.qty
            : (p.avgPrice - m.price) * p.qty;
        const pnlPct = (pnl / (p.avgPrice * p.qty)) * 100;
        return { p, m, mkt, pnl, pnlPct };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))
      .slice(0, 5);
  }, [positions, market]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Portfolio</h1>
          <div className="page-subtitle">
            Paper trading · Real market data
          </div>
        </div>
      </div>

      <div className="tabs" style={{ marginBottom: 14 }}>
        <button
          className={tab === 'overview' ? 'active' : ''}
          onClick={() => setTab('overview')}
        >
          Overview
        </button>
        <button
          className={tab === 'positions' ? 'active' : ''}
          onClick={() => setTab('positions')}
        >
          Positions ({positions.length})
        </button>
      </div>

      {tab === 'overview' && (
      <>
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
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <h3 className="card-title">Portfolio value</h3>
              {rangeDelta && (
                <div
                  style={{
                    fontSize: 12,
                    color:
                      rangeDelta.abs >= 0 ? 'var(--up)' : 'var(--down)',
                    fontWeight: 500,
                  }}
                >
                  {fmtMoney(rangeDelta.abs, { signed: true })}{' '}
                  <span style={{ opacity: 0.85 }}>
                    ({fmtPct(rangeDelta.pct)})
                  </span>
                </div>
              )}
            </div>
            <div className="segmented">
              {(['1D', '1W', '1M', '3M', 'YTD', 'ALL'] as const).map((r) => (
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
          <div className="card-body">
            <PriceChart
              points={chartPoints}
              height={260}
              xLabelMode={range === '1D' ? 'time' : 'date'}
            />
            {historyError && (
              <div
                style={{
                  color: 'var(--down)',
                  fontSize: 12,
                  padding: '0 18px 12px',
                }}
              >
                Couldn’t load history: {historyError}
              </div>
            )}
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
                onClick={() => onNavigate('trade', t.ticker)}
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
                </div>
                <Sparkline
                  data={t.m!.history.slice(-30)}
                  width={62}
                  height={22}
                />
                <div style={{ textAlign: 'right', minWidth: 82 }}>
                  <div className="mono tnum">${t.m!.price.toFixed(2)}</div>
                  <div
                    className={`chip ${(t.pct ?? 0) >= 0 ? 'up' : 'down'}`}
                    style={{ marginTop: 2 }}
                  >
                    {fmtPct(t.pct ?? 0)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header">
          <h3 className="card-title">
            Top positions
            {positions.length > previewPositions.length && (
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 12,
                  fontWeight: 400,
                  color: 'var(--text-muted)',
                }}
              >
                {previewPositions.length} of {positions.length} · by |P&L|
              </span>
            )}
          </h3>
          {positions.length > previewPositions.length && (
            <button
              className="btn sm ghost"
              onClick={() => setTab('positions')}
            >
              View all →
            </button>
          )}
        </div>
        <div className="card-body p0">
          {positions.length === 0 ? (
            <Empty
              title="No open positions"
              subtitle="Pick a symbol from your watchlist to place your first trade."
            />
          ) : (
            <div className="table-scroll">
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
                {previewPositions.map(({ p, m, mkt, pnl, pnlPct }) => (
                  <tr key={p.id}>
                    <td>
                      <div
                        className="ticker"
                        onClick={() => onOpenLots(p.ticker)}
                        style={{ cursor: 'pointer' }}
                      >
                        {p.ticker}
                      </div>
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
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>
      </div>
      </>
      )}

      {tab === 'positions' && (
        <div className="card">
          {positions.length === 0 ? (
            <Empty
              title="No open positions"
              subtitle="Use the Trade button on any stock to open your first position."
            />
          ) : (
            <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th className="num">Qty</th>
                  <th className="num">Avg Cost</th>
                  <th className="num">Last</th>
                  <th className="num">Market Value</th>
                  <th className="num">Unrealized P&L</th>
                  <th className="num">% Change</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const m = market[p.ticker];
                  if (!m) return null;
                  const mkt = (p.side === 'long' ? m.price : p.avgPrice) * p.qty;
                  const pnl =
                    p.side === 'long'
                      ? (m.price - p.avgPrice) * p.qty
                      : (p.avgPrice - m.price) * p.qty;
                  const pnlPct = (pnl / (p.avgPrice * p.qty)) * 100;
                  return (
                    <tr key={p.id}>
                      <td>
                        <div
                          className="ticker"
                          onClick={() => onOpenLots(p.ticker)}
                          style={{ cursor: 'pointer' }}
                        >
                          {p.ticker}
                        </div>
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
                      <td
                        className="num"
                        style={{ color: pnl >= 0 ? 'var(--up)' : 'var(--down)' }}
                      >
                        {fmtMoney(pnl, { signed: true })}
                      </td>
                      <td className="num">
                        <span className={`chip ${pnlPct >= 0 ? 'up' : 'down'}`}>
                          {fmtPct(pnlPct)}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div
                          style={{
                            display: 'flex',
                            gap: 4,
                            justifyContent: 'flex-end',
                          }}
                        >
                          <button
                            className="btn sm"
                            onClick={() =>
                              setTradeCtx({
                                ticker: p.ticker,
                                side: p.side === 'long' ? 'buy' : 'short',
                              })
                            }
                          >
                            Add
                          </button>
                          <button
                            className="btn sm primary"
                            onClick={() =>
                              setTradeCtx({
                                ticker: p.ticker,
                                side: p.side === 'long' ? 'sell' : 'cover',
                              })
                            }
                          >
                            Close
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          )}
        </div>
      )}

    </div>
  );
}
