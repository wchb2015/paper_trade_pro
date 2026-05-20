# Acquired History drawer + lot-aware Sell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Portfolio "click symbol → navigate to Trade page" behavior with a right-side drawer that shows the user's per-lot Acquired History for that symbol and lets them sell or cover specific lots inline (Market or Limit).

**Architecture:** Frontend-only. A new `PositionDetailDrawer` is mounted in `App.tsx`, keyed on `activeLotTicker`. Per-lot rows are derived from the existing `replayFifo()` in `frontend/src/lib/pnl.ts` via a thin `lib/lotView.ts` adapter. Selection-as-intent: the user picks lots, but we submit one combined Sell/Cover order via the existing `placeOrder` path. No backend, schema, or API changes.

**Tech Stack:** React 19 + TypeScript + Vite. No test runner is installed in this repo (`backend/package.json` and `frontend/package.json` confirm) — the project's quality gates are `npm run lint` (eslint) and `npm run build` (`tsc -b && vite build`). **Do not introduce Vitest/Jest in this plan.** Each task verifies via lint + type-check; behavioral validation happens in the manual smoke task at the end.

**Spec:** `docs/superpowers/specs/2026-05-19-acquired-history-and-lot-sell-design.md`

---

## File Structure

### New files
- `frontend/src/lib/lotView.ts` — adapter on top of `replayFifo`. Builds `LotRow[]` (per-lot precomputed values) for a ticker, formats the Acquired column, handles the "history-pruned → aggregate fallback" case. **Pure** — no React.
- `frontend/src/components/LotTable.tsx` — presentational table for one side (long or short). Takes pre-built rows + selection + order-form state. Owns no business logic.
- `frontend/src/components/PositionDetailDrawer.tsx` — drawer container. Mounts when `ticker` prop is non-null. Owns selection / order-type / limit-price / submit-error state. Renders one `LotTable` per non-empty side. Calls `placeOrder`.

### Modified files
- `frontend/src/pages/PortfolioPage.tsx` — accept `onOpenLots: (ticker: string) => void`; replace the symbol cell `onClick={() => onNavigate('trade', ...)}` calls in the Top positions table and the Positions tab with `onOpenLots(ticker)`. Add/Close buttons untouched.
- `frontend/src/components/PageRouter.tsx` — thread `onOpenLots` through to `PortfolioPage`.
- `frontend/src/App.tsx` — add `activeLotTicker` state; pass setter through `PageRouter`; render `<PositionDetailDrawer />` at the same level as `ModalStack`.
- `frontend/src/index.css` — add `.lot-drawer*` styles using existing tokens (`--accent`, `--border`, `--bg-elev`, `--up`, `--down`).

### Untouched
`TradeForm.tsx`, `TradeTicket.tsx`, `lib/pnl.ts`, `hooks/usePortfolio.ts`, all of `backend/`, all of `shared/`.

---

## Task 1: Build the `lib/lotView.ts` adapter

**Files:**
- Create: `frontend/src/lib/lotView.ts`

This task is pure data-shaping — no React, no DOM. Doing it first lets every later task import a stable type.

- [ ] **Step 1: Create the file with full implementation**

Write `frontend/src/lib/lotView.ts`:

```ts
// -----------------------------------------------------------------------------
// lotView — adapter on top of replayFifo for the PositionDetailDrawer.
//
// Builds per-lot row data (term, current value, unrealized $/% G/L, cost-basis
// totals) from the FIFO open-lot queues already produced by lib/pnl.ts. Falls
// back to a synthetic "aggregate lot" derived from the Position row when the
// queues are empty (history pruned past HISTORY_LIMIT, fresh import, etc.).
//
// Pure module — no React, no I/O. Errors are logged with the project's
// "Never fail silently" rule (see CLAUDE.md) and replaced with a safe empty
// result the caller surfaces as a warning.
// -----------------------------------------------------------------------------

import type { Market, Portfolio } from './types';
import { replayFifo, type Lot } from './pnl';

// 365 days. Lots opened ≥1 year ago count as Long-term; younger lots are
// Short-term. Mirrors the U.S. brokerage convention shown on the spec mock.
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export interface LotRow extends Lot {
  /** 'Short' = held <1y; 'Long' = held ≥1y. Re-evaluated on every getLotRows
   *  call so older lots flip without a backend change. */
  term: 'Short' | 'Long';
  /** Long: qty * markPrice. Short: qty * costPerShare (entry price). */
  currentValue: number;
  /** Long: (mark - cost) * qty. Short: (cost - mark) * qty. */
  unrealizedAbs: number;
  /** unrealizedAbs / costBasisTotal * 100. 0 when basis is 0. */
  unrealizedPct: number;
  /** qty * costPerShare. */
  costBasisTotal: number;
  /** True when this row was synthesized from the Position row, not from a
   *  real opening order in history. */
  aggregateFallback?: true;
}

export interface LotRowsResult {
  long: LotRow[];
  short: LotRow[];
  /** True when at least one section was synthesized from the Position row. */
  aggregate: boolean;
  /** True when the adapter caught an error and returned a safe empty result.
   *  The drawer renders an inline warning when this is set. */
  failed: boolean;
}

/**
 * Build per-lot rows for `ticker`. Reads `portfolio.history` + `portfolio.positions`
 * for lot reconstruction, and `market[ticker]` for the live mark price.
 */
export function getLotRows(
  portfolio: Portfolio,
  ticker: string,
  market: Market,
): LotRowsResult {
  try {
    const fifo = replayFifo(portfolio.history, portfolio.positions);
    const queues = fifo.openLots.get(ticker);
    const mark = market[ticker]?.price ?? 0;

    const longLots = (queues?.long ?? []).filter((l) => l.qty > 0);
    const shortLots = (queues?.short ?? []).filter((l) => l.qty > 0);

    let aggregate = false;

    // Aggregate fallback per side: if the FIFO queue is empty but a Position
    // row exists, synthesize one row so the user can still sell.
    const longPos = portfolio.positions.find(
      (p) => p.ticker === ticker && p.side === 'long',
    );
    if (longLots.length === 0 && longPos && longPos.qty > 0) {
      longLots.push({
        openOrderId: `agg-${longPos.id}`,
        ticker,
        side: 'long',
        costPerShare: longPos.avgPrice,
        qty: longPos.qty,
        openedAt: longPos.openedAt,
      });
      aggregate = true;
    }

    const shortPos = portfolio.positions.find(
      (p) => p.ticker === ticker && p.side === 'short',
    );
    if (shortLots.length === 0 && shortPos && shortPos.qty > 0) {
      shortLots.push({
        openOrderId: `agg-${shortPos.id}`,
        ticker,
        side: 'short',
        costPerShare: shortPos.avgPrice,
        qty: shortPos.qty,
        openedAt: shortPos.openedAt,
      });
      aggregate = true;
    }

    return {
      long: longLots.map((l) => buildRow(l, mark, aggregate)),
      short: shortLots.map((l) => buildRow(l, mark, aggregate)),
      aggregate,
      failed: false,
    };
  } catch (err) {
    // CLAUDE.md "Never fail silently" — log with ERROR keyword + context.
    // eslint-disable-next-line no-console
    console.error('ERROR getLotRows failed', { ticker, err });
    return { long: [], short: [], aggregate: false, failed: true };
  }
}

function buildRow(lot: Lot, mark: number, aggregate: boolean): LotRow {
  const costBasisTotal = lot.qty * lot.costPerShare;
  const term: 'Short' | 'Long' =
    Date.now() - lot.openedAt >= ONE_YEAR_MS ? 'Long' : 'Short';
  const currentValue =
    lot.side === 'long' ? lot.qty * mark : lot.qty * lot.costPerShare;
  const unrealizedAbs =
    lot.side === 'long'
      ? (mark - lot.costPerShare) * lot.qty
      : (lot.costPerShare - mark) * lot.qty;
  const unrealizedPct =
    costBasisTotal > 0 ? (unrealizedAbs / costBasisTotal) * 100 : 0;
  const row: LotRow = {
    ...lot,
    term,
    currentValue,
    unrealizedAbs,
    unrealizedPct,
    costBasisTotal,
  };
  if (aggregate && lot.openOrderId.startsWith('agg-')) {
    row.aggregateFallback = true;
  }
  return row;
}

/**
 * "Mar 15, 2025 09:31 AM" in the user's local timezone. Per CLAUDE.md timezone
 * golden rule, we convert to local only at the display edge.
 */
export function formatAcquired(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}
```

- [ ] **Step 2: Type-check**

Run from repo root:
```bash
cd frontend && npx tsc -b
```
Expected: exit 0, no diagnostics for `lib/lotView.ts`.

- [ ] **Step 3: Lint**

Run:
```bash
cd frontend && npm run lint -- src/lib/lotView.ts
```
Expected: no errors. (Warnings about `console.error` are suppressed by the inline `eslint-disable-next-line` comment.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/lotView.ts
git commit -m "feat(portfolio): add lotView adapter on top of replayFifo"
```

---

## Task 2: Build the `LotTable` presentational component

**Files:**
- Create: `frontend/src/components/LotTable.tsx`

This is the table rendering for a single side (long or short). It is purely presentational — no `replayFifo`, no `placeOrder`. The drawer in Task 3 wires data + handlers in.

- [ ] **Step 1: Create the file with full implementation**

Write `frontend/src/components/LotTable.tsx`:

```tsx
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
```

- [ ] **Step 2: Type-check**

Run:
```bash
cd frontend && npx tsc -b
```
Expected: exit 0.

- [ ] **Step 3: Lint**

Run:
```bash
cd frontend && npm run lint -- src/components/LotTable.tsx
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/LotTable.tsx
git commit -m "feat(portfolio): add LotTable presentational component"
```

---

## Task 3: Build the `PositionDetailDrawer` container

**Files:**
- Create: `frontend/src/components/PositionDetailDrawer.tsx`

The drawer mounts when `ticker` is non-null, owns selection / order-type / limit-price / submit state, derives data from `portfolio + market` via `getLotRows`, and submits one combined order per side via the existing `placeOrder` prop.

- [ ] **Step 1: Create the file with full implementation**

Write `frontend/src/components/PositionDetailDrawer.tsx`:

```tsx
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
import { askOrPrice, bidOrPrice } from '../lib/quote';
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

/**
 * Per-side local form state. Selection ids reference Lot.openOrderId
 * (stable across recomputes; survives live-tick re-renders).
 */
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
  // every lot to selected. We track the last ticker we seeded for so a live
  // tick or a partial fill doesn't blow away the user's manual unchecks.
  useEffect(() => {
    if (!ticker) {
      setLongState(initialSideState());
      setShortState(initialSideState());
      return;
    }
    const allLong = new Set(lotRowsResult.long.map((r) => r.openOrderId));
    const allShort = new Set(lotRowsResult.short.map((r) => r.openOrderId));
    setLongState((s) => ({
      ...initialSideState(),
      // Preserve the limit price the user might have typed — but reseed
      // selection because lots can change shape between opens.
      limitPrice: s.limitPrice,
      selected: allLong,
    }));
    setShortState((s) => ({
      ...initialSideState(),
      limitPrice: s.limitPrice,
      selected: allShort,
    }));
    // Intentionally not including lotRowsResult — that recomputes on every
    // live tick and would clobber user unchecks. We only reseed on ticker change.
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

  // Drop selected ids that no longer exist after a live recompute.
  useEffect(() => {
    setLongState((s) => pruneSelection(s, lotRowsResult.long));
    setShortState((s) => pruneSelection(s, lotRowsResult.short));
  }, [lotRowsResult.long, lotRowsResult.short]);

  const submitFor = useCallback(
    (side: LotTableSide) => {
      if (!ticker) return;
      const state = side === 'long' ? longState : shortState;
      const setState = side === 'long' ? setLongState : setShortState;
      const rows = side === 'long' ? lotRowsResult.long : lotRowsResult.short;

      const selectedRows = rows.filter((r) => state.selected.has(r.openOrderId));
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

      // placeOrder in usePortfolio is fire-and-forget (returns void) and the
      // global handleError surfaces failures via toast. We close optimistically
      // on dispatch, mirroring TradeForm.onDone — same UX as the existing
      // Trade flow. If you later make placeOrder return a Promise you can
      // gate this on success.
      try {
        placeOrder(order);
        onClose();
      } catch (err) {
        // eslint-disable-next-line no-console
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
    [ticker, longState, shortState, lotRowsResult, placeOrder, onClose],
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
      <div className="lot-drawer-stat-value mono tnum" style={color ? { color } : undefined}>
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
  mark,
  marketIsOpen,
  marketClockLoading,
  aggregateFallback,
  onSubmit,
}: SideSlotProps) {
  const selectedRows = rows.filter((r) => state.selected.has(r.openOrderId));
  const selectedQty = selectedRows.reduce((acc, r) => acc + r.qty, 0);
  const selectedUnrealized = selectedRows.reduce(
    (acc, r) => acc + r.unrealizedAbs,
    0,
  );

  // Estimated proceeds at current price (Market) or limit price (Limit).
  // For Market: long sells at bid, short covers at ask. We don't have direct
  // bid/ask here, but the LotTable footer is informational only — the actual
  // fill price comes from market[ticker] inside usePortfolio.placeOrder.
  // Use mark as a fair approximation.
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
      const next = allOn ? new Set<string>() : new Set(rows.map((r) => r.openOrderId));
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
      selectedIds={state.selected}
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

// askOrPrice / bidOrPrice are not used in the current MVP estimate (we use
// mark price for the footer summary). Keep them imported so a later upgrade
// to true bid/ask can wire them in without touching the import block.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _keepAskBid = { askOrPrice, bidOrPrice };

function pruneSelection(s: SideState, rows: LotRow[]): SideState {
  if (s.selected.size === 0) return s;
  const valid = new Set(rows.map((r) => r.openOrderId));
  let mutated = false;
  const next = new Set<string>();
  for (const id of s.selected) {
    if (valid.has(id)) next.add(id);
    else mutated = true;
  }
  return mutated ? { ...s, selected: next } : s;
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
```

> **Note for the executor:** the `_keepAskBid` line is intentional — a later iteration may use real bid/ask in the footer estimate. If lint flags it, the inline `eslint-disable-next-line` already suppresses; do **not** remove the import unless you also remove the disable comment.

- [ ] **Step 2: Type-check**

Run:
```bash
cd frontend && npx tsc -b
```
Expected: exit 0.

- [ ] **Step 3: Lint**

Run:
```bash
cd frontend && npm run lint -- src/components/PositionDetailDrawer.tsx
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/PositionDetailDrawer.tsx
git commit -m "feat(portfolio): add PositionDetailDrawer container"
```

---

## Task 4: Wire `PortfolioPage` to the new `onOpenLots` prop

**Files:**
- Modify: `frontend/src/pages/PortfolioPage.tsx`

Replace the symbol cell `onClick={() => onNavigate('trade', ticker)}` calls with `onOpenLots(ticker)`. Touch only the ticker text — leave the Add and Close buttons (and Top movers' click handler) exactly as they are.

- [ ] **Step 1: Add the new prop**

In `frontend/src/pages/PortfolioPage.tsx`, modify the `PortfolioPageProps` interface and the destructured args:

Find:
```ts
interface PortfolioPageProps {
  market: Market;
  portfolio: Portfolio;
  valuation: Valuation;
  onNavigate: (page: PageKey, ticker?: string) => void;
  setTradeCtx: (ctx: TradeCtx | null) => void;
}

export function PortfolioPage({
  market,
  portfolio,
  valuation,
  onNavigate,
  setTradeCtx,
}: PortfolioPageProps) {
```

Replace with:
```ts
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
```

- [ ] **Step 2: Replace the Top positions table symbol click**

Find this block (in the "Top positions" `previewPositions.map` body, around line 350-355):

```tsx
                {previewPositions.map(({ p, m, mkt, pnl, pnlPct }) => (
                  <tr key={p.id}>
                    <td>
                      <div className="ticker">{p.ticker}</div>
                    </td>
```

Replace with:

```tsx
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
```

- [ ] **Step 3: Replace the Positions tab symbol click**

Find this block (in the Positions tab table body, around line 440-447):

```tsx
                      <td>
                        <div
                          className="ticker"
                          onClick={() => onNavigate('trade', p.ticker)}
                          style={{ cursor: 'pointer' }}
                        >
                          {p.ticker}
                        </div>
                      </td>
```

Replace with:

```tsx
                      <td>
                        <div
                          className="ticker"
                          onClick={() => onOpenLots(p.ticker)}
                          style={{ cursor: 'pointer' }}
                        >
                          {p.ticker}
                        </div>
                      </td>
```

> **Note for the executor:** Top movers (line ~270-298) still uses `onNavigate('trade', t.ticker)`. Per the spec scope, we leave it alone — Top movers includes tickers the user does not own. Do not change it.

- [ ] **Step 4: Type-check + lint**

Run:
```bash
cd frontend && npx tsc -b && npm run lint -- src/pages/PortfolioPage.tsx
```
Expected: exit 0, no errors. (TypeScript will flag the missing `onOpenLots` at the call sites in `PageRouter.tsx` — that's expected and is fixed in Task 5.)

If `tsc -b` fails *only* with errors of the form `Property 'onOpenLots' is missing` at the `<PortfolioPage ...>` call site, that is the expected mid-state and you should proceed to Task 5. Any other error must be fixed before continuing.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/PortfolioPage.tsx
git commit -m "feat(portfolio): route symbol click to onOpenLots"
```

---

## Task 5: Thread `onOpenLots` through `PageRouter`

**Files:**
- Modify: `frontend/src/components/PageRouter.tsx`

- [ ] **Step 1: Add the prop**

In `frontend/src/components/PageRouter.tsx`, modify `PageRouterProps`:

Find:
```ts
  onNavigate: (p: PageKey, ticker?: string) => void;
  setTradeCtx: (ctx: TradeCtx | null) => void;
  setAlertCtx: (ctx: AlertCtx | null) => void;
  onAddStock: () => void;
  liveFeed: "iex" | "sip" | null;
}
```

Replace with:
```ts
  onNavigate: (p: PageKey, ticker?: string) => void;
  setTradeCtx: (ctx: TradeCtx | null) => void;
  setAlertCtx: (ctx: AlertCtx | null) => void;
  onAddStock: () => void;
  liveFeed: "iex" | "sip" | null;
  onOpenLots: (ticker: string) => void;
}
```

- [ ] **Step 2: Destructure it**

Find:
```ts
    onAddStock,
    liveFeed,
  } = props;
```

Replace with:
```ts
    onAddStock,
    liveFeed,
    onOpenLots,
  } = props;
```

- [ ] **Step 3: Pass it to PortfolioPage**

Find:
```tsx
    case "portfolio":
      return (
        <PortfolioPage
          market={market}
          portfolio={portfolio}
          valuation={valuation}
          onNavigate={onNavigate}
          setTradeCtx={setTradeCtx}
        />
      );
```

Replace with:
```tsx
    case "portfolio":
      return (
        <PortfolioPage
          market={market}
          portfolio={portfolio}
          valuation={valuation}
          onNavigate={onNavigate}
          setTradeCtx={setTradeCtx}
          onOpenLots={onOpenLots}
        />
      );
```

- [ ] **Step 4: Type-check + lint**

Run:
```bash
cd frontend && npx tsc -b && npm run lint -- src/components/PageRouter.tsx
```
Expected: exit 0, no errors. (TypeScript will now flag the missing `onOpenLots` at `<PageRouter ...>` in `App.tsx` — fixed in Task 6.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PageRouter.tsx
git commit -m "feat(portfolio): thread onOpenLots through PageRouter"
```

---

## Task 6: Mount the drawer in `App.tsx`

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Add the import**

Near the top of `frontend/src/App.tsx`, after the existing component imports, add:

```tsx
import { PositionDetailDrawer } from "./components/PositionDetailDrawer";
```

Place it next to the other `./components/*` imports (e.g. right after `import { ModalStack } from "./components/ModalStack";`).

- [ ] **Step 2: Add the state**

Find the block of `useState` calls inside `App()` (around line 33-41):

```tsx
  const [activeTradeTicker, setActiveTradeTicker] = usePersistedState<string>(
    "ptp_trade_ticker",
    "AAPL",
  );
  const [tradeCtx, setTradeCtx] = useState<TradeCtx | null>(null);
  const [alertCtx, setAlertCtx] = useState<AlertCtx | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [tweaksOpen, setTweaksOpen] = useState(false);
```

Add a new line right after the `addOpen` line:

```tsx
  const [activeLotTicker, setActiveLotTicker] = useState<string | null>(null);
```

So the block reads:
```tsx
  const [activeTradeTicker, setActiveTradeTicker] = usePersistedState<string>(
    "ptp_trade_ticker",
    "AAPL",
  );
  const [tradeCtx, setTradeCtx] = useState<TradeCtx | null>(null);
  const [alertCtx, setAlertCtx] = useState<AlertCtx | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [activeLotTicker, setActiveLotTicker] = useState<string | null>(null);
  const [tweaksOpen, setTweaksOpen] = useState(false);
```

- [ ] **Step 3: Pass `onOpenLots` to PageRouter**

Find:
```tsx
        <PageRouter
          page={page}
          activeTradeTicker={activeTradeTicker}
          market={market}
          unavailable={unavailable}
          portfolio={portfolio}
          valuation={effectiveValuation}
          toggleWatch={toggleWatch}
          placeOrder={placeOrder}
          cancelOrder={cancelOrder}
          toggleAlert={toggleAlert}
          removeAlert={removeAlert}
          resetFunds={resetFunds}
          onNavigate={onNavigate}
          setTradeCtx={setTradeCtx}
          setAlertCtx={setAlertCtx}
          onAddStock={() => setAddOpen(true)}
          liveFeed={liveFeed}
        />
```

Replace with:
```tsx
        <PageRouter
          page={page}
          activeTradeTicker={activeTradeTicker}
          market={market}
          unavailable={unavailable}
          portfolio={portfolio}
          valuation={effectiveValuation}
          toggleWatch={toggleWatch}
          placeOrder={placeOrder}
          cancelOrder={cancelOrder}
          toggleAlert={toggleAlert}
          removeAlert={removeAlert}
          resetFunds={resetFunds}
          onNavigate={onNavigate}
          setTradeCtx={setTradeCtx}
          setAlertCtx={setAlertCtx}
          onAddStock={() => setAddOpen(true)}
          liveFeed={liveFeed}
          onOpenLots={setActiveLotTicker}
        />
```

- [ ] **Step 4: Render the drawer**

Find:
```tsx
      <ModalStack
        market={market}
        portfolio={portfolio}
        tradeCtx={tradeCtx}
        alertCtx={alertCtx}
        addOpen={addOpen}
        setTradeCtx={setTradeCtx}
        setAlertCtx={setAlertCtx}
        setAddOpen={setAddOpen}
        placeOrder={placeOrder}
        addAlert={addAlert}
        toggleWatch={toggleWatch}
      />
```

Add directly after the `</ModalStack>` (i.e. on the next line after the self-closing tag):

```tsx
      <PositionDetailDrawer
        ticker={activeLotTicker}
        market={market}
        portfolio={portfolio}
        placeOrder={placeOrder}
        onClose={() => setActiveLotTicker(null)}
      />
```

- [ ] **Step 5: Type-check + lint + build**

Run:
```bash
cd frontend && npx tsc -b && npm run lint && npm run build
```
Expected: exit 0 on all three. The whole project should now type-check and build cleanly.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat(portfolio): mount PositionDetailDrawer in App"
```

---

## Task 7: Add drawer styles to `index.css`

**Files:**
- Modify: `frontend/src/index.css`

- [ ] **Step 1: Append the drawer block**

Append the following block to the end of `frontend/src/index.css`:

```css
/* ============================================================
   PositionDetailDrawer (lot drawer)
   ============================================================ */

.lot-drawer-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.32);
  z-index: 50;
  display: flex;
  justify-content: flex-end;
  animation: lot-drawer-fade 120ms ease-out;
}

@keyframes lot-drawer-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

.lot-drawer {
  width: min(960px, 92vw);
  height: 100%;
  background: var(--bg-elev);
  border-left: 1px solid var(--border);
  box-shadow: -8px 0 30px rgba(0, 0, 0, 0.18);
  overflow: auto;
  animation: lot-drawer-slide 180ms cubic-bezier(.2,.7,.2,1);
}

@keyframes lot-drawer-slide {
  from { transform: translateX(24px); opacity: 0.4; }
  to { transform: translateX(0); opacity: 1; }
}

.lot-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  background: var(--bg-elev);
  z-index: 1;
}
.lot-drawer-head .ticker { font-weight: 700; font-size: 18px; }
.lot-drawer-price { color: var(--accent); font-weight: 600; margin-left: 10px; }

.lot-drawer-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1px;
  background: var(--border);
}
.lot-drawer-stat { background: var(--bg-elev); padding: 12px 16px; }
.lot-drawer-stat-label {
  font-size: 10.5px;
  color: var(--text-muted);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.lot-drawer-stat-value { font-size: 14px; margin-top: 2px; }

.lot-drawer-warn,
.lot-warn {
  margin: 12px 18px 0;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--down) 14%, transparent);
  color: var(--down);
  border-radius: 8px;
  font-size: 12.5px;
}

.lot-drawer-empty {
  padding: 32px 18px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.lot-section {
  padding: 14px 18px 18px;
  border-bottom: 1px solid var(--border);
}
.lot-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin: 0 0 8px;
}
.lot-section-head h4 { margin: 0; font-size: 13px; }
.lot-section-count {
  color: var(--text-muted);
  font-weight: 400;
  font-size: 11.5px;
  margin-left: 4px;
}

.lot-notice {
  margin: 0 0 8px;
  padding: 8px 12px;
  background: var(--accent-soft);
  color: var(--accent);
  border-radius: 8px;
  font-size: 12px;
}

.lot-table { font-size: 12.5px; }
.lot-table .lot-cb-col { width: 28px; text-align: center; padding-left: 8px; padding-right: 0; }
.lot-row-selected td { background: var(--accent-soft); }

.lot-term {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  background: color-mix(in srgb, var(--text-muted) 18%, transparent);
  color: var(--text);
}
.lot-term.long {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--accent);
}

.lot-footer {
  margin-top: 12px;
  padding: 12px;
  border: 1px dashed var(--border);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.lot-footer-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.lot-footer-summary { justify-content: space-between; }
.lot-footer-label {
  font-size: 10.5px;
  color: var(--text-muted);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.lot-footer-pnl { font-weight: 600; }
.lot-footer-note { color: var(--text-muted); font-size: 11px; margin-left: 6px; }
.lot-footer-seg { /* inherits .segmented */ }
.lot-footer-limit { width: 160px; }

.lot-submit { align-self: flex-end; min-width: 160px; }

@media (max-width: 720px) {
  .lot-drawer-stats { grid-template-columns: repeat(2, 1fr); }
  .lot-table { font-size: 11.5px; }
  .lot-footer-summary { flex-direction: column; align-items: flex-start; }
}
```

- [ ] **Step 2: Type-check + build**

Run:
```bash
cd frontend && npm run build
```
Expected: exit 0. The CSS is shipped via Vite, so the build is the verification.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/index.css
git commit -m "feat(portfolio): style PositionDetailDrawer"
```

---

## Task 8: Manual smoke test

**Files:** none (verification only)

Behavioral validation. The repo has no test runner, so this task is the QA gate before merge.

- [ ] **Step 1: Start the dev stack**

In one terminal:
```bash
cd backend && npm run dev
```

In a second terminal:
```bash
cd frontend && npm run dev
```

Open the URL Vite prints (typically http://localhost:5173).

- [ ] **Step 2: Acquired History — happy path**

1. On the Portfolio page, ensure you have at least one open position. If not, place a few buys at different prices on a single ticker (e.g. AAPL via the Watchlist Trade modal).
2. Click the **AAPL** ticker text on the Positions tab.
3. **Verify:** Drawer slides in from the right with the AAPL price strip, four stat cells (Total qty, Mkt value, Avg cost, Unrealized), and a "Long lots" section with one row per buy.
4. **Verify:** Each row shows the local-time Acquired string ("Mar 15, 2025 09:31 AM" style), Term ("Short" since recent), $/% G/L matching the live tick, Quantity, Avg cost, Cost basis total.
5. **Verify:** All checkboxes start ticked.

- [ ] **Step 3: Live tick**

While the drawer is open, watch a $/% G/L cell. **Verify:** It updates in place as `market[ticker].price` ticks (no flicker, no row re-shuffle).

- [ ] **Step 4: Selection + sell (Market)**

1. Uncheck the oldest lot.
2. **Verify:** Footer "Selected: N sh" updates to the sum of remaining checked rows. Footer Unrealized updates accordingly.
3. Confirm Order = Market.
4. Click **SELL N AAPL**.
5. **Verify:** Drawer closes, a toast (or other usePortfolio path) reflects the placed order, the Orders page shows one new "sell" row with the correct qty, and the position quantity in Portfolio drops by N.

- [ ] **Step 5: Selection + sell (Limit)**

1. Reopen the drawer for the same ticker.
2. Switch Order → **Limit**.
3. **Verify:** Limit price input appears, seeded from the current market price (or empty — confirm against the actual implementation; either is OK).
4. Type a positive limit price and click **SELL N AAPL · Limit**.
5. **Verify:** Drawer closes, a new "pending" limit order shows on the Orders page Working tab.

- [ ] **Step 6: Empty-state path**

1. Use the Account page Reset to clear positions, or manually create a state where the position exists but no buy orders are in `portfolio.history` (less likely in normal flow — this primarily verifies the aggregate-fallback rendering when it ever fires).
2. If you cannot reproduce naturally, open `frontend/src/lib/lotView.ts` in your dev tools and confirm via React devtools that `aggregateFallback: true` flows when `portfolio.history` is empty for the symbol.

- [ ] **Step 7: Long + short coexistence (optional, if your account state supports it)**

1. With a long position open, place a `short` order on the same ticker.
2. Open the drawer.
3. **Verify:** Two stacked sections render — Long lots (with Sell) and Short lots (with Cover) — each with its own footer, totals, and submit button. Selection in one section does not affect the other.

- [ ] **Step 8: Theme + close affordances**

1. Toggle dark mode via the existing theme switch.
2. **Verify:** Drawer respects the theme (background, borders, accent, gain/loss colors).
3. Close the drawer via:
   - Clicking the ✕ icon
   - Clicking the backdrop
   - Pressing Escape
   **Verify:** All three close it.

- [ ] **Step 9: Top movers untouched**

1. Click a ticker on the Top movers card on the Portfolio Overview tab.
2. **Verify:** Old behavior preserved — navigates to the Trade page, drawer does not open.

- [ ] **Step 10: Mark this task complete**

If every step above passed, mark this task complete. If any step failed, file a follow-up under `docs/superpowers/specs/` describing what didn't match the spec, and DO NOT mark this task complete until the gap is closed.

> **Note for the executor:** No commit for this task — it produces no file changes.

---

## Self-review

I checked the plan against the spec. Coverage:

| Spec section | Covered by |
|---|---|
| §2 Data sources (reuse `replayFifo`) | Task 1 (`getLotRows`) |
| §3.1 Trigger on Positions table symbol cell only | Task 4 |
| §3.2 Drawer layout (stat row + per-side sections) | Task 3 (`PositionDetailDrawer`) + Task 7 (CSS) |
| §3.3 Default selection = all on | Task 3 (`useEffect` reseed on ticker change) |
| §3.4 Market/Limit toggle, market-clock gate | Task 2 (`LotTable`) + Task 3 (uses `useMarketClock`) |
| §3.5 Selection-as-intent, one combined order | Task 3 (`submitFor` builds one `placeOrder` call) |
| §3.6 Aggregate fallback when history empty | Task 1 (synthesizes one row) + Task 3 (forwards `notice`) |
| §3.7 Drawer auto-closes on submit | Task 3 (calls `onClose()` on success) |
| §4 Column spec exact | Task 1 (computes columns) + Task 2 (renders header in spec order) |
| §5 New / modified files | Tasks 1-7 |
| §6 Data flow incl. selection-prune on lot vanish | Task 3 (`pruneSelection` effect) |
| §7 Error handling: try/catch, ERROR logging | Task 1 (`getLotRows` catch) + Task 3 (`submitFor` catch) |
| §8 Testing | Task 8 (manual smoke — repo has no test runner) |

Type consistency check: `LotRow` is defined once in Task 1 and consumed by Tasks 2 and 3 with the same property names. `LotRowsResult.failed` flows from Task 1 to Task 3 with the same name. `OrderType` is the existing union from `lib/types`, used identically in `LotTable` props and `SideState`. No drift.

No placeholders. No "TBD". No "implement later". Every code step shows the actual code.
