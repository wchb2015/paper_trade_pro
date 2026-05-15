# Backend API

All routes are mounted under `/api`. Backend listens on `BACKEND_PORT=5010` (`ports.cjs:16`), so the base URL in dev is `http://localhost:5010/api`.

## Conventions

- **Auth**: pre-auth — every request is mapped to `cfg.currentUserId` server-side (`backend/src/server.ts:73`). No headers required today.
- **Content-Type**: `application/json` on every POST. `express.json()` middleware (`backend/src/server.ts:53`).
- **CORS**: allows `cfg.frontendOrigin` (`backend/src/server.ts:52`).
- **Errors**: shape is `{ "error": "<message>" }` with `400` for client-correctable problems (invalid enum, missing field, "not found") and `500`/`502` for server/provider failures. Final safety net: `errorHandler` returns `{ error: { code, message, ref } }` for anything that escapes a route's try/catch (`backend/src/server.ts:84`).
- **Portfolio mutations** all return the **full refreshed `Portfolio`** so the client can replace state in one shot.
- **Tracing**: every request gets a short `ref` id via `attachRef` middleware (`backend/src/server.ts:55`); look it up in pino logs to trace one request end-to-end.

## Quote endpoints (`backend/src/routes/quotes.ts`)

| Path | Method | Required input | Optional input | Sample request → response | curl |
|---|---|---|---|---|---|
| `/api/quotes` | GET | `symbols` (CSV query, e.g. `AAPL,TSLA`) | — | Req: `GET /api/quotes?symbols=AAPL,TSLA`<br>Res `200`: `{ "quotes": { "AAPL": { "symbol":"AAPL", "price":189.2, "bid":189.1, "ask":189.3, "dayOpen":188.0, "dayHigh":190.4, "dayLow":187.5, "prevClose":188.7, "volume":4123456, "timestamp":1715000000000, "status":"live" }, ... }, "providerStatus":"live", "provider":"alpaca" }`<br>Res `400`: `{ "error":"symbols query param required" }`<br>Res `502`: empty `quotes` + `providerStatus:"unavailable"` | `curl 'http://localhost:5010/api/quotes?symbols=AAPL,TSLA'` |
| `/api/bars` | GET | `symbol` (string) | `timeframe` ∈ `1Min`,`5Min`,`15Min`,`1Hour`,`1Day` (default `1Day`); `limit` 1–1000 (default 90) | Req: `GET /api/bars?symbol=AAPL&timeframe=1Day&limit=30`<br>Res `200`: `{ "symbol":"AAPL", "timeframe":"1Day", "bars":[{"t":1715000000000,"o":188,"h":190,"l":187,"c":189,"v":4000000}, ...], "provider":"alpaca" }`<br>Res `400`: `{ "error":"invalid timeframe; one of 1Min, 5Min, 15Min, 1Hour, 1Day" }` | `curl 'http://localhost:5010/api/bars?symbol=AAPL&timeframe=1Day&limit=30'` |
| `/api/subscriptions` | POST | JSON `{ symbols: string[], replace?: boolean }` | `replace=true` swaps the entire subscription set | Req body: `{ "symbols":["AAPL","TSLA"], "replace": false }`<br>Res `200`: `{ "subscribed":["AAPL","TSLA","SPY"] }` | `curl -X POST http://localhost:5010/api/subscriptions -H 'Content-Type: application/json' -d '{"symbols":["AAPL","TSLA"]}'` |
| `/api/subscriptions` | GET | — | — | Res `200`: `{ "subscribed":["AAPL","TSLA"] }` | `curl http://localhost:5010/api/subscriptions` |
| `/api/health` | GET | — | — | Res `200`: `{ "ok":true, "provider":"alpaca", "providerStatus":"live", "subscribed":["AAPL"] }` | `curl http://localhost:5010/api/health` |

**Caching**: `/quotes` is served from `QuoteCache` with TTL `SNAPSHOT_CACHE_TTL_MS=10s` (`shared/src/constants.ts:14`). `/bars` is served from an in-memory map keyed by `symbol|timeframe|limit` with TTL `BARS_CACHE_TTL_MS=5min` (`shared/src/constants.ts:16`). `/quotes` also opportunistically calls `hub.ensureSubscribed(symbols)` so the WS stream warms up alongside the snapshot.

## Portfolio endpoints (`backend/src/routes/portfolio.ts`)

Every mutating endpoint returns the **full `Portfolio`** (cash, positions, orders, alerts, watchlist, history). Schemas: `shared/src/contracts/portfolio.ts`.

| Path | Method | Required input | Optional input | Sample request → response | curl |
|---|---|---|---|---|---|
| `/api/portfolio` | GET | — | — | Res `200`: `Portfolio` (see schema below) | `curl http://localhost:5010/api/portfolio` |
| `/api/orders` | POST | JSON `PlaceOrderInput` — `ticker`, `side` (`buy`/`sell`/`short`/`cover`), `type` (`market`/`limit`/`stop`/`stop_limit`/`trailing_stop`/`conditional`), `qty`, `tif` (`day`/`gtc`/`ioc`) | `limitPrice`, `stopPrice`, `trailPct`, `condTrigger` `{ticker,op,price}`, `innerType`, `fillPrice` (required for market orders — client-computed from current ask/bid) | Req: `{ "ticker":"AAPL", "side":"buy", "type":"market", "qty":10, "tif":"day", "fillPrice":189.20 }`<br>Res `200`: refreshed `Portfolio` | `curl -X POST http://localhost:5010/api/orders -H 'Content-Type: application/json' -d '{"ticker":"AAPL","side":"buy","type":"market","qty":10,"tif":"day","fillPrice":189.20}'` |
| `/api/orders/:id/cancel` | POST | path `:id` | — | Res `200`: refreshed `Portfolio`<br>Res `400`: `{ "error":"order not cancellable" }` | `curl -X POST http://localhost:5010/api/orders/<id>/cancel` |
| `/api/orders/:id/fill` | POST | path `:id`, JSON `{ fillPrice: number }` | — | Req: `{ "fillPrice": 191.05 }`<br>Res `200`: refreshed `Portfolio`<br>Res `400`: `{ "error":"fillPrice (number) required" }` | `curl -X POST http://localhost:5010/api/orders/<id>/fill -H 'Content-Type: application/json' -d '{"fillPrice":191.05}'` |
| `/api/orders/:id/peak` | POST | path `:id`, JSON `{ peak: number }` | — | Used by the trailing-stop client logic to update the high-water mark.<br>Req: `{ "peak": 192.50 }`<br>Res `200`: refreshed `Portfolio` | `curl -X POST http://localhost:5010/api/orders/<id>/peak -H 'Content-Type: application/json' -d '{"peak":192.50}'` |
| `/api/alerts` | POST | JSON `AddAlertInput` — `ticker`, `condition` (`above`/`below`), `price` | `note` (string) | Req: `{ "ticker":"AAPL", "condition":"above", "price":200, "note":"watch breakout" }`<br>Res `200`: refreshed `Portfolio` | `curl -X POST http://localhost:5010/api/alerts -H 'Content-Type: application/json' -d '{"ticker":"AAPL","condition":"above","price":200}'` |
| `/api/alerts/:id/toggle` | POST | path `:id` | — | Toggles `active`. Res `200`: refreshed `Portfolio` | `curl -X POST http://localhost:5010/api/alerts/<id>/toggle` |
| `/api/alerts/:id/trigger` | POST | path `:id`, JSON `{ price: number }` | — | Marks the alert as triggered with the observed price (client observed the cross).<br>Req: `{ "price": 200.15 }`<br>Res `200`: refreshed `Portfolio`<br>Res `400`: `{ "error":"already triggered" }` | `curl -X POST http://localhost:5010/api/alerts/<id>/trigger -H 'Content-Type: application/json' -d '{"price":200.15}'` |
| `/api/alerts/:id` | DELETE | path `:id` | — | Res `200`: refreshed `Portfolio` | `curl -X DELETE http://localhost:5010/api/alerts/<id>` |
| `/api/watchlist/toggle` | POST | JSON `{ ticker: string }` | — | Adds the ticker if missing, removes if present.<br>Req: `{ "ticker":"AAPL" }`<br>Res `200`: refreshed `Portfolio`<br>Res `400`: `{ "error":"ticker (string) required" }` | `curl -X POST http://localhost:5010/api/watchlist/toggle -H 'Content-Type: application/json' -d '{"ticker":"AAPL"}'` |
| `/api/portfolio/reset` | POST | — | JSON `{ cash?: number }` (defaults to `INITIAL_CASH`, `100_000`) | Dev-only. Wipes positions/orders/alerts/watchlist and resets cash.<br>Req: `{ "cash": 50000 }`<br>Res `200`: refreshed `Portfolio` | `curl -X POST http://localhost:5010/api/portfolio/reset -H 'Content-Type: application/json' -d '{"cash":50000}'` |

## Realtime (Socket.io)

Same origin/port as the REST API (Socket.io is mounted on the HTTP server in `backend/src/server.ts:58`). Event names are constants in `shared/src/contracts/events.ts:6`:

| Direction | Event | Payload |
|---|---|---|
| Server → Client | `price:tick` | `{ symbol: string, price: number, timestamp: number }` |
| Server → Client | `provider:status` | `{ status: 'live' \| 'stale' \| 'unavailable', provider: string, message?: string }` |

Subscriptions are managed via the REST endpoint `POST /api/subscriptions` (so reconnects don't lose state).

## Reference: `Portfolio` shape

Returned by **every** portfolio endpoint. Defined in `shared/src/contracts/portfolio.ts:104`.

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

Order/alert/position enums (validated at the route boundary, see `shared/src/contracts/portfolio.ts:38`):

- **OrderType**: `market` | `limit` | `stop` | `stop_limit` | `trailing_stop` | `conditional`
- **OrderSide**: `buy` | `sell` | `short` | `cover`
- **OrderStatus**: `pending` | `pending_fill` | `filled` | `cancelled`
- **TimeInForce**: `day` | `gtc` | `ioc`
- **AlertCondition**: `above` | `below`
- **ConditionalOp**: `>=` | `<=`

Timestamps over the wire are **epoch milliseconds** (numbers). The DB stores `timestamptz`; conversion happens at the SQL boundary.
