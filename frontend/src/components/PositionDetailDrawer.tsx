import { useEffect, useMemo } from 'react';
import { Icon } from './Icon';
import { LotSellPanel } from './LotSellPanel';
import { getLotRows, type LotRow } from '../lib/lotView';
import { fmtMoney } from '../lib/format';
import type { Market, Portfolio } from '../lib/types';
import type { PlaceOrderInput } from '../hooks/usePortfolio';

interface PositionDetailDrawerProps {
  /** Non-null = drawer open. */
  ticker: string | null;
  market: Market;
  portfolio: Portfolio;
  placeOrder: (order: PlaceOrderInput) => void;
  onClose: () => void;
}

export function PositionDetailDrawer({
  ticker,
  market,
  portfolio,
  placeOrder,
  onClose,
}: PositionDetailDrawerProps) {
  // Memoize the heavy FIFO replay. Recomputes only when history, positions,
  // or the live tick for this ticker changes.
  const tickerKey = ticker ?? '';
  const markPrice = market[tickerKey]?.price ?? 0;
  const lotRowsResult = useMemo(
    () =>
      ticker
        ? getLotRows(portfolio, ticker, market)
        : { long: [], short: [], aggregate: false, failed: false },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ticker, portfolio.history, portfolio.positions, markPrice],
  );

  // ESC + body scroll lock, mirrored from Modal.
  useEffect(() => {
    if (!ticker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [ticker, onClose]);

  if (!ticker) return null;

  const m = market[ticker];
  const totals = computeTotals(lotRowsResult.long, lotRowsResult.short);

  return (
    <div className="lot-drawer-backdrop" onClick={onClose}>
      <aside
        className="lot-drawer"
        role="dialog"
        aria-label={`Lot history for ${ticker}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="lot-drawer-head">
          <div>
            <span className="ticker">{ticker}</span>
            {m && (
              <span className="mono tnum lot-drawer-price">
                {' '}
                {fmtMoney(m.price)}
              </span>
            )}
          </div>
          <button
            className="btn ghost icon-only"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="lot-drawer-stats">
          <Stat label="Total qty" value={String(totals.qty)} />
          <Stat label="Mkt value" value={fmtMoney(totals.marketValue)} />
          <Stat label="Avg cost" value={fmtMoney(totals.avgCost)} />
          <Stat
            label="Unrealized"
            value={fmtMoney(totals.unrealized, { signed: true })}
            color={totals.unrealized >= 0 ? 'var(--up)' : 'var(--down)'}
          />
        </div>

        {lotRowsResult.failed && (
          <div className="lot-warn lot-drawer-warn">
            Lot history unavailable for {ticker}. Use the Trade page to manage
            this position.
          </div>
        )}

        {lotRowsResult.long.length === 0 &&
          lotRowsResult.short.length === 0 &&
          !lotRowsResult.failed && (
            <div className="lot-drawer-empty">
              No open shares of {ticker}.
            </div>
          )}

        {lotRowsResult.long.length > 0 && (
          <LotSellPanel
            ticker={ticker}
            side="long"
            rows={lotRowsResult.long}
            aggregateFallback={lotRowsResult.long.some(
              (r) => r.aggregateFallback,
            )}
            market={market}
            placeOrder={placeOrder}
            onAfterSubmit={onClose}
          />
        )}

        {lotRowsResult.short.length > 0 && (
          <LotSellPanel
            ticker={ticker}
            side="short"
            rows={lotRowsResult.short}
            aggregateFallback={lotRowsResult.short.some(
              (r) => r.aggregateFallback,
            )}
            market={market}
            placeOrder={placeOrder}
            onAfterSubmit={onClose}
          />
        )}
      </aside>
    </div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="lot-drawer-stat">
      <div className="lot-drawer-stat-label">{label}</div>
      <div
        className="lot-drawer-stat-value mono tnum"
        style={color ? { color } : undefined}
      >
        {value}
      </div>
    </div>
  );
}

function computeTotals(longRows: LotRow[], shortRows: LotRow[]) {
  const all = [...longRows, ...shortRows];
  const qty = all.reduce((a, r) => a + r.qty, 0);
  const marketValue = all.reduce((a, r) => a + r.currentValue, 0);
  const cost = all.reduce((a, r) => a + r.costBasisTotal, 0);
  const unrealized = all.reduce((a, r) => a + r.unrealizedAbs, 0);
  const avgCost = qty > 0 ? cost / qty : 0;
  return { qty, marketValue, avgCost, unrealized };
}
