# LotSellPanel reuse + Trade page "By lot" tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the per-side lot picker from `PositionDetailDrawer` into a standalone `LotSellPanel` component, then mount it as a "By lot" tab in the Trade page's "Place order" card so users can pick specific lots without leaving the Trade page.

**Architecture:** `LotSellPanel` is self-contained — it owns its own selection / order-type / limit-price / submit-error state and renders `<LotTable>`. Both `PositionDetailDrawer` (which keeps its outer chrome) and `TradePage` mount one or two `LotSellPanel` instances. No shared modal between pages; the panel is a unit and each page is its own container. No backend, schema, or API changes.

**Tech Stack:** React 19 + TypeScript + Vite. No test runner installed (verified during the prior plan); verification = `npx tsc -b` + `npx eslint <touched-file>` + `npm run build` after the final task. Manual smoke at the end.

**Spec:** `docs/superpowers/specs/2026-05-19-lot-sell-panel-trade-tab-design.md`

---

## File Structure

### New
- `frontend/src/components/LotSellPanel.tsx` — self-contained per-side panel. Owns `selected: Set<string>`, `orderType`, `limitPrice`, `submitting`, `submitError`. Computes `effectiveSelected` via `intersectIds`. Renders `<LotTable>`. Submits one combined order through `placeOrder` and calls `onAfterSubmit` on success.

### Modified
- `frontend/src/components/PositionDetailDrawer.tsx` — drop the per-side `SideState`, `setLongState`/`setShortState`, `effectiveLongSelected`/`effectiveShortSelected`, `submitFor`, `intersectIds`, the helper `SideSlot`. Replace with `<LotSellPanel onAfterSubmit={onClose} />` per side. Drawer keeps the chrome (header, 4-stat strip, failed/empty warnings) and the memoized `getLotRows` call.
- `frontend/src/pages/TradePage.tsx` — add `tradeMode: 'quick' | 'byLot'` state, reset to `'quick'` when `activeTicker` changes; add segmented tab strip in the "Place order" card; render `<TradeForm>` for `quick` and one or two `<LotSellPanel>` for `byLot`.
- `frontend/src/index.css` — add a small style block for the tab strip + the inter-panel divider on Trade page.

### Untouched
- `frontend/src/components/LotTable.tsx`
- `frontend/src/lib/lotView.ts`
- `frontend/src/lib/pnl.ts`
- All of `backend/`, all of `shared/`.

---

## Task 1: Create `LotSellPanel.tsx` (extraction-ready)

**Files:**
- Create: `frontend/src/components/LotSellPanel.tsx`

The panel mirrors what `SideSlot` does today inside `PositionDetailDrawer.tsx:321-390`, but owns its own state instead of receiving it via props. Build it standalone first; later tasks plug it into the Drawer and the Trade page.

- [ ] **Step 1: Create the file with full implementation**

Write `frontend/src/components/LotSellPanel.tsx`:

```tsx
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
```

- [ ] **Step 2: Type-check**

Run from `frontend/`:
```bash
cd frontend && npx tsc -b
```
Expected: exit 0, no diagnostics.

- [ ] **Step 3: Lint the new file**

```bash
npx eslint src/components/LotSellPanel.tsx
```
Expected: exit 0, no errors.

> **If lint complains about `react-hooks/set-state-in-effect`** on the second `setState` inside the reseed effect: the inline `eslint-disable-next-line` is already in place. If it instead warns *"Unused eslint-disable directive"*, remove that comment. The matching pattern is the same two-step we resolved during the previous plan.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/LotSellPanel.tsx
git commit -m "feat(portfolio): extract LotSellPanel from PositionDetailDrawer"
```

---

## Task 2: Refactor `PositionDetailDrawer` to consume `LotSellPanel`

**Files:**
- Modify: `frontend/src/components/PositionDetailDrawer.tsx`

Drop everything that `LotSellPanel` now owns. The Drawer keeps the header, stat strip, failed/empty warnings, and the memoized `getLotRows` call.

- [ ] **Step 1: Replace the entire file body**

Overwrite `frontend/src/components/PositionDetailDrawer.tsx` with:

```tsx
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
          <section className="lot-section">
            <header className="lot-section-head">
              <h4>
                Long lots{' '}
                <span className="lot-section-count">
                  · {lotRowsResult.long.length} open
                </span>
              </h4>
              <span className="pill long">LONG</span>
            </header>
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
          </section>
        )}

        {lotRowsResult.short.length > 0 && (
          <section className="lot-section">
            <header className="lot-section-head">
              <h4>
                Short lots{' '}
                <span className="lot-section-count">
                  · {lotRowsResult.short.length} open
                </span>
              </h4>
              <span className="pill short">SHORT</span>
            </header>
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
          </section>
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
```

> **Heads up for the executor:** The Drawer used to render the section header (`Long lots · N open`, `LONG` pill) inside `LotTable` via `SIDE_COPY`. `LotTable` still does this — but on the Trade page the section header would duplicate the "Place order" / "By lot" tab heading. So the Drawer now wraps each panel in a `<section class="lot-section">…<header class="lot-section-head">…` itself. **Don't** remove `LotTable`'s own header; both surfaces use the inner header from `LotTable`. This outer wrapper exists only because `lot-section` styling (border-bottom between long/short blocks) was previously applied via `LotTable`'s root `<section>`. The CSS already targets `.lot-section`, so this rendering keeps the same visual frame.
>
> If on closer inspection the duplicated `Long lots · N open` heading appears (one from the wrapper here, one from `LotTable`'s `<section class="lot-section">`), remove the wrapper `<section>...<header>...</header>` block and let `LotTable` own its frame. Only the wrapper `<header>` is decorative; no behavior depends on it.

- [ ] **Step 2: Type-check**

```bash
npx tsc -b
```
Expected: exit 0.

- [ ] **Step 3: Lint**

```bash
npx eslint src/components/PositionDetailDrawer.tsx
```
Expected: exit 0, no errors.

- [ ] **Step 4: Build**

```bash
npm run build
```
Expected: exit 0; bundle sizes roughly match the previous build (a few KB swing is fine).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PositionDetailDrawer.tsx
git commit -m "refactor(portfolio): drawer uses LotSellPanel"
```

---

## Task 3: Add the "By lot" tab to `TradePage`

**Files:**
- Modify: `frontend/src/pages/TradePage.tsx`

- [ ] **Step 1: Add imports**

Open `frontend/src/pages/TradePage.tsx`. After the existing import block (lines 1-19), add:

```tsx
import { LotSellPanel } from '../components/LotSellPanel';
import { getLotRows } from '../lib/lotView';
```

Place `LotSellPanel` next to the other component imports (after `import { TradeForm } from '../components/TradeForm';`) and `getLotRows` next to the other lib imports (after `import { fmtLocalTime, fmtMoney, fmtPct } from '../lib/format';`). The exact ordering doesn't matter for correctness; just keep neighbors together for diff readability.

- [ ] **Step 2: Add the tab state + ticker-reset effect**

Find the local-state block (lines 65-94 — the section starting with `const [formSide, setFormSide] = useState<OrderSide>('buy');`).

Add a new `useState` directly after `const [formSide, setFormSide] = useState<OrderSide>('buy');`:

```tsx
  const [tradeMode, setTradeMode] = useState<'quick' | 'byLot'>('quick');
```

Then, inside the existing `useEffect(() => { setActiveTicker(ticker); }, [ticker])` block (lines 75-78), add a second statement so the tab also resets when the ticker changes externally:

Find:
```tsx
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveTicker(ticker);
  }, [ticker]);
```

Replace with:
```tsx
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveTicker(ticker);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTradeMode('quick');
  }, [ticker]);
```

Then, inside `switchTo` (lines 96-108), add a tab reset after `setActiveTicker(sym);`:

Find:
```tsx
  const switchTo = (sym: string) => {
    setActiveTicker(sym);
    onNavigate('trade', sym);
```

Replace with:
```tsx
  const switchTo = (sym: string) => {
    setActiveTicker(sym);
    setTradeMode('quick');
    onNavigate('trade', sym);
```

- [ ] **Step 3: Compute lot rows for the active ticker (after `m` is defined)**

After the `if (!m) { return … }` block ends (around line 236) but before `const chartPoints = …`, add:

```tsx
  // Lot rows for the "By lot" tab. Memoized on history/positions/markPrice so
  // it only recomputes when something the panel actually displays changes.
  const lotRowsResult = useMemo(
    () => getLotRows(portfolio, activeTicker, market),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTicker, portfolio.history, portfolio.positions, m.price],
  );
```

> Note: `useMemo` is already imported via `useState`/`useEffect`. If the import statement does not include `useMemo`, change `import { useEffect, useState, type ReactNode } from 'react';` to `import { useEffect, useMemo, useState, type ReactNode } from 'react';`.

- [ ] **Step 4: Replace the "Place order" card body with a tabbed view**

Find this block (lines 598-612):

```tsx
            <div className="card" id="trade-form-card">
              <div className="card-header">
                <h3 className="card-title">Place order</h3>
              </div>
              <div className="card-body">
                <TradeForm
                  ticker={activeTicker}
                  market={market}
                  portfolio={portfolio}
                  placeOrder={placeOrder}
                  initialSide={formSide}
                  layout="panel"
                />
              </div>
            </div>
```

Replace with:

```tsx
            <div className="card" id="trade-form-card">
              <div className="card-header">
                <h3 className="card-title">Place order</h3>
                <div className="segmented trade-mode-tabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tradeMode === 'quick'}
                    className={tradeMode === 'quick' ? 'active' : ''}
                    onClick={() => setTradeMode('quick')}
                  >
                    Quick trade
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tradeMode === 'byLot'}
                    className={tradeMode === 'byLot' ? 'active' : ''}
                    onClick={() => setTradeMode('byLot')}
                  >
                    By lot
                  </button>
                </div>
              </div>
              <div className="card-body">
                {tradeMode === 'quick' ? (
                  <TradeForm
                    ticker={activeTicker}
                    market={market}
                    portfolio={portfolio}
                    placeOrder={placeOrder}
                    initialSide={formSide}
                    layout="panel"
                  />
                ) : (
                  <ByLotView
                    ticker={activeTicker}
                    market={market}
                    placeOrder={placeOrder}
                    rows={lotRowsResult}
                  />
                )}
              </div>
            </div>
```

- [ ] **Step 5: Add the `ByLotView` helper at the bottom of the file**

After the `filterRegularHours` function at the end of the file, add:

```tsx
import type { LotRow } from '../lib/lotView';

interface ByLotViewProps {
  ticker: string;
  market: Market;
  placeOrder: (order: PlaceOrderInput) => void;
  rows: {
    long: LotRow[];
    short: LotRow[];
    aggregate: boolean;
    failed: boolean;
  };
}

function ByLotView({ ticker, market, placeOrder, rows }: ByLotViewProps) {
  if (rows.failed) {
    return (
      <div className="lot-warn">
        Lot history unavailable for {ticker}. Use Quick trade to manage this
        position.
      </div>
    );
  }

  if (rows.long.length === 0 && rows.short.length === 0) {
    return (
      <div className="trade-bylot-empty">
        No open shares of {ticker}. Open a position from{' '}
        <span style={{ fontWeight: 600 }}>Quick trade</span> to use lot
        selling.
      </div>
    );
  }

  return (
    <div className="trade-bylot">
      {rows.long.length > 0 && (
        <section className="lot-section">
          <header className="lot-section-head">
            <h4>
              Long lots{' '}
              <span className="lot-section-count">
                · {rows.long.length} open
              </span>
            </h4>
            <span className="pill long">LONG</span>
          </header>
          <LotSellPanel
            ticker={ticker}
            side="long"
            rows={rows.long}
            aggregateFallback={rows.long.some((r) => r.aggregateFallback)}
            market={market}
            placeOrder={placeOrder}
          />
        </section>
      )}
      {rows.short.length > 0 && (
        <section className="lot-section">
          <header className="lot-section-head">
            <h4>
              Short lots{' '}
              <span className="lot-section-count">
                · {rows.short.length} open
              </span>
            </h4>
            <span className="pill short">SHORT</span>
          </header>
          <LotSellPanel
            ticker={ticker}
            side="short"
            rows={rows.short}
            aggregateFallback={rows.short.some((r) => r.aggregateFallback)}
            market={market}
            placeOrder={placeOrder}
          />
        </section>
      )}
    </div>
  );
}
```

> **Cleanup:** the new `import type { LotRow } from '../lib/lotView';` line at the bottom should be hoisted up to the import block at the top to satisfy `import/first` (eslint catches this). If your eslint config does not enforce that rule, the bottom-of-file location is fine — but the safe move is to place it next to the existing top-of-file imports. Move only this `import type` line up.

- [ ] **Step 6: Type-check + lint + build**

```bash
npx tsc -b && npx eslint src/pages/TradePage.tsx && npm run build
```
Expected: exit 0 on all three.

> **Pre-existing lint errors in `TradePage.tsx`:** none in the original baseline (verified during the prior plan; `Date.now`-purity issues are in `PortfolioPage.tsx`, not here). If new errors fire, they're from these changes — fix before committing. The same `react-hooks/set-state-in-effect` inline-disable pattern used elsewhere in this file (`setActiveTicker`, the new `setTradeMode`) is already applied.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/TradePage.tsx
git commit -m "feat(trade): add 'By lot' tab to Place order card"
```

---

## Task 4: Style the Trade page tab + by-lot container

**Files:**
- Modify: `frontend/src/index.css`

The drawer's `.lot-section` styles already exist; the Trade page reuses them. We only need a small block for the tab strip placement and the empty-state.

- [ ] **Step 1: Append the styles**

Append to the end of `frontend/src/index.css`:

```css
/* ============================================================
   Trade page — Quick trade / By lot tabs
   ============================================================ */

.trade-mode-tabs {
  font-size: 11.5px;
}
.trade-mode-tabs button {
  padding: 4px 10px;
}

.trade-bylot {
  display: flex;
  flex-direction: column;
}
.trade-bylot .lot-section {
  /* Override the drawer's bottom-border so consecutive panels stack neatly
     inside the card body without an extra full-width line at the bottom. */
  border-bottom: 1px solid var(--border);
  padding-left: 0;
  padding-right: 0;
}
.trade-bylot .lot-section:last-child {
  border-bottom: none;
}

.trade-bylot-empty {
  padding: 28px 8px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}
```

- [ ] **Step 2: Build**

```bash
npm run build
```
Expected: exit 0; CSS bundle grows by a few hundred bytes.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/index.css
git commit -m "feat(trade): style Quick trade / By lot tabs"
```

---

## Task 5: Manual smoke test

**Files:** none (verification only)

The repo has no test runner; manual smoke is the QA gate.

- [ ] **Step 1: Start the dev stack**

In one terminal:
```bash
cd backend && npm run dev
```
In a second:
```bash
cd frontend && npm run dev
```
Open the URL Vite prints (typically http://localhost:5173).

- [ ] **Step 2: Drawer regression — confirms the extraction didn't break anything**

1. Place a few buys at different prices on AAPL via the Watchlist Trade modal.
2. On Portfolio → Positions tab, click **AAPL**.
3. **Verify:** Drawer opens with header, 4-stat strip, one Long lots section. Rows show Acquired (local time), Term, $/% G/L, Qty, Avg cost, Cost basis total. All checkboxes pre-ticked.
4. Uncheck the oldest lot, click **SELL …**. **Verify:** Drawer auto-closes; Orders page shows the new sell row with the correct (unchecked-aware) qty.
5. Reopen drawer. **Verify:** Remaining lots present, drained lot is gone, all checkboxes pre-ticked again on the fresh open.

- [ ] **Step 3: Trade page — Quick trade default**

1. Navigate to the Trade page (sidebar) for the same ticker.
2. **Verify:** "Place order" card header shows the title + a `Quick trade | By lot` segmented tab strip. Default selection is `Quick trade`.
3. **Verify:** Quick trade content matches the previous TradeForm exactly (Action toggle, Unit, Order Type, Timing, Estimate, Submit).

- [ ] **Step 4: Trade page — By lot with rows**

1. Click `By lot`.
2. **Verify:** The same lot-picker UI from the Drawer renders inline in the card body. All rows ticked. Footer shows summed qty + Specific-lot view note + Sell button.
3. Watch the $/% G/L cells. **Verify:** They tick live without resetting selection.
4. Uncheck two lots, switch Order to `Limit`, type a price, click **SELL N AAPL · Limit**.
5. **Verify:** Working orders table at the bottom of the Trade page shows a new pending Limit sell with the summed qty. Tab stays on `By lot`. Selection re-defaults to all remaining lots.

- [ ] **Step 5: Trade page — switching tickers resets the tab**

1. Click a different symbol in the Trade rail (or search a new one).
2. **Verify:** Tab snaps back to `Quick trade`. (The new symbol may have no lots; auto-resetting prevents a confusing empty `By lot` view.)
3. Switch back to AAPL via the rail. **Verify:** Tab is `Quick trade` again.

- [ ] **Step 6: Trade page — By lot empty state**

1. Pick a symbol where the user has no open position (e.g. a watchlist-only ticker).
2. Click `By lot`.
3. **Verify:** Empty-state copy renders: *"No open shares of {TICKER}. Open a position from Quick trade to use lot selling."*

- [ ] **Step 7: Long + short coexistence on Trade page**

1. With a long position open, place a `short` order on the same ticker via Quick trade.
2. Switch to `By lot`.
3. **Verify:** Two stacked panels render — Long lots (with Sell) and Short lots (with Cover). Each footer is independent. Submitting from one does not touch the other.

- [ ] **Step 8: Theme parity**

1. Toggle dark mode.
2. **Verify:** The tab strip, the row backgrounds, the section dividers, and the empty-state respect the theme tokens (no light-mode whites bleeding through).

- [ ] **Step 9: Top movers untouched**

1. Click a Top movers ticker on the Portfolio Overview tab.
2. **Verify:** Old behavior preserved — navigates to the Trade page (default `Quick trade`); the lot Drawer does NOT open.

- [ ] **Step 10: Mark this task complete**

If every step passed, mark this task complete. If any step failed, capture the failure (which step, what you saw, what you expected) and stop — don't mark complete.

> **Note:** No commit for this task — it produces no file changes.

---

## Self-review

I checked the plan against the spec.

| Spec section | Covered by |
|---|---|
| §2 Architecture: extract `LotSellPanel`, drawer keeps chrome | Tasks 1 + 2 |
| §3 Components & files: new + modified file list | Tasks 1, 2, 3, 4 — exactly the files in the spec |
| §3 `LotSellPanelProps` shape | Task 1 (matches spec verbatim) |
| §4.1 Drawer behavior unchanged | Task 2 (`onAfterSubmit={onClose}` preserves auto-close); Task 5 step 2 verifies |
| §4.2 Trade page "By lot" tab in Place order card | Task 3 + Task 4 styling |
| §4.2 Empty-state: *"No open shares of {ticker}. Open a position from Quick trade to use lot selling."* | Task 3, exact copy in `ByLotView` |
| §4.3 Tab reset on ticker change | Task 3 step 2 + step 2 in `switchTo` |
| §4.3 Tab does NOT reset on live tick | Inherent — tab state lives in `TradePage`, only changed by ticker effect or user click |
| §4.3 After successful submit on `byLot`, tab stays | Task 3 — no `setTradeMode` call in `LotSellPanel` or `ByLotView` |
| §5 Data flow | Tasks 1-3 collectively |
| §6 Error handling: try/catch, ERROR logging | Task 1 (`onSubmit` catch logs `ERROR LotSellPanel submit failed`) |
| §6 `failed` plumbing on Trade page | Task 3 (`ByLotView` reads `rows.failed`) |
| §7 Testing — tsc/eslint/build per task; manual smoke | Each task has a verify step; Task 5 is the smoke gate |

**Placeholder scan:** No "TBD", "TODO", or "implement later". Every code step shows the actual code. The only conditional language ("If lint complains…", "Cleanup: hoist this import…") is genuinely conditional guidance, not a placeholder.

**Type consistency:** `LotSellPanelProps` is defined in Task 1 and used identically in Task 2 and Task 3. `ByLotViewProps.rows` is the literal shape returned by `getLotRows` (`{long, short, aggregate, failed}`). `LotSellPanelSide` exported but unused outside Task 1 — fine, it documents the union and lets future callers import the named type.

No issues found. Plan ready.
