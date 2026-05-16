import { Icon } from '../components/Icon';
import { PriceCell } from '../components/PriceCell';
import { Sparkline } from '../components/Sparkline';
import { Empty } from '../components/Empty';
import { fmtPct } from '../lib/format';
import { dayChange, dayChangePct } from '../lib/quote';
import { getStockMeta } from '../lib/seedStocks';
import { useBars } from '../hooks/useBars';
import type {
  Market,
  PageKey,
  Portfolio,
  TradeCtx,
} from '../lib/types';
import type { UnavailableReason } from '../../../shared/src';

interface WatchlistPageProps {
  market: Market;
  unavailable: Record<string, UnavailableReason>;
  portfolio: Portfolio;
  toggleWatch: (ticker: string) => void;
  onNavigate: (page: PageKey, ticker?: string) => void;
  onAdd: () => void;
  setTradeCtx: (ctx: TradeCtx | null) => void;
}

export function WatchlistPage({
  market,
  unavailable,
  portfolio,
  toggleWatch,
  onNavigate,
  onAdd,
  setTradeCtx,
}: WatchlistPageProps) {
  const { watchlist } = portfolio;
  // 1Min intraday bars for the sparkline column. Refreshed every minute by
  // the hook; the backend's 30s bars cache absorbs duplicate calls.
  const intradayBars = useBars(watchlist, '1Min', 400, 60_000);
  // Classify each watchlist ticker. Loading rows (no quote yet, no
  // unavailability info) are skipped — they resolve in the next snapshot
  // call, typically within a few hundred ms.
  type Row =
    | { kind: 'priced'; ticker: string; m: NonNullable<Market[string]> }
    | { kind: 'banner'; ticker: string; reason: UnavailableReason };
  const rows: Row[] = [];
  for (const t of watchlist) {
    const m = market[t];
    if (m) {
      rows.push({ kind: 'priced', ticker: t, m });
      continue;
    }
    const reason = unavailable[t];
    if (reason) rows.push({ kind: 'banner', ticker: t, reason });
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Watchlist</h1>
          <div className="page-subtitle">
            {watchlist.length} symbols tracked · live prices
          </div>
        </div>
        <button className="btn accent" onClick={onAdd}>
          <Icon name="plus" size={14} /> Add symbol
        </button>
      </div>

      <div className="card">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1.3fr 1fr 1fr 0.6fr 0.4fr',
            padding: '10px 16px',
            borderBottom: '1px solid var(--border)',
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: 'var(--text-muted)',
            fontWeight: 500,
            background: 'var(--bg)',
          }}
        >
          <div>Symbol</div>
          <div style={{ textAlign: 'right' }}>Last</div>
          <div style={{ textAlign: 'right' }}>Change</div>
          <div style={{ textAlign: 'center' }}>Today</div>
          <div></div>
        </div>
        {rows.length === 0 && (
          <Empty
            title="Your watchlist is empty"
            subtitle="Click Add symbol to start tracking."
          />
        )}
        {rows.map((row) => {
          if (row.kind === 'banner') {
            const { ticker, reason } = row;
            return (
              <div
                key={ticker}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1.3fr 1fr 1fr 0.6fr 0.4fr',
                  padding: '14px 16px',
                  borderBottom: '1px solid var(--border)',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <div>
                  <div className="ticker">{ticker}</div>
                  <div className="company">
                    {getStockMeta(ticker).name}
                  </div>
                </div>
                <div
                  style={{
                    gridColumn: '2 / 5',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    color: 'var(--text-muted)',
                    fontSize: 12.5,
                  }}
                >
                  <span
                    className="chip"
                    style={{
                      background: 'rgba(245, 158, 11, 0.14)',
                      color: '#f59e0b',
                    }}
                  >
                    No data
                  </span>
                  <span>{reason.message}</span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    gap: 4,
                    justifyContent: 'flex-end',
                  }}
                >
                  <button
                    className="btn sm ghost"
                    onClick={() => toggleWatch(ticker)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            );
          }

          // priced row — unchanged from the previous implementation
          const { ticker, m } = row;
          const pct = dayChangePct(m);
          const change = dayChange(m);
          // Color "Last" by day direction (vs prev close). Null baseline →
          // neutral. Matches the Change column so a row never disagrees
          // with itself (Last green / Change red, etc).
          const dayDir =
            change == null || change === 0 ? null : change > 0 ? 'up' : 'down';
          return (
            <div
              key={ticker}
              style={{
                display: 'grid',
                gridTemplateColumns: '1.3fr 1fr 1fr 0.6fr 0.4fr',
                padding: '14px 16px',
                borderBottom: '1px solid var(--border)',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
              }}
              onClick={() => onNavigate('detail', ticker)}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = 'var(--bg-muted)')
              }
              onMouseLeave={(e) => (e.currentTarget.style.background = '')}
            >
              <div>
                <div className="ticker">{ticker}</div>
                <div className="company">{m.name}</div>
              </div>
              <div
                className={`mono tnum ${dayDir ?? ''}`}
                style={{ textAlign: 'right', fontWeight: 500 }}
              >
                <PriceCell value={m.price} prefix="$" />
              </div>
              <div style={{ textAlign: 'right' }}>
                {change == null || pct == null ? (
                  <div
                    className="mono tnum"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    —
                  </div>
                ) : (
                  <>
                    <div className={`mono tnum ${pct >= 0 ? 'up' : 'down'}`}>
                      {change >= 0 ? '+' : ''}
                      {change.toFixed(2)}
                    </div>
                    <div style={{ fontSize: 11.5, marginTop: 2 }}>
                      <span className={`chip ${pct >= 0 ? 'up' : 'down'}`}>
                        {fmtPct(pct)}
                      </span>
                    </div>
                  </>
                )}
              </div>
              <div
                style={{ display: 'flex', justifyContent: 'center' }}
                onClick={(e) => e.stopPropagation()}
              >
                {(() => {
                  const bars = intradayBars[ticker];
                  // Prefer real intraday bars when we have them. Fall back
                  // to live tick history (no timestamps → no tooltip) until
                  // the first /api/bars response lands.
                  if (bars && bars.length >= 2) {
                    return (
                      <Sparkline
                        points={bars.map((b) => ({ t: b.t, p: b.c }))}
                        width={80}
                        height={24}
                      />
                    );
                  }
                  return (
                    <Sparkline
                      data={m.history.slice(-30)}
                      width={80}
                      height={24}
                    />
                  );
                })()}
              </div>
              <div
                style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="btn sm primary"
                  onClick={() => setTradeCtx({ ticker, side: 'buy' })}
                >
                  Trade
                </button>
                <button
                  className="btn sm ghost icon-only"
                  onClick={() => toggleWatch(ticker)}
                  title="Remove"
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
