# Backend API

All routes are mounted under `/api`. Backend listens on `BACKEND_PORT=5010` (`ports.cjs:16`), so the base URL in dev is `http://localhost:5010/api`.

## Conventions

- **Auth**: pre-auth — every request is mapped to `cfg.currentUserId` server-side (`backend/src/server.ts`). No headers required today.
- **Content-Type**: `application/json` on every POST. `express.json()` middleware in `server.ts`.
- **CORS**: allows `cfg.frontendOrigin` only.
- **Errors**: shape is `{ "error": "<message>" }` with `400` for client-correctable problems (invalid enum, missing field, "not found") and `500`/`502` for server/provider failures. Final safety net `errorHandler` returns `{ error: { code, message, ref } }` for anything that escapes a route's try/catch.
- **Portfolio mutations** return the **full refreshed `Portfolio`** so the client can replace state in one shot — **except**:
  - `POST /api/orders` returns just the new `Order`. The client refetches `GET /api/portfolio` afterwards to refresh `cash` / `positions`. Each route owns one concern.
  - `POST /api/portfolio/reset` returns `{ ok: true }` on success (or `{ error }` on failure). The client refetches `GET /api/portfolio` afterwards.

  The equity-snapshotter is invoked in the background after fills/resets so the chart picks up the change.
- **Tracing**: every request gets a short `ref` id via `attachRef` middleware; look it up in pino logs to trace one request end-to-end.

## API surface at a glance

| Category | Endpoints | Purpose |
|---|---|---|
| [Quotes](#1-quotes) | `GET /quotes`, `GET /bars` | Snapshot prices and historical bars |
| [Assets](#2-assets) | `GET /assets/lookup` | Validate / resolve a ticker symbol |
| [Subscriptions](#3-subscriptions) | `GET /subscriptions`, `POST /subscriptions` | Manage which symbols stream over WS |
| [Health](#4-health) | `GET /health` | Liveness + provider status |
| [Portfolio reads](#5-portfolio-reads) | `GET /portfolio`, `GET /portfolio/history` | Full portfolio snapshot + equity history for the dashboard chart |
| [Orders](#6-orders) | `POST /orders`, `POST /orders/:id/cancel`, `POST /orders/:id/fill`, `POST /orders/:id/peak` | Place, cancel, fill, and trail working orders |
| [Alerts](#7-alerts) | `POST /alerts`, `POST /alerts/:id/toggle`, `POST /alerts/:id/trigger`, `DELETE /alerts/:id` | Price-cross alerts |
| [Watchlist](#8-watchlist) | `POST /watchlist/toggle` | Add/remove a ticker from the user's watchlist |
| [Account](#9-account) | `POST /portfolio/reset` | Dev-only: restart the account (wipes positions/orders/history; keeps alerts + watchlist) |
| [Realtime](#10-realtime-socketio) | Socket.io | Push price ticks + provider-status changes |

> **Read this column carefully:** "When called" tells you which UI surface or hook triggers each endpoint. If you change a route, search the named call sites first to understand the blast radius.

---

## 1. Quotes

Source: `backend/src/routes/quotes.ts`. Caching layer: `QuoteCache` (`backend/src/services/QuoteCache.ts`).

### `GET /api/quotes`

| | |
|---|---|
| **Purpose** | Batch snapshot fetch — one round trip returns the latest price + day OHLC + bid/ask for many symbols. Also opportunistically warms the WS subscription for those symbols. |
| **Required** | `symbols` (CSV query, e.g. `AAPL,TSLA`) |
| **Optional** | — |
| **Response 200** | `{ "quotes": { "AAPL": { "symbol":"AAPL", "price":189.2, "bid":189.1, "ask":189.3, "dayOpen":188.0, "dayHigh":190.4, "dayLow":187.5, "prevClose":188.7, "volume":4123456, "timestamp":1715000000000, "status":"live" } }, "providerStatus":"live", "provider":"alpaca" }` |
| **Response 400** | `{ "error":"symbols query param required" }` |
| **Response 502** | `quotes: {}` + `providerStatus:"unavailable"` |
| **When called** | `priceClient.fetchQuotes` — invoked by `useMarket` (`frontend/src/hooks/useMarket.ts:199`) on initial mount and whenever the tracked-symbol set changes (watchlist, positions, working orders, alerts). Cached in `QuoteCache` for `SNAPSHOT_CACHE_TTL_MS=10s` (`shared/src/constants.ts`). |
| **curl** | `curl 'http://localhost:5010/api/quotes?symbols=AAPL,TSLA'` |

### `GET /api/bars`

| | |
|---|---|
| **Purpose** | Historical OHLCV bars for the symbol-detail page chart. |
| **Required** | `symbol` (string) |
| **Optional** | `timeframe` ∈ `1Min`,`5Min`,`15Min`,`1Hour`,`1Day` (default `1Day`); `limit` 1–1000 (default 90) |
| **Response 200** | `{ "symbol":"AAPL", "timeframe":"1Day", "bars":[{"t":1715000000000,"o":188,"h":190,"l":187,"c":189,"v":4000000}, ...], "provider":"alpaca" }` |
| **Response 400** | `{ "error":"invalid timeframe; one of 1Min, 5Min, 15Min, 1Hour, 1Day" }` |
| **When called** | `priceClient.fetchBars` — invoked by `useBars` (`frontend/src/hooks/useBars.ts:43`) when the user opens the symbol-detail page or switches its timeframe selector. Cached in-memory by `symbol|timeframe|limit` for `BARS_CACHE_TTL_MS=5min`. |
| **curl** | `curl 'http://localhost:5010/api/bars?symbol=AAPL&timeframe=1Day&limit=30'` |

---

## 2. Assets

### `GET /api/assets/lookup`

| | |
|---|---|
| **Purpose** | "Is this a real, tradable symbol?" Provider-mode-independent — even in replay mode this proxies to the live Alpaca catalog with the same creds, so the watchlist add-symbol modal doesn't reject valid tickers when running off recorded data. |
| **Required** | `symbol` (string, regex `^[A-Z][A-Z0-9.]{0,7}$`) |
| **Response 200 (found)** | `{ "asset": { "symbol":"JD", "name":"JD.com Inc.", "tradable":true, "exchange":"NASDAQ" } }` |
| **Response 200 (unknown)** | `{ "asset": null }` |
| **Response 400** | `{ "error":"symbol query param required" }` or `{ "error":"symbol must start with a letter and contain only letters, digits, or '.', max 8 chars" }` |
| **Response 502** | `{ "error":"Alpaca assets failed: …" }` |
| **When called** | `priceClient.lookupAsset` — invoked by `AddStockModal` (`frontend/src/components/AddStockModal.tsx:62`) when the user types a new ticker into the watchlist add-symbol modal. Cached per-symbol for 1h; concurrent lookups for the same symbol are coalesced. |
| **curl** | `curl 'http://localhost:5010/api/assets/lookup?symbol=JD'` |

---

## 3. Subscriptions

The Socket.io stream needs to know which symbols to listen for. Subscriptions are managed via REST (not WS messages) so reconnects don't lose state.

### `POST /api/subscriptions`

| | |
|---|---|
| **Purpose** | Add (default) or replace the set of symbols streamed over the WS price feed. |
| **Required** | JSON `{ symbols: string[] }` |
| **Optional** | `replace?: boolean` — if `true`, swaps the entire subscription set instead of appending |
| **Response 200** | `{ "subscribed":["AAPL","TSLA","SPY"] }` |
| **When called** | `priceClient.ensureSubscribed` — invoked by `useMarket` (`frontend/src/hooks/useMarket.ts:254`) whenever the tracked-symbol set changes. Also called server-side as a side-effect of `GET /quotes` so the stream warms up alongside the snapshot. |
| **curl** | `curl -X POST http://localhost:5010/api/subscriptions -H 'Content-Type: application/json' -d '{"symbols":["AAPL","TSLA"]}'` |

### `GET /api/subscriptions`

| | |
|---|---|
| **Purpose** | Read the current subscription set (debug/inspection). |
| **Response 200** | `{ "subscribed":["AAPL","TSLA"] }` |
| **When called** | Not currently called by the frontend — present for debugging via curl/health checks. |
| **curl** | `curl http://localhost:5010/api/subscriptions` |

---

## 4. Health

### `GET /api/health`

| | |
|---|---|
| **Purpose** | Liveness probe + at-a-glance provider status. |
| **Response 200** | `{ "ok":true, "provider":"alpaca", "providerStatus":"live", "subscribed":["AAPL"] }` |
| **When called** | Not currently called by the frontend — used by ops/curl/PM2 health checks. |
| **curl** | `curl http://localhost:5010/api/health` |

---

## 5. Portfolio reads

Source: `backend/src/routes/portfolio.ts`. Schemas: `shared/src/contracts/portfolio.ts`.

### `GET /api/portfolio`

| | |
|---|---|
| **Purpose** | Return the full `Portfolio` (cash, positions, working orders, alerts, watchlist, recent fill/cancel history). The account row is **self-provisioned** on first read: if the user has no row yet, `PortfolioStore.ensureAccount` inserts one at `INITIAL_CASH=100_000` and seeds the default watchlist. |
| **Response 200** | `Portfolio` ([reference shape](#reference-portfolio-shape)) |
| **When called** | `portfolioClient.get` — invoked once by `usePortfolio` on mount (`frontend/src/hooks/usePortfolio.ts`). Every subsequent mutation returns the refreshed `Portfolio` in the response, so the client doesn't poll. |
| **curl** | `curl http://localhost:5010/api/portfolio` |

### `GET /api/portfolio/history`

| | |
|---|---|
| **Purpose** | Time-series of equity samples for the dashboard's "Portfolio value" chart. Backed by `paper_trade_pro.equity_snapshots`, written by the in-process `EquitySnapshotter` (every `EQUITY_SNAPSHOT_INTERVAL_MS=60s` by default) and on-demand after every fill/reset. |
| **Required** | `range` query — one of `1M`, `3M`, `YTD`, `ALL` (validated by `isHistoryRange`; see `shared/src/contracts/portfolio.ts`) |
| **Response 200** | `{ "range": "1M", "points": [{ "t": 1715000000000, "p": 100023.45 }, …] }` (`t` epoch-ms UTC, `p` equity in dollars; ordered ASC) |
| **Response 400** | `{ "error":"invalid range \"<value>\"" }` |
| **When called** | `portfolioClient.getHistory` — invoked by `DashboardPage` (`frontend/src/pages/DashboardPage.tsx:45`) on mount and every time the user clicks one of the **1M / 3M / YTD / ALL** segmented buttons. The page also appends a synthetic "now" point client-side so the right edge of the line stays current between snapshots. |
| **curl** | `curl 'http://localhost:5010/api/portfolio/history?range=1M'` |

---

## 6. Orders

`POST /api/orders` returns just the new [`Order`](#reference-portfolio-shape) — the client refetches `GET /api/portfolio` afterwards to refresh `cash` / `positions`. The other order endpoints (`/cancel`, `/fill`, `/peak`) still return the full refreshed `Portfolio`. Side-effect: market-order placement and any successful fill triggers `EquitySnapshotter.snapshotUser(userId)` so the chart catches the new equity instantly.

### `POST /api/orders`

| | |
|---|---|
| **Purpose** | Place a new order. Market orders fill in-line in the same transaction; non-market types insert with `status='pending'` and wait for a client-side trigger to call `/fill`. |
| **Required (JSON `PlaceOrderInput`)** | `ticker`, `side` (`buy`/`sell`/`short`/`cover`), `type` (`market`/`limit`/`stop`/`stop_limit`/`trailing_stop`/`conditional`), `qty`, `tif` (`day`/`gtc`/`ioc`) |
| **Optional** | `limitPrice`, `stopPrice`, `trailPct`, `condTrigger` `{ticker,op,price}`, `innerType`, `fillPrice` (**required** when `type='market'` — the client reads it from the current ask/bid before posting) |
| **Response 200** | The post-mutation `Order`. A market order arrives with `status='filled'`, `filledAt`, and `fillPrice` populated; non-market orders arrive with `status='pending'`. Cash and positions are NOT included — the client refetches `GET /api/portfolio` to refresh those scopes (each route owns one concern). |
| **Response 400** | e.g. `{ "error":"market orders require fillPrice" }`, `{ "error":"limit orders require limitPrice" }`, etc. |
| **When called** | `portfolioClient.placeOrder` — invoked by `usePortfolio.placeOrder` when the user submits the Trade ticket modal. The hook then refetches `GET /api/portfolio` to refresh state. |
| **curl** | `curl -X POST http://localhost:5010/api/orders -H 'Content-Type: application/json' -d '{"ticker":"AAPL","side":"buy","type":"market","qty":10,"tif":"day","fillPrice":189.20}'` |

### `POST /api/orders/:id/cancel`

| | |
|---|---|
| **Purpose** | Cancel a working order (`status` in `pending`/`pending_fill`). |
| **Required** | path `:id` |
| **Response 200** | refreshed `Portfolio` |
| **Response 400** | `{ "error":"order <id> not found or not cancellable" }` |
| **When called** | `portfolioClient.cancelOrder` — invoked by `usePortfolio.cancelOrder` (`frontend/src/hooks/usePortfolio.ts:160`) from the Orders page Cancel button. |
| **curl** | `curl -X POST http://localhost:5010/api/orders/<id>/cancel` |

### `POST /api/orders/:id/fill`

| | |
|---|---|
| **Purpose** | Trigger a fill for a non-market working order at the given price. Updates the order row, merges into existing positions (weighted-average cost), adjusts cash, and records an equity snapshot — all in one transaction. |
| **Required** | path `:id`, JSON `{ fillPrice: number }` |
| **Response 200** | refreshed `Portfolio` |
| **Response 400** | `{ "error":"fillPrice (number) required" }`, `{ "error":"order <id> is filled; cannot fill twice" }` |
| **When called** | `portfolioClient.fillOrder` — invoked by `usePortfolio`'s tick-driven evaluator (`frontend/src/hooks/usePortfolio.ts:297`) when a working order's trigger condition fires (limit price crossed, stop hit, trailing-stop level reached, conditional met). De-duplicated client-side via an `inFlight` set so the same order can't fill twice. |
| **curl** | `curl -X POST http://localhost:5010/api/orders/<id>/fill -H 'Content-Type: application/json' -d '{"fillPrice":191.05}'` |

### `POST /api/orders/:id/peak`

| | |
|---|---|
| **Purpose** | Update the high-water mark (`peak`) of a trailing-stop order. Persists across restarts. |
| **Required** | path `:id`, JSON `{ peak: number }` |
| **Response 200** | refreshed `Portfolio` |
| **When called** | **Currently not invoked by the frontend.** The client deliberately holds peaks in memory (`localPeaks` ref in `usePortfolio.ts:70`) and re-seeds from the server's stored `peak` on reload — that's "close enough for a paper-trading sim and spares us a POST per tick." Endpoint is kept available for an eventual server-side trailing-stop loop. |
| **curl** | `curl -X POST http://localhost:5010/api/orders/<id>/peak -H 'Content-Type: application/json' -d '{"peak":192.50}'` |

---

## 7. Alerts

### `POST /api/alerts`

| | |
|---|---|
| **Purpose** | Create a price-cross alert (`above` or `below` a threshold). Newly-created alerts start `active=true` and untriggered. |
| **Required (JSON `AddAlertInput`)** | `ticker`, `condition` (`above`/`below`), `price` |
| **Optional** | `note` (string) |
| **Response 200** | refreshed `Portfolio` |
| **When called** | `portfolioClient.addAlert` — invoked by `usePortfolio.addAlert` (`frontend/src/hooks/usePortfolio.ts:185`) when the user submits the New Alert modal. |
| **curl** | `curl -X POST http://localhost:5010/api/alerts -H 'Content-Type: application/json' -d '{"ticker":"AAPL","condition":"above","price":200}'` |

### `POST /api/alerts/:id/toggle`

| | |
|---|---|
| **Purpose** | Flip an alert's `active` flag (mute/unmute). Does not touch `triggered_at`. |
| **Required** | path `:id` |
| **Response 200** | refreshed `Portfolio` |
| **When called** | `portfolioClient.toggleAlert` — invoked by `usePortfolio.toggleAlert` (`frontend/src/hooks/usePortfolio.ts:199`) from the Alerts page's mute toggle. |
| **curl** | `curl -X POST http://localhost:5010/api/alerts/<id>/toggle` |

### `POST /api/alerts/:id/trigger`

| | |
|---|---|
| **Purpose** | Mark an alert as triggered (the client observed the price cross). One-shot — re-firing is rejected. |
| **Required** | path `:id`, JSON `{ price: number }` |
| **Response 200** | refreshed `Portfolio` |
| **Response 400** | `{ "error":"alert <id> not found or already triggered" }` |
| **When called** | `portfolioClient.triggerAlert` — invoked by `usePortfolio`'s tick-driven evaluator (`frontend/src/hooks/usePortfolio.ts:320`) when an active, untriggered alert's condition is met against a live tick. De-duplicated via the `inFlight` set with key `alert:<id>`. |
| **curl** | `curl -X POST http://localhost:5010/api/alerts/<id>/trigger -H 'Content-Type: application/json' -d '{"price":200.15}'` |

### `DELETE /api/alerts/:id`

| | |
|---|---|
| **Purpose** | Permanently remove an alert. |
| **Required** | path `:id` |
| **Response 200** | refreshed `Portfolio` |
| **When called** | `portfolioClient.removeAlert` — invoked by `usePortfolio.removeAlert` (`frontend/src/hooks/usePortfolio.ts:192`) from the Alerts page Delete button. |
| **curl** | `curl -X DELETE http://localhost:5010/api/alerts/<id>` |

---

## 8. Watchlist

### `POST /api/watchlist/toggle`

| | |
|---|---|
| **Purpose** | Toggle a ticker on the watchlist — adds if missing, removes if present. Single endpoint instead of separate add/remove because the UI button is always a toggle. |
| **Required** | JSON `{ ticker: string }` |
| **Response 200** | refreshed `Portfolio` |
| **Response 400** | `{ "error":"ticker (string) required" }` |
| **When called** | `portfolioClient.toggleWatch` — invoked by `usePortfolio.toggleWatch` and surfaced through the prop drilled into `WatchlistPage`, `DetailPage`, and `AddStockModal`. Star button on the watchlist row, the detail-page header button, and the AddStockModal's "Add" action all funnel through this. |
| **curl** | `curl -X POST http://localhost:5010/api/watchlist/toggle -H 'Content-Type: application/json' -d '{"ticker":"AAPL"}'` |

---

## 9. Account

### `POST /api/portfolio/reset`

| | |
|---|---|
| **Purpose** | **Dev convenience.** Wipes the user's positions, orders, trade history, and equity snapshots, then resets `cash` and `initial_cash` to the requested amount (or `INITIAL_CASH=100_000` if omitted). **Alerts and watchlist are intentionally preserved across resets** — users curate those over time and a "clean slate to practice a new strategy" should not erase them. After the wipe, calls `EquitySnapshotter.snapshotUser` so the chart starts with one fresh point at the new cash. |
| **Optional** | JSON `{ cash?: number }` |
| **Response 200** | `{ "ok": true }`. State lives on `GET /api/portfolio`; the client refetches that endpoint after a successful reset. Each route owns one concern. |
| **Response 400/500** | `{ "error": "<message>" }` |
| **When called** | `portfolioClient.reset` — invoked by `usePortfolio.resetFunds` from the AccountPage "Reset funds" button. AccountPage gates the call behind a two-click confirmation strip that lists exactly what will be erased vs kept. Not exposed in the production UI flow once auth lands. |
| **curl** | `curl -X POST http://localhost:5010/api/portfolio/reset -H 'Content-Type: application/json' -d '{"cash":50000}'` |

---

## 10. Realtime (Socket.io)

Same origin/port as the REST API (Socket.io is mounted on the HTTP server in `backend/src/server.ts`). Event names are constants in `shared/src/contracts/events.ts`.

| Direction | Event | Payload | When emitted |
|---|---|---|---|
| Server → Client | `price:tick` | `{ symbol: string, price: number, timestamp: number, …optional OHLC fields }` | Every upstream tick from the price provider for a subscribed symbol. Driven by `PriceStreamHub`. |
| Server → Client | `provider:status` | `{ status: 'live' \| 'stale' \| 'unavailable', provider: string, message?: string }` | Provider connection state changes — e.g. WS reconnect, missing creds. |

Subscriptions are managed via the REST endpoint `POST /api/subscriptions` so reconnects don't lose state. The frontend wires this up in `useMarket.connect` (`frontend/src/hooks/useMarket.ts:137`).

---

## Reference: `Portfolio` shape

Returned by `GET /api/portfolio`, the `/alerts` and `/watchlist` mutations, and the order routes that still echo state (`/cancel`, `/fill`, `/peak`). `POST /api/orders` returns just an [`Order`](#reference-order-shape) and `POST /api/portfolio/reset` returns `{ ok: true }`; in both cases the client refetches `GET /api/portfolio` for fresh state. Defined in `shared/src/contracts/portfolio.ts`.

```jsonc
{
  "cash": 95231.40,
  "initialCash": 100000,
  "positions": [
    { "id":"pos_…", "ticker":"AAPL", "side":"long", "qty":10, "avgPrice":189.20, "openedAt":1715000000000 }
  ],
  "orders": [
    { "id":"ord_…", "ticker":"AAPL", "side":"buy", "type":"limit", "qty":10, "tif":"gtc",
      "status":"pending", "createdAt":1715000000000, "limitPrice":188.0 }
  ],
  "alerts": [
    { "id":"alr_…", "ticker":"AAPL", "condition":"above", "price":200, "active":true, "createdAt":1715000000000 }
  ],
  "watchlist": ["TQQQ","SQQQ","TSLA","AMZN","COIN"],
  "history": [
    { "id":"ord_…", "ticker":"AAPL", "side":"buy", "type":"market", "qty":10, "tif":"day",
      "status":"filled", "createdAt":1715000000000, "filledAt":1715000010000, "fillPrice":189.20 }
  ]
}
```

Note that `Portfolio.history` is the **last 200 filled/cancelled orders** (most recent first). It is **not** the equity-value time-series — that lives at `GET /portfolio/history` and is shaped as `{ range, points: [{ t, p }] }`.

## Reference: `Order` shape

Returned by `POST /api/orders`. Defined in `shared/src/contracts/portfolio.ts`. Same shape that appears inside `Portfolio.orders` and `Portfolio.history`.

```jsonc
{
  "id": "019e32fc-e963-759b-9c19-98f9c228444e",
  "ticker": "TSLA", "side": "sell", "type": "market", "qty": 10, "tif": "day",
  "status": "filled",
  "createdAt": 1778971896114,
  "filledAt": 1778971896114,
  "fillPrice": 427.0000
}
```

## Reference: enums

Validated at the route boundary by the runtime guards in `shared/src/contracts/portfolio.ts` (no DB CHECKs for value-spaces — application is the single source of truth).

| Enum | Values |
|---|---|
| `OrderType` | `market` · `limit` · `stop` · `stop_limit` · `trailing_stop` · `conditional` |
| `OrderSide` | `buy` · `sell` · `short` · `cover` |
| `OrderStatus` | `pending` · `pending_fill` · `filled` · `cancelled` |
| `PositionSide` | `long` · `short` |
| `TimeInForce` | `day` · `gtc` · `ioc` |
| `AlertCondition` | `above` · `below` |
| `ConditionalOp` | `>=` · `<=` |
| `HistoryRange` | `1M` · `3M` · `YTD` · `ALL` |

Timestamps over the wire are **epoch milliseconds** (numbers). The DB stores `timestamptz`; conversion happens at the SQL boundary.
