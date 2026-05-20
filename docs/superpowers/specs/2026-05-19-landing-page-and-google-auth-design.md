# Landing Page + Google Auth + Responsive Audit — Design

**Status:** Draft, pending user review
**Date:** 2026-05-19
**Owner:** wchb

## Summary

Add a public landing page, Google OAuth sign-in, a read-only demo mode, and a
responsive audit of the existing app. The app is paper-trading-only; auth is
Google-only; deployment is bare nginx + pm2 on a single host.

The landing page is **Direction A — Editorial minimal**: same vocabulary as
the in-app UI (Inter + JetBrains Mono, indigo accent, the black brand-mark
square). Single hero with two doors — "Sign in with Google" and "Try the
demo" — and one feature strip. Both the new landing page **and** the
existing web app are responsive on the same breakpoints.

## Context

The app today is pre-auth. `backend/src/config.ts` reads
`CURRENT_USER_ID` from env and falls back to a hardcoded UUID; every
authenticated request maps to that single user. `server.ts:123` documents
this as the swap point: `getUserId: () => cfg.currentUserId`.

The frontend is a Vite SPA at `frontend/src/`. There is no router library;
`App.tsx` plus `PageRouter.tsx` (a switch) handle in-app navigation. Page
state persists via `usePersistedState` keys in `localStorage`.

Deployment will be **nginx + pm2** on a single host: pm2 runs the Node
backend (already configured in `ecosystem.config.cjs` on port 5010), nginx
serves the SPA static bundle and reverse-proxies `/api/` and `/socket.io/`
to the backend.

## Goals

1. Public landing page at `/` that converts both serious traders and
   curious learners (single hero, two doors).
2. Google OAuth sign-in that creates a real user record and replaces the
   hardcoded `cfg.currentUserId`.
3. Read-only demo mode at `/demo` so visitors can experience the app
   without signing in.
4. Both the landing page and the existing app responsive across desktop /
   tablet / phone.
5. Deployment doc + nginx config example so the eventual prod cutover is
   mechanical.
6. Local dev keeps working with **just `npm run dev`** — no nginx, no
   TLS, no Docker. Google sign-in must work end-to-end against
   `http://localhost:5011`.

## Non-goals

- No password / magic-link / Apple / Microsoft auth — Google only.
- No `react-router-dom`. A 30-line `useLocation` + `popstate` hook covers
  the three new URLs we need.
- No CI/CD changes, no Docker, no multi-host.
- No test framework introduction. Verification is a manual checklist; see
  §6.5.
- No mobile gestures (swipe drawer, pull to refresh).
- No analytics, no PWA, no per-visitor sandbox accounts.
- No redesign of existing pages' mobile layout from scratch — Section 3
  is an audit + targeted fixes, not a rewrite.

## 1. Architecture

Three URL surfaces (plus `/login` as an alias for `/`), one app, no router
library.

```
URL          | Surface              | Auth required | Component mounted
-------------|----------------------|---------------|-------------------
/            | Landing page         | No            | LandingPage
/demo        | App in demo mode     | No            | App (demoUser, ro)
/app/*       | App (real account)   | Yes (cookie)  | App (sessionUser)
/login       | Alias of /           | No            | LandingPage
```

**Boot sequence (`main.tsx`):**

1. Render the brand mark + spinner (no landing flash for returning users).
2. `GET /api/auth/me`.
3. On 200 (authenticated user) → mount `<App user={...} />`. If pathname
   is `/` or `/login`, `history.replaceState` to `/app`. If pathname is
   `/demo`, *still* mount the demo view (signed-in users can browse the
   demo if they want — the API calls go to `/api/demo/*` and are
   read-only there regardless of who's signed in).
4. On 401 → if pathname is `/demo`, mount `<App user=DEMO readOnly />`;
   otherwise mount `<LandingPage />`.
5. On network failure → treat as 401 (don't block returning users on a
   transient blip; they'll click sign-in and recover).

The router is a `useLocation()` hook plus `pushPath(p)` / `replacePath(p)`
helpers in `frontend/src/lib/router.ts`. `App.tsx` doesn't change shape —
it accepts a `user` prop instead of trusting a global UUID.

**Server-side swap point:** `server.ts:123` becomes
`getUserId: (req) => req.user.id` via the new `requireAuth` middleware
(§4.4). The demo path uses `attachDemoUser` to inject
`req.user = { id: DEMO_USER_ID, isDemo: true }`.

## 2. Landing page components

```
frontend/src/landing/
├── LandingPage.tsx         page shell, sections, footer, ?error= banner
├── LandingNav.tsx          brand, anchor links (≥640px), burger (<640px)
├── LandingHero.tsx         eyebrow, headline, lede, CTAs, AppPreview
├── LandingFeatures.tsx     3-card strip
├── LandingFooter.tsx       © · paper-only · GitHub · theme toggle
├── GoogleButton.tsx        reusable pill: <span class="g"/> Sign in with Google
└── AppPreview.tsx          stripped-down Portfolio dashboard with fake data
```

(7 files, not 8 — Phase 2 also adds `landing.css` as a sibling, accounted
for separately.)

`AppPreview.tsx` is intentionally **a component, not a screenshot**. It
re-uses the same CSS variables (`--bg-elev`, `--up`, `--accent`) so it
adapts to dark/light + `Tweaks` automatically and never staleness-rots
when we restyle the app.

**Hero CTAs — exact behavior:**

- Primary: `Sign in with Google` →
  `window.location.href = '/api/auth/google/start'` (full redirect; the
  OAuth handshake can't be `fetch`-driven).
- Secondary: `Try the demo` →
  `window.location.href = '/demo'`.

**Headline copy** (placeholder, finalize during implementation):

> Trade real markets, with *simulated cash.*
>
> Live quotes from Alpaca. $100k starting balance. Lots, alerts, and a
> paper portfolio that behaves like the real thing.

**Feature cards** (1-line headline + 1-sentence body):

1. **Live data, not lookalike** — Real Alpaca quotes, real bid/ask, real
   market clock — paper books, real prices.
2. **Lot-level P/L** — Pick which tax lots to sell. Watch unrealized vs
   realized as you trade.
3. **Alerts & limit orders** — Set price alerts, place limit orders.
   Practice patience, not just clicks.

**Footer:** © 2026 Paper Trade Pro · Paper-only · GitHub link · theme
toggle. The theme toggle reuses `usePersistedState<'light'|'dark'>(...)`
with the same key as the app, so a returning user lands in their preferred
theme on `/` and on `/app`.

`landing.css` is a sibling of `index.css`, imported once from
`LandingPage.tsx`. It scopes hero / nav / feature classes; it does **not**
duplicate the design tokens — they live in `index.css :root` and are
inherited.

## 3. Responsive strategy

### 3.1 Breakpoints (shared)

| Name | Width | Behavior |
|---|---|---|
| `--bp-md` | 900px | Sidebar collapses to icons (was 1100px — too aggressive). |
| `--bp-sm` | 640px | Full mobile reflow; sidebar hides entirely; burger drawer takes over. |
| `--bp-xs` | 480px | Edge-case stacks (4-up stat grid → 1-up; date-pair stack on OrdersPage). |

These are documented as comments in `index.css`; CSS doesn't read them.
`landing.css` uses the same numbers.

### 3.2 Landing page rules

| Width | Hero | Nav | Feature strip |
|---|---|---|---|
| ≥ 900px | Two-col: copy left, AppPreview right (4:3). | Brand · anchor links · Sign-in pill | 3-up grid |
| 640–899px | Single col: copy on top, AppPreview full-width below. CTAs side-by-side. | Brand · inline links · Sign-in text link | 3-up grid (cards narrower) |
| < 640px | Single col, CTAs stack vertically full-width. | Brand · burger → sheet w/ links + Google CTA | Stacked 1-up |

The two CTAs are above the fold on a 667-tall iPhone (verified mentally;
re-verify in browser during implementation).

### 3.3 Existing-app responsive audit

| Where | Today | Fix |
|---|---|---|
| `Sidebar` < 640px | 64px icon column still visible. | Hide entirely. Burger button in `TopBar` opens it as a left-slide drawer (overlay + dimmed backdrop). |
| `TopBar` portfolio summary < 1100px | Hidden. Equity / day P/L disappear. | At 640–1099px show a compact 2-cell summary (Equity · Day P/L%). At < 640px show one chip with equity only. |
| `TopBar` market-status pills < 640px | Cluster wraps and overflows. | Hide verbose status, keep one dot indicator (green / red / grey) with `title` tooltip. |
| `.detail-layout` | Already collapses at 1100/900px. | No change. |
| `.stat-grid` | 4 → 2 → 2. | Below 480px: 1 column. |
| `Modal` widths | `max-width: 480px`, `padding: 20px`. | No change (320px modal in 360px viewport is fine). |
| `TradeForm` | `@media (max-width: 540px)` already reflows. | Verify only. |
| `OrdersPage` filter shelf | Reflows at 900px but date inputs overflow at 360px. | At < 480px stack the date pair vertically. |
| Tables (Portfolio / Orders / Watchlist) | Force horizontal scroll. | Wrap in `overflow-x: auto` + faint right-edge gradient as scroll hint. (Do NOT reflow tables into cards — out of scope.) |

### 3.4 Touch targets

At `< 640px`, all interactive elements **≥ 40×40 px**: `.btn.sm`,
`.nav-item`, icon buttons, `.qf-chip`. The current `.btn.sm` is ~26px tall —
fine on desktop, too small on phone.

## 4. Auth: Google OAuth + session cookie

### 4.1 Data model

New tables in `paper_trade_pro` schema:

```sql
CREATE TABLE paper_trade_pro.users (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub      text        NOT NULL UNIQUE,
  email           text        NOT NULL,
  email_lower     text        NOT NULL UNIQUE,
  name            text,
  picture_url     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE paper_trade_pro.sessions (
  id              text        PRIMARY KEY,        -- 256-bit, base64url
  user_id         uuid        NOT NULL REFERENCES paper_trade_pro.users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON paper_trade_pro.sessions(user_id);
CREATE INDEX ON paper_trade_pro.sessions(expires_at);
```

DB-backed sessions, not JWT. Reasoning: revocable, no signing keys to
ship, lookup cost is one indexed query (negligible against the existing
portfolio queries).

The current hardcoded `cfg.currentUserId` (`3f7c9b2e-8a41-4d6c-b5f3-1e9a72c4d8ab`)
becomes the **demo user**. Seeded by `backend/scripts/seedDemoUser.ts`
(idempotent insert with `google_sub = 'demo'`,
`email = 'demo@papertrade.local'`) so foreign-key invariants in existing
tables hold.

### 4.2 OAuth flow (server-side, redirect-based)

```
Browser                  Backend                       Google
  │                         │                             │
  │ click "Sign in"         │                             │
  ├────────────────────────►│ GET /api/auth/google/start
  │                         │  · gen state, set state cookie (httpOnly, 10m)
  │                         │  · 302 to Google authorize URL
  │◄────────────────────────┤
  │                         │                             │
  │ user consents at Google                               │
  ├──────────────────────────────────────────────────────►│
  │                         │                             │
  │ Google → callback       │                             │
  │◄──────────────────────────────────────────────────────┤
  ├────────────────────────►│ GET /api/auth/google/callback?code&state
  │                         │  · verify state cookie matches
  │                         │  · POST code → Google token endpoint
  │                         │  · verify ID token (aud, iss, exp, sig)
  │                         │  · upsert users by google_sub
  │                         │  · INSERT session row
  │                         │  · Set-Cookie: ptp_sid=...; HttpOnly; Secure;
  │                         │                SameSite=Lax; Max-Age=30d
  │                         │  · 302 to /app
  │◄────────────────────────┤
```

**Library:** `google-auth-library` (official Google package). One new
backend dep. No `passport`.

**Why redirect-based, not GIS one-tap:** simpler to reason about, no
Google JS SDK in the frontend, the cookie is set by the same origin that
serves the page, no CORS dance. Trade-off: returning users get a 1–2s
round-trip instead of one-tap. GIS can be added on top later as a
progressive enhancement without throwing this away.

### 4.3 New env vars

```
# Required
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:5011/api/auth/google/callback

# Optional with defaults
SESSION_COOKIE_NAME=ptp_sid
SESSION_LIFETIME_MS=2592000000   # 30 days

# Dev-only escape hatch (refused in production)
# BYPASS_AUTH=1                   # see §5.0 step 8
```

The default `GOOGLE_REDIRECT_URI` points at **`:5011`** (the Vite dev
server), not `:5010` (the backend), because in local dev the browser
hits the SPA origin and Vite proxies `/api` to the backend. Same-origin
end-to-end.

Documented in `.env.example` with the same Reference treatment as the
existing block. In production behind nginx, `GOOGLE_REDIRECT_URI` becomes
`https://papertrade.pro/api/auth/google/callback` — same origin as the
SPA, so the session cookie is first-party. Both URLs must be registered
as authorized redirect URIs on the Google Cloud Console OAuth client (see
§5.0 step 4).

### 4.4 New backend routes

```
GET   /api/auth/google/start    302 to Google (redirect target)
GET   /api/auth/google/callback consume code, set cookie, 302 to /app
GET   /api/auth/me              { user } | 401
POST  /api/auth/logout          delete session row, clear cookie, 200
```

`start` is `GET` (not `POST`) because it's the target of a top-level
`window.location.href = ...` from the Google button, not an XHR. The
state cookie protects against CSRF on the callback.

`requireAuth` middleware reads `req.cookies.ptp_sid`, looks up the
session, joins `users`, attaches `req.user`. On miss → 401. Mounted on
`/api/portfolio/*` and any other authenticated route. The existing
`getUserId` callback in `server.ts:123` becomes
`(req) => req.user.id`.

### 4.5 Demo flow

`/api/demo/*` middleware order:

```
/api/demo/*  →  attachDemoUser  →  readOnlyDemo  →  ...handler
```

`attachDemoUser` injects
`req.user = { id: DEMO_USER_ID, isDemo: true }` and forwards to the same
handlers. The handlers don't know it's demo. `readOnlyDemo` rejects any
non-`GET` with **403**:

```json
{ "error": { "code": "demo_readonly", "message": "Sign in to trade." } }
```

The existing `api<T>()` helper (wired with `configureApi` in
`main.tsx`) routes 403 codes into a toast: "Sign in to trade with real
(paper) cash."

The Trade button, "Place order," "Add alert," "Reset funds" are **not**
disabled visually in demo mode. They look the same; clicking surfaces the
toast. Reasoning: the point of demo is to *feel* the app. A disabled UI
hides the affordance. (One exception: a "Sign in with Google" pill is
added to the `TopBar` in demo mode as a permanent prompt.)

The demo-vs-real distinction lives at the **URL prefix level** — not
inside `req.user` — because then read-only enforcement is a single line in
the middleware (`if (method !== 'GET') return 403`) instead of every
mutating handler having to remember to check.

### 4.6 Cookie attributes

```
Name:      ptp_sid
HttpOnly:  yes
Secure:    yes in prod, no in dev (HTTPS not available on localhost)
SameSite:  Lax (both prod and dev — Vite proxy keeps everything same-site)
Path:      /
Max-Age:   30 days
```

`Secure` is gated on `process.env.NODE_ENV === 'production'`, not on
`req.secure`, so dev (plain HTTP `localhost`) gets a cookie that the
browser will actually accept. In prod, `app.set('trust proxy', 1)` lets
Express honour `X-Forwarded-Proto` from nginx; the `Secure` flag is set
unconditionally there.

Sliding expiration: every authenticated request bumps
`sessions.last_seen_at`; a daily cron deletes
`sessions.expires_at < now()`. Cron is not in v1; the schema is ready
for it.

## 5. Deployment & local development

### 5.0 Local dev (no nginx, no TLS)

The local dev story has to be exactly **`npm run dev` and go**, even though
production needs nginx for same-origin cookies and SPA fallback. We solve
this by mirroring nginx's role with Vite's dev proxy: the browser talks
*only* to `http://localhost:5011` (the Vite dev server), which forwards
`/api/*` and `/socket.io/*` to the backend on `:5010`. Net effect:
same-origin in dev, same-origin in prod, no client code branches.

**1. Frontend talks same-origin in dev**

Drop the cross-origin URL injection. `frontend/src/config.ts` becomes:

```ts
// In dev, omit the host: relative URLs ride on the Vite proxy.
// In prod, omit the host: nginx serves the SPA and proxies /api itself.
export const config = {
  backendUrl: '',           // was: import.meta.env.VITE_BACKEND_URL
  ...
};
```

`marketClient.ts`, `portfolioClient.ts`, `priceClient.ts` then call
`/api/portfolio/...` instead of `${backendUrl}/api/portfolio/...`. They
already prefix paths with `/api`, so this is a 1-line change in each
client.

**2. Vite dev-server proxy** — append to `frontend/vite.config.ts`:

```ts
server: {
  port: ports.FRONTEND_DEV_PORT,
  strictPort: true,
  proxy: {
    '/api':       { target: ports.BACKEND_URL, changeOrigin: true },
    '/socket.io': { target: ports.BACKEND_URL, ws: true, changeOrigin: true },
  },
},
```

**3. Cookie attributes in dev**

`Secure` cookies require HTTPS, which we don't have on `localhost`.
The cookie code reads `app.get('env') === 'production'` and falls back to
**`Secure: false; SameSite: Lax`** in dev. `SameSite=Lax` is fine because
both Google's redirect-back and our XHRs are same-site once the proxy
fronts everything.

**4. Google Cloud Console — local credentials**

Add **two** authorized redirect URIs to the OAuth client in Google Cloud
Console:

```
http://localhost:5011/api/auth/google/callback     # dev (via Vite proxy)
https://papertrade.pro/api/auth/google/callback    # prod
```

Google's docs allow `http://` for `localhost` only (it's the documented
exception to the HTTPS-only rule). The callback URL the backend hands to
Google is read from `GOOGLE_REDIRECT_URI` — set it to the `:5011` host in
local `.env`, the prod host in prod `.env`. Same code, different env.

**5. One-command start**

Add to root `package.json`:

```json
{
  "scripts": {
    "dev": "concurrently -k -n be,fe -c blue,green \"npm --prefix backend run dev\" \"npm --prefix frontend run dev\""
  },
  "devDependencies": { "concurrently": "^9" }
}
```

Then:

```bash
npm install                                  # one time
npm run dev                                  # spawns backend + frontend
open http://localhost:5011                   # everything works here
```

**6. Local Google sign-in flow (sanity check)**

```
http://localhost:5011/                       (Vite SPA)
  click "Sign in with Google"
http://localhost:5011/api/auth/google/start  (Vite proxies → :5010)
  302 → accounts.google.com/o/oauth2/v2/auth?...
        redirect_uri=http://localhost:5011/api/auth/google/callback
  user consents
http://localhost:5011/api/auth/google/callback?code&state
  (Vite proxies → :5010, backend verifies, sets cookie on :5011)
  302 → http://localhost:5011/app
```

The cookie's domain is `localhost`, the user's browser is on
`http://localhost:5011`, the API is reached via `http://localhost:5011/api`.
Same origin everywhere — no third-party-cookie problems, no CORS dance.

**7. Local-dev README**

`deploy/README.md` ships the prod story. Local-dev steps go in **a new
top-level `docs/Local_Dev.md`** (sibling to `Backend_API.md` / `ENV.md`),
covering: clone, `.env`, Postgres URL (Neon dev branch), Google OAuth
client creation with the two redirect URIs above, and the
`npm run dev` cycle. The `.env.example` block for `GOOGLE_*` references
this doc.

**8. Verifying without Google (offline / first-run)**

A `BYPASS_AUTH=1` env var (dev-only, refused if `NODE_ENV=production`)
short-circuits `requireAuth` to attach `req.user = { id: cfg.currentUserId,
email: 'dev@local', isDemo: false }`. Lets a contributor poke at the app
before they've set up their own Google OAuth client. Logs a `WARN` at
boot so it's never silently on.

### 5.1 Process layout (production)

```
nginx (80/443, public)
  ├─ static  /            → /var/www/papertrade/frontend/dist (SPA)
  ├─ proxy   /api/        → http://127.0.0.1:5010
  ├─ proxy   /socket.io/  → http://127.0.0.1:5010 (Upgrade headers)
  └─ TLS     Let's Encrypt via certbot

pm2 (non-root service user)
  └─ 5010_paper_trade_pro_backend  (existing ecosystem.config.cjs)
```

The frontend is served by **nginx**, not by Express. The backend stays a
pure API. Same-origin between SPA and `/api` means session cookies are
first-party and CORS is a no-op in prod.

### 5.2 nginx config (sketch — checked in at `deploy/nginx.conf.example`)

```nginx
server {
  listen 443 ssl http2;
  server_name papertrade.pro;
  # certbot manages ssl_certificate / ssl_certificate_key

  location /api/ {
    proxy_pass         http://127.0.0.1:5010;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   X-Real-IP         $remote_addr;
  }

  location /socket.io/ {
    proxy_pass         http://127.0.0.1:5010;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade           $http_upgrade;
    proxy_set_header   Connection        "upgrade";
    proxy_set_header   Host              $host;
    proxy_read_timeout 3600s;
    proxy_buffering    off;
  }

  root /var/www/papertrade/frontend/dist;
  index index.html;

  location / {
    try_files $uri $uri/ /index.html;
  }

  location ~* \.(js|css|woff2?|svg|png|webp)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }
  location = /index.html {
    expires -1;
    add_header Cache-Control "no-store";
  }
}

server {
  listen 80;
  server_name papertrade.pro;
  return 301 https://$host$request_uri;
}
```

`try_files $uri $uri/ /index.html;` is required for SPA fallback so a
hard refresh of `/demo` or `/app/orders` doesn't 404.

### 5.3 Express knobs that change for prod

Two new lines in `server.ts`:

```ts
app.set('trust proxy', 1);    // honour X-Forwarded-Proto from nginx
app.use(cookieParser());      // for ptp_sid + oauth state cookie
```

`cookieParser` is a new dep. Tiny.

### 5.4 New deploy artifacts

```
deploy/
├── nginx.conf.example      the snippet above
├── README.md               clean-host bring-up
└── certbot.md              one-time TLS bootstrap notes
```

`ecosystem.config.cjs` is **untouched** — pm2 doesn't need to know about
nginx. `package.json:scripts.deploy` is **untouched** — it builds and
starts pm2; the host-side rsync of `frontend/dist` is documented in
`deploy/README.md`, not automated.

## 6. Errors, edge cases, observability

### 6.1 `?error=` codes on landing

| Code | Triggered by | Banner |
|---|---|---|
| `auth_state` | OAuth state cookie missing or mismatched | "Sign-in link expired — please try again." |
| `auth_verify` | Google ID token failed verification | "We couldn't verify your Google account. Try again." |
| `auth_db` | Postgres upsert/insert failed | "Sign-in is temporarily unavailable. Try again in a minute." |
| `auth_cancelled` | User cancelled at Google | (no banner — silent return to `/`) |

Banner has a close × that strips the param via `history.replaceState`.
Server-side, every error path logs at `ERROR` severity with the original
exception, the operation name, and the request `ref` id (`attachRef`
already in `server.ts`). The redirect URL carries `&ref=<id>` so support
can find the log.

### 6.2 Session edge cases

| Case | Behavior |
|---|---|
| Session expired | `requireAuth` 401s. `api()` helper hard-redirects to `/login`. WebSocket reconnects on next handshake. |
| Logout in another tab | Tab A keeps stale state. Acceptable v1. (Real fix: `BroadcastChannel`.) |
| `/api/auth/me` flake on boot | Treat as 401, render `LandingPage`. User clicks Sign in, recovers. **Not** a fatal screen. |
| User revokes Google access | `users` row stays. Cookie still works until expiry. Next sign-in fails at Google → `auth_state` / `auth_cancelled`. |
| Two concurrent sign-ins | Two `sessions` rows; both work. Logout is per-session. `UNIQUE` is on `users.google_sub`, not on `sessions.user_id`. |

### 6.3 Demo guardrails

- All non-GET requests under `/api/demo/*` return 403.
- Mutating UI is **not** visually disabled — clicking shows a toast.
- A "Sign in with Google" pill is added to the `TopBar` in demo mode.

### 6.4 Boot sequence (avoiding landing flash for returning users)

```
main.tsx
  configureApi (existing)
  AuthBoot (new):
    GET /api/auth/me → loading | { user } | null
    while loading: render brand mark + spinner (no landing)
  on resolved:
    null → <LandingPage /> at "/", or <App demoUser /> at "/demo"
    user → <App user />, replace pathname to /app if on / or /login
```

### 6.5 Verification checklist (manual; lives in the implementation PR)

**Auth happy paths**
- [ ] First-time sign-in creates `users` row, sets cookie, lands `/app/portfolio`.
- [ ] Returning sign-in finds `users` row by `google_sub`, bumps `last_login_at`.
- [ ] `/api/auth/me` returns the right user.
- [ ] Logout clears cookie, deletes session row, returns to `/`.

**Auth error paths**
- [ ] Tampered state cookie → `?error=auth_state` banner.
- [ ] Cancel at Google → silent return to `/`.
- [ ] Backend down during callback → `?error=auth_db`, log includes `ref`.

**Demo**
- [ ] `/demo` renders the app with seeded data.
- [ ] Place order → 403 + "Sign in to trade" toast.
- [ ] Reset funds → 403 + toast.
- [ ] Watchlist add → 403 + toast.
- [ ] All `GET` calls succeed (read-only browsing).

**Landing & responsive**
- [ ] Hero scales: 1440 / 1024 / 768 / 414 / 360 viewports.
- [ ] Mobile burger opens a sheet with anchor links + Google CTA.
- [ ] Feature strip stacks at < 640px.
- [ ] Theme toggle in footer persists across `/` and `/app`.

**Existing-app responsive audit (§3.3)**
- [ ] Sidebar hides at < 640px, burger opens drawer.
- [ ] TopBar shows compact equity 640–1099px, single chip < 640px.
- [ ] OrdersPage date inputs stack at < 480px.
- [ ] Tables horizontal-scroll cleanly with right-edge gradient hint.

**Local dev (no nginx)**
- [ ] Fresh clone + `.env` from `.env.example` + `npm install` + `npm run dev` lands a working app at `http://localhost:5011`.
- [ ] `/api/auth/me` (proxied) returns 401 before sign-in, 200 after.
- [ ] Google sign-in completes end-to-end on localhost (using the `:5011` redirect URI registered in Google Cloud Console).
- [ ] `/socket.io` ticks reach the browser through the Vite proxy.
- [ ] `BYPASS_AUTH=1` boots into the app without Google credentials and prints a `WARN` at startup.
- [ ] `BYPASS_AUTH=1` with `NODE_ENV=production` refuses to start.

**Deploy**
- [ ] `try_files` makes `/demo`, `/app/orders` survive a hard refresh.
- [ ] Socket.io reconnects after a 60s idle through nginx.
- [ ] Cookies are `Secure` in prod, not in dev.

### 6.6 Logging discipline

Per `CLAUDE.md`: every catch logs with the original error and an
operation name. Two new log fields:

- `userId` — populated by `requireAuth` so portfolio query logs gain user
  context.
- `authOp` — one of `start | callback | me | logout | demo_attach |
  readonly_block`.

## 7. Implementation phases & file inventory

### 7.1 Phases

Four PRs. Each independently shippable.

**Phase 0 — Same-origin plumbing (no behavior change)**
- Vite dev-server proxy for `/api` + `/socket.io` (§5.0 step 2)
- `frontend/src/config.ts` `backendUrl: ''` (§5.0 step 1)
- 1-line drops in `marketClient.ts`, `portfolioClient.ts`, `priceClient.ts`
- Root `package.json`: `npm run dev` script + `concurrently` devDep
- `docs/Local_Dev.md` v1 (without the Google parts yet — those land in Phase 1)

After Phase 0: a fresh clone + `npm install` + `npm run dev` opens a
working app at `http://localhost:5011`. Cross-origin
`http://localhost:5010` calls are gone. No behavior change for the user;
this is the foundation Phase 1's auth code stands on.

**Phase 1 — Auth backbone (no UI changes)**
- `users` + `sessions` tables, schema migration
- `google-auth-library`, `cookie-parser` deps
- `/api/auth/google/start`, `/callback`, `/me`, `/logout`
- `requireAuth` middleware
- Swap `getUserId: () => cfg.currentUserId` → `(req) => req.user.id`
- Demo middlewares mounted on `/api/demo/*`
- New env vars in `.env.example`
- `cfg.currentUserId` becomes the demo user, seeded as a `users` row

After Phase 1: app behaves identically *if you have a session cookie*.
Without one, every API call 401s — fine, because Phase 2 ships sign-in.

**Phase 2 — Landing page + auth UI**
- `frontend/src/landing/` (7 components, see §2)
- `frontend/src/landing.css`
- `AuthBoot` in `main.tsx`
- 30-line router (`useLocation` + `popstate`)
- `App.tsx` accepts a `user` prop
- Sign-out in `TopBar` for real users, Google CTA in `TopBar` for demo

After Phase 2: end-to-end Google sign-in, demo, landing page.

**Phase 3 — Responsive audit (existing app)**
- All §3.3 items
- 1100→900 breakpoint drop in `index.css`
- Mobile drawer for `Sidebar`
- Compact `TopBar` summary at 640–1099px
- Touch-target bumps at < 640px
- Tables `overflow-x: auto`
- OrdersPage date stack at < 480px

After Phase 3: app verified responsive on the breakpoints in §3.1.

### 7.2 File inventory

**Net-new:**

```
backend/
├── src/auth/
│   ├── google.ts              OAuth client, token exchange, ID-token verify
│   ├── sessions.ts            create / lookup / delete; bumps last_seen_at
│   ├── middleware.ts          requireAuth, attachDemoUser, readOnlyDemo
│   └── routes.ts              /api/auth/* and /api/demo/* mount helper
└── scripts/
    └── seedDemoUser.ts        idempotent demo users row insert

frontend/
└── src/
    ├── landing/
    │   ├── LandingPage.tsx
    │   ├── LandingNav.tsx
    │   ├── LandingHero.tsx
    │   ├── LandingFeatures.tsx
    │   ├── LandingFooter.tsx
    │   ├── GoogleButton.tsx
    │   └── AppPreview.tsx
    ├── landing.css
    ├── lib/auth.ts            fetchMe, signOut, GoogleLoginUrl
    ├── lib/router.ts          useLocation, pushPath, replacePath
    └── components/AuthBoot.tsx

deploy/
├── nginx.conf.example
├── README.md
└── certbot.md

docs/
└── Local_Dev.md               clone → .env → Google client → npm run dev
```

**Modified:**

```
backend/src/server.ts          mount auth routes, swap getUserId, set('trust proxy'), cookieParser, BYPASS_AUTH banner
backend/src/config.ts          load Google + session env vars, BYPASS_AUTH (dev-only)
backend/scripts/init-db.sql    append users + sessions tables (consumed by initDb.ts)
backend/package.json           google-auth-library, cookie-parser
frontend/src/config.ts         backendUrl: '' (was ports.BACKEND_URL); same-origin
frontend/src/lib/marketClient.ts       drop ${backendUrl} prefix
frontend/src/lib/portfolioClient.ts    drop ${backendUrl} prefix
frontend/src/lib/priceClient.ts        socket.io client uses '/' (same origin)
frontend/vite.config.ts        add server.proxy for /api and /socket.io
frontend/src/main.tsx          AuthBoot, LandingPage vs App
frontend/src/App.tsx           accept user prop
frontend/src/components/TopBar.tsx     sign-out button, demo CTA, compact summary
frontend/src/components/Sidebar.tsx    mobile drawer behavior
frontend/src/index.css         1100→900 breakpoint, touch targets, drawer styles, table scroll
package.json                   add `dev` script + concurrently devDep
.env.example                   GOOGLE_*, SESSION_*, BYPASS_AUTH (commented)
```

**Untouched (intentionally):**

- `ports.cjs`
- `ecosystem.config.cjs`
- `package.json:scripts.deploy`
- All existing `pages/*` and trade flow

### 7.3 Estimated size

- Phase 0: ~30 LoC config + ~80 LoC docs (Local_Dev.md).
- Phase 1: ~400 LoC backend, ~80 LoC frontend.
- Phase 2: ~600 LoC frontend, ~30 LoC backend.
- Phase 3: ~250 LoC CSS, ~80 LoC JSX.

Roughly a focused week for one engineer; four reviewable PRs.

## 8. Open questions

None as of this draft. Final go/no-go is the user-review gate before
moving into implementation planning.
