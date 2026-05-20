import type { OrderType } from '../lib/types';
import { fmtMoney, fmtPct } from '../lib/format';
import { formatAcquired, type LotRow } from '../lib/lotView';

export type LotTableSide = 'long' | 'short';

export interface LotTableProps {
  side: LotTableSide;
  rows: LotRow[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  orderType: OrderType;
  setOrderType: (t: OrderType) => void;
  limitPrice: string;
  setLimitPrice: (s: string) => void;
  /** Estimated proceeds for the selected qty at the chosen price. */
  estimatedProceeds: number;
  /** Sum of unrealized G/L over the selected rows (specific-lot view). */
  selectedUnrealized: number;
  selectedQty: number;
  marketIsOpen: boolean;
  marketClockLoading: boolean;
  submitting: boolean;
  /** Inline error text shown above the submit button when set. */
  submitError: string | null;
  /** Inline warning shown above the table (e.g. aggregate fallback). */
  notice: string | null;
  onSubmit: () => void;
}

const SIDE_COPY: Record<LotTableSide, { title: string; pill: string; verb: string }> = {
  long: { title: 'Long lots', pill: 'LONG', verb: 'SELL' },
  short: { title: 'Short lots', pill: 'SHORT', verb: 'COVER' },
};

export function LotTable({
  side,
  rows,
  selectedIds,
  onToggle,
  onToggleAll,
  orderType,
  setOrderType,
  limitPrice,
  setLimitPrice,
  estimatedProceeds,
  selectedUnrealized,
  selectedQty,
  marketIsOpen,
  marketClockLoading,
  submitting,
  submitError,
  notice,
  onSubmit,
}: LotTableProps) {
  const copy = SIDE_COPY[side];
  const allOn = rows.length > 0 && rows.every((r) => selectedIds.has(r.openOrderId));
  const noneOn = rows.every((r) => !selectedIds.has(r.openOrderId));

  const limitInvalid = orderType === 'limit' && (!limitPrice || +limitPrice <= 0);
  const marketBlocked = orderType === 'market' && !marketIsOpen;
  const submitDisabled =
    submitting || selectedQty <= 0 || limitInvalid || marketBlocked;

  return (
    <section className="lot-section">
      <header className="lot-section-head">
        <h4>
          {copy.title} <span className="lot-section-count">· {rows.length} open</span>
        </h4>
        <span className={`pill ${side}`}>{copy.pill}</span>
      </header>

      {notice && <div className="lot-notice">{notice}</div>}

      <table className="table lot-table">
        <thead>
          <tr>
            <th className="lot-cb-col">
              <input
                type="checkbox"
                aria-label="Select all"
                checked={allOn}
                ref={(el) => {
                  if (el) el.indeterminate = !allOn && !noneOn;
                }}
                onChange={onToggleAll}
              />
            </th>
            <th>Acquired</th>
            <th>Term</th>
            <th className="num">$ G/L</th>
            <th className="num">% G/L</th>
            <th className="num">Current value</th>
            <th className="num">Quantity</th>
            <th className="num">Avg cost</th>
            <th className="num">Cost basis total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const checked = selectedIds.has(r.openOrderId);
            const gainColor =
              r.unrealizedAbs >= 0 ? 'var(--up)' : 'var(--down)';
            return (
              <tr key={r.openOrderId} className={checked ? 'lot-row-selected' : ''}>
                <td className="lot-cb-col">
                  <input
                    type="checkbox"
                    aria-label={`Select lot from ${formatAcquired(r.openedAt)}`}
                    checked={checked}
                    onChange={() => onToggle(r.openOrderId)}
                  />
                </td>
                <td>{formatAcquired(r.openedAt)}</td>
                <td>
                  <span className={`lot-term ${r.term.toLowerCase()}`}>{r.term}</span>
                </td>
                <td className="num" style={{ color: gainColor, fontWeight: 500 }}>
                  {fmtMoney(r.unrealizedAbs, { signed: true })}
                </td>
                <td className="num" style={{ color: gainColor }}>
                  {fmtPct(r.unrealizedPct)}
                </td>
                <td className="num">{fmtMoney(r.currentValue)}</td>
                <td className="num">{r.qty}</td>
                <td className="num">{fmtMoney(r.costPerShare)}</td>
                <td className="num">{fmtMoney(r.costBasisTotal)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="lot-footer">
        <div className="lot-footer-row">
          <span className="lot-footer-label">Order</span>
          <div className="segmented lot-footer-seg">
            <button
              type="button"
              className={orderType === 'market' ? 'active' : ''}
              onClick={() => setOrderType('market')}
            >
              Market
            </button>
            <button
              type="button"
              className={orderType === 'limit' ? 'active' : ''}
              onClick={() => setOrderType('limit')}
            >
              Limit
            </button>
          </div>
          {orderType === 'limit' && (
            <div className="input-affix lot-footer-limit">
              <input
                className="input mono"
                type="number"
                step="0.01"
                value={limitPrice}
                onChange={(e) => setLimitPrice(e.target.value)}
                placeholder="Limit price"
                aria-label="Limit price"
              />
              <span className="affix">USD</span>
            </div>
          )}
        </div>

        <div className="lot-footer-row lot-footer-summary">
          <span>
            <span className="lot-footer-label">Selected</span>
            <span className="mono tnum"> {selectedQty} sh</span>
            <span
              className="mono tnum lot-footer-pnl"
              style={{
                color:
                  selectedUnrealized >= 0 ? 'var(--up)' : 'var(--down)',
                marginLeft: 8,
              }}
            >
              {fmtMoney(selectedUnrealized, { signed: true })}
            </span>
            <span className="lot-footer-note"> · Specific-lot view</span>
          </span>
          <span>
            <span className="lot-footer-label">Est. {side === 'long' ? 'proceeds' : 'cost'}</span>
            <span className="mono tnum"> {fmtMoney(estimatedProceeds)}</span>
          </span>
        </div>

        {marketBlocked && (
          <div className="lot-warn">
            {marketClockLoading
              ? 'Checking market status…'
              : 'Market closed — switch to Limit to queue this order.'}
          </div>
        )}

        {submitError && <div className="lot-warn">{submitError}</div>}

        <button
          type="button"
          className={`btn ${side === 'long' ? 'sell' : 'buy'} lot-submit`}
          disabled={submitDisabled}
          onClick={onSubmit}
        >
          {submitting ? 'Placing…' : `${copy.verb} ${selectedQty} ${rows[0]?.ticker ?? ''}`}
          {orderType === 'limit' ? ' · Limit' : ''}
        </button>
      </div>
    </section>
  );
}
