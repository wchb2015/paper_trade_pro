import { PriceCell } from '../components/PriceCell';
import { Empty } from '../components/Empty';
import { fmtMoney, fmtPct } from '../lib/format';
import type {
  Market,
  Portfolio,
  TradeCtx,
  Valuation,
} from '../lib/types';

interface PositionsPageProps {
  market: Market;
  portfolio: Portfolio;
  valuation: Valuation;
  setTradeCtx: (ctx: TradeCtx | null) => void;
}

export function PositionsPage({
  market,
  portfolio,
  valuation,
  setTradeCtx,
}: PositionsPageProps) {
  const rows = portfolio.positions;
  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Positions</h1>
          <div className="page-subtitle">
            {rows.length} open · {fmtMoney(valuation.marketValue)} market value
          </div>
        </div>
      </div>
      <div className="card">
        {rows.length === 0 ? (
          <Empty
            title="No open positions"
            subtitle="Use the Trade button on any stock to open your first position."
          />
        ) : (
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
              {rows.map((p) => {
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
                    <td
                      className="num"
                      style={{
                        color: pnl >= 0 ? 'var(--up)' : 'var(--down)',
                      }}
                    >
                      {fmtMoney(pnl, { signed: true })}
                    </td>
                    <td className="num">
                      <span
                        className={`chip ${pnlPct >= 0 ? 'up' : 'down'}`}
                      >
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
        )}
      </div>
    </div>
  );
}
