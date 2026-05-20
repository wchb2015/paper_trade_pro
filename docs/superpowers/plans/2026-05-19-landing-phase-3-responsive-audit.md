# Phase 3 — Responsive audit (existing app)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten the existing app's responsive behavior across the §3.1 breakpoints. Sidebar becomes a drawer below 640px; TopBar shows a compact summary in the 640–1099px range; touch targets are ≥40×40 on phones; tables horizontal-scroll cleanly; OrdersPage date inputs stack at <480px. No new feature work — this is an audit + targeted fixes.

**Architecture:** Pure UI changes. `index.css` gets new media-query rules and a few new classnames. `Sidebar.tsx` learns to render as a drawer. `TopBar.tsx` learns the compact + chip variants. A new `menu` icon is added.

**Tech Stack:** No new deps. CSS + React only.

**Spec:** [`docs/superpowers/specs/2026-05-19-landing-page-and-google-auth-design.md`](../specs/2026-05-19-landing-page-and-google-auth-design.md) §3 (responsive strategy).

**Prerequisite:** Phases 0–2 merged. The drawer button in Phase 3 lives in the same `TopBar` that Phase 2 modified — sequence matters.

---

## File Structure

### Modified
- `frontend/src/index.css` — drop the `1100px` breakpoint to `900px`; add a `<640px` rule that hides the sidebar and reveals the drawer; add compact-summary styles for `TopBar`; touch-target bumps; table horizontal-scroll wrapper styles; OrdersPage `<480px` rule.
- `frontend/src/components/Sidebar.tsx` — accepts `open` + `onClose` props; renders an overlay drawer at `<640px`.
- `frontend/src/components/TopBar.tsx` — accepts `onOpenSidebar`. Renders a burger button at `<640px`. Adds the compact summary variant.
- `frontend/src/App.tsx` — owns `sidebarOpen` state; passes the prop pair to `Sidebar` + `TopBar`.
- `frontend/src/components/Icon.tsx` — adds a `menu` icon (three-line burger).
- `frontend/src/pages/OrdersPage.tsx` — wraps the date inputs in a stack-on-small container that the new CSS rule targets. Wraps the table in `.table-scroll`.
- `frontend/src/pages/PortfolioPage.tsx` — wraps the positions table in `.table-scroll`.
- `frontend/src/pages/WatchlistPage.tsx` — wraps the watchlist rows / table in `.table-scroll`.

### Untouched
- All hooks.
- All `landing/*` (Phase 2).
- Backend.
- Trade form (`frontend/src/components/TradeForm.tsx`) already has its own mobile rule per spec §3.3 verify-only.

---

## Task 1: Add a `menu` (burger) icon

**Files:**
- Modify: `frontend/src/components/Icon.tsx`

The burger that opens the sidebar drawer.

- [ ] **Step 1: Apply the diff**

Find `export type IconName =` and add `'menu'` to the union (alphabetical-ish placement is fine):

```ts
export type IconName =
  | 'dashboard'
  | 'watchlist'
  | 'positions'
  | 'orders'
  | 'alerts'
  | 'account'
  | 'sun'
  | 'moon'
  | 'plus'
  | 'close'
  | 'star'
  | 'starFilled'
  | 'trash'
  | 'settings'
  | 'refresh'
  | 'menu';
```

In the `paths` map, add the `menu` entry. The existing icons use a 24-viewport with `stroke="currentColor"` — match that style:

```tsx
  menu: (
    <>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </>
  ),
```

- [ ] **Step 2: Typecheck + lint**

Run: `cd frontend && npx tsc -b && npx eslint src/components/Icon.tsx`
Expected: 0 errors, 0 lint problems.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/Icon.tsx
git commit -m "feat(icon): add menu (burger) icon"
```

---

## Task 2: `index.css` — drop 1100→900, add drawer + compact summary + table scroll

**Files:**
- Modify: `frontend/src/index.css`

The bulk of the responsive work lives here.

- [ ] **Step 1: Find the existing `@media (max-width: 1100px)` block and rename it to `900px`**

Find this block in `index.css`:

```css
/* responsive */
@media (max-width: 1100px) {
  .app {
    grid-template-columns: 64px 1fr;
  }
  .brand {
    width: auto;
  }
  ...
  .portfolio-summary {
    display: none;
  }
}
```

Change the media-query value from `1100px` to `900px`. **Keep every rule inside the block** — only the breakpoint changes. The `portfolio-summary` rule stays inside this block (we'll override it for 640–899 in Step 3).

- [ ] **Step 2: Replace the `.portfolio-summary { display: none }` rule inside the (now) 900px block**

Inside that same `@media (max-width: 900px)` block, replace:

```css
  .portfolio-summary {
    display: none;
  }
```

with:

```css
  /* Compact summary at 640–899px: equity + day P/L only. The full 3-cell
     summary returns at >=900px. */
  .portfolio-summary {
    gap: 10px;
    padding: 0 8px;
  }
  .portfolio-summary .ps-item.ps-cash { display: none; }
```

(We'll add a `ps-cash` class to the existing Cash item in Task 4.)

- [ ] **Step 3: Find `@media (max-width: 640px)` and append new rules**

Find the existing `@media (max-width: 640px)` block. Inside it (the order doesn't matter; appending is easiest), add:

```css
  /* App shell — sidebar drawer mode */
  .app {
    grid-template-columns: 1fr;
  }
  .sidebar {
    position: fixed;
    top: 56px;
    left: 0;
    width: 260px;
    max-width: 80vw;
    height: calc(100vh - 56px);
    background: var(--bg-elev);
    border-right: 1px solid var(--border);
    transform: translateX(-105%);
    transition: transform 0.18s ease-out;
    z-index: 60;
    box-shadow: var(--shadow-lg);
  }
  .sidebar.open { transform: translateX(0); }
  .sidebar-backdrop {
    position: fixed;
    top: 56px;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.32);
    z-index: 55;
    animation: fadeIn 0.15s ease-out;
  }
  /* Sidebar nav-items inside the drawer get full labels back. */
  .sidebar.open .nav-item { justify-content: flex-start; padding: 10px 14px; }
  .sidebar.open .nav-item span:not(.badge) { display: inline; }
  .sidebar.open .nav-group-label { display: block; }
  .sidebar.open .nav-item .badge { display: inline-flex; }

  /* Burger button in the topbar (only visible <640px) */
  .topbar-burger {
    display: inline-flex;
    width: 40px;
    height: 40px;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    color: var(--text);
    background: transparent;
    border: 1px solid var(--border);
    margin-right: 6px;
  }
  .topbar-burger:hover { background: var(--bg-hover); }

  /* Compact summary collapses to a single chip below 640px. */
  .portfolio-summary {
    border: none;
    padding: 0;
    height: auto;
    gap: 0;
  }
  .portfolio-summary .ps-item.ps-pct { display: none; }
  .portfolio-summary .ps-label { display: none; }
  .portfolio-summary .ps-item .ps-value { font-size: 13px; }

  /* Status pill — keep just the dot at <640px (verbose label hidden). */
  .top-actions .status-pill-label { display: none; }

  /* Touch targets ≥ 40px */
  .btn.sm { min-height: 40px; padding: 6px 12px; }
  .nav-item { min-height: 40px; }
  .btn.icon-only { min-width: 40px; min-height: 40px; }
  .qf-chip { min-height: 32px; padding: 6px 12px; }
```

(Note: the existing `<640px` block already contained `.main { padding: 16px; }`, `.stat-grid { grid-template-columns: 1fr 1fr; }`, etc. Keep those.)

By default (≥640px) the burger should not show. Add this rule **outside** any media query (e.g., right after the `.topbar` block earlier in the file):

```css
.topbar-burger { display: none; }
```

- [ ] **Step 4: `<480px` overrides**

After the `<640px` block, append a new media block (or merge into an existing one if the file has it):

```css
@media (max-width: 480px) {
  .stat-grid { grid-template-columns: 1fr; }
  /* OrdersPage filter shelf: stack the date pair vertically. */
  .orders-shelf-dates { flex-direction: column; align-items: stretch; }
  .orders-shelf-dates .input { width: 100%; }
}
```

- [ ] **Step 5: Add `.table-scroll` (top-level, no media query)**

Above the existing `.table { ... }` rules, add:

```css
/* Wrap any .table in .table-scroll for graceful horizontal overflow on narrow
   viewports. Right-edge gradient hints at scrollability without being noisy. */
.table-scroll {
  position: relative;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.table-scroll::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  width: 24px;
  height: 100%;
  pointer-events: none;
  background: linear-gradient(to right, transparent, var(--bg-elev));
  opacity: 0.85;
}
```

- [ ] **Step 6: Manually re-read the `index.css` patches**

Open the file and confirm:
- The `@media (max-width: 1100px)` block is now `@media (max-width: 900px)`.
- A new `@media (max-width: 480px)` block exists.
- `.table-scroll` is defined at the top level.
- `.topbar-burger { display: none }` is at the top level (overridden inside the `<640px` block).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/index.css
git commit -m "style(responsive): drop 1100→900, add drawer/compact/burger/table-scroll/<480px"
```

---

## Task 3: `Sidebar` accepts `open` + `onClose`

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx`

Renders a `.sidebar-backdrop` next to the sidebar when `open === true`, and adds `.open` to the sidebar's class. The drawer-only behavior is gated by CSS — the same component renders inline at ≥640px.

- [ ] **Step 1: Apply the diff**

In `frontend/src/components/Sidebar.tsx`, extend the `SidebarProps` interface:

```ts
interface SidebarProps {
  page: PageKey;
  onNavigate: (p: PageKey, ticker?: string) => void;
  portfolio: Portfolio;
  activeAlerts: number;
  unreadTriggered: number;
  provider: string;
  /** When true, the drawer is shown over the page (only matters <640px). */
  open: boolean;
  /** Closes the drawer; called on backdrop click and on nav. */
  onClose: () => void;
}
```

Destructure the new props in the function signature:

```ts
export function Sidebar({
  page,
  onNavigate,
  portfolio,
  activeAlerts,
  unreadTriggered,
  provider,
  open,
  onClose,
}: SidebarProps) {
```

In the JSX, change the `<aside className="sidebar">` opening tag and wrap the return:

```tsx
  return (
    <>
      {open && <div className="sidebar-backdrop" onClick={onClose} />}
      <aside className={`sidebar${open ? ' open' : ''}`}>
        ...existing content...
      </aside>
    </>
  );
```

Also wrap each `onNavigate` call in `nav-item` so it closes the drawer too:

```tsx
          onClick={() => {
            onClose();
            onNavigate(item.id);
          }}
```

(Both inside the `.map` and in the explicit `account` button.)

- [ ] **Step 2: Typecheck + lint**

Run: `cd frontend && npx tsc -b && npx eslint src/components/Sidebar.tsx`
Expected: 0 errors, 0 lint problems. (`App.tsx` will error because it doesn't pass `open`/`onClose` yet — that's resolved in Task 4.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/Sidebar.tsx
git commit -m "feat(sidebar): accept open + onClose for mobile drawer"
```

---

## Task 4: `TopBar` — burger button, compact summary class names

**Files:**
- Modify: `frontend/src/components/TopBar.tsx`

Add `onOpenSidebar` prop. Wrap the brand mark area to include a burger button that calls it. Tag `.ps-cash` and `.ps-pct` on the existing summary items so the CSS rules in Task 2 can hide them per breakpoint.

- [ ] **Step 1: Apply the diff**

Add to `TopBarProps`:

```ts
  /** Opens the mobile sidebar drawer. Only the burger button below 640px calls it. */
  onOpenSidebar: () => void;
```

Add the prop to the function destructuring (alphabetically near the rest is fine).

In the JSX, find the existing `<div className="topbar">` opening. The `<div className="brand">` block currently sits right inside `.topbar`. Insert the burger button **before** `.brand`:

```tsx
      <button
        className="topbar-burger"
        type="button"
        aria-label="Open menu"
        onClick={onOpenSidebar}
      >
        <Icon name="menu" size={20} />
      </button>
```

Find this block:

```tsx
      <div className="portfolio-summary">
        <div className="ps-item">
          <span className="ps-label">Portfolio</span>
          <span className="ps-value mono tnum">{fmtMoney(totalValue)}</span>
        </div>
        <div className="ps-item">
          <span className="ps-label">All-time</span>
          <span ...>...</span>
        </div>
        <div className="ps-item">
          <span className="ps-label">Cash</span>
          <span className="ps-value mono tnum">
            {fmtMoney(cash, { digits: 0 })}
          </span>
        </div>
      </div>
```

Replace with the same content but with extra classes on the second + third `.ps-item`:

```tsx
      <div className="portfolio-summary">
        <div className="ps-item ps-equity">
          <span className="ps-label">Portfolio</span>
          <span className="ps-value mono tnum">{fmtMoney(totalValue)}</span>
        </div>
        <div className="ps-item ps-pct">
          <span className="ps-label">All-time</span>
          <span ...>...</span>
        </div>
        <div className="ps-item ps-cash">
          <span className="ps-label">Cash</span>
          <span className="ps-value mono tnum">
            {fmtMoney(cash, { digits: 0 })}
          </span>
        </div>
      </div>
```

Find the status-pill `<span className="btn ghost sm">` block. The first text node inside is the status label. Wrap that label in a span with `.status-pill-label`:

```tsx
        <span
          className="btn ghost sm"
          title={statusPill.title}
          style={{ cursor: "default" }}
        >
          <span className="status-pill-label">{statusPill.label}</span>
          {/* keep the rest of the children unchanged: replay clock + dot */}
          ...
        </span>
```

- [ ] **Step 2: Typecheck + lint**

Run: `cd frontend && npx tsc -b && npx eslint src/components/TopBar.tsx`
Expected: 0 errors, 0 lint problems.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/TopBar.tsx
git commit -m "feat(topbar): burger button, ps-equity/pct/cash classes, status-pill-label"
```

---

## Task 5: `App.tsx` — own the drawer state

**Files:**
- Modify: `frontend/src/App.tsx`

Add a `sidebarOpen` state. Pass `open`+`onClose` to Sidebar, `onOpenSidebar` to TopBar.

- [ ] **Step 1: Apply the diff**

Inside `App({ user, readOnly })`, add the state next to the existing `useState` calls:

```tsx
  const [sidebarOpen, setSidebarOpen] = useState(false);
```

Update the `<TopBar ... />` JSX to add `onOpenSidebar`:

```tsx
      <TopBar
        ...existing props...
        user={user}
        readOnly={readOnly}
        onOpenSidebar={() => setSidebarOpen(true)}
      />
```

Update the `<Sidebar ... />` JSX:

```tsx
      <Sidebar
        page={page}
        onNavigate={onNavigate}
        portfolio={portfolio}
        activeAlerts={activeAlerts}
        unreadTriggered={unreadTriggered}
        provider={provider}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
```

- [ ] **Step 2: Typecheck + build**

Run: `cd frontend && npx tsc -b && npm run build`
Expected: 0 errors; build succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat(app): own sidebar drawer state"
```

---

## Task 6: Wrap pages' tables in `.table-scroll`

**Files:**
- Modify: `frontend/src/pages/PortfolioPage.tsx`
- Modify: `frontend/src/pages/OrdersPage.tsx`
- Modify: `frontend/src/pages/WatchlistPage.tsx`

Each `<table className="table">` (or equivalent rows container) gets wrapped in a `<div className="table-scroll">`. No layout change at desktop widths; on phones it scrolls horizontally with a right-edge gradient hint.

- [ ] **Step 1: PortfolioPage**

Find each occurrence of `<table className="table">` in `frontend/src/pages/PortfolioPage.tsx`. Wrap each in `<div className="table-scroll">...</div>`. If a table is already inside a `.card-body.p0` block, the wrapper goes between the `.card-body` and the `<table>`.

Example:

```tsx
<div className="card">
  <div className="card-header">...</div>
  <div className="card-body p0">
    <div className="table-scroll">
      <table className="table">...</table>
    </div>
  </div>
</div>
```

Apply to every `<table className="table">` in the file.

- [ ] **Step 2: OrdersPage**

Same wrap for every `<table className="table">` in `frontend/src/pages/OrdersPage.tsx`.

Additionally — find this in OrdersPage:

```tsx
<div className="orders-shelf-dates">
  ... date inputs ...
</div>
```

It's already correctly classed. The Task 2 CSS rule under `<480px` will stack it. No code change needed here.

- [ ] **Step 3: WatchlistPage**

The Watchlist's row layout uses `.wl-row` (a CSS grid), not a `<table>`. Wrap the rows container in `<div className="table-scroll">` so very narrow phones can scroll if needed. If WatchlistPage uses `<table>` instead in your branch (depending on a recent change), apply the same `<table className="table">` wrap.

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/PortfolioPage.tsx frontend/src/pages/OrdersPage.tsx frontend/src/pages/WatchlistPage.tsx
git commit -m "feat(pages): wrap tables in .table-scroll for mobile horizontal scroll"
```

---

## Task 7: Manual responsive smoke (the verification gate)

**Files:**
- (none — verification only)

This is the gate before the PR. Boot the stack and walk through each breakpoint with DevTools' device toolbar.

- [ ] **Step 1: Boot**

```bash
npm run dev
```

Open the app at `http://localhost:5011/app` (sign in or `BYPASS_AUTH=1`).

- [ ] **Step 2: 1440 × 900 (desktop wide)**

Sidebar full-width with labels, TopBar shows full 3-cell summary, status pill shows `Live · alpaca · IEX` (or similar), no burger visible.

- [ ] **Step 3: 1024 × 768 (tablet landscape)**

This is now ≥900 (desktop), so behavior is identical to Step 2.

- [ ] **Step 4: 900 × 700 (just below the new breakpoint)**

Below 900: sidebar collapses to icons, brand text disappears, TopBar shows the *compact* 2-cell summary (Equity + All-time) — Cash is hidden. Status pill still shows label.

- [ ] **Step 5: 640 × 1100 (just at the mobile breakpoint)**

Sidebar still icons. Compact summary visible.

- [ ] **Step 6: 414 × 896 (large phone)**

Sidebar disappears. Burger button appears in TopBar. Click it → sidebar slides in from left with full labels and a backdrop. Click backdrop → closes. Summary shows just Equity (no label, no All-time, no Cash). Status pill shows just the dot.

- [ ] **Step 7: 360 × 760 (small phone)**

Same as Step 6. Sidebar drawer takes ~80vw. Stat grid on Portfolio page is 2 columns.

- [ ] **Step 8: 320 × 568 (very small)**

Stat grid collapses to 1 column (the new `<480px` rule). OrdersPage date inputs stack vertically.

- [ ] **Step 9: Tables horizontal-scroll**

On a phone viewport, navigate to the Orders page (or Portfolio) and try to scroll a long table horizontally. Expect a faint right-edge gradient before scrolling and the gradient receding as you scroll right.

- [ ] **Step 10: Touch targets**

Random sample on a phone viewport: tap targets feel chunky enough — they're all `min-height: 40px`.

- [ ] **Step 11: Build**

```bash
npm run build
```
Expected: success.

- [ ] **Step 12: No commit**

Verification only.

---

## Phase 3 verification checklist (from spec §6.5)

**Existing-app responsive audit (§3.3)**
- [ ] Sidebar hides at < 640px, burger opens drawer.
- [ ] TopBar shows compact equity 640–1099px, single chip < 640px.
- [ ] OrdersPage date inputs stack at < 480px.
- [ ] Tables horizontal-scroll cleanly with right-edge gradient hint.

**Touch targets**
- [ ] All interactive elements `min-height: 40px` at < 640px.

**Breakpoint sanity**
- [ ] 1100→900 breakpoint drop applied; the previous "sidebar collapses at 1100" behavior now happens at 900.

## Phase 3 PR description template

```
Phase 3 of the landing-page + Google-auth project. Pure responsive
audit of the existing app — no new features.

- Sidebar collapses-to-icons threshold dropped from 1100px to 900px.
- Sidebar hides entirely at <640px and re-appears as a left-slide drawer
  triggered from a new TopBar burger button.
- TopBar portfolio summary becomes compact (Equity + Day P/L) at
  640–1099px, then a single Equity chip at <640px.
- Status pill keeps just the dot at <640px.
- All interactive elements ≥ 40×40 px at <640px.
- Tables wrap in .table-scroll for graceful horizontal overflow with a
  faint right-edge gradient hint.
- OrdersPage date pair stacks vertically at <480px.

Spec: docs/superpowers/specs/2026-05-19-landing-page-and-google-auth-design.md §3
Plan: docs/superpowers/plans/2026-05-19-landing-phase-3-responsive-audit.md
```
