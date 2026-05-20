# Page Redesign — 5-Page Consolidation

**Date:** 2026-05-18
**Author:** wchb (drafted with Claude)
**Status:** Approved by user (sections 1–5)

## Goal

Consolidate the app to five pages: **Portfolio, Watchlist, Trade, Alerts, Account.** Eliminate duplication between Positions and Portfolio, surface "set alert" as a first-class action on the Watchlist, and let the Trade page operate on any symbol — not only watchlist symbols.

## Out of scope

- Visual token redesign (colors, spacing, typography). The current visual language is kept.
- Migration to `react-router`. The custom `PageRouter` in `App.tsx` is kept; URLs remain non-deep-linkable.
- Mobile-responsive overhaul. Current responsive behavior is preserved.

## Architectural choice

**Approach 1 — surgical edits.** Smallest blast radius. All work happens inside the existing `PageRouter` model. No new dependencies.

---

## Section 1 — Navigation & page map

Sidebar (`frontend/src/components/Sidebar.tsx`) becomes:

```
Portfolio       (was "Dashboard"; route key: dashboard → portfolio)
Watchlist       (unchanged)
Trade           (was "Detail";    route key: detail → trade)
Alerts          (unchanged; red-dot badge when triggered alerts unread)
─── Settings ───
Account
```

**Removed pages:** `PositionsPage.tsx`, `OrdersPage.tsx`. Their nav entries are removed and the files are deleted.

**Route key renames:** `dashboard` → `portfolio`, `detail` → `trade`. Update the `PageRouter` page-key union in `App.tsx`, every `setPage(...)` callsite, and any default page reference. The default page becomes `portfolio`.

**Alerts badge.** Sidebar's Alerts item shows a red dot when there are triggered alerts with `acknowledgedAt == null`. The badge clears when the user visits the Alerts page (see Section 5 for the acknowledged-at mechanism).

---

## Section 2 — Portfolio page (`DashboardPage.tsx` → `PortfolioPage.tsx`)

Three tabs: **Overview | Positions | History.**

- **Overview** — exactly today's Dashboard content: cash, equity, P&L chart with 1M / 3M / 1Y range, top positions with sparklines. No content removed.
- **Positions** — the table from the deleted `PositionsPage.tsx` is moved here verbatim: symbol, qty, avg cost, market value, unrealized P&L, close/add buttons. Row "Trade" buttons keep working (open ticket modal).
- **History** — filled-order history from the deleted `OrdersPage.tsx`, **filled orders only**. Columns: symbol, side, qty, fill price, time. Working orders are not on Portfolio — they live on the Trade page next to the ticket (Section 4).

Tab state is local component state. No URL persistence (custom router is kept).

---

## Section 3 — Watchlist page (`WatchlistPage.tsx`)

Row layout (text buttons, option A from brainstorming):

```
Symbol | Last | Change | Today | Actions: [Trade] [Alert] [Remove]
```

**Behavior:**

- **Symbol click** — navigates to Trade page with that symbol selected (today's behavior, kept).
- **Trade button** — opens existing `TradeTicket` modal with `{ ticker, side: "buy" }` (today's behavior, kept).
- **Alert button** — *new.* Opens existing `NewAlertModal` with `ticker` pre-filled, via `setAlertCtx({ ticker })`. Modal already supports arbitrary tickers, so no modal change is needed.
- **Remove button** — unchanged.

**Not changing:** add/remove-symbol controls at the top of the page; columns; sparkline rendering; no per-symbol alert-count badge; no dedicated Alerts column.

---

## Section 4 — Trade page (`DetailPage.tsx` → `TradePage.tsx`)

Layout: **two-column grid.** Left rail ~200px wide; right pane fills remaining width.

### Left rail (new)

- **Search input** at the top. Type any ticker; on Enter or selection, the right pane updates. Validates with the existing `TICKER_RE` regex; rejects unknown formats (inline error).
- **Watchlist** section — list of watchlist symbols. Click loads symbol on the right; active symbol highlighted.
- **Recent** section — last 5 symbols viewed in this browser, persisted to `localStorage` under a single key (e.g., `paperTradePro.recentSymbols`). Click loads symbol.

### Right pane

The right pane stacks the existing chart + ticket plus three new cards. Order, top to bottom:

1. **Header.** Symbol + name, last price, day %.
2. **Chart.** 1D / 1W / 1M / 3M range toggles. Unchanged from today's DetailPage.
3. **Position card** *(new on this page).* Qty, avg cost, market value, unrealized P&L for the active symbol. Empty state: "No position in AAPL." Source: same positions data the Positions tab uses (no new fetch).
4. **Order ticket.** Unchanged from today's DetailPage.
5. **Working orders for this symbol** *(new — folded in from removed Orders page).* Open / working orders for the active symbol with cancel button. Filtered client-side from the orders store. Empty state hidden when zero rows.
6. **Alerts panel for this symbol** *(new).* Active alerts for this symbol; "+ New alert" opens `NewAlertModal` pre-filled with the ticker. Each row has a delete (✕). Empty state: "No alerts on AAPL."

### State

Active symbol lives in `TradePage` local state, seeded from the `ticker` prop the router passes. Switching via the rail updates local state in place — the user does not leave the page.

---

## Section 5 — Alerts page + cleanup

### Alerts page (`AlertsPage.tsx`)

Active / Triggered tabs, distance-to-trigger, toggle / delete are kept. Two additions:

- **Symbol click → Trade page.** Clicking the symbol cell navigates to TradePage with that symbol selected. Consistent with Watchlist row symbol-click.
- **Sidebar badge from triggered-alerts unread count.** Each triggered alert gets a nullable `acknowledgedAt` field. The sidebar badge counts triggered alerts where `acknowledgedAt IS NULL`. Visiting the Alerts page sets `acknowledgedAt = now()` for all triggered alerts (single bulk write on mount of the Triggered tab; idempotent). Storage column on the existing alerts row.

### Account page (`AccountPage.tsx`)

Unchanged.

### File / code changes

- **Rename:** `DashboardPage.tsx` → `PortfolioPage.tsx`, `DetailPage.tsx` → `TradePage.tsx`.
- **Delete:** `PositionsPage.tsx`, `OrdersPage.tsx`.
- **Edit:** `App.tsx` (page-key union, route map, default page = `portfolio`); `Sidebar.tsx` (nav items + badge); `WatchlistPage.tsx` (Alert button per row); `AlertsPage.tsx` (clickable symbol + acknowledged-at acknowledge-on-view).
- **Backend:** add `acknowledged_at timestamptz NULL` to the alerts table; add endpoint `POST /alerts/acknowledge` that sets `acknowledged_at = now()` for all the user's triggered alerts where it is currently `NULL`. Additive only — existing rows default to `NULL` and stay equivalent to today.

### Error handling (project Golden Rule compliance)

- All new fetches log to `console.error` with the original error object and stack trace, plus an operation tag (e.g., `acknowledgeAlerts`, `searchSymbol`).
- The acknowledge endpoint and symbol search show a toast on failure in addition to the log.
- No silent catches; no swallowed promise rejections; no generic returns of `null` / `undefined` from failed paths.

---

## Open questions

None at design time — all clarifying questions were resolved during brainstorming.
