import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Icon } from './Icon';
import { LotTable, type LotTableSide } from './LotTable';
import { getLotRows, type LotRow } from '../lib/lotView';
import { useMarketClock } from '../hooks/useMarketClock';
import { fmtMoney } from '../lib/format';
import type { Market, OrderType, Portfolio } from '../lib/types';
import type { PlaceOrderInput } from '../hooks/usePortfolio';

interface PositionDetailDrawerProps {
  /** Non-null = drawer open. */
  ticker: string | null;
  market: Market;
  portfolio: Portfolio;
  placeOrder: (order: PlaceOrderInput) => void;
  onClose: () => void;
}

interface SideState {
  selected: Set<string>;
  orderType: OrderType;
  limitPrice: string;
  submitting: boolean;
  submitError: string | null;
}

const initialSideState = (): SideState => ({
  selected: new Set(),
  orderType: 'market',
  limitPrice: '',
  submitting: false,
  submitError: null,
});

export function PositionDetailDrawer({
  ticker,
  market,
  portfolio,
  placeOrder,
  onClose,
}: PositionDetailDrawerProps) {
  const { clock, loading: clockLoading } = useMarketClock();
  const marketIsOpen = clock?.isOpen === true;

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

  const [longState, setLongState] = useState<SideState>(initialSideState);
  const [shortState, setShortState] = useState<SideState>(initialSideState);

  // Per-ticker reseed: when the user opens the drawer for a new ticker, default
  // every lot to selected. We only reseed on ticker change so a live tick or
  // a partial fill doesn't blow away the user's manual unchecks.
  useEffect(() => {
    if (!ticker) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLongState(initialSideState());
      setShortState(initialSideState());
      return;
    }
    const allLong = new Set(lotRowsResult.long.map((r) => r.openOrderId));
    const allShort = new Set(lotRowsResult.short.map((r) => r.openOrderId));
    setLongState((s) => ({
      ...initialSideState(),
      // Preserve the limit price the user might have typed earlier.
      limitPrice: s.limitPrice,
      selected: allLong,
    }));
    setShortState((s) => ({
      ...initialSideState(),
      limitPrice: s.limitPrice,
      selected: allShort,
    }));
    // Intentionally not including lotRowsResult — that recomputes on every
    // live tick and would clobber user unchecks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker]);

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

  // Effective selection — drop stale ids whose lots disappeared from the
  // live recompute. We *derive* this rather than mirroring back into state to
  // avoid an effect→setState cascade. Storage stays the user's raw set.
  const effectiveLongSelected = useMemo(
    () => intersectIds(longState.selected, lotRowsResult.long),
    [longState.selected, lotRowsResult.long],
  );
  const effectiveShortSelected = useMemo(
    () => intersectIds(shortState.selected, lotRowsResult.short),
    [shortState.selected, lotRowsResult.short],
  );

  const submitFor = useCallback(
    (side: LotTableSide) => {
      if (!ticker) return;
      const state = side === 'long' ? longState : shortState;
      const setState = side === 'long' ? setLongState : setShortState;
      const rows = side === 'long' ? lotRowsResult.long : lotRowsResult.short;
      const effective =
        side === 'long' ? effectiveLongSelected : effectiveShortSelected;

      const selectedRows = rows.filter((r) => effective.has(r.openOrderId));
      const qty = selectedRows.reduce((acc, r) => acc + r.qty, 0);
      if (qty <= 0) return;

      const orderSide = side === 'long' ? 'sell' : 'cover';
      const order: PlaceOrderInput = {
        ticker,
        side: orderSide,
        type: state.orderType,
        qty,
        tif: 'day',
      };
      if (state.orderType === 'limit') {
        const lim = +state.limitPrice;
        if (!Number.isFinite(lim) || lim <= 0) return;
        order.limitPrice = lim;
      }

      setState((s) => ({ ...s, submitting: true, submitError: null }));

      // placeOrder in usePortfolio is fire-and-forget. Async failures surface
      // through the existing toast handler. We close optimistically on
      // dispatch (mirrors TradeForm.onDone). Synchronous throws — e.g. the
      // "no market data for X" guard — land in the catch below.
      try {
        placeOrder(order);
        onClose();
      } catch (err) {
        console.error('ERROR PositionDetailDrawer submit failed', {
          ticker,
          side: orderSide,
          qty,
          type: state.orderType,
          err,
        });
        const msg = err instanceof Error ? err.message : String(err);
        setState((s) => ({
          ...s,
          submitting: false,
          submitError: `Couldn't place order: ${msg}`,
        }));
      }
    },
    [
      ticker,
      longState,
      shortState,
      lotRowsResult,
      effectiveLongSelected,
      effectiveShortSelected,
      placeOrder,
      onClose,
    ],
  );

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
          <SideSlot
            ticker={ticker}
            side="long"
            rows={lotRowsResult.long}
            state={longState}
            setState={setLongState}
            effectiveSelected={effectiveLongSelected}
            mark={markPrice}
            marketIsOpen={marketIsOpen}
            marketClockLoading={clockLoading}
            aggregateFallback={lotRowsResult.long.some(
              (r) => r.aggregateFallback,
            )}
            onSubmit={() => submitFor('long')}
          />
        )}

        {lotRowsResult.short.length > 0 && (
          <SideSlot
            ticker={ticker}
            side="short"
            rows={lotRowsResult.short}
            state={shortState}
            setState={setShortState}
            effectiveSelected={effectiveShortSelected}
            mark={markPrice}
            marketIsOpen={marketIsOpen}
            marketClockLoading={clockLoading}
            aggregateFallback={lotRowsResult.short.some(
              (r) => r.aggregateFallback,
            )}
            onSubmit={() => submitFor('short')}
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

interface SideSlotProps {
  ticker: string;
  side: LotTableSide;
  rows: LotRow[];
  state: SideState;
  setState: (updater: (s: SideState) => SideState) => void;
  /** Pruned selection — drops ids whose lots have disappeared. Computed in
   *  the parent so we don't need to mirror state. */
  effectiveSelected: Set<string>;
  mark: number;
  marketIsOpen: boolean;
  marketClockLoading: boolean;
  aggregateFallback: boolean;
  onSubmit: () => void;
}

function SideSlot({
  side,
  rows,
  state,
  setState,
  effectiveSelected,
  mark,
  marketIsOpen,
  marketClockLoading,
  aggregateFallback,
  onSubmit,
}: SideSlotProps) {
  const selectedRows = rows.filter((r) =>
    effectiveSelected.has(r.openOrderId),
  );
  const selectedQty = selectedRows.reduce((acc, r) => acc + r.qty, 0);
  const selectedUnrealized = selectedRows.reduce(
    (acc, r) => acc + r.unrealizedAbs,
    0,
  );

  const refPrice =
    state.orderType === 'limit' ? +state.limitPrice || 0 : mark;
  const estimatedProceeds = selectedQty * refPrice;

  const onToggle = (id: string) => {
    setState((s) => {
      const next = new Set(s.selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...s, selected: next };
    });
  };
  const onToggleAll = () => {
    setState((s) => {
      const allOn = rows.every((r) => s.selected.has(r.openOrderId));
      const next = allOn
        ? new Set<string>()
        : new Set(rows.map((r) => r.openOrderId));
      return { ...s, selected: next };
    });
  };

  const notice = aggregateFallback
    ? 'Detailed lot history is unavailable; showing aggregate position.'
    : null;

  return (
    <LotTable
      side={side}
      rows={rows}
      selectedIds={effectiveSelected}
      onToggle={onToggle}
      onToggleAll={onToggleAll}
      orderType={state.orderType}
      setOrderType={(t) => setState((s) => ({ ...s, orderType: t }))}
      limitPrice={state.limitPrice}
      setLimitPrice={(v) => setState((s) => ({ ...s, limitPrice: v }))}
      estimatedProceeds={estimatedProceeds}
      selectedUnrealized={selectedUnrealized}
      selectedQty={selectedQty}
      marketIsOpen={marketIsOpen}
      marketClockLoading={marketClockLoading}
      submitting={state.submitting}
      submitError={state.submitError}
      notice={notice}
      onSubmit={onSubmit}
    />
  );
}

/** Intersect a raw selection set with the ids of currently-rendered rows. */
function intersectIds(raw: Set<string>, rows: LotRow[]): Set<string> {
  if (raw.size === 0) return raw;
  const valid = new Set(rows.map((r) => r.openOrderId));
  const next = new Set<string>();
  for (const id of raw) {
    if (valid.has(id)) next.add(id);
  }
  return next;
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
