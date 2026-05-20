# Phase 1 — Auth backbone (no UI changes)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the server-side Google OAuth flow, DB-backed sessions, `requireAuth`, the `/api/demo/*` read-only path, and the `BYPASS_AUTH` dev escape hatch — all without touching the UI. The hardcoded `cfg.currentUserId` becomes the demo user; mutating routes start expecting a session cookie.

**Architecture:** New `backend/src/auth/` package with four small files (`google.ts`, `sessions.ts`, `middleware.ts`, `routes.ts`). `users` + `sessions` tables appended to `backend/scripts/init-db.sql`. `server.ts` mounts auth + demo routers and swaps `getUserId`. The demo path reuses the same handlers via a separate URL prefix and a read-only middleware.

**Tech Stack:** `google-auth-library` (new), `cookie-parser` (new). Express 5, pg.

**Spec:** [`docs/superpowers/specs/2026-05-19-landing-page-and-google-auth-design.md`](../specs/2026-05-19-landing-page-and-google-auth-design.md) §1 (architecture), §4 (auth), §5.0 step 8 (BYPASS_AUTH).

**Prerequisite:** Phase 0 must be merged. Verify by running `grep -n "config.backendUrl" frontend/src/lib/*.ts` — expect zero matches.

---

## File Structure

### New
- `backend/src/auth/google.ts` — wraps `google-auth-library`. Exports `buildAuthorizeUrl(state)`, `exchangeCode(code)`, `verifyIdToken(idToken)`, all returning typed shapes the rest of the auth code consumes.
- `backend/src/auth/sessions.ts` — `createSession(userId)`, `getSessionUser(sid)`, `bumpLastSeen(sid)`, `deleteSession(sid)`. Pure DB layer.
- `backend/src/auth/users.ts` — `upsertGoogleUser(profile)` and `getUserById(id)`. Pure DB layer.
- `backend/src/auth/middleware.ts` — `requireAuth`, `attachDemoUser`, `readOnlyDemo`, `bypassAuth`. Express handlers.
- `backend/src/auth/routes.ts` — `createAuthRouter(deps)` and `createDemoMountHelper(deps)`. The latter wraps a real-user router so `/api/demo/<...same handlers>` works.
- `backend/scripts/seedDemoUser.ts` — idempotent insert of the demo user. Runs from `npm run --prefix backend db:init` (we'll wire it in).
- `shared/src/contracts/auth.ts` — wire shape for `GET /api/auth/me`.

### Modified
- `backend/scripts/init-db.sql` — append `users` + `sessions` tables. Idempotent.
- `backend/src/config.ts` — load `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `SESSION_COOKIE_NAME`, `SESSION_LIFETIME_MS`, `BYPASS_AUTH`.
- `backend/src/server.ts` — install `cookieParser`, `attachRef` early, mount `/api/auth`, mount real `/api/portfolio` behind `requireAuth | bypassAuth`, mount `/api/demo/portfolio` behind `attachDemoUser + readOnlyDemo`, swap `getUserId` to read `req.user.id`.
- `backend/package.json` — add `google-auth-library`, `cookie-parser`, `@types/cookie-parser`.
- `backend/scripts/initDb.ts` — also run `seedDemoUser.ts` after schema is up.
- `shared/src/index.ts` — re-export `./contracts/auth.js`.
- `.env.example` — append the auth block (with full Reference treatment).
- (Express type augmentation) `backend/src/auth/middleware.ts` declares `req.user` so handlers can read it.

### Untouched
- All frontend code.
- `backend/src/store/PortfolioStore.ts`, `backend/src/services/*`.
- `backend/src/routes/portfolio.ts`, `routes/quotes.ts`, `routes/market.ts` — they still take `getUserId(req)` exactly as before.

---

## Task 1: Append `users` + `sessions` tables to init-db.sql

**Files:**
- Modify: `backend/scripts/init-db.sql`

Append the two new tables. Idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).

- [ ] **Step 1: Append to the bottom of `backend/scripts/init-db.sql`**

Append exactly:

```sql

-- =============================================================================
-- Auth (added in Phase 1 — landing page + Google sign-in)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- users — one row per signed-in human (or the special demo user).
-- google_sub is Google's stable subject id and is the natural unique key.
-- email_lower is generated client-side (lowercased) for case-insensitive
-- uniqueness without a generated column (PG does have generated cols, but
-- staying portable is cheap here).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paper_trade_pro.users (
  id              UUID         PRIMARY KEY DEFAULT uuidv7(),
  google_sub      TEXT         NOT NULL UNIQUE,
  email           TEXT         NOT NULL,
  email_lower     TEXT         NOT NULL UNIQUE,
  name            TEXT,
  picture_url     TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_login_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER users_set_updated_at
  BEFORE UPDATE ON paper_trade_pro.users
  FOR EACH ROW EXECUTE FUNCTION paper_trade_pro.set_updated_at();

-- -----------------------------------------------------------------------------
-- sessions — server-side session store. id is a 256-bit random base64url
-- string handed to the client as the ptp_sid cookie. ON DELETE CASCADE so
-- removing a user nukes their sessions atomically.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paper_trade_pro.sessions (
  id              TEXT         PRIMARY KEY,
  user_id         UUID         NOT NULL REFERENCES paper_trade_pro.users(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ  NOT NULL,
  last_seen_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER sessions_set_updated_at
  BEFORE UPDATE ON paper_trade_pro.sessions
  FOR EACH ROW EXECUTE FUNCTION paper_trade_pro.set_updated_at();

CREATE INDEX IF NOT EXISTS sessions_user_idx
  ON paper_trade_pro.sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx
  ON paper_trade_pro.sessions (expires_at);
```

- [ ] **Step 2: Apply against your dev DB**

Run:
```bash
npm run --prefix backend db:init
```
Expected: `[initDb] OK — schema is up to date`. (If it fails, fix the SQL inline — do not commit a broken migration.)

- [ ] **Step 3: Spot-check the tables exist**

Run:
```bash
psql "$(grep '^DATABASE_URL=' .env | cut -d'=' -f2-)" -c "\dt paper_trade_pro.*"
```
Expected: the listing includes `users` and `sessions` rows.

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/init-db.sql
git commit -m "db: add paper_trade_pro.users and paper_trade_pro.sessions"
```

---

## Task 2: New backend deps

**Files:**
- Modify: `backend/package.json`, `backend/package-lock.json`

- [ ] **Step 1: Install**

Run:
```bash
npm --prefix backend install --save google-auth-library@^9 cookie-parser@^1
npm --prefix backend install --save-dev @types/cookie-parser@^1
```
Expected: `package.json` and `package-lock.json` updated; no errors.

- [ ] **Step 2: Verify versions made it into `backend/package.json`**

Run: `grep -E '"(google-auth-library|cookie-parser)"' backend/package.json`
Expected: three matches (two deps + one type).

- [ ] **Step 3: Commit**

```bash
git add backend/package.json backend/package-lock.json
git commit -m "chore(backend): add google-auth-library and cookie-parser"
```

---

## Task 3: `shared/src/contracts/auth.ts` — wire types

**Files:**
- Create: `shared/src/contracts/auth.ts`
- Modify: `shared/src/index.ts`

The frontend will need a typed `User` shape for `GET /api/auth/me`. Define it in `shared/` so backend + frontend agree.

- [ ] **Step 1: Create `shared/src/contracts/auth.ts`**

Write:

```ts
// -----------------------------------------------------------------------------
// Auth wire types — shared by the backend (auth routes) and the frontend
// (AuthBoot, lib/auth.ts). All fields are wire-safe primitives.
// -----------------------------------------------------------------------------

export interface AuthUser {
  /** uuidv7 — same uuid that scopes positions/orders/alerts. */
  id: string;
  email: string;
  name: string | null;
  pictureUrl: string | null;
  /** True for the seeded demo user; false for real Google sign-ins. */
  isDemo: boolean;
}

/** Body of GET /api/auth/me on success. */
export interface AuthMeResponse {
  user: AuthUser;
}
```

- [ ] **Step 2: Re-export from `shared/src/index.ts`**

Edit `shared/src/index.ts` to read:

```ts
export * from './contracts/quote.js';
export * from './contracts/events.js';
export * from './contracts/portfolio.js';
export * from './contracts/market.js';
export * from './contracts/auth.js';
export * from './constants.js';
```

- [ ] **Step 3: Typecheck the backend (which depends on `shared/`)**

Run: `cd backend && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add shared/src/contracts/auth.ts shared/src/index.ts
git commit -m "feat(shared): AuthUser and AuthMeResponse contracts"
```

---

## Task 4: Extend `backend/src/config.ts` with auth env vars

**Files:**
- Modify: `backend/src/config.ts`

Load `GOOGLE_*`, `SESSION_*`, and `BYPASS_AUTH`. Refuse `BYPASS_AUTH=1` when `NODE_ENV=production`.

- [ ] **Step 1: Apply this diff**

In `backend/src/config.ts`:

a. Inside `interface AppConfig`, add (after the `replay:` block, before `limits`):

```ts
  /**
   * Google OAuth client. All three are *required* for `/api/auth/google/*`
   * to work; if you don't have them yet, set BYPASS_AUTH=1 in dev to skip
   * the flow entirely.
   */
  googleClientId: string | null;
  googleClientSecret: string | null;
  googleRedirectUri: string | null;
  /**
   * Session cookie & lifetime. These have safe defaults — override only
   * when you know why.
   */
  sessionCookieName: string;
  sessionLifetimeMs: number;
  /**
   * Dev-only escape hatch. When true, requireAuth attaches the demo user
   * instead of looking up a session. Refused under NODE_ENV=production.
   */
  bypassAuth: boolean;
```

b. Inside `loadConfig()`, before the `cached = cfg` line, add the parsing:

```ts
  const isProd = process.env.NODE_ENV === 'production';
  const bypassAuth = (optionalEnv('BYPASS_AUTH') ?? '0') === '1';
  if (bypassAuth && isProd) {
    throw new Error(
      'FATAL: BYPASS_AUTH=1 refused under NODE_ENV=production. ' +
      'Remove it from prod env or unset NODE_ENV.',
    );
  }
```

c. Extend the `cfg` object (inside `loadConfig`) by adding these fields next to `replay:`:

```ts
    googleClientId: optionalEnv('GOOGLE_CLIENT_ID') ?? null,
    googleClientSecret: optionalEnv('GOOGLE_CLIENT_SECRET') ?? null,
    googleRedirectUri: optionalEnv('GOOGLE_REDIRECT_URI') ?? null,
    sessionCookieName: optionalEnv('SESSION_COOKIE_NAME') ?? 'ptp_sid',
    sessionLifetimeMs: Number(
      optionalEnv('SESSION_LIFETIME_MS') ?? 30 * 24 * 60 * 60 * 1000,
    ),
    bypassAuth,
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/config.ts
git commit -m "feat(backend): config loads GOOGLE_*, SESSION_*, BYPASS_AUTH"
```

---

## Task 5: `.env.example` — auth block

**Files:**
- Modify: `.env.example`

Append a documented block with the full Reference treatment, matching the existing style.

- [ ] **Step 1: Append to `.env.example`**

Append:

```
# ============================ AUTH (Phase 1) ==============================
# Google OAuth — required for /api/auth/google/* to work. Set BYPASS_AUTH=1
# instead if you don't have a client yet.
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GOOGLE_REDIRECT_URI=http://localhost:5011/api/auth/google/callback

# Session cookie tunables — safe defaults; override only if you know why.
# SESSION_COOKIE_NAME=ptp_sid
# SESSION_LIFETIME_MS=2592000000

# Dev-only escape hatch. Refused under NODE_ENV=production.
# BYPASS_AUTH=1

# ============================ AUTH REFERENCE ==============================
#
# GOOGLE_CLIENT_ID         OAuth client ID from Google Cloud Console.
#                          Console → APIs & Services → Credentials → Create
#                          OAuth client → Web application.
#                          e.g. GOOGLE_CLIENT_ID=12345-abc.apps.googleusercontent.com
#
# GOOGLE_CLIENT_SECRET     OAuth client secret. Pair with GOOGLE_CLIENT_ID.
#                          NEVER prefix with VITE_ — it would ship to the browser.
#                          e.g. GOOGLE_CLIENT_SECRET=GOCSPX-abcdefghij
#
# GOOGLE_REDIRECT_URI      Where Google sends the auth code. MUST be one of
#                          the "Authorized redirect URIs" registered on the
#                          Google client. Local dev points at the Vite dev
#                          server (:5011), which proxies /api to the backend.
#                          Default: http://localhost:5011/api/auth/google/callback
#                          Prod:    https://papertrade.pro/api/auth/google/callback
#
# SESSION_COOKIE_NAME      Cookie name for the server-side session id.
#                          Default: ptp_sid
#
# SESSION_LIFETIME_MS      Session cookie Max-Age, in milliseconds.
#                          Default: 2592000000 (30 days)
#
# BYPASS_AUTH              Dev-only. When 1, every authenticated request is
#                          fulfilled with the demo user — no Google client
#                          required. Refused when NODE_ENV=production. Logs
#                          a WARN at backend boot when active.
#                          e.g. BYPASS_AUTH=1
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs(env): document GOOGLE_*, SESSION_*, BYPASS_AUTH"
```

---

## Task 6: `backend/src/auth/google.ts`

**Files:**
- Create: `backend/src/auth/google.ts`

A small wrapper around `google-auth-library`. Three pure-ish functions: build the authorize URL, exchange a code for tokens, verify the id_token. Anything else (state cookie, DB writes, redirects) lives in `routes.ts`.

- [ ] **Step 1: Create the file**

Write `backend/src/auth/google.ts`:

```ts
import { OAuth2Client } from 'google-auth-library';
import { getLogger } from '@chongbei/web-basics/server';
import { loadConfig } from '../config';

const log = getLogger('auth.google');

// -----------------------------------------------------------------------------
// google-auth-library wrapper. The route layer (routes.ts) handles HTTP — this
// module only knows how to talk to Google.
//
// Throws (logged) when called without GOOGLE_CLIENT_ID / SECRET / REDIRECT_URI.
// Routes that depend on this module check `cfg.googleClientId` upfront and
// return a clear 5xx (or redirect to ?error=auth_misconfig) before calling in.
// -----------------------------------------------------------------------------

const SCOPES = ['openid', 'email', 'profile'];

function makeClient(): OAuth2Client {
  const cfg = loadConfig();
  if (!cfg.googleClientId || !cfg.googleClientSecret || !cfg.googleRedirectUri) {
    throw new Error(
      'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI must all be set',
    );
  }
  return new OAuth2Client({
    clientId: cfg.googleClientId,
    clientSecret: cfg.googleClientSecret,
    redirectUri: cfg.googleRedirectUri,
  });
}

export interface GoogleProfile {
  /** Google's stable subject id (`sub` in the id_token). */
  googleSub: string;
  email: string;
  name: string | null;
  pictureUrl: string | null;
}

/** Build the URL we 302 the user to so they can consent at Google. */
export function buildAuthorizeUrl(state: string): string {
  const client = makeClient();
  return client.generateAuthUrl({
    scope: SCOPES,
    access_type: 'online',
    prompt: 'select_account',
    state,
    include_granted_scopes: true,
  });
}

/**
 * Exchange the `code` query param from the callback for tokens, then verify
 * the id_token's signature/audience/issuer/expiry against Google's JWKs.
 * Returns the verified profile. Throws on any failure (network, bad code,
 * verify failure) — the caller logs and redirects to ?error=auth_*.
 */
export async function verifyCallback(code: string): Promise<GoogleProfile> {
  const client = makeClient();
  const cfg = loadConfig();

  // Exchange the authorization code for tokens.
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) {
    log.error(
      { authOp: 'callback', reason: 'no_id_token' },
      'ERROR Google token response did not include id_token',
    );
    throw new Error('Google token response missing id_token');
  }

  // Verify the id_token. verifyIdToken does aud + iss + exp + signature.
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: cfg.googleClientId!,
  });
  const payload = ticket.getPayload();
  if (!payload || !payload.sub || !payload.email) {
    log.error(
      { authOp: 'callback', reason: 'invalid_payload' },
      'ERROR id_token payload missing sub/email',
    );
    throw new Error('id_token payload missing sub or email');
  }

  return {
    googleSub: payload.sub,
    email: payload.email,
    name: payload.name ?? null,
    pictureUrl: payload.picture ?? null,
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/auth/google.ts
git commit -m "feat(auth): google-auth-library wrapper"
```

---

## Task 7: `backend/src/auth/users.ts`

**Files:**
- Create: `backend/src/auth/users.ts`

Pure DB layer for the `users` table.

- [ ] **Step 1: Create the file**

Write `backend/src/auth/users.ts`:

```ts
import { getPool } from '../db';
import type { GoogleProfile } from './google';
import type { AuthUser } from '../../../shared/src';

// -----------------------------------------------------------------------------
// users table — pure DB layer. No Google, no HTTP. The auth route exchanges a
// Google profile for a row here (upsert by google_sub) and returns the row's
// id to the session layer.
// -----------------------------------------------------------------------------

interface UsersRow {
  id: string;
  google_sub: string;
  email: string;
  name: string | null;
  picture_url: string | null;
}

function rowToAuthUser(row: UsersRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    pictureUrl: row.picture_url,
    isDemo: row.google_sub === 'demo',
  };
}

/**
 * Upsert by google_sub. Updates email/name/picture on every login (Google
 * profile fields drift) and bumps last_login_at. Returns the AuthUser shape
 * we hand to the rest of the app.
 */
export async function upsertGoogleUser(
  profile: GoogleProfile,
): Promise<AuthUser> {
  const sql = `
    INSERT INTO paper_trade_pro.users (google_sub, email, email_lower, name, picture_url)
    VALUES ($1, $2, lower($2), $3, $4)
    ON CONFLICT (google_sub) DO UPDATE
    SET email         = EXCLUDED.email,
        email_lower   = EXCLUDED.email_lower,
        name          = EXCLUDED.name,
        picture_url   = EXCLUDED.picture_url,
        last_login_at = now()
    RETURNING id, google_sub, email, name, picture_url
  `;
  const { rows } = await getPool().query<UsersRow>(sql, [
    profile.googleSub,
    profile.email,
    profile.name,
    profile.pictureUrl,
  ]);
  if (rows.length !== 1) {
    throw new Error('upsertGoogleUser: expected exactly one row');
  }
  return rowToAuthUser(rows[0]);
}

/** Lookup by primary key. Returns null if no row. */
export async function getUserById(id: string): Promise<AuthUser | null> {
  const { rows } = await getPool().query<UsersRow>(
    `SELECT id, google_sub, email, name, picture_url
     FROM paper_trade_pro.users
     WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  return rowToAuthUser(rows[0]);
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/auth/users.ts
git commit -m "feat(auth): users DB layer (upsertGoogleUser, getUserById)"
```

---

## Task 8: `backend/src/auth/sessions.ts`

**Files:**
- Create: `backend/src/auth/sessions.ts`

DB layer for the `sessions` table. 256-bit random ids. `getSessionUser` returns the joined user shape.

- [ ] **Step 1: Create the file**

Write `backend/src/auth/sessions.ts`:

```ts
import crypto from 'node:crypto';
import { getPool } from '../db';
import { loadConfig } from '../config';
import type { AuthUser } from '../../../shared/src';

// -----------------------------------------------------------------------------
// sessions table — pure DB layer. id is 32 random bytes encoded as base64url
// (43 chars). The session lifetime is read from cfg.sessionLifetimeMs at
// create time and written into expires_at; we don't bump expires_at on every
// request, only last_seen_at.
// -----------------------------------------------------------------------------

function newSessionId(): string {
  // 256 bits, base64url, no padding. Identical to RFC 4648 §5 "URL and
  // Filename safe" alphabet — all the characters are cookie-safe.
  return crypto.randomBytes(32).toString('base64url');
}

export async function createSession(userId: string): Promise<{
  id: string;
  expiresAt: Date;
}> {
  const cfg = loadConfig();
  const id = newSessionId();
  const expiresAt = new Date(Date.now() + cfg.sessionLifetimeMs);
  await getPool().query(
    `INSERT INTO paper_trade_pro.sessions (id, user_id, expires_at)
     VALUES ($1, $2, $3)`,
    [id, userId, expiresAt],
  );
  return { id, expiresAt };
}

interface JoinedRow {
  id: string;
  google_sub: string;
  email: string;
  name: string | null;
  picture_url: string | null;
}

/**
 * Look up a session id, validate it's not expired, and return the joined
 * user. Returns null on miss or expiry. Bumps last_seen_at as a side effect
 * (fire-and-forget — failure does not block the request).
 */
export async function getSessionUser(sid: string): Promise<AuthUser | null> {
  const { rows } = await getPool().query<JoinedRow>(
    `SELECT u.id, u.google_sub, u.email, u.name, u.picture_url
     FROM paper_trade_pro.sessions s
     JOIN paper_trade_pro.users u ON u.id = s.user_id
     WHERE s.id = $1
       AND s.expires_at > now()`,
    [sid],
  );
  if (rows.length === 0) return null;
  // Bump last_seen_at — fire and forget. Log on failure instead of bubbling.
  void getPool()
    .query(
      `UPDATE paper_trade_pro.sessions SET last_seen_at = now() WHERE id = $1`,
      [sid],
    )
    .catch((err: unknown) => {
      // Avoid pulling getLogger here to keep this module dependency-light;
      // the route layer logs auth events with `authOp` already.
      console.error('ERROR sessions.bumpLastSeen failed', err);
    });
  const row = rows[0];
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    pictureUrl: row.picture_url,
    isDemo: row.google_sub === 'demo',
  };
}

export async function deleteSession(sid: string): Promise<void> {
  await getPool().query(`DELETE FROM paper_trade_pro.sessions WHERE id = $1`, [
    sid,
  ]);
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/auth/sessions.ts
git commit -m "feat(auth): sessions DB layer"
```

---

## Task 9: `backend/src/auth/middleware.ts`

**Files:**
- Create: `backend/src/auth/middleware.ts`

Three middlewares + Express `Request.user` augmentation. `requireAuth` 401s without a valid cookie. `bypassAuth` (only when `cfg.bypassAuth` is on) attaches the demo user. `attachDemoUser` does the same but unconditionally — for the `/api/demo/*` routes. `readOnlyDemo` rejects non-GET on the demo prefix.

- [ ] **Step 1: Create the file**

Write `backend/src/auth/middleware.ts`:

```ts
import type { Request, Response, NextFunction } from 'express';
import { getLogger } from '@chongbei/web-basics/server';
import { loadConfig } from '../config';
import { getSessionUser } from './sessions';
import { getUserById } from './users';
import type { AuthUser } from '../../../shared/src';

const log = getLogger('auth.middleware');

// -----------------------------------------------------------------------------
// Augment Express's Request with `user`. Every authenticated handler reads
// `req.user.id` instead of `cfg.currentUserId`. middleware.ts is the only
// place that writes to req.user.
// -----------------------------------------------------------------------------
declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

const DEMO_USER_ID = '3f7c9b2e-8a41-4d6c-b5f3-1e9a72c4d8ab';

let demoUserCache: AuthUser | null = null;
async function loadDemoUser(): Promise<AuthUser> {
  if (demoUserCache) return demoUserCache;
  const u = await getUserById(DEMO_USER_ID);
  if (!u) {
    throw new Error(
      `Demo user ${DEMO_USER_ID} not found in users table. Run ` +
        '`npm run --prefix backend db:init` to seed it.',
    );
  }
  demoUserCache = u;
  return u;
}

/**
 * Real-user gate. Reads ptp_sid, looks up the session+user, attaches to
 * `req.user`. 401 on miss/expiry.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const cfg = loadConfig();
    if (cfg.bypassAuth) {
      // Dev-only path — short-circuit to demo user. Logged once at boot.
      req.user = await loadDemoUser();
      return next();
    }
    const sid = req.cookies?.[cfg.sessionCookieName];
    if (typeof sid !== 'string' || sid.length === 0) {
      res.status(401).json({ error: { code: 'unauthenticated' } });
      return;
    }
    const user = await getSessionUser(sid);
    if (!user) {
      res.status(401).json({ error: { code: 'unauthenticated' } });
      return;
    }
    req.user = user;
    next();
  } catch (err) {
    log.error(
      { err, authOp: 'requireAuth', operation: 'requireAuth' },
      'ERROR requireAuth failed',
    );
    res.status(500).json({ error: { code: 'auth_internal' } });
  }
}

/**
 * Unconditionally attach the demo user. Mounted only under /api/demo/*.
 */
export async function attachDemoUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    req.user = await loadDemoUser();
    next();
  } catch (err) {
    log.error(
      { err, authOp: 'demo_attach' },
      'ERROR attachDemoUser failed',
    );
    next(err);
  }
}

/**
 * Read-only demo gate. Mounted *after* attachDemoUser. Anything other than
 * GET (or HEAD/OPTIONS) is 403 with a clear toast-friendly code.
 */
export function readOnlyDemo(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  log.warn(
    {
      authOp: 'readonly_block',
      method: req.method,
      path: req.originalUrl,
    },
    'demo readonly block',
  );
  res.status(403).json({
    error: { code: 'demo_readonly', message: 'Sign in to trade.' },
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: 0 errors. (If `req.cookies` is unknown, ensure `cookie-parser` is installed — Task 2.)

- [ ] **Step 3: Commit**

```bash
git add backend/src/auth/middleware.ts
git commit -m "feat(auth): requireAuth, attachDemoUser, readOnlyDemo"
```

---

## Task 10: `backend/src/auth/routes.ts`

**Files:**
- Create: `backend/src/auth/routes.ts`

The four `/api/auth/*` routes. State cookie is a separate short-lived cookie (`ptp_oauth_state`, 10-minute lifetime). Errors redirect to `/?error=<code>&ref=<reqRef>`.

- [ ] **Step 1: Create the file**

Write `backend/src/auth/routes.ts`:

```ts
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { getLogger } from '@chongbei/web-basics/server';
import { loadConfig } from '../config';
import { buildAuthorizeUrl, verifyCallback } from './google';
import { upsertGoogleUser } from './users';
import { createSession, deleteSession } from './sessions';
import type { AuthMeResponse } from '../../../shared/src';

const log = getLogger('auth.routes');

// -----------------------------------------------------------------------------
// /api/auth/* routes. The four entry points:
//
//   GET  /api/auth/google/start    302 to Google
//   GET  /api/auth/google/callback consume code, set cookie, 302 to /app
//   GET  /api/auth/me              { user } | 401
//   POST /api/auth/logout          delete session row, clear cookie, 200
//
// Errors redirect to `/?error=<code>&ref=<reqRef>` so the landing page can
// surface a banner. The state cookie is a separate short-lived cookie
// (`ptp_oauth_state`, 10 min) so rotating it doesn't touch the session
// cookie's expiry.
// -----------------------------------------------------------------------------

const STATE_COOKIE = 'ptp_oauth_state';
const STATE_LIFETIME_MS = 10 * 60 * 1000;

function isProd(): boolean {
  return process.env.NODE_ENV === 'production';
}

function setStateCookie(res: Response, value: string): void {
  res.cookie(STATE_COOKIE, value, {
    httpOnly: true,
    secure: isProd(),
    sameSite: 'lax',
    path: '/',
    maxAge: STATE_LIFETIME_MS,
  });
}

function clearStateCookie(res: Response): void {
  res.clearCookie(STATE_COOKIE, { path: '/' });
}

function setSessionCookie(res: Response, sid: string, expiresAt: Date): void {
  const cfg = loadConfig();
  res.cookie(cfg.sessionCookieName, sid, {
    httpOnly: true,
    secure: isProd(),
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

function clearSessionCookie(res: Response): void {
  const cfg = loadConfig();
  res.clearCookie(cfg.sessionCookieName, { path: '/' });
}

/** Read the request `ref` set by attachRef so we can echo it on errors. */
function reqRef(req: Request): string {
  const v = (req as unknown as { ref?: string }).ref;
  return typeof v === 'string' && v.length > 0 ? v : '';
}

function redirectError(
  res: Response,
  req: Request,
  code:
    | 'auth_state'
    | 'auth_verify'
    | 'auth_db'
    | 'auth_misconfig'
    | 'auth_cancelled',
): void {
  const ref = reqRef(req);
  const qs = new URLSearchParams({ error: code });
  if (ref) qs.set('ref', ref);
  res.redirect(`/?${qs.toString()}`);
}

export function createAuthRouter(): Router {
  const router = Router();

  // ---- /api/auth/google/start ---------------------------------------------
  router.get('/auth/google/start', (req: Request, res: Response) => {
    try {
      const cfg = loadConfig();
      if (!cfg.googleClientId) {
        log.error(
          { authOp: 'start' },
          'ERROR /auth/google/start with no GOOGLE_CLIENT_ID configured',
        );
        return redirectError(res, req, 'auth_misconfig');
      }
      const state = crypto.randomBytes(16).toString('base64url');
      setStateCookie(res, state);
      const url = buildAuthorizeUrl(state);
      log.info({ authOp: 'start' }, 'redirecting to Google');
      res.redirect(url);
    } catch (err) {
      log.error({ err, authOp: 'start' }, 'ERROR /auth/google/start failed');
      redirectError(res, req, 'auth_misconfig');
    }
  });

  // ---- /api/auth/google/callback ------------------------------------------
  router.get('/auth/google/callback', async (req: Request, res: Response) => {
    // Google can return ?error=access_denied if the user clicks Cancel.
    if (typeof req.query.error === 'string') {
      log.info({ authOp: 'callback', err: req.query.error }, 'user cancelled');
      clearStateCookie(res);
      return redirectError(res, req, 'auth_cancelled');
    }

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const stateCookie =
      typeof req.cookies?.[STATE_COOKIE] === 'string'
        ? req.cookies[STATE_COOKIE]
        : '';
    clearStateCookie(res);

    if (!code || !state || !stateCookie || state !== stateCookie) {
      log.warn(
        { authOp: 'callback', hasCode: !!code, stateMatch: state === stateCookie },
        'WARN auth callback state mismatch',
      );
      return redirectError(res, req, 'auth_state');
    }

    let profile;
    try {
      profile = await verifyCallback(code);
    } catch (err) {
      log.error(
        { err, authOp: 'callback' },
        'ERROR /auth/google/callback verify failed',
      );
      return redirectError(res, req, 'auth_verify');
    }

    let user;
    let session;
    try {
      user = await upsertGoogleUser(profile);
      session = await createSession(user.id);
    } catch (err) {
      log.error(
        { err, authOp: 'callback' },
        'ERROR /auth/google/callback DB write failed',
      );
      return redirectError(res, req, 'auth_db');
    }

    setSessionCookie(res, session.id, session.expiresAt);
    log.info({ authOp: 'callback', userId: user.id }, 'sign-in success');
    res.redirect('/app');
  });

  // ---- /api/auth/me --------------------------------------------------------
  router.get('/auth/me', async (req: Request, res: Response) => {
    try {
      const cfg = loadConfig();
      // Mirror requireAuth's contract but never 500 — this endpoint is
      // polled at boot, including by the landing page; transient flakes
      // should look like "not signed in", not "fatal error".
      if (cfg.bypassAuth) {
        // Lazy import to avoid a circular dep with middleware (which already
        // imports from this module's siblings).
        const { getUserById } = await import('./users');
        const u = await getUserById('3f7c9b2e-8a41-4d6c-b5f3-1e9a72c4d8ab');
        if (!u) return res.status(401).json({ error: { code: 'unauthenticated' } });
        const body: AuthMeResponse = { user: u };
        return res.json(body);
      }
      const sid = req.cookies?.[cfg.sessionCookieName];
      if (typeof sid !== 'string' || sid.length === 0) {
        return res.status(401).json({ error: { code: 'unauthenticated' } });
      }
      const { getSessionUser } = await import('./sessions');
      const user = await getSessionUser(sid);
      if (!user) {
        return res.status(401).json({ error: { code: 'unauthenticated' } });
      }
      const body: AuthMeResponse = { user };
      return res.json(body);
    } catch (err) {
      log.error({ err, authOp: 'me' }, 'ERROR /auth/me failed');
      return res.status(401).json({ error: { code: 'unauthenticated' } });
    }
  });

  // ---- /api/auth/logout ---------------------------------------------------
  router.post('/auth/logout', async (req: Request, res: Response) => {
    try {
      const cfg = loadConfig();
      const sid = req.cookies?.[cfg.sessionCookieName];
      if (typeof sid === 'string' && sid.length > 0) {
        await deleteSession(sid);
      }
      clearSessionCookie(res);
      log.info({ authOp: 'logout' }, 'logout');
      res.json({ ok: true });
    } catch (err) {
      log.error({ err, authOp: 'logout' }, 'ERROR /auth/logout failed');
      // Even on error, clear the cookie — the user should not be stuck.
      clearSessionCookie(res);
      res.status(500).json({ error: { code: 'logout_failed' } });
    }
  });

  return router;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/auth/routes.ts
git commit -m "feat(auth): /api/auth/* routes"
```

---

## Task 11: Demo-user seed script

**Files:**
- Create: `backend/scripts/seedDemoUser.ts`
- Modify: `backend/scripts/initDb.ts`

The hardcoded `3f7c9b2e-...` UUID has been the implicit user since day one. Now it's an explicit row. Idempotent.

- [ ] **Step 1: Create `backend/scripts/seedDemoUser.ts`**

Write:

```ts
/* eslint-disable no-console */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { Client } from 'pg';

// -----------------------------------------------------------------------------
// seedDemoUser.ts — idempotent insert of the demo user row.
//
// The pre-auth app keyed everything off cfg.currentUserId
// (3f7c9b2e-8a41-4d6c-b5f3-1e9a72c4d8ab). Phase 1 introduces a real users
// table; this script makes that UUID a real row so existing positions/orders/
// alerts/watchlist/equity_snapshots foreign-key cleanly.
//
// google_sub='demo' is what middleware.ts uses to set isDemo=true on the
// AuthUser shape, and what readOnlyDemo doesn't actually read — it's a
// label the rest of the system can rely on.
// -----------------------------------------------------------------------------

const DEMO_USER_ID = '3f7c9b2e-8a41-4d6c-b5f3-1e9a72c4d8ab';

function resolveDotEnv(): string {
  let dir = __dirname;
  while (true) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`FATAL: could not locate .env walking up from ${__dirname}`);
    }
    dir = parent;
  }
}

export async function seedDemoUser(): Promise<void> {
  dotenv.config({ path: resolveDotEnv() });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('FATAL: DATABASE_URL is not set');

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query(
      `INSERT INTO paper_trade_pro.users
         (id, google_sub, email, email_lower, name, picture_url)
       VALUES
         ($1, 'demo', 'demo@papertrade.local', 'demo@papertrade.local',
          'Demo Account', NULL)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [DEMO_USER_ID],
    );
    if (result.rowCount === 1) {
      console.log(`[seedDemoUser] inserted demo user ${DEMO_USER_ID}`);
    } else {
      console.log(`[seedDemoUser] demo user ${DEMO_USER_ID} already present`);
    }
  } finally {
    await client.end();
  }
}

// Standalone invocation (`tsx backend/scripts/seedDemoUser.ts`).
// eslint-disable-next-line @typescript-eslint/no-floating-promises
if (require.main === module) {
  seedDemoUser().catch((err) => {
    console.error('ERROR [seedDemoUser] failed:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Modify `backend/scripts/initDb.ts` to also run the seed**

Edit `backend/scripts/initDb.ts`. Inside `main()`, after the `console.log('[initDb] OK ...');` line, add:

```ts
    // Seed the demo user row so existing data (positions/orders/...) for
    // the legacy hardcoded user id remains valid against the new FK.
    const { seedDemoUser } = await import('./seedDemoUser');
    await seedDemoUser();
```

Keep the rest of the file the same.

- [ ] **Step 3: Run it**

```bash
npm run --prefix backend db:init
```
Expected: prints `[initDb] OK ...` and `[seedDemoUser] inserted demo user ...` (or `already present`).

- [ ] **Step 4: Verify the row exists**

```bash
psql "$(grep '^DATABASE_URL=' .env | cut -d'=' -f2-)" -c \
  "SELECT id, google_sub, email FROM paper_trade_pro.users WHERE google_sub='demo'"
```
Expected: one row with `id=3f7c9b2e-8a41-4d6c-b5f3-1e9a72c4d8ab`.

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/seedDemoUser.ts backend/scripts/initDb.ts
git commit -m "feat(db): seed demo users row from db:init"
```

---

## Task 12: Wire it into `server.ts` (the surgical bit)

**Files:**
- Modify: `backend/src/server.ts`

This is the integration step. The diff has four parts:

1. New imports + `cookieParser` middleware.
2. Mount `/api/auth/*` (no auth required).
3. Mount the existing portfolio router behind `requireAuth` at `/api`.
4. Mount the same portfolio router behind `attachDemoUser` + `readOnlyDemo` at `/api/demo`.
5. Swap `getUserId` to read `req.user.id` (with a typeguard).
6. Set `app.set('trust proxy', 1)`.
7. Print a `WARN` at boot if `cfg.bypassAuth` is on.

- [ ] **Step 1: Apply this diff to `backend/src/server.ts`**

Find the imports block and add (next to the existing imports — keep the existing order):

```ts
import cookieParser from 'cookie-parser';
import { createAuthRouter } from './auth/routes';
import { requireAuth, attachDemoUser, readOnlyDemo } from './auth/middleware';
```

Find this block in `main()`:

```ts
  const app = express();
  app.use(cors({ origin: cfg.frontendOrigin }));
  app.use(express.json());
  // Install early so every route handler and service call downstream can emit
  // logs tagged with the request's `ref`.
  app.use(attachRef);
```

Replace it with:

```ts
  const app = express();
  // Trust the X-Forwarded-Proto header from nginx so req.secure / Secure
  // cookies behave correctly in production.
  app.set('trust proxy', 1);
  app.use(cors({ origin: cfg.frontendOrigin, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());
  // Install early so every route handler and service call downstream can emit
  // logs tagged with the request's `ref`.
  app.use(attachRef);

  if (cfg.bypassAuth) {
    log.warn(
      { authOp: 'bypass' },
      'WARN BYPASS_AUTH=1 active — every request resolves to the demo user. ' +
        'Refused under NODE_ENV=production; harmless in dev.',
    );
  }
```

Find this block (current portfolio mount):

```ts
  const portfolioStore = new PortfolioStore({
    initialCash: cfg.initialCash,
    marketClock,
  });
  const snapshotter = new EquitySnapshotter(
    cache,
    cfg.historySnapshotIntervalMs,
  );
  snapshotter.start();
  app.use(
    "/api",
    createPortfolioRouter({
      store: portfolioStore,
      snapshotter,
      getUserId: () => cfg.currentUserId,
    }),
  );
```

Replace with:

```ts
  const portfolioStore = new PortfolioStore({
    initialCash: cfg.initialCash,
    marketClock,
  });
  const snapshotter = new EquitySnapshotter(
    cache,
    cfg.historySnapshotIntervalMs,
  );
  snapshotter.start();

  // Auth routes — no requireAuth gate; these are how you obtain a session.
  app.use('/api', createAuthRouter());

  // Real-user portfolio. requireAuth attaches req.user.id; the router reads
  // it via getUserId. When BYPASS_AUTH=1 is on (dev), requireAuth attaches
  // the demo user and lets the request through.
  app.use(
    '/api',
    requireAuth,
    createPortfolioRouter({
      store: portfolioStore,
      snapshotter,
      getUserId: (req) => {
        if (!req.user) throw new Error('requireAuth did not attach req.user');
        return req.user.id;
      },
    }),
  );

  // Demo portfolio — same handlers, demo user, read-only enforcement.
  // /api/demo/portfolio, /api/demo/orders, etc.
  app.use(
    '/api/demo',
    attachDemoUser,
    readOnlyDemo,
    createPortfolioRouter({
      store: portfolioStore,
      snapshotter,
      getUserId: (req) => {
        if (!req.user) throw new Error('attachDemoUser did not attach req.user');
        return req.user.id;
      },
    }),
  );
```

(The `quotes` and `market` routers stay where they are. They don't read `getUserId`.)

- [ ] **Step 2: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Boot it**

Run (root): `npm run dev`. Watch the backend log line. Expected on success:

```
... paper-trade-pro backend listening
```

If `BYPASS_AUTH=1` is set, also expect (right above the "listening" line):

```
WARN BYPASS_AUTH=1 active — every request resolves to the demo user...
```

- [ ] **Step 4: Smoke `/api/auth/me` against an empty session**

In another terminal:
```bash
curl -i http://localhost:5011/api/auth/me
```
Expected: `HTTP/1.1 401 Unauthorized` with `{"error":{"code":"unauthenticated"}}`. (If `BYPASS_AUTH=1`, expect a `200 OK` with the demo user JSON instead — that's correct.)

- [ ] **Step 5: Smoke `/api/portfolio` is gated**

```bash
curl -i http://localhost:5011/api/portfolio
```
Expected (no `BYPASS_AUTH`): `401`. (With `BYPASS_AUTH=1`: full portfolio JSON.)

- [ ] **Step 6: Smoke the demo portfolio is open + read-only**

```bash
curl -i http://localhost:5011/api/demo/portfolio
curl -i -X POST http://localhost:5011/api/demo/portfolio/reset
```
Expected: first call 200; second call 403 with `{"error":{"code":"demo_readonly","message":"Sign in to trade."}}`.

- [ ] **Step 7: Commit**

```bash
git add backend/src/server.ts
git commit -m "feat(auth): mount /api/auth/*, gate /api/* with requireAuth, add /api/demo/*"
```

---

## Task 13: `deploy/` — nginx config example, README, certbot notes

**Files:**
- Create: `deploy/nginx.conf.example`
- Create: `deploy/README.md`
- Create: `deploy/certbot.md`

The prod cutover docs. Not exercised in dev (Phase 0's Vite proxy mirrors them) but checked in so the prod cutover is mechanical.

- [ ] **Step 1: Create `deploy/nginx.conf.example`**

Write `deploy/nginx.conf.example` exactly per spec §5.2:

```nginx
# -----------------------------------------------------------------------------
# Paper Trade Pro — production nginx config (example).
# Replace papertrade.pro with your domain and adjust the SPA root path.
# Apply via:
#   sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/papertrade
#   sudo ln -s /etc/nginx/sites-available/papertrade /etc/nginx/sites-enabled/
#   sudo nginx -t && sudo systemctl reload nginx
# -----------------------------------------------------------------------------

server {
  listen 443 ssl http2;
  server_name papertrade.pro;
  # certbot manages ssl_certificate / ssl_certificate_key — see certbot.md.

  # ----- API -----
  location /api/ {
    proxy_pass         http://127.0.0.1:5010;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   X-Real-IP         $remote_addr;
  }

  # ----- WebSocket -----
  location /socket.io/ {
    proxy_pass         http://127.0.0.1:5010;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade           $http_upgrade;
    proxy_set_header   Connection        "upgrade";
    proxy_set_header   Host              $host;
    proxy_read_timeout 3600s;
    proxy_buffering    off;
  }

  # ----- SPA -----
  root /var/www/papertrade/frontend/dist;
  index index.html;

  location / {
    try_files $uri $uri/ /index.html;
  }

  # Cache hashed assets aggressively, never cache index.html.
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

- [ ] **Step 2: Create `deploy/README.md`**

Write `deploy/README.md`:

```markdown
# Deploying Paper Trade Pro (single host, nginx + pm2)

This is the bare-metal recipe. CI/CD is out of scope.

## Prerequisites

- Ubuntu 22.04+ (or any distro with nginx + Node 20+ + pm2)
- A domain pointed at the host (A/AAAA record)
- A Postgres database (Neon prod branch recommended)
- Alpaca paper-account API keys
- A Google OAuth client (see `docs/Local_Dev.md` for setup; register the
  prod redirect URI: `https://<domain>/api/auth/google/callback`)

## Layout

```
/var/www/papertrade/             # owned by the service user (e.g. www-data)
├── frontend/dist/               # SPA static bundle (rsynced from CI or local)
├── backend/                     # backend source + node_modules + dist
└── .env                         # prod env vars (NEVER VITE_-prefixed secrets)
```

## One-time host setup

1. Install nginx, certbot, Node 20+, pm2.
2. Create the service user, clone the repo, install deps:

   ```bash
   sudo adduser --system --group papertrade
   sudo -u papertrade git clone <repo> /var/www/papertrade
   cd /var/www/papertrade
   sudo -u papertrade npm run install:all
   ```

3. Populate `/var/www/papertrade/.env` from `.env.example`. Required:

   - `DATABASE_URL` — prod Postgres
   - `APCA_KEY_ID`, `APCA_SECRET_KEY` — Alpaca paper account
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI=https://<domain>/api/auth/google/callback`
   - `NODE_ENV=production`

   Do NOT set `BYPASS_AUTH=1` — the backend will refuse to start.

4. Initialize the DB schema:

   ```bash
   sudo -u papertrade npm run --prefix backend db:init
   ```

5. Build everything:

   ```bash
   sudo -u papertrade npm run build:all
   ```

6. Start the backend with pm2:

   ```bash
   sudo -u papertrade pm2 startOrReload ecosystem.config.cjs
   sudo pm2 startup systemd -u papertrade --hp /home/papertrade
   sudo -u papertrade pm2 save
   ```

7. Install nginx config:

   ```bash
   sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/papertrade
   # Edit: replace papertrade.pro with your domain.
   sudo ln -s /etc/nginx/sites-available/papertrade /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```

8. Provision TLS with certbot — see `certbot.md`.

## Subsequent deploys

```bash
sudo -u papertrade git pull
sudo -u papertrade npm run install:all
sudo -u papertrade npm run build:all
sudo -u papertrade pm2 reload ecosystem.config.cjs
```

(Frontend changes are picked up because nginx serves `frontend/dist/`
directly; no nginx reload needed unless `nginx.conf.example` itself changed.)

## Smoke test

After every deploy:

```bash
curl -i https://<domain>/api/market/clock
curl -i https://<domain>/api/auth/me   # should be 401 in incognito
```

Open `https://<domain>/` in a private window — landing page renders.
Click "Sign in with Google" — full OAuth round-trip — land at /app.
```

- [ ] **Step 3: Create `deploy/certbot.md`**

Write `deploy/certbot.md`:

```markdown
# TLS via certbot (one-time)

Assumes you've already installed nginx and pointed your domain's
A/AAAA records at the host.

## Install certbot

```bash
sudo apt install certbot python3-certbot-nginx
```

## Provision the certificate

```bash
sudo certbot --nginx -d papertrade.pro
```

This:

- Talks to Let's Encrypt to issue the certificate.
- Edits `/etc/nginx/sites-available/papertrade` to add `ssl_certificate`
  and `ssl_certificate_key` directives pointing at
  `/etc/letsencrypt/live/papertrade.pro/`.
- Reloads nginx.

## Auto-renewal

Certbot installs a systemd timer that renews automatically. Verify:

```bash
sudo systemctl list-timers | grep certbot
```

Expected: a `certbot.timer` line with the next run time.

## What if cert provisioning fails

- DNS not propagated yet → wait + re-run.
- Port 80 not reachable from the public internet → fix firewall / cloud
  rules first.
- Rate-limited (5 certs per registered domain per week) → wait.
```

- [ ] **Step 4: Commit**

```bash
git add deploy/nginx.conf.example deploy/README.md deploy/certbot.md
git commit -m "docs(deploy): nginx.conf.example + README + certbot.md"
```

---

## Task 14: Manual end-to-end Google sign-in (with a real client)

**Files:**
- (none — verification only)

This is the smoke test that proves Phase 1 actually works. Skip if you don't have a Google OAuth client set up — the next phases don't depend on this for code, but you'll want to run it before merging.

- [ ] **Step 1: Provision a Google OAuth client (one-time)**

Per `docs/Local_Dev.md`:
1. Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID → Web application.
2. Add authorized redirect URI: `http://localhost:5011/api/auth/google/callback`.
3. Copy `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` into `.env` (and unset `BYPASS_AUTH` if you set it earlier).

- [ ] **Step 2: Run the full flow manually**

1. `npm run dev`.
2. In a private/incognito window, open `http://localhost:5011/api/auth/google/start`.
3. Consent at Google.
4. Confirm you're redirected to `http://localhost:5011/app` (which currently 404s in the frontend — that's expected; Phase 2 ships the route).
5. In DevTools → Application → Cookies for `localhost:5011`: confirm `ptp_sid` exists, `HttpOnly`, `SameSite=Lax`.
6. `curl --cookie 'ptp_sid=<value>' http://localhost:5011/api/auth/me` → 200 + your user JSON.
7. `curl --cookie 'ptp_sid=<value>' http://localhost:5011/api/portfolio` → 200.

- [ ] **Step 3: Test the unhappy paths**

- Tamper with the state cookie before completing consent → expect redirect to `/?error=auth_state&ref=...`.
- Click "Cancel" at Google → expect `/?error=auth_cancelled&ref=...` (no banner; spec §6.1 says silent for cancelled).
- `curl -X POST http://localhost:5011/api/auth/logout --cookie 'ptp_sid=<value>'` → 200; the row in `paper_trade_pro.sessions` is gone.

- [ ] **Step 4: No commit**

This task is verification only. If anything failed, fix it inline and re-run.

---

## Phase 1 verification checklist (from spec §6.5)

Before opening the PR.

**Schema / seed**
- [ ] `npm run --prefix backend db:init` is idempotent — re-running prints `already present`.
- [ ] `paper_trade_pro.users` row for `3f7c9b2e-...` exists.

**Routing**
- [ ] `/api/auth/me` 401s without a cookie.
- [ ] `/api/portfolio` 401s without a cookie.
- [ ] `/api/demo/portfolio` 200s without a cookie.
- [ ] `/api/demo/portfolio/reset` 403s with `code: "demo_readonly"`.

**Auth happy + sad paths**
- [ ] First-time sign-in inserts a `users` row, sets `ptp_sid`, redirects to `/app`.
- [ ] Returning sign-in finds the existing row by `google_sub`, bumps `last_login_at`.
- [ ] `/api/auth/me` (with cookie) returns the right user.
- [ ] Logout deletes the `sessions` row, clears the cookie, returns 200.
- [ ] Tampered state cookie → `?error=auth_state` redirect.
- [ ] Cancel at Google → `?error=auth_cancelled` redirect.

**BYPASS_AUTH**
- [ ] `BYPASS_AUTH=1 npm run dev` boots and prints the WARN.
- [ ] `BYPASS_AUTH=1 NODE_ENV=production node ...` refuses to start.

**Logging**
- [ ] Each auth route logs at INFO/WARN/ERROR with `authOp` set.
- [ ] Errors include the original exception via `{ err }`.

## Phase 1 PR description template

```
Phase 1 of the landing-page + Google-auth project. No UI changes.

- New paper_trade_pro.users + paper_trade_pro.sessions tables.
- Server-side OAuth via google-auth-library + cookie-parser.
- /api/auth/google/start, /callback, /me, /logout.
- requireAuth gates /api/portfolio/* (etc.).
- /api/demo/* mounts the same handlers behind attachDemoUser + readOnlyDemo.
- BYPASS_AUTH=1 (dev-only) short-circuits to the demo user.
- Demo user (UUID 3f7c9b2e-...) is now a real users row, seeded from db:init.

Spec: docs/superpowers/specs/2026-05-19-landing-page-and-google-auth-design.md §1, §4, §5.0 step 8
Plan: docs/superpowers/plans/2026-05-19-landing-phase-1-auth-backbone.md
```
