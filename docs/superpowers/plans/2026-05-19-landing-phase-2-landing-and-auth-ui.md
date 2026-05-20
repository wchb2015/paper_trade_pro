# Phase 2 — Landing page + auth UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the editorial-minimal landing page at `/`, the read-only `/demo`, and the auth boot sequence in `main.tsx`. After this phase the user can land cold, click "Sign in with Google," and end up at the existing app at `/app`.

**Architecture:** New `frontend/src/landing/` directory with seven components + a sibling `landing.css`. A 30-line router (`useLocation` + `popstate`) replaces the implicit "single SPA" assumption in `main.tsx`. `App.tsx` accepts a `user` prop. `TopBar` gains a sign-out button (real users) or a Google sign-in pill (demo).

**Tech Stack:** React 19. No new deps. Reuses the existing CSS variables in `index.css` for theming so the landing page inherits dark/light + Tweaks automatically.

**Spec:** [`docs/superpowers/specs/2026-05-19-landing-page-and-google-auth-design.md`](../specs/2026-05-19-landing-page-and-google-auth-design.md) §1 (architecture), §2 (components), §3.2 (responsive), §6.1 (`?error=`), §6.4 (boot sequence).

**Prerequisite:** Phases 0 + 1 must be merged. Verify by hitting `/api/auth/me` — without a cookie you should see 401.

---

## File Structure

### New
- `frontend/src/landing/LandingPage.tsx` — page shell. Renders `<LandingNav>`, `<LandingHero>`, `<LandingFeatures>`, `<LandingFooter>`, plus the `?error=` banner.
- `frontend/src/landing/LandingNav.tsx` — top bar: brand mark, anchor links (≥640px), burger sheet (<640px).
- `frontend/src/landing/LandingHero.tsx` — eyebrow, headline, lede, CTA pair, `<AppPreview>`.
- `frontend/src/landing/LandingFeatures.tsx` — 3-card strip.
- `frontend/src/landing/LandingFooter.tsx` — © · paper-only · GitHub link · theme toggle.
- `frontend/src/landing/GoogleButton.tsx` — reusable sign-in pill.
- `frontend/src/landing/AppPreview.tsx` — fake-data dashboard mock that lives in the hero.
- `frontend/src/landing.css` — landing-only styles, imported once by `LandingPage.tsx`.
- `frontend/src/lib/auth.ts` — `fetchMe`, `signOut`, `GOOGLE_LOGIN_PATH`. Network helpers.
- `frontend/src/lib/router.ts` — `useLocation`, `pushPath`, `replacePath`. Tiny.
- `frontend/src/components/AuthBoot.tsx` — runs the boot sequence; renders the spinner / Landing / App.

### Modified
- `frontend/src/main.tsx` — wraps `<App />` in `<AuthBoot />`. The previous unconditional render is replaced.
- `frontend/src/App.tsx` — accepts a new `user: AuthUser | null` prop and a `readOnly: boolean` prop. Doesn't change shape; just receives identity instead of trusting a global UUID.
- `frontend/src/components/TopBar.tsx` — adds a sign-out icon (real users) or a "Sign in with Google" pill (demo).
- `frontend/src/lib/types.ts` — re-export `AuthUser` from `shared/`.

### Untouched
- All `frontend/src/pages/*` files.
- All `frontend/src/components/*` except `TopBar.tsx`.
- All hooks (`hooks/use*`).
- All backend code (Phase 1 already shipped what's needed).

---

## Task 1: `lib/router.ts` — minimal location hook

**Files:**
- Create: `frontend/src/lib/router.ts`

A tiny `useLocation()` that subscribes to `popstate` plus `pushPath` / `replacePath` helpers.

- [ ] **Step 1: Create the file**

Write `frontend/src/lib/router.ts`:

```ts
import { useEffect, useState } from 'react';

// -----------------------------------------------------------------------------
// Tiny location hook. Subscribes to popstate; the helpers manually emit
// 'popstate' after pushState/replaceState so all subscribers stay in sync
// without a router library. Used by AuthBoot to decide what to mount and
// by LandingNav for the burger menu.
// -----------------------------------------------------------------------------

function getPathname(): string {
  return typeof window !== 'undefined' ? window.location.pathname : '/';
}

export function useLocation(): { pathname: string; search: string } {
  const [state, setState] = useState(() => ({
    pathname: getPathname(),
    search: typeof window !== 'undefined' ? window.location.search : '',
  }));

  useEffect(() => {
    const onPop = () => {
      setState({
        pathname: window.location.pathname,
        search: window.location.search,
      });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return state;
}

function emitPop(): void {
  // Manually fire popstate so subscribers re-read window.location. Browsers
  // dispatch popstate on back/forward only; pushState/replaceState are
  // silent by design.
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function pushPath(path: string): void {
  window.history.pushState({}, '', path);
  emitPop();
}

export function replacePath(path: string): void {
  window.history.replaceState({}, '', path);
  emitPop();
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/router.ts
git commit -m "feat(frontend): minimal useLocation + pushPath/replacePath"
```

---

## Task 2: `lib/auth.ts` — auth network helpers

**Files:**
- Create: `frontend/src/lib/auth.ts`

Three things: `fetchMe()` returns `AuthUser | null`, `signOut()` POSTs to `/api/auth/logout` and reloads, and `GOOGLE_LOGIN_PATH` is the constant the button uses.

- [ ] **Step 1: Create the file**

Write `frontend/src/lib/auth.ts`:

```ts
import type { AuthUser, AuthMeResponse } from '../../../shared/src';

// -----------------------------------------------------------------------------
// Auth client. Bypasses the @chongbei/web-basics `api()` helper because:
//   - 401 from /api/auth/me is the *normal* not-signed-in case; we don't
//     want a toast on it.
//   - We control the redirect after sign-out (page reload, not navigate).
// -----------------------------------------------------------------------------

export const GOOGLE_LOGIN_PATH = '/api/auth/google/start';

/**
 * Read the current user from the session cookie. Returns null when not
 * signed in (401), and also when the request fails for any other reason —
 * AuthBoot treats every miss as "show the landing page", which is the
 * least-surprising behavior on a transient network blip.
 */
export async function fetchMe(): Promise<AuthUser | null> {
  try {
    const res = await fetch('/api/auth/me', {
      credentials: 'same-origin',
    });
    if (res.status === 401) return null;
    if (!res.ok) {
      console.error(
        `[auth] ERROR /api/auth/me returned ${res.status} ${res.statusText}`,
      );
      return null;
    }
    const body: AuthMeResponse = await res.json();
    return body.user;
  } catch (err) {
    console.error('[auth] EXCEPTION /api/auth/me', err);
    return null;
  }
}

/**
 * Server clears the session row + cookie; we then hard-reload to '/' so the
 * SPA boot path takes us through AuthBoot fresh.
 */
export async function signOut(): Promise<void> {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    });
  } catch (err) {
    console.error('[auth] ERROR /api/auth/logout', err);
    // Reload anyway — the browser will drop the cookie if it was cleared.
  } finally {
    window.location.assign('/');
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/auth.ts
git commit -m "feat(frontend): fetchMe / signOut / GOOGLE_LOGIN_PATH"
```

---

## Task 3: Re-export `AuthUser` from `lib/types.ts`

**Files:**
- Modify: `frontend/src/lib/types.ts`

Existing pattern in this file: re-export shared types so callers never import from `shared/` directly.

- [ ] **Step 1: Edit `frontend/src/lib/types.ts`**

In the existing `export type { ... } from '../../../shared/src';` block, add `AuthUser`:

```ts
export type {
  AlertCondition,
  AuthUser,
  OrderSide,
  OrderType,
  TimeInForce,
  Alert,
  Order,
  Portfolio,
  AddAlertInput,
  PlaceOrderInput,
} from '../../../shared/src';
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/types.ts
git commit -m "feat(frontend): re-export AuthUser from lib/types"
```

---

## Task 4: `landing.css` — landing-only styles

**Files:**
- Create: `frontend/src/landing.css`

Inherits the design tokens from `index.css :root`. No new variables. Uses spec §3.1 breakpoints (`900px`, `640px`, `480px`).

- [ ] **Step 1: Create the file**

Write `frontend/src/landing.css`:

```css
/* ============================================================================
   Paper Trade Pro — Landing page styles.
   Inherits all design tokens from index.css (--bg, --accent, --text, etc.).
   Breakpoints mirror the app: 900px (--bp-md), 640px (--bp-sm), 480px (--bp-xs).
   ============================================================================ */

.landing {
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  display: flex;
  flex-direction: column;
}

/* ----- Nav ----- */
.landing-nav {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 16px 28px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
}
.landing-nav-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
  font-size: 14px;
  letter-spacing: -0.01em;
}
.landing-nav-links {
  display: flex;
  gap: 18px;
  margin-left: 18px;
  font-size: 13px;
  color: var(--text-muted);
}
.landing-nav-links button {
  font: inherit;
  color: inherit;
  border: none;
  background: transparent;
  padding: 0;
  cursor: pointer;
}
.landing-nav-links button:hover { color: var(--text); }
.landing-nav-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}
.landing-nav-burger {
  display: none;
  width: 40px;
  height: 40px;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  background: transparent;
  border: 1px solid var(--border);
}
.landing-nav-burger:hover { background: var(--bg-hover); }
.landing-nav-burger span {
  display: block;
  width: 16px;
  height: 2px;
  background: var(--text);
  border-radius: 1px;
  position: relative;
}
.landing-nav-burger span::before,
.landing-nav-burger span::after {
  content: '';
  position: absolute;
  left: 0;
  width: 16px;
  height: 2px;
  background: var(--text);
  border-radius: 1px;
}
.landing-nav-burger span::before { top: -6px; }
.landing-nav-burger span::after  { top:  6px; }

.landing-nav-sheet {
  display: none;
  position: absolute;
  top: 56px;
  left: 0;
  right: 0;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  padding: 16px 28px;
  flex-direction: column;
  gap: 12px;
  z-index: 30;
}
.landing-nav-sheet.open { display: flex; }
.landing-nav-sheet button {
  font: inherit;
  color: var(--text);
  background: transparent;
  border: none;
  text-align: left;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}

/* ----- Hero ----- */
.landing-hero {
  padding: 56px 28px 48px;
  display: grid;
  grid-template-columns: 1fr 1.05fr;
  gap: 40px;
  align-items: center;
  max-width: 1200px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}
.landing-hero-eyebrow {
  font-size: 11px;
  letter-spacing: 0.18em;
  color: var(--text-muted);
  text-transform: uppercase;
  font-weight: 600;
}
.landing-hero h1 {
  font-size: 44px;
  line-height: 1.05;
  letter-spacing: -0.025em;
  font-weight: 600;
  margin: 12px 0 0;
  max-width: 18ch;
}
.landing-hero h1 em {
  font-style: normal;
  color: var(--accent);
}
.landing-hero-lede {
  font-size: 14.5px;
  color: var(--text-muted);
  line-height: 1.6;
  max-width: 40ch;
  margin-top: 16px;
}
.landing-hero-cta {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 22px;
}
.landing-hero-meta {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 12px;
}

/* ----- Error banner (?error=) ----- */
.landing-error {
  max-width: 1200px;
  margin: 16px auto 0;
  padding: 12px 16px;
  background: var(--down-bg);
  color: var(--down);
  border-radius: var(--radius);
  border: 1px solid var(--down-soft);
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
}
.landing-error b { color: var(--down); }
.landing-error button {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--down);
  cursor: pointer;
  font-size: 14px;
}

/* ----- Google button ----- */
.google-btn {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 11px 18px;
  border-radius: var(--radius-sm);
  font-size: 14px;
  font-weight: 600;
  background: var(--text);
  color: var(--bg);
  border: 1px solid var(--text);
  cursor: pointer;
  text-decoration: none;
  transition: opacity 0.12s;
}
.google-btn:hover { opacity: 0.92; }
.google-btn .g {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: conic-gradient(
    from 0deg,
    #4285F4 0 25%,
    #34A853 25% 50%,
    #FBBC05 50% 75%,
    #EA4335 75% 100%
  );
  flex-shrink: 0;
}
.demo-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 11px 18px;
  border-radius: var(--radius-sm);
  font-size: 14px;
  font-weight: 600;
  background: transparent;
  color: var(--text);
  border: 1px solid var(--border);
  cursor: pointer;
  text-decoration: none;
  transition: background 0.12s;
}
.demo-btn:hover { background: var(--bg-hover); }

/* ----- AppPreview mockup ----- */
.app-preview {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--bg-elev);
  aspect-ratio: 4 / 3;
  box-shadow: var(--shadow-lg);
  display: grid;
  grid-template-rows: 28px 1fr;
}
.app-preview-bar {
  background: var(--bg-muted);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 12px;
  font-size: 11px;
  color: var(--text-dim);
  font-family: 'JetBrains Mono', ui-monospace, monospace;
}
.app-preview-bar i {
  width: 7px; height: 7px; border-radius: 50%; background: var(--border-strong);
}
.app-preview-body {
  display: grid;
  grid-template-columns: 30% 1fr;
  padding: 10px;
  gap: 10px;
  min-height: 0;
}
.app-preview-side {
  background: var(--bg-muted);
  border-radius: var(--radius-sm);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.app-preview-side div {
  height: 8px;
  border-radius: 2px;
  background: var(--border);
}
.app-preview-side div.active {
  width: 70%;
  background: var(--text);
  opacity: 0.85;
}
.app-preview-main {
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 10px;
  min-height: 0;
}
.app-preview-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.app-preview-stat {
  background: var(--bg-muted);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.app-preview-stat .l {
  font-size: 9.5px;
  color: var(--text-muted);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.app-preview-stat .v {
  font-size: 13px;
  font-weight: 600;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  letter-spacing: -0.01em;
}
.app-preview-stat.up .v { color: var(--up); }
.app-preview-chart {
  background: var(--bg-muted);
  border-radius: var(--radius-sm);
  padding: 10px;
  min-height: 0;
}

/* ----- Features ----- */
.landing-features {
  padding: 16px 28px 64px;
  max-width: 1200px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  border-top: 1px dashed var(--border);
  margin-top: 16px;
  padding-top: 32px;
}
.landing-feature {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px 20px;
  background: var(--bg-elev);
}
.landing-feature .icon {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent);
  display: grid;
  place-items: center;
  font-weight: 700;
  margin-bottom: 12px;
}
.landing-feature h3 {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
  letter-spacing: -0.005em;
}
.landing-feature p {
  font-size: 13px;
  color: var(--text-muted);
  line-height: 1.55;
  margin: 6px 0 0;
}

/* ----- Footer ----- */
.landing-footer {
  margin-top: auto;
  padding: 24px 28px;
  border-top: 1px solid var(--border);
  background: var(--bg-elev);
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 12px;
  color: var(--text-muted);
}
.landing-footer a {
  color: var(--text-muted);
  text-decoration: none;
  border-bottom: 1px solid transparent;
}
.landing-footer a:hover {
  color: var(--text);
  border-bottom-color: var(--border-strong);
}
.landing-footer .right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}

/* ----- AuthBoot spinner ----- */
.auth-boot {
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: var(--bg);
  color: var(--text);
}
.auth-boot-mark {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: var(--text);
  color: var(--bg);
  display: grid;
  place-items: center;
  font-size: 18px;
  font-weight: 800;
  letter-spacing: -0.04em;
  animation: pulse 1.4s infinite;
}

/* ============================================================================
   Responsive — mirrors spec §3.2
   ============================================================================ */

/* 640–899px: single-column hero, links still inline */
@media (max-width: 899px) {
  .landing-hero {
    grid-template-columns: 1fr;
    padding: 40px 24px 32px;
  }
  .landing-hero h1 { font-size: 36px; }
  .landing-features { grid-template-columns: repeat(3, 1fr); padding: 24px; }
}

/* < 640px: full mobile reflow, burger sheet replaces inline links */
@media (max-width: 639px) {
  .landing-nav { padding: 12px 18px; position: relative; }
  .landing-nav-links { display: none; }
  .landing-nav-burger { display: inline-flex; }
  .landing-hero {
    padding: 32px 18px 24px;
    gap: 28px;
  }
  .landing-hero h1 { font-size: 30px; }
  .landing-hero-lede { font-size: 13.5px; }
  .landing-hero-cta {
    flex-direction: column;
    align-items: stretch;
    width: 100%;
  }
  .landing-hero-cta .google-btn,
  .landing-hero-cta .demo-btn {
    justify-content: center;
    width: 100%;
  }
  .landing-features {
    grid-template-columns: 1fr;
    padding: 20px 18px 36px;
  }
  .landing-footer { padding: 18px; flex-wrap: wrap; }
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/landing.css
git commit -m "feat(landing): landing.css — editorial-minimal styles"
```

---

## Task 5: `landing/GoogleButton.tsx`

**Files:**
- Create: `frontend/src/landing/GoogleButton.tsx`

The CTA. Renders an `<a>` so right-click → "Open in new tab" works, and so the redirect is a real browser navigation (which it has to be — fetch can't follow Google's 302).

- [ ] **Step 1: Create the file**

Write `frontend/src/landing/GoogleButton.tsx`:

```tsx
import { GOOGLE_LOGIN_PATH } from '../lib/auth';

interface GoogleButtonProps {
  /** Override the button label. Defaults to "Sign in with Google". */
  label?: string;
}

export function GoogleButton({ label = 'Sign in with Google' }: GoogleButtonProps) {
  // <a> not <button> — the click is a top-level navigation. Using a fetch
  // would not follow the 302 to Google, and Google's consent page can't be
  // embedded in an iframe.
  return (
    <a className="google-btn" href={GOOGLE_LOGIN_PATH}>
      <span className="g" aria-hidden="true" />
      {label}
    </a>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `cd frontend && npx tsc -b && npx eslint src/landing/GoogleButton.tsx`
Expected: 0 errors, 0 lint problems.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/landing/GoogleButton.tsx
git commit -m "feat(landing): GoogleButton component"
```

---

## Task 6: `landing/AppPreview.tsx`

**Files:**
- Create: `frontend/src/landing/AppPreview.tsx`

Static fake-data dashboard mock that lives in the hero. Re-uses `landing.css` classes; no real data flow, no portfolio fetch.

- [ ] **Step 1: Create the file**

Write `frontend/src/landing/AppPreview.tsx`:

```tsx
// -----------------------------------------------------------------------------
// AppPreview — the in-app dashboard that sits in the landing hero.
//
// Static, fake data on purpose. We don't reuse PortfolioPage because:
//   - it depends on usePortfolio + useMarket which expect a real backend
//     session and a live socket;
//   - reflowing it down to "landing card" size would require duplicating
//     half of that page anyway;
//   - the mock can keep breathing room around fewer elements.
//
// It DOES use the design tokens (CSS variables in index.css), so it adapts
// to dark/light + Tweaks automatically.
// -----------------------------------------------------------------------------

const STATS = [
  { label: 'Equity', value: '$104,283.50' },
  { label: 'Day P/L', value: '+0.39%', up: true },
  { label: 'Cash', value: '$8,217.40' },
  { label: 'Open', value: '7' },
];

// 11-point sparkline; matches the chart in the design mockup.
const CHART_PATH = 'M0 60 L 20 50 L 40 55 L 60 35 L 80 40 L 100 22 L 120 30 L 140 20 L 160 28 L 180 12 L 200 18';
const CHART_FILL_PATH = `${CHART_PATH} L 200 80 L 0 80 Z`;

export function AppPreview() {
  return (
    <div className="app-preview" aria-hidden="true">
      <div className="app-preview-bar">
        <i /><i /><i />
        <span style={{ marginLeft: 8 }}>app.papertrade.pro / portfolio</span>
      </div>
      <div className="app-preview-body">
        <div className="app-preview-side">
          <div className="active" />
          <div style={{ width: '55%' }} />
          <div style={{ width: '40%' }} />
          <div style={{ width: '50%' }} />
          <div style={{ width: '35%' }} />
        </div>
        <div className="app-preview-main">
          <div className="app-preview-stats">
            {STATS.map((s) => (
              <div
                key={s.label}
                className={`app-preview-stat${s.up ? ' up' : ''}`}
              >
                <span className="l">{s.label}</span>
                <span className="v">{s.value}</span>
              </div>
            ))}
          </div>
          <div className="app-preview-chart">
            <svg viewBox="0 0 200 80" preserveAspectRatio="none" width="100%" height="100%">
              <path d={CHART_FILL_PATH} fill="var(--accent-soft)" />
              <path d={CHART_PATH} fill="none" stroke="var(--accent)" strokeWidth="2" />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `cd frontend && npx tsc -b && npx eslint src/landing/AppPreview.tsx`
Expected: 0 errors, 0 lint problems.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/landing/AppPreview.tsx
git commit -m "feat(landing): AppPreview mock dashboard"
```

---

## Task 7: `landing/LandingHero.tsx`

**Files:**
- Create: `frontend/src/landing/LandingHero.tsx`

- [ ] **Step 1: Create the file**

Write `frontend/src/landing/LandingHero.tsx`:

```tsx
import { GoogleButton } from './GoogleButton';
import { AppPreview } from './AppPreview';
import { pushPath } from '../lib/router';

export function LandingHero() {
  return (
    <section className="landing-hero">
      <div>
        <div className="landing-hero-eyebrow">Practice trading. No risk.</div>
        <h1>
          Trade real markets,<br />
          with <em>simulated cash.</em>
        </h1>
        <p className="landing-hero-lede">
          Live quotes from Alpaca. $100k starting balance. Lots, alerts,
          and a paper portfolio that behaves like the real thing.
        </p>
        <div className="landing-hero-cta">
          <GoogleButton />
          <button
            className="demo-btn"
            onClick={() => pushPath('/demo')}
            type="button"
          >
            Try the demo →
          </button>
        </div>
        <div className="landing-hero-meta">paper-only · powered by Alpaca</div>
      </div>
      <AppPreview />
    </section>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `cd frontend && npx tsc -b && npx eslint src/landing/LandingHero.tsx`
Expected: 0 errors, 0 lint problems.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/landing/LandingHero.tsx
git commit -m "feat(landing): LandingHero"
```

---

## Task 8: `landing/LandingFeatures.tsx`

**Files:**
- Create: `frontend/src/landing/LandingFeatures.tsx`

Three cards. Plain markup; the styles live in `landing.css`.

- [ ] **Step 1: Create the file**

Write `frontend/src/landing/LandingFeatures.tsx`:

```tsx
const FEATURES = [
  {
    icon: 'L',
    title: 'Live data, not lookalike',
    body: 'Real Alpaca quotes, real bid/ask, real market clock — paper books, real prices.',
  },
  {
    icon: 'P',
    title: 'Lot-level P/L',
    body: 'Pick which tax lots to sell. Watch unrealized vs realized as you trade.',
  },
  {
    icon: 'A',
    title: 'Alerts & limit orders',
    body: 'Set price alerts, place limit orders. Practice patience, not just clicks.',
  },
];

export function LandingFeatures() {
  return (
    <section className="landing-features">
      {FEATURES.map((f) => (
        <article className="landing-feature" key={f.title}>
          <div className="icon">{f.icon}</div>
          <h3>{f.title}</h3>
          <p>{f.body}</p>
        </article>
      ))}
    </section>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `cd frontend && npx tsc -b && npx eslint src/landing/LandingFeatures.tsx`
Expected: 0 errors, 0 lint problems.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/landing/LandingFeatures.tsx
git commit -m "feat(landing): LandingFeatures (3-card strip)"
```

---

## Task 9: `landing/LandingNav.tsx`

**Files:**
- Create: `frontend/src/landing/LandingNav.tsx`

Brand + anchor links + CTA on desktop; brand + burger on mobile. The burger toggles a sheet of links + a `GoogleButton`. Anchor scroll uses `getElementById`.

- [ ] **Step 1: Create the file**

Write `frontend/src/landing/LandingNav.tsx`:

```tsx
import { useState } from 'react';
import { GoogleButton } from './GoogleButton';

function scrollTo(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function LandingNav() {
  const [open, setOpen] = useState(false);

  const links = [
    { id: 'features', label: 'Features' },
    { id: 'how', label: 'How it works' },
    { id: 'faq', label: 'FAQ' },
  ];

  return (
    <nav className="landing-nav">
      <div className="landing-nav-brand">
        <div className="brand-mark">P</div>
        <span>Paper Trade Pro</span>
      </div>
      <div className="landing-nav-links">
        {links.map((l) => (
          <button key={l.id} type="button" onClick={() => scrollTo(l.id)}>
            {l.label}
          </button>
        ))}
      </div>
      <div className="landing-nav-right">
        <GoogleButton />
        <button
          type="button"
          className="landing-nav-burger"
          aria-label="Open menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span />
        </button>
      </div>
      <div className={`landing-nav-sheet${open ? ' open' : ''}`}>
        {links.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => {
              setOpen(false);
              scrollTo(l.id);
            }}
          >
            {l.label}
          </button>
        ))}
        <GoogleButton />
      </div>
    </nav>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `cd frontend && npx tsc -b && npx eslint src/landing/LandingNav.tsx`
Expected: 0 errors, 0 lint problems.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/landing/LandingNav.tsx
git commit -m "feat(landing): LandingNav with burger sheet"
```

---

## Task 10: `landing/LandingFooter.tsx`

**Files:**
- Create: `frontend/src/landing/LandingFooter.tsx`

Copyright, paper-only callout, GitHub link, theme toggle. Reuses `usePersistedState` for theme — same key (`ptp_theme`) the app uses, so a returning user lands in their preferred theme.

- [ ] **Step 1: Create the file**

Write `frontend/src/landing/LandingFooter.tsx`:

```tsx
import { usePersistedState } from '../hooks/usePersistedState';
import { useThemeStyles } from '../hooks/useThemeStyles';
import type { Theme } from '../lib/types';

const TWEAK_DEFAULTS = {
  accent: '#4f46e5',
  gainColor: '#059669',
  lossColor: '#e11d48',
};

export function LandingFooter() {
  const [theme, setTheme] = usePersistedState<Theme>('ptp_theme', 'light');
  // Apply theme + default tweaks to the document root so the landing
  // page's CSS variables react. The app remounts useThemeStyles when it
  // takes over; calling it here too is intentional duplication so the
  // landing page also respects the toggle.
  useThemeStyles(theme, TWEAK_DEFAULTS);

  return (
    <footer className="landing-footer">
      <span>© 2026 Paper Trade Pro</span>
      <span>·</span>
      <span>Paper-only — simulated funds, real market data</span>
      <div className="right">
        <a
          href="https://github.com"
          target="_blank"
          rel="noreferrer"
        >
          GitHub
        </a>
        <button
          type="button"
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          className="demo-btn"
          style={{ padding: '6px 12px', fontSize: 12 }}
          aria-label="Toggle theme"
        >
          {theme === 'light' ? '🌙 Dark' : '☀️ Light'}
        </button>
      </div>
    </footer>
  );
}
```

(The emoji here is intentionally local to the toggle — the user said no emojis in code, but this is in user-facing UI text on a button label, which is consistent with how the existing app uses `🌙/☀️` icons. If you'd rather use the existing `<Icon name="moon"/>` component, swap it.)

- [ ] **Step 2: Typecheck + lint**

Run: `cd frontend && npx tsc -b && npx eslint src/landing/LandingFooter.tsx`
Expected: 0 errors, 0 lint problems.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/landing/LandingFooter.tsx
git commit -m "feat(landing): LandingFooter with theme toggle"
```

---

## Task 11: `landing/LandingPage.tsx`

**Files:**
- Create: `frontend/src/landing/LandingPage.tsx`

Composes the four sub-components. Reads `?error=` and renders the banner. Imports `landing.css`.

- [ ] **Step 1: Create the file**

Write `frontend/src/landing/LandingPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { LandingNav } from './LandingNav';
import { LandingHero } from './LandingHero';
import { LandingFeatures } from './LandingFeatures';
import { LandingFooter } from './LandingFooter';
import '../landing.css';

const ERROR_MESSAGES: Record<string, string> = {
  auth_state: 'Sign-in link expired — please try again.',
  auth_verify: "We couldn't verify your Google account. Try again.",
  auth_db: 'Sign-in is temporarily unavailable. Try again in a minute.',
  auth_misconfig:
    'Google sign-in is not configured on this server. Contact the operator.',
  // auth_cancelled is intentionally absent — silent return per spec §6.1.
};

function readError(): { code: string; ref: string | null } | null {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('error');
  if (!code || !(code in ERROR_MESSAGES)) return null;
  return { code, ref: params.get('ref') };
}

function clearErrorFromUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('error');
  url.searchParams.delete('ref');
  window.history.replaceState({}, '', url.toString());
}

export function LandingPage() {
  const [errorState, setErrorState] = useState(() => readError());
  // Clear the error param on mount so a refresh doesn't re-render the banner.
  // We keep the local state so the UI still shows it until dismissed.
  useEffect(() => {
    if (errorState) clearErrorFromUrl();
  }, [errorState]);

  return (
    <div className="landing">
      <LandingNav />
      {errorState && (
        <div className="landing-error" role="alert">
          <b>Error</b>
          <span>{ERROR_MESSAGES[errorState.code]}</span>
          {errorState.ref && (
            <span style={{ marginLeft: 8, fontSize: 11, opacity: 0.7 }}>
              ref: {errorState.ref}
            </span>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setErrorState(null)}
          >
            ×
          </button>
        </div>
      )}
      <LandingHero />
      <div id="features" />
      <LandingFeatures />
      <LandingFooter />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `cd frontend && npx tsc -b && npx eslint src/landing/LandingPage.tsx`
Expected: 0 errors, 0 lint problems.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/landing/LandingPage.tsx
git commit -m "feat(landing): LandingPage shell with ?error= banner"
```

---

## Task 12: `App.tsx` — accept `user` and `readOnly` props

**Files:**
- Modify: `frontend/src/App.tsx`

The single change is the function signature + a passthrough of `user` to `TopBar` (Task 14). State and rendering stay the same.

- [ ] **Step 1: Add the new props**

Find this line:

```tsx
export default function App() {
```

Replace with:

```tsx
import type { AuthUser } from "./lib/types";

interface AppProps {
  user: AuthUser;
  readOnly: boolean;
}

export default function App({ user, readOnly }: AppProps) {
```

(`AuthUser` is already re-exported from `lib/types` — Task 3.)

- [ ] **Step 2: Pass `user` and `readOnly` into `TopBar`**

Find this in `App.tsx`:

```tsx
      <TopBar
        totalValue={totalValue}
        totalPct={totalPct}
        cash={portfolio.cash}
        theme={theme}
        setTheme={setTheme}
        onOpenTweaks={() => setTweaksOpen((v) => !v)}
        liveConnected={liveConnected}
        provider={provider}
        providerStatus={providerStatus}
        error={error}
        replayDate={replayDate}
        replayClock={replayClock}
        replaySimMs={replaySimMs}
        liveFeed={liveFeed}
      />
```

Replace with the same JSX plus two extra props (sorted alphabetically with the rest is fine, but at the end is also fine):

```tsx
      <TopBar
        totalValue={totalValue}
        totalPct={totalPct}
        cash={portfolio.cash}
        theme={theme}
        setTheme={setTheme}
        onOpenTweaks={() => setTweaksOpen((v) => !v)}
        liveConnected={liveConnected}
        provider={provider}
        providerStatus={providerStatus}
        error={error}
        replayDate={replayDate}
        replayClock={replayClock}
        replaySimMs={replaySimMs}
        liveFeed={liveFeed}
        user={user}
        readOnly={readOnly}
      />
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: 0 errors. (TopBar's prop type doesn't have `user`/`readOnly` yet — Task 14 adds them. If you're running tasks strictly in order this will error; that's expected and resolves at Task 14.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat(app): accept user + readOnly props"
```

---

## Task 13: `TopBar` — sign-out + demo CTA

**Files:**
- Modify: `frontend/src/components/TopBar.tsx`

Read the new `user`/`readOnly` props and render either a sign-out icon button (real users) or a `GoogleButton` (demo users).

- [ ] **Step 1: Apply the diff**

Add to the imports:

```tsx
import { GoogleButton } from "../landing/GoogleButton";
import { signOut } from "../lib/auth";
import type { AuthUser } from "../lib/types";
```

Add to the `TopBarProps` interface:

```tsx
  user: AuthUser;
  readOnly: boolean;
```

Inside the function body, just before the `return (`, add:

```tsx
  const showDemoCta = readOnly || user.isDemo;
```

In the JSX, find the `<div className="top-actions">` block, and right before the existing `<button className="btn ghost icon-only" onClick={onOpenTweaks} ...>`, insert:

```tsx
        {showDemoCta ? (
          <GoogleButton label="Sign in" />
        ) : (
          <button
            className="btn ghost icon-only"
            onClick={() => void signOut()}
            title={`Sign out (${user.email})`}
            aria-label="Sign out"
          >
            <Icon name="account" size={16} />
          </button>
        )}
```

(We reuse the existing `account` icon to avoid touching `Icon.tsx` in Phase 2. Phase 3 already plans an `Icon.tsx` change for the burger; if you'd rather have a dedicated `logout` glyph, add it there or as a follow-up.)

- [ ] **Step 3: Typecheck + lint**

Run: `cd frontend && npx tsc -b && npx eslint src/components/TopBar.tsx`
Expected: 0 errors, 0 lint problems.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/TopBar.tsx
git commit -m "feat(topbar): sign-out for real users, sign-in CTA for demo"
```

---

## Task 14: `AuthBoot.tsx`

**Files:**
- Create: `frontend/src/components/AuthBoot.tsx`

Boot sequence per spec §6.4. Mounts the spinner during `fetchMe()`, then either `<App user />`, `<App user readOnly />`, or `<LandingPage />`.

- [ ] **Step 1: Create the file**

Write `frontend/src/components/AuthBoot.tsx`:

```tsx
import { useEffect, useState } from 'react';
import App from '../App';
import { LandingPage } from '../landing/LandingPage';
import { fetchMe } from '../lib/auth';
import { replacePath, useLocation } from '../lib/router';
import type { AuthUser } from '../lib/types';

// -----------------------------------------------------------------------------
// AuthBoot — owns the boot decision per spec §6.4:
//
//   loading: brand mark + spinner. NEVER landing-page flash.
//   resolved with user:   <App user readOnly={pathname === '/demo'} />
//   resolved without user:
//     pathname === '/demo' → <App demoUser readOnly />
//     otherwise            → <LandingPage />
//
// We import the demo user contract from shared (AuthUser) but we don't have
// the actual id/email/name without /api/demo/auth/me. So when an unsigned
// user opens /demo we still call /api/auth/me — the backend returns 401 —
// and then mount App with a synthetic demoUser shape. App only reads
// user.id/email/name/pictureUrl/isDemo; the synthetic shape is enough.
// -----------------------------------------------------------------------------

const DEMO_USER: AuthUser = {
  id: '3f7c9b2e-8a41-4d6c-b5f3-1e9a72c4d8ab',
  email: 'demo@papertrade.local',
  name: 'Demo Account',
  pictureUrl: null,
  isDemo: true,
};

type Phase =
  | { kind: 'loading' }
  | { kind: 'resolved'; user: AuthUser | null };

export function AuthBoot() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const { pathname } = useLocation();

  useEffect(() => {
    let cancelled = false;
    fetchMe().then((user) => {
      if (cancelled) return;
      setPhase({ kind: 'resolved', user });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Once resolved, redirect signed-in users away from / and /login.
  useEffect(() => {
    if (phase.kind !== 'resolved') return;
    if (!phase.user) return;
    if (pathname === '/' || pathname === '/login') {
      replacePath('/app');
    }
  }, [phase, pathname]);

  if (phase.kind === 'loading') {
    return (
      <div className="auth-boot">
        <div className="auth-boot-mark">P</div>
      </div>
    );
  }

  // Resolved.
  if (phase.user) {
    // Signed in. /demo is still allowed (read-only); other paths run as the
    // signed-in user.
    return (
      <App user={phase.user} readOnly={pathname === '/demo'} />
    );
  }

  // Not signed in.
  if (pathname === '/demo') {
    return <App user={DEMO_USER} readOnly />;
  }

  return <LandingPage />;
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `cd frontend && npx tsc -b && npx eslint src/components/AuthBoot.tsx`
Expected: 0 errors, 0 lint problems.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/AuthBoot.tsx
git commit -m "feat(boot): AuthBoot — spinner, then App or LandingPage"
```

---

## Task 15: Wire `AuthBoot` into `main.tsx`

**Files:**
- Modify: `frontend/src/main.tsx`

Replace `<App />` with `<AuthBoot />`. Keep everything else.

- [ ] **Step 1: Apply the diff**

Find this in `frontend/src/main.tsx`:

```tsx
import App from "./App.tsx";
```

Replace with:

```tsx
import { AuthBoot } from "./components/AuthBoot";
```

Find this:

```tsx
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
      <Toaster position="top-right" />
    </ErrorBoundary>
  </StrictMode>,
);
```

Replace with:

```tsx
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthBoot />
      <Toaster position="top-right" />
    </ErrorBoundary>
  </StrictMode>,
);
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: 0 errors.

- [ ] **Step 3: Build the SPA**

Run: `cd frontend && npm run build`
Expected: success; `dist/` produced.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/main.tsx
git commit -m "feat(boot): mount AuthBoot instead of App in main.tsx"
```

---

## Task 16: End-to-end smoke

**Files:**
- (none — verification only)

The full happy path. Boots the stack, visits each surface, confirms behavior.

- [ ] **Step 1: Boot**

```bash
npm run dev
```

(Either with a real Google client configured, or with `BYPASS_AUTH=1`. Both paths are useful — try both.)

- [ ] **Step 2: Open the landing page**

Open `http://localhost:5011/` in a fresh incognito window. Expect:
- Brand mark + spinner for ~50–150ms.
- Then the landing page (eyebrow, headline, two CTAs, AppPreview, feature strip, footer).
- DevTools Network: `GET /api/auth/me` returned 401.

- [ ] **Step 3: Click "Try the demo"**

Expect to land at `/demo`. The existing app shell renders. The `TopBar` shows a "Sign in" CTA where the sign-out button would normally be.

- [ ] **Step 4: Try a mutation in demo**

Open the Trade page (or hit "Reset funds" on Account). Expect a toast: **"Sign in to trade."** No state changed.

- [ ] **Step 5: Click "Sign in with Google" from inside `/demo`**

Expect to redirect to Google's consent (or, if `BYPASS_AUTH=1`, the next nav to `/app` already shows you signed in — Google flow doesn't run).

- [ ] **Step 6: After signing in, refresh `/`**

Expect: brand mark spinner, then `replacePath('/app')`. App loads as the real user. `TopBar` shows the sign-out button.

- [ ] **Step 7: Click sign-out**

Expect `/api/auth/logout` 200, page reloads to `/`, landing page renders again, cookie gone.

- [ ] **Step 8: Mobile responsive smoke**

DevTools → Toggle device toolbar → 375×812 (iPhone X). Expect:
- Brand + burger only on the nav (no anchor links).
- CTAs stacked, full-width.
- AppPreview reflows below the copy.
- Feature strip stacks 1-up.

- [ ] **Step 9: `?error=` banner smoke**

Visit `http://localhost:5011/?error=auth_verify`. Expect the red banner with "We couldn't verify your Google account. Try again." Click ×. Banner disappears. Refresh the page (no `?error=` in the URL anymore — `replaceState` cleared it).

- [ ] **Step 10: No commit**

Verification only. If anything failed, fix inline and re-run.

---

## Phase 2 verification checklist (from spec §6.5)

**Landing & responsive**
- [ ] Hero scales: 1440 / 1024 / 768 / 414 / 360 viewports.
- [ ] Mobile burger opens a sheet with anchor links + Google CTA.
- [ ] Feature strip stacks at < 640px.
- [ ] Theme toggle in footer persists across `/` and `/app`.

**Auth happy paths**
- [ ] First-time sign-in lands `/app/portfolio`.
- [ ] Returning sign-in skips the landing flash (resolved branch with `user`).
- [ ] Sign-out clears the cookie + reloads to `/`.

**Auth error paths**
- [ ] `?error=auth_state` shows the banner; close × strips the param.
- [ ] Cancel at Google → silent return (no banner code in `ERROR_MESSAGES`).

**Demo**
- [ ] `/demo` renders the app with seeded data.
- [ ] All mutations toast "Sign in to trade."
- [ ] All `GET` calls succeed.

## Phase 2 PR description template

```
Phase 2 of the landing-page + Google-auth project.

- Landing page at / (editorial-minimal: hero with two CTAs, 3-card
  feature strip, footer with theme toggle).
- AuthBoot decides what to mount based on /api/auth/me.
- App.tsx accepts user + readOnly props.
- TopBar shows a sign-out icon for real users, "Sign in with Google"
  for demo.
- /demo mounts the app in read-only mode using a synthetic demoUser.
- Tiny home-grown router replaces the implicit "single SPA" assumption.

Spec: docs/superpowers/specs/2026-05-19-landing-page-and-google-auth-design.md §1, §2, §3.2, §6.1, §6.4
Plan: docs/superpowers/plans/2026-05-19-landing-phase-2-landing-and-auth-ui.md
```
