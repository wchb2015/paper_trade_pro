import { Icon } from '../components/Icon';
import { PriceCell } from '../components/PriceCell';
import { Sparkline } from '../components/Sparkline';
import { Empty } from '../components/Empty';
import { fmtPct, fmtVol } from '../lib/format';
import type {
  Market,
  PageKey,
  Portfolio,
  TradeCtx,
} from '../lib/types';

interface WatchlistPageProps {
  market: Market;
  portfolio: Portfolio;
  toggleWatch: (ticker: string) => void;
  onNavigate: (page: PageKey, ticker?: string) => void;
  onAdd: () => void;
  setTradeCtx: (ctx: TradeCtx | null) => void;
}

export function WatchlistPage({
  market,
  portfolio,
  toggleWatch,
  onNavigate,
  onAdd,
  setTradeCtx,
}: WatchlistPageProps) {
  const { watchlist } = portfolio;
  const rows = watchlist
    .map((t) => ({ ticker: t, m: market[t] }))
    .filter((r) => r.m);

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
            gridTemplateColumns: '1.3fr 1fr 1fr 0.8fr 0.6fr 0.4fr',
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
          <div style={{ textAlign: 'right' }}>Volume</div>
          <div style={{ textAlign: 'center' }}>30D</div>
          <div></div>
        </div>
        {rows.length === 0 && (
          <Empty
            title="Your watchlist is empty"
            subtitle="Click Add symbol to start tracking."
          />
        )}
        {rows.map(({ ticker, m }) => {
          if (!m) return null;
          const pct = ((m.price - m.dayOpen) / m.dayOpen) * 100;
          const change = m.price - m.dayOpen;
          return (
            <div
              key={ticker}
              style={{
                display: 'grid',
                gridTemplateColumns: '1.3fr 1fr 1fr 0.8fr 0.6fr 0.4fr',
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
                className="mono tnum"
                style={{ textAlign: 'right', fontWeight: 500 }}
              >
                <PriceCell value={m.price} prefix="$" />
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className={`mono tnum ${pct >= 0 ? 'up' : 'down'}`}>
                  {change >= 0 ? '+' : ''}
                  {change.toFixed(2)}
                </div>
                <div style={{ fontSize: 11.5, marginTop: 2 }}>
                  <span className={`chip ${pct >= 0 ? 'up' : 'down'}`}>
                    {fmtPct(pct)}
                  </span>
                </div>
              </div>
              <div
                className="mono tnum"
                style={{ textAlign: 'right', color: 'var(--text-muted)' }}
              >
                {fmtVol(m.vol)}
              </div>
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <Sparkline
                  data={m.history.slice(-30)}
                  width={64}
                  height={24}
                />
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
