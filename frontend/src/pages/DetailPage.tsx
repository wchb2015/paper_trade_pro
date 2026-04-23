import { useState, type ReactNode } from 'react';
import { Icon } from '../components/Icon';
import { PriceChart } from '../components/PriceChart';
import { Empty } from '../components/Empty';
import { fmtMoney, fmtPct, fmtVol } from '../lib/format';
import { dayChange, dayChangePct, money } from '../lib/quote';
import type {
  AlertCtx,
  Market,
  PageKey,
  Portfolio,
  TradeCtx,
} from '../lib/types';

interface DetailPageProps {
  ticker: string;
  market: Market;
  portfolio: Portfolio;
  toggleWatch: (ticker: string) => void;
  setTradeCtx: (ctx: TradeCtx | null) => void;
  setAlertCtx: (ctx: AlertCtx | null) => void;
  onNavigate: (page: PageKey, ticker?: string) => void;
}

const ranges: Record<string, number> = {
  '1D': 20,
  '1W': 35,
  '1M': 60,
  '3M': 90,
};

export function DetailPage({
  ticker,
  market,
  portfolio,
  toggleWatch,
  setTradeCtx,
  setAlertCtx,
  onNavigate,
}: DetailPageProps) {
  const m = market[ticker];
  const [range, setRange] = useState<keyof typeof ranges>('1M');

  if (!m) {
    return (
      <Empty
        title="Stock not found"
        action={
          <button className="btn" onClick={() => onNavigate('watchlist')}>
            Back to watchlist
          </button>
        }
      />
    );
  }

  const rangeSize = ranges[range] ?? 60;
  const dataSlice = m.history.slice(-rangeSize);
  const pct = dayChangePct(m);
  const change = dayChange(m);

  const inWatch = portfolio.watchlist.includes(ticker);
  const longPos = portfolio.positions.find(
    (p) => p.ticker === ticker && p.side === 'long',
  );
  const shortPos = portfolio.positions.find(
    (p) => p.ticker === ticker && p.side === 'short',
  );

  const stats: [string, ReactNode][] = [
    ['Open', money(m.dayOpen)],
    ['Day High', money(m.dayHigh)],
    ['Day Low', money(m.dayLow)],
    ['Volume', m.volume != null ? fmtVol(m.volume) : '—'],
    ['Bid', money(m.bid)],
    ['Ask', money(m.ask)],
    ['Prev Close', money(m.prevClose)],
    ['Sector', m.sector],
  ];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 6,
        }}
      >
        <button
          className="btn ghost sm"
          onClick={() => onNavigate('watchlist')}
        >
          ← Watchlist
        </button>
        <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
          {m.sector}
        </span>
      </div>
      <div className="page-header">
        <div>
          <div
            style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}
          >
            <h1 className="page-title" style={{ margin: 0 }}>
              {ticker}
            </h1>
            <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>
              {m.name}
            </span>
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
              className="mono tnum"
              style={{
                fontSize: 34,
                fontWeight: 600,
                letterSpacing: '-0.02em',
              }}
            >
              ${m.price.toFixed(2)}
            </div>
            <div>
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
          <button className="btn" onClick={() => toggleWatch(ticker)}>
            <Icon name={inWatch ? 'starFilled' : 'star'} size={14} />
            {inWatch ? 'Watching' : 'Watch'}
          </button>
          <button className="btn" onClick={() => setAlertCtx({ ticker })}>
            <Icon name="alerts" size={14} /> Alert
          </button>
        </div>
      </div>

      <div className="detail-layout">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Price</h3>
              <div className="segmented">
                {Object.keys(ranges).map((r) => (
                  <button
                    key={r}
                    className={range === r ? 'active' : ''}
                    onClick={() => setRange(r as keyof typeof ranges)}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <div className="card-body">
              <PriceChart data={dataSlice} height={320} />
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
                            onClick={() =>
                              setTradeCtx({
                                ticker,
                                side: p.side === 'long' ? 'sell' : 'cover',
                              })
                            }
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

        <OrderPanel
          ticker={ticker}
          market={market}
          portfolio={portfolio}
          setTradeCtx={setTradeCtx}
        />
      </div>
    </div>
  );
}

interface OrderPanelProps {
  ticker: string;
  market: Market;
  portfolio: Portfolio;
  setTradeCtx: (ctx: TradeCtx | null) => void;
}

function OrderPanel({
  ticker,
  market,
  portfolio,
  setTradeCtx,
}: OrderPanelProps) {
  const m = market[ticker];
  if (!m) return null;
  return (
    <div className="card" style={{ position: 'sticky', top: 74 }}>
      <div className="card-header">
        <h3 className="card-title">Place order</h3>
      </div>
      <div className="card-body">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 8,
            marginBottom: 10,
          }}
        >
          <button
            className="btn buy"
            style={{ padding: 12 }}
            onClick={() => setTradeCtx({ ticker, side: 'buy' })}
          >
            Buy / Long
          </button>
          <button
            className="btn sell"
            style={{ padding: 12 }}
            onClick={() => setTradeCtx({ ticker, side: 'sell' })}
          >
            Sell
          </button>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 8,
            marginBottom: 14,
          }}
        >
          <button
            className="btn"
            style={{ padding: 10 }}
            onClick={() => setTradeCtx({ ticker, side: 'short' })}
          >
            Short
          </button>
          <button
            className="btn"
            style={{ padding: 10 }}
            onClick={() => setTradeCtx({ ticker, side: 'cover' })}
          >
            Cover
          </button>
        </div>

        <div
          style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginBottom: 8,
            fontWeight: 500,
          }}
        >
          Quick info
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            fontSize: 12.5,
          }}
        >
          <Row
            label="Bid × Ask"
            val={
              <span className="mono tnum">
                {money(m.bid)} × {money(m.ask)}
              </span>
            }
          />
          <Row
            label="Spread"
            val={
              <span className="mono tnum">
                {m.bid != null && m.ask != null
                  ? `$${(m.ask - m.bid).toFixed(2)}`
                  : '—'}
              </span>
            }
          />
          <Row
            label="Day range"
            val={
              <span className="mono tnum">
                {money(m.dayLow)} – {money(m.dayHigh)}
              </span>
            }
          />
          <Row
            label="Buying power"
            val={<span className="mono tnum">{fmtMoney(portfolio.cash)}</span>}
          />
        </div>
      </div>
    </div>
  );
}

function Row({ label, val }: { label: string; val: ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span>{val}</span>
    </div>
  );
}
