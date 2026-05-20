import { useEffect, useMemo, useState } from 'react';
import { LotTable } from './LotTable';
import { useMarketClock } from '../hooks/useMarketClock';
import type { LotRow } from '../lib/lotView';
import type { Market, OrderType } from '../lib/types';
import type { PlaceOrderInput } from '../hooks/usePortfolio';

export type LotSellPanelSide = 'long' | 'short';

export interface LotSellPanelProps {
  ticker: string;
  side: LotSellPanelSide;
  rows: LotRow[];
  /** Whether at least one row is the synthetic aggregate fallback. */
  aggregateFallback: boolean;
  market: Market;
  placeOrder: (order: PlaceOrderInput) => void;
  /** Optional callback fired after a successful synchronous submit. The
   *  Drawer host passes onClose; the Trade-page host omits it. */
  onAfterSubmit?: () => void;
}

interface PanelState {
  selected: Set<string>;
  orderType: OrderType;
  limitPrice: string;
  submitting: boolean;
  submitError: string | null;
}

export function LotSellPanel({
  ticker,
  side,
  rows,
  aggregateFallback,
  market,
  placeOrder,
  onAfterSubmit,
}: LotSellPanelProps) {
  const { clock, loading: clockLoading } = useMarketClock();
  const marketIsOpen = clock?.isOpen === true;

  // Default selection = all open lots. Reseed whenever the visible row-id set
  // changes shape (ticker switch, partial fill drains a lot, etc.). We compare
  // the joined ids so a live tick that doesn't change the lot list keeps the
  // user's manual unchecks intact.
  const rowIdsKey = rows.map((r) => r.openOrderId).join('|');
  const [state, setState] = useState<PanelState>(() => ({
    selected: new Set(rows.map((r) => r.openOrderId)),
    orderType: 'market',
    limitPrice: '',
    submitting: false,
    submitError: null,
  }));

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((s) => ({
      ...s,
      selected: new Set(rows.map((r) => r.openOrderId)),
      submitting: false,
      submitError: null,
    }));
    // We intentionally key on rowIdsKey (a string), not `rows`, because the
    // rows array reference changes on every live tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowIdsKey]);

  // Effective selection — drop ids whose lots vanished. Derived, not mirrored
  // back to state, to avoid an effect→setState cascade.
  const effectiveSelected = useMemo(
    () => intersectIds(state.selected, rows),
    [state.selected, rows],
  );

  const selectedRows = rows.filter((r) => effectiveSelected.has(r.openOrderId));
  const selectedQty = selectedRows.reduce((acc, r) => acc + r.qty, 0);
  const selectedUnrealized = selectedRows.reduce(
    (acc, r) => acc + r.unrealizedAbs,
    0,
  );

  const markPrice = market[ticker]?.price ?? 0;
  const refPrice =
    state.orderType === 'limit' ? +state.limitPrice || 0 : markPrice;
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

  const onSubmit = () => {
    if (selectedQty <= 0) return;

    const orderSide = side === 'long' ? 'sell' : 'cover';
    const order: PlaceOrderInput = {
      ticker,
      side: orderSide,
      type: state.orderType,
      qty: selectedQty,
      tif: 'day',
    };
    if (state.orderType === 'limit') {
      const lim = +state.limitPrice;
      if (!Number.isFinite(lim) || lim <= 0) return;
      order.limitPrice = lim;
    }

    setState((s) => ({ ...s, submitting: true, submitError: null }));

    // placeOrder is fire-and-forget. Async failures surface through the
    // existing toast handler. Synchronous throws (e.g. "no market data for X")
    // land in the catch.
    try {
      placeOrder(order);
      onAfterSubmit?.();
    } catch (err) {
      console.error('ERROR LotSellPanel submit failed', {
        ticker,
        side: orderSide,
        qty: selectedQty,
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
      marketClockLoading={clockLoading}
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
