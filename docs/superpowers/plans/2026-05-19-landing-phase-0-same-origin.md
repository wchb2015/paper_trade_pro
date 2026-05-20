# Phase 0 — Same-origin plumbing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror the production same-origin setup in local dev so cookies and OAuth work without nginx. Browser talks only to `http://localhost:5011`; Vite proxies `/api` and `/socket.io` to the backend on `:5010`. No behavior change for users.

**Architecture:** Drop `config.backendUrl` to `''` so the three frontend client modules (`marketClient`, `portfolioClient`, `priceClient`) build relative URLs. Add `server.proxy` to `vite.config.ts`. Add a root-level `npm run dev` that boots both halves with `concurrently`. Document the bring-up in `docs/Local_Dev.md`.

**Tech Stack:** Vite 8, `socket.io-client` (already same-origin-friendly when given `'/'`), `concurrently` (new devDep).

**Spec:** [`docs/superpowers/specs/2026-05-19-landing-page-and-google-auth-design.md`](../specs/2026-05-19-landing-page-and-google-auth-design.md) §5.0

---

## File Structure

### New
- `docs/Local_Dev.md` — clone → install → `.env` → `npm run dev` walkthrough.

### Modified
- `frontend/vite.config.ts` — add `server.proxy` for `/api` and `/socket.io`. Drop the `define` for `VITE_BACKEND_URL` (no longer needed by client code).
- `frontend/src/config.ts` — `backendUrl` becomes `''`. Drop the FATAL throw.
- `frontend/src/lib/marketClient.ts` — drop the `${config.backendUrl}` prefix.
- `frontend/src/lib/portfolioClient.ts` — drop the `${config.backendUrl}` prefix.
- `frontend/src/lib/priceClient.ts` — pass `''` (or `'/'`) to the `PriceClient` constructor; relative URLs in `fetch` calls.
- `package.json` (root) — add `dev` script and `concurrently` devDep.

### Untouched
- `ports.cjs` (the constants are still used by Vite + backend; only the *frontend client code* stops needing the URL).
- `backend/src/server.ts`, `backend/src/config.ts` — backend still listens on `:5010` exactly as before.
- `ecosystem.config.cjs` — pm2 prod config doesn't change.
- All existing pages and components.

---

## Task 1: Add Vite dev-server proxy

**Files:**
- Modify: `frontend/vite.config.ts`

The proxy makes Vite forward `/api` and `/socket.io` to the backend, so the browser never hits `:5010` directly.

- [ ] **Step 1: Replace the file content**

Write `frontend/vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ports = require('../ports.cjs') as {
  BACKEND_PORT: number
  FRONTEND_DEV_PORT: number
  BACKEND_URL: string
  FRONTEND_DEV_URL: string
}
if (typeof ports.FRONTEND_DEV_PORT !== 'number') {
  throw new Error('FATAL: ports.cjs missing FRONTEND_DEV_PORT (number)')
}
if (typeof ports.BACKEND_URL !== 'string' || !ports.BACKEND_URL) {
  throw new Error('FATAL: ports.cjs missing BACKEND_URL (string)')
}

// https://vite.dev/config/
export default defineConfig({
  envDir: '..',
  plugins: [react()],
  server: {
    port: ports.FRONTEND_DEV_PORT,
    strictPort: true,
    // -----------------------------------------------------------------------
    // Same-origin in dev. Frontend client modules use relative URLs
    // (e.g. '/api/portfolio'); Vite forwards them to the backend on
    // ports.BACKEND_URL. This mirrors the prod nginx setup so OAuth
    // cookies and CORS behave the same in both environments.
    // -----------------------------------------------------------------------
    proxy: {
      '/api': { target: ports.BACKEND_URL, changeOrigin: true },
      '/socket.io': {
        target: ports.BACKEND_URL,
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
```

(The previous `define` for `VITE_BACKEND_URL` is gone — `config.backendUrl` becomes `''` in Task 2.)

- [ ] **Step 2: Verify Vite still parses the config**

Run:
```bash
cd frontend && npx vite --help >/dev/null
```
Expected: exits 0, no error printed. (If you see `FATAL: ports.cjs ...`, fix `ports.cjs` first.)

- [ ] **Step 3: Commit**

```bash
git add frontend/vite.config.ts
git commit -m "feat(dev): vite dev-server proxies /api and /socket.io"
```

---

## Task 2: `frontend/src/config.ts` — relative URLs

**Files:**
- Modify: `frontend/src/config.ts`

Drop the cross-origin URL injection. Keep the rest of the runtime config exactly as it was.

- [ ] **Step 1: Replace the file content**

Write `frontend/src/config.ts`:

```ts
// Frontend runtime config. Only two things are configurable at build-time
// for the UI — refresh intervals. The backend URL is empty: every client
// module builds relative paths ('/api/...') that ride on the Vite dev
// proxy in development and on the nginx reverse-proxy in production.

const meta = import.meta.env as Record<string, string | undefined>;

export const config = {
  /**
   * Empty string by design. All client modules call `/api/...` directly,
   * which the dev server (Vite proxy) and prod (nginx) both route to the
   * Node backend. Same-origin everywhere keeps the cookie + CORS story
   * identical between dev and prod. See spec §5.0.
   */
  backendUrl: '',
  /**
   * How often we poll the backend's /api/quotes as a belt-and-suspenders
   * refresh of bid/ask/dayHigh/etc. (the socket only delivers trade price).
   */
  snapshotRefreshMs: Number(meta['VITE_SNAPSHOT_REFRESH_MS'] ?? 30_000),
  /** After this long with no tick, a symbol is shown as "stale". */
  staleAfterMs: Number(meta['VITE_STALE_AFTER_MS'] ?? 60_000),
  /** Max points kept in the rolling history drawn in sparklines. */
  sparklinePoints: 90,
} as const;
```

- [ ] **Step 2: Typecheck**

Run:
```bash
cd frontend && npx tsc -b
```
Expected: 0 errors. (TS will not complain — `${config.backendUrl}${path}` still compiles even when `backendUrl` is `''`.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/config.ts
git commit -m "refactor(frontend): config.backendUrl = '' for same-origin"
```

---

## Task 3: `marketClient.ts` — drop backendUrl

**Files:**
- Modify: `frontend/src/lib/marketClient.ts`

The `url()` helper is now a no-op (`''` + path = path). Remove it; call `api()` with the path directly.

- [ ] **Step 1: Replace the file content**

Write `frontend/src/lib/marketClient.ts`:

```ts
import { api } from "@chongbei/web-basics/client";
import type { MarketClockResponse } from "../../../shared/src";

// -----------------------------------------------------------------------------
// Thin client for market metadata endpoints. Today this is just the clock.
// Networking goes through `api<T>()` (toast on error, ApiError on non-2xx) —
// same shape as the rest of the frontend API surface.
//
// Same-origin: all paths are relative. See frontend/src/config.ts.
// -----------------------------------------------------------------------------

export const marketClient = {
  getClock(): Promise<MarketClockResponse> {
    return api<MarketClockResponse>("/api/market/clock");
  },
};
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: 0 errors.

- [ ] **Step 3: Lint the touched file**

Run: `cd frontend && npx eslint src/lib/marketClient.ts`
Expected: 0 problems.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/marketClient.ts
git commit -m "refactor(frontend): marketClient uses relative URLs"
```

---

## Task 4: `portfolioClient.ts` — drop backendUrl

**Files:**
- Modify: `frontend/src/lib/portfolioClient.ts`

Same change as Task 3 — drop the `url()` helper and the `config` import; call `api()` with paths directly. The full diff is mechanical: every `url(...)` becomes the inner string.

- [ ] **Step 1: Replace the file content**

Write `frontend/src/lib/portfolioClient.ts`:

```ts
import { api } from "@chongbei/web-basics/client";
import type {
  AddAlertInput,
  FillOrderInput,
  HistoryRange,
  OkResponse,
  Order,
  PlaceOrderInput,
  Portfolio,
  PortfolioHistoryResponse,
  ResetFundsInput,
  ToggleWatchInput,
  TriggerAlertInput,
} from "../../../shared/src";

// -----------------------------------------------------------------------------
// Thin REST wrapper around the backend's /api portfolio endpoints. Every
// mutating call returns the whole Portfolio so usePortfolio can replace its
// state atomically — same shape the old localStorage hook used internally.
//
// Networking goes through `api<T>()` from @chongbei/web-basics: any non-2xx
// throws an ApiError with `{ status, code, ref, message }` AND fires a toast
// via the `configureApi` wiring in main.tsx. Callers catch to record the
// message in local state but don't need to toast themselves.
//
// Same-origin: all paths are relative. See frontend/src/config.ts.
// -----------------------------------------------------------------------------

export const portfolioClient = {
  get(): Promise<Portfolio> {
    return api<Portfolio>("/api/portfolio");
  },
  getHistory(range: HistoryRange): Promise<PortfolioHistoryResponse> {
    return api<PortfolioHistoryResponse>(
      `/api/portfolio/history?range=${encodeURIComponent(range)}`,
    );
  },
  placeOrder(body: PlaceOrderInput): Promise<Order> {
    return api<Order>("/api/orders", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  cancelOrder(id: string): Promise<Portfolio> {
    return api<Portfolio>(`/api/orders/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    });
  },
  fillOrder(id: string, body: FillOrderInput): Promise<Portfolio> {
    return api<Portfolio>(`/api/orders/${encodeURIComponent(id)}/fill`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  addAlert(body: AddAlertInput): Promise<Portfolio> {
    return api<Portfolio>("/api/alerts", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  toggleAlert(id: string): Promise<Portfolio> {
    return api<Portfolio>(`/api/alerts/${encodeURIComponent(id)}/toggle`, {
      method: "POST",
    });
  },
  triggerAlert(id: string, body: TriggerAlertInput): Promise<Portfolio> {
    return api<Portfolio>(
      `/api/alerts/${encodeURIComponent(id)}/trigger`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  },
  removeAlert(id: string): Promise<Portfolio> {
    return api<Portfolio>(`/api/alerts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
  toggleWatch(body: ToggleWatchInput): Promise<Portfolio> {
    return api<Portfolio>("/api/watchlist/toggle", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  reset(body: ResetFundsInput = {}): Promise<OkResponse> {
    return api<OkResponse>("/api/portfolio/reset", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
};
```

- [ ] **Step 2: Typecheck + lint**

Run:
```bash
cd frontend && npx tsc -b && npx eslint src/lib/portfolioClient.ts
```
Expected: 0 errors, 0 lint problems.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/portfolioClient.ts
git commit -m "refactor(frontend): portfolioClient uses relative URLs"
```

---

## Task 5: `priceClient.ts` — relative paths + same-origin socket

**Files:**
- Modify: `frontend/src/lib/priceClient.ts`

The `PriceClient` constructor takes a `baseUrl`. Pass `''` from the singleton; replace the `${this.baseUrl}/api/...` interpolations with plain `/api/...`. For `io(...)`, pass nothing (or `'/'`) so socket.io connects to the page origin.

- [ ] **Step 1: Replace the file content**

Write `frontend/src/lib/priceClient.ts`:

```ts
import { io, type Socket } from "socket.io-client";
import { api } from "@chongbei/web-basics/client";
import { dump } from "./dump";
import type {
  AlpacaFeed,
  AssetLookupResponse,
  BarsResponse,
  BarTimeframe,
  ClientToServerEvents,
  LiveFeedResponse,
  PriceTickPayload,
  ProviderStatusPayload,
  Quote,
  QuotesResponse,
  ServerToClientEvents,
  SubscriptionsResponse,
} from "../../../shared/src";
import { SOCKET_EVENTS } from "../../../shared/src";

// -----------------------------------------------------------------------------
// Single source of truth for talking to the backend. REST calls are cached
// by the server; the socket delivers live trade ticks. All UI code that
// needs a price goes through here — no component fetches prices directly.
//
// Same-origin: REST paths are relative; the WS uses '/' so socket.io
// connects to the current page origin. The Vite dev proxy and prod nginx
// both forward /socket.io/ to the backend.
// -----------------------------------------------------------------------------

export interface PriceClientSubscribers {
  onTick: (tick: PriceTickPayload) => void;
  onStatus: (status: ProviderStatusPayload) => void;
  onConnectionChange: (connected: boolean) => void;
}

export class PriceClient {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents> | null =
    null;
  // Coalesce concurrent ensureSubscribed() calls with identical args. React
  // StrictMode in dev double-invokes effect bodies, so without this we'd fire
  // POST /api/subscriptions twice on every symbol change. Keyed by the
  // sorted symbol set; cleared once the in-flight promise settles.
  private inflightSubs = new Map<string, Promise<SubscriptionsResponse>>();

  /** Batched snapshot fetch. Errors throw ApiError + fire a toast. */
  async fetchQuotes(symbols: string[]): Promise<QuotesResponse> {
    const q = new URLSearchParams({
      symbols: symbols.map((s) => s.toUpperCase()).join(","),
    });
    return api<QuotesResponse>(`/api/quotes?${q}`);
  }

  /**
   * Historical OHLC bars. Backend caches per (symbol, timeframe, limit) so
   * repeating these calls is cheap. Used to seed the intraday sparkline.
   */
  async fetchBars(
    symbol: string,
    timeframe: BarTimeframe,
    limit: number,
    opts?: { feed?: AlpacaFeed },
  ): Promise<BarsResponse> {
    const q = new URLSearchParams({
      symbol: symbol.toUpperCase(),
      timeframe,
      limit: String(limit),
    });
    if (opts?.feed) q.set("feed", opts.feed);
    return api<BarsResponse>(`/api/bars?${q}`);
  }

  /**
   * Switch the live WS feed at runtime (Alpaca only). The server tears down
   * the current WS, reopens against `feed`, and re-subscribes. On failure
   * (e.g. account not entitled to SIP for streaming), the response carries
   * `fellBack: true` and `feed` is the *restored* prior feed — UI should
   * surface a toast and reflect the actual active feed.
   */
  async setLiveFeed(feed: AlpacaFeed): Promise<LiveFeedResponse> {
    return api<LiveFeedResponse>("/api/live-feed", {
      method: "POST",
      body: JSON.stringify({ feed }),
    });
  }

  /** Read the currently active live WS feed. */
  async getLiveFeed(): Promise<LiveFeedResponse> {
    return api<LiveFeedResponse>("/api/live-feed");
  }

  /**
   * "Is this a real, tradable symbol?" — provider-mode-independent.
   */
  async lookupAsset(symbol: string): Promise<AssetLookupResponse> {
    const q = new URLSearchParams({ symbol: symbol.toUpperCase() });
    return api<AssetLookupResponse>(`/api/assets/lookup?${q}`);
  }

  /**
   * Mirror the backend's WS subscription set to exactly `symbols`.
   */
  async ensureSubscribed(symbols: string[]): Promise<SubscriptionsResponse> {
    const upper = symbols.map((s) => s.toUpperCase());
    const key = [...upper].sort().join(",");
    const existing = this.inflightSubs.get(key);
    if (existing) return existing;
    const p = api<SubscriptionsResponse>("/api/subscriptions", {
      method: "POST",
      body: JSON.stringify({ symbols: upper }),
    }).finally(() => {
      this.inflightSubs.delete(key);
    });
    this.inflightSubs.set(key, p);
    return p;
  }

  /** Open the socket and start pushing ticks to the subscriber. */
  connect(subs: PriceClientSubscribers): void {
    console.log("PriceClient.connect subs:\n" + dump(subs));
    if (this.socket) return;
    // Empty / undefined URL → socket.io connects to the current page origin.
    // The dev proxy and prod nginx both route /socket.io/ to the backend.
    const socket = io({
      reconnection: true,
      reconnectionDelay: 2_000,
      timeout: 4_000,
    });
    socket.on("connect", () => subs.onConnectionChange(true));
    socket.on("disconnect", () => subs.onConnectionChange(false));
    socket.on("connect_error", () => subs.onConnectionChange(false));
    socket.on(SOCKET_EVENTS.PRICE_TICK, subs.onTick);
    socket.on(SOCKET_EVENTS.PROVIDER_STATUS, subs.onStatus);
    this.socket = socket;
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }
}

/** Module-level singleton — exactly one socket per tab. */
export const priceClient = new PriceClient();

// Re-export for callers that want the Quote type without a long path.
export type { Quote, QuotesResponse };
```

Note: the constructor no longer takes a `baseUrl` argument. Re-check callers.

- [ ] **Step 2: Confirm no other caller passes a base URL**

Run:
```bash
grep -nR "new PriceClient" /Users/chongbei/Workspace/personal/paper_trade_pro/frontend/src
```
Expected: only one match — the singleton at the bottom of `priceClient.ts`.

- [ ] **Step 3: Typecheck + lint**

Run:
```bash
cd frontend && npx tsc -b && npx eslint src/lib/priceClient.ts
```
Expected: 0 errors, 0 lint problems.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/priceClient.ts
git commit -m "refactor(frontend): priceClient uses relative URLs and same-origin socket"
```

---

## Task 6: Root `npm run dev` script + `concurrently`

**Files:**
- Modify: `package.json` (root)

One command starts both halves. Backend on `:5010`, frontend on `:5011`.

- [ ] **Step 1: Install `concurrently` as a root devDep**

Run:
```bash
cd /Users/chongbei/Workspace/personal/paper_trade_pro && npm install --save-dev concurrently@^9
```
Expected: `package.json` and `package-lock.json` updated; no errors.

- [ ] **Step 2: Add the `dev` script**

Edit root `package.json` and replace the file with:

```json
{
  "name": "paper-trade-pro",
  "version": "1.0.0",
  "description": "Paper trading app (PERN + Socket.io)",
  "private": true,
  "scripts": {
    "install:all": "npm --prefix frontend install --include=dev && npm --prefix backend install --include=dev",
    "build:all": "cd frontend && npm run build && cd ../backend && npm run build",
    "dev": "concurrently -k -n be,fe -c blue,green \"npm --prefix backend run dev\" \"npm --prefix frontend run dev\"",
    "pm2:start": "pm2 startOrReload ecosystem.config.cjs",
    "deploy": "npm run install:all && npm run build:all && npm run pm2:start",
    "lint": "cd frontend && npm run lint"
  },
  "devDependencies": {
    "concurrently": "^9"
  }
}
```

(Keep the exact `concurrently` version that step 1 installed; if npm chose a newer minor, update accordingly.)

- [ ] **Step 3: Smoke the new script**

Run:
```bash
cd /Users/chongbei/Workspace/personal/paper_trade_pro && timeout 6 npm run dev || true
```
Expected (within ~5s, before the timeout kills it):
- A `[be]` line saying `paper-trade-pro backend listening` on `:5010`.
- A `[fe]` line saying `Local: http://localhost:5011/` (Vite dev server).

If the backend complains about missing `.env` keys, that's pre-existing — not the script's fault. Address it by populating `.env` from `.env.example`, then re-run.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add root npm run dev (concurrently)"
```

---

## Task 7: Manual smoke — full path through the proxy

**Files:**
- (none — verification only)

End-to-end check that browsing `http://localhost:5011` reaches the backend through the Vite proxy.

- [ ] **Step 1: Boot both halves**

Run (in one terminal): `npm run dev`

Wait until you see both `[be] paper-trade-pro backend listening` and `[fe] Local: http://localhost:5011/`.

- [ ] **Step 2: Confirm REST proxy works**

In another terminal:
```bash
curl -i http://localhost:5011/api/market/clock
```
Expected: `HTTP/1.1 200 OK` and a JSON body. The fact that this came back through `:5011` proves the proxy is forwarding to `:5010`.

- [ ] **Step 3: Confirm WebSocket proxy works**

Open `http://localhost:5011/` in a browser (any page that mounts the app — Portfolio is fine). Open the DevTools Network panel, filter to `WS`. Expect to see `ws://localhost:5011/socket.io/...?EIO=4&transport=websocket` in `101 Switching Protocols` state, with frames flowing.

If you see `connect_error` toasts in the app: check that the backend logs show no errors and that the proxy entry in `vite.config.ts` has `ws: true`.

- [ ] **Step 4: Confirm no cross-origin requests remain**

Still in DevTools Network panel, look for any request whose **Domain** column is `localhost:5010`. There should be **zero**. Every request should be `localhost:5011` (the SPA origin).

- [ ] **Step 5: No commit**

This task is verification only.

---

## Task 8: `docs/Local_Dev.md`

**Files:**
- Create: `docs/Local_Dev.md`

The contributor entry-point doc. References Phase 1's `GOOGLE_*` env vars but explains that `BYPASS_AUTH=1` is the path of least resistance until the contributor sets up their own Google client.

- [ ] **Step 1: Create the file**

Write `docs/Local_Dev.md`:

```markdown
# Local development

Paper Trade Pro runs as two processes locally:

- **Backend** (`backend/`) — Express + Socket.io on `:5010`.
- **Frontend** (`frontend/`) — Vite dev server on `:5011`.

The browser only ever talks to **`http://localhost:5011`**. Vite's dev
proxy forwards `/api/*` and `/socket.io/*` to the backend, so the cookie
+ same-origin story is identical to production (which uses nginx).

## First-time setup

1. **Clone + install**

   ```bash
   git clone <repo>
   cd paper_trade_pro
   npm install                                  # root devDeps (concurrently)
   npm run install:all                          # frontend + backend
   ```

2. **Create your `.env`**

   ```bash
   cp .env.example .env
   ```

   Required keys:

   - `APCA_KEY_ID`, `APCA_SECRET_KEY` — Alpaca paper account.
     Sign up at https://app.alpaca.markets/paper/dashboard/overview.
   - `DATABASE_URL` — Postgres connection string (Neon dev branch is fine).

3. **Bootstrap the DB**

   ```bash
   npm run --prefix backend db:init
   ```

4. **Bring it up**

   ```bash
   npm run dev
   ```

   Open http://localhost:5011.

## After Phase 1 lands (auth)

You'll need either:

### Option A: A Google OAuth client (full flow)

In Google Cloud Console → "APIs & Services" → "Credentials" → Create OAuth
client ID (Web application). Add **two** authorized redirect URIs:

```
http://localhost:5011/api/auth/google/callback     # local dev
https://papertrade.pro/api/auth/google/callback    # prod (when you have it)
```

Then add to `.env`:

```
GOOGLE_CLIENT_ID=<from console>
GOOGLE_CLIENT_SECRET=<from console>
GOOGLE_REDIRECT_URI=http://localhost:5011/api/auth/google/callback
```

### Option B: `BYPASS_AUTH` (no Google client needed)

If you just want to poke at the app:

```
BYPASS_AUTH=1
```

This short-circuits `requireAuth` to attach the demo user. **Refused** when
`NODE_ENV=production`. Logs a `WARN` at backend startup so you'll always
notice.

## Common gotchas

- **Port already in use:** Both dev servers `strictPort`, so they exit on
  collision. Free `:5010` / `:5011` and re-run.
- **Backend logs `FATAL: APCA_KEY_ID is required`:** Populate `.env`.
- **Browser shows no socket frames:** Check `vite.config.ts` proxy entry has
  `ws: true` and the backend is up.
- **Tab hits `localhost:5010`:** That's a stale build of a client module
  still using `${config.backendUrl}` — pull latest, rebuild.

## Production deploy

See `deploy/README.md` (lands in Phase 1 / 2). TL;DR: nginx serves
`frontend/dist/`, proxies `/api/` and `/socket.io/` to pm2-managed Node
on `:5010`, certbot manages TLS.
```

- [ ] **Step 2: Commit**

```bash
git add docs/Local_Dev.md
git commit -m "docs: Local_Dev.md — contributor bring-up"
```

---

## Phase 0 verification checklist (from spec §6.5)

Run before opening the PR. None of these should fail.

- [ ] Fresh clone + `.env` from `.env.example` + `npm install` + `npm run install:all` + `npm run dev` lands a working app at `http://localhost:5011`.
- [ ] DevTools Network shows zero requests to `localhost:5010`.
- [ ] `/socket.io` ticks reach the browser through the Vite proxy (frames in DevTools WS panel).
- [ ] `npm run --prefix frontend run build` succeeds.
- [ ] `npx tsc -b` (in `frontend/`) prints no errors.

## Phase 0 PR description template

```
Phase 0 of the landing-page + Google-auth project. No user-visible
behavior change.

- Vite dev-server proxies /api and /socket.io to the backend, so the
  browser only talks to :5011.
- frontend/src/config.ts: backendUrl is now ''.
- marketClient / portfolioClient / priceClient: relative URLs only.
- Root `npm run dev` boots both halves with concurrently.
- docs/Local_Dev.md walks contributors from clone to running app.

Spec: docs/superpowers/specs/2026-05-19-landing-page-and-google-auth-design.md §5.0
```
