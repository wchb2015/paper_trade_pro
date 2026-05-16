# Price Data Providers

This document describes every stock-price data source wired into Paper Trade Pro,
how the abstraction layer sits in front of them, and what the network shapes
(endpoints, sample payloads, Socket.io events) look like end-to-end.

```
                           ┌──────────────────────────────────────┐
                           │            Frontend (React)          │
                           └──────────────┬───────────────────────┘
                                          │ REST + Socket.io
              ┌───────────────────────────┴───────────────────────────┐
              │                  backend/src/routes                   │
              │   GET /api/quotes  GET /api/bars  POST /subscriptions │
              │   Socket.io: price:tick, provider:status              │
              └────┬───────────────────────────────────┬──────────────┘
                   │                                   │
        ┌──────────▼──────────┐         ┌──────────────▼─────────────┐
        │   QuoteCache (TTL)  │         │ PriceStreamHub (Socket.io) │
        └──────────┬──────────┘         └──────────────┬─────────────┘
                   │                                   │
                   └───────────────┬───────────────────┘
                                   │
                       ┌───────────▼────────────┐
                       │   PriceProvider IFace  │  ← backend/src/providers/PriceProvider.ts
                       └───┬────────────────────┘
                           │
        ┌──────────────────┼─────────────────────┐
        │                                        │
┌───────▼─────────┐                    ┌─────────▼─────────┐
│ AlpacaProvider  │                    │  ReplayProvider   │
│ REST + WS (live)│                    │ NDJSON file replay│
└───────┬─────────┘                    └─────────┬─────────┘
        │                                         │
        ▼                                         ▼
data.alpaca.markets             backend/.replay-cache/<date>/<SYM>.ndjson
stream.data.alpaca.markets      (downloaded by backend/scripts/fetchTrades.ts)
```

---

## 1. The `PriceProvider` Abstraction

Source: `backend/src/providers/PriceProvider.ts`

Every consumer of price data in the app talks to this interface — never to a
provider directly. To plug in a new vendor (Polygon, Finnhub, IEX Cloud, etc.)
you write a class implementing the interface and add a branch to
`backend/src/providers/index.ts::createPriceProvider`. Nothing else in the app
needs to change.

```ts
export interface PriceProvider {
  readonly name: string;

  // REST: latest snapshot (price + OHLC + bid/ask) for many symbols at once.
  fetchQuotes(symbols: string[]): Promise<Record<string, Quote>>;

  // REST: historical OHLC bars for one symbol.
  fetchBars(symbol: string, timeframe: BarTimeframe, limit: number): Promise<Bar[]>;

  // Streaming: open the live tick stream.
  startStream(initialSymbols: string[], handlers: PriceStreamHandlers): Promise<UnsubscribeFn>;

  // Streaming: replace the active subscription set.
  updateSubscriptions(symbols: string[]): Promise<void>;

  // Synchronous availability check (cheap, no I/O).
  getUnavailableSymbols(symbols: string[]): Record<string, UnavailableReason>;

  // Catalog lookup: "is this a real, tradable symbol?" — must be independent
  // of runtime feed state (replay fixtures, IEX silence, etc.). Replay
  // proxies this to the live catalog using the same Alpaca creds.
  lookupAsset(symbol: string): Promise<AssetLookup | null>;

  // Replay-only metadata for the UI's running clock + status pill.
  getReplaySpeed?(): number;
  getReplayDate?(): string;
}
```

### Canonical normalized shapes

Source: `shared/src/contracts/quote.ts`. Every quote and bar that leaves the
provider layer must conform to these shapes. Provider-specific fields are
mapped at the edge of the provider class.

```ts
export interface Quote {
  symbol: string;
  price: number;                 // last trade price
  bid: number | null;            // best bid (null if not exposed)
  ask: number | null;            // best ask
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  prevClose: number | null;      // yesterday's close (used for day-change %)
  timestamp: number;             // epoch ms of last trade
  status: 'live' | 'stale' | 'unavailable';
}

export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }

export type BarTimeframe = '1Min' | '5Min' | '15Min' | '1Hour' | '1Day';

export interface UnavailableReason {
  code: 'no-replay-data';
  message: string;
}

export interface AssetLookup {
  symbol: string;          // canonical (uppercased) ticker
  name: string | null;     // friendly company / fund name when upstream supplies one
  tradable: boolean;       // false ⇒ delisted, halted, etc.
  exchange: string | null; // upstream exchange code (e.g. "NASDAQ")
}
```

### Provider selection

`PRICE_PROVIDER` env var (parsed in `backend/src/config.ts`):

| Value     | Class                  | Source             | Use case                                  |
| --------- | ---------------------- | ------------------ | ----------------------------------------- |
| `alpaca`  | `AlpacaProvider`       | live REST + WS     | default; market hours                     |
| `replay`  | `ReplayProvider`       | local NDJSON files | off-hours dev / deterministic UI testing  |

Constants live in `shared/src/constants.ts::PROVIDERS`.

---

## 2. AlpacaProvider (live)

Source: `backend/src/providers/AlpacaProvider.ts`

Live market data via Alpaca's market-data product. Used in production / during
RTH. **Every Alpaca-specific symbol, URL, header, or ws message lives in this
file** — nothing else in the codebase imports `ws` or hits
`data.alpaca.markets` directly.

### Free-tier guardrails

- IEX feed only (`feed=iex`). SIP is paid.
- 200 REST req/min ceiling — protected upstream by `QuoteCache`
  (`backend/src/services/QuoteCache.ts`) which TTL-caches snapshots and
  coalesces concurrent fetches of the same symbol set.
- Exactly **one** concurrent WS connection per account on the free tier — all
  frontend clients share a single upstream socket through `PriceStreamHub`.
- Caps in `shared/src/constants.ts::FREE_TIER`:
  - `SNAPSHOT_CACHE_TTL_MS` = 10 s
  - `BARS_CACHE_TTL_MS` = 5 min
  - `MAX_STREAM_SYMBOLS` = 30
  - `STALE_AFTER_MS` = 60 s (UI-side)
  - `WS_RECONNECT_DELAY_MS` = 5 s

### Authentication

All Alpaca calls send these headers (REST) or auth message (WS):

```
APCA-API-KEY-ID:     <APCA_KEY_ID>
APCA-API-SECRET-KEY: <APCA_SECRET_KEY>
Accept:              application/json
```

### 2.1 REST — Snapshots (`fetchQuotes`)

Implements: `PriceProvider.fetchQuotes(symbols)`

**Endpoint** — `GET https://data.alpaca.markets/v2/stocks/snapshots`

| Query param | Example                | Notes                           |
| ----------- | ---------------------- | ------------------------------- |
| `symbols`   | `TSLA,AAPL,MSFT`       | comma-joined, upper-cased       |
| `feed`      | `iex` \| `sip`         | from `ALPACA_FEED`              |

**Sample request**

```
GET /v2/stocks/snapshots?symbols=TSLA,AAPL&feed=iex
APCA-API-KEY-ID: PKXXXX...
APCA-API-SECRET-KEY: ****
```

**Sample upstream response** (truncated; either `{ snapshots: {...} }` or keyed
directly by symbol — the provider accepts both shapes):

```json
{
  "TSLA": {
    "latestTrade": { "p": 434.13, "t": "2026-05-15T19:59:59.4Z" },
    "latestQuote": { "ap": 434.20, "bp": 434.10, "t": "2026-05-15T19:59:59.4Z" },
    "dailyBar":     { "t": "2026-05-15T04:00:00Z", "o": 430.10, "h": 437.45, "l": 429.05, "c": 434.13, "v": 89234100 },
    "prevDailyBar": { "t": "2026-05-14T04:00:00Z", "o": 421.00, "h": 432.10, "l": 420.50, "c": 430.05, "v": 75123000 },
    "minuteBar":    { "t": "2026-05-15T19:59:00Z", "o": 434.05, "h": 434.20, "l": 434.00, "c": 434.13, "v": 8421 }
  },
  "AAPL": { "...": "..." }
}
```

**Normalized output** (`Record<string, Quote>` returned to callers):

```json
{
  "TSLA": {
    "symbol": "TSLA",
    "price": 434.13,
    "bid": 434.10,
    "ask": 434.20,
    "dayOpen": 430.10,
    "dayHigh": 437.45,
    "dayLow": 429.05,
    "prevClose": 430.05,
    "timestamp": 1747339199400,
    "status": "live"
  }
}
```

### 2.2 REST — Bars (`fetchBars`)

Implements: `PriceProvider.fetchBars(symbol, timeframe, limit)`

**Endpoint** — `GET https://data.alpaca.markets/v2/stocks/bars`

| Query param  | Example                              |
| ------------ | ------------------------------------ |
| `symbols`    | `TSLA`                               |
| `timeframe`  | `1Min` \| `5Min` \| `15Min` \| `1Hour` \| `1Day` |
| `limit`      | up to `1000` (clamped server-side in `routes/quotes.ts`) |
| `feed`       | `iex` \| `sip`                       |
| `adjustment` | `raw` (split/dividend-unadjusted)    |

**Sample request**

```
GET /v2/stocks/bars?symbols=TSLA&timeframe=1Day&limit=90&feed=iex&adjustment=raw
```

**Sample upstream response**

```json
{
  "bars": {
    "TSLA": [
      { "t": "2026-02-14T05:00:00Z", "o": 410.5, "h": 415.0, "l": 408.3, "c": 412.7, "v": 60000000 },
      { "t": "2026-02-15T05:00:00Z", "o": 412.7, "h": 419.2, "l": 410.0, "c": 418.0, "v": 70000000 }
    ]
  }
}
```

**Normalized output** (`Bar[]`):

```json
[
  { "t": 1739509200000, "o": 410.5, "h": 415.0, "l": 408.3, "c": 412.7, "v": 60000000 },
  { "t": 1739595600000, "o": 412.7, "h": 419.2, "l": 410.0, "c": 418.0, "v": 70000000 }
]
```

### 2.3 REST — Asset catalog (`lookupAsset`)

Implements: `PriceProvider.lookupAsset(symbol)`

**Endpoint** — `GET https://paper-api.alpaca.markets/v2/assets/{symbol}` (the
**trading**-API host, distinct from the data host above; `cfg.alpaca.tradingBaseUrl`,
overridable via `ALPACA_TRADING_URL`).

`ReplayProvider.lookupAsset` proxies to this same endpoint with the same
credentials — catalog validity is independent of whether a replay fixture
exists for the configured `REPLAY_DATE`.

**Sample request**

```
GET /v2/assets/JD
APCA-API-KEY-ID: PKXXXX...
APCA-API-SECRET-KEY: ****
```

**Sample upstream response**

```json
{
  "id": "5e2b0bcd-...-1f4d0a3a",
  "class": "us_equity",
  "exchange": "NASDAQ",
  "symbol": "JD",
  "name": "JD.com Inc. American Depositary Shares",
  "status": "active",
  "tradable": true,
  "marginable": true,
  "shortable": true,
  "easy_to_borrow": true,
  "fractionable": true
}
```

A `404` from upstream is treated as "unknown symbol" and surfaced to the
client as `{ "asset": null }` (not a 404) — see §5 below.

**Normalized output** (`AssetLookup | null`):

```json
{
  "symbol": "JD",
  "name": "JD.com Inc. American Depositary Shares",
  "tradable": true,
  "exchange": "NASDAQ"
}
```

### 2.4 WebSocket — Live Trades

**Endpoint** — `wss://stream.data.alpaca.markets/v2/<feed>` (default
`wss://stream.data.alpaca.markets/v2/iex`)

**Protocol** (all messages JSON, framed as arrays of objects):

| Direction | Type        | Message                                                                          |
| --------- | ----------- | -------------------------------------------------------------------------------- |
| → server  | auth        | `{ "action": "auth", "key": "...", "secret": "..." }`                            |
| ← server  | auth ok     | `[{ "T": "success", "msg": "authenticated" }]`                                   |
| → server  | subscribe   | `{ "action": "subscribe",   "trades": ["TSLA","AAPL"] }`                         |
| → server  | unsubscribe | `{ "action": "unsubscribe", "trades": ["AAPL"] }`                                |
| ← server  | trade tick  | `[{ "T": "t", "S": "TSLA", "p": 434.13, "t": "2026-05-15T19:59:59.4Z", ... }]`   |
| ← server  | error       | `[{ "T": "error", "code": 401, "msg": "..." }]`                                  |

**Reconnect:** on `close` the provider waits `WS_RECONNECT_DELAY_MS` (5 s) and
reopens. On reconnect it re-sends `{ action: "subscribe", trades: [...current...] }`
with the full subscribed set so no symbols are silently dropped.

**Tick → Quote mapping** (`AlpacaProvider.handleMessage`): only `price` and
`timestamp` are populated from the ws tick; OHLC / bid / ask are left `null`
and back-filled by the cached snapshot inside `QuoteCache.applyTick`.

```json
{
  "symbol": "TSLA",
  "price": 434.13,
  "bid": null,
  "ask": null,
  "dayOpen": null,
  "dayHigh": null,
  "dayLow": null,
  "prevClose": null,
  "timestamp": 1747339199400,
  "status": "live"
}
```

---

## 3. ReplayProvider (historical replay)

Source: `backend/src/providers/ReplayProvider.ts`

Replays trades that `backend/scripts/fetchTrades.ts` previously dumped, through
the same `PriceProvider` interface. The frontend cannot tell the difference
from live Alpaca — same `price:tick` Socket.io events, same shapes — except
for the optional `simTimestamp` and `replaySpeed` / `replayDate` metadata.

### What it solves

- Off-hours development: markets closed → no live ticks → blank UI.
- Deterministic regression testing: replay a known session repeatedly.
- Stress testing the WS / scheduler at `REPLAY_SPEED=0` (drain ASAP).

### Disk layout

```
backend/.replay-cache/
└── 2026-05-15/
    ├── TSLA.ndjson          # one Alpaca trade per line
    ├── TSLA.meta.json       # date, window, count, first/last timestamps
    ├── AAPL.ndjson
    └── AAPL.meta.json
```

The path is `{REPLAY_CACHE_DIR}/{REPLAY_DATE}/{SYMBOL}.ndjson` — see
`ReplayProvider.pathFor`. Defaults to `backend/.replay-cache`.

**Sample `*.ndjson` line** (raw Alpaca `/v2/stocks/trades` row):

```json
{"c":["@","I"],"i":9,"p":434.135,"s":20,"t":"2026-05-15T13:30:00.093457262Z","x":"V","z":"C"}
```

**Sample `*.meta.json`:**

```json
{
  "symbol": "TSLA",
  "date": "2026-05-15",
  "startIso": "2026-05-15T13:30:00.000Z",
  "endIso":   "2026-05-15T20:00:00.000Z",
  "feed": "iex",
  "count": 18667,
  "pages": 2,
  "downloadedAt":   "2026-05-16T14:57:26.861Z",
  "firstTradeIso":  "2026-05-15T13:30:00.093457262Z",
  "lastTradeIso":   "2026-05-15T19:59:59.425378268Z"
}
```

### How the playback engine works

1. **Per-symbol streaming reader** (`replay/ndjsonLineReader.ts`) — pull-based
   line iterator with backpressure; never buffers the whole file.
2. **Min-heap merge across symbols** (`replay/minHeap.ts`) — ordered by trade
   timestamp so emitted ticks are in true chronological order across the
   subscribed set.
3. **Sim clock** — `simNow = simStart + (Date.now() - wallStart) * speed`.
   Trades whose `t` ≤ `simNow` are drained on each scheduler tick (every 20 ms).
   `REPLAY_SPEED=0` returns `+Infinity` and drains everything immediately.
4. **Looping** — when the heap empties and `REPLAY_LOOP=true`, all readers are
   re-opened from the start; `dayStats` is reset so each loop is treated as a
   fresh trading day.
5. **Day-stats accumulator** — `dayStats` (open / high / low) is updated as
   ticks emit, so `fetchQuotes` can return a non-null `dayOpen` immediately
   (peeking the file's first trade if needed) and the running high/low reflect
   simulation progress, not the pre-known full-day total.
6. **Wall-clock remap** — emitted `quote.timestamp` is set to `Date.now()` so
   the frontend's stale-detection (`STALE_AFTER_MS`) doesn't immediately flag
   every tick as ancient. The original sim time is passed in `meta.simTimestamp`
   for the UI's running replay clock.

### `fetchQuotes` and `fetchBars` in replay mode

- `fetchQuotes` returns the most recently emitted price (or peeks the first
  trade on disk if the scheduler hasn't started). `bid` / `ask` / `prevClose`
  are always `null` in replay — TODOed in code to read yesterday's close from
  `*.meta.json` later.
- `fetchBars` rebuilds OHLC bars on-demand by bucketing the NDJSON file at
  `bucketMs = timeframeToMs(timeframe)`. Result is cached per
  `<symbol>::<timeframe>` so the chart doesn't re-scan on every render.

### `lookupAsset` in replay mode

Proxies directly to `https://paper-api.alpaca.markets/v2/assets/{symbol}`
using the same Alpaca credentials the rest of the app already requires.
**Does not** consult the on-disk fixture — "is JD a real, tradable ticker?"
must succeed in replay mode even when no NDJSON file exists for
`REPLAY_DATE`. This decouples watchlist add-symbol validation from the
replay corpus.

### `getUnavailableSymbols`

Returns one entry per symbol whose NDJSON file is missing for the configured
`REPLAY_DATE`. The REST `/api/quotes` response then contains:

```json
{
  "quotes": { "TSLA": { "...": "..." } },
  "providerStatus": "live",
  "provider": "replay",
  "unavailable": {
    "AAPL": {
      "code": "no-replay-data",
      "message": "No replay file for AAPL on 2026-05-15."
    }
  }
}
```

### 3.1 The downloader: `fetchTrades.ts`

Source: `backend/scripts/fetchTrades.ts` (also exposed as
`npm run fetch-trades` inside `backend/`).

Downloads historical trades from Alpaca's REST API and writes them as NDJSON
into the replay cache.

**Endpoint used** — `GET https://data.alpaca.markets/v2/stocks/trades`

| Query param     | Example                    | Notes                                              |
| --------------- | -------------------------- | -------------------------------------------------- |
| `symbols`       | `TSLA`                     | one symbol per script invocation                   |
| `start`         | `2026-05-15T13:30:00.000Z` | UTC ISO; converted from ET wall-clock by script    |
| `end`           | `2026-05-15T20:00:00.000Z` | UTC ISO                                            |
| `limit`         | `10000`                    | max page size                                      |
| `feed`          | `iex` \| `sip`             | `--feed` flag or `ALPACA_FEED` env                 |
| `sort`          | `asc`                      |                                                    |
| `page_token`    | from previous response     | follow `next_page_token` until null                |

**Sample upstream response (one page)**

```json
{
  "trades": {
    "TSLA": [
      { "t": "2026-05-15T13:30:00.093Z", "x": "V", "p": 434.135, "s": 20, "c": ["@","I"], "i": 9, "z": "C" },
      { "t": "2026-05-15T13:30:00.098Z", "x": "V", "p": 434.135, "s":  5, "c": ["@","I"], "i": 10, "z": "C" }
    ]
  },
  "next_page_token": "MjAyNi0wNS0xNVQxMzozMDow..."
}
```

**Usage**

```sh
# Defaults: regular trading hours 09:30–16:00 ET (pre-market and after-hours
# on IEX are too sparse to be useful for replay).
cd backend && npm run fetch-trades -- TSLA 2026-05-15

# Custom intraday window (extended hours):
cd backend && npm run fetch-trades -- TSLA 2026-05-15 04:00 20:00

# Force overwrite an existing file:
cd backend && npm run fetch-trades -- TSLA 2026-05-15 --force

# Use SIP feed:
cd backend && npm run fetch-trades -- TSLA 2026-05-15 --feed sip
```

Emits paginated progress to stdout, retries 429 / 5xx with exponential backoff
(up to 5 attempts, 30 s ceiling), gentle 250 ms pause between pages, and
finally writes:

- `backend/.replay-cache/<date>/<SYMBOL>.ndjson`
- `backend/.replay-cache/<date>/<SYMBOL>.meta.json`

---

## 4. Plumbing on top of providers

### 4.1 `QuoteCache` — `backend/src/services/QuoteCache.ts`

TTL cache + in-flight request coalescing wrapped around `provider.fetchQuotes`.

- **TTL**: `SNAPSHOT_CACHE_TTL_MS` (10 s).
- **Coalescing**: concurrent `getMany([...])` calls for the same set are
  deduped to one upstream fetch.
- **Tick merging**: `applyTick(quote)` folds streamed prices into the cached
  snapshot — the WS tick only carries `price` + `timestamp`, so cached `bid` /
  `ask` / OHLC remain accurate until the next REST refresh.

### 4.2 `PriceStreamHub` — `backend/src/services/PriceStreamHub.ts`

Owns the single upstream WebSocket and re-broadcasts ticks to all connected
Socket.io clients.

- Caps subscriptions at `MAX_STREAM_SYMBOLS` (30) on the free tier.
- Maintains the union watchlist; `ensureSubscribed(symbols, { replace })` is
  additive by default and replaces the set when `replace: true`.
- Tracks provider status (`live` / `unavailable`) and broadcasts
  `provider:status` whenever it changes (with optional `replaySpeed` /
  `replayDate` for replay mode).

---

## 5. Backend API — what providers feed into

Source: `backend/src/routes/quotes.ts`

### REST endpoints

| Method | Path                       | Description                                              |
| ------ | -------------------------- | -------------------------------------------------------- |
| GET    | `/api/quotes?symbols=`     | Batch snapshot fetch (TTL-cached). Auto-subscribes WS.   |
| GET    | `/api/bars?...`            | Historical OHLC bars (per-`(symbol,timeframe,limit)` cached for `BARS_CACHE_TTL_MS`). |
| GET    | `/api/assets/lookup?symbol=` | Catalog lookup; provider-mode-independent. 1h TTL cache. |
| POST   | `/api/subscriptions`       | Ensure the WS hub is subscribed to the given symbols.    |
| GET    | `/api/subscriptions`       | List current WS subscriptions (debug).                   |
| GET    | `/api/health`              | Liveness + provider status.                              |

#### `GET /api/quotes`

```
GET /api/quotes?symbols=TSLA,AAPL
```

```json
{
  "quotes": {
    "TSLA": { "symbol": "TSLA", "price": 434.13, "bid": 434.10, "ask": 434.20,
              "dayOpen": 430.10, "dayHigh": 437.45, "dayLow": 429.05,
              "prevClose": 430.05, "timestamp": 1747339199400, "status": "live" },
    "AAPL": { "...": "..." }
  },
  "providerStatus": "live",
  "provider": "alpaca"
}
```

In replay mode, missing-file symbols also surface in `unavailable` (see §3).

#### `GET /api/bars`

```
GET /api/bars?symbol=TSLA&timeframe=1Day&limit=90
```

```json
{
  "symbol": "TSLA",
  "timeframe": "1Day",
  "bars": [
    { "t": 1739509200000, "o": 410.5, "h": 415.0, "l": 408.3, "c": 412.7, "v": 60000000 }
  ],
  "provider": "alpaca"
}
```

#### `GET /api/assets/lookup`

```
GET /api/assets/lookup?symbol=JD
```

```json
{
  "asset": {
    "symbol": "JD",
    "name": "JD.com Inc. American Depositary Shares",
    "tradable": true,
    "exchange": "NASDAQ"
  }
}
```

Unknown ticker:

```
GET /api/assets/lookup?symbol=XYZQ
```

```json
{ "asset": null }
```

#### `POST /api/subscriptions`

```http
POST /api/subscriptions
Content-Type: application/json

{ "symbols": ["TSLA","AAPL"], "replace": false }
```

```json
{ "subscribed": ["AAPL","TSLA"] }
```

### Socket.io events

Source: `shared/src/contracts/events.ts`. Same shape regardless of provider —
only the optional replay metadata distinguishes them.

| Event             | Direction        | Payload                                                       |
| ----------------- | ---------------- | ------------------------------------------------------------- |
| `price:tick`      | server → client  | `{ symbol, price, timestamp, simTimestamp? }`                 |
| `provider:status` | server → client  | `{ status, provider, message?, replaySpeed?, replayDate? }`   |

**Sample `price:tick`**

```json
{ "symbol": "TSLA", "price": 434.13, "timestamp": 1747339199400 }
```

**Sample `price:tick` (replay mode)**

```json
{ "symbol": "TSLA", "price": 434.13, "timestamp": 1747340012345, "simTimestamp": 1747339199400 }
```

`timestamp` is wall-clock at emission (used by frontend stale-detection);
`simTimestamp` is the original session's market time (used by the UI's
running replay clock, extrapolated between ticks via `replaySpeed`).

**Sample `provider:status`**

```json
{ "status": "live", "provider": "alpaca" }

{ "status": "live", "provider": "replay", "message": "replay 2026-05-15 @ 1x",
  "replaySpeed": 1, "replayDate": "2026-05-15" }

{ "status": "unavailable", "provider": "alpaca", "message": "ECONNRESET" }
```

---

## 6. Configuration reference

All env vars live in the repo-root `.env` (see `.env.example` for the full
annotated list). Provider-relevant subset:

| Env var              | Required? | Default                                         | Purpose                                            |
| -------------------- | --------- | ----------------------------------------------- | -------------------------------------------------- |
| `APCA_KEY_ID`        | yes       | —                                               | Alpaca paper key id (also gates market data).      |
| `APCA_SECRET_KEY`    | yes       | —                                               | Alpaca paper secret key.                           |
| `PRICE_PROVIDER`     | no        | `alpaca`                                        | `alpaca` or `replay`.                              |
| `ALPACA_FEED`        | no        | `iex`                                           | `iex` (free) or `sip` (paid subscription).         |
| `ALPACA_DATA_URL`    | no        | `https://data.alpaca.markets`                   | Market-data REST base URL override (snapshots, bars). |
| `ALPACA_TRADING_URL` | no        | `https://paper-api.alpaca.markets`              | Trading-API base URL override (assets catalog).    |
| `ALPACA_STREAM_URL`  | no        | `wss://stream.data.alpaca.markets/v2/<feed>`    | WS URL override.                                   |
| `REPLAY_DATE`        | no        | `2026-05-01`                                    | Subfolder under `REPLAY_CACHE_DIR` to play back.   |
| `REPLAY_SPEED`       | no        | `1`                                             | `1` real-time, `10` ten-times, `0` ASAP.           |
| `REPLAY_LOOP`        | no        | `true`                                          | Restart at EOD so the feed never dies.             |
| `REPLAY_CACHE_DIR`   | no        | `backend/.replay-cache`                         | Absolute path to NDJSON root.                      |

---

## 7. Adding a new provider

1. Create `backend/src/providers/MyVendorProvider.ts` implementing
   `PriceProvider`. Map vendor-specific shapes to `Quote` / `Bar` inside the
   class — keep all imports of vendor SDKs / URLs strictly within this file.
2. Add `'myvendor'` to `PROVIDERS` in `shared/src/constants.ts`. The TS
   exhaustiveness check in `createPriceProvider` will then force you to wire
   the new branch in `backend/src/providers/index.ts`.
3. Document the vendor's REST endpoints, WS protocol, rate limits, and
   feed/tier choices in a new section of this file mirroring §2 / §3.
4. Extend `.env.example` with any new env vars and add them to `config.ts`.
5. Verify: `GET /api/health` returns `{ "provider": "myvendor", ... }` and
   the frontend renders ticks identically to the existing providers.

