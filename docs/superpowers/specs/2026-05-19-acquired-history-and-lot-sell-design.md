# Acquired History drawer + lot-aware Sell — Design

**Date:** 2026-05-19
**Status:** Approved (brainstorming) → ready for implementation plan
**Scope:** Frontend only. No backend, schema, or API changes.

---

## 1. Goal

Replace the current "click symbol on Portfolio → navigate to Trade page" behavior with a right-hand drawer that shows the user's per-lot **Acquired History** for that symbol and lets them sell (or cover) specific lots inline.

Two tables in one view, sharing the same per-lot data:

- An **Acquired History** view (read-only columns).
- A **Lot picker** with a checkbox per row, an inline Market/Limit toggle, and a Sell/Cover footer.

Per the user's brief, the two tables must be derived from the same source so they cannot diverge.

---

## 2. Data sources (no schema changes)

The frontend already has FIFO lot reconstruction in `frontend/src/lib/pnl.ts`. Its module comment explicitly anticipates the lot-picker use case:

> "TradeTicket lot picker — needs the *current* open lots for a symbol so the user can pick which to close."

We reuse it. No new endpoints, no new tables, no migrations.

| What | Where it comes from |
|---|---|
| Open lots per ticker | `replayFifo(portfolio.history, portfolio.positions).openLots.get(ticker)` |
| Live mark price | `market[ticker].price` (already piped in via `useMarket`) |
| Aggregate fallback (when history is pruned) | `portfolio.positions.find(p => p.ticker === T && p.side === S)` → synthesize a single `Lot` |

---

## 3. UX behavior

### 3.1 Trigger

- Clicking the **ticker text** in the Portfolio Positions table (both the Overview "Top positions" preview and the Positions tab) opens the drawer.
- The existing `Add` and `Close` buttons in those tables are not changed; they still open the Trade modal as today.
- "Top movers" and other symbol click targets elsewhere in the app are out of scope.

### 3.2 Drawer layout (one section per side that has lots)

```
┌────────────────────────────────────────────┐
│ AAPL    $401.97              [✕]           │
├──────────┬──────────┬──────────┬───────────┤
│ Total qty│Mkt value │ Avg cost │Unrealized │
│   208    │ $83,633  │ $321.21  │ +$15,790  │
├──────────┴──────────┴──────────┴───────────┤
│ Long lots · 6 open                  [LONG] │
│ ☑ Acquired               Term  $G/L  Qty…  │
│ ☑ Apr 09, 2026 09:31 AM Short +$2,753  50  │
│ ☑ Jun 26, 2025 02:14 PM Short +$2,132  30  │
│ …                                          │
│                                            │
│ Order: [Market|Limit]   Limit price: ____  │
│ Qty: 168 · Est. proceeds $67,531  [SELL…]  │
├────────────────────────────────────────────┤
│ Short lots · 0 open  (section omitted)     │
└────────────────────────────────────────────┘
```

If a symbol has both a long and a short position open, both sections render stacked, each with its own footer/submit. A user cannot mix sides in one submit.

### 3.3 Default selection

All lots in a section are pre-checked when the drawer opens (matches the second table in the user's brief). Footer totals reflect the selected subset only. A header checkbox toggles "select all / none" for that section.

### 3.4 Order type

The footer exposes the same Market/Limit choice as the existing `TradeForm`:

- **Market** — submitted with no `limitPrice`. Disabled when the market clock reports closed (mirrors existing `TradeForm` behavior).
- **Limit** — reveals a price input seeded from the current `market[ticker].price`; submit disabled until value > 0.

Stop / trailing-stop / conditional are out of scope for the drawer (they can be initiated from the existing Trade flow as before).

### 3.5 Lot-selection semantics — selection-as-intent

We submit **one combined order** with the summed quantity from the user's selected lots. The backend does not know about specific lots; the existing FIFO algorithm continues to drain oldest-first.

Consequence: the drawer's footer shows realized P&L computed against the *selected* lots (specific-lot accounting), while the global Orders page continues to show FIFO-reconstructed P&L. This is intentional. We add a small note next to the footer P&L: *"Specific-lot view"*.

### 3.6 Empty-lot fallback

When `replayFifo` produces no lots for a side that has a `Position` row (history pruned past `HISTORY_LIMIT = 1000`, or any other cause), the drawer synthesizes one aggregate row from the position:

```ts
{
  openOrderId: `agg-${position.id}`,
  ticker, side,
  costPerShare: position.avgPrice,
  qty: position.qty,
  openedAt: position.openedAt,
  aggregateFallback: true
}
```

The table shows that single row with a footer note: *"Detailed lot history is unavailable; showing aggregate position."* The user can still sell from it.

### 3.7 After a successful sell

`placeOrder` returns; `usePortfolio` replaces `portfolio` state; lot rows recompute. Drawer closes (matches `TradeForm.onDone`). User can re-open from Portfolio.

---

## 4. Column spec

The Acquired History header reads exactly:

| Column | Source / formula |
|---|---|
| Acquired | `Intl.DateTimeFormat` in user's local TZ, single line `"Mon DD, YYYY HH:MM AM/PM"` |
| Term | `now - lot.openedAt < 365d` → `Short`, else `Long` |
| $ Total gain/loss | Long: `(market.price - lot.costPerShare) * lot.qty`. Short: `(lot.costPerShare - market.price) * lot.qty` |
| % Total gain/loss | `$ G/L ÷ (lot.qty * lot.costPerShare) × 100` |
| Current value | Long: `lot.qty * market.price`. Short: `lot.qty * lot.costPerShare` |
| Quantity | `lot.qty` |
| Average cost basis | `lot.costPerShare` |
| Cost basis total | `lot.qty * lot.costPerShare` |

The lot-picker variant adds a leading `Selected` checkbox column and an `Unrealized G/L` column (same formula as `$ Total gain/loss`). The two views share the same `LotRow` data model so they cannot drift.

---

## 5. Components & files

### New
- `frontend/src/components/PositionDetailDrawer.tsx` — drawer container. Props: `ticker`, `market`, `portfolio`, `placeOrder`, `onClose`. Owns selection / order-type / limit-price state. Renders one `LotTable` per non-empty side.
- `frontend/src/components/LotTable.tsx` — pure presentation. Props: `rows`, `side`, `selectedIds`, `onToggle`, `onToggleAll`, `orderType`, `setOrderType`, `limitPrice`, `setLimitPrice`, `marketIsOpen`, `onSubmit`, `submitting`, `error`. No data fetching.
- `frontend/src/lib/lotView.ts` — adapter on top of `replayFifo`. Exports:
  ```ts
  export interface LotRow extends Lot {
    term: 'Short' | 'Long';
    currentValue: number;
    unrealizedAbs: number;
    unrealizedPct: number;
    costBasisTotal: number;
    aggregateFallback?: true;
  }
  export function getLotRows(
    portfolio: Portfolio,
    ticker: string,
    market: Market,
  ): { long: LotRow[]; short: LotRow[]; aggregate: boolean };
  export function formatAcquired(epochMs: number): string;
  ```

### Modified
- `frontend/src/pages/PortfolioPage.tsx` — accept `onOpenLots: (ticker: string) => void`. Replace the symbol-cell `onClick={() => onNavigate('trade', p.ticker)}` calls (Top positions table ~line 354, Positions tab table ~line 442) with `onOpenLots(p.ticker)`. Add/Close buttons untouched.
- `frontend/src/components/PageRouter.tsx` — thread `onOpenLots` through to `PortfolioPage`.
- `frontend/src/App.tsx` — add `activeLotTicker` state; pass setter to PageRouter; render `<PositionDetailDrawer ticker={activeLotTicker} ... onClose={() => setActiveLotTicker(null)} />` at the same level as `ModalStack`.
- `frontend/src/index.css` — add `.lot-drawer*` styles using existing tokens (`--accent`, `--border`, `--bg-elev`, `--up`, `--down`, etc.) so dark mode comes along for free.

### Untouched
`TradeForm.tsx`, `TradeTicket.tsx`, `lib/pnl.ts`, all of `backend/`, all of `shared/`.

---

## 6. Data flow

1. **Open** — Click ticker → `App.activeLotTicker = 'AAPL'` → drawer mounts → `getLotRows()` runs → all checkboxes default on.
2. **Live tick** — `market[ticker].price` updates → memoized rows recompute → `$/% G/L` and `Current value` cells update; selection preserved.
3. **External fill** (rare during sell flow) — `portfolio.history` changes → rows recompute. If a previously-selected lot id no longer exists, we drop it from `selectedIds`.
4. **Submit** — `placeOrder({ ticker, side, type, qty, tif: 'day', limitPrice? })`. Same shape `TradeForm` already submits.
5. **After success** — `portfolio` replaces atomically → drawer closes via `onClose()`. If the user wants to act again they re-open from Portfolio.

### Pre-submit guards (reuse what TradeForm enforces today)
- Selected qty > 0
- Market + market closed → disable, show clock note (reuse `useMarketClock`)
- Limit + limitPrice ≤ 0 → disable
- Cover (cash-out) + estimated cost > buying power → disable + warning

---

## 7. Error handling (per CLAUDE.md "Never fail silently")

### `lib/lotView.ts`
- `getLotRows` body wrapped in `try/catch`. On exception: `console.error('ERROR getLotRows failed', { ticker, err })`; return `{ long: [], short: [], aggregate: false }` plus a flag the drawer surfaces as an inline warning.
- Per-row defensive validation (`qty > 0`, `costPerShare > 0`); malformed rows are skipped with `console.warn('WARN getLotRows skipping malformed lot', { ticker, lot })`.

### `PositionDetailDrawer.tsx`
- Wrapped in an ErrorBoundary so a render exception shows a fallback "Couldn't render lot history for AAPL." card instead of crashing the app.
- Submit handler `try/catch`es around `placeOrder`. Failures: `console.error('ERROR PositionDetailDrawer submit failed', { ticker, side, qty, type, err })` and inline red banner ("Couldn't place order: …"). Drawer stays open; selection preserved; user can retry.
- In-flight UI: Sell button disabled with spinner until the promise resolves.

### Reused mechanisms
- `replayFifo`'s existing pruned-history fallback (uses `position.avgPrice` for the orphan tail) is preserved.
- Backend error envelopes (e.g. insufficient buying power on cover) bubble through `usePortfolio` exactly as they do for the existing trade flow.

No empty `catch {}`, no swallowed rejections, no `null`-returns without logging.

---

## 8. Testing

### Unit — `frontend/src/lib/lotView.test.ts`
- Three filled buys → 3 rows; cost basis correct; G/L matches mock `market.price`.
- Term boundary: lot opened at `now - 365d` → Long; at `now - 364d` → Short; future-dated → Short.
- Pruned history → exactly one aggregate row with `aggregateFallback: true`.
- Mixed long + short → both arrays populated; short G/L sign correct.
- Date format: structure of the returned string (`/^[A-Z][a-z]{2} \d{2}, \d{4} \d{2}:\d{2} (AM|PM)$/`) — TZ-agnostic.

### Component — `frontend/src/components/PositionDetailDrawer.test.tsx` (RTL)
- Open → all rows pre-selected → footer shows summed qty + summed G/L.
- Uncheck a row → footer recomputes.
- Market → Limit toggle reveals input; Sell disabled until positive price.
- Submit → `placeOrder` called once with correct shape (one combined order, summed qty, type, optional `limitPrice`).
- Submit failure → error banner shows, drawer stays open, selection preserved.
- Short section appears only when short lots exist; submitting from it issues `cover`, not `sell`.

### Manual smoke (dev server, before declaring done)
1. Multiple buys at different prices → drawer rows match Orders history, totals tally with the live tick.
2. Uncheck oldest lot, Sell Market → Orders page shows one `sell` row with the correct (summed-unchecked-aware) qty.
3. Open a short on the same ticker → both sections render; sell from each independently.
4. Empty-state: position with no replayable lots → aggregate fallback row + disclosure note.
5. Light + dark theme — drawer styling uses existing tokens so dark mode is free.

---

## 9. Out of scope

- Backend lot tracking / true specific-lot accounting (rejected as Approach C in brainstorming; would require a `lots` table and migrations).
- Stop/trailing-stop/conditional from the drawer (existing Trade modal still handles those).
- Top movers / Watchlist / Trade page click targets (untouched).
- Closed lots / trade journal view (rejected scope; only currently-open lots render).
- Multi-symbol lot views.

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Drawer P&L (specific-lot) and Orders page P&L (FIFO) disagree | Deliberate per user direction. Surface "Specific-lot view" note in the drawer footer; keep the global Orders page view canonical. |
| `replayFifo` is O(N + Σ pops) per render | Memoize the call in the drawer keyed on `portfolio.history`, `portfolio.positions`, `market[ticker]`. The same memoization pattern is already used in `OrdersPage`. |
| User clicks ticker on a symbol with no `Position` row at all | `getLotRows` returns `{ long: [], short: [], aggregate: false }` → drawer renders empty-state "No open shares of AAPL." with a Close button. |
| Live tick during selection | Selection set is keyed by `lot.openOrderId`, which is stable across recomputes. Tick changes price columns, not selection. |
| Submit fails mid-flight | Banner + retry; drawer remains open with selection preserved. |
