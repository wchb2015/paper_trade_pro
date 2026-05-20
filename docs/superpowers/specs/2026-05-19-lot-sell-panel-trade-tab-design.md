# LotSellPanel reuse + Trade page "By lot" tab — Design

**Date:** 2026-05-19
**Status:** Approved (brainstorming) → ready for implementation plan
**Scope:** Frontend only. Builds on the just-shipped Acquired History drawer.
**Builds on:** `docs/superpowers/specs/2026-05-19-acquired-history-and-lot-sell-design.md`

---

## 1. Goal

Reuse the lot-aware sell flow from `PositionDetailDrawer` on the Trade page. Users who want to pick specific lots to close shouldn't have to start from Portfolio — the same picker should live next to the Trade form.

The mechanism: extract the per-side lot-picker into a standalone `LotSellPanel` component, then mount it as a "By lot" tab in the Trade page's "Place order" card.

---

## 2. Architecture

The current `PositionDetailDrawer` already has a sub-component called `SideSlot` that renders one `LotTable` for one side and owns no state itself — it forwards everything from the drawer's `longState` / `shortState`. We promote that into a self-contained component:

- `LotSellPanel` owns its own selection / order-type / limit-price / submit-error state.
- Both the Drawer (which used to manage that state directly) and the Trade page render `<LotSellPanel ticker side market portfolio placeOrder onAfterSubmit />`.
- The Drawer keeps its outer chrome (header, 4-stat strip, empty-state, optional `failed` warning, two stacked panels for long+short).

No backend, schema, or API changes. The lot-data adapter (`lib/lotView.ts`) is reused as-is.

---

## 3. Components & files

### New
- `frontend/src/components/LotSellPanel.tsx` — self-contained panel for one side. Props:
  ```ts
  interface LotSellPanelProps {
    ticker: string;
    side: 'long' | 'short';
    rows: LotRow[];                 // pre-computed by the parent
    aggregateFallback: boolean;
    market: Market;                 // for live mark price in the footer estimate
    placeOrder: (order: PlaceOrderInput) => void;
    /** Optional callback fired after a successful synchronous submit.
     *  Drawer hosts pass onClose; Trade-page host can leave it undefined
     *  (or use it to scroll/log). */
    onAfterSubmit?: () => void;
  }
  ```
  Internally the component:
  - Holds `selected: Set<string>` (default = all row ids; reseeded when `rows` length identity changes via `useMemo` keying on row ids).
  - Holds `orderType`, `limitPrice`, `submitting`, `submitError` exactly as `SideSlot` does today.
  - Computes `effectiveSelected` via the existing `intersectIds` helper (also moved into the panel file).
  - Submits one combined order through `placeOrder`. On synchronous throw → logs ERROR, sets banner, does NOT call `onAfterSubmit`. On success → calls `onAfterSubmit` if provided.
  - Renders `<LotTable />`.

### Modified
- `frontend/src/components/PositionDetailDrawer.tsx` — drop the per-side `SideState` / `setLongState` / `setShortState` plumbing and the `submitFor` callback. Replace `<SideSlot ...>` callsites with `<LotSellPanel ...>`. Drawer state shrinks to just "what ticker is open" (already a prop). The drawer passes `onAfterSubmit={onClose}` so the close-on-submit behavior is preserved.
- `frontend/src/pages/TradePage.tsx` — add a tab strip to the "Place order" card header: `Quick trade | By lot`. `Quick trade` keeps the existing `<TradeForm />`. `By lot` renders one or two `<LotSellPanel />` instances. Owned local state: `tradeMode: 'quick' | 'byLot'`. After a switch, the tab survives a price tick but resets to `quick` when `activeTicker` changes (a new symbol may have no open lots).

### Untouched
- `frontend/src/components/LotTable.tsx` — still a pure presentational table.
- `frontend/src/lib/lotView.ts` — unchanged.
- `frontend/src/lib/pnl.ts` — unchanged.
- All of `backend/`, all of `shared/`.

---

## 4. UX behavior

### 4.1 Drawer (unchanged from user-visible perspective)

The Drawer still:
- Mounts on Portfolio symbol click.
- Shows the 4-stat strip, the failed/empty warnings, and one `LotSellPanel` per non-empty side (long / short).
- Auto-closes after a successful submit (because the Drawer passes `onAfterSubmit={onClose}`).

The Drawer's row-data computation (`getLotRows`) stays at the drawer level so both panels share one memoized result.

### 4.2 Trade page "By lot" tab

In the right rail, the existing card titled **Place order**:

- Adds two pill-style tabs at the top of the card body:
  ```
  ┌──────────────────────────────────────┐
  │ Place order                          │
  ├──────────────────────────────────────┤
  │  ◉ Quick trade   ○ By lot            │
  ├──────────────────────────────────────┤
  │  …Quick trade or By lot content…     │
  └──────────────────────────────────────┘
  ```
- `Quick trade` (default) → existing `<TradeForm layout="panel" />`.
- `By lot` →
  - If neither long nor short lots exist for `activeTicker`: empty-state copy *"No open shares of {ticker}. Open a position from Quick trade to use lot selling."*
  - If only one side has lots: render that one panel.
  - If both sides have lots: render both, stacked, with a thin divider between.

### 4.3 Tab reset rules

- Switching tickers (rail click, search, etc.) resets the tab to `quick`. Reason: the new ticker often has no open lots; a stale `byLot` tab would be a confusing empty state.
- A live price tick does NOT reset the tab.
- After a successful submit on `byLot`, the tab stays on `byLot`. The `LotSellPanel` itself reseeds its selection (since rows changed shape) but `tradeMode` is unchanged. Unlike the Drawer, the Trade page has nowhere to "close back" to.

---

## 5. Data flow

### Trade page mount sequence
1. User clicks symbol elsewhere → navigates to Trade page → `activeTicker` set.
2. Trade page renders `Quick trade` by default.
3. User clicks `By lot`:
   - `TradePage` calls `getLotRows(portfolio, activeTicker, market)` (memoized on `portfolio.history`, `portfolio.positions`, `market[activeTicker].price`).
   - Renders `<LotSellPanel side="long" rows={r.long} aggregateFallback={r.long.some(r => r.aggregateFallback)} ... />` and likewise for short.
4. User toggles checkboxes / picks Market or Limit / clicks Sell.
5. `LotSellPanel` builds one `placeOrder` call with `side: 'sell' | 'cover'`, summed qty, optional `limitPrice`. Closes optimistically on dispatch (mirrors current Drawer + TradeForm semantics).
6. `usePortfolio` refetches, `portfolio` updates, `LotSellPanel` rows recompute. Selected ids that vanished are dropped via `intersectIds`. If both sides become empty the Trade tab shows the empty-state copy.

### Drawer mount sequence (unchanged user-facing)
1. Symbol click on Portfolio → `activeLotTicker` set.
2. Drawer calls `getLotRows` once.
3. Renders 4-stat strip + per-side `<LotSellPanel onAfterSubmit={onClose}>`.
4. On submit success → `onAfterSubmit` → drawer closes.

---

## 6. Error handling (per CLAUDE.md "Never fail silently")

`LotSellPanel.submit`:
- `try` around the synchronous `placeOrder(order)` and `onAfterSubmit?.()` calls.
- `catch (err)` → `console.error('ERROR LotSellPanel submit failed', { ticker, side, qty, type, err })`, set `submitError` banner, leave `submitting=false`. Selection preserved.
- Async failures (network, 4xx) bubble through `usePortfolio.handleError` exactly as they do for `TradeForm`.

`TradePage`'s `getLotRows` call inherits the same `failed` flag plumbing as the Drawer. When `failed`, the `By lot` content shows an inline warning (mirrors the Drawer) and disables submission.

No empty `catch {}`. No swallowed rejections. No `null` returns without logs.

---

## 7. Testing

Repo has no test runner (confirmed during prior plan). Verification stays:
- `npx tsc -b` after each task — no new diagnostics.
- `npx eslint` per touched file — no new errors. Pre-existing errors in `PortfolioPage.tsx` / `App.tsx` (the `Date.now`-purity warnings and the `setMarketView` cycle-break) are out of scope.
- `npm run build` after the final task — clean.

Manual smoke at the end:
1. Drawer still opens from Portfolio click and behaves as before.
2. On Trade page, default tab is `Quick trade` showing the existing form.
3. Switch to `By lot` for a ticker with open lots → table renders with all checkboxes ticked.
4. Submit a Sell at Market → order shows in the Working/Filled order list at the bottom of the same Trade page; tab stays on `By lot`; selection re-defaults to all remaining lots.
5. Submit a Sell at Limit → working order appears.
6. Switch tickers via the left rail → `By lot` resets to `Quick trade`.
7. With long+short on the same ticker → both panels render, each with its own footer.
8. Theme switch (light ↔ dark) → both surfaces respect tokens.

---

## 8. Out of scope

- Sharing a single modal across both pages. Rejected: pages and modals are containers, the lot picker is a unit; a single modal couples surfaces unnecessarily and forces the Trade page to host extra chrome (4-stat strip duplicates the "Your position" card).
- Changing the `LotTable` columns or footer behavior.
- Backend lot tracking.
- Adding `By lot` to any other surface (Watchlist, Orders, etc.) — defer until requested.

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Drawer regression during the extraction | Drawer state shrinks; semantic behavior is identical because `onAfterSubmit={onClose}` preserves the auto-close. Manual smoke step 1 verifies. |
| Tab reset on ticker change feels surprising | Stated explicit rule; the empty-state on Trade is friendly when the new ticker has no lots, so users discover that they're now viewing the correct symbol. |
| Trade page "By lot" tab is invisible to users who don't notice the tab strip | Tabs use the existing `.segmented` styling that already appears elsewhere on the Trade page (chart range, RTH/IEX/SIP), so the visual idiom is familiar. |
| Live tick during selection on Trade page | Same mechanism as the Drawer: `getLotRows` recomputes; selection set is keyed by `lot.openOrderId` which is stable; `intersectIds` drops vanished ids. |
| Submit on Trade tab leaves the user staring at an empty state | If position fully closes, the panel renders empty-state copy with a friendly *"No open shares of {ticker}…"*. The user sees the order in the Working/Filled list below. |
