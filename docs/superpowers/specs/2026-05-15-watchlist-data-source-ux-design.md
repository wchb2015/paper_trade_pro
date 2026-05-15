# Watchlist data-source UX — design

**Status:** approved (brainstorm)
**Date:** 2026-05-15
**Owner:** chongbei
**Scope:** frontend (`WatchlistPage`) + backend (`PriceProvider`, `/api/quotes`) + shared types.

## 1. Problem

Today, the watchlist page silently filters out any symbol whose backend `Market` entry is missing:

```ts
// frontend/src/pages/WatchlistPage.tsx
const rows = watchlist.map(t => ({ ticker: t, m: market[t] })).filter(r => r.m);
```

Under `PRICE_PROVIDER=replay`, that situation is the norm rather than the exception — every symbol in the user's watchlist that lacks an NDJSON file under `backend/.replay-cache/<REPLAY_DATE>/` disappears from the table. The sidebar badge still reports `watchlist.length` (e.g. "5"), so the user sees a "5 symbols tracked" subtitle and an empty table with no explanation. (See the bug we just fixed where this masked a separate cache-path resolution issue.)

The user should always see one row per watchlist symbol. Symbols the backend cannot price should render a clear, scoped message that names the reason.

## 2. Goals & non-goals

### Goals

- Render one row per watchlist symbol, regardless of whether the backend can price it.
- For each row the backend cannot price, show a "no data" banner that names the reason — for replay, that means *"No replay file for AMZN on 2026-05-01."*
- Keep the existing top-right provider pill — today rendered as `Live · ${provider}` (e.g. `Live · replay`) when connected, with `Stale` / `Unavailable` / `Offline` fallbacks (`App.tsx:316-343`) — as the single source of truth for "which provider is active". Do not change its text in this design and do not duplicate it on rows.
- No regression to alpaca behavior.

### Non-goals

- Detail / Positions / Orders / Alerts pages. They reference `market[ticker]` similarly but the user's request is specifically the watchlist; their behavior is unchanged in this design.
- A "Fetch trades for AMZN" button. Adding the fetcher to the UI is its own piece of work; here the only contextual action on a no-data row is `Remove`.
- Per-row provider tooltip / hover label. The global pill is enough.
- Distinguishing "the symbol is unknown to the provider" from "the provider transiently failed". The new field is a discriminated `code`, so a future change can add codes without reshaping the response.

## 3. User-visible behavior

### 3.1 Row states

| State | Trigger | Render |
| --- | --- | --- |
| **Priced** | `market[t]` exists | Existing row (price / change / volume / sparkline / Trade + Remove). Unchanged. |
| **No data** | `market[t]` missing AND `unavailable[t]` set | Banner row (mockup C). Same row height as priced rows. |
| **Loading** | `market[t]` missing AND `unavailable[t]` not set | Row is hidden. (Same as today; resolves on first `/quotes` response, typically within a few hundred ms.) |

### 3.2 Banner row layout

The banner reuses the existing 6-column grid. Visually:

```
| Symbol            | Last … 30D (spanned)                                          | (action) |
| AMZN              | [No data]  No replay file for AMZN on 2026-05-01.             | Remove   |
| Amazon.com, Inc.  |                                                                |          |
```

CSS: `grid-column: 2 / 6` on the banner cell so it spans the price/change/volume/sparkline columns. The action column stays separate so `Remove` lines up with `Trade` on neighboring rows. The `[No data]` chip uses the existing warn color (`#f59e0b` palette in `Watchlist`'s row chips).

### 3.3 Top-right provider pill

Unchanged. Already wired in `App.tsx:316-343` from `useMarket`'s `provider` + `providerStatus` + `liveConnected`, and renders `Live · ${provider}` (e.g. `Live · replay`) / `Stale` / `Unavailable` / `Offline`. No row-level provider hint added (per Q4 = 4a). If we later want richer provider text (date/speed for replay), that's a separate change.

## 4. Architecture

```
ReplayProvider                          AlpacaProvider
  - pathFor(sym), fs.existsSync         - getUnavailableSymbols() → {}
  - getUnavailableSymbols(syms)
       → { sym: { code:'no-replay-data',
                  message:'No replay file for AMZN on 2026-05-01.' } }
                |
                v
QuoteCache (unchanged)         provider.getUnavailableSymbols(syms)
   |                                    |
   +------- /api/quotes ----------------+
              QuotesResponse {
                quotes, providerStatus, provider,
                unavailable?: Record<sym, UnavailableReason>     ← new, optional
              }
              |
              v
useMarket()
   - market: Record<sym, StockSnapshot>      (existing)
   - unavailable: Record<sym, UnavailableReason>   ← new
              |
              v
WatchlistPage:
   for t of watchlist:
     market[t]      → priced row
     unavailable[t] → banner row
     else           → skip
```

Per-symbol unavailability is computed on the backend (the only place that knows what files exist under `cacheDir`). The frontend treats it as opaque and renders `message` directly.

## 5. Detailed changes

### 5.1 `shared/src/contracts/quote.ts`

Add `UnavailableReason` and an optional field on `QuotesResponse`:

```ts
export interface UnavailableReason {
  /** Stable code; UI keys off this. Add new codes here as needed. */
  code: 'no-replay-data';
  /** Human-readable, ready to render verbatim. */
  message: string;
}

export interface QuotesResponse {
  quotes: Record<string, Quote>;
  providerStatus: PriceStatus;
  provider: string;
  /**
   * Symbols the provider knows it cannot price right now (e.g. replay
   * has no NDJSON file for the configured date). Optional so existing
   * clients ignore it gracefully.
   */
  unavailable?: Record<string, UnavailableReason>;
}
```

Keeping the field optional means alpaca responses are byte-identical to today's.

### 5.2 `backend/src/providers/PriceProvider.ts`

Extend the interface:

```ts
export interface PriceProvider {
  // …existing methods
  /** Per-symbol availability hint. Default: empty (everything is available). */
  getUnavailableSymbols(symbols: string[]): Record<string, UnavailableReason>;
}
```

### 5.3 `backend/src/providers/AlpacaProvider.ts`

Add:
```ts
getUnavailableSymbols(_symbols: string[]): Record<string, UnavailableReason> {
  return {};
}
```

### 5.4 `backend/src/providers/ReplayProvider.ts`

Add:
```ts
getUnavailableSymbols(symbols: string[]): Record<string, UnavailableReason> {
  const out: Record<string, UnavailableReason> = {};
  for (const raw of symbols) {
    const sym = raw.toUpperCase();
    if (!fs.existsSync(this.pathFor(sym))) {
      out[sym] = {
        code: 'no-replay-data',
        message: `No replay file for ${sym} on ${this.cfg.replay.date}.`,
      };
    }
  }
  return out;
}
```

This is `O(n)` `existsSync` calls per `/quotes` request. With a watchlist of ≤16 symbols and a `SNAPSHOT_CACHE_TTL_MS` already protecting upstream calls, this is fine. If it ever shows up in profiling, we can cache the file-exists check by `(date, sym)`.

### 5.5 `backend/src/routes/quotes.ts`

In the `GET /quotes` handler, after the existing `cache.getMany(symbols)`:

```ts
const unavailable = deps.provider.getUnavailableSymbols(symbols);
const body: QuotesResponse = {
  quotes,
  providerStatus: deps.hub.getStatus().status,
  provider: deps.provider.name,
  ...(Object.keys(unavailable).length > 0 ? { unavailable } : {}),
};
```

Conditional spread keeps the field absent when empty (matches current alpaca shape; `optional` field semantics under `exactOptionalPropertyTypes`).

### 5.6 `frontend/src/hooks/useMarket.ts`

Add to the hook's returned shape:

```ts
export interface UseMarketResult {
  market: Market;
  unavailable: Record<string, UnavailableReason>;   // ← new
  liveConnected: boolean;
  providerStatus: 'live' | 'stale' | 'unavailable';
  provider: string;
  error: string | null;
}
```

State + replacement on every `loadSnapshots` mirrors the existing `setMarket` block — drop unavailable entries for symbols not in the current `symbolList`, replace the rest with the response's `unavailable ?? {}`. No socket integration needed (replay's "no data" status is stable for the lifetime of `REPLAY_DATE` — it can only change on a server restart).

### 5.7 `frontend/src/App.tsx`

Pull `unavailable` out of `useMarket()` and pass it to `<WatchlistPage>`. (No other page consumes it — see non-goals.)

### 5.8 `frontend/src/pages/WatchlistPage.tsx`

Replace the rows construction:

```ts
const { watchlist } = portfolio;
// rows = ALL watchlist tickers, classified into priced / banner / skip
```

For each ticker:
- `market[t]` present → existing priced row.
- otherwise `unavailable[t]` present → banner row component (inline JSX, ~25 lines — small enough not to need its own file):
  - left: ticker + company name (same as priced row).
  - middle (`grid-column: 2 / 6`): `<span class="chip warn">No data</span> {unavailable[t].message}`.
  - right: `Remove` button → `toggleWatch(ticker)` (already in props).
- otherwise → skip.

The "5 symbols tracked" subtitle continues to render `watchlist.length` — that is now consistent with the on-page row count.

## 6. Error handling

- `/api/quotes` already swallows upstream provider errors and returns `{ quotes: {}, providerStatus: 'unavailable' }`. With the new field optional, that path is unchanged. In an upstream-error scenario, no row gets a banner — the existing top-right pill flips to `Unavailable` and rows render as "loading" (skipped) until things recover.
- `provider.getUnavailableSymbols` is sync and pure; we do not wrap it in try/catch in the route. If a future provider implementation throws, we want the Express `errorHandler` to log it (CLAUDE.md rule 6) rather than swallowing.

## 7. Logging

No new log statements needed. The existing `PriceStreamHub` already emits `ERROR replay: no data for AMZN on 2026-05-01` when the *stream* tries to open the file (`ReplayProvider.openStreams`), which is the same root signal. We're surfacing that same fact through a separate REST channel for UI use; we don't want to double-log on every `/quotes` call.

## 8. Testing

Manual checklist (no test framework wired up yet for this app):

1. **Replay, mixed availability**
   `.env`: `PRICE_PROVIDER=replay`, `REPLAY_DATE=2026-05-01`. Watchlist: `[TSLA, AMZN, COIN]` (only TSLA has NDJSON). Restart pm2.
   - Expect: TSLA row priced; AMZN + COIN render banner *"No replay file for X on 2026-05-01."*
   - Expect: top-right pill `Replay · 2026-05-01 · 1×`.
   - Expect: `GET /api/quotes?symbols=TSLA,AMZN,COIN` response includes `unavailable: { AMZN: {...}, COIN: {...} }`.
2. **Replay, all unavailable**
   `REPLAY_DATE=1970-01-01` (no folder). Restart.
   - Expect: every watchlist row renders banner; existing `PriceStreamHub` "no data for X" warnings in `pm2 logs` are unchanged.
3. **Alpaca**
   `PRICE_PROVIDER=alpaca`. Restart during market hours.
   - Expect: no banner rows; behavior identical to pre-change.
   - Expect: `/api/quotes` response has no `unavailable` field.
4. **Remove from banner row**
   Click `Remove` on a banner row → that symbol leaves the watchlist immediately; sidebar badge decrements.

## 9. Migration / rollout

Single change, no DB migration, no client/server skew risk (the field is optional). Ship in one commit.

## 10. Open questions

None. (Resolved during brainstorm: hybrid provider signal = global pill; banner shown only under replay; no per-row source tooltip; no in-UI fetch action.)
