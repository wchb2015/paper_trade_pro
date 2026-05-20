# Google Auth

End-to-end documentation for the Google OAuth + session flow that gates `/api/portfolio/*` and friends. If a sign-in is misbehaving, this is the doc to read.

**TL;DR:** server-side OAuth 2.0 via Google's standard authorization-code flow. The browser is redirected to Google, Google redirects back with a code, the backend exchanges the code for an ID token, verifies the token's signature against Google's JWKs, upserts a row in `paper_trade_pro.users` keyed by `google_sub`, creates a row in `paper_trade_pro.sessions` with a 30-day expiry, and sets an `HttpOnly` cookie carrying the session id. Subsequent requests look up the cookie, join the user, and attach `req.user`.

---

## Table of contents

1. [Architecture](#1-architecture)
2. [What we use from Google](#2-what-we-use-from-google)
3. [Sequence — full sign-in](#3-sequence--full-sign-in)
4. [Backend routes — input/output](#4-backend-routes--inputoutput)
5. [Data model](#5-data-model)
6. [Cookies & session lifetime](#6-cookies--session-lifetime)
7. [Demo mode (`/api/demo/*`)](#7-demo-mode-apidemo)
8. [`BYPASS_AUTH` (dev only)](#8-bypass_auth-dev-only)
9. [Configuration](#9-configuration)
10. [Setting up a Google OAuth client](#10-setting-up-a-google-oauth-client)
11. [Debugging & logging](#11-debugging--logging)
12. [Common failures and how to read them](#12-common-failures-and-how-to-read-them)

---

## 1. Architecture

```
backend/src/auth/
├── google.ts        — wraps google-auth-library: authorize URL, code↔token, ID-token verify
├── users.ts         — upsertGoogleUser, getUserById  (DB layer, paper_trade_pro.users)
├── sessions.ts      — createSession, getSessionUser, deleteSession  (DB layer, paper_trade_pro.sessions)
├── middleware.ts    — requireAuth, attachDemoUser, readOnlyDemo
└── routes.ts        — /api/auth/{start,callback,me,logout}

backend/scripts/seedDemoUser.ts  — idempotent demo-user row insert (run from `npm run --prefix backend db:init`)
```

The integration into `server.ts` (line 130-ish) mounts three things in this order:

```ts
app.use('/api', createAuthRouter());                     // /api/auth/*  — no gate
app.use('/api/demo', attachDemoUser, readOnlyDemo, …);   // /api/demo/*  — demo user, read-only
app.use('/api', requireAuth, …);                          // /api/*       — gated
```

Order matters: `/api/demo/*` is mounted **before** the gated `/api/*` so that the more-specific prefix wins. Without this, `requireAuth` would intercept `/api/demo/portfolio` and 401 it.

---

## 2. What we use from Google

We use the standard OAuth 2.0 / OpenID Connect "authorization code" flow. No Google Identity Services SDK on the frontend, no `passport`, no third-party libraries beyond Google's own.

| What | Endpoint | Used for |
|---|---|---|
| Authorize URL | `https://accounts.google.com/o/oauth2/v2/auth` | We 302 the browser there with `client_id`, `redirect_uri`, `response_type=code`, `scope=openid email profile`, `state`, `prompt=select_account`, `access_type=online`. |
| Token exchange | `https://oauth2.googleapis.com/token` | Backend POSTs `code` + `client_id` + `client_secret` + `grant_type=authorization_code`; receives `access_token`, `id_token`, `expires_in`. We only use the `id_token`. |
| JWKs | `https://www.googleapis.com/oauth2/v3/certs` | `google-auth-library` fetches and caches Google's signing keys to verify the `id_token` signature. We never call this directly. |

The `google-auth-library` package is the official Google SDK for Node.js. It hides the JWK fetching, signature verification, audience/issuer/expiry checks, and clock-skew tolerance behind one method (`verifyIdToken`).

### What goes in / what comes out

**Authorize URL** (constructed by `buildAuthorizeUrl(state)` in `auth/google.ts`):

```
https://accounts.google.com/o/oauth2/v2/auth?
  response_type=code
  &client_id=<GOOGLE_CLIENT_ID>
  &redirect_uri=<GOOGLE_REDIRECT_URI>
  &scope=openid%20email%20profile
  &access_type=online
  &prompt=select_account
  &include_granted_scopes=true
  &state=<random>
```

**Token-exchange request** (`google-auth-library` calls this internally; we don't see it in our code):

```
POST https://oauth2.googleapis.com/token
Content-Type: application/x-www-form-urlencoded

code=<from query string>
&client_id=<GOOGLE_CLIENT_ID>
&client_secret=<GOOGLE_CLIENT_SECRET>
&redirect_uri=<GOOGLE_REDIRECT_URI>
&grant_type=authorization_code
```

**Token-exchange response** (only `id_token` is used; `access_token` and `refresh_token` are ignored):

```jsonc
{
  "access_token": "ya29.…",      // ignored — we don't call any Google APIs after this
  "expires_in": 3599,             // ignored
  "id_token": "<jwt>",            // <-- this is what we verify
  "scope": "openid email profile",
  "token_type": "Bearer"
}
```

**Verified ID-token payload** (returned by `verifyIdToken`, after signature/audience/issuer/expiry checks):

```jsonc
{
  "iss": "https://accounts.google.com",
  "azp": "<GOOGLE_CLIENT_ID>",
  "aud": "<GOOGLE_CLIENT_ID>",
  "sub": "104238…",                   // Google's stable user id  <-- becomes users.google_sub
  "email": "alice@example.com",       // becomes users.email
  "email_verified": true,
  "name": "Alice Smith",              // becomes users.name
  "picture": "https://…",              // becomes users.picture_url
  "given_name": "Alice",
  "family_name": "Smith",
  "iat": 1779…, "exp": 1779…
}
```

We trust **only** `sub`, `email`, `name`, `picture` (see `auth/google.ts:GoogleProfile`). Everything else is ignored.

---

## 3. Sequence — full sign-in

```
Browser                  Backend                          Google
  │                         │                                │
  │ click "Sign in"         │                                │
  ├────────────────────────►│ GET /api/auth/google/start
  │                         │  • crypto.randomBytes(16) → state
  │                         │  • Set-Cookie: ptp_oauth_state=<state>; HttpOnly; SameSite=Lax; Max-Age=600s
  │                         │  • 302 to Google authorize URL with state in querystring
  │◄────────────────────────┤
  │                         │                                │
  │ user consents at Google                                  │
  ├─────────────────────────────────────────────────────────►│
  │                         │                                │
  │ Google → callback       │                                │
  │◄─────────────────────────────────────────────────────────┤
  │ ?code=…&state=…         │                                │
  ├────────────────────────►│ GET /api/auth/google/callback
  │                         │  1. Compare cookie state == query state. Mismatch → /?error=auth_state.
  │                         │  2. Clear ptp_oauth_state cookie.
  │                         │  3. POST code → Google /token endpoint (via google-auth-library).
  │                         │  4. verifyIdToken(id_token, audience=client_id) — signature + iss + aud + exp.
  │                         │  5. INSERT INTO paper_trade_pro.users … ON CONFLICT (google_sub) DO UPDATE
  │                         │     SET email, name, picture_url, last_login_at = now()
  │                         │     RETURNING id (uuidv7) → AuthUser
  │                         │  6. INSERT INTO paper_trade_pro.sessions (id, user_id, expires_at)
  │                         │     VALUES (crypto.randomBytes(32).toString('base64url'), user.id, now()+30d)
  │                         │  7. Set-Cookie: ptp_sid=<id>; HttpOnly; SameSite=Lax; Max-Age=30d
  │                         │  8. 302 → /app
  │◄────────────────────────┤
  │                         │                                │
  │ subsequent requests     │                                │
  ├────────────────────────►│ GET /api/portfolio  (cookie ptp_sid sent automatically)
  │                         │  • requireAuth: SELECT u.* FROM sessions s JOIN users u ON …
  │                         │    WHERE s.id=$1 AND s.expires_at > now()
  │                         │  • req.user = AuthUser; UPDATE last_seen_at = now() (fire-and-forget)
  │                         │  • portfolio handler reads getUserId(req) = req.user.id
  │◄────────────────────────┤ 200 { … }
```

---

## 4. Backend routes — input/output

All routes mount under `/api/auth/`. Source: `backend/src/auth/routes.ts`.

### `GET /api/auth/google/start`

| | |
|---|---|
| **Purpose** | Begin the OAuth flow. Plants a CSRF state cookie and 302s to Google. |
| **Method** | `GET` (so it can be the target of a top-level `<a href>` / `window.location.href`) |
| **Input** | none |
| **Output** | `302 Location: https://accounts.google.com/…` + `Set-Cookie: ptp_oauth_state=…; HttpOnly; SameSite=Lax; Max-Age=600` |
| **Errors** | If `GOOGLE_CLIENT_ID` is missing, redirects to `/?error=auth_misconfig&ref=<id>`. Logs `ERROR /auth/google/start with no GOOGLE_CLIENT_ID configured`. |
| **Frontend caller** | `<a href="/api/auth/google/start">` rendered by `frontend/src/landing/GoogleButton.tsx`. |

### `GET /api/auth/google/callback`

| | |
|---|---|
| **Purpose** | Consume Google's redirect, verify the token, upsert the user, create the session, set the cookie, redirect to `/app`. |
| **Method** | `GET` (Google always redirects with `GET`) |
| **Input (query string)** | `?code=<from-google>&state=<from-google>` — and optionally `?error=access_denied` if the user cancelled at Google. |
| **Input (cookie)** | `ptp_oauth_state` (httpOnly, set by `/start`) — must equal `state` query param, else CSRF abort. |
| **Output (success)** | `Set-Cookie: ptp_sid=<base64url-256-bit>; HttpOnly; SameSite=Lax; Path=/; Expires=<+30d>` (and `Secure` in prod). `302 Location: /app`. |
| **Output (error)** | `302 Location: /?error=<code>&ref=<request-ref>`. State cookie always cleared. |
| **Error codes** | `auth_state` (state mismatch / missing), `auth_verify` (token verify failed), `auth_db` (Postgres write failed), `auth_cancelled` (user clicked Cancel at Google). |
| **Frontend handler** | `frontend/src/landing/LandingPage.tsx` reads `?error=` on mount and renders the red banner. |

### `GET /api/auth/me`

| | |
|---|---|
| **Purpose** | "Am I signed in?" Polled at app boot by `AuthBoot`. |
| **Method** | `GET` |
| **Input (cookie)** | `ptp_sid` (optional) |
| **Output 200** | `{ "user": { "id":"…", "email":"alice@example.com", "name":"Alice Smith", "pictureUrl":"https://…", "isDemo":false } }` |
| **Output 401** | `{ "error": { "code": "unauthenticated" } }` — *expected* on every cold visit; the frontend treats this as "show landing page", not as an error. **Never** returns 5xx — transient flakes return 401 too. |
| **Frontend caller** | `fetchMe()` in `frontend/src/lib/auth.ts`, called by `AuthBoot` (`frontend/src/components/AuthBoot.tsx`). |
| **`BYPASS_AUTH=1` behaviour** | Returns the demo user as if they were signed in. |

### `POST /api/auth/logout`

| | |
|---|---|
| **Purpose** | Delete the session row, clear the cookie. |
| **Method** | `POST` |
| **Input (cookie)** | `ptp_sid` |
| **Output 200** | `{ "ok": true }` |
| **Output 500** | `{ "error": { "code": "logout_failed" } }` — even on this, the cookie is still cleared (Set-Cookie sent before responding). The user should never be stuck signed in. |
| **Side effects** | `DELETE FROM paper_trade_pro.sessions WHERE id = ptp_sid` |
| **Frontend caller** | `signOut()` in `frontend/src/lib/auth.ts`, triggered by the sign-out button in `TopBar`. After response, the frontend `window.location.assign('/')` to bounce through `AuthBoot` cold. |

### `requireAuth` middleware (mounted on `/api/portfolio/*`, `/api/orders/*`, `/api/alerts/*`, `/api/watchlist/*`, `/api/portfolio/reset`, `/api/portfolio/history`)

| | |
|---|---|
| **Purpose** | Authenticate before letting the route handler see the request. Attaches `req.user`. |
| **Behaviour** | Reads `req.cookies.ptp_sid`, calls `getSessionUser(sid)`, sets `req.user`. On miss → 401 with `{"error":{"code":"unauthenticated"}}`. |
| **`BYPASS_AUTH=1` behaviour** | Skips cookie lookup, attaches the demo user, calls `next()`. |
| **Logs (on internal failure only)** | `ERROR requireAuth failed` with `authOp: "requireAuth"` and the original `err`. |

---

## 5. Data model

Two new tables, both in the existing `paper_trade_pro` schema. Defined in `backend/scripts/init-db.sql` and applied via `npm run --prefix backend db:init`.

### `paper_trade_pro.users`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` PK, `DEFAULT uuidv7()` | This **is** the user id used to scope every existing portfolio table. Time-sortable. |
| `google_sub` | `TEXT NOT NULL UNIQUE` | Google's stable subject id. The natural unique key. The literal `'demo'` value identifies the seeded demo user. |
| `email` | `TEXT NOT NULL` | Latest email from Google. May change on subsequent sign-ins. |
| `email_lower` | `TEXT NOT NULL UNIQUE` | Lowercased copy for case-insensitive uniqueness. Computed in app code (`lower($2)` in the upsert). |
| `name` | `TEXT` | Display name (nullable — Google doesn't always return it). |
| `picture_url` | `TEXT` | Profile picture URL (nullable). |
| `created_at` | `TIMESTAMPTZ DEFAULT now()` | Immutable. |
| `updated_at` | `TIMESTAMPTZ DEFAULT now()` | Auto-bumped by `set_updated_at` trigger. |
| `last_login_at` | `TIMESTAMPTZ DEFAULT now()` | Updated by every successful sign-in. |

The demo-user row is seeded by `backend/scripts/seedDemoUser.ts` (which `db:init` calls automatically). Fixed UUID `3f7c9b2e-8a41-4d6c-b5f3-1e9a72c4d8ab`, `google_sub='demo'`, `email='demo@papertrade.local'`. This is the same UUID the pre-auth app used as `cfg.currentUserId`, so the legacy positions/orders/alerts/watchlist/equity_snapshots rows continue to FK-cleanly.

### `paper_trade_pro.sessions`

| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT` PK | 32 random bytes (`crypto.randomBytes(32)`), base64url-encoded → 43 chars. This **is** the cookie value. |
| `user_id` | `UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE` | Removing a user atomically nukes their sessions. |
| `created_at` | `TIMESTAMPTZ DEFAULT now()` | Immutable. |
| `expires_at` | `TIMESTAMPTZ NOT NULL` | Absolute expiry. Set at create time to `now() + SESSION_LIFETIME_MS`. **Not** rolling — we do not extend on each request. |
| `last_seen_at` | `TIMESTAMPTZ DEFAULT now()` | Bumped on every authenticated request, fire-and-forget. Useful for "who logged in lately" queries. |
| `updated_at` | `TIMESTAMPTZ DEFAULT now()` | Auto-bumped by trigger. |

Indexes:
```sql
CREATE INDEX sessions_user_idx    ON paper_trade_pro.sessions (user_id);
CREATE INDEX sessions_expires_idx ON paper_trade_pro.sessions (expires_at);
```

### Why DB-backed sessions and not JWT in the cookie

- **Revocable.** Sign-out and "log me out everywhere" are one `DELETE`.
- **No signing keys to rotate.** The cookie value is just an opaque random id — guessing it is infeasible (256 bits of entropy).
- **Lookup cost is one indexed query** per request — negligible against the existing portfolio queries.
- The session row also gives us `last_seen_at`, which we can use for analytics later without any code changes.

---

## 6. Cookies & session lifetime

### `ptp_sid` (the session cookie)

```
Name        ptp_sid                                    (override via SESSION_COOKIE_NAME)
Value       <43-char base64url, 256 bits of entropy>
HttpOnly    yes                                         (no JS access)
Secure      production: yes,  development: no           (gated on NODE_ENV === 'production')
SameSite    Lax                                         (allows Google's cross-site → us redirect-back)
Path        /
Max-Age     30 days                                     (override via SESSION_LIFETIME_MS)
```

### `ptp_oauth_state` (the CSRF state cookie)

```
Name        ptp_oauth_state
Value       <22-char base64url, 128 bits of entropy>
HttpOnly    yes
Secure      production: yes, development: no
SameSite    Lax
Path        /
Max-Age     10 minutes                                  (hardcoded — the round-trip should always finish in < 1 minute)
```

Set at `/api/auth/google/start`, cleared at `/api/auth/google/callback`. If the user takes longer than 10 minutes to consent at Google, the cookie expires and the callback redirects with `?error=auth_state`.

### Why `Secure: false` in dev

Browsers refuse to send `Secure` cookies over plain `http://localhost`. The flag is gated on `process.env.NODE_ENV === 'production'`, **not** on `req.secure`, because Vite's proxy doesn't pretend to be HTTPS. In production, nginx terminates TLS and forwards `X-Forwarded-Proto=https`; we set `app.set('trust proxy', 1)` so Express respects it.

### Why `SameSite: Lax` instead of Strict

The OAuth round-trip ends with a `GET` redirect from `accounts.google.com` back to our origin. With `SameSite: Strict`, the browser would not send the cookie on this cross-site navigation. `Lax` allows cookies on top-level cross-site `GET`s, which is exactly what we need.

### Session lifetime — what actually happens

- **Created** at the callback. `expires_at = now() + SESSION_LIFETIME_MS` (30 days).
- **Used** on every request. `getSessionUser` does `WHERE expires_at > now()` — expired sessions look exactly like missing ones.
- **Bumped** on every use — `last_seen_at` only. **Not** `expires_at`. So 30 days is an absolute ceiling regardless of activity.
- **Cleaned up** by sign-out (one `DELETE`). We do **not** run a cron to GC expired sessions yet — they pile up but are harmless (`expires_at > now()` still works). Schema is ready; cron is a v2 concern.

If you want sliding expiration (a session never expires while the user is active), bump `expires_at` in `getSessionUser` alongside `last_seen_at`. We deliberately did not, to keep the policy explicit.

---

## 7. Demo mode (`/api/demo/*`)

Same handlers as `/api/*`, mounted under a separate prefix, gated by two middlewares:

```ts
app.use('/api/demo',
  attachDemoUser,    // sets req.user = the demo user row (cached in module-local var)
  readOnlyDemo,      // 403s any non-GET/HEAD/OPTIONS request
  createPortfolioRouter({ store, snapshotter, getUserId: req => req.user.id })
);
```

Examples:

```
GET  /api/demo/portfolio          → 200, the demo user's portfolio
GET  /api/demo/portfolio/history  → 200, the demo user's equity history
POST /api/demo/orders             → 403 { "error": { "code": "demo_readonly", "message": "Sign in to trade." } }
POST /api/demo/portfolio/reset    → 403 same shape
```

The frontend's `api()` helper (from `@chongbei/web-basics/client`, wired in `main.tsx`) routes `403 demo_readonly` into a toast: "Sign in to trade." UI elements that look interactive (the Trade button, "Place order", "Reset funds") are intentionally **not** disabled in demo mode — clicking them surfaces the toast. The point of demo is to feel the app, including what it's like to click those buttons. (Spec §6.3.)

The frontend mounts the same `App` component for `/demo` with `readOnly={true}`, which adds a "Sign in" pill to `TopBar` instead of the sign-out icon.

---

## 8. `BYPASS_AUTH` (dev only)

Set `BYPASS_AUTH=1` in `.env` and the backend short-circuits both `requireAuth` and `/api/auth/me` to return the demo user, skipping cookie lookups entirely. Useful for:

- Contributors who haven't set up their own Google OAuth client yet.
- Running smoke tests without doing the OAuth round-trip.

**Refused at startup** under `NODE_ENV=production` — the backend throws a `FATAL` and exits non-zero (see `backend/src/config.ts:175`). PM2 will see the failed exit; no risk of accidentally shipping it.

When active, the backend prints a `WARN` at boot:

```
WARN BYPASS_AUTH=1 active — every request resolves to the demo user.
     Refused under NODE_ENV=production; harmless in dev.
```

In `BYPASS_AUTH` mode every request — including ones that would normally come from a signed-in user — resolves to the demo user. State changes you make do persist (it's the demo user's real DB rows).

---

## 9. Configuration

All env vars are documented in `.env.example`. Quick reference:

| Var | Required? | Default | Purpose |
|---|---|---|---|
| `GOOGLE_CLIENT_ID` | required for real auth | — | OAuth client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | required for real auth | — | OAuth client secret. **Never** prefix with `VITE_`. |
| `GOOGLE_REDIRECT_URI` | required for real auth | — | Must be one of the "Authorized redirect URIs" registered on the Google client. Local: `http://localhost:5011/api/auth/google/callback`. Prod: `https://<domain>/api/auth/google/callback`. |
| `SESSION_COOKIE_NAME` | optional | `ptp_sid` | Cookie name for the session id. |
| `SESSION_LIFETIME_MS` | optional | `2592000000` (30 days) | Session expiry. |
| `BYPASS_AUTH` | optional | `0` | `1` enables dev bypass; refused under `NODE_ENV=production`. |

The redirect URI **must match exactly** what's registered in Google Cloud Console — including the protocol, port, and path. If they don't match, Google returns `redirect_uri_mismatch` at the consent screen.

---

## 10. Setting up a Google OAuth client

One-time per environment.

1. Open <https://console.cloud.google.com/apis/credentials>.
2. Create a project (or pick an existing one).
3. **OAuth consent screen** → External (or Internal if you have Workspace) → fill in app name and support email → save.
4. **Credentials** → Create Credentials → OAuth client ID → **Web application**.
5. Add **Authorized redirect URIs**:
   - `http://localhost:5011/api/auth/google/callback` — local dev (Google explicitly allows `http://` for `localhost` only)
   - `https://<your-domain>/api/auth/google/callback` — production
6. Copy the **Client ID** and **Client Secret** into your local `.env`:

   ```
   GOOGLE_CLIENT_ID=<…>.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-<…>
   GOOGLE_REDIRECT_URI=http://localhost:5011/api/auth/google/callback
   ```

7. `npm run dev` and open `http://localhost:5011/api/auth/google/start` to test.

Both URIs go on the **same** OAuth client. Google does not require a separate client per environment.

---

## 11. Debugging & logging

### Where do auth events go?

Every auth event is logged via pino with the field `authOp` set to one of:

```
start | callback | me | logout | bypass | requireAuth | demo_attach | readonly_block
```

In dev, pino-pretty colourises these. In prod (PM2), they're JSON lines.

### Find one user's recent auth activity

```bash
pm2 logs paper_trade_pro_backend --lines 1000 --nostream | grep authOp
```

Or for a specific user:

```bash
pm2 logs paper_trade_pro_backend --lines 5000 --nostream \
  | grep -E '"authOp":"callback"' \
  | grep '"userId":"019e4322-…"'
```

### Find one specific request

Every request is tagged with a short `ref` id by `attachRef` (mounted in `server.ts`). The error redirects pass it through as `?ref=<id>`, so when a user reports `Error: We couldn't verify your Google account` with `ref: 1d13cf29` in the URL, you can:

```bash
pm2 logs paper_trade_pro_backend --lines 10000 --nostream | grep '1d13cf29'
```

…and see every log line that request emitted, in order. The `err` field contains the original exception with stack.

### Verify the DB state

The local `psql` may not have Neon's root cert. Easiest path is to run a script through the backend's pg pool:

```bash
cd backend
cat > scripts/_check.ts <<'EOF'
import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { Client } from 'pg';
let dir = __dirname;
while (!fs.existsSync(path.join(dir, '.env'))) dir = path.dirname(dir);
dotenv.config({ path: path.join(dir, '.env') });
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const u = await c.query("SELECT id, email, google_sub, last_login_at FROM paper_trade_pro.users ORDER BY last_login_at DESC LIMIT 10");
  console.table(u.rows);
  const s = await c.query("SELECT id, user_id, expires_at, last_seen_at FROM paper_trade_pro.sessions ORDER BY last_seen_at DESC LIMIT 10");
  console.table(s.rows.map((r: any) => ({...r, id: r.id.slice(0,16)+'…'})));
  await c.end();
})();
EOF
npx tsx scripts/_check.ts
rm scripts/_check.ts
```

### Inspect a cookie in the browser

DevTools → Application → Cookies → `localhost:5011` (or your prod domain).

- `ptp_sid` should be `HttpOnly`, `SameSite=Lax`, `Path=/`, with a `Max-Age` of `2592000` (30 days).
- `ptp_oauth_state` only exists between `/start` and `/callback`. After callback (success or failure) it's cleared.

### Manually exercise each route

```bash
# 1. /me with no cookie (cold visit)
curl -i http://localhost:5011/api/auth/me
# → 401 {"error":{"code":"unauthenticated"}}

# 2. /me with BYPASS_AUTH=1 in .env
curl -s http://localhost:5011/api/auth/me | jq
# → demo user JSON

# 3. /demo/portfolio without auth (always works)
curl -s http://localhost:5011/api/demo/portfolio | jq | head

# 4. /demo POST is rejected
curl -s -i -X POST -H 'Content-Type: application/json' -d '{}' \
  http://localhost:5011/api/demo/portfolio/reset
# → 403 {"error":{"code":"demo_readonly","message":"Sign in to trade."}}

# 5. /portfolio with a captured cookie
curl -s --cookie "ptp_sid=<your-sid-from-devtools>" http://localhost:5011/api/portfolio | jq | head
```

### Reproduce a state-mismatch error

Pretty handy for testing the `?error=auth_state` banner:

1. Click "Sign in with Google" → land on Google's consent page.
2. Don't consent yet. Open DevTools → Application → Cookies → delete `ptp_oauth_state`.
3. Now consent. The callback compares `state` (which Google sent) with `stateCookie` (which you just deleted) → mismatch → redirect to `/?error=auth_state&ref=<id>`.

---

## 12. Common failures and how to read them

| Symptom | What to check |
|---|---|
| Browser sits on `/api/auth/google/start` then 404s | `GOOGLE_REDIRECT_URI` doesn't match what's registered on the Google client → Google returns `redirect_uri_mismatch` before redirecting. Look at the Google error page directly. Also check `GOOGLE_CLIENT_ID` — a wrong one makes Google show `Error 401: invalid_client`. |
| Lands on `/?error=auth_misconfig` | `GOOGLE_CLIENT_ID` is unset (or only `GOOGLE_CLIENT_SECRET` is). `pm2 logs` shows `ERROR /auth/google/start with no GOOGLE_CLIENT_ID configured`. |
| Lands on `/?error=auth_state` | State cookie missing or doesn't match. Either: cookie was blocked (private mode + `Secure: true` over `http://`), the `/start` and `/callback` are on different origins (check that `GOOGLE_REDIRECT_URI` host matches the SPA's origin), or > 10 minutes elapsed between `/start` and `/callback`. |
| Lands on `/?error=auth_verify` | `verifyIdToken` rejected the id_token. `pm2 logs` will have the full `err`. Most common: `aud` mismatch (`GOOGLE_CLIENT_ID` in `.env` differs from the one that issued the token), or clock skew > 5 minutes. |
| Lands on `/?error=auth_db` | Postgres write failed. Check `DATABASE_URL` and that the schema is up-to-date (`npm run --prefix backend db:init`). Look at the `err` in the log line tagged `authOp: "callback"`. |
| Lands on `/?error=auth_cancelled` (no banner) | User clicked "Cancel" at Google. Spec §6.1 says no banner. This is silent on purpose. |
| `/api/auth/me` returns 200 with the demo user when you expected your own | You have `BYPASS_AUTH=1` in `.env`. The boot WARN in pm2 logs confirms it. Unset and restart. |
| `/api/portfolio` is 401 even though you signed in | Cookie not being sent. Check `SameSite=Lax` and the request origin. Common cause: the SPA is on `:5010` (direct backend) instead of `:5011` (proxy) — this can happen if `frontend/src/config.ts:backendUrl` got reverted to `import.meta.env.VITE_BACKEND_URL`. The fix is `backendUrl: ''`; see Phase 0. |
| Sign-out doesn't clear the session row | `DELETE FROM paper_trade_pro.sessions WHERE id = …` ran but you're still seeing the row. You're probably looking at a different session — sign-out is per-session. Check `created_at` to confirm. |
| Backend refuses to start with `FATAL: BYPASS_AUTH=1 refused under NODE_ENV=production` | Working as designed. Either unset `BYPASS_AUTH` from prod env, or unset `NODE_ENV` if you're running prod creds locally for some reason. |

If you're stuck, the structured log line carries everything — the request `ref`, the `authOp`, the original `err.message` and `err.stack`. Grep on the `ref` and you'll see the whole story for that request.
