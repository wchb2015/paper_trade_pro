# Page Redesign — 5-Page Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the app to 5 pages (Portfolio, Watchlist, Trade, Alerts, Account). Remove Positions + Orders pages, add Alert quick-action to Watchlist rows, and rebuild Trade as a side-rail symbol picker plus per-symbol position/orders/alerts cards.

**Architecture:** Surgical edits inside the existing custom `PageRouter` (no `react-router`). Files are renamed (`DashboardPage → PortfolioPage`, `DetailPage → TradePage`); two pages are deleted (`PositionsPage`, `OrdersPage`); their contents are folded into Portfolio (tabs) and TradePage (per-symbol cards). The sidebar's red-dot "unread triggered alerts" badge is driven by a single `localStorage` timestamp (`lastAlertsViewedAt`) — no DB or backend changes.

**Tech Stack:** React 19 + Vite + TypeScript (custom `PageRouter`), Express + Postgres backend, vanilla CSS with CSS-var design tokens. No tests in repo today (`backend.test = "exit 1"`); verification is manual via `npm run dev` + page exercising. Frontend type-check is `npm run --prefix frontend build` (it runs `tsc -b` + Vite build); ESLint via `npm run --prefix frontend lint`.

---

## File map

**Renamed:**
- `frontend/src/pages/DashboardPage.tsx` → `frontend/src/pages/PortfolioPage.tsx` (export `PortfolioPage`)
- `frontend/src/pages/DetailPage.tsx` → `frontend/src/pages/TradePage.tsx` (export `TradePage`)

**Deleted:**
- `frontend/src/pages/PositionsPage.tsx`
- `frontend/src/pages/OrdersPage.tsx`

**Modified:**
- `frontend/src/components/Sidebar.tsx` — nav items + Alerts red-dot badge.
- `frontend/src/components/PageRouter.tsx` — switch arms updated.
- `frontend/src/App.tsx` — page-key default + persisted-state migration + new prop wiring.
- `frontend/src/lib/types.ts` — `PageKey` union narrowed.
- `frontend/src/hooks/useInterestingSymbols.ts` — references to `'detail'` page key.
- `frontend/src/pages/PortfolioPage.tsx` — three tabs (Overview / Positions / History).
- `frontend/src/pages/WatchlistPage.tsx` — `[Trade] [Alert] [Remove]` action buttons.
- `frontend/src/pages/TradePage.tsx` — left rail (search + watchlist + recent), right pane gets position card + working-orders panel + alerts panel.
- `frontend/src/pages/AlertsPage.tsx` — clickable symbol → Trade page; mark-viewed on mount.
- `frontend/src/index.css` — small additions: `.detail-layout` already exists; add `.trade-shell`, `.trade-rail`, `.trade-rail-section-label`, `.trade-rail-row`, `.trade-rail-error` (only what's actually new).

---

## Task 1: Frontend — `lib/alertsViewed.ts` localStorage helper

**Files:**
- Create: `frontend/src/lib/alertsViewed.ts`

Single-purpose helper that owns the `lastAlertsViewedAt` timestamp in `localStorage`. Exposes `getLastViewedAt()`, `markViewedNow()`, and a derived `countUnreadTriggered(alerts)`. No backend changes; no DB schema changes.

- [ ] **Step 1: Create the helper**

Create `frontend/src/lib/alertsViewed.ts`:

```ts
import type { Alert } from './types';

// Tracks "the last time the user opened the Alerts page". Anything triggered
// after this moment counts as unread and drives the sidebar's red dot.
// Stored in localStorage for cheap persistence; sync across devices is not a
// goal for a single-user paper-trading app.
const KEY = 'paperTradePro.lastAlertsViewedAt';

export function getLastViewedAt(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    console.error('ERROR getLastViewedAt failed', err);
    return 0;
  }
}

export function markViewedNow(): void {
  try {
    localStorage.setItem(KEY, String(Date.now()));
  } catch (err) {
    console.error('ERROR markViewedNow failed', err);
  }
}

/**
 * Count of triggered alerts the user has not yet seen. The sidebar's red dot
 * shows when this is > 0.
 */
export function countUnreadTriggered(alerts: Alert[]): number {
  const cutoff = getLastViewedAt();
  let n = 0;
  for (const a of alerts) {
    if (a.triggeredAt && a.triggeredAt > cutoff) n++;
  }
  return n;
}
```

- [ ] **Step 2: Type-check the frontend build**

Run:

```bash
npm run --prefix frontend build
```

Expected: exits 0. (The helper is unused at this point; consumers land in Task 10.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/alertsViewed.ts
git commit -m "feat(alerts): localStorage helper for unread-triggered tracking"
```

---



- [ ] **Step 1: Create the standalone migration file**

Create `backend/scripts/2026-05-18-alerts-acknowledged-at.sql`:

```sql
-- =============================================================================
-- Migration 2026-05-18 — alerts.acknowledged_at
--
-- Adds a nullable TIMESTAMPTZ column for the "Triggered alerts unread" sidebar
-- badge. Set to now() when the user views the Triggered tab; NULL means
-- unread. Idempotent.
--
-- Apply via:
--   psql "$DATABASE_URL" -f backend/scripts/2026-05-18-alerts-acknowledged-at.sql
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS paper_trade_pro;
SET LOCAL search_path = paper_trade_pro, public;

ALTER TABLE paper_trade_pro.alerts
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

-- Used by the sidebar badge query: count triggered, unacknowledged alerts.
CREATE INDEX IF NOT EXISTS alerts_user_unacked_idx
  ON paper_trade_pro.alerts (user_id)
  WHERE triggered_at IS NOT NULL AND acknowledged_at IS NULL;
```

- [ ] **Step 2: Mirror the change in `init-db.sql` (so a fresh init still creates the column)**

In `backend/scripts/init-db.sql`, find the alerts table block (around line 184 — `CREATE TABLE IF NOT EXISTS paper_trade_pro.alerts (`). After the existing `ALTER TABLE … ADD COLUMN IF NOT EXISTS updated_at` block (around line 203–204), add:

```sql
ALTER TABLE paper_trade_pro.alerts
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS alerts_user_unacked_idx
  ON paper_trade_pro.alerts (user_id)
  WHERE triggered_at IS NOT NULL AND acknowledged_at IS NULL;
```

(Keep the additions inside the same `SET LOCAL search_path = paper_trade_pro, public;` scope already at the top of the file.)

- [ ] **Step 3: Apply the migration to the dev database**

Run from repo root:

```bash
psql "$DATABASE_URL" -f backend/scripts/2026-05-18-alerts-acknowledged-at.sql
```

Expected output: `ALTER TABLE` then `CREATE INDEX` (or `NOTICE: relation "alerts_user_unacked_idx" already exists, skipping` on a re-run).

- [ ] **Step 4: Verify the column landed**

Run:

```bash
psql "$DATABASE_URL" -c "\d paper_trade_pro.alerts"
```

Expected: a row reading `acknowledged_at | timestamp with time zone |  |  |` appears in the column list.

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/init-db.sql backend/scripts/2026-05-18-alerts-acknowledged-at.sql
git commit -m "feat(db): add alerts.acknowledged_at for triggered-alert read state"
```

---

## Task 2: Narrow `PageKey` and rename route keys (`dashboard→portfolio`, `detail→trade`)

**Files:**
- Modify: `frontend/src/lib/types.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/Sidebar.tsx`
- Modify: `frontend/src/components/PageRouter.tsx`
- Modify: `frontend/src/hooks/useInterestingSymbols.ts`
- Modify: `frontend/src/pages/DashboardPage.tsx`
- Modify: `frontend/src/pages/DetailPage.tsx`
- Modify: `frontend/src/pages/AlertsPage.tsx`

This task is *just* the rename — no behavior changes, no new pages, no removed pages yet. After Task 5 the app still works exactly as before but with new route keys, so we land it as its own commit and verify boot.

- [ ] **Step 1: Narrow the `PageKey` union**

In `frontend/src/lib/types.ts` (around line 64–71), replace:

```ts
export type PageKey =
  | 'dashboard'
  | 'watchlist'
  | 'detail'
  | 'positions'
  | 'orders'
  | 'alerts'
  | 'account';
```

With:

```ts
export type PageKey =
  | 'portfolio'
  | 'watchlist'
  | 'trade'
  | 'positions'
  | 'orders'
  | 'alerts'
  | 'account';
```

(Note: we keep `'positions'` and `'orders'` in the union for this task only. They get removed in Task 8 when the pages are deleted. This keeps the diff small per commit.)

- [ ] **Step 2: Update App.tsx default page + persisted-state migration**

In `frontend/src/App.tsx`, replace the existing persisted-state line (line 31):

```ts
const [page, setPage] = usePersistedState<PageKey>("ptp_page", "dashboard");
```

With (note the new storage key `ptp_page_v2` so older browsers do not boot into a now-invalid `'dashboard'` value):

```ts
const [page, setPage] = usePersistedState<PageKey>("ptp_page_v2", "portfolio");
```

Also update the `setDetailTicker` line right after (line 32–35) — keep the storage key `ptp_detail` (it stores a ticker, not a page key), but rename the variable to `setActiveTradeTicker` to match new semantics throughout the file:

Replace:

```ts
const [detailTicker, setDetailTicker] = usePersistedState<string>(
  "ptp_detail",
  "AAPL",
);
```

With:

```ts
const [activeTradeTicker, setActiveTradeTicker] = usePersistedState<string>(
  "ptp_trade_ticker",
  "AAPL",
);
```

Then update every reference further down in `App.tsx`:
- Replace `detailTicker` with `activeTradeTicker` in calls to `useInterestingSymbols`, `<PageRouter detailTicker={...}` (rename the prop too — see PageRouter below), and inside `onNavigate`.
- In `onNavigate` (line 97–100), replace `setDetailTicker(ticker)` with `setActiveTradeTicker(ticker)`.

- [ ] **Step 3: Update Sidebar nav items for the rename**

In `frontend/src/components/Sidebar.tsx`, update the `navItems` array:

Replace:

```ts
{ id: "dashboard", label: "Dashboard", icon: "dashboard" },
```

With:

```ts
{ id: "portfolio", label: "Portfolio", icon: "dashboard" },
```

(Keep using the `dashboard` icon until/unless we add a new one — out of scope.) The `'positions'` and `'orders'` entries stay in this task; they are removed in Task 8.

- [ ] **Step 4: Update PageRouter switch cases + prop name**

In `frontend/src/components/PageRouter.tsx`:

a) Rename the prop in `PageRouterProps` (line 21):

```ts
  detailTicker: string;
```

becomes

```ts
  activeTradeTicker: string;
```

b) Destructure and forward the new name (line 41 and the consumer in the `case 'detail':` block):

```ts
const {
  page,
  activeTradeTicker,
  // …
} = props;
```

c) Rename the case `'dashboard'` → `'portfolio'` (line 59) and `'detail'` → `'trade'` (line 81):

Replace:

```ts
case "dashboard":
  return (
    <DashboardPage
```

With:

```ts
case "portfolio":
  return (
    <DashboardPage
```

(For now we still import `DashboardPage` — Task 7 renames the file/symbol.)

Replace:

```ts
case "detail":
  return (
    <DetailPage
      ticker={detailTicker}
```

With:

```ts
case "trade":
  return (
    <DetailPage
      ticker={activeTradeTicker}
```

Update the `case "alerts":` block's `onAdd` line (line 118):

```ts
onAdd={() => setAlertCtx({ ticker: detailTicker || "AAPL" })}
```

becomes:

```ts
onAdd={() => setAlertCtx({ ticker: activeTradeTicker || "AAPL" })}
```

- [ ] **Step 5: Update `useInterestingSymbols` to use the new page key + prop**

In `frontend/src/hooks/useInterestingSymbols.ts`:

a) Rename `detailTicker` to `activeTradeTicker` in the args interface and destructuring (line 17, 25, 37, 47).

b) Replace `if (page === "detail" && detailTicker)` (line 37) with:

```ts
if (page === "trade" && activeTradeTicker) set.add(activeTradeTicker);
```

- [ ] **Step 6: Update in-page references that hard-code `'dashboard'` or `'detail'`**

`frontend/src/pages/DashboardPage.tsx` line 197: `onNavigate('detail', t.ticker)` → `onNavigate('trade', t.ticker)`.
Line 237: `onNavigate('positions')` — unchanged for now (Task 8 collapses Positions into Portfolio tabs and updates this).

`frontend/src/pages/DetailPage.tsx` line 134, 178: `onNavigate('watchlist')` — unchanged (these go to Watchlist, not Trade).

`frontend/src/pages/WatchlistPage.tsx` line 175: `onNavigate('detail', ticker)` → `onNavigate('trade', ticker)`.

`frontend/src/pages/AlertsPage.tsx` — has no `'detail'` nav today; no change in this step.

- [ ] **Step 7: Update App.tsx PageRouter prop name**

In `App.tsx` (around line 147–164), in the `<PageRouter ... />` JSX, replace:

```tsx
detailTicker={detailTicker}
```

With:

```tsx
activeTradeTicker={activeTradeTicker}
```

- [ ] **Step 8: Type-check + build**

Run:

```bash
npm run --prefix frontend build
```

Expected: exits 0. Any leftover reference to `'dashboard'` / `'detail'` page keys, or to `detailTicker`, will surface as a TS error here — fix in place if so.

- [ ] **Step 9: Manual smoke test**

Run:

```bash
npm run --prefix frontend dev
```

Open the Vite URL it prints. Click each sidebar item; confirm Dashboard now reads "Portfolio" and clicking a watchlist symbol or a top-mover row navigates to the (still old-styled) detail page. No console errors.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/lib/types.ts frontend/src/App.tsx frontend/src/components/Sidebar.tsx frontend/src/components/PageRouter.tsx frontend/src/hooks/useInterestingSymbols.ts frontend/src/pages/DashboardPage.tsx frontend/src/pages/DetailPage.tsx frontend/src/pages/WatchlistPage.tsx
git commit -m "refactor(routing): rename page keys dashboard→portfolio, detail→trade"
```

---

## Task 3: Watchlist — add `[Alert]` button between `[Trade]` and `[Remove]`

**Files:**
- Modify: `frontend/src/pages/WatchlistPage.tsx` (props + actions cell)
- Modify: `frontend/src/components/PageRouter.tsx` (forward `setAlertCtx` to WatchlistPage)

The Alert button opens the existing `NewAlertModal` (already wired through `setAlertCtx`). No modal change needed.

- [ ] **Step 1: Add `setAlertCtx` to `WatchlistPageProps`**

In `frontend/src/pages/WatchlistPage.tsx`, add to the imports (around line 8–14):

```ts
import type {
  AlertCtx,
  Market,
  PageKey,
  Portfolio,
  TradeCtx,
} from '../lib/types';
```

Update `WatchlistPageProps` (around line 16–24):

```ts
interface WatchlistPageProps {
  market: Market;
  unavailable: Record<string, UnavailableReason>;
  portfolio: Portfolio;
  toggleWatch: (ticker: string) => void;
  onNavigate: (page: PageKey, ticker?: string) => void;
  onAdd: () => void;
  setTradeCtx: (ctx: TradeCtx | null) => void;
  setAlertCtx: (ctx: AlertCtx | null) => void;
}
```

Destructure `setAlertCtx` in the component signature (around line 26–34).

- [ ] **Step 2: Add the Alert button to each priced row**

In `WatchlistPage.tsx`, find the Actions cell of the priced row (around line 239–256). Replace the cell with:

```tsx
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
    className="btn sm"
    onClick={() => setAlertCtx({ ticker })}
  >
    Alert
  </button>
  <button
    className="btn sm ghost icon-only"
    onClick={() => toggleWatch(ticker)}
    title="Remove"
  >
    <Icon name="close" size={14} />
  </button>
</div>
```

(The `Alert` button uses the same `btn sm` style — neutral, between primary `Trade` and ghost `Remove`. No other style additions needed.)

- [ ] **Step 3: Forward `setAlertCtx` from PageRouter**

In `frontend/src/components/PageRouter.tsx`, the `case "watchlist":` block (around line 69–80). Replace:

```tsx
case "watchlist":
  return (
    <WatchlistPage
      market={market}
      unavailable={unavailable}
      portfolio={portfolio}
      toggleWatch={toggleWatch}
      onNavigate={onNavigate}
      onAdd={onAddStock}
      setTradeCtx={setTradeCtx}
    />
  );
```

With:

```tsx
case "watchlist":
  return (
    <WatchlistPage
      market={market}
      unavailable={unavailable}
      portfolio={portfolio}
      toggleWatch={toggleWatch}
      onNavigate={onNavigate}
      onAdd={onAddStock}
      setTradeCtx={setTradeCtx}
      setAlertCtx={setAlertCtx}
    />
  );
```

- [ ] **Step 4: Type-check + build**

```bash
npm run --prefix frontend build
```

Expected: exits 0.

- [ ] **Step 5: Manual smoke test**

`npm run --prefix frontend dev`. Click `Alert` on a watchlist row — `NewAlertModal` opens with the symbol pre-filled. Submit; the new alert shows up on the Alerts page. `Trade` and `Remove` still work as before.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/WatchlistPage.tsx frontend/src/components/PageRouter.tsx
git commit -m "feat(watchlist): add Set Alert quick action per row"
```

---

## Task 4: Rename `DashboardPage`/`DetailPage` files + symbols → `PortfolioPage`/`TradePage`

**Files:**
- Rename + edit: `frontend/src/pages/DashboardPage.tsx` → `frontend/src/pages/PortfolioPage.tsx` (export `PortfolioPage`, props `PortfolioPageProps`)
- Rename + edit: `frontend/src/pages/DetailPage.tsx` → `frontend/src/pages/TradePage.tsx` (export `TradePage`, props `TradePageProps`)
- Modify: `frontend/src/components/PageRouter.tsx` (imports + JSX)

This task is mechanical — symbol rename only. The big TradePage rebuild (rail + cards) is Task 9.

- [ ] **Step 1: Rename DashboardPage.tsx → PortfolioPage.tsx**

```bash
git mv frontend/src/pages/DashboardPage.tsx frontend/src/pages/PortfolioPage.tsx
```

In the renamed file, update the export and props symbol:

Replace:

```ts
interface DashboardPageProps {
```

With:

```ts
interface PortfolioPageProps {
```

Replace:

```ts
export function DashboardPage({
```

With:

```ts
export function PortfolioPage({
```

Update the props type reference inside the function signature (`}: DashboardPageProps)` → `}: PortfolioPageProps)`).

Replace the page-title literal:

```tsx
<h1 className="page-title">Dashboard</h1>
```

With:

```tsx
<h1 className="page-title">Portfolio</h1>
```

(The page subtitle text is fine.)

- [ ] **Step 2: Rename DetailPage.tsx → TradePage.tsx**

```bash
git mv frontend/src/pages/DetailPage.tsx frontend/src/pages/TradePage.tsx
```

In the renamed file:

Replace:

```ts
interface DetailPageProps {
```

With:

```ts
interface TradePageProps {
```

Replace:

```ts
export function DetailPage({
```

With:

```ts
export function TradePage({
```

Update the props type reference (`}: DetailPageProps)` → `}: TradePageProps)`).

(The internal `<h1 className="page-title">{ticker}</h1>` stays — the ticker IS the page title for the trade view.)

- [ ] **Step 3: Update PageRouter imports + JSX**

In `frontend/src/components/PageRouter.tsx` (lines 1–7):

Replace:

```ts
import { DashboardPage } from "../pages/DashboardPage";
import { WatchlistPage } from "../pages/WatchlistPage";
import { DetailPage } from "../pages/DetailPage";
import { PositionsPage } from "../pages/PositionsPage";
import { OrdersPage } from "../pages/OrdersPage";
import { AlertsPage } from "../pages/AlertsPage";
import { AccountPage } from "../pages/AccountPage";
```

With:

```ts
import { PortfolioPage } from "../pages/PortfolioPage";
import { WatchlistPage } from "../pages/WatchlistPage";
import { TradePage } from "../pages/TradePage";
import { PositionsPage } from "../pages/PositionsPage";
import { OrdersPage } from "../pages/OrdersPage";
import { AlertsPage } from "../pages/AlertsPage";
import { AccountPage } from "../pages/AccountPage";
```

(Positions and Orders imports stay until Task 8 deletes the files.)

In the `case "portfolio":` block, replace `<DashboardPage` with `<PortfolioPage`. In `case "trade":`, replace `<DetailPage` with `<TradePage`.

- [ ] **Step 4: Type-check + build**

```bash
npm run --prefix frontend build
```

Expected: exits 0.

- [ ] **Step 5: Manual smoke test**

`npm run --prefix frontend dev`. Sidebar shows "Portfolio". Click a watchlist row — page header reads the ticker as before; URL still uses your custom router so no path change. No console errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/PortfolioPage.tsx frontend/src/pages/TradePage.tsx frontend/src/components/PageRouter.tsx
git commit -m "refactor: rename DashboardPage→PortfolioPage, DetailPage→TradePage"
```

---

## Task 5: Delete Positions + Orders pages; fold contents into PortfolioPage tabs

**Files:**
- Modify: `frontend/src/pages/PortfolioPage.tsx` (add tabs: Overview / Positions / History)
- Modify: `frontend/src/components/Sidebar.tsx` (remove `positions` and `orders` items)
- Modify: `frontend/src/components/PageRouter.tsx` (drop the `'positions'` and `'orders'` cases + imports)
- Modify: `frontend/src/lib/types.ts` (drop `'positions'` and `'orders'` from `PageKey`)
- Modify: `frontend/src/App.tsx` (the `workingOrders` prop being unused after sidebar drops the badge — see step 6)
- Modify: `frontend/src/hooks/useInterestingSymbols.ts` (no change needed — already iterates `portfolio.orders` regardless of page key)
- Delete: `frontend/src/pages/PositionsPage.tsx`
- Delete: `frontend/src/pages/OrdersPage.tsx`

PortfolioPage gets a small tab bar at the top. Tab content is local component state; no URL persistence.

- [ ] **Step 1: Move Positions table source out of PositionsPage and inline it in PortfolioPage**

We will not import from PositionsPage; instead, the Positions tab in PortfolioPage gets its own copy of the table because we are deleting PositionsPage. Open `frontend/src/pages/PositionsPage.tsx` and copy the JSX inside `<div className="card">…</div>` (lines 35–135) for reference. Open `frontend/src/pages/OrdersPage.tsx` and copy the **filled-only** branch of the table for History (we only need filled, not working/cancelled — see filtering below).

- [ ] **Step 2: Update PortfolioPage props for the new behavior**

In `frontend/src/pages/PortfolioPage.tsx`, update imports:

```ts
import { useEffect, useMemo, useState } from 'react';
import { dayChangePct } from '../lib/quote';
import { fmtMoney, fmtPct, fmtLocalTime } from '../lib/format';
import { PriceChart, type PriceChartPoint } from '../components/PriceChart';
import { PriceCell } from '../components/PriceCell';
import { Sparkline } from '../components/Sparkline';
import { Empty } from '../components/Empty';
import { portfolioClient } from '../lib/portfolioClient';
import type { HistoryRange } from '../../../shared/src';
import type {
  Market,
  PageKey,
  Portfolio,
  TradeCtx,
  Valuation,
} from '../lib/types';
```

(Adding `fmtLocalTime` for the History tab.)

- [ ] **Step 3: Add tab state + tab bar**

After the existing `range`/`historyPoints` state declarations (around line 38–40), add:

```ts
type Tab = 'overview' | 'positions' | 'history';
const [tab, setTab] = useState<Tab>('overview');
```

In the JSX, after the `<div className="page-header">…</div>` (around line 102–110), and *before* `<div className="stat-grid">…</div>`, add:

```tsx
<div className="tabs" style={{ marginBottom: 14 }}>
  <button
    className={tab === 'overview' ? 'active' : ''}
    onClick={() => setTab('overview')}
  >
    Overview
  </button>
  <button
    className={tab === 'positions' ? 'active' : ''}
    onClick={() => setTab('positions')}
  >
    Positions ({positions.length})
  </button>
  <button
    className={tab === 'history' ? 'active' : ''}
    onClick={() => setTab('history')}
  >
    History
  </button>
</div>
```

(The `tabs` class already exists — used by `OrdersPage.tsx`. Reusing it keeps visuals consistent.)

- [ ] **Step 4: Wrap each section in the new tabs**

The current Overview body is everything from `<div className="stat-grid">` through the closing `</div>` of the "Open positions" card (around line 112–323). Wrap it conditionally:

```tsx
{tab === 'overview' && (
  <>
    {/* existing stat-grid + grid-2 + open positions card */}
  </>
)}
```

(Note: the "Open positions" card in Overview today shows up to all positions with a "View all →" button that used to navigate to the Positions page. Since Positions now lives in a tab here, change that button: replace `onClick={() => onNavigate('positions')}` (around line 237) with `onClick={() => setTab('positions')}`. Keep the visual.)

- [ ] **Step 5: Add the Positions tab body**

After the Overview block, before the closing `</div>` of the page, add:

```tsx
{tab === 'positions' && (
  <div className="card">
    {positions.length === 0 ? (
      <Empty
        title="No open positions"
        subtitle="Use the Trade button on any stock to open your first position."
      />
    ) : (
      <table className="table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Side</th>
            <th className="num">Qty</th>
            <th className="num">Avg Cost</th>
            <th className="num">Last</th>
            <th className="num">Market Value</th>
            <th className="num">Unrealized P&L</th>
            <th className="num">% Change</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const m = market[p.ticker];
            if (!m) return null;
            const mkt = (p.side === 'long' ? m.price : p.avgPrice) * p.qty;
            const pnl =
              p.side === 'long'
                ? (m.price - p.avgPrice) * p.qty
                : (p.avgPrice - m.price) * p.qty;
            const pnlPct = (pnl / (p.avgPrice * p.qty)) * 100;
            return (
              <tr key={p.id}>
                <td>
                  <div
                    className="ticker"
                    onClick={() => onNavigate('trade', p.ticker)}
                    style={{ cursor: 'pointer' }}
                  >
                    {p.ticker}
                  </div>
                </td>
                <td>
                  <span className={`pill ${p.side}`}>{p.side.toUpperCase()}</span>
                </td>
                <td className="num">{p.qty}</td>
                <td className="num">${p.avgPrice.toFixed(2)}</td>
                <td className="num">
                  <PriceCell value={m.price} prefix="$" />
                </td>
                <td className="num">${mkt.toFixed(2)}</td>
                <td
                  className="num"
                  style={{ color: pnl >= 0 ? 'var(--up)' : 'var(--down)' }}
                >
                  {fmtMoney(pnl, { signed: true })}
                </td>
                <td className="num">
                  <span className={`chip ${pnlPct >= 0 ? 'up' : 'down'}`}>
                    {fmtPct(pnlPct)}
                  </span>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <div
                    style={{
                      display: 'flex',
                      gap: 4,
                      justifyContent: 'flex-end',
                    }}
                  >
                    <button
                      className="btn sm"
                      onClick={() =>
                        setTradeCtx({
                          ticker: p.ticker,
                          side: p.side === 'long' ? 'buy' : 'short',
                        })
                      }
                    >
                      Add
                    </button>
                    <button
                      className="btn sm primary"
                      onClick={() =>
                        setTradeCtx({
                          ticker: p.ticker,
                          side: p.side === 'long' ? 'sell' : 'cover',
                        })
                      }
                    >
                      Close
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    )}
  </div>
)}
```

- [ ] **Step 6: Add the History tab body**

After the Positions block, add:

```tsx
{tab === 'history' && (
  <div className="card">
    {(() => {
      const filled = portfolio.history.filter((o) => o.status === 'filled');
      if (filled.length === 0) {
        return (
          <Empty
            title="No filled orders yet"
            subtitle="Once you place and fill an order it will appear here."
          />
        );
      }
      return (
        <table className="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Symbol</th>
              <th>Action</th>
              <th className="num">Qty</th>
              <th className="num">Fill Price</th>
            </tr>
          </thead>
          <tbody>
            {filled.map((o) => (
              <tr key={o.id}>
                <td style={{ color: 'var(--text-muted)' }}>
                  {fmtLocalTime(o.filledAt ?? o.createdAt)}
                </td>
                <td>
                  <div
                    className="ticker"
                    onClick={() => onNavigate('trade', o.ticker)}
                    style={{ cursor: 'pointer' }}
                  >
                    {o.ticker}
                  </div>
                </td>
                <td>
                  <span
                    className={`pill ${
                      o.side === 'buy' || o.side === 'cover' ? 'long' : 'short'
                    }`}
                  >
                    {o.side.toUpperCase()}
                  </span>
                </td>
                <td className="num">{o.qty}</td>
                <td className="num">
                  {o.fillPrice ? `$${o.fillPrice.toFixed(2)}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    })()}
  </div>
)}
```

- [ ] **Step 7: Drop Positions/Orders entries from Sidebar**

In `frontend/src/components/Sidebar.tsx`, replace the `navItems` array (around line 21–52):

```ts
const navItems: {
  id: PageKey;
  label: string;
  icon: IconName;
  badge?: number | null;
}[] = [
  { id: "portfolio", label: "Portfolio", icon: "dashboard" },
  {
    id: "watchlist",
    label: "Watchlist",
    icon: "watchlist",
    badge: portfolio.watchlist.length,
  },
  {
    id: "trade",
    label: "Trade",
    icon: "positions",
    badge: null,
  },
  {
    id: "alerts",
    label: "Alerts",
    icon: "alerts",
    badge: activeAlerts || null,
  },
];
```

(We reuse the `'positions'` icon for Trade until we add a dedicated one — out of scope. Trade has no badge.)

The component receives `workingOrders` and `activeAlerts` props. Keep `activeAlerts` (still used). Remove `workingOrders` from the props interface and from the destructuring — we no longer surface a working-orders count anywhere. Update `SidebarProps` (line 4–11):

```ts
interface SidebarProps {
  page: PageKey;
  onNavigate: (p: PageKey, ticker?: string) => void;
  portfolio: Portfolio;
  activeAlerts: number;
  provider: string;
}
```

And the destructuring:

```ts
export function Sidebar({
  page,
  onNavigate,
  portfolio,
  activeAlerts,
  provider,
}: SidebarProps) {
```

- [ ] **Step 8: Remove the unused Sidebar prop in App.tsx**

In `frontend/src/App.tsx`, the `<Sidebar … />` element (around line 137–144). Delete the `workingOrders={workingOrders}` line. Then remove the `workingOrders` constant computation (around line 105–107). Both removals must happen — the constant becomes dead code and the prop no longer exists on the type.

- [ ] **Step 9: Drop `'positions'` and `'orders'` PageKey arms**

In `frontend/src/lib/types.ts`, replace:

```ts
export type PageKey =
  | 'portfolio'
  | 'watchlist'
  | 'trade'
  | 'positions'
  | 'orders'
  | 'alerts'
  | 'account';
```

With:

```ts
export type PageKey =
  | 'portfolio'
  | 'watchlist'
  | 'trade'
  | 'alerts'
  | 'account';
```

In `frontend/src/components/PageRouter.tsx`:
- Remove the imports `import { PositionsPage } from "../pages/PositionsPage";` and `import { OrdersPage } from "../pages/OrdersPage";`.
- Remove the `case "positions":` and `case "orders":` arms.

- [ ] **Step 10: Delete the now-unused page files**

```bash
git rm frontend/src/pages/PositionsPage.tsx
git rm frontend/src/pages/OrdersPage.tsx
```

- [ ] **Step 11: Type-check + build**

```bash
npm run --prefix frontend build
```

Expected: exits 0. Any leftover `'positions'` / `'orders'` reference, or any dangling `cancelOrder` prop on `PageRouter`, will surface here.

`PageRouter` still receives `cancelOrder` from App.tsx. It is *no longer* consumed by the deleted Orders page, but Task 9 will use it on TradePage. Leave it threaded.

- [ ] **Step 12: Manual smoke test**

`npm run --prefix frontend dev`. Sidebar shows: Portfolio, Watchlist, Trade, Alerts, Account. Portfolio page shows the three tabs and clicking Positions/History switches the body. Clicking a symbol in either Positions or History navigates to Trade. No console errors.

- [ ] **Step 13: Commit**

```bash
git add frontend/src/pages/PortfolioPage.tsx frontend/src/components/Sidebar.tsx frontend/src/App.tsx frontend/src/components/PageRouter.tsx frontend/src/lib/types.ts
git rm frontend/src/pages/PositionsPage.tsx frontend/src/pages/OrdersPage.tsx
git commit -m "feat(portfolio): tabs Overview/Positions/History; remove Positions+Orders pages"
```

---

## Task 6: TradePage — left rail (search + watchlist + recent) + per-symbol cards

**Files:**
- Modify: `frontend/src/pages/TradePage.tsx`
- Modify: `frontend/src/components/PageRouter.tsx` (forward `cancelOrder`, `removeAlert`, `setAlertCtx` to TradePage)
- Modify: `frontend/src/index.css` (small additions for the rail layout)

The page currently has a two-column grid via `.detail-layout` — chart-stack on the left, OrderPanel on the right (sticky). We extend it: a new **rail** to the left (250px wide) holding the symbol picker; the existing two-column grid moves into the right portion. Inside the right portion we keep what is there (chart, key stats, position card) and add: a working-orders card + an alerts card.

The Trade page's notion of the "active" symbol moves from being purely externally-driven (the `ticker` prop) to externally-driven-with-internal-overrides: the rail can change the active ticker without leaving the page. We mirror the prop into local state and let the rail call `setActiveTicker`. We *also* call `onNavigate('trade', symbol)` so the App-level persisted-state stays in sync (so the next reload boots into the same symbol). This is a small redundancy but keeps the rest of the app's wiring unchanged.

- [ ] **Step 1: Add the rail-related CSS**

In `frontend/src/index.css`, append (location: end of file is fine):

```css
/* TradePage rail layout */
.trade-shell {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 14px;
  align-items: start;
}
.trade-rail {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px;
  position: sticky;
  top: 74px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.trade-rail-section-label {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  font-weight: 600;
  margin-top: 4px;
}
.trade-rail-row {
  display: flex;
  align-items: center;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text);
}
.trade-rail-row:hover { background: var(--bg-muted); }
.trade-rail-row.active {
  background: var(--accent);
  color: white;
}
.trade-rail-error {
  font-size: 11.5px;
  color: var(--down);
  margin-top: 4px;
}
```

- [ ] **Step 2: TradePage — mirror prop into local state + rail handler**

At the top of `frontend/src/pages/TradePage.tsx`, update imports:

```ts
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'react-hot-toast';
import { Icon } from '../components/Icon';
import { PriceChart } from '../components/PriceChart';
import { Empty } from '../components/Empty';
import { fmtLocalTime, fmtMoney, fmtPct } from '../lib/format';
import { dayChange, dayChangePct, money } from '../lib/quote';
import { useBars } from '../hooks/useBars';
import { priceClient } from '../lib/priceClient';
import type { AlpacaFeed, BarTimeframe } from '../../../shared/src';
import type {
  AlertCtx,
  Market,
  PageKey,
  Portfolio,
  TradeCtx,
} from '../lib/types';
```

(Adds `fmtLocalTime` for the Working Orders panel.)

Update `TradePageProps` (around line 19–29) to receive the new props:

```ts
interface TradePageProps {
  ticker: string;
  market: Market;
  portfolio: Portfolio;
  toggleWatch: (ticker: string) => void;
  setTradeCtx: (ctx: TradeCtx | null) => void;
  setAlertCtx: (ctx: AlertCtx | null) => void;
  cancelOrder: (id: string) => void;
  removeAlert: (id: string) => void;
  onNavigate: (page: PageKey, ticker?: string) => void;
  liveFeed: AlpacaFeed | null;
}
```

In the component body, *replace* the existing `const m = market[ticker];` line (around line 57) with:

```ts
// Mirror the prop-driven ticker into local state so the rail can switch
// symbol without leaving the page. Also reflect the change up to App via
// onNavigate so persisted state survives reloads.
const [activeTicker, setActiveTicker] = useState(ticker);
useEffect(() => {
  setActiveTicker(ticker);
}, [ticker]);
const m = market[activeTicker];
```

Replace every later occurrence of the bare `ticker` variable inside this component with `activeTicker` (uses are: useBars call, position lookups via `portfolio.positions.find`, the `<h1>{ticker}</h1>`, every `setTradeCtx({ ticker, side: ... })` call, and the existing `setAlertCtx({ ticker })`. There are ~12 sites — search and replace inside this file only).

Add a rail handler near the top of the component, after the local state declarations:

```ts
const TICKER_RE = /^[A-Z][A-Z0-9.]{0,7}$/;
const RECENT_KEY = 'paperTradePro.recentSymbols';
const [search, setSearch] = useState('');
const [searchError, setSearchError] = useState<string | null>(null);
const [recent, setRecent] = useState<string[]>(() => {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch (err) {
    console.error('ERROR load recent symbols', err);
    return [];
  }
});

const switchTo = (sym: string) => {
  setActiveTicker(sym);
  onNavigate('trade', sym);
  setRecent((prev) => {
    const next = [sym, ...prev.filter((t) => t !== sym)].slice(0, 5);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch (err) {
      console.error('ERROR persist recent symbols', err);
    }
    return next;
  });
};

const submitSearch = () => {
  const sym = search.trim().toUpperCase();
  if (!sym) return;
  if (!TICKER_RE.test(sym)) {
    setSearchError('Letters/digits/dot, max 8 chars (e.g. AAPL, BRK.B).');
    return;
  }
  setSearchError(null);
  setSearch('');
  switchTo(sym);
};
```

- [ ] **Step 3: Wrap the existing layout in a new shell + add the rail**

Find the outermost render `return ( <div> … )` (around line 166). Replace its top-level JSX with:

```tsx
return (
  <div className="trade-shell">
    {/* LEFT RAIL */}
    <aside className="trade-rail">
      <input
        className="input mono"
        placeholder="Search ticker"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value.toUpperCase());
          if (searchError) setSearchError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submitSearch();
        }}
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
      />
      {searchError && <div className="trade-rail-error">{searchError}</div>}

      <div className="trade-rail-section-label">Watchlist</div>
      {portfolio.watchlist.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '0 8px' }}>
          No symbols yet
        </div>
      ) : (
        portfolio.watchlist.map((t) => (
          <div
            key={t}
            className={`trade-rail-row ${t === activeTicker ? 'active' : ''}`}
            onClick={() => switchTo(t)}
          >
            {t}
          </div>
        ))
      )}

      {recent.length > 0 && (
        <>
          <div className="trade-rail-section-label">Recent</div>
          {recent.map((t) => (
            <div
              key={t}
              className={`trade-rail-row ${t === activeTicker ? 'active' : ''}`}
              onClick={() => switchTo(t)}
            >
              {t}
            </div>
          ))}
        </>
      )}
    </aside>

    {/* RIGHT PANE — existing chart + ticket + new cards */}
    <div>
      {/* Existing page-header block stays here */}
      {/* Existing detail-layout block stays here */}
      {/* New: WorkingOrdersCard for activeTicker (Step 4) */}
      {/* New: AlertsForSymbolCard for activeTicker (Step 5) */}
    </div>
  </div>
);
```

Then *move* the previously-rendered children (the back-button row, the page-header, the `.detail-layout` block) into the inner `<div>` of the right pane. Important: drop the `<button className="btn ghost sm" onClick={() => onNavigate('watchlist')}>← Watchlist</button>` row entirely — the rail makes it unnecessary, and it points at the previous "came-from-watchlist" model.

The `if (!m) { return <Empty … /> }` early-return needs to render *inside* the new shell so the rail stays visible. Replace it with:

```tsx
if (!m) {
  return (
    <div className="trade-shell">
      <aside className="trade-rail">{/* same rail markup as above */}</aside>
      <div>
        <Empty
          title={`No quote for ${activeTicker}`}
          subtitle="Try a different symbol or check the data provider status."
        />
      </div>
    </div>
  );
}
```

Extract the rail markup into a small inline component so you don't duplicate it; e.g. a function `renderRail()` declared inside `TradePage` returning the `<aside>` JSX, then called in both branches.

- [ ] **Step 4: Add the Working Orders card (per-symbol)**

Inside the right-pane `<div>`, after the existing `.detail-layout` block, insert:

```tsx
{(() => {
  const symbolOrders = portfolio.orders.filter(
    (o) =>
      o.ticker === activeTicker &&
      (o.status === 'pending' || o.status === 'pending_fill'),
  );
  if (symbolOrders.length === 0) return null;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-header">
        <h3 className="card-title">Working orders for {activeTicker}</h3>
      </div>
      <div className="card-body p0">
        <table className="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Action</th>
              <th>Type</th>
              <th className="num">Qty</th>
              <th className="num">Trigger</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {symbolOrders.map((o) => (
              <tr key={o.id}>
                <td style={{ color: 'var(--text-muted)' }}>
                  {fmtLocalTime(o.createdAt)}
                </td>
                <td>
                  <span
                    className={`pill ${
                      o.side === 'buy' || o.side === 'cover'
                        ? 'long'
                        : 'short'
                    }`}
                  >
                    {o.side.toUpperCase()}
                  </span>
                </td>
                <td>{o.type}</td>
                <td className="num">{o.qty}</td>
                <td className="num" style={{ fontSize: 12 }}>
                  {o.type === 'limit'
                    ? `Limit $${o.limitPrice?.toFixed(2) ?? '—'}`
                    : o.type === 'stop'
                      ? `Stop $${o.stopPrice?.toFixed(2) ?? '—'}`
                      : o.type === 'stop_limit'
                        ? `Stop $${o.stopPrice?.toFixed(2) ?? '—'} / Lim $${o.limitPrice?.toFixed(2) ?? '—'}`
                        : o.type === 'trailing_stop'
                          ? `Trail ${o.trailPct ?? '—'}%`
                          : 'Market'}
                </td>
                <td style={{ textAlign: 'right' }}>
                  <button
                    className="btn sm ghost"
                    onClick={() => cancelOrder(o.id)}
                  >
                    Cancel
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
})()}
```

- [ ] **Step 5: Add the Alerts-for-symbol card**

After the working-orders block, insert:

```tsx
{(() => {
  const symbolAlerts = portfolio.alerts.filter(
    (a) => a.ticker === activeTicker && !a.triggeredAt,
  );
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-header">
        <h3 className="card-title">Alerts for {activeTicker}</h3>
        <button
          className="btn sm accent"
          onClick={() => setAlertCtx({ ticker: activeTicker })}
        >
          + New alert
        </button>
      </div>
      <div className="card-body p0">
        {symbolAlerts.length === 0 ? (
          <Empty
            title={`No alerts on ${activeTicker}`}
            subtitle="Click + New alert to be notified at a price you choose."
          />
        ) : (
          symbolAlerts.map((a) => (
            <div
              key={a.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '10px 18px',
                borderBottom: '1px solid var(--border)',
                gap: 14,
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, color: 'var(--text)' }}>
                  {a.condition === 'above' ? 'Above' : 'Below'}{' '}
                  <span className="mono tnum" style={{ fontWeight: 600 }}>
                    ${a.price.toFixed(2)}
                  </span>
                </div>
                {a.note && (
                  <div className="company" style={{ marginTop: 2 }}>
                    {a.note}
                  </div>
                )}
              </div>
              <button
                className="btn sm ghost icon-only"
                onClick={() => removeAlert(a.id)}
                title="Delete alert"
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
})()}
```

- [ ] **Step 6: PageRouter — pass `cancelOrder`, `removeAlert`, `setAlertCtx` to TradePage**

In `frontend/src/components/PageRouter.tsx`, the `case "trade":` block (around line 81–93). Replace:

```tsx
case "trade":
  return (
    <DetailPage
      ticker={activeTradeTicker}
      market={market}
      portfolio={portfolio}
      toggleWatch={toggleWatch}
      setTradeCtx={setTradeCtx}
      setAlertCtx={setAlertCtx}
      onNavigate={onNavigate}
      liveFeed={liveFeed}
    />
  );
```

(Note the `<DetailPage>` was renamed to `<TradePage>` in Task 7; the code below assumes the post-Task-7 state.)

With:

```tsx
case "trade":
  return (
    <TradePage
      ticker={activeTradeTicker}
      market={market}
      portfolio={portfolio}
      toggleWatch={toggleWatch}
      setTradeCtx={setTradeCtx}
      setAlertCtx={setAlertCtx}
      cancelOrder={cancelOrder}
      removeAlert={removeAlert}
      onNavigate={onNavigate}
      liveFeed={liveFeed}
    />
  );
```

`cancelOrder` and `removeAlert` are already in `PageRouterProps` and destructured in the function — no other plumbing change needed.

- [ ] **Step 7: Type-check + build**

```bash
npm run --prefix frontend build
```

Expected: exits 0. If TypeScript complains about the unused `cancelOrder` import or the dropped `<button>… ← Watchlist</button>` reference, follow the trail and remove cleanly.

- [ ] **Step 8: Manual smoke test**

`npm run --prefix frontend dev`. Click sidebar Trade. Verify:

- Left rail shows search + watchlist symbols + (after switching) recent symbols.
- Type `MSFT` in search, hit Enter — page reloads with MSFT.
- Click a watchlist symbol in the rail — page switches without navigating away.
- The "Working orders for X" card appears only when X has working orders.
- The "Alerts for X" card appears with the existing alerts and `+ New alert` opens the modal pre-filled.
- Reload the browser — the last-viewed symbol is preserved (because `onNavigate('trade', sym)` updated the App-level persisted state).

- [ ] **Step 9: Commit**

```bash
git add frontend/src/pages/TradePage.tsx frontend/src/components/PageRouter.tsx frontend/src/index.css
git commit -m "feat(trade): side rail symbol picker + per-symbol orders/alerts cards"
```

---

## Task 7: AlertsPage — clickable symbol + sidebar red dot (localStorage-driven)

**Files:**
- Modify: `frontend/src/pages/AlertsPage.tsx`
- Modify: `frontend/src/components/PageRouter.tsx` (forward `onNavigate`)
- Modify: `frontend/src/App.tsx` (compute `unreadTriggered` from `countUnreadTriggered`)
- Modify: `frontend/src/components/Sidebar.tsx` (red dot when `unreadTriggered > 0`)

The "unread triggered alerts" badge derives from a single `localStorage` timestamp (set up in Task 1). Visiting the Alerts page bumps the timestamp; the sidebar dot recomputes locally on each render.

- [ ] **Step 1: AlertsPage — mark viewed on mount + clickable symbol**

In `frontend/src/pages/AlertsPage.tsx`, update the imports and props:

```ts
import { useEffect } from 'react';
import { Icon } from '../components/Icon';
import { Empty } from '../components/Empty';
import { fmtPct, timeAgo } from '../lib/format';
import { markViewedNow } from '../lib/alertsViewed';
import type { Alert, Market, PageKey, Portfolio } from '../lib/types';

interface AlertsPageProps {
  market: Market;
  portfolio: Portfolio;
  toggleAlert: (id: string) => void;
  removeAlert: (id: string) => void;
  onAdd: () => void;
  onNavigate: (page: PageKey, ticker?: string) => void;
}
```

Update the function signature and add a mount effect:

```ts
export function AlertsPage({
  market,
  portfolio,
  toggleAlert,
  removeAlert,
  onAdd,
  onNavigate,
}: AlertsPageProps) {
  // Bump the "last viewed" timestamp so the sidebar's red dot clears.
  // Idempotent — re-running just overwrites the timestamp with now().
  useEffect(() => {
    markViewedNow();
  }, []);
```

Make the symbol clickable. In the inner `card` render function (around line 25 of the existing file), update the symbol cell:

```tsx
<span
  className="ticker"
  onClick={() => onNavigate('trade', a.ticker)}
  style={{ cursor: 'pointer' }}
>
  {a.ticker}
</span>
```

(The `.ticker` CSS class already styles tickers; we just add the click + cursor.)

- [ ] **Step 2: PageRouter — forward `onNavigate` to AlertsPage**

In `frontend/src/components/PageRouter.tsx`, the `case "alerts":` block. Replace:

```tsx
case "alerts":
  return (
    <AlertsPage
      market={market}
      portfolio={portfolio}
      toggleAlert={toggleAlert}
      removeAlert={removeAlert}
      onAdd={() => setAlertCtx({ ticker: activeTradeTicker || "AAPL" })}
    />
  );
```

With:

```tsx
case "alerts":
  return (
    <AlertsPage
      market={market}
      portfolio={portfolio}
      toggleAlert={toggleAlert}
      removeAlert={removeAlert}
      onAdd={() => setAlertCtx({ ticker: activeTradeTicker || "AAPL" })}
      onNavigate={onNavigate}
    />
  );
```

- [ ] **Step 3: App.tsx — compute `unreadTriggered` and pass to Sidebar**

In `frontend/src/App.tsx`, add an import:

```ts
import { countUnreadTriggered } from "./lib/alertsViewed";
```

After the existing `activeAlerts` constant, add:

```ts
const unreadTriggered = countUnreadTriggered(portfolio.alerts);
```

Note: `countUnreadTriggered` reads `localStorage` synchronously on every render. That's fine — `localStorage.getItem` is fast, and React only re-renders when state changes. When the user visits Alerts, `markViewedNow` writes the new timestamp; the next portfolio mutation (or any other state change) re-renders and recomputes the count to 0. To force a re-render right after the bump (so the dot disappears immediately), the AlertsPage effect can also call a small bump-state on App, but a tick-driven re-render fires within 100ms anyway because `useMarket` ticks. For now we accept the up-to-one-tick delay; it's invisible in practice.

Pass `unreadTriggered` to `<Sidebar … />`:

```tsx
<Sidebar
  page={page}
  onNavigate={onNavigate}
  portfolio={portfolio}
  activeAlerts={activeAlerts}
  unreadTriggered={unreadTriggered}
  provider={provider}
/>
```

- [ ] **Step 4: Sidebar — render the red dot**

In `frontend/src/components/Sidebar.tsx`, add to `SidebarProps`:

```ts
unreadTriggered: number;
```

Destructure it in the component signature.

In the `navItems` array, add a `dot` field on the alerts item (TS type widen):

```ts
const navItems: {
  id: PageKey;
  label: string;
  icon: IconName;
  badge?: number | null;
  dot?: boolean;
}[] = [
  { id: "portfolio", label: "Portfolio", icon: "dashboard" },
  {
    id: "watchlist",
    label: "Watchlist",
    icon: "watchlist",
    badge: portfolio.watchlist.length,
  },
  { id: "trade", label: "Trade", icon: "positions", badge: null },
  {
    id: "alerts",
    label: "Alerts",
    icon: "alerts",
    badge: activeAlerts || null,
    dot: unreadTriggered > 0,
  },
];
```

In the JSX rendering each nav item, append a dot span after the badge:

```tsx
{item.badge ? <span className="badge">{item.badge}</span> : null}
{item.dot ? (
  <span
    aria-label={`${unreadTriggered} unread triggered alerts`}
    style={{
      marginLeft: 6,
      width: 8,
      height: 8,
      borderRadius: 999,
      background: 'var(--down)',
      display: 'inline-block',
    }}
  />
) : null}
```

- [ ] **Step 5: Type-check + build**

```bash
npm run --prefix frontend build
```

Expected: exits 0.

- [ ] **Step 6: End-to-end manual smoke test**

`npm run --prefix frontend dev` plus backend running.

a) Create an alert that will trigger immediately (e.g. AAPL above $0.01). Wait for the toast.
b) Confirm the sidebar's Alerts item shows a red dot.
c) Click Alerts. The Triggered alert is visible. Within ~1s the dot disappears (after the next market tick re-renders App).
d) On the Alerts page, click the AAPL ticker — page navigates to Trade with AAPL active.
e) Reload the browser — the dot stays gone (timestamp persisted in localStorage).
f) Trigger a second alert *after* visiting Alerts — the dot reappears.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/AlertsPage.tsx frontend/src/components/PageRouter.tsx frontend/src/App.tsx frontend/src/components/Sidebar.tsx
git commit -m "feat(alerts): clickable symbol + sidebar red dot driven by localStorage"
```

---

## Task 8: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Whole-project type-check + lint**

```bash
npm run --prefix frontend build
npm run --prefix frontend lint
npm run --prefix backend build
```

Expected: all exit 0. (Lint may surface warnings; only fix actual errors.)

- [ ] **Step 2: Manual integration walkthrough**

With backend + frontend running, click through:

1. **Sidebar** shows exactly: Portfolio, Watchlist, Trade, Alerts, Account. No Positions, no Orders.
2. **Portfolio**: Overview tab matches today's Dashboard. Switching to Positions shows the table; clicking a symbol → Trade. Switching to History shows filled orders only; clicking a symbol → Trade.
3. **Watchlist**: each row has `[Trade] [Alert] [Remove]`. Trade opens TradeTicket. Alert opens NewAlertModal pre-filled. Remove drops the symbol. Symbol cell click → Trade page.
4. **Trade**: rail shows search + watchlist + recent. Search a non-watchlist symbol (e.g. `TSLA`) and hit Enter — page loads. Place a working limit order — Working orders card appears. Cancel it — card disappears. Click + New alert — modal opens, save → Alerts-for-symbol card lists it. Delete via ✕ — gone.
5. **Alerts**: ticker click → Trade page. Visiting Alerts clears the sidebar red dot if any triggered alerts were unread. Toggle/delete/timestamp behavior is unchanged.
6. **Account**: unchanged.

- [ ] **Step 3: Final commit if any leftovers**

If anything was tweaked during the walkthrough (CSS adjustments, copy fixes), commit them as one cleanup commit:

```bash
git add -A
git commit -m "chore(redesign): post-walkthrough cleanup"
```

If nothing changed, skip this step.

---

## Self-review

**Spec coverage:**
- Section 1 (Sidebar + route renames) → Tasks 2, 5, 7.
- Section 2 (Portfolio tabs) → Task 5.
- Section 3 (Watchlist Alert button) → Task 3.
- Section 4 (Trade rail + cards) → Task 6.
- Section 5 (Alerts page tweaks + sidebar dot) → Tasks 1, 7.

**Placeholder scan:** No TBDs. All steps include code to write or commands to run.

**Type consistency:**
- `PageKey` narrowing happens in two passes: Task 2 keeps `'positions'`/`'orders'` (so the routing rename can land standalone), Task 5 drops them (when the pages are deleted). Both diffs compile cleanly because the routing arms exist whenever the union members exist.
- Prop rename `detailTicker → activeTradeTicker` cascades through Sidebar, PageRouter, useInterestingSymbols, App.tsx — all in Task 2.
- The `unreadTriggered` count is computed locally in App.tsx via `countUnreadTriggered(portfolio.alerts)` (Task 7) using the helper added in Task 1. No backend or shared-types change.

**Acknowledgement mechanism note:** Original spec considered a server-side `acknowledged_at` column. We dropped it in favor of a `localStorage` timestamp because (a) sync across devices is not needed for a single-user paper-trading app, and (b) it avoids a DB migration, a new endpoint, and additional client state on a hot path.

---

## Plan complete and saved to `docs/superpowers/plans/2026-05-18-page-redesign.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.
