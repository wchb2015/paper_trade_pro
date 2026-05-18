import { useState, type ReactNode } from 'react';
import { toast } from 'react-hot-toast';
import { Icon } from '../components/Icon';
import { PriceChart } from '../components/PriceChart';
import { Empty } from '../components/Empty';
import { fmtMoney, fmtPct } from '../lib/format';
import { dayChange, dayChangePct, money } from '../lib/quote';
import { useBars } from '../hooks/useBars';
import { priceClient } from '../lib/priceClient';
import type { AlpacaFeed, BarTimeframe } from '../../../shared/src';
import type {
  AlertCtx,
  Market,
  PageKey,
  Portfolio,
  TradeCtx,
} from '../lib/types';

interface TradePageProps {
  ticker: string;
  market: Market;
  portfolio: Portfolio;
  toggleWatch: (ticker: string) => void;
  setTradeCtx: (ctx: TradeCtx | null) => void;
  setAlertCtx: (ctx: AlertCtx | null) => void;
  onNavigate: (page: PageKey, ticker?: string) => void;
  /** Currently active live WS feed reported by the server. */
  liveFeed: AlpacaFeed | null;
}

type RangeKey = '1D' | '1W' | '1M' | '3M';

// Each visible range maps to the bar resolution + how many bars to request.
// 1D uses 1Min bars (~390 trading minutes); the longer ranges roll up to 1Day
// candles where one bar = one trading day. The backend caches /api/bars per
// (symbol, timeframe, limit) so polling here is cheap.
const rangeConfig: Record<
  RangeKey,
  { timeframe: BarTimeframe; limit: number; xLabel: 'date' | 'time' }
> = {
  '1D': { timeframe: '1Min', limit: 390, xLabel: 'time' },
  '1W': { timeframe: '1Day', limit: 5, xLabel: 'date' },
  '1M': { timeframe: '1Day', limit: 22, xLabel: 'date' },
  '3M': { timeframe: '1Day', limit: 66, xLabel: 'date' },
};

export function TradePage({
  ticker,
  market,
  portfolio,
  toggleWatch,
  setTradeCtx,
  setAlertCtx,
  onNavigate,
  liveFeed,
}: TradePageProps) {
  const m = market[ticker];
  const [range, setRange] = useState<RangeKey>('1M');
  // 1D extended-hours mode. 'rth' = filter to 09:30–16:00 ET (default);
  // 'iex' = full IEX-feed payload, ~08:00–17:00 ET; 'sip' = paid SIP feed,
  // full 04:00–20:00 ET. Picking 'iex' or 'sip' also POSTs /api/live-feed
  // so the live WS tick stream stays coherent with the bars on screen.
  const [extMode, setExtMode] = useState<'rth' | 'iex' | 'sip'>('rth');
  // Pending while a feed-switch network request is in flight. Disables the
  // segmented control so users can't queue overlapping switches that race.
  const [feedSwitching, setFeedSwitching] = useState(false);

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
        // Snap the segmented control to whatever feed the server actually
        // landed on so the UI doesn't lie. Historical bars on screen will
        // re-fetch on the next 60s tick (or right now via the dep change).
        setExtMode(result.feed);
      }
    } catch (err) {
      // Network/5xx — api() already toasted with a ref id. Revert the UI
      // optimism so the user can retry; preserve the prior mode by reading
      // the actual server feed.
      console.error('ERROR setLiveFeed failed', err);
      setExtMode(liveFeed ?? 'rth');
    } finally {
      setFeedSwitching(false);
    }
  };
  const cfg = rangeConfig[range];
  // Only pass `feed` to the backend when the user has explicitly chosen one.
  // 'rth' uses the server's default feed (env-configured) and we filter to
  // regular trading hours client-side.
  const requestedFeed: AlpacaFeed | undefined =
    range === '1D' && extMode !== 'rth' ? extMode : undefined;
  // Pull historical OHLC for the selected range. useBars polls every minute
  // so the latest candle keeps refreshing; backend caches per
  // (sym, tf, limit, feed) so this is cheap. Single-symbol fetch -> result
  // keyed by ticker.
  const barsBySymbol = useBars(
    [ticker],
    cfg.timeframe,
    cfg.limit,
    60_000,
    requestedFeed,
  );
  const rawBars = barsBySymbol[ticker] ?? [];
  const bars =
    range === '1D' && extMode === 'rth' ? filterRegularHours(rawBars) : rawBars;
  // First-bar-open -> last-bar-close % across the visible window. Drives
  // the colored chip next to the range buttons for 1W/1M/3M.
  const rangeChange =
    bars.length >= 2
      ? {
          abs: bars[bars.length - 1].c - bars[0].o,
          pct: ((bars[bars.length - 1].c - bars[0].o) / bars[0].o) * 100,
        }
      : null;

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

  const chartPoints = bars.map((b) => ({ t: b.t, p: b.c }));
  const pct = dayChangePct(m);
  const change = dayChange(m);
  // Color the big price + change row by day direction (vs prev close).
  const dayDir =
    change == null || change === 0 ? null : change > 0 ? 'up' : 'down';

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
    ['Bid', money(m.bid)],
    ['Ask', money(m.ask)],
    ['Prev Close', money(m.prevClose)],
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
      </div>
      <div className="page-header">
        <div>
          <div
            style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}
          >
            <h1 className="page-title" style={{ margin: 0 }}>
              {ticker}
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
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 10 }}
              >
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
